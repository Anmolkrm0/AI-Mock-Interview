"""SQLAlchemy ORM models.

Every user-owned row carries ``user_id`` (directly or through its interview) so
ownership can be enforced in queries *and* by Postgres Row Level Security.
"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import (
    BigInteger,
    Boolean,
    CheckConstraint,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


class Base(DeclarativeBase):
    pass


def _uuid_pk() -> Mapped[uuid.UUID]:
    return mapped_column(
        UUID(as_uuid=True),
        primary_key=True,
        default=uuid.uuid4,
        server_default=text("gen_random_uuid()"),
    )


def _created() -> Mapped[datetime]:
    return mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now())


def _updated() -> Mapped[datetime]:
    return mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )


class Profile(Base):
    __tablename__ = "profiles"
    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True)
    display_name: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = _created()
    updated_at: Mapped[datetime] = _updated()


class Document(Base):
    __tablename__ = "documents"
    __table_args__ = (
        CheckConstraint("document_type in ('resume','job_description')", name="ck_documents_type"),
        CheckConstraint(
            "parsing_status in ('pending','extracting','parsed','failed')",
            name="ck_documents_parsing_status",
        ),
        Index("ix_documents_user_created", "user_id", "created_at"),
    )
    id: Mapped[uuid.UUID] = _uuid_pk()
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("profiles.id", ondelete="CASCADE"), nullable=False
    )
    document_type: Mapped[str] = mapped_column(String(32), nullable=False)
    file_name: Mapped[str | None] = mapped_column(Text)
    mime_type: Mapped[str | None] = mapped_column(String(128))
    size_bytes: Mapped[int | None] = mapped_column(Integer)
    storage_path: Mapped[str | None] = mapped_column(Text)
    content_sha256: Mapped[str | None] = mapped_column(String(64))
    extracted_text: Mapped[str | None] = mapped_column(Text)
    extracted_data: Mapped[dict[str, Any] | None] = mapped_column(JSONB)
    parsing_status: Mapped[str] = mapped_column(String(16), nullable=False, default="pending")
    parsing_error: Mapped[str | None] = mapped_column(String(64))
    text_purged_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = _created()
    updated_at: Mapped[datetime] = _updated()


INTERVIEW_STATUSES = (
    "created",
    "preparing",
    "ready",
    "connecting",
    "in_progress",
    "paused",
    "finalizing",
    "evaluating",
    "completed",
    "failed",
    "cancelled",
)


class Interview(Base):
    __tablename__ = "interviews"
    __table_args__ = (
        CheckConstraint("duration_minutes in (10,20,30,45)", name="ck_interviews_duration"),
        CheckConstraint(
            "evaluation_rigor in ('standard','target_bar','stress_test')",
            name="ck_interviews_rigor",
        ),
        CheckConstraint(
            "status in (" + ",".join(f"'{s}'" for s in INTERVIEW_STATUSES) + ")",
            name="ck_interviews_status",
        ),
        UniqueConstraint("user_id", "idempotency_key", name="uq_interviews_user_idem"),
        Index("ix_interviews_user_created", "user_id", "created_at"),
        Index("ix_interviews_status", "status"),
    )
    id: Mapped[uuid.UUID] = _uuid_pk()
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("profiles.id", ondelete="CASCADE"), nullable=False
    )
    resume_document_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("documents.id", ondelete="SET NULL")
    )
    job_description_document_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("documents.id", ondelete="SET NULL")
    )
    job_role: Mapped[str] = mapped_column(String(200), nullable=False)
    duration_minutes: Mapped[int] = mapped_column(Integer, nullable=False)
    evaluation_rigor: Mapped[str] = mapped_column(String(16), nullable=False)
    recording_mode: Mapped[str] = mapped_column(String(16), nullable=False, default="none")
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="created")
    failure_stage: Mapped[str | None] = mapped_column(String(32))
    failure_code: Mapped[str | None] = mapped_column(String(64))
    idempotency_key: Mapped[str | None] = mapped_column(String(128))
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    deadline_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_activity_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    live_tokens_issued: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    created_at: Mapped[datetime] = _created()
    updated_at: Mapped[datetime] = _updated()

    questions: Mapped[list[Question]] = relationship(
        back_populates="interview", order_by="Question.sequence_number", lazy="raise"
    )


class InterviewPlan(Base):
    __tablename__ = "interview_plans"
    __table_args__ = (UniqueConstraint("interview_id", "version", name="uq_plans_version"),)
    id: Mapped[uuid.UUID] = _uuid_pk()
    interview_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("interviews.id", ondelete="CASCADE"), nullable=False
    )
    plan_json: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False)
    version: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    created_at: Mapped[datetime] = _created()


class Question(Base):
    __tablename__ = "questions"
    __table_args__ = (
        UniqueConstraint("interview_id", "sequence_number", name="uq_questions_sequence"),
        CheckConstraint(
            "status in ('pending','asked','answered','skipped','retaking')",
            name="ck_questions_status",
        ),
        CheckConstraint("difficulty between 1 and 5", name="ck_questions_difficulty"),
    )
    id: Mapped[uuid.UUID] = _uuid_pk()
    interview_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("interviews.id", ondelete="CASCADE"), nullable=False
    )
    sequence_number: Mapped[int] = mapped_column(Integer, nullable=False)
    question_text: Mapped[str] = mapped_column(Text, nullable=False)
    competency: Mapped[str] = mapped_column(String(120), nullable=False)
    difficulty: Mapped[int] = mapped_column(Integer, nullable=False)
    question_type: Mapped[str] = mapped_column(String(32), nullable=False)
    priority: Mapped[str] = mapped_column(String(16), nullable=False, default="core")
    time_allocation_seconds: Mapped[int] = mapped_column(Integer, nullable=False, default=120)
    expected_evidence: Mapped[list[str]] = mapped_column(JSONB, nullable=False, default=list)
    follow_up_topics: Mapped[list[str]] = mapped_column(JSONB, nullable=False, default=list)
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="pending")
    asked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = _created()

    interview: Mapped[Interview] = relationship(back_populates="questions", lazy="raise")


class AnswerAttempt(Base):
    __tablename__ = "answer_attempts"
    __table_args__ = (
        UniqueConstraint("question_id", "attempt_number", name="uq_attempts_number"),
        CheckConstraint("answer_source in ('voice','text','none')", name="ck_attempts_source"),
        Index(
            "uq_attempts_one_selected",
            "question_id",
            unique=True,
            postgresql_where=text("selected_for_evaluation"),
        ),
    )
    id: Mapped[uuid.UUID] = _uuid_pk()
    question_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("questions.id", ondelete="CASCADE"), nullable=False
    )
    attempt_number: Mapped[int] = mapped_column(Integer, nullable=False)
    answer_source: Mapped[str] = mapped_column(String(8), nullable=False)
    transcript_text: Mapped[str] = mapped_column(Text, nullable=False, default="")
    exchange: Mapped[list[dict[str, Any]]] = mapped_column(JSONB, nullable=False, default=list)
    selected_for_evaluation: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    is_skipped: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = _created()


class InterviewEvent(Base):
    __tablename__ = "interview_events"
    __table_args__ = (
        UniqueConstraint("interview_id", "sequence_number", name="uq_events_sequence"),
        UniqueConstraint("interview_id", "client_event_id", name="uq_events_client_id"),
    )
    id: Mapped[uuid.UUID] = _uuid_pk()
    interview_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("interviews.id", ondelete="CASCADE"), nullable=False
    )
    client_event_id: Mapped[str] = mapped_column(String(64), nullable=False)
    event_type: Mapped[str] = mapped_column(String(40), nullable=False)
    event_payload: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False, default=dict)
    sequence_number: Mapped[int] = mapped_column(Integer, nullable=False)
    created_at: Mapped[datetime] = _created()


class Report(Base):
    __tablename__ = "reports"
    __table_args__ = (
        UniqueConstraint("interview_id", name="uq_reports_interview"),
        CheckConstraint(
            "overall_score is null or (overall_score >= 0 and overall_score <= 100)",
            name="ck_reports_score",
        ),
        CheckConstraint("report_status in ('pending','completed','failed')", name="ck_reports_status"),
    )
    id: Mapped[uuid.UUID] = _uuid_pk()
    interview_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("interviews.id", ondelete="CASCADE"), nullable=False
    )
    overall_score: Mapped[float | None] = mapped_column(Float)
    evidence_sufficiency: Mapped[str | None] = mapped_column(String(16))
    competency_scores: Mapped[list[dict[str, Any]]] = mapped_column(JSONB, nullable=False, default=list)
    question_evaluations: Mapped[list[dict[str, Any]]] = mapped_column(JSONB, nullable=False, default=list)
    strengths: Mapped[list[Any]] = mapped_column(JSONB, nullable=False, default=list)
    improvement_areas: Mapped[list[Any]] = mapped_column(JSONB, nullable=False, default=list)
    recommendations: Mapped[list[Any]] = mapped_column(JSONB, nullable=False, default=list)
    summary: Mapped[str | None] = mapped_column(Text)
    unevaluated_questions: Mapped[list[dict[str, Any]]] = mapped_column(JSONB, nullable=False, default=list)
    model_info: Mapped[dict[str, Any]] = mapped_column(JSONB, nullable=False, default=dict)
    report_status: Mapped[str] = mapped_column(String(16), nullable=False, default="pending")
    created_at: Mapped[datetime] = _created()
    updated_at: Mapped[datetime] = _updated()


class Recording(Base):
    """One current recording pointer per user (primary key = user_id)."""

    __tablename__ = "recordings"
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("profiles.id", ondelete="CASCADE"), primary_key=True
    )
    interview_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("interviews.id", ondelete="CASCADE"), nullable=False
    )
    storage_path: Mapped[str] = mapped_column(Text, nullable=False)
    mime_type: Mapped[str] = mapped_column(String(128), nullable=False)
    file_size_bytes: Mapped[int] = mapped_column(BigInteger, nullable=False)
    duration_seconds: Mapped[int | None] = mapped_column(Integer)
    created_at: Mapped[datetime] = _created()


class RecordingUpload(Base):
    """Every issued upload slot. Used to validate confirmations and clean orphans."""

    __tablename__ = "recording_uploads"
    __table_args__ = (
        CheckConstraint("status in ('issued','confirmed','rejected','expired')", name="ck_uploads_status"),
        Index("ix_uploads_user_status", "user_id", "status"),
    )
    id: Mapped[uuid.UUID] = _uuid_pk()
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("profiles.id", ondelete="CASCADE"), nullable=False
    )
    interview_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("interviews.id", ondelete="CASCADE"), nullable=False
    )
    storage_path: Mapped[str] = mapped_column(Text, nullable=False, unique=True)
    mime_type: Mapped[str] = mapped_column(String(128), nullable=False)
    expected_size_bytes: Mapped[int] = mapped_column(BigInteger, nullable=False)
    duration_seconds: Mapped[int | None] = mapped_column(Integer)
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="issued")
    created_at: Mapped[datetime] = _created()
    confirmed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class Feedback(Base):
    __tablename__ = "feedback"
    __table_args__ = (
        CheckConstraint("rating between 1 and 5", name="ck_feedback_rating"),
        UniqueConstraint("user_id", "interview_id", name="uq_feedback_user_interview"),
    )
    id: Mapped[uuid.UUID] = _uuid_pk()
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("profiles.id", ondelete="CASCADE"), nullable=False
    )
    interview_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("interviews.id", ondelete="CASCADE"), nullable=False
    )
    rating: Mapped[int] = mapped_column(Integer, nullable=False)
    comments: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = _created()
    updated_at: Mapped[datetime] = _updated()


class EvaluationJob(Base):
    """Durable job row so report generation survives restarts."""

    __tablename__ = "evaluation_jobs"
    __table_args__ = (
        UniqueConstraint("interview_id", name="uq_eval_jobs_interview"),
        CheckConstraint("status in ('queued','running','succeeded','failed')", name="ck_eval_jobs_status"),
        Index("ix_eval_jobs_runnable", "status", "next_run_at"),
    )
    id: Mapped[uuid.UUID] = _uuid_pk()
    interview_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("interviews.id", ondelete="CASCADE"), nullable=False
    )
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="queued")
    attempts: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    last_error_code: Mapped[str | None] = mapped_column(String(64))
    next_run_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    locked_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = _created()
    updated_at: Mapped[datetime] = _updated()


class StorageCleanupTask(Base):
    __tablename__ = "storage_cleanup_tasks"
    __table_args__ = (
        CheckConstraint("status in ('pending','done','failed')", name="ck_cleanup_status"),
        Index("ix_cleanup_pending", "status", "next_run_at"),
    )
    id: Mapped[uuid.UUID] = _uuid_pk()
    bucket: Mapped[str] = mapped_column(String(64), nullable=False)
    storage_path: Mapped[str] = mapped_column(Text, nullable=False)
    reason: Mapped[str] = mapped_column(String(64), nullable=False)
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="pending")
    attempts: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    next_run_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    created_at: Mapped[datetime] = _created()


class AIUsage(Base):
    __tablename__ = "ai_usage"
    __table_args__ = (Index("ix_ai_usage_user_created", "user_id", "created_at"),)
    id: Mapped[uuid.UUID] = _uuid_pk()
    user_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("profiles.id", ondelete="SET NULL")
    )
    interview_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("interviews.id", ondelete="SET NULL")
    )
    operation: Mapped[str] = mapped_column(String(48), nullable=False)
    provider: Mapped[str] = mapped_column(String(32), nullable=False)
    model: Mapped[str] = mapped_column(String(96), nullable=False)
    input_tokens: Mapped[int | None] = mapped_column(Integer)
    output_tokens: Mapped[int | None] = mapped_column(Integer)
    latency_ms: Mapped[int] = mapped_column(Integer, nullable=False)
    success: Mapped[bool] = mapped_column(Boolean, nullable=False)
    error_code: Mapped[str | None] = mapped_column(String(64))
    created_at: Mapped[datetime] = _created()
