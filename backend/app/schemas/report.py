"""Evaluation schemas.

The LLM only returns per-question judgements (rubric score, rationale and
quoted evidence) plus narrative feedback. All numbers that aggregate those
judgements are computed deterministically in code.
"""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, Field

RUBRIC = {
    1: "Insufficient evidence or incorrect",
    2: "Significant gaps",
    3: "Competent but incomplete",
    4: "Strong and well-supported",
    5: "Excellent, detailed and role-relevant",
}


class EvidenceQuote(BaseModel):
    quote: str = Field(
        min_length=3, max_length=400, description="Verbatim excerpt from the candidate's answer"
    )
    supports: str = Field(max_length=300, description="What this excerpt demonstrates")


class QuestionJudgement(BaseModel):
    question_id: str
    score: int = Field(ge=1, le=5)
    rationale: str = Field(min_length=10, max_length=1500)
    evidence: list[EvidenceQuote] = Field(default_factory=list, max_length=4)
    gaps: list[str] = Field(default_factory=list, max_length=5)
    stronger_answer: str | None = Field(default=None, max_length=1500)
    confidence: Literal["low", "medium", "high"]


class EvaluationDraft(BaseModel):
    judgements: list[QuestionJudgement]
    strengths: list[str] = Field(default_factory=list, max_length=6)
    weaknesses: list[str] = Field(default_factory=list, max_length=6)
    recommendations: list[str] = Field(default_factory=list, max_length=6)
    summary: str = Field(min_length=10, max_length=1500)


class ReportOut(BaseModel):
    interview_id: uuid.UUID
    report_status: str
    overall_score: float | None
    evidence_sufficiency: str | None
    competency_scores: list[dict[str, Any]]
    question_evaluations: list[dict[str, Any]]
    strengths: list[Any]
    improvement_areas: list[Any]
    recommendations: list[Any]
    summary: str | None
    unevaluated_questions: list[dict[str, Any]]
    rubric: dict[int, str] = RUBRIC
    job_role: str
    evaluation_rigor: str
    duration_minutes: int
    created_at: datetime
    feedback: dict[str, Any] | None = None
