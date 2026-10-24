from __future__ import annotations

import uuid

from fastapi import APIRouter, Header, Query, Response
from sqlalchemy import delete, func, select
from sqlalchemy.dialects.postgresql import insert

from app.api.deps import DB, CurrentUser, Providers, SettingsDep, limit_ai
from app.core.errors import Conflict, NotFound
from app.models import (
    AnswerAttempt,
    Document,
    EvaluationJob,
    Feedback,
    Interview,
    InterviewEvent,
    InterviewPlan,
    Question,
    Recording,
    RecordingUpload,
    Report,
    StorageCleanupTask,
)
from app.schemas.interviews import (
    CompleteIn,
    EventBatch,
    EventBatchOut,
    EventResult,
    FeedbackIn,
    FeedbackOut,
    InterviewCreate,
    InterviewDetail,
    InterviewOut,
    InterviewPage,
    InterviewSummary,
    LiveTokenOut,
    PlanCreate,
    QuestionOut,
    StatusOut,
)
from app.schemas.report import ReportOut
from app.services import interview_service, live_ai_service
from app.services.auth_service import get_owned_interview

router = APIRouter(prefix="/interviews", tags=["interviews"])


@router.post("", response_model=InterviewOut, status_code=201)
async def create_interview(
    body: InterviewCreate,
    user: CurrentUser,
    db: DB,
    settings: SettingsDep,
    providers: Providers,
    response: Response,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key", max_length=128),
) -> InterviewOut:
    if not providers.live.is_configured() or not providers.text.is_configured():
        from app.providers.base import not_configured

        raise not_configured("The AI provider", "GEMINI_API_KEY")
    interview, created = await interview_service.create_interview(
        db, user_id=user.id, payload=body, idempotency_key=idempotency_key, settings=settings
    )
    if not created:
        response.status_code = 200
    return InterviewOut.model_validate(interview)


@router.post("/plan", response_model=InterviewDetail)
async def create_plan(
    body: PlanCreate, user: CurrentUser, db: DB, settings: SettingsDep, providers: Providers
) -> InterviewDetail:
    interview = await get_owned_interview(db, user.id, body.interview_id)
    if interview.status in ("created",) or (
        interview.status == "failed" and interview.failure_stage == "planning"
    ):
        limit_ai(user, settings)
    await db.commit()
    await interview_service.prepare_plan(
        db, user_id=user.id, interview_id=body.interview_id, provider=providers.text
    )
    return await _detail(db, user.id, body.interview_id, include_transcript=False)


@router.get("", response_model=InterviewPage)
async def list_interviews(
    user: CurrentUser,
    db: DB,
    limit: int = Query(default=20, ge=1, le=50),
    offset: int = Query(default=0, ge=0),
) -> InterviewPage:
    total = (
        await db.execute(
            select(func.count())
            .select_from(Interview)
            .where(Interview.user_id == user.id, Interview.status != "cancelled")
        )
    ).scalar_one()
    rows = (
        await db.execute(
            select(
                Interview,
                Report.overall_score,
                Report.report_status,
                Report.evidence_sufficiency,
            )
            .outerjoin(Report, Report.interview_id == Interview.id)
            .where(Interview.user_id == user.id, Interview.status != "cancelled")
            .order_by(Interview.created_at.desc())
            .limit(limit)
            .offset(offset)
        )
    ).all()
    current = await db.get(Recording, user.id)
    items = [
        InterviewSummary(
            id=i.id,
            job_role=i.job_role,
            duration_minutes=i.duration_minutes,
            evaluation_rigor=i.evaluation_rigor,
            status=i.status,
            overall_score=score,
            report_status=rstatus,
            evidence_sufficiency=rsufficiency,
            failure_stage=i.failure_stage,
            failure_code=i.failure_code,
            has_current_recording=bool(current and current.interview_id == i.id),
            created_at=i.created_at,
            completed_at=i.completed_at,
        )
        for i, score, rstatus, rsufficiency in rows
    ]
    return InterviewPage(
        items=items,
        total=total,
        limit=limit,
        offset=offset,
        current_recording_interview_id=current.interview_id if current else None,
    )


async def _detail(
    db, user_id: uuid.UUID, interview_id: uuid.UUID, *, include_transcript: bool
) -> InterviewDetail:
    interview = await get_owned_interview(db, user_id, interview_id)
    questions = list(
        (
            await db.execute(
                select(Question)
                .where(Question.interview_id == interview.id)
                .order_by(Question.sequence_number)
            )
        ).scalars()
    )
    plan = (
        await db.execute(
            select(InterviewPlan.plan_json)
            .where(InterviewPlan.interview_id == interview.id)
            .order_by(InterviewPlan.version.desc())
            .limit(1)
        )
    ).scalar_one_or_none()
    attempts: dict[str, list[dict]] = {}
    if questions:
        for a in (
            await db.execute(
                select(AnswerAttempt)
                .where(AnswerAttempt.question_id.in_([q.id for q in questions]))
                .order_by(AnswerAttempt.attempt_number)
            )
        ).scalars():
            attempts.setdefault(str(a.question_id), []).append(
                {
                    "attempt_number": a.attempt_number,
                    "answer_source": a.answer_source,
                    "transcript_text": a.transcript_text,
                    "selected_for_evaluation": a.selected_for_evaluation,
                    "is_skipped": a.is_skipped,
                    "completed_at": a.completed_at.isoformat() if a.completed_at else None,
                }
            )
    transcript = await interview_service.build_transcript(db, interview.id) if include_transcript else []
    base = InterviewOut.model_validate(interview).model_dump()
    return InterviewDetail(
        **base,
        questions=[QuestionOut.model_validate(q) for q in questions],
        objectives=(plan or {}).get("objectives", []),
        attempts=attempts,
        transcript=transcript,
        server_time=interview_service.now_utc(),
    )


