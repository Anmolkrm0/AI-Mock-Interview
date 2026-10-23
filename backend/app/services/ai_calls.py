"""Validated AI calls with bounded retries and usage tracking.

* Transient provider failures (timeouts, rate limits, 5xx, empty/malformed
  output) are retried with exponential backoff, a bounded number of times.
* Non-retryable failures (bad key, unknown model, exhausted quota) fail fast.
* Output that does not validate against the Pydantic schema is retried with a
  short corrective note; it is never accepted unvalidated.
* Every call records an ``ai_usage`` row in its own short transaction, so no
  database transaction is held open while waiting for the model.
"""

from __future__ import annotations

import asyncio
import logging
import random
import uuid
from collections.abc import Awaitable, Callable
from typing import TypeVar

from pydantic import BaseModel, ValidationError

from app.core.config import get_settings
from app.core.errors import ProviderError
from app.db.session import get_sessionmaker
from app.models import AIUsage
from app.providers.base import JSONResult, UsageInfo, malformed_response

logger = logging.getLogger("app.ai")
T = TypeVar("T", bound=BaseModel)

NON_RETRYABLE = {
    "AI_PROVIDER_AUTH_FAILED",
    "AI_MODEL_UNSUPPORTED",
    "AI_PROVIDER_QUOTA_EXHAUSTED",
    "AI_PROVIDER_NOT_CONFIGURED",
    "AI_PROVIDER_BAD_REQUEST",
}


async def record_usage(
    *,
    usage: UsageInfo | None,
    provider: str,
    model: str,
    operation: str,
    user_id: uuid.UUID | None,
    interview_id: uuid.UUID | None,
    success: bool,
    error_code: str | None,
    latency_ms: int = 0,
) -> None:
    try:
        async with get_sessionmaker()() as session:
            session.add(
                AIUsage(
                    user_id=user_id,
                    interview_id=interview_id,
                    operation=operation,
                    provider=usage.provider if usage else provider,
                    model=usage.model if usage else model,
                    input_tokens=usage.input_tokens if usage else None,
                    output_tokens=usage.output_tokens if usage else None,
                    latency_ms=usage.latency_ms if usage else latency_ms,
                    success=success,
                    error_code=error_code,
                )
            )
            await session.commit()
    except Exception:  # usage tracking must never break the main flow
        logger.warning("ai_usage_record_failed operation=%s", operation)


def _validation_note(exc: ValidationError) -> str:
    issues = []
    for err in exc.errors()[:6]:
        loc = ".".join(str(p) for p in err.get("loc", []))
        issues.append(f"{loc}: {err.get('msg')}")
    return "; ".join(issues)


async def call_validated(
    call: Callable[[str], Awaitable[JSONResult]],
    schema: type[T],
    *,
    prompt: str,
    operation: str,
    provider: str,
    model: str,
    user_id: uuid.UUID | None = None,
    interview_id: uuid.UUID | None = None,
    post_validate: Callable[[T], None] | None = None,
    sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
) -> T:
    settings = get_settings()
    attempts = settings.ai_max_retries + 1
    current_prompt = prompt
    last_error: ProviderError | None = None
    for attempt in range(attempts):
        usage: UsageInfo | None = None
        try:
            result = await call(current_prompt)
            usage = result.usage
            parsed = schema.model_validate(result.data)
            if post_validate:
                post_validate(parsed)
        except ProviderError as exc:
            await record_usage(
                usage=usage,
                provider=provider,
                model=model,
                operation=operation,
                user_id=user_id,
                interview_id=interview_id,
                success=False,
                error_code=exc.code,
            )
            last_error = exc
            if exc.code in NON_RETRYABLE or not exc.retryable:
                raise
        except (ValidationError, ValueError) as exc:
            await record_usage(
                usage=usage,
                provider=provider,
                model=model,
                operation=operation,
                user_id=user_id,
                interview_id=interview_id,
                success=False,
                error_code="AI_OUTPUT_INVALID",
            )
            note = _validation_note(exc) if isinstance(exc, ValidationError) else str(exc)[:300]
            logger.info("ai_output_invalid operation=%s attempt=%s", operation, attempt + 1)
            current_prompt = (
                f"{prompt}\n\nYour previous response did not match the required format "
                f"({note}). Return a corrected JSON object."
            )
            last_error = malformed_response()
        else:
            await record_usage(
                usage=usage,
                provider=provider,
                model=model,
                operation=operation,
                user_id=user_id,
                interview_id=interview_id,
                success=True,
                error_code=None,
            )
            return parsed
        if attempt < attempts - 1:
            await sleep(min(8.0, 0.75 * (2**attempt)) + random.uniform(0, 0.4))
    assert last_error is not None
    raise last_error
