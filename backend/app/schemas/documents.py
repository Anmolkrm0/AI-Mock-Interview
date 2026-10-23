"""Document schemas, including the structured LLM extraction contracts."""

from __future__ import annotations

import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator

Str200 = str


def _clean_list(values: list[str], limit: int) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for v in values:
        item = " ".join(str(v).split())[:300]
        key = item.lower()
        if item and key not in seen:
            seen.add(key)
            out.append(item)
    return out[:limit]


class ProjectItem(BaseModel):
    name: str = Field(max_length=200)
    description: str = Field(default="", max_length=1000)
    technologies: list[str] = Field(default_factory=list)


class EducationItem(BaseModel):
    qualification: str = Field(max_length=300)
    institution: str = Field(default="", max_length=300)
    year: str = Field(default="", max_length=40)


class ResumeExtraction(BaseModel):
    """Candidate profile. Only facts stated in the resume; unknowns stay empty."""

    candidate_name: str | None = Field(default=None, max_length=200)
    headline: str | None = Field(default=None, max_length=300)
    total_experience_years: float | None = Field(
        default=None,
        ge=0,
        le=60,
        description="Only if explicitly stated or directly computable from listed dates; else null.",
    )
    skills: list[str] = Field(default_factory=list)
    tools_and_technologies: list[str] = Field(default_factory=list)
    projects: list[ProjectItem] = Field(default_factory=list)
    responsibilities: list[str] = Field(default_factory=list)
    achievements: list[str] = Field(default_factory=list)
    education: list[EducationItem] = Field(default_factory=list)

    @field_validator("skills", "tools_and_technologies", "responsibilities", "achievements")
    @classmethod
    def _dedupe(cls, v: list[str]) -> list[str]:
        return _clean_list(v, 60)


class RoleSuggestion(BaseModel):
    title: str = Field(min_length=2, max_length=200)
    confidence: float = Field(ge=0, le=1)
    reason: str = Field(default="", max_length=300)


class JobExtraction(BaseModel):
    job_title: str | None = Field(default=None, max_length=200)
    seniority: Literal["intern", "entry", "mid", "senior", "lead", "principal", "executive", "unknown"] = (
        "unknown"
    )
    required_skills: list[str] = Field(default_factory=list)
    preferred_skills: list[str] = Field(default_factory=list)
    responsibilities: list[str] = Field(default_factory=list)
    required_experience: str | None = Field(default=None, max_length=300)
    competencies: list[str] = Field(default_factory=list)
    interview_topics: list[str] = Field(default_factory=list)
    role_suggestions: list[RoleSuggestion] = Field(default_factory=list, max_length=6)

    @field_validator(
        "required_skills", "preferred_skills", "responsibilities", "competencies", "interview_topics"
    )
    @classmethod
    def _dedupe(cls, v: list[str]) -> list[str]:
        return _clean_list(v, 40)


class DocumentOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    document_type: Literal["resume", "job_description"]
    file_name: str | None
    parsing_status: str
    parsing_error: str | None
    extracted_data: dict | None
    character_count: int = 0
    created_at: datetime


class DocumentCorrection(BaseModel):
    """Manual correction of extracted data by the user."""

    extracted_data: dict


class JobDescriptionText(BaseModel):
    text: str = Field(min_length=1, max_length=30_000)
