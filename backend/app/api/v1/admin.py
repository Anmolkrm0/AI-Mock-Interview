"""Admin endpoints."""

from __future__ import annotations

import uuid
from typing import Annotated, Any

from fastapi import APIRouter, Query
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import DB, AdminUser
from app.core.errors import NotFound
from app.schemas.admin import (
    AdminInterviewItem,
    AdminInterviewListOut,
    AdminMeOut,
    AdminOverviewOut,
    AdminUserDetailOut,
    AdminUserInterviewItem,
    AdminUserListOut,
    AdminUserSummary,
    AIHealthRow,
    DailySeriesPoint,
    ErrorCodeRow,
    FeedbackItemOut,
    FeedbackListOut,
    FeedbackSummaryOut,
    OverviewAveragesOut,
    OverviewBreakdownsOut,
    OverviewFeedbackOut,
    OverviewHealthOut,
    OverviewInterviewsOut,
    OverviewLiveNowOut,
    OverviewUsersOut,
    RoleCount,
)

router = APIRouter(prefix="/admin", tags=["admin"])


async def _has_auth_users(db: AsyncSession) -> bool:
    res = await db.execute(
        text("SELECT 1 FROM information_schema.tables WHERE table_schema = 'auth' AND table_name = 'users'")
    )
    return res.scalar() is not None


@router.get("/me", response_model=AdminMeOut)
async def admin_me(admin: AdminUser) -> AdminMeOut:
    return AdminMeOut(admin=True)


