"""Explicit test doubles. MOCKED: these never call real AI or storage services."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any

from pydantic import BaseModel

from app.core.errors import StorageError
from app.providers.base import (
    EvaluationProvider,
    JSONResult,
    LiveCredentials,
    LiveInterviewProvider,
    LiveSessionSetup,
    TextGenerationProvider,
    UsageInfo,
)
from app.schemas.documents import JobExtraction, ResumeExtraction
from app.schemas.plan import InterviewPlanDraft
from app.schemas.report import EvaluationDraft
from app.storage.supabase_storage import ObjectInfo, SignedUpload

RESUME_DATA = {
    "candidate_name": "Test Candidate",
    "headline": "Backend engineer",
    "total_experience_years": 4,
    "skills": ["Python", "PostgreSQL", "APIs"],
    "tools_and_technologies": ["FastAPI", "Docker"],
    "projects": [{"name": "Payments API", "description": "Built a payments API", "technologies": ["Python"]}],
    "responsibilities": ["Designed REST services"],
    "achievements": ["Cut latency by 40%"],
    "education": [{"qualification": "B.Tech", "institution": "Test University", "year": "2019"}],
}
JOB_DATA = {
    "job_title": "Senior Backend Engineer",
    "seniority": "senior",
    "required_skills": ["Python", "SQL", "Distributed systems"],
    "preferred_skills": ["Kubernetes"],
    "responsibilities": ["Own backend services"],
    "required_experience": "4+ years",
    "competencies": ["System design", "Coding"],
    "interview_topics": ["API design"],
    "role_suggestions": [{"title": "Senior Backend Engineer", "confidence": 0.92, "reason": "Title"}],
}


def _usage(name: str) -> UsageInfo:
    return UsageInfo(provider=name, model="fake-model", latency_ms=5, input_tokens=10, output_tokens=20)


class FakeText(TextGenerationProvider):
    name = "fake"
    model = "fake-model"

    def __init__(self) -> None:
        self.calls: list[str] = []
        self.queue: list[Any] = []  # optional scripted responses / exceptions
        self.configured = True

    def is_configured(self) -> bool:
        return self.configured

    async def generate_json(
        self,
        *,
        system: str,
        prompt: str,
        schema: type[BaseModel],
        temperature: float = 0.4,
        max_output_tokens: int = 8192,
    ) -> JSONResult:
        self.calls.append(schema.__name__)
        if self.queue:
            item = self.queue.pop(0)
            if isinstance(item, Exception):
                raise item
            return JSONResult(data=item, usage=_usage(self.name))
        if schema is ResumeExtraction:
            return JSONResult(data=dict(RESUME_DATA), usage=_usage(self.name))
        if schema is JobExtraction:
            return JSONResult(data=dict(JOB_DATA), usage=_usage(self.name))
        if schema is InterviewPlanDraft:
            core = int(re.search(r"exactly (\d+) questions", prompt).group(1))
            optional = int(re.search(r"followed by (\d+) with", prompt).group(1))
            questions = []
            for i in range(core + optional):
                questions.append(
                    {
                        "question": f"Planned question number {i + 1} about backend systems?",
                        "category": "technical" if i % 2 else "experience",
                        "competency": "System design" if i % 2 else "Coding",
                        "difficulty": 3,
                        "priority": "core" if i < core else "optional",
                        "expected_evidence": ["specific example"],
                        "follow_up_topics": ["scale"],
                        "time_allocation_seconds": 120,
                    }
                )
            return JSONResult(
                data={
                    "objectives": ["Assess backend depth"],
                    "competencies": [
                        {"competency": "System design", "weight": 0.6},
                        {"competency": "Coding", "weight": 0.4},
                    ],
                    "questions": questions,
                },
                usage=_usage(self.name),
            )
        raise AssertionError(f"unexpected schema {schema}")


class FakeEvaluation(EvaluationProvider):
    name = "fake"
    model = "fake-eval"

    def __init__(self) -> None:
        self.calls = 0
        self.queue: list[Any] = []
        self.score = 4

    def is_configured(self) -> bool:
        return True

    async def evaluate(self, *, system: str, prompt: str, schema: type[BaseModel]) -> JSONResult:
        self.calls += 1
        if self.queue:
            item = self.queue.pop(0)
            if isinstance(item, Exception):
                raise item
            return JSONResult(data=item, usage=_usage(self.name))
        assert schema is EvaluationDraft
        items, _ = json.JSONDecoder().raw_decode(prompt[prompt.index("[{") :])
        judgements = []
        for item in items:
            answer = item["candidate_answer"]
            judgements.append(
                {
                    "question_id": item["question_id"],
                    "score": self.score,
                    "rationale": "Clear, specific answer with relevant detail.",
                    "evidence": [
                        {"quote": answer[:30], "supports": "Specific experience"},
                        {"quote": "a sentence that was never said", "supports": "Invented"},
                    ],
                    "gaps": [],
                    "stronger_answer": "Add metrics.",
                    "confidence": "high",
                }
            )
        return JSONResult(
            data={
                "judgements": judgements,
                "strengths": ["Specific examples"],
                "weaknesses": ["Few metrics"],
                "recommendations": ["Quantify impact"],
                "summary": "Solid interview with specific examples.",
            },
            usage=_usage(self.name),
        )


class FakeLive(LiveInterviewProvider):
    name = "fake_live"
    model = "fake-live"

    def __init__(self) -> None:
        self.setups: list[LiveSessionSetup] = []

    def is_configured(self) -> bool:
        return True

    async def create_credentials(self, setup: LiveSessionSetup) -> LiveCredentials:
        self.setups.append(setup)
        now = datetime.now(UTC)
        return LiveCredentials(
            provider=self.name,
            token=f"auth_tokens/fake-{len(self.setups)}",
            model=self.model,
            api_version="v1alpha",
            expires_at=now + timedelta(minutes=30),
            new_session_expires_at=now + timedelta(minutes=2),
            connect_config={"responseModalities": ["AUDIO"]},
        )


@dataclass
class FakeRegistry:
    text: FakeText = field(default_factory=FakeText)
    evaluation: FakeEvaluation = field(default_factory=FakeEvaluation)
    live: FakeLive = field(default_factory=FakeLive)

    def status(self) -> dict:
        return {}


class FakeStorage:
    """In-memory object store with failure injection."""

    def __init__(self) -> None:
        self.objects: dict[tuple[str, str], tuple[bytes, str]] = {}
        self.fail_upload = False
        self.fail_delete = False
        self.deleted: list[str] = []

    async def create_signed_upload(self, bucket: str, path: str) -> SignedUpload:
        return SignedUpload(path=path, token="upload-token", signed_url=f"https://storage/{bucket}/{path}")

    async def create_signed_url(self, bucket: str, path: str, expires_in: int) -> str:
        if (bucket, path) not in self.objects:
            raise StorageError("missing", code="STORAGE_REJECTED")
        return f"https://storage/sign/{bucket}/{path}?token=t&exp={expires_in}"

    async def get_object_info(self, bucket: str, path: str) -> ObjectInfo | None:
        if (bucket, path) not in self.objects:
            return None
        data, mime = self.objects[(bucket, path)]
        return ObjectInfo(path=path, size=len(data), mime_type=mime)

    async def upload(self, bucket: str, path: str, data: bytes, content_type: str) -> None:
        if self.fail_upload:
            raise StorageError("upload failed", code="STORAGE_REJECTED")
        self.objects[(bucket, path)] = (data, content_type)

    async def delete(self, bucket: str, paths: list[str]) -> None:
        if self.fail_delete:
            raise StorageError("delete failed")
        for p in paths:
            self.objects.pop((bucket, p), None)
            self.deleted.append(p)

    # simulate the browser uploading to the signed URL
    def browser_upload(self, bucket: str, path: str, size: int, mime: str) -> None:
        self.objects[(bucket, path)] = (b"x" * size, mime)
