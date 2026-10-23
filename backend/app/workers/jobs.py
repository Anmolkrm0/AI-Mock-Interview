"""In-process background worker backed by durable database rows.

Work state lives in Postgres, not memory, so a restart loses nothing: the
next loop iteration picks up queued jobs, expired leases and pending cleanups.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import timedelta

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.core.config import Settings
from app.models import Document, Interview, RecordingUpload, StorageCleanupTask
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


async def tick(
    sessionmaker: async_sessionmaker[AsyncSession],
    provider: EvaluationProvider,
    storage: StorageClient,
    settings: Settings,
    *,
    housekeeping: bool,
) -> None:
    if housekeeping:
        async with sessionmaker() as db:
            await finalize_abandoned(db, settings)
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


async def worker_loop(
    sessionmaker: async_sessionmaker[AsyncSession],
    provider: EvaluationProvider,
    storage: StorageClient,
    settings: Settings,
    stop: asyncio.Event,
) -> None:
    logger.info("worker_started")
    iteration = 0
    while not stop.is_set():
        try:
            await tick(sessionmaker, provider, storage, settings, housekeeping=iteration % 12 == 0)
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