@router.get("/overview", response_model=AdminOverviewOut)
async def get_overview(
    admin: AdminUser,
    db: DB,
    days: Annotated[int, Query(ge=1, le=365)] = 30,
) -> AdminOverviewOut:
    params: dict[str, Any] = {"days": days}

    # 1. Users stats
    user_stats_sql = """
        SELECT
            count(*) AS total,
            count(*) FILTER (WHERE created_at >= now() - (:days * interval '1 day')) AS new_in_range
        FROM profiles
    """
    u_res = (await db.execute(text(user_stats_sql), params)).mappings().one()

    # Active users (created interview or emitted event in window)
    active_24h_sql = """
        SELECT count(DISTINCT user_id) AS active_cnt FROM (
            SELECT user_id FROM interviews WHERE created_at >= now() - interval '24 hours'
            UNION
            SELECT i.user_id FROM interview_events e
            JOIN interviews i ON i.id = e.interview_id
            WHERE e.created_at >= now() - interval '24 hours'
        ) t
    """
    active_24h = int((await db.execute(text(active_24h_sql))).scalar_one() or 0)

    active_7d_sql = """
        SELECT count(DISTINCT user_id) AS active_cnt FROM (
            SELECT user_id FROM interviews WHERE created_at >= now() - interval '7 days'
            UNION
            SELECT i.user_id FROM interview_events e
            JOIN interviews i ON i.id = e.interview_id
            WHERE e.created_at >= now() - interval '7 days'
        ) t
    """
    active_7d = int((await db.execute(text(active_7d_sql))).scalar_one() or 0)

    active_30d_sql = """
        SELECT count(DISTINCT user_id) AS active_cnt FROM (
            SELECT user_id FROM interviews WHERE created_at >= now() - interval '30 days'
            UNION
            SELECT i.user_id FROM interview_events e
            JOIN interviews i ON i.id = e.interview_id
            WHERE e.created_at >= now() - interval '30 days'
        ) t
    """
    active_30d = int((await db.execute(text(active_30d_sql))).scalar_one() or 0)

    users_out = OverviewUsersOut(
        total=int(u_res["total"]),
        new_in_range=int(u_res["new_in_range"]),
        active_24h=active_24h,
        active_7d=active_7d,
        active_30d=active_30d,
    )

    # 2. Interviews stats
    int_sql = """
        SELECT
            count(*) AS created,
            count(*) FILTER (WHERE started_at IS NOT NULL) AS started,
            count(*) FILTER (WHERE status = 'completed') AS completed,
            count(*) FILTER (WHERE status = 'cancelled') AS cancelled,
            count(*) FILTER (WHERE status = 'failed') AS failed,
            coalesce(round(avg(duration_minutes)::numeric, 1), 0.0) AS avg_duration
        FROM interviews
        WHERE created_at >= now() - (:days * interval '1 day')
    """
    i_res = (await db.execute(text(int_sql), params)).mappings().one()
    created_cnt = int(i_res["created"])
    started_cnt = int(i_res["started"])
    completed_cnt = int(i_res["completed"])
    cancelled_cnt = int(i_res["cancelled"])
    failed_cnt = int(i_res["failed"])
    completion_rate = round((completed_cnt / started_cnt) * 100, 1) if started_cnt > 0 else 0.0

    interviews_out = OverviewInterviewsOut(
        created=created_cnt,
        started=started_cnt,
        completed=completed_cnt,
        cancelled=cancelled_cnt,
        failed=failed_cnt,
        completion_rate=completion_rate,
    )

    # 3. Averages
    score_sql = """
        SELECT coalesce(round(avg(r.overall_score)::numeric, 1), 0.0) AS avg_score
        FROM reports r
        JOIN interviews i ON i.id = r.interview_id
        WHERE i.created_at >= now() - (:days * interval '1 day')
          AND r.overall_score IS NOT NULL
    """
    avg_score = float((await db.execute(text(score_sql), params)).scalar_one() or 0.0)

    q_per_completed_sql = """
        SELECT coalesce(round(avg(answered_cnt)::numeric, 1), 0.0) AS avg_answered
        FROM (
            SELECT i.id, count(latest_a.question_id) AS answered_cnt
            FROM interviews i
            LEFT JOIN questions q ON q.interview_id = i.id
            LEFT JOIN (
                SELECT a.question_id, a.is_skipped,
                       row_number() OVER (PARTITION BY a.question_id ORDER BY a.attempt_number DESC) AS rn
                FROM answer_attempts a
            ) latest_a ON latest_a.question_id = q.id AND latest_a.rn = 1 AND latest_a.is_skipped = false
            WHERE i.status = 'completed' AND i.created_at >= now() - (:days * interval '1 day')
            GROUP BY i.id
        ) t
    """
    avg_answered = float((await db.execute(text(q_per_completed_sql), params)).scalar_one() or 0.0)

    averages_out = OverviewAveragesOut(
        overall_score=avg_score,
        duration_minutes=float(i_res["avg_duration"]),
        questions_answered_per_completed=avg_answered,
    )

    # 4. Feedback
    fb_sql = """
        SELECT
            count(*) AS count,
            coalesce(round(avg(rating)::numeric, 1), 0.0) AS average_rating,
            count(*) FILTER (WHERE rating = 1) AS c1,
            count(*) FILTER (WHERE rating = 2) AS c2,
            count(*) FILTER (WHERE rating = 3) AS c3,
            count(*) FILTER (WHERE rating = 4) AS c4,
            count(*) FILTER (WHERE rating = 5) AS c5
        FROM feedback
        WHERE created_at >= now() - (:days * interval '1 day')
    """
    fb_res = (await db.execute(text(fb_sql), params)).mappings().one()
    feedback_out = OverviewFeedbackOut(
        count=int(fb_res["count"]),
        average_rating=float(fb_res["average_rating"]),
        rating_counts={
            1: int(fb_res["c1"]),
            2: int(fb_res["c2"]),
            3: int(fb_res["c3"]),
            4: int(fb_res["c4"]),
            5: int(fb_res["c5"]),
        },
    )

    # 5. Breakdowns
    rigor_sql = """
        SELECT evaluation_rigor, count(*) AS count
        FROM interviews
        WHERE created_at >= now() - (:days * interval '1 day')
        GROUP BY evaluation_rigor
    """
    rigor_rows = (await db.execute(text(rigor_sql), params)).all()
    by_rigor = {r[0]: int(r[1]) for r in rigor_rows}

    duration_sql = """
        SELECT duration_minutes, count(*) AS count
        FROM interviews
        WHERE created_at >= now() - (:days * interval '1 day')
        GROUP BY duration_minutes
    """
    duration_rows = (await db.execute(text(duration_sql), params)).all()
    by_duration = {str(d[0]): int(d[1]) for d in duration_rows}

    roles_sql = """
        SELECT job_role AS role, count(*) AS count
        FROM interviews
        WHERE created_at >= now() - (:days * interval '1 day')
        GROUP BY job_role
        ORDER BY count DESC
        LIMIT 10
    """
    roles_rows = (await db.execute(text(roles_sql), params)).mappings().all()
    top_roles = [RoleCount(role=row["role"], count=int(row["count"])) for row in roles_rows]

    breakdowns_out = OverviewBreakdownsOut(
        by_rigor=by_rigor,
        by_duration=by_duration,
        top_roles=top_roles,
    )

    # 6. Daily series (IST dates)
    daily_sql = """
        WITH date_series AS (
            SELECT generate_series(
                (now() AT TIME ZONE 'Asia/Kolkata')::date - (:days - 1) * interval '1 day',
                (now() AT TIME ZONE 'Asia/Kolkata')::date,
                interval '1 day'
            )::date AS day
        ),
        daily_users AS (
            SELECT (created_at AT TIME ZONE 'Asia/Kolkata')::date AS day, count(*) AS count
            FROM profiles
            WHERE created_at >= (now() AT TIME ZONE 'Asia/Kolkata')::date - (:days - 1) * interval '1 day'
            GROUP BY 1
        ),
        daily_started AS (
            SELECT (started_at AT TIME ZONE 'Asia/Kolkata')::date AS day, count(*) AS count
            FROM interviews
            WHERE started_at IS NOT NULL
              AND started_at >= (now() AT TIME ZONE 'Asia/Kolkata')::date - (:days - 1) * interval '1 day'
            GROUP BY 1
        ),
        daily_completed AS (
            SELECT (completed_at AT TIME ZONE 'Asia/Kolkata')::date AS day, count(*) AS count
            FROM interviews
            WHERE status = 'completed'
              AND completed_at IS NOT NULL
              AND completed_at >= (now() AT TIME ZONE 'Asia/Kolkata')::date - (:days - 1) * interval '1 day'
            GROUP BY 1
        ),
        daily_feedback AS (
            SELECT (created_at AT TIME ZONE 'Asia/Kolkata')::date AS day, count(*) AS count
            FROM feedback
            WHERE created_at >= (now() AT TIME ZONE 'Asia/Kolkata')::date - (:days - 1) * interval '1 day'
            GROUP BY 1
        )
        SELECT
            to_char(ds.day, 'YYYY-MM-DD') AS date,
            coalesce(du.count, 0) AS new_users,
            coalesce(dsta.count, 0) AS interviews_started,
            coalesce(dc.count, 0) AS interviews_completed,
            coalesce(df.count, 0) AS feedback_count
        FROM date_series ds
        LEFT JOIN daily_users du ON du.day = ds.day
        LEFT JOIN daily_started dsta ON dsta.day = ds.day
        LEFT JOIN daily_completed dc ON dc.day = ds.day
        LEFT JOIN daily_feedback df ON df.day = ds.day
        ORDER BY ds.day ASC
    """
    daily_rows = (await db.execute(text(daily_sql), params)).mappings().all()
    daily_series = [
        DailySeriesPoint(
            date=row["date"],
            new_users=int(row["new_users"]),
            interviews_started=int(row["interviews_started"]),
            interviews_completed=int(row["interviews_completed"]),
            feedback_count=int(row["feedback_count"]),
        )
        for row in daily_rows
    ]

    # 7. Health
    ai_sql = """
        SELECT
            operation,
            model,
            count(*) AS calls,
            count(*) FILTER (WHERE not success) AS failures,
            coalesce(round(avg(latency_ms)), 0) AS avg_latency_ms
        FROM ai_usage
        WHERE created_at >= now() - (:days * interval '1 day')
        GROUP BY operation, model
        ORDER BY calls DESC
    """
    ai_rows = (await db.execute(text(ai_sql), params)).mappings().all()
    ai_usage = [
        AIHealthRow(
            operation=row["operation"],
            model=row["model"],
            calls=int(row["calls"]),
            failures=int(row["failures"]),
            avg_latency_ms=int(row["avg_latency_ms"]),
        )
        for row in ai_rows
    ]

    errors_sql = """
        SELECT error_code, count(*) AS count
        FROM ai_usage
        WHERE created_at >= now() - (:days * interval '1 day')
          AND error_code IS NOT NULL AND error_code != ''
        GROUP BY error_code
        ORDER BY count DESC
        LIMIT 10
    """
    err_rows = (await db.execute(text(errors_sql), params)).mappings().all()
    top_error_codes = [
        ErrorCodeRow(error_code=row["error_code"], count=int(row["count"])) for row in err_rows
    ]

    events_health_sql = """
        SELECT
            count(*) FILTER (WHERE event_type = 'connection_lost') AS connection_lost,
            count(*) FILTER (
                WHERE event_type = 'metric'
                  AND coalesce(event_payload->>'metric', event_payload->>'metric_name') = 'live_connection_failed'
            ) AS live_connection_failed,
            count(*) FILTER (
                WHERE event_type = 'metric'
                  AND coalesce(event_payload->>'metric', event_payload->>'metric_name') = 'recording_upload_failed'
            ) AS recording_upload_failed,
            percentile_cont(0.5) WITHIN GROUP (
                ORDER BY coalesce((event_payload->>'value')::float, (event_payload->>'metric_value')::float)
            ) FILTER (
                WHERE event_type = 'metric'
                  AND coalesce(event_payload->>'metric', event_payload->>'metric_name') = 'time_to_first_response_ms'
            ) AS median_first_response_ms
        FROM interview_events
        WHERE created_at >= now() - (:days * interval '1 day')
    """
    ev_res = (await db.execute(text(events_health_sql), params)).mappings().one()
    median_ttfr = ev_res["median_first_response_ms"]
    if median_ttfr is not None:
        median_ttfr = round(float(median_ttfr), 1)

    health_out = OverviewHealthOut(
        ai_usage=ai_usage,
        top_error_codes=top_error_codes,
        connection_lost=int(ev_res["connection_lost"]),
        live_connection_failed=int(ev_res["live_connection_failed"]),
        recording_upload_failed=int(ev_res["recording_upload_failed"]),
        median_time_to_first_response_ms=median_ttfr,
    )

    # 8. Live now
    live_sql = """
        SELECT count(*)
        FROM interviews
        WHERE status IN ('connecting', 'in_progress', 'paused')
          AND last_activity_at >= now() - interval '5 minutes'
    """
    live_cnt = int((await db.execute(text(live_sql))).scalar_one() or 0)
    live_now_out = OverviewLiveNowOut(count=live_cnt)

    return AdminOverviewOut(
        users=users_out,
        interviews=interviews_out,
        averages=averages_out,
        feedback=feedback_out,
        breakdowns=breakdowns_out,
        daily_series=daily_series,
        health=health_out,
        live_now=live_now_out,
    )


