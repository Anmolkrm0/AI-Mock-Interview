from __future__ import annotations

import logging

import httpx
from fastapi import APIRouter, Response
from sqlalchemy import delete, select

from app.api.deps import DB, CurrentUser, SettingsDep
from app.core.errors import Conflict
from app.models import (
    AIUsage,
    AnswerAttempt,
    Document,
    EvaluationJob,
    Feedback,
    Interview,
    InterviewEvent,
    InterviewPlan,
    Profile,
    Question,
    Recording,
    RecordingUpload,
    Report,
    StorageCleanupTask,
)
from app.services import auth_service, interview_service

logger = logging.getLogger("app.users")

router = APIRouter(prefix="/users", tags=["users"])


@router.delete("/me", status_code=204)
async def delete_account(
    user: CurrentUser,
    db: DB,
    settings: SettingsDep,
) -> Response:
    # 1. Refuse if any interview is in progress
    active_live = (
        await db.execute(
            select(Interview.id).where(
                Interview.user_id == user.id,
                Interview.status.in_(interview_service.LIVE_STATES),
            )
        )
    ).first()
    if active_live:
        raise Conflict(
            "Cannot delete account while an interview is in progress.",
            code="INTERVIEW_IN_PROGRESS",
        )

    # 2. Queue storage cleanup for all user recordings
    current_rec = await db.get(Recording, user.id)
    if current_rec and current_rec.storage_path:
        db.add(
            StorageCleanupTask(
                bucket=settings.recordings_bucket,
                storage_path=current_rec.storage_path,
                reason="account_deleted",
            )
        )

    uploads = list(
        (
            await db.execute(
                select(RecordingUpload).where(RecordingUpload.user_id == user.id)
            )
        ).scalars()
    )
    for upload in uploads:
        if upload.storage_path:
            db.add(
                StorageCleanupTask(
                    bucket=settings.recordings_bucket,
                    storage_path=upload.storage_path,
                    reason="account_deleted",
                )
            )

    # 3. Queue storage cleanup for all user documents
    docs = list(
        (
            await db.execute(
                select(Document).where(Document.user_id == user.id)
            )
        ).scalars()
    )
    for doc in docs:
        if doc.storage_path:
            db.add(
                StorageCleanupTask(
                    bucket=settings.documents_bucket,
                    storage_path=doc.storage_path,
                    reason="account_deleted",
                )
            )

    # 4. Delete all user interviews and child rows
    interviews = list(
        (
            await db.execute(
                select(Interview).where(Interview.user_id == user.id)
            )
        ).scalars()
    )
    for inv in interviews:
        await db.execute(delete(EvaluationJob).where(EvaluationJob.interview_id == inv.id))
        await db.execute(delete(Feedback).where(Feedback.interview_id == inv.id))
        await db.execute(delete(Report).where(Report.interview_id == inv.id))
        await db.execute(delete(InterviewEvent).where(InterviewEvent.interview_id == inv.id))
        questions = list((await db.execute(select(Question).where(Question.interview_id == inv.id))).scalars())
        for q in questions:
            await db.execute(delete(AnswerAttempt).where(AnswerAttempt.question_id == q.id))
            await db.delete(q)
        await db.execute(delete(InterviewPlan).where(InterviewPlan.interview_id == inv.id))
        await db.delete(inv)

    # 5. Delete uploads, recordings, feedback, documents, ai_usage, profile
    await db.execute(delete(RecordingUpload).where(RecordingUpload.user_id == user.id))
    if current_rec:
        await db.delete(current_rec)
    await db.execute(delete(Feedback).where(Feedback.user_id == user.id))
    for doc in docs:
        await db.delete(doc)
    await db.execute(delete(AIUsage).where(AIUsage.user_id == user.id))
    profile = await db.get(Profile, user.id)
    if profile:
        await db.delete(profile)

    await db.commit()
    auth_service.forget_profile_cache()

    # 6. Delete user from Supabase Auth admin API if configured
    if settings.supabase_url and settings.supabase_secret_key:
        headers = {
            "apikey": settings.supabase_secret_key,
            "Authorization": f"Bearer {settings.supabase_secret_key}",
        }
        url = f"{settings.supabase_url.rstrip('/')}/auth/v1/admin/users/{user.id}"
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                resp = await client.delete(url, headers=headers)
                if resp.status_code not in (200, 204, 404):
                    logger.warning(
                        "supabase_delete_user_failed status=%s body=%s",
                        resp.status_code,
                        resp.text[:200],
                    )
        except Exception as exc:
            logger.warning("supabase_delete_user_error error=%s", exc)

    return Response(status_code=204)