@router.get("/{interview_id}", response_model=InterviewDetail)
async def get_interview(interview_id: uuid.UUID, user: CurrentUser, db: DB) -> InterviewDetail:
    return await _detail(db, user.id, interview_id, include_transcript=True)


@router.post("/{interview_id}/live-token", response_model=LiveTokenOut)
async def live_token(
    interview_id: uuid.UUID, user: CurrentUser, db: DB, settings: SettingsDep, providers: Providers
) -> LiveTokenOut:
    interview = await get_owned_interview(db, user.id, interview_id, for_update=True)
    creds, interview = await live_ai_service.issue_live_credentials(
        db, interview=interview, provider=providers.live, settings=settings
    )
    return LiveTokenOut(
        provider=creds.provider,
        token=creds.token,
        model=creds.model,
        api_version=creds.api_version,
        expires_at=creds.expires_at,
        new_session_expires_at=creds.new_session_expires_at,
        connect_config=creds.connect_config,
        deadline_at=interview.deadline_at,
        server_time=interview_service.now_utc(),
    )


@router.post("/{interview_id}/events", response_model=EventBatchOut)
async def post_events(
    interview_id: uuid.UUID, body: EventBatch, user: CurrentUser, db: DB, settings: SettingsDep
) -> EventBatchOut:
    interview, results = await interview_service.record_events(
        db, user_id=user.id, interview_id=interview_id, events=body.events, settings=settings
    )
    return EventBatchOut(
        results=[EventResult(client_event_id=c, sequence_number=s, duplicate=d) for c, s, d in results],
        status=interview.status,
        progress=await interview_service.progress(db, interview.id),
        remaining_seconds=interview_service.remaining_seconds(interview),
    )


@router.post("/{interview_id}/complete", response_model=InterviewOut)
async def complete(
    interview_id: uuid.UUID, user: CurrentUser, db: DB, body: CompleteIn | None = None
) -> InterviewOut:
    interview = await get_owned_interview(db, user.id, interview_id, for_update=True)
    interview = await interview_service.complete_interview(
        db, interview=interview, reason=(body or CompleteIn()).reason
    )
    await db.commit()
    return InterviewOut.model_validate(interview)


@router.post("/{interview_id}/cancel", response_model=InterviewOut)
async def cancel(interview_id: uuid.UUID, user: CurrentUser, db: DB) -> InterviewOut:
    interview = await get_owned_interview(db, user.id, interview_id, for_update=True)
    interview = await interview_service.cancel_interview(db, interview)
    await db.commit()
    return InterviewOut.model_validate(interview)


@router.post("/{interview_id}/retry-evaluation", response_model=InterviewOut)
async def retry_evaluation(interview_id: uuid.UUID, user: CurrentUser, db: DB) -> InterviewOut:
    interview = await get_owned_interview(db, user.id, interview_id, for_update=True)
    interview = await interview_service.retry_evaluation(db, interview)
    await db.commit()
    return InterviewOut.model_validate(interview)


@router.get("/{interview_id}/status", response_model=StatusOut)
async def status(interview_id: uuid.UUID, user: CurrentUser, db: DB) -> StatusOut:
    interview = await get_owned_interview(db, user.id, interview_id)
    report_status = (
        await db.execute(select(Report.report_status).where(Report.interview_id == interview.id))
    ).scalar_one_or_none()
    attempts = (
        await db.execute(select(EvaluationJob.attempts).where(EvaluationJob.interview_id == interview.id))
    ).scalar_one_or_none()
    return StatusOut(
        id=interview.id,
        status=interview.status,
        failure_stage=interview.failure_stage,
        failure_code=interview.failure_code,
        report_status=report_status,
        evaluation_attempts=attempts or 0,
        started_at=interview.started_at,
        deadline_at=interview.deadline_at,
        server_time=interview_service.now_utc(),
        remaining_seconds=interview_service.remaining_seconds(interview),
        progress=await interview_service.progress(db, interview.id),
    )