@router.get("/users", response_model=AdminUserListOut)
async def list_users(
    admin: AdminUser,
    db: DB,
    limit: Annotated[int, Query(ge=1, le=100)] = 50,
    offset: Annotated[int, Query(ge=0)] = 0,
    search: Annotated[str | None, Query()] = None,
) -> AdminUserListOut:
    has_auth = await _has_auth_users(db)
    auth_join = "LEFT JOIN auth.users u ON u.id = p.id" if has_auth else ""
    user_email_select = "u.email AS email" if has_auth else "CAST(NULL AS text) AS email"
    signed_up_at_select = (
        "coalesce(u.created_at, p.created_at) AS signed_up_at" if has_auth else "p.created_at AS signed_up_at"
    )
    last_sign_in_select = (
        "u.last_sign_in_at AS last_sign_in_at" if has_auth else "CAST(NULL AS timestamptz) AS last_sign_in_at"
    )
    group_by_auth = ", u.email, u.created_at, u.last_sign_in_at" if has_auth else ""

    where_clauses: list[str] = []
    params: dict[str, Any] = {"limit": limit, "offset": offset}

    if search and search.strip():
        cleaned = search.strip().replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
        pattern = f"%{cleaned}%"
        params["search"] = pattern
        if has_auth:
            where_clauses.append("(u.email ILIKE :search OR p.display_name ILIKE :search)")
        else:
            where_clauses.append("(p.display_name ILIKE :search OR CAST(p.id AS text) ILIKE :search)")

    where_sql = ("WHERE " + " AND ".join(where_clauses)) if where_clauses else ""

    count_sql = f"""
        SELECT count(DISTINCT p.id)
        FROM profiles p
        {auth_join}
        {where_sql}
    """
    total = int((await db.execute(text(count_sql), params)).scalar_one() or 0)

    users_sql = f"""
        SELECT
            p.id AS user_id,
            p.display_name,
            {user_email_select},
            {signed_up_at_select},
            {last_sign_in_select},
            count(DISTINCT i.id) AS interviews_total,
            count(DISTINCT i.id) FILTER (WHERE i.status = 'completed') AS interviews_completed,
            max(i.created_at) AS last_interview_at,
            round(avg(r.overall_score)::numeric, 1) AS average_score,
            count(DISTINCT f.id) AS feedback_count
        FROM profiles p
        {auth_join}
        LEFT JOIN interviews i ON i.user_id = p.id
        LEFT JOIN reports r ON r.interview_id = i.id
        LEFT JOIN feedback f ON f.user_id = p.id
        {where_sql}
        GROUP BY p.id, p.display_name, p.created_at {group_by_auth}
        ORDER BY coalesce(max(i.created_at), p.created_at) DESC
        LIMIT :limit OFFSET :offset
    """
    rows = (await db.execute(text(users_sql), params)).mappings().all()

    items = [
        AdminUserSummary(
            user_id=row["user_id"],
            email=row["email"],
            display_name=row["display_name"],
            signed_up_at=row["signed_up_at"],
            last_sign_in_at=row["last_sign_in_at"],
            interviews_total=int(row["interviews_total"]),
            interviews_completed=int(row["interviews_completed"]),
            last_interview_at=row["last_interview_at"],
            average_score=float(row["average_score"]) if row["average_score"] is not None else None,
            feedback_count=int(row["feedback_count"]),
        )
        for row in rows
    ]
    return AdminUserListOut(items=items, total=total)


