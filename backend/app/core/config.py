"""Application settings.

Settings are read from environment variables (and an optional ``.env`` file in
the backend directory for local development). No secret has a default value:
missing provider keys are reported as configuration errors at the point of use
instead of being replaced with mock behaviour.
"""

from __future__ import annotations

import os
from functools import lru_cache
from pathlib import Path

from pydantic import BaseModel, Field, field_validator

BACKEND_DIR = Path(__file__).resolve().parents[2]


def _load_dotenv(path: Path) -> None:
    """Minimal .env loader: KEY=VALUE lines, existing env vars win."""
    if not path.is_file():
        return
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        os.environ.setdefault(key, value)


class Settings(BaseModel):
    app_name: str = "AI Mock Interview API"
    app_version: str = "1.0.0"
    environment: str = "development"  # development | test | production

    # Database (Supabase Postgres). Use the Supavisor pooler URL on Render (IPv4).
    database_url: str = ""
    db_pool_size: int = 5
    db_max_overflow: int = 5

    # Supabase
    supabase_url: str = ""
    supabase_secret_key: str = ""  # server-only; sb_secret_... or legacy service_role
    supabase_jwt_secret: str = ""  # only for legacy HS256 projects / tests
    supabase_jwt_audience: str = "authenticated"
    recordings_bucket: str = "interview-recordings"
    documents_bucket: str = "interview-documents"

    # Admin access
    admin_emails: list[str] = Field(default_factory=list)

    # CORS
    cors_origins: list[str] = Field(default_factory=lambda: ["http://localhost:3000"])

    # AI providers
    text_ai_provider: str = "gemini"
    evaluation_ai_provider: str = "gemini"
    live_ai_provider: str = "gemini_live"
    gemini_api_key: str = ""
    gemini_api_base: str = "https://generativelanguage.googleapis.com"
    gemini_text_model: str = "gemini-3.5-flash-lite"
    gemini_evaluation_model: str = "gemini-3.5-flash-lite"
    gemini_live_model: str = "gemini-3.8-live"
    gemini_live_api_version: str = "v1alpha"
    gemini_live_voice: str = ""
    gemini_use_json_schema: bool = True
    groq_api_key: str = ""
    groq_api_base: str = "https://api.groq.com/openai/v1"
    groq_text_model: str = ""

    ai_request_timeout_seconds: float = 90.0
    ai_max_retries: int = 2

    # Limits
    max_upload_bytes: int = 5 * 1024 * 1024
    min_document_chars: int = 200
    max_document_chars: int = 60_000
    max_jd_text_chars: int = 30_000
    recording_max_bytes: int = 50 * 1024 * 1024  # Supabase Free per-file cap
    recording_signed_url_ttl_seconds: int = 300
    live_token_ttl_seconds: int = 30 * 60
    live_token_new_session_seconds: int = 120
    daily_interview_limit: int = 5
    max_active_interviews: int = 1
    document_retention_days: int = 30
    completion_grace_seconds: int = 120
    abandoned_after_seconds: int = 15 * 60

    # Rate limits (requests per minute, per user, per process)
    rate_limit_default_per_minute: int = 120
    rate_limit_ai_per_minute: int = 12
    rate_limit_live_token_per_minute: int = 6

    # Background worker
    run_worker: bool = True
    worker_poll_seconds: float = 5.0
    job_lease_seconds: int = 300
    job_max_attempts: int = 3

    @field_validator("admin_emails", mode="before")
    @classmethod
    def _split_admin_emails(cls, value: object) -> object:
        if isinstance(value, str):
            return [v.strip().lower() for v in value.split(",") if v.strip()]
        if isinstance(value, (list, tuple, set)):
            return [str(v).strip().lower() for v in value if str(v).strip()]
        return value

    @field_validator("cors_origins", mode="before")
    @classmethod
    def _split_origins(cls, value: object) -> object:
        if isinstance(value, str):
            return [v.strip().rstrip("/") for v in value.split(",") if v.strip()]
        return value

    @property
    def is_production(self) -> bool:
        return self.environment == "production"

    @property
    def sqlalchemy_url(self) -> str:
        url = self.database_url
        if url.startswith("postgres://"):
            url = "postgresql://" + url[len("postgres://") :]
        if url.startswith("postgresql://"):
            url = "postgresql+psycopg://" + url[len("postgresql://") :]
        return url

    @property
    def supabase_jwks_url(self) -> str:
        return f"{self.supabase_url.rstrip('/')}/auth/v1/.well-known/jwks.json"

    @property
    def supabase_issuer(self) -> str:
        return f"{self.supabase_url.rstrip('/')}/auth/v1"


_BOOL_TRUE = {"1", "true", "yes", "on"}


def _from_env() -> Settings:
    _load_dotenv(BACKEND_DIR / ".env")
    data: dict[str, object] = {}
    for name, field in Settings.model_fields.items():
        raw = os.environ.get(name.upper())
        if raw is None:
            continue
        if field.annotation is bool:
            data[name] = raw.strip().lower() in _BOOL_TRUE
        else:
            data[name] = raw
    return Settings(**data)


@lru_cache
def get_settings() -> Settings:
    return _from_env()
