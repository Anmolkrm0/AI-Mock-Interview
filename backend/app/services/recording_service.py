"""Latest-recording-only policy.

Business rule: each user has at most one current recording. Interview history,
transcripts and reports are never deleted when a recording is replaced.

Replacement order (never delete the old file before the new one is verified):
    1. Issue an upload slot for a *new* path ``{user}/{interview}/{uuid}.{ext}``.
    2. Browser uploads to that path with a short-lived signed upload token.
    3. Confirm: verify the object exists with the expected size and type.
    4. In one transaction, point ``recordings`` (PK user_id) at the new object
       and queue the old object for deletion.
    5. Delete the old object; on failure the queued cleanup task retries later.
If the upload fails or the browser dies, step 4 never happens and the old
recording stays current.
"""

from __future__ import annotations

import logging
import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import Settings
from app.core.errors import AppError, Conflict, NotFound, ValidationFailed
from app.models import Interview, Recording, RecordingUpload, StorageCleanupTask
from app.schemas.recordings import UploadUrlIn
from app.services.auth_service import get_owned_interview
from app.services.interview_service import now_utc
from app.storage.supabase_storage import SignedUpload, StorageClient

logger = logging.getLogger("app.recordings")

MIME_EXT = {
    "video/webm": "webm",
    "audio/webm": "weba",
    "video/mp4": "mp4",
    "audio/mp4": "m4a",
    "audio/ogg": "ogg",
}
RECORDABLE_STATES = {"in_progress", "paused", "finalizing", "evaluating", "completed", "failed"}


def base_mime(mime: str) -> str:
    return mime.split(";", 1)[0].strip().lower()


def validate_recording_request(body: UploadUrlIn, interview: Interview, settings: Settings) -> str:
    mime = base_mime(body.mime_type)
    if mime not in MIME_EXT:
        raise ValidationFailed("This recording format isn't supported.", code="RECORDING_TYPE_UNSUPPORTED")
    if interview.recording_mode == "none":
        raise Conflict("Recording was not enabled for this interview.", code="RECORDING_NOT_ENABLED")
    if interview.recording_mode == "audio" and mime.startswith("video/"):
        raise ValidationFailed(
            "This interview was set to audio-only recording.", code="RECORDING_TYPE_MISMATCH"
        )
    if body.size_bytes > settings.recording_max_bytes:
        mb = settings.recording_max_bytes // (1024 * 1024)
        raise AppError(
            f"The recording is larger than the {mb} MB storage limit. It was kept on this device "
            "only; your transcript and report are unaffected.",
            code="RECORDING_TOO_LARGE",
            status_code=413,
        )
    max_duration = interview.duration_minutes * 60 + 600
    if body.duration_seconds > max_duration:
        raise ValidationFailed(
            "The recording is longer than the interview.", code="RECORDING_DURATION_INVALID"
        )
    if interview.status not in RECORDABLE_STATES:
        raise Conflict("This interview hasn't started.", code="INTERVIEW_NOT_STARTED")
    return mime


async def issue_upload(
    db: AsyncSession,
    storage: StorageClient,
    settings: Settings,
    *,
    user_id: uuid.UUID,
    body: UploadUrlIn,
) -> tuple[RecordingUpload, SignedUpload]:
    interview = await get_owned_interview(db, user_id, body.interview_id)
    mime = validate_recording_request(body, interview, settings)
    upload_id = uuid.uuid4()
    path = f"{user_id}/{interview.id}/{upload_id}.{MIME_EXT[mime]}"
    signed = await storage.create_signed_upload(settings.recordings_bucket, path)
    upload = RecordingUpload(
        id=upload_id,
        user_id=user_id,
        interview_id=interview.id,
        storage_path=path,
        mime_type=mime,
        expected_size_bytes=body.size_bytes,
        duration_seconds=body.duration_seconds,
        status="issued",
    )
    db.add(upload)
    await db.commit()
    return upload, signed


