"""Gemini text generation via the REST ``generateContent`` endpoint.

Request shape: ``POST {base}/v1beta/models/{model}:generateContent`` with the
``x-goog-api-key`` header, ``generationConfig.responseMimeType=application/json``
and (optionally) ``generationConfig.responseJsonSchema``. Output is always
re-validated with Pydantic by the calling service.
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
from app.providers.json_schema import inline_schema, parse_json_object, schema_prompt


class GeminiTextProvider(TextGenerationProvider):
    name = "gemini"

    def __init__(self, settings: Settings, model: str | None = None) -> None:
        self._settings = settings
        self.model = model or settings.gemini_text_model
        self._use_schema = settings.gemini_use_json_schema
        self._client = httpx.AsyncClient(timeout=settings.ai_request_timeout_seconds)

    def is_configured(self) -> bool:
        return bool(self._settings.gemini_api_key and self.model)

    def _body(
        self,
        system: str,
        prompt: str,
        schema: type[BaseModel],
        temperature: float,
        max_output_tokens: int,
        with_schema: bool,
    ) -> dict:
        generation: dict = {
            "responseMimeType": "application/json",
            "temperature": temperature,
            "maxOutputTokens": max_output_tokens,
        }
        text = prompt
        if with_schema:
            generation["responseJsonSchema"] = inline_schema(schema)
        else:
            text = f"{prompt}\n\nReturn only JSON matching this JSON Schema:\n{schema_prompt(schema)}"
        return {
            "systemInstruction": {"parts": [{"text": system}]},
            "contents": [{"role": "user", "parts": [{"text": text}]}],
            "generationConfig": generation,
        }

    async def generate_json(
        self,
        *,
        system: str,
        prompt: str,
        schema: type[BaseModel],
        temperature: float = 0.4,
        max_output_tokens: int = 8192,
    ) -> JSONResult:
        if not self._settings.gemini_api_key:
            raise not_configured("Gemini", "GEMINI_API_KEY")
        if not self.model:
            raise not_configured("Gemini", "GEMINI_TEXT_MODEL")
        url = f"{self._settings.gemini_api_base.rstrip('/')}/v1beta/models/{self.model}:generateContent"
        headers = {"x-goog-api-key": self._settings.gemini_api_key}
        started = time.monotonic()
        with_schema = self._use_schema
        for _ in range(2):
            body = self._body(system, prompt, schema, temperature, max_output_tokens, with_schema)
            try:
                response = await self._client.post(url, json=body, headers=headers)
            except httpx.TimeoutException as exc:
                raise timeout_error() from exc
            except httpx.HTTPError as exc:
                raise map_http_error(503, type(exc).__name__, "Gemini") from exc
            if response.status_code == 400 and with_schema and "schema" in response.text.lower():
                # Model rejected the schema form; fall back to prompt-embedded schema.
                with_schema = False
                continue
            break
        if response.status_code >= 400:
            raise map_http_error(response.status_code, _error_message(response), "Gemini")

        payload = response.json()
        latency = int((time.monotonic() - started) * 1000)
        usage_meta = payload.get("usageMetadata") or {}
        usage = UsageInfo(
            provider=self.name,
            model=self.model,
            latency_ms=latency,
            input_tokens=usage_meta.get("promptTokenCount"),
            output_tokens=usage_meta.get("candidatesTokenCount"),
        )
        candidates = payload.get("candidates") or []
        if not candidates:
            raise empty_response()
        parts = (candidates[0].get("content") or {}).get("parts") or []
        text = "".join(p.get("text", "") for p in parts if not p.get("thought"))
        if not text.strip():
            raise empty_response()
        try:
            data = parse_json_object(text)
        except json.JSONDecodeError as exc:
            raise malformed_response() from exc
        return JSONResult(data=data, usage=usage)


def _error_message(response: httpx.Response) -> str:
    try:
        error = response.json().get("error", {})
        return f"{error.get('status', '')} {error.get('message', '')}"
    except ValueError:
        return response.text[:200]
