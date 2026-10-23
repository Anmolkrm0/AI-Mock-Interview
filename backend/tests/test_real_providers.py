"""REAL provider tests. Opt-in: they spend real API quota.

Run with:  RUN_REAL_PROVIDER_TESTS=1 GEMINI_API_KEY=... pytest tests/test_real_providers.py -v

These are the only automated tests that talk to Gemini. Passing them shows the
configured key, models and request formats work; the browser voice session
itself still needs the manual check in docs/TESTING.md.
"""

from __future__ import annotations

import os

import pytest

from app.core.config import Settings
from app.providers.base import LiveSessionSetup
from app.providers.gemini_live import GeminiLiveProvider
from app.providers.gemini_text import GeminiTextProvider
from app.schemas.documents import JobExtraction
from app.services.live_ai_service import FUNCTIONS

pytestmark = [
    pytest.mark.real_provider,
    pytest.mark.skipif(
        os.environ.get("RUN_REAL_PROVIDER_TESTS") != "1" or not os.environ.get("REAL_GEMINI_API_KEY"),
        reason="Set RUN_REAL_PROVIDER_TESTS=1 and REAL_GEMINI_API_KEY to run real provider tests",
    ),
]


def _settings() -> Settings:
    return Settings(
        gemini_api_key=os.environ["REAL_GEMINI_API_KEY"],
        gemini_text_model=os.environ.get("GEMINI_TEXT_MODEL", "gemini-3.5-flash-lite"),
        gemini_live_model=os.environ.get("GEMINI_LIVE_MODEL", "gemini-3.8-live"),
        database_url="",
    )


async def test_real_gemini_structured_extraction() -> None:
    provider = GeminiTextProvider(_settings())
    result = await provider.generate_json(
        system="Extract job requirements. Use only the text.",
        prompt="We are hiring a Junior Data Analyst skilled in SQL and Excel to build weekly reports.",
        schema=JobExtraction,
    )
    parsed = JobExtraction.model_validate(result.data)
    assert parsed.job_title and any("sql" in s.lower() for s in parsed.required_skills)


async def test_real_gemini_live_ephemeral_token() -> None:
    provider = GeminiLiveProvider(_settings())
    creds = await provider.create_credentials(
        LiveSessionSetup(system_instruction="You are a test interviewer.", functions=FUNCTIONS)
    )
    assert creds.token.startswith("auth_tokens/")
