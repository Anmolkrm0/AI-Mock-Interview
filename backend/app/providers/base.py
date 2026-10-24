"""Provider interfaces.

Business logic depends only on these interfaces, so providers can be swapped
through configuration without touching interview code.
"""

from __future__ import annotations

import abc
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, TypeVar

from pydantic import BaseModel

from app.core.errors import ProviderError

T = TypeVar("T", bound=BaseModel)


@dataclass
class UsageInfo:
    provider: str
    model: str
    latency_ms: int
    input_tokens: int | None = None
    output_tokens: int | None = None


@dataclass
class JSONResult:
    data: dict[str, Any]
    usage: UsageInfo


class TextGenerationProvider(abc.ABC):
    """Generates a single JSON object for a prompt. Validation happens in services."""

    name: str
    model: str

    @abc.abstractmethod
    def is_configured(self) -> bool: ...

    @abc.abstractmethod
    async def generate_json(
        self,
        *,
        system: str,
        prompt: str,
        schema: type[BaseModel],
        temperature: float = 0.4,
        max_output_tokens: int = 8192,
    ) -> JSONResult: ...


class EvaluationProvider(abc.ABC):
    """Scores interview answers. Implemented on top of a text provider."""

    name: str
    model: str

    @abc.abstractmethod
    def is_configured(self) -> bool: ...

    @abc.abstractmethod
    async def evaluate(self, *, system: str, prompt: str, schema: type[BaseModel]) -> JSONResult: ...


@dataclass
class LiveFunction:
    name: str
    description: str
    parameters: dict[str, Any]


@dataclass
class LiveSessionSetup:
    system_instruction: str
    functions: list[LiveFunction] = field(default_factory=list)
    voice: str | None = None


@dataclass
class LiveCredentials:
    provider: str
    token: str
    model: str
    api_version: str
    expires_at: datetime
    new_session_expires_at: datetime
    connect_config: dict[str, Any]


class LiveInterviewProvider(abc.ABC):
    name: str
    model: str

    @abc.abstractmethod
    def is_configured(self) -> bool: ...

    @abc.abstractmethod
    async def create_credentials(self, setup: LiveSessionSetup) -> LiveCredentials: ...


def map_http_error(status: int, message: str, provider: str) -> ProviderError:
    """Map provider HTTP failures to stable application errors."""
    text = message.lower()
    if status in (401, 403) or "api key not valid" in text or "api_key_invalid" in text:
        return ProviderError(
            f"The {provider} API key is invalid or lacks access. Check the server configuration.",
            code="AI_PROVIDER_AUTH_FAILED",
            status_code=503,
            retryable=False,
        )
    if status == 404 or "is not found" in text or "not supported" in text:
        return ProviderError(
            f"The configured {provider} model is not available. Check the model name in the server configuration.",
            code="AI_MODEL_UNSUPPORTED",
            status_code=503,
            retryable=False,
        )
    if status == 429 or "resource_exhausted" in text or ("quota" in text and "exceeded" in text):
        daily = any(s in text for s in ("per day", "perday", "daily", "quota exceeded for quota metric"))
        if daily or "exhausted" in text and "rate" not in text:
            return ProviderError(
                "Our AI is busy right now. Please try again in a few minutes. Your past reports are still available.",
                code="AI_PROVIDER_QUOTA_EXHAUSTED",
                status_code=503,
                retryable=False,
            )
        return ProviderError(
            "Our AI is busy right now. Please try again in a few minutes. Your past reports are still available.",
            code="AI_PROVIDER_RATE_LIMITED",
            status_code=503,
            retryable=True,
        )
    if status == 400:
        return ProviderError(
            "The AI service rejected the request.",
            code="AI_PROVIDER_BAD_REQUEST",
            status_code=502,
            retryable=False,
        )
    return ProviderError(
        "The AI service is temporarily unavailable.",
        code="AI_PROVIDER_UNAVAILABLE",
        status_code=503,
        retryable=True,
    )


def not_configured(provider: str, variable: str) -> ProviderError:
    return ProviderError(
        f"{provider} is not configured. Set {variable} on the server (see backend/.env.example).",
        code="AI_PROVIDER_NOT_CONFIGURED",
        status_code=503,
        retryable=False,
    )


def timeout_error() -> ProviderError:
    return ProviderError(
        "The AI service took too long to respond.",
        code="AI_PROVIDER_TIMEOUT",
        status_code=504,
        retryable=True,
    )


def empty_response() -> ProviderError:
    return ProviderError(
        "The AI service returned an empty response.",
        code="AI_EMPTY_RESPONSE",
        status_code=502,
        retryable=True,
    )


def malformed_response() -> ProviderError:
    return ProviderError(
        "The AI service returned a response in an unexpected format.",
        code="AI_MALFORMED_RESPONSE",
        status_code=502,
        retryable=True,
    )
