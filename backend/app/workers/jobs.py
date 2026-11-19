"""In-process background worker backed by durable database rows.

Work state lives in Postgres, not memory, so a restart loses nothing: the
next loop iteration picks up queued jobs, expired leases and pending cleanups.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import timedelta

import httpx
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.core.config import Settings
from app.models import (
    CreditLedger,
    Document,
    GuestConversion,
    Interview,
    Profile,
    Recording,
    RecordingUpload,
    StorageCleanupTask,
)
from app.providers.base import EvaluationProvider
from app.services import recording_service, report_service
from app.services.interview_service import complete_interview, now_utc
from app.storage.supabase_storage import StorageClient

logger = logging.getLogger("app.worker")


async def finalize_abandoned(db: AsyncSession, settings: Settings) -> int:
    """Interviews left running past their deadline are finalized and evaluated."""
    cutoff = now_utc() - timedelta(seconds=settings.abandoned_after_seconds)
    # Leave a grace period after the deadline so the browser can submit its final answer.
    deadline_cutoff = now_utc() - timedelta(seconds=settings.completion_grace_seconds)
    rows = list(
        (
            await db.execute(
                select(Interview)
                .where(
                    Interview.status.in_(("connecting", "in_progress", "paused")),
                    ((Interview.deadline_at.is_not(None)) & (Interview.deadline_at < deadline_cutoff))
                    | (Interview.last_activity_at < cutoff),
                )
                .limit(20)
                .with_for_update(skip_locked=True)
            )
        ).scalars()
    )
    for interview in rows:
        await complete_interview(db, interview=interview, reason="time_expired")
    await db.commit()
    return len(rows)


async def refund_unstarted_or_failed(db: AsyncSession, settings: Settings) -> int:
    """Return credits for charged interviews that never started within 30 minutes.

    Only runs when payments are on, and only touches interviews that were actually
    charged and not yet refunded, so with payments off the app behaves as before.
    The interview is cancelled as well, so a refunded interview can't be retried for free.
    A state that can't move to "cancelled" is skipped instead of crashing the worker tick.
    """
    if not settings.payments_enabled:
        return 0

    from app.services.billing_service import refund_interview_credits
    from app.services.interview_service import can_transition

    charged = select(CreditLedger.interview_id).where(
        CreditLedger.reason == "interview_use", CreditLedger.interview_id.is_not(None)
    )
    refunded = select(CreditLedger.interview_id).where(
        CreditLedger.reason == "interview_refund", CreditLedger.interview_id.is_not(None)
    )
    cutoff_30m = now_utc() - timedelta(minutes=30)
    stale = list(
        (
            await db.execute(
                select(Interview)
                .where(
                    Interview.id.in_(charged),
                    Interview.id.not_in(refunded),
                    Interview.started_at.is_(None),
                    Interview.created_at < cutoff_30m,
                    Interview.status.in_(("created", "preparing", "ready", "connecting", "failed")),
                )
                .limit(20)
                .with_for_update(skip_locked=True)
            )
        ).scalars()
    )

    refund_count = 0
    for interview in stale:
        if not can_transition(interview.status, "cancelled", interview.failure_stage):
            continue
        interview.status = "cancelled"
        refunded_credits = await refund_interview_credits(
            db,
            interview_id=interview.id,
            reason_note="Interview did not start within 30 minutes",
        )
        if refunded_credits:
            refund_count += 1

    await db.commit()
    return refund_count


async def run_cleanups(db: AsyncSession, storage: StorageClient) -> int:
    ids = list(
        (
            await db.execute(
                select(StorageCleanupTask.id)
                .where(StorageCleanupTask.status == "pending", StorageCleanupTask.next_run_at <= now_utc())
                .limit(20)
            )
        ).scalars()
    )
    for task_id in ids:
        await recording_service.try_cleanup(db, storage, task_id)
    return len(ids)


async def expire_uploads(db: AsyncSession, settings: Settings) -> int:
    """Upload slots never confirmed within 6 hours: delete any partial object."""
    old = now_utc() - timedelta(hours=6)
    rows = list(
        (
            await db.execute(
                select(RecordingUpload)
                .where(RecordingUpload.status == "issued", RecordingUpload.created_at < old)
                .limit(50)
                .with_for_update(skip_locked=True)
            )
        ).scalars()
    )
    for upload in rows:
        upload.status = "expired"
        db.add(
            StorageCleanupTask(
                bucket=settings.recordings_bucket, storage_path=upload.storage_path, reason="expired_upload"
            )
        )
    await db.commit()
    return len(rows)


async def purge_document_text(db: AsyncSession, settings: Settings) -> int:
    """Remove raw document text and original files after the retention period."""
    cutoff = now_utc() - timedelta(days=settings.document_retention_days)
    docs = list(
        (
            await db.execute(
                select(Document)
                .where(Document.created_at < cutoff, Document.text_purged_at.is_(None))
                .limit(50)
                .with_for_update(skip_locked=True)
            )
        ).scalars()
    )
    for doc in docs:
        if doc.storage_path:
            db.add(
                StorageCleanupTask(
                    bucket=settings.documents_bucket,
                    storage_path=doc.storage_path,
                    reason="document_retention",
                )
            )
        doc.extracted_text = None
        doc.storage_path = None
        doc.text_purged_at = now_utc()
    await db.commit()
    return len(docs)


async def cleanup_unclaimed_guests(
    db: AsyncSession,
    storage: StorageClient,
    settings: Settings,
    *,
    http_client: httpx.AsyncClient | None = None,
) -> int:
    """Delete anonymous profiles older than 48 hours that were never converted."""
    cutoff = now_utc() - timedelta(hours=48)
    converted_subquery = select(GuestConversion.guest_user_id)
    profiles = list(
        (
            await db.execute(
                select(Profile)
                .where(
                    Profile.is_anonymous.is_(True),
                    Profile.created_at < cutoff,
                    Profile.id.not_in(converted_subquery),
                )
                .limit(50)
                .with_for_update(skip_locked=True)
            )
        ).scalars()
    )
    if not profiles:
        return 0

    user_ids = [p.id for p in profiles]

    # Queue storage cleanup for documents
    docs = list((await db.execute(select(Document).where(Document.user_id.in_(user_ids)))).scalars())
    for doc in docs:
        if doc.storage_path:
            db.add(
                StorageCleanupTask(
                    bucket=settings.documents_bucket,
                    storage_path=doc.storage_path,
                    reason="guest_expired",
                )
            )

    # Queue storage cleanup for recording uploads and recordings
    uploads = list(
        (await db.execute(select(RecordingUpload).where(RecordingUpload.user_id.in_(user_ids)))).scalars()
    )
    for up in uploads:
        if up.storage_path:
            db.add(
                StorageCleanupTask(
                    bucket=settings.recordings_bucket,
                    storage_path=up.storage_path,
                    reason="guest_expired",
                )
            )

    recs = list((await db.execute(select(Recording).where(Recording.user_id.in_(user_ids)))).scalars())
    for rec in recs:
        if rec.storage_path:
            db.add(
                StorageCleanupTask(
                    bucket=settings.recordings_bucket,
                    storage_path=rec.storage_path,
                    reason="guest_expired",
                )
            )

    # Delete profiles (cascades delete documents, interviews, and child rows)
    for p in profiles:
        await db.delete(p)
    await db.commit()

    # Delete users from Supabase Auth admin API if configured
    if settings.supabase_url and settings.supabase_secret_key:
        headers = {
            "apikey": settings.supabase_secret_key,
            "Authorization": f"Bearer {settings.supabase_secret_key}",
        }
        for uid in user_ids:
            url = f"{settings.supabase_url.rstrip('/')}/auth/v1/admin/users/{uid}"
            try:
                if http_client is not None:
                    await http_client.delete(url, headers=headers)
                else:
                    async with httpx.AsyncClient(timeout=10.0) as client:
                        await client.delete(url, headers=headers)
            except Exception as exc:
                logger.warning("supabase_delete_guest_auth_user_failed error=%s", exc)

    logger.info("cleaned_up_unclaimed_guests count=%d", len(profiles))
    return len(profiles)


async def tick(
    sessionmaker: async_sessionmaker[AsyncSession],
    provider: EvaluationProvider,
    storage: StorageClient,
    settings: Settings,
    *,
    housekeeping: bool,
    hourly: bool = False,
) -> None:
    if housekeeping:
        async with sessionmaker() as db:
            await finalize_abandoned(db, settings)
            await refund_unstarted_or_failed(db, settings)
    # Drain a few evaluation jobs per tick.
    for _ in range(3):
        status = await report_service.process_one(sessionmaker, provider, settings)
        if status is None:
            break
    if housekeeping:
        async with sessionmaker() as db:
            await expire_uploads(db, settings)
            await purge_document_text(db, settings)
            await run_cleanups(db, storage)
    if hourly:
        async with sessionmaker() as db:
            await cleanup_unclaimed_guests(db, storage, settings)


async def worker_loop(
    sessionmaker: async_sessionmaker[AsyncSession],
    provider: EvaluationProvider,
    storage: StorageClient,
    settings: Settings,
    stop: asyncio.Event,
) -> None:
    logger.info("worker_started")
    iteration = 0
    hourly_interval = max(1, int(3600 / max(settings.worker_poll_seconds, 1.0)))
    while not stop.is_set():
        try:
            await tick(
                sessionmaker,
                provider,
                storage,
                settings,
                housekeeping=iteration % 12 == 0,
                hourly=iteration % hourly_interval == 0,
            )
        except Exception:
            logger.exception("worker_tick_failed")
        iteration += 1
        try:
            await asyncio.wait_for(stop.wait(), timeout=settings.worker_poll_seconds)
        except TimeoutError:
            pass
    logger.info("worker_stopped")


async def mark_stale_cleanups_failed(db: AsyncSession) -> None:  # pragma: no cover - ops helper
    await db.execute(
        update(StorageCleanupTask).where(StorageCleanupTask.attempts >= 10).values(status="failed")
    )
    await db.commit()
