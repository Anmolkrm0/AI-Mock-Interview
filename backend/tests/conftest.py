"""Test configuration.

* Integration tests run against a real, dedicated PostgreSQL test database
  (TEST_DATABASE_URL). The schema is created by running the Alembic migrations,
  so the migrations themselves are under test. Never point this at production.
* AI providers and Supabase Storage are replaced with in-process fakes
  (``tests/fakes.py``). These tests prove our logic, not the real Gemini
  integration; real-provider tests live in ``test_real_providers.py`` and only
  run with RUN_REAL_PROVIDER_TESTS=1.
* Access tokens are real HS256 JWTs verified by the production verifier.
"""

from __future__ import annotations

import getpass
import os
import socket
import time
import uuid
from collections.abc import AsyncIterator

import jwt
import pytest


def _default_test_db() -> str:
    user = getpass.getuser()
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.5)
        if s.connect_ex(("127.0.0.1", 5432)) == 0:
            return f"postgresql://{user}@127.0.0.1:5432/mock_interview_test"
    return "postgresql://postgres@127.0.0.1:54329/mock_interview_test"


TEST_DB = os.environ.get("TEST_DATABASE_URL") or _default_test_db()
JWT_SECRET = "test-jwt-secret-that-is-long-enough-for-hs256"
SUPABASE_URL = "https://example-project.supabase.co"

os.environ.update(
    {
        "ENVIRONMENT": "test",
        "DATABASE_URL": TEST_DB,
        "SUPABASE_URL": SUPABASE_URL,
        "SUPABASE_JWT_SECRET": JWT_SECRET,
        "SUPABASE_SECRET_KEY": "",
        "GEMINI_API_KEY": "",
        "RUN_WORKER": "false",
        "AI_MAX_RETRIES": "2",
        "CORS_ORIGINS": "http://localhost:3000",
    }
)

import httpx  # noqa: E402
from sqlalchemy import text  # noqa: E402

from app.core.config import get_settings  # noqa: E402


def make_token(user_id: uuid.UUID, *, expires_in: int = 3600, secret: str = JWT_SECRET, **overrides) -> str:
    now = int(time.time())
    claims = {
        "sub": str(user_id),
        "aud": "authenticated",
        "role": "authenticated",
        "iss": f"{SUPABASE_URL}/auth/v1",
        "email": f"{str(user_id)[:8]}@example.com",
        "iat": now,
        "exp": now + expires_in,
    }
    claims.update(overrides)
    return jwt.encode(claims, secret, algorithm="HS256")


def auth(user_id: uuid.UUID) -> dict[str, str]:
    return {"Authorization": f"Bearer {make_token(user_id)}"}


@pytest.fixture(scope="session")
def migrated_db() -> str:
    """Recreate the test database and apply migrations once per session."""
    import psycopg

    base, _, name = TEST_DB.rpartition("/")
    admin = psycopg.connect(f"{base}/postgres", autocommit=True)
    admin.execute(f'drop database if exists "{name}" with (force)')
    admin.execute(f'create database "{name}"')
    admin.close()

    from alembic import command
    from alembic.config import Config

    cfg = Config(os.path.join(os.path.dirname(__file__), "..", "alembic.ini"))
    cfg.set_main_option("script_location", os.path.join(os.path.dirname(__file__), "..", "alembic"))
    get_settings.cache_clear()

    def _upgrade() -> None:
        command.upgrade(cfg, "head")

    # alembic env.py uses asyncio.run, so this must run outside an event loop.
    _upgrade()
    return TEST_DB


TABLES = [
    "ai_usage",
    "storage_cleanup_tasks",
    "evaluation_jobs",
    "feedback",
    "recording_uploads",
    "recordings",
    "reports",
    "interview_events",
    "answer_attempts",
    "questions",
    "interview_plans",
    "interviews",
    "documents",
    "profiles",
]


@pytest.fixture
async def clean_db(migrated_db: str) -> AsyncIterator[None]:
    from app.db.session import get_sessionmaker
    from app.services.auth_service import forget_profile_cache

    async with get_sessionmaker()() as session:
        await session.execute(text("truncate " + ", ".join(TABLES) + " cascade"))
        await session.commit()
    forget_profile_cache()
    from app.core.rate_limit import rate_limiter

    rate_limiter.reset()
    yield


@pytest.fixture
def fakes():
    from tests.fakes import FakeRegistry, FakeStorage

    return FakeRegistry(), FakeStorage()


@pytest.fixture
async def client(clean_db, fakes) -> AsyncIterator[httpx.AsyncClient]:
    from app.main import app
    from app.providers.factory import get_provider_registry
    from app.storage.supabase_storage import get_storage_client

    registry, storage = fakes
    app.dependency_overrides[get_provider_registry] = lambda: registry
    app.dependency_overrides[get_storage_client] = lambda: storage
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
        yield c
    app.dependency_overrides.clear()
