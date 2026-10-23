"""Report generation jobs and report retrieval.

Jobs live in ``evaluation_jobs``. A worker claims one with
``FOR UPDATE SKIP LOCKED`` and a lease (``locked_until``); if the process dies
mid-run (e.g. a Render restart), the lease expires and the job is picked up
again. The report is marked completed only after it is persisted.
"""

from __future__ import annotations

import logging
import uuid
from dataclasses import dataclass
from datetime import timedelta

from sqlalchemy import or_, select, text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.core.config import Settings
from app.core.errors import AppError
from app.models import EvaluationJob, Interview, Report
from app.providers.base import EvaluationProvider
from app.services import evaluation_service
from app.services.interview_service import mark_failed, now_utc, transition

logger = logging.getLogger("app.reports")


@dataclass
class ClaimedJob:
    id: uuid.UUID
    interview_id: uuid.UUID
    attempts: int


async def claim_job(db: AsyncSession, settings: Settings) -> ClaimedJob | None:
    at = now_utc()
    job = (
        await db.execute(
            select(EvaluationJob)
            .where(
                or_(
                    (EvaluationJob.status == "queued") & (EvaluationJob.next_run_at <= at),
                    (EvaluationJob.status == "running") & (EvaluationJob.locked_until < at),
                )
            )
            .order_by(EvaluationJob.next_run_at)
            .limit(1)
            .with_for_update(skip_locked=True)
        )
    ).scalar_one_or_none()
    if job is None:
        await db.rollback()
        return None
    job.status = "running"
    job.attempts += 1
    job.locked_until = at + timedelta(seconds=settings.job_lease_seconds)
    claimed = ClaimedJob(id=job.id, interview_id=job.interview_id, attempts=job.attempts)
    await db.commit()
    return claimed


async def run_job(
    sessionmaker: async_sessionmaker[AsyncSession],
    job: ClaimedJob,
    provider: EvaluationProvider,
    settings: Settings,
) -> str:
    """Run one claimed job. Returns the final job status."""
    async with sessionmaker() as db:
        interview = await db.get(Interview, job.interview_id)
        if interview is None or interview.status != "evaluating":
            j = await db.get(EvaluationJob, job.id)
            if j:
                j.status = "succeeded" if interview and interview.status == "completed" else "failed"
                j.locked_until = None
            await db.commit()
            return j.status if j else "failed"
        data = await evaluation_service.gather_input(db, interview)
        await db.commit()  # no transaction held during the AI call

    error: AppError | None = None
    payload = None
    try:
        payload = await evaluation_service.evaluate(provider, data)
    except AppError as exc:
        error = exc
    except Exception:
        logger.exception("evaluation_unexpected_error interview=%s", job.interview_id)
        error = AppError("Evaluation failed unexpectedly.", code="EVALUATION_ERROR", retryable=True)

    async with sessionmaker() as db:
        j = (
            await db.execute(select(EvaluationJob).where(EvaluationJob.id == job.id).with_for_update())
        ).scalar_one()
        interview = (
            await db.execute(select(Interview).where(Interview.id == job.interview_id).with_for_update())
        ).scalar_one()
        report = (
            await db.execute(select(Report).where(Report.interview_id == job.interview_id).with_for_update())
        ).scalar_one_or_none()
        if report is None:
            report = Report(interview_id=job.interview_id, report_status="pending")
            db.add(report)

        if payload is not None:
            for key, value in payload.items():
                setattr(report, key, value)
            report.report_status = "completed"
            if interview.status == "evaluating":
                transition(interview, "completed")
            j.status, j.locked_until, j.last_error_code = "succeeded", None, None
            await db.commit()
            logger.info("evaluation_completed interview=%s", job.interview_id)
            return "succeeded"

        assert error is not None
        j.last_error_code = error.code
        j.locked_until = None
        if error.retryable and job.attempts < settings.job_max_attempts:
            j.status = "queued"
            j.next_run_at = now_utc() + timedelta(seconds=30 * (2 ** (job.attempts - 1)))
            await db.commit()
            logger.warning("evaluation_retry_scheduled interview=%s code=%s", job.interview_id, error.code)
            return "queued"
        j.status = "failed"
        report.report_status = "failed"
        if interview.status == "evaluating":
            mark_failed(interview, "evaluation", error.code)
        await db.commit()
        logger.warning("evaluation_failed interview=%s code=%s", job.interview_id, error.code)
        return "failed"


async def process_one(
    sessionmaker: async_sessionmaker[AsyncSession],
    provider: EvaluationProvider,
    settings: Settings,
) -> str | None:
    async with sessionmaker() as db:
        job = await claim_job(db, settings)
    if job is None:
        return None
    return await run_job(sessionmaker, job, provider, settings)


async def database_ready(db: AsyncSession) -> bool:
    await db.execute(text("select 1"))
    return True
