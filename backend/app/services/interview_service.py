"""Interview lifecycle: state machine, creation, planning, events, completion.

State changes happen inside transactions that lock the interview row
(``SELECT ... FOR UPDATE``), so concurrent requests (double clicks, retries,
two tabs) cannot interleave. No transaction is held open during AI calls.

Attempt-selection policy (used by evaluation):
    The most recent *non-skipped* attempt of a question is evaluated. Starting a
    retake keeps the previous attempt selected until the new answer arrives, so
    abandoning a retake never loses an answer. Skipping deselects all attempts.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy import func, select, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import Settings
from app.core.errors import AppError, Conflict, RateLimited, ValidationFailed
from app.models import (
    AnswerAttempt,
    Document,
    EvaluationJob,
    Interview,
    InterviewEvent,
    InterviewPlan,
    Question,
    Report,
)
from app.providers.base import TextGenerationProvider
from app.schemas.documents import JobExtraction, ResumeExtraction
from app.schemas.interviews import EventIn, InterviewCreate
from app.services import interview_planner
from app.services.auth_service import get_owned_document, get_owned_interview

TRANSITIONS: dict[str, set[str]] = {
    "created": {"preparing", "cancelled"},
    "preparing": {"ready", "failed", "cancelled"},
    "ready": {"connecting", "cancelled"},
    "connecting": {"in_progress", "failed", "finalizing", "cancelled"},
    "in_progress": {"paused", "finalizing"},
    "paused": {"in_progress", "finalizing"},
    "finalizing": {"evaluating", "failed"},
    "evaluating": {"completed", "failed"},
    "failed": {"preparing", "connecting", "evaluating", "cancelled"},
    "completed": set(),
    "cancelled": set(),
}
# Retrying out of "failed" is only allowed back into the stage that failed.
RETRY_FROM_FAILED = {"planning": "preparing", "live": "connecting", "evaluation": "evaluating"}
LIVE_STATES = {"connecting", "in_progress", "paused"}
TERMINALISH = {"finalizing", "evaluating", "completed"}


def now_utc() -> datetime:
    return datetime.now(UTC)


def can_transition(current: str, target: str, failure_stage: str | None = None) -> bool:
    if target not in TRANSITIONS.get(current, set()):
        return False
    if current == "failed" and target != "cancelled":
        return RETRY_FROM_FAILED.get(failure_stage or "") == target
    return True


def transition(interview: Interview, target: str) -> None:
    if not can_transition(interview.status, target, interview.failure_stage):
        raise Conflict(
            f"This interview can't move from '{interview.status}' to '{target}'.",
            code="INVALID_STATE_TRANSITION",
            details={"status": interview.status},
        )
    interview.status = target
    if target != "failed":
        interview.failure_stage = None
        interview.failure_code = None


def mark_failed(interview: Interview, stage: str, code: str) -> None:
    transition(interview, "failed")
    interview.failure_stage = stage
    interview.failure_code = code


def remaining_seconds(interview: Interview, at: datetime | None = None) -> int | None:
    if interview.deadline_at is None:
        return None
    at = at or now_utc()
    return max(0, int((interview.deadline_at - at).total_seconds()))


# ---------------------------------------------------------------- creation


async def create_interview(
    db: AsyncSession,
    *,
    user_id: uuid.UUID,
    payload: InterviewCreate,
    idempotency_key: str | None,
    settings: Settings,
) -> tuple[Interview, bool]:
    """Create an interview once. Returns (interview, created)."""
    if idempotency_key:
        existing = (
            await db.execute(
                select(Interview).where(
                    Interview.user_id == user_id, Interview.idempotency_key == idempotency_key
                )
            )
        ).scalar_one_or_none()
        if existing:
            return existing, False

    resume = await get_owned_document(db, user_id, payload.resume_document_id)
    job = await get_owned_document(db, user_id, payload.job_description_document_id)
    if resume.document_type != "resume" or job.document_type != "job_description":
        raise ValidationFailed("Choose a resume and a job description.", code="DOCUMENT_TYPE_MISMATCH")
    if resume.parsing_status != "parsed" or not resume.extracted_data:
        raise ValidationFailed("Your resume hasn't been parsed successfully yet.", code="RESUME_NOT_PARSED")
    if job.parsing_status != "parsed" or not job.extracted_data:
        raise ValidationFailed(
            "The job description hasn't been parsed successfully yet.", code="JOB_NOT_PARSED"
        )

    since = now_utc() - timedelta(hours=24)
    created_today = (
        await db.execute(
            select(func.count())
            .select_from(Interview)
            .where(
                Interview.user_id == user_id,
                Interview.created_at >= since,
                Interview.status != "cancelled",
            )
        )
    ).scalar_one()
    if created_today >= settings.daily_interview_limit:
        raise RateLimited(
            f"You've reached the limit of {settings.daily_interview_limit} interviews in 24 hours. "
            "This keeps the free AI quota available for everyone.",
            code="DAILY_INTERVIEW_LIMIT",
        )

    interview = Interview(
        id=uuid.uuid4(),
        user_id=user_id,
        resume_document_id=resume.id,
        job_description_document_id=job.id,
        job_role=payload.job_role,
        duration_minutes=payload.duration_minutes,
        evaluation_rigor=payload.evaluation_rigor,
        recording_mode=payload.recording_mode,
        status="created",
        idempotency_key=idempotency_key,
    )
    db.add(interview)
    try:
        await db.commit()
    except IntegrityError:
        # Lost a race with an identical request: return the winner.
        await db.rollback()
        if not idempotency_key:
            raise
        existing = (
            await db.execute(
                select(Interview).where(
                    Interview.user_id == user_id, Interview.idempotency_key == idempotency_key
                )
            )
        ).scalar_one()
        return existing, False
    return interview, True


async def prepare_plan(
    db: AsyncSession,
    *,
    user_id: uuid.UUID,
    interview_id: uuid.UUID,
    provider: TextGenerationProvider,
) -> Interview:
    """Generate and persist the plan (idempotent: returns early if already ready)."""
    interview = await get_owned_interview(db, user_id, interview_id, for_update=True)
    if interview.status not in ("created", "failed") or (
        interview.status == "failed" and interview.failure_stage != "planning"
    ):
        if interview.status == "preparing":
            raise Conflict("The plan is already being prepared.", code="PLAN_IN_PROGRESS", retryable=True)
        await db.commit()
        return interview  # ready or later: nothing to do
    transition(interview, "preparing")
    resume_doc = await db.get(Document, interview.resume_document_id)
    job_doc = await db.get(Document, interview.job_description_document_id)
    if not resume_doc or not job_doc or not resume_doc.extracted_data or not job_doc.extracted_data:
        mark_failed(interview, "planning", "DOCUMENTS_MISSING")
        await db.commit()
        raise ValidationFailed(
            "The resume or job description is no longer available.", code="DOCUMENTS_MISSING"
        )
    resume = ResumeExtraction.model_validate(resume_doc.extracted_data)
    job = JobExtraction.model_validate(job_doc.extracted_data)
    await db.commit()  # release the row lock before the AI call

    try:
        draft = await interview_planner.generate_plan(
            provider=provider,
            resume=resume,
            job=job,
            role=interview.job_role,
            rigor=interview.evaluation_rigor,
            duration_minutes=interview.duration_minutes,
            user_id=user_id,
            interview_id=interview.id,
        )
    except AppError as exc:
        interview = await get_owned_interview(db, user_id, interview_id, for_update=True)
        if interview.status == "preparing":
            mark_failed(interview, "planning", exc.code)
        await db.commit()
        raise

    interview = await get_owned_interview(db, user_id, interview_id, for_update=True)
    if interview.status != "preparing":
        await db.commit()
        return interview
    existing_plan = (
        await db.execute(select(InterviewPlan.id).where(InterviewPlan.interview_id == interview.id))
    ).first()
    if existing_plan is None:
        await interview_planner.persist_plan(db, interview, draft)
    transition(interview, "ready")
    await db.commit()
    return interview


# ---------------------------------------------------------------- events


async def _questions(db: AsyncSession, interview_id: uuid.UUID) -> list[Question]:
    return list(
        (
            await db.execute(
                select(Question)
                .where(Question.interview_id == interview_id)
                .order_by(Question.sequence_number)
            )
        ).scalars()
    )


async def progress(db: AsyncSession, interview_id: uuid.UUID) -> dict[str, int]:
    rows = (
        await db.execute(
            select(Question.status, Question.priority, func.count())
            .where(Question.interview_id == interview_id)
            .group_by(Question.status, Question.priority)
        )
    ).all()
    out = {"total": 0, "core_total": 0, "answered": 0, "skipped": 0, "pending": 0}
    for status, priority, count in rows:
        out["total"] += count
        if priority == "core":
            out["core_total"] += count
        if status == "answered":
            out["answered"] += count
        elif status == "skipped":
            out["skipped"] += count
        else:
            out["pending"] += count
    return out


def _sanitize_payload(event: EventIn) -> dict:
    payload: dict = {}
    if event.question_id:
        payload["question_id"] = str(event.question_id)
    if event.answer_source:
        payload["answer_source"] = event.answer_source
    if event.transcript_text is not None:
        payload["answer_chars"] = len(event.transcript_text)
    if event.event_type == "transcript_segment":
        payload["speaker"] = event.speaker
        payload["text"] = (event.text or "")[:8000]
    if event.metric_name:
        payload["metric"] = event.metric_name
        payload["value"] = event.metric_value
    if event.reason:
        payload["reason"] = event.reason[:200]
    return payload


async def _next_attempt_number(db: AsyncSession, question_id: uuid.UUID) -> int:
    current = (
        await db.execute(
            select(func.max(AnswerAttempt.attempt_number)).where(AnswerAttempt.question_id == question_id)
        )
    ).scalar_one()
    return (current or 0) + 1


async def _deselect_attempts(db: AsyncSession, question_id: uuid.UUID) -> None:
    await db.execute(
        update(AnswerAttempt)
        .where(AnswerAttempt.question_id == question_id, AnswerAttempt.selected_for_evaluation)
        .values(selected_for_evaluation=False)
    )


async def _apply_event(
    db: AsyncSession,
    interview: Interview,
    event: EventIn,
    question: Question | None,
    at: datetime,
) -> None:
    kind = event.event_type
    if kind == "session_started":
        if interview.status == "connecting":
            transition(interview, "in_progress")
        if interview.started_at is None:
            interview.started_at = at
            interview.deadline_at = at + timedelta(minutes=interview.duration_minutes)
        return
    if kind == "paused" and interview.status == "in_progress":
        transition(interview, "paused")
        return
    if kind == "resumed" and interview.status == "paused":
        transition(interview, "in_progress")
        return
    if (
        kind in ("question_asked", "answer_submitted", "question_skipped", "answer_retake")
        and question is None
    ):
        raise ValidationFailed("question_id is required for this event.", code="QUESTION_REQUIRED")
    if kind == "question_asked":
        assert question is not None
        if question.status == "pending":
            question.status = "asked"
            question.asked_at = at
        return
    if kind == "answer_submitted":
        assert question is not None
        if not event.answer_source or not (event.transcript_text or "").strip():
            raise ValidationFailed("An answer needs text and a source.", code="ANSWER_EMPTY")
        if question.status == "answered":
            raise Conflict(
                "This question already has an answer. Use retake to answer again.",
                code="ANSWER_ALREADY_RECORDED",
            )
        await _deselect_attempts(db, question.id)
        db.add(
            AnswerAttempt(
                question_id=question.id,
                attempt_number=await _next_attempt_number(db, question.id),
                answer_source=event.answer_source,
                transcript_text=event.transcript_text.strip(),
                exchange=[t.model_dump() for t in (event.exchange or [])],
                selected_for_evaluation=True,
                is_skipped=False,
                started_at=question.asked_at,
                completed_at=at,
            )
        )
        question.status = "answered"
        return
    if kind == "question_skipped":
        assert question is not None
        if question.status == "skipped":
            return
        await _deselect_attempts(db, question.id)
        db.add(
            AnswerAttempt(
                question_id=question.id,
                attempt_number=await _next_attempt_number(db, question.id),
                answer_source="none",
                transcript_text="",
                selected_for_evaluation=False,
                is_skipped=True,
                started_at=question.asked_at,
                completed_at=at,
            )
        )
        question.status = "skipped"
        return
    if kind == "answer_retake":
        assert question is not None
        if question.status != "answered":
            raise Conflict("Only an answered question can be retaken.", code="RETAKE_NOT_ALLOWED")
        question.status = "retaking"
        return
    # transcript_segment, connection_lost, reconnected, metric: recorded only.


async def record_events(
    db: AsyncSession,
    *,
    user_id: uuid.UUID,
    interview_id: uuid.UUID,
    events: list[EventIn],
    settings: Settings,
) -> tuple[Interview, list[tuple[str, int, bool]]]:
    interview = await get_owned_interview(db, user_id, interview_id, for_update=True)
    at = now_utc()
    accepting = interview.status in LIVE_STATES
    in_grace = interview.status == "finalizing" or (
        interview.status in ("evaluating",)
        and interview.completed_at is not None
        and at - interview.completed_at < timedelta(seconds=settings.completion_grace_seconds)
    )
    deadline_passed = interview.deadline_at is not None and at > interview.deadline_at + timedelta(
        seconds=settings.completion_grace_seconds
    )

    questions = {q.id: q for q in await _questions(db, interview.id)}
    existing = {
        cid: seq
        for cid, seq in (
            await db.execute(
                select(InterviewEvent.client_event_id, InterviewEvent.sequence_number).where(
                    InterviewEvent.interview_id == interview.id,
                    InterviewEvent.client_event_id.in_([e.client_event_id for e in events]),
                )
            )
        ).all()
    }
    next_seq = (
        await db.execute(
            select(func.coalesce(func.max(InterviewEvent.sequence_number), 0)).where(
                InterviewEvent.interview_id == interview.id
            )
        )
    ).scalar_one()

    results: list[tuple[str, int, bool]] = []
    for event in events:
        if event.client_event_id in existing:
            results.append((event.client_event_id, existing[event.client_event_id], True))
            continue
        late_ok = event.event_type in ("transcript_segment", "answer_submitted", "metric")
        if not accepting and not (in_grace and late_ok) and event.event_type != "metric":
            raise Conflict(
                "This interview is not accepting answers right now.",
                code="INTERVIEW_NOT_ACTIVE",
                details={"status": interview.status},
            )
        if deadline_passed and event.event_type not in ("transcript_segment", "metric"):
            raise Conflict("The interview time is over.", code="INTERVIEW_TIME_EXPIRED")
        question = None
        if event.question_id is not None:
            question = questions.get(event.question_id)
            if question is None:
                raise ValidationFailed(
                    "That question isn't part of this interview.", code="QUESTION_NOT_FOUND"
                )
        await _apply_event(db, interview, event, question, at)
        next_seq += 1
        db.add(
            InterviewEvent(
                interview_id=interview.id,
                client_event_id=event.client_event_id,
                event_type=event.event_type,
                event_payload=_sanitize_payload(event),
                sequence_number=next_seq,
            )
        )
        existing[event.client_event_id] = next_seq
        results.append((event.client_event_id, next_seq, False))
    interview.last_activity_at = at
    await db.commit()
    return interview, results


# ---------------------------------------------------------------- completion


async def enqueue_evaluation(db: AsyncSession, interview_id: uuid.UUID) -> None:
    await db.execute(
        insert(EvaluationJob)
        .values(interview_id=interview_id, status="queued")
        .on_conflict_do_update(
            index_elements=[EvaluationJob.interview_id],
            set_={
                "status": "queued",
                "next_run_at": func.now(),
                "locked_until": None,
                "attempts": 0,
                "last_error_code": None,
            },
            where=EvaluationJob.status == "failed",
        )
    )
    await db.execute(
        insert(Report)
        .values(interview_id=interview_id, report_status="pending")
        .on_conflict_do_update(
            index_elements=[Report.interview_id],
            set_={"report_status": "pending"},
            where=Report.report_status == "failed",
        )
    )


async def complete_interview(db: AsyncSession, *, interview: Interview, reason: str) -> Interview:
    """Finalize idempotently. The caller must hold the row lock."""
    if interview.status in TERMINALISH or interview.status == "cancelled":
        return interview
    if interview.status in ("created", "preparing", "ready"):
        transition(interview, "cancelled")
        interview.completed_at = now_utc()
        return interview
    if interview.status == "failed" and interview.failure_stage == "live":
        answered = (await progress(db, interview.id))["answered"]
        if answered == 0:
            transition(interview, "cancelled")
            interview.completed_at = now_utc()
            return interview
        interview.status = "finalizing"  # recover a dropped session that has answers
        interview.failure_stage = interview.failure_code = None
    elif interview.status == "failed":
        raise Conflict(
            "This interview can't be completed in its current state.", code="INVALID_STATE_TRANSITION"
        )
    elif interview.status == "connecting" and (await progress(db, interview.id))["answered"] == 0:
        transition(interview, "cancelled")
        interview.completed_at = now_utc()
        return interview
    else:
        transition(interview, "finalizing")
    interview.completed_at = interview.completed_at or now_utc()
    # Questions still marked "retaking" fall back to the previously selected attempt.
    await db.execute(
        update(Question)
        .where(Question.interview_id == interview.id, Question.status == "retaking")
        .values(status="answered")
    )
    transition(interview, "evaluating")
    await enqueue_evaluation(db, interview.id)
    return interview


async def retry_evaluation(db: AsyncSession, interview: Interview) -> Interview:
    report_status = (
        await db.execute(select(Report.report_status).where(Report.interview_id == interview.id))
    ).scalar_one_or_none()
    if (
        interview.status == "failed" and interview.failure_stage == "evaluation"
    ) or report_status == "failed":
        if interview.status != "evaluating":
            transition(interview, "evaluating")
        await enqueue_evaluation(db, interview.id)
        return interview
    if interview.status in ("evaluating", "completed"):
        return interview
    raise Conflict("There is no failed evaluation to retry.", code="NOTHING_TO_RETRY")


async def cancel_interview(db: AsyncSession, interview: Interview) -> Interview:
    if interview.status == "cancelled":
        return interview
    if interview.status not in ("created", "preparing", "ready", "failed", "connecting"):
        raise Conflict("Only interviews that haven't started can be cancelled.", code="CANCEL_NOT_ALLOWED")
    transition(interview, "cancelled")
    return interview


async def build_transcript(db: AsyncSession, interview_id: uuid.UUID) -> list[dict]:
    rows = (
        await db.execute(
            select(InterviewEvent.event_payload, InterviewEvent.created_at)
            .where(
                InterviewEvent.interview_id == interview_id, InterviewEvent.event_type == "transcript_segment"
            )
            .order_by(InterviewEvent.sequence_number)
        )
    ).all()
    return [
        {
            "speaker": p.get("speaker"),
            "text": p.get("text"),
            "question_id": p.get("question_id"),
            "at": at.isoformat(),
        }
        for p, at in rows
    ]