@router.get("/users/{user_id}", response_model=AdminUserDetailOut)
async def get_user_detail(
    user_id: uuid.UUID,
    admin: AdminUser,
    db: DB,
) -> AdminUserDetailOut:
    has_auth = await _has_auth_users(db)
    auth_join = "LEFT JOIN auth.users u ON u.id = p.id" if has_auth else ""
    user_email_select = "u.email AS email" if has_auth else "CAST(NULL AS text) AS email"
    signed_up_at_select = (
        "coalesce(u.created_at, p.created_at) AS signed_up_at" if has_auth else "p.created_at AS signed_up_at"
    )
    last_sign_in_select = (
        "u.last_sign_in_at AS last_sign_in_at" if has_auth else "CAST(NULL AS timestamptz) AS last_sign_in_at"
    )
    group_by_auth = ", u.email, u.created_at, u.last_sign_in_at" if has_auth else ""

    params = {"user_id": user_id}

    user_sql = f"""
        SELECT
            p.id AS user_id,
            p.display_name,
            {user_email_select},
            {signed_up_at_select},
            {last_sign_in_select},
            count(DISTINCT i.id) AS interviews_total,
            count(DISTINCT i.id) FILTER (WHERE i.status = 'completed') AS interviews_completed,
            round(avg(r.overall_score)::numeric, 1) AS average_score,
            count(DISTINCT f.id) AS feedback_count
        FROM profiles p
        {auth_join}
        LEFT JOIN interviews i ON i.user_id = p.id
        LEFT JOIN reports r ON r.interview_id = i.id
        LEFT JOIN feedback f ON f.user_id = p.id
        WHERE p.id = :user_id
        GROUP BY p.id, p.display_name, p.created_at {group_by_auth}
    """
    row = (await db.execute(text(user_sql), params)).mappings().first()
    if not row:
        raise NotFound("User not found.")

    interviews_sql = """
        SELECT
            i.id,
            i.created_at,
            i.job_role,
            i.duration_minutes,
            i.evaluation_rigor,
            i.status,
            i.failure_stage,
            i.failure_code,
            r.overall_score,
            f.rating AS feedback_rating,
            f.comments AS feedback_comments
        FROM interviews i
        LEFT JOIN reports r ON r.interview_id = i.id
        LEFT JOIN feedback f ON f.interview_id = i.id AND f.user_id = i.user_id
        WHERE i.user_id = :user_id
        ORDER BY i.created_at DESC
    """
    int_rows = (await db.execute(text(interviews_sql), params)).mappings().all()

    interview_items = [
        AdminUserInterviewItem(
            id=i_row["id"],
            created_at=i_row["created_at"],
            job_role=i_row["job_role"],
            duration_minutes=int(i_row["duration_minutes"]),
            evaluation_rigor=i_row["evaluation_rigor"],
            status=i_row["status"],
            failure_stage=i_row["failure_stage"],
            failure_code=i_row["failure_code"],
            overall_score=float(i_row["overall_score"]) if i_row["overall_score"] is not None else None,
            feedback_rating=int(i_row["feedback_rating"]) if i_row["feedback_rating"] is not None else None,
            feedback_comments=i_row["feedback_comments"],
        )
        for i_row in int_rows
    ]

    return AdminUserDetailOut(
        user_id=row["user_id"],
        email=row["email"],
        display_name=row["display_name"],
        signed_up_at=row["signed_up_at"],
        last_sign_in_at=row["last_sign_in_at"],
        interviews_total=int(row["interviews_total"]),
        interviews_completed=int(row["interviews_completed"]),
        average_score=float(row["average_score"]) if row["average_score"] is not None else None,
        feedback_count=int(row["feedback_count"]),
        interviews=interview_items,
    )