@router.get("/{interview_id}/report", response_model=ReportOut)
async def get_report(interview_id: uuid.UUID, user: CurrentUser, db: DB) -> ReportOut:
    interview = await get_owned_interview(db, user.id, interview_id)
    report = (
        await db.execute(select(Report).where(Report.interview_id == interview.id))
    ).scalar_one_or_none()
    if report is None:
        raise NotFound("No report exists for this interview yet.", code="REPORT_NOT_FOUND")
    feedback = (
        await db.execute(
            select(Feedback).where(Feedback.interview_id == interview.id, Feedback.user_id == user.id)
        )
    ).scalar_one_or_none()
    return ReportOut(
        interview_id=interview.id,
        report_status=report.report_status,
        overall_score=report.overall_score,
        evidence_sufficiency=report.evidence_sufficiency,
        competency_scores=report.competency_scores,
        question_evaluations=report.question_evaluations,
        strengths=report.strengths,
        improvement_areas=report.improvement_areas,
        recommendations=report.recommendations,
        summary=report.summary,
        unevaluated_questions=report.unevaluated_questions,
        job_role=interview.job_role,
        evaluation_rigor=interview.evaluation_rigor,
        duration_minutes=interview.duration_minutes,
        created_at=report.created_at,
        feedback={"rating": feedback.rating, "comments": feedback.comments} if feedback else None,
    )


@router.post("/{interview_id}/feedback", response_model=FeedbackOut)
async def submit_feedback(
    interview_id: uuid.UUID, body: FeedbackIn, user: CurrentUser, db: DB
) -> FeedbackOut:
    interview = await get_owned_interview(db, user.id, interview_id)
    comments = (body.comments or "").strip() or None
    await db.execute(
        insert(Feedback)
        .values(user_id=user.id, interview_id=interview.id, rating=body.rating, comments=comments)
        .on_conflict_do_update(
            constraint="uq_feedback_user_interview",
            set_={"rating": body.rating, "comments": comments, "updated_at": func.now()},
        )
    )
    await db.commit()
    row = (
        await db.execute(
            select(Feedback).where(Feedback.interview_id == interview.id, Feedback.user_id == user.id)
        )
    ).scalar_one()
    return FeedbackOut.model_validate(row)


@router.delete("/{interview_id}", status_code=204)
async def delete_interview(
    interview_id: uuid.UUID,
    user: CurrentUser,
    db: DB,
    settings: SettingsDep,
) -> Response:
    interview = await get_owned_interview(db, user.id, interview_id, for_update=True)
    if interview.status in interview_service.LIVE_STATES:
        raise Conflict(
            "Cannot delete an interview while it is in progress.",
            code="INTERVIEW_IN_PROGRESS",
        )

    # 1. Recording pointer
    current_rec = (
        await db.execute(select(Recording).where(Recording.interview_id == interview.id))
    ).scalar_one_or_none()
    if current_rec:
        if current_rec.storage_path:
            db.add(
                StorageCleanupTask(
                    bucket=settings.recordings_bucket,
                    storage_path=current_rec.storage_path,
                    reason="interview_deleted",
                )
            )
        await db.delete(current_rec)

    # 2. Recording uploads
    uploads = list(
        (
            await db.execute(
                select(RecordingUpload).where(RecordingUpload.interview_id == interview.id)
            )
        ).scalars()
    )
    for upload in uploads:
        if upload.storage_path:
            db.add(
                StorageCleanupTask(
                    bucket=settings.recordings_bucket,
                    storage_path=upload.storage_path,
                    reason="interview_deleted",
                )
            )
        await db.delete(upload)

    # 3. Documents
    doc_ids = [d for d in (interview.resume_document_id, interview.job_description_document_id) if d is not None]
    for doc_id in doc_ids:
        doc = await db.get(Document, doc_id)
        if doc:
            other_cnt = (
                await db.execute(
                    select(func.count())
                    .select_from(Interview)
                    .where(
                        Interview.id != interview.id,
                        (Interview.resume_document_id == doc_id) | (Interview.job_description_document_id == doc_id),
                    )
                )
            ).scalar_one()
            if other_cnt == 0:
                if doc.storage_path:
                    db.add(
                        StorageCleanupTask(
                            bucket=settings.documents_bucket,
                            storage_path=doc.storage_path,
                            reason="interview_deleted",
                        )
                    )
                await db.delete(doc)

    # 4. Explicitly delete child rows in transaction
    await db.execute(delete(EvaluationJob).where(EvaluationJob.interview_id == interview.id))
    await db.execute(delete(Feedback).where(Feedback.interview_id == interview.id))

    await db.execute(delete(Report).where(Report.interview_id == interview.id))

    await db.execute(delete(InterviewEvent).where(InterviewEvent.interview_id == interview.id))

    questions = list((await db.execute(select(Question).where(Question.interview_id == interview.id))).scalars())
    for q in questions:
        await db.execute(delete(AnswerAttempt).where(AnswerAttempt.question_id == q.id))
        await db.delete(q)

    await db.execute(delete(InterviewPlan).where(InterviewPlan.interview_id == interview.id))

    await db.delete(interview)
    await db.commit()
    return Response(status_code=204)

