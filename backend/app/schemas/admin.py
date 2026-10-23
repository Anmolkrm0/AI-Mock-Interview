"""Admin API schemas."""

from __future__ import annotations

import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict


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
