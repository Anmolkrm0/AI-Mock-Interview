"""Role detection from the parsed job description.

The suggestions come from the job-description extraction (no extra AI call).
This service decides whether one role is clear enough to preselect.
"""

from __future__ import annotations

from pydantic import BaseModel

from app.schemas.documents import JobExtraction

CLEAR_CONFIDENCE = 0.75
CLEAR_MARGIN = 0.2


class RoleOption(BaseModel):
    title: str
    confidence: float
    reason: str = ""


class RoleDetection(BaseModel):
    roles: list[RoleOption]
    default_role: str | None
    needs_user_choice: bool


def detect_roles(job: JobExtraction) -> RoleDetection:
    options: dict[str, RoleOption] = {}
    for s in job.role_suggestions:
        key = s.title.strip().lower()
        if key and (key not in options or options[key].confidence < s.confidence):
            options[key] = RoleOption(title=s.title.strip(), confidence=s.confidence, reason=s.reason)
    if job.job_title:
        key = job.job_title.strip().lower()
        if key not in options:
            options[key] = RoleOption(
                title=job.job_title.strip(), confidence=0.7, reason="Title stated in the job description"
            )
    roles = sorted(options.values(), key=lambda r: r.confidence, reverse=True)[:5]
    if not roles:
        return RoleDetection(roles=[], default_role=None, needs_user_choice=True)
    top = roles[0]
    runner_up = roles[1].confidence if len(roles) > 1 else 0.0
    clear = top.confidence >= CLEAR_CONFIDENCE and (top.confidence - runner_up) >= CLEAR_MARGIN
    return RoleDetection(roles=roles, default_role=top.title if clear else None, needs_user_choice=not clear)