async def confirm_upload(
    db: AsyncSession,
    storage: StorageClient,
    settings: Settings,
    *,
    user_id: uuid.UUID,
    upload_id: uuid.UUID,
) -> Recording:
    upload = (
        await db.execute(
            select(RecordingUpload).where(RecordingUpload.id == upload_id, RecordingUpload.user_id == user_id)
        )
    ).scalar_one_or_none()
    if upload is None:
        raise NotFound("Upload not found.", code="UPLOAD_NOT_FOUND")
    if upload.status == "confirmed":
        current = await db.get(Recording, user_id)
        if current and current.storage_path == upload.storage_path:
            return current  # idempotent repeat
        raise Conflict("A newer recording has replaced this one.", code="UPLOAD_SUPERSEDED")
    if upload.status != "issued":
        raise Conflict("This upload can no longer be confirmed.", code="UPLOAD_NOT_CONFIRMABLE")
    await db.commit()  # don't hold a transaction during the storage call

    info = await storage.get_object_info(settings.recordings_bucket, upload.storage_path)
    if info is None:
        raise Conflict(
            "The recording upload hasn't finished. Retry the upload.",
            code="RECORDING_NOT_UPLOADED",
            retryable=True,
        )
    size_ok = info.size == upload.expected_size_bytes
    mime_ok = info.mime_type is None or base_mime(info.mime_type) == upload.mime_type
    if not size_ok or not mime_ok or info.size > settings.recording_max_bytes:
        upload_row = await db.get(RecordingUpload, upload.id)
        if upload_row:
            upload_row.status = "rejected"
        db.add(
            StorageCleanupTask(
                bucket=settings.recordings_bucket, storage_path=upload.storage_path, reason="rejected_upload"
            )
        )
        await db.commit()
        raise ValidationFailed(
            "The uploaded recording didn't match what was expected. Try uploading again.",
            code="RECORDING_VERIFICATION_FAILED",
        )

    # Swap the pointer atomically.
    current = (
        await db.execute(select(Recording).where(Recording.user_id == user_id).with_for_update())
    ).scalar_one_or_none()
    upload_row = (
        await db.execute(select(RecordingUpload).where(RecordingUpload.id == upload.id).with_for_update())
    ).scalar_one()
    if upload_row.status == "confirmed":  # concurrent confirm won
        await db.commit()
        refreshed = await db.get(Recording, user_id)
        assert refreshed is not None
        return refreshed
    old_path = current.storage_path if current else None
    cleanup: StorageCleanupTask | None = None
    if current is None:
        current = Recording(user_id=user_id)
        db.add(current)
    current.interview_id = upload.interview_id
    current.storage_path = upload.storage_path
    current.mime_type = upload.mime_type
    current.file_size_bytes = info.size
    current.duration_seconds = upload.duration_seconds
    current.created_at = now_utc()
    upload_row.status = "confirmed"
    upload_row.confirmed_at = now_utc()
    if old_path and old_path != upload.storage_path:
        cleanup = StorageCleanupTask(
            bucket=settings.recordings_bucket, storage_path=old_path, reason="replaced_recording"
        )
        db.add(cleanup)
    await db.commit()

    if cleanup is not None:
        await try_cleanup(db, storage, cleanup.id)
    return current


async def try_cleanup(db: AsyncSession, storage: StorageClient, task_id: uuid.UUID) -> bool:
    task = await db.get(StorageCleanupTask, task_id)
    if task is None or task.status == "done":
        return True
    try:
        await storage.delete(task.bucket, [task.storage_path])
    except AppError:
        task.attempts += 1
        from datetime import timedelta

        task.next_run_at = now_utc() + timedelta(minutes=min(60, 2**task.attempts))
        if task.attempts >= 10:
            task.status = "failed"
        await db.commit()
        logger.warning("storage_cleanup_deferred task=%s attempts=%s", task.id, task.attempts)
        return False
    task.status = "done"
    await db.commit()
    return True


async def delete_current(
    db: AsyncSession, storage: StorageClient, settings: Settings, *, user_id: uuid.UUID
) -> bool:
    current = (
        await db.execute(select(Recording).where(Recording.user_id == user_id).with_for_update())
    ).scalar_one_or_none()
    if current is None:
        await db.commit()
        return False
    task = StorageCleanupTask(
        bucket=settings.recordings_bucket, storage_path=current.storage_path, reason="user_deleted"
    )
    db.add(task)
    await db.delete(current)
    await db.commit()
    await try_cleanup(db, storage, task.id)
    return True


async def playback_url(
    db: AsyncSession,
    storage: StorageClient,
    settings: Settings,
    *,
    user_id: uuid.UUID,
    interview_id: uuid.UUID,
) -> tuple[str, Recording]:
    await get_owned_interview(db, user_id, interview_id)
    current = await db.get(Recording, user_id)
    if current is None or current.interview_id != interview_id:
        raise NotFound(
            "There's no stored recording for this interview. Only your latest recording is kept.",
            code="RECORDING_NOT_FOUND",
        )
    url = await storage.create_signed_url(
        settings.recordings_bucket, current.storage_path, settings.recording_signed_url_ttl_seconds
    )
    return url, current
