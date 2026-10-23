from __future__ import annotations

import uuid

from fastapi import APIRouter, Response

from app.api.deps import DB, CurrentUser, SettingsDep, Storage
from app.core.errors import NotFound
from app.models import Recording
from app.schemas.recordings import (
    ConfirmIn,
    PlaybackOut,
    RecordingOut,
    UploadUrlIn,
    UploadUrlOut,
)
from app.services import recording_service

router = APIRouter(tags=["recordings"])


def _out(r: Recording) -> RecordingOut:
    return RecordingOut(
        interview_id=r.interview_id,
        mime_type=r.mime_type,
        file_size_bytes=r.file_size_bytes,
        duration_seconds=r.duration_seconds,
        created_at=r.created_at,
    )


@router.post("/recordings/upload-url", response_model=UploadUrlOut)
async def upload_url(
    body: UploadUrlIn, user: CurrentUser, db: DB, settings: SettingsDep, storage: Storage
) -> UploadUrlOut:
    upload, signed = await recording_service.issue_upload(db, storage, settings, user_id=user.id, body=body)
    return UploadUrlOut(
        upload_id=upload.id,
        bucket=settings.recordings_bucket,
        path=signed.path,
        token=signed.token,
        signed_url=signed.signed_url,
        max_bytes=settings.recording_max_bytes,
    )


@router.post("/recordings/confirm", response_model=RecordingOut)
async def confirm(
    body: ConfirmIn, user: CurrentUser, db: DB, settings: SettingsDep, storage: Storage
) -> RecordingOut:
    recording = await recording_service.confirm_upload(
        db, storage, settings, user_id=user.id, upload_id=body.upload_id
    )
    return _out(recording)


@router.get("/recordings/latest", response_model=RecordingOut)
async def latest(user: CurrentUser, db: DB) -> RecordingOut:
    current = await db.get(Recording, user.id)
    if current is None:
        raise NotFound("You don't have a stored recording.", code="RECORDING_NOT_FOUND")
    return _out(current)


@router.delete("/recordings/latest", status_code=204)
async def delete_latest(user: CurrentUser, db: DB, settings: SettingsDep, storage: Storage) -> Response:
    deleted = await recording_service.delete_current(db, storage, settings, user_id=user.id)
    if not deleted:
        raise NotFound("You don't have a stored recording.", code="RECORDING_NOT_FOUND")
    return Response(status_code=204)


@router.get("/interviews/{interview_id}/recording-url", response_model=PlaybackOut)
async def recording_url(
    interview_id: uuid.UUID, user: CurrentUser, db: DB, settings: SettingsDep, storage: Storage
) -> PlaybackOut:
    url, rec = await recording_service.playback_url(
        db, storage, settings, user_id=user.id, interview_id=interview_id
    )
    return PlaybackOut(
        url=url, expires_in_seconds=settings.recording_signed_url_ttl_seconds, mime_type=rec.mime_type
    )