@router.get("/interviews", response_model=AdminInterviewListOut)
async def list_interviews(
    admin: AdminUser,
    db: DB,
    limit: Annotated[int, Query(ge=1, le=100)] = 50,
    offset: Annotated[int, Query(ge=0)] = 0,
    status: Annotated[str | None, Query()] = None,
    days: Annotated[int | None, Query(ge=1, le=365)] = None,
) -> AdminInterviewListOut:
    where_clauses: list[str] = []
    params: dict[str, Any] = {"limit": limit, "offset": offset}

    if status and status.strip():
        where_clauses.append("i.status = :status")
        params["status"] = status.strip()

    if days:
        where_clauses.append("i.created_at >= now() - (:days * interval '1 day')")
        params["days"] = days

    where_sql = ("WHERE " + " AND ".join(where_clauses)) if where_clauses else ""

    count_sql = f"""
        SELECT count(*)
        FROM interviews i
        {where_sql}
    """
    total = int((await db.execute(text(count_sql), params)).scalar_one() or 0)

    has_auth = await _has_auth_users(db)
    auth_join = "LEFT JOIN auth.users u ON u.id = i.user_id" if has_auth else ""
    user_email_select = "u.email AS user_email" if has_auth else "CAST(NULL AS text) AS user_email"

    items_sql = f"""
        SELECT
            i.id,
            i.created_at,
            i.user_id,
            {user_email_select},
            i.job_role,
            i.duration_minutes,
            i.evaluation_rigor,
            i.recording_mode,
            i.status,
            i.failure_stage,
            i.failure_code,
            coalesce(q_counts.total, 0) AS questions_total,
            coalesce(q_counts.answered, 0) AS questions_answered,
            coalesce(q_counts.skipped, 0) AS questions_skipped,
            r.overall_score,
            f.rating AS feedback_rating
        FROM interviews i
        {auth_join}
        LEFT JOIN (
            SELECT
                q.interview_id,
                count(DISTINCT q.id) AS total,
                count(DISTINCT q.id) FILTER (WHERE latest_a.is_skipped = false) AS answered,
                count(DISTINCT q.id) FILTER (WHERE latest_a.is_skipped = true OR q.status = 'skipped') AS skipped
            FROM questions q
            LEFT JOIN (
                SELECT a.question_id, a.is_skipped,
                       row_number() OVER (PARTITION BY a.question_id ORDER BY a.attempt_number DESC) AS rn
                FROM answer_attempts a
            ) latest_a ON latest_a.question_id = q.id AND latest_a.rn = 1
            GROUP BY q.interview_id
        ) q_counts ON q_counts.interview_id = i.id
        LEFT JOIN reports r ON r.interview_id = i.id
        LEFT JOIN feedback f ON f.interview_id = i.id
        {where_sql}
        ORDER BY i.created_at DESC
        LIMIT :limit OFFSET :offset
    """
    rows = (await db.execute(text(items_sql), params)).mappings().all()

    items = [
        AdminInterviewItem(
            id=row["id"],
            created_at=row["created_at"],
            user_id=row["user_id"],
            user_email=row["user_email"],
            job_role=row["job_role"],
            duration_minutes=int(row["duration_minutes"]),
            evaluation_rigor=row["evaluation_rigor"],
            recording_mode=row["recording_mode"],
            status=row["status"],
            failure_stage=row["failure_stage"],
            failure_code=row["failure_code"],
            questions_total=int(row["questions_total"]),
            questions_answered=int(row["questions_answered"]),
            questions_skipped=int(row["questions_skipped"]),
            overall_score=float(row["overall_score"]) if row["overall_score"] is not None else None,
            feedback_rating=int(row["feedback_rating"]) if row["feedback_rating"] is not None else None,
        )
        for row in rows
    ]
    return AdminInterviewListOut(items=items, total=total)


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
