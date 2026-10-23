from __future__ import annotations

import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

RecordingMime = Literal["video/webm", "audio/webm", "video/mp4", "audio/mp4", "audio/ogg"]


class UploadUrlIn(BaseModel):
    interview_id: uuid.UUID
    mime_type: str = Field(max_length=128)
    size_bytes: int = Field(gt=0)
    duration_seconds: int = Field(ge=1, le=60 * 60)


class UploadUrlOut(BaseModel):
    upload_id: uuid.UUID
    bucket: str
    path: str
    token: str
    signed_url: str
    max_bytes: int


class ConfirmIn(BaseModel):
    upload_id: uuid.UUID


class RecordingOut(BaseModel):
    interview_id: uuid.UUID
    mime_type: str
    file_size_bytes: int
    duration_seconds: int | None
    created_at: datetime


class PlaybackOut(BaseModel):
    url: str
    expires_in_seconds: int
    mime_type: str
