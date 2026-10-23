"""Admin endpoints."""

from __future__ import annotations

from typing import Annotated, Any

from fastapi import APIRouter, Query
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import DB, AdminUser
from app.schemas.admin import FeedbackItemOut, FeedbackListOut, FeedbackSummaryOut

router = APIRouter(prefix="/admin", tags=["admin"])


async def _has_auth_users(db: AsyncSession) -> bool:
    res = await db.execute(
        text("SELECT 1 FROM information_schema.tables WHERE table_schema = 'auth' AND table_name = 'users'")
    )
    return res.scalar() is not None


@router.get("/feedback", response_model=FeedbackListOut)
async def list_feedback(
    admin: AdminUser,
    db: DB,
    limit: Annotated[int, Query(ge=1, le=100)] = 50,
    offset: Annotated[int, Query(ge=0)] = 0,
    rating: Annotated[int | None, Query(ge=1, le=5)] = None,
    has_comments: Annotated[bool | None, Query()] = None,
) -> FeedbackListOut:
    where_clauses: list[str] = []
    params: dict[str, Any] = {"limit": limit, "offset": offset}

    if rating is not None:
        where_clauses.append("f.rating = :rating")
        params["rating"] = rating

    if has_comments is True:
        where_clauses.append("(f.comments IS NOT NULL AND length(trim(f.comments)) > 0)")
    elif has_comments is False:
        where_clauses.append("(f.comments IS NULL OR length(trim(f.comments)) = 0)")

    where_sql = ("WHERE " + " AND ".join(where_clauses)) if where_clauses else ""

    count_sql = f"""
        SELECT count(*) AS total
        FROM feedback f
        {where_sql}
    """
    total_res = await db.execute(text(count_sql), params)
    total = int(total_res.scalar_one())

    has_auth = await _has_auth_users(db)
    auth_join = "LEFT JOIN auth.users u ON u.id = f.user_id" if has_auth else ""
    user_email_select = "u.email AS user_email" if has_auth else "CAST(NULL AS text) AS user_email"

    items_sql = f"""
        SELECT
            f.created_at AS submitted_at,
            {user_email_select},
            f.rating AS rating,
            f.comments AS comments,
            f.interview_id AS interview_id,
            i.job_role AS job_role,
            i.duration_minutes AS duration_minutes,
            i.evaluation_rigor AS evaluation_rigor,
            r.overall_score AS overall_score
        FROM feedback f
        JOIN interviews i ON i.id = f.interview_id
        LEFT JOIN reports r ON r.interview_id = f.interview_id
        {auth_join}
        {where_sql}
        ORDER BY f.created_at DESC
        LIMIT :limit OFFSET :offset
    """
    items_res = await db.execute(text(items_sql), params)
    rows = items_res.mappings().all()

    items = [
        FeedbackItemOut(
            submitted_at=row["submitted_at"],
            user_email=row["user_email"],
            rating=row["rating"],
            comments=row["comments"],
            interview_id=row["interview_id"],
            job_role=row["job_role"],
            duration_minutes=row["duration_minutes"],
            evaluation_rigor=row["evaluation_rigor"],
            overall_score=row["overall_score"],
        )
        for row in rows
    ]
    return FeedbackListOut(items=items, total=total)


@router.get("/feedback/summary", response_model=FeedbackSummaryOut)
async def feedback_summary(
    admin: AdminUser,
    db: DB,
) -> FeedbackSummaryOut:
    summary_sql = """
        SELECT
            count(*) AS total_responses,
            coalesce(avg(rating), 0.0) AS average_rating,
            count(*) FILTER (WHERE created_at >= now() - interval '7 days') AS last_7_days,
            count(*) FILTER (WHERE comments IS NOT NULL AND length(trim(comments)) > 0) AS with_comments,
            count(*) FILTER (WHERE rating = 1) AS count_1,
            count(*) FILTER (WHERE rating = 2) AS count_2,
            count(*) FILTER (WHERE rating = 3) AS count_3,
            count(*) FILTER (WHERE rating = 4) AS count_4,
            count(*) FILTER (WHERE rating = 5) AS count_5
        FROM feedback
    """
    res = await db.execute(text(summary_sql))
    row = res.mappings().one()
    return FeedbackSummaryOut(
        total_responses=int(row["total_responses"]),
        average_rating=round(float(row["average_rating"]), 2),
        rating_counts={
            1: int(row["count_1"]),
            2: int(row["count_2"]),
            3: int(row["count_3"]),
            4: int(row["count_4"]),
            5: int(row["count_5"]),
        },
        last_7_days=int(row["last_7_days"]),
        with_comments=int(row["with_comments"]),
    )
