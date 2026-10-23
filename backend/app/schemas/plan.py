"""Interview plan schemas."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field, field_validator, model_validator

QuestionCategory = Literal[
    "experience",
    "technical",
    "behavioral",
    "situational",
    "role_knowledge",
    "system_design",
    "problem_solving",
]
Rigor = Literal["standard", "target_bar", "stress_test"]
Duration = Literal[10, 20, 30, 45]


class PlanQuestion(BaseModel):
    question: str = Field(min_length=10, max_length=220)
    category: QuestionCategory
    competency: str = Field(min_length=2, max_length=120)
    difficulty: int = Field(ge=1, le=5)
    priority: Literal["core", "optional"] = "core"
    expected_evidence: list[str] = Field(min_length=1, max_length=6)
    follow_up_topics: list[str] = Field(default_factory=list, max_length=5)
    time_allocation_seconds: int = Field(ge=45, le=900)

    @field_validator("question")
    @classmethod
    def _validate_single_question(cls, v: str) -> str:
        if v.count("?") > 1:
            raise ValueError("question must contain at most one '?'")
        return v


class CompetencyWeight(BaseModel):
    competency: str = Field(min_length=2, max_length=120)
    weight: float = Field(gt=0, le=1)
    description: str = Field(default="", max_length=300)


class InterviewPlanDraft(BaseModel):
    """What the LLM must return."""

    objectives: list[str] = Field(min_length=1, max_length=6)
    competencies: list[CompetencyWeight] = Field(min_length=1, max_length=8)
    questions: list[PlanQuestion] = Field(min_length=2, max_length=24)

    @field_validator("questions")
    @classmethod
    def _unique_questions(cls, questions: list[PlanQuestion]) -> list[PlanQuestion]:
        seen: set[str] = set()
        unique: list[PlanQuestion] = []
        for q in questions:
            key = " ".join(q.question.lower().split())
            if key not in seen:
                seen.add(key)
                unique.append(q)
        if len(unique) < 2:
            raise ValueError("plan must contain at least two distinct questions")
        return unique

    @model_validator(mode="after")
    def _competencies_cover_questions(self) -> InterviewPlanDraft:
        names = {c.competency.lower() for c in self.competencies}
        missing = {q.competency for q in self.questions if q.competency.lower() not in names}
        for name in sorted(missing):
            self.competencies.append(CompetencyWeight(competency=name, weight=0.1))
        total = sum(c.weight for c in self.competencies)
        for c in self.competencies:
            c.weight = round(c.weight / total, 4)
        return self


class PlanRequest(BaseModel):
    interview_id: str
