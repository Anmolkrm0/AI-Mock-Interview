"""Admin API schemas."""

from __future__ import annotations

import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict


class AdminMeOut(BaseModel):
    admin: bool = True


class OverviewUsersOut(BaseModel):
    total: int
    new_in_range: int
    active_24h: int
    active_7d: int
    active_30d: int


class OverviewInterviewsOut(BaseModel):
    created: int
    started: int
    completed: int
    cancelled: int
    failed: int
    completion_rate: float


class OverviewAveragesOut(BaseModel):
    overall_score: float
    duration_minutes: float
    questions_answered_per_completed: float


class OverviewFeedbackOut(BaseModel):
    count: int
    average_rating: float
    rating_counts: dict[int, int]


class RoleCount(BaseModel):
    role: str
    count: int


class OverviewBreakdownsOut(BaseModel):
    by_rigor: dict[str, int]
    by_duration: dict[str, int]
    top_roles: list[RoleCount]


class DailySeriesPoint(BaseModel):
    date: str
    new_users: int
    interviews_started: int
    interviews_completed: int
    feedback_count: int


class AIHealthRow(BaseModel):
    operation: str
    model: str
    calls: int
    failures: int
    avg_latency_ms: int


class ErrorCodeRow(BaseModel):
    error_code: str
    count: int


class OverviewHealthOut(BaseModel):
    ai_usage: list[AIHealthRow]
    top_error_codes: list[ErrorCodeRow]
    connection_lost: int
    live_connection_failed: int
    recording_upload_failed: int
    median_time_to_first_response_ms: float | None = None


class OverviewLiveNowOut(BaseModel):
    count: int


class AdminOverviewOut(BaseModel):
    users: OverviewUsersOut
    interviews: OverviewInterviewsOut
    averages: OverviewAveragesOut
    feedback: OverviewFeedbackOut
    breakdowns: OverviewBreakdownsOut
    daily_series: list[DailySeriesPoint]
    health: OverviewHealthOut
    live_now: OverviewLiveNowOut


class AdminUserSummary(BaseModel):
    user_id: uuid.UUID
    email: str | None = None
    display_name: str | None = None
    signed_up_at: datetime | None = None
    last_sign_in_at: datetime | None = None
    interviews_total: int
    interviews_completed: int
    last_interview_at: datetime | None = None
    average_score: float | None = None
    feedback_count: int


class AdminUserListOut(BaseModel):
    items: list[AdminUserSummary]
    total: int


class AdminUserInterviewItem(BaseModel):
    id: uuid.UUID
    created_at: datetime
    job_role: str
    duration_minutes: int
    evaluation_rigor: str
    status: str
    failure_stage: str | None = None
    failure_code: str | None = None
    overall_score: float | None = None
    feedback_rating: int | None = None
    feedback_comments: str | None = None


class AdminUserDetailOut(BaseModel):
    user_id: uuid.UUID
    email: str | None = None
    display_name: str | None = None
    signed_up_at: datetime | None = None
    last_sign_in_at: datetime | None = None
    interviews_total: int
    interviews_completed: int
    average_score: float | None = None
    feedback_count: int
    interviews: list[AdminUserInterviewItem]


class AdminInterviewItem(BaseModel):
    id: uuid.UUID
    created_at: datetime
    user_id: uuid.UUID
    user_email: str | None = None
    job_role: str
    duration_minutes: int
    evaluation_rigor: str
    recording_mode: str
    status: str
    failure_stage: str | None = None
    failure_code: str | None = None
    questions_total: int
    questions_answered: int
    questions_skipped: int
    overall_score: float | None = None
    feedback_rating: int | None = None


class AdminInterviewListOut(BaseModel):
    items: list[AdminInterviewItem]
    total: int


class FeedbackItemOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    submitted_at: datetime
    user_email: str | None = None
    rating: int
    comments: str | None = None
    interview_id: uuid.UUID
    job_role: str
    duration_minutes: int
    evaluation_rigor: str
    overall_score: float | None = None


class FeedbackListOut(BaseModel):
    items: list[FeedbackItemOut]
    total: int


class FeedbackSummaryOut(BaseModel):
    total_responses: int
    average_rating: float
    rating_counts: dict[int, int]
    last_7_days: int
    with_comments: int
