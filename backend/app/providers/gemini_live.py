"""Gemini Live: short-lived browser credentials.

The browser talks to the Live API directly over WebSocket (lowest latency,
nothing to relay through Render's free instance), but it never sees the real
API key. The backend mints a single-use ephemeral token:

``POST {base}/v1alpha/auth_tokens`` with ``bidiGenerateContentSetup`` holding the
interview's model, system instruction, tools and transcription settings, and a
``fieldMask`` listing those fields as locked. Locked fields cannot be changed by
the browser, so a user cannot replace the interviewer's instructions. Session
resumption is deliberately left unlocked so the client can pass a resumption
handle when reconnecting.

The browser connects with ``new GoogleGenAI({apiKey: token, httpOptions:
{apiVersion}})``; the SDK then uses ``BidiGenerateContentConstrained`` with an
``access_token`` query parameter.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Any

import httpx

from app.core.config import Settings
from app.providers.base import (
    LiveCredentials,
    LiveInterviewProvider,
    LiveSessionSetup,
    empty_response,
    map_http_error,
    not_configured,
    timeout_error,
)


def _field_mask(setup: dict[str, Any]) -> str:
    """Same algorithm as the official SDK: one or two levels of keys."""
    fields: list[str] = []
    for key, value in setup.items():
        if isinstance(value, dict) and value:
            fields.extend(f"{key}.{sub}" for sub in value)
        else:
            fields.append(key)
    return ",".join(fields)


def _iso(dt: datetime) -> str:
    return dt.astimezone(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


class GeminiLiveProvider(LiveInterviewProvider):
    name = "gemini_live"

    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        self.model = settings.gemini_live_model
        self._client = httpx.AsyncClient(timeout=30.0)

    def is_configured(self) -> bool:
        return bool(self._settings.gemini_api_key and self.model)

    def build_setup(self, setup: LiveSessionSetup) -> dict[str, Any]:
        generation: dict[str, Any] = {"responseModalities": ["AUDIO"]}
        if setup.voice:
            generation["speechConfig"] = {"voiceConfig": {"prebuiltVoiceConfig": {"voiceName": setup.voice}}}
        body: dict[str, Any] = {
            "model": f"models/{self.model}",
            "generationConfig": generation,
            "systemInstruction": {"parts": [{"text": setup.system_instruction}]},
            "inputAudioTranscription": {},
            "outputAudioTranscription": {},
            "contextWindowCompression": {"slidingWindow": {}},
        }
        if setup.functions:
            body["tools"] = [
                {
                    "functionDeclarations": [
                        {"name": f.name, "description": f.description, "parameters": f.parameters}
                        for f in setup.functions
                    ]
                }
            ]
        return body

    async def create_credentials(self, setup: LiveSessionSetup) -> LiveCredentials:
        if not self._settings.gemini_api_key:
            raise not_configured("Gemini Live", "GEMINI_API_KEY")
        if not self.model:
            raise not_configured("Gemini Live", "GEMINI_LIVE_MODEL")
        now = datetime.now(UTC)
        expires = now + timedelta(seconds=self._settings.live_token_ttl_seconds)
        new_session = now + timedelta(seconds=self._settings.live_token_new_session_seconds)
        bidi = self.build_setup(setup)
        body = {
            "uses": 1,
            "expireTime": _iso(expires),
            "newSessionExpireTime": _iso(new_session),
            "bidiGenerateContentSetup": bidi,
            "fieldMask": _field_mask(bidi),
        }
        version = self._settings.gemini_live_api_version
        url = f"{self._settings.gemini_api_base.rstrip('/')}/{version}/auth_tokens"
        try:
            response = await self._client.post(
                url, json=body, headers={"x-goog-api-key": self._settings.gemini_api_key}
            )
        except httpx.TimeoutException as exc:
            raise timeout_error() from exc
        except httpx.HTTPError as exc:
            raise map_http_error(503, type(exc).__name__, "Gemini Live") from exc
        if response.status_code >= 400:
            try:
                err = response.json().get("error", {})
                message = f"{err.get('status', '')} {err.get('message', '')}"
            except ValueError:
                message = response.text[:200]
            raise map_http_error(response.status_code, message, "Gemini Live")
        token = response.json().get("name")
        if not token:
            raise empty_response()

        # The browser sends the same config when connecting; locked fields are
        # enforced server-side by Google regardless of what it sends.
        connect_config: dict[str, Any] = {
            "responseModalities": ["AUDIO"],
            "systemInstruction": setup.system_instruction,
            "inputAudioTranscription": {},
            "outputAudioTranscription": {},
            "contextWindowCompression": {"slidingWindow": {}},
        }
        if "speechConfig" in bidi["generationConfig"]:
            connect_config["speechConfig"] = bidi["generationConfig"]["speechConfig"]
        if "tools" in bidi:
            connect_config["tools"] = bidi["tools"]
        return LiveCredentials(
            provider=self.name,
            token=token,
            model=self.model,
            api_version=version,
            expires_at=expires,
            new_session_expires_at=new_session,
            connect_config=connect_config,
        )
