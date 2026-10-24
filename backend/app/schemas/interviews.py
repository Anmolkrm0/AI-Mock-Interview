"""Interview API schemas."""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.schemas.plan import Duration, Rigor


class InterviewCreate(BaseModel):
    resume_document_id: uuid.UUID
    job_description_document_id: uuid.UUID
    job_role: str = Field(min_length=2, max_length=200)
    duration_minutes: Duration
    evaluation_rigor: Rigor
    recording_mode: Literal["video", "audio", "none"] = "none"
    consent_given: bool

    @field_validator("job_role")
    @classmethod
    def _clean_role(cls, v: str) -> str:
        cleaned = " ".join(v.split())
        if len(cleaned) < 2:
            raise ValueError("Enter a job role")
        return cleaned

    @field_validator("consent_given")
    @classmethod
    def _consent(cls, v: bool) -> bool:
        if not v:
            raise ValueError("Consent is required to start an interview")
        return v


class PlanCreate(BaseModel):
    interview_id: uuid.UUID


class QuestionOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    sequence_number: int
    question_text: str
    competency: str
    difficulty: int
    question_type: str
    priority: str
    time_allocation_seconds: int
    status: str


class InterviewOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    job_role: str
    duration_minutes: int
    evaluation_rigor: str
    recording_mode: str
    status: str
    failure_stage: str | None
    failure_code: str | None
    started_at: datetime | None
    deadline_at: datetime | None
    completed_at: datetime | None
    created_at: datetime


class InterviewDetail(InterviewOut):
    questions: list[QuestionOut] = Field(default_factory=list)
    objectives: list[str] = Field(default_factory=list)
    attempts: dict[str, list[dict[str, Any]]] = Field(default_factory=dict)
    transcript: list[dict[str, Any]] = Field(default_factory=list)
    server_time: datetime


class InterviewSummary(BaseModel):
    id: uuid.UUID
    job_role: str
    duration_minutes: int
    evaluation_rigor: str
    status: str
    overall_score: float | None
    report_status: str | None
    evidence_sufficiency: str | None = None
    failure_stage: str | None = None
    failure_code: str | None = None
    has_current_recording: bool
    created_at: datetime
    completed_at: datetime | None


class InterviewPage(BaseModel):
    items: list[InterviewSummary]
    total: int
    limit: int
    offset: int
    current_recording_interview_id: uuid.UUID | None


class StatusOut(BaseModel):
    id: uuid.UUID
    status: str
    failure_stage: str | None
    failure_code: str | None
    report_status: str | None
    evaluation_attempts: int
    started_at: datetime | None
    deadline_at: datetime | None
    server_time: datetime
    remaining_seconds: int | None
    progress: dict[str, int]


class LiveTokenOut(BaseModel):
    provider: str
    token: str
    model: str
    api_version: str
    expires_at: datetime
    new_session_expires_at: datetime
    connect_config: dict[str, Any]
    deadline_at: datetime | None
    server_time: datetime


EVENT_TYPES = Literal[
    "session_started",
    "question_asked",
    "answer_submitted",
    "question_skipped",
    "answer_retake",
    "transcript_segment",
    "connection_lost",
    "reconnected",
    "paused",
    "resumed",
    "metric",
]


class ExchangeTurn(BaseModel):
    speaker: Literal["interviewer", "candidate"]
    text: str = Field(max_length=8000)


class EventIn(BaseModel):
    client_event_id: Annotated[str, Field(min_length=8, max_length=64, pattern=r"^[A-Za-z0-9_\-]+$")]
    event_type: EVENT_TYPES
    question_id: uuid.UUID | None = None
    answer_source: Literal["voice", "text"] | None = None
    transcript_text: str | None = Field(default=None, max_length=20_000)
    exchange: list[ExchangeTurn] | None = Field(default=None, max_length=60)
    speaker: Literal["interviewer", "candidate"] | None = None
    text: str | None = Field(default=None, max_length=8000)
    metric_name: (
        Literal[
            "time_to_first_response_ms",
            "transcription_delay_ms",
            "ai_turn_duration_ms",
            "live_connection_failed",
            "recording_upload_failed",
        ]
        | None
    ) = None
    metric_value: float | None = Field(default=None, ge=0, le=86_400_000)
    reason: str | None = Field(default=None, max_length=200)


class EventBatch(BaseModel):
    events: list[EventIn] = Field(min_length=1, max_length=50)


class EventResult(BaseModel):
    client_event_id: str
    sequence_number: int
    duplicate: bool


class EventBatchOut(BaseModel):
    results: list[EventResult]
    status: str
    progress: dict[str, int]
    remaining_seconds: int | None


class CompleteIn(BaseModel):
    reason: Literal["user_ended", "time_expired", "all_questions_done"] = "user_ended"


class FeedbackIn(BaseModel):
    rating: int = Field(ge=1, le=5)
    comments: str | None = Field(default=None, max_length=2000)


class FeedbackOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    rating: int
    comments: str | None
    created_at: datetime
