"""Optional Groq text provider (OpenAI-compatible chat completions API).

Only used when TEXT_AI_PROVIDER or EVALUATION_AI_PROVIDER is set to ``groq``.
It is never switched to automatically when Gemini quota runs out.
"""

from __future__ import annotations

import json
import time

import httpx
from pydantic import BaseModel

from app.core.config import Settings
from app.providers.base import (
    JSONResult,
    TextGenerationProvider,
    UsageInfo,
    empty_response,
    malformed_response,
    map_http_error,
    not_configured,
    timeout_error,
)
from app.providers.json_schema import parse_json_object, schema_prompt


class GroqTextProvider(TextGenerationProvider):
    name = "groq"

    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        self.model = settings.groq_text_model
        self._client = httpx.AsyncClient(timeout=settings.ai_request_timeout_seconds)

    def is_configured(self) -> bool:
        return bool(self._settings.groq_api_key and self.model)

    async def generate_json(
        self,
        *,
        system: str,
        prompt: str,
        schema: type[BaseModel],
        temperature: float = 0.4,
        max_output_tokens: int = 8192,
    ) -> JSONResult:
        if not self._settings.groq_api_key:
            raise not_configured("Groq", "GROQ_API_KEY")
        if not self.model:
            raise not_configured("Groq", "GROQ_TEXT_MODEL")
        body = {
            "model": self.model,
            "temperature": temperature,
            "max_tokens": max_output_tokens,
            "response_format": {"type": "json_object"},
            "messages": [
                {"role": "system", "content": system},
                {
                    "role": "user",
                    "content": f"{prompt}\n\nReturn only a JSON object matching this JSON Schema:\n"
                    f"{schema_prompt(schema)}",
                },
            ],
        }
        started = time.monotonic()
        try:
            response = await self._client.post(
                f"{self._settings.groq_api_base.rstrip('/')}/chat/completions",
                json=body,
                headers={"Authorization": f"Bearer {self._settings.groq_api_key}"},
            )
        except httpx.TimeoutException as exc:
            raise timeout_error() from exc
        except httpx.HTTPError as exc:
            raise map_http_error(503, type(exc).__name__, "Groq") from exc
        if response.status_code >= 400:
            try:
                message = str(response.json().get("error", {}).get("message", ""))
            except ValueError:
                message = response.text[:200]
            raise map_http_error(response.status_code, message, "Groq")
        payload = response.json()
        usage_meta = payload.get("usage") or {}
        usage = UsageInfo(
            provider=self.name,
            model=self.model,
            latency_ms=int((time.monotonic() - started) * 1000),
            input_tokens=usage_meta.get("prompt_tokens"),
            output_tokens=usage_meta.get("completion_tokens"),
        )
        choices = payload.get("choices") or []
        text = ((choices[0].get("message") or {}).get("content") if choices else "") or ""
        if not text.strip():
            raise empty_response()
        try:
            return JSONResult(data=parse_json_object(text), usage=usage)
        except json.JSONDecodeError as exc:
            raise malformed_response() from exc
