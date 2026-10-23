"""Provider adapters, tested against a mocked HTTP transport (no real network).

These verify request shapes and error handling. Real calls are in
test_real_providers.py (opt-in).
"""

from __future__ import annotations

import json

import httpx
import pytest

from app.core.config import Settings
from app.core.errors import ProviderError
from app.providers.base import LiveFunction, LiveSessionSetup
from app.providers.gemini_live import GeminiLiveProvider
from app.providers.gemini_text import GeminiTextProvider
from app.providers.groq_text import GroqTextProvider
from app.providers.json_schema import inline_schema
from app.schemas.documents import JobExtraction
from app.schemas.plan import InterviewPlanDraft
from app.services import ai_calls

SETTINGS = Settings(
    gemini_api_key="test-key", groq_api_key="gk", groq_text_model="groq-model", database_url=""
)


def _with_transport(provider, handler) -> None:
    provider._client = httpx.AsyncClient(transport=httpx.MockTransport(handler))


def _gemini_ok(text: str) -> httpx.Response:
    return httpx.Response(
        200,
        json={
            "candidates": [{"content": {"parts": [{"text": text}]}}],
            "usageMetadata": {"promptTokenCount": 11, "candidatesTokenCount": 7},
        },
    )


async def test_gemini_text_request_shape() -> None:
    seen: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        seen["key"] = request.headers.get("x-goog-api-key")
        seen["body"] = json.loads(request.content)
        return _gemini_ok(json.dumps({"job_title": "Analyst"}))

    p = GeminiTextProvider(SETTINGS, model="gemini-3.5-flash-lite")
    _with_transport(p, handler)
    result = await p.generate_json(system="sys", prompt="hello", schema=JobExtraction)
    assert seen["url"].endswith("/v1beta/models/gemini-3.5-flash-lite:generateContent")
    assert seen["key"] == "test-key"
    gen = seen["body"]["generationConfig"]
    assert gen["responseMimeType"] == "application/json"
    assert "$ref" not in json.dumps(gen["responseJsonSchema"])
    assert seen["body"]["systemInstruction"]["parts"][0]["text"] == "sys"
    assert result.data == {"job_title": "Analyst"} and result.usage.input_tokens == 11
    assert "key=" not in seen["url"]  # key never in the URL


async def test_gemini_schema_fallback() -> None:
    calls: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        calls.append(body)
        if "responseJsonSchema" in body["generationConfig"]:
            return httpx.Response(
                400, json={"error": {"status": "INVALID_ARGUMENT", "message": "Invalid JSON schema"}}
            )
        return _gemini_ok('```json\n{"job_title": "Analyst"}\n```')

    p = GeminiTextProvider(SETTINGS)
    _with_transport(p, handler)
    result = await p.generate_json(system="s", prompt="p", schema=JobExtraction)
    assert len(calls) == 2 and "JSON Schema" in calls[1]["contents"][0]["parts"][0]["text"]
    assert result.data["job_title"] == "Analyst"


async def test_gemini_schema_fallback_generic_400_without_schema_in_message() -> None:
    calls: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        calls.append(body)
        if "responseJsonSchema" in body["generationConfig"]:
            # Real Gemini 400 error does NOT mention "schema":
            return httpx.Response(
                400,
                json={
                    "error": {
                        "status": "INVALID_ARGUMENT",
                        "message": "Request contains an invalid argument.",
                    }
                },
            )
        return _gemini_ok('```json\n{"job_title": "Analyst"}\n```')

    p = GeminiTextProvider(SETTINGS)
    _with_transport(p, handler)
    result = await p.generate_json(system="s", prompt="p", schema=JobExtraction)
    assert len(calls) == 2
    assert "responseJsonSchema" not in calls[1]["generationConfig"]
    assert "JSON Schema" in calls[1]["contents"][0]["parts"][0]["text"]
    assert result.data["job_title"] == "Analyst"


def test_inline_schema_interview_plan_draft_gemini_compatible() -> None:
    sch = inline_schema(InterviewPlanDraft)
    sch_json = json.dumps(sch)
    assert "exclusiveMinimum" not in sch_json
    assert "exclusiveMaximum" not in sch_json
    assert "$ref" not in sch_json
    assert "$defs" not in sch


@pytest.mark.parametrize(
    ("response", "code"),
    [
        (httpx.Response(200, json={"candidates": []}), "AI_EMPTY_RESPONSE"),
        (_gemini_ok("not json at all"), "AI_MALFORMED_RESPONSE"),
        (
            httpx.Response(
                429, json={"error": {"status": "RESOURCE_EXHAUSTED", "message": "rate limit per minute"}}
            ),
            "AI_PROVIDER_RATE_LIMITED",
        ),
        (
            httpx.Response(404, json={"error": {"status": "NOT_FOUND", "message": "model is not found"}}),
            "AI_MODEL_UNSUPPORTED",
        ),
    ],
)
async def test_gemini_errors(response: httpx.Response, code: str) -> None:
    p = GeminiTextProvider(SETTINGS)
    _with_transport(p, lambda r: response)
    with pytest.raises(ProviderError) as exc:
        await p.generate_json(system="s", prompt="p", schema=JobExtraction)
    assert exc.value.code == code


async def test_gemini_timeout() -> None:
    def handler(request):
        raise httpx.ReadTimeout("slow", request=request)

    p = GeminiTextProvider(SETTINGS)
    _with_transport(p, handler)
    with pytest.raises(ProviderError) as exc:
        await p.generate_json(system="s", prompt="p", schema=JobExtraction)
    assert exc.value.code == "AI_PROVIDER_TIMEOUT" and exc.value.retryable


async def test_missing_key_is_configuration_error_not_mock() -> None:
    p = GeminiTextProvider(Settings(gemini_api_key="", database_url=""))
    assert not p.is_configured()
    with pytest.raises(ProviderError) as exc:
        await p.generate_json(system="s", prompt="p", schema=JobExtraction)
    assert exc.value.code == "AI_PROVIDER_NOT_CONFIGURED"


async def test_live_token_request_locks_setup() -> None:
    seen: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        seen["body"] = json.loads(request.content)
        seen["key"] = request.headers.get("x-goog-api-key")
        return httpx.Response(200, json={"name": "auth_tokens/abc"})

    p = GeminiLiveProvider(SETTINGS)
    _with_transport(p, handler)
    creds = await p.create_credentials(
        LiveSessionSetup(
            system_instruction="Be an interviewer",
            functions=[LiveFunction("advance_to_question", "d", {"type": "object", "properties": {}})],
            voice="Puck",
        )
    )
    body = seen["body"]
    assert seen["url"].endswith("/v1alpha/auth_tokens") and seen["key"] == "test-key"
    assert body["uses"] == 1 and body["expireTime"].endswith("Z")
    setup = body["bidiGenerateContentSetup"]
    assert setup["model"] == "models/gemini-3.8-live"
    assert setup["systemInstruction"]["parts"][0]["text"] == "Be an interviewer"
    assert setup["generationConfig"]["responseModalities"] == ["AUDIO"]
    mask = body["fieldMask"].split(",")
    assert {"model", "systemInstruction.parts", "tools", "generationConfig.responseModalities"} <= set(mask)
    assert "sessionResumption" not in mask  # left open so the client can resume
    assert creds.token == "auth_tokens/abc" and creds.api_version == "v1alpha"
    assert "test-key" not in json.dumps(creds.connect_config)


async def test_groq_request_shape() -> None:
    seen: dict = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["body"] = json.loads(request.content)
        seen["auth"] = request.headers.get("authorization")
        return httpx.Response(
            200,
            json={
                "choices": [{"message": {"content": '{"job_title":"X"}'}}],
                "usage": {"prompt_tokens": 3, "completion_tokens": 2},
            },
        )

    p = GroqTextProvider(SETTINGS)
    _with_transport(p, handler)
    result = await p.generate_json(system="s", prompt="p", schema=JobExtraction)
    assert seen["auth"] == "Bearer gk" and seen["body"]["response_format"] == {"type": "json_object"}
    assert result.data == {"job_title": "X"}


# --------------------------------------------------------------- retry policy


class _Scripted:
    def __init__(self, items):
        self.items = list(items)
        self.calls = 0

    async def __call__(self, prompt: str):
        from app.providers.base import JSONResult, UsageInfo

        self.calls += 1
        item = self.items.pop(0)
        if isinstance(item, Exception):
            raise item
        return JSONResult(data=item, usage=UsageInfo("fake", "m", 1))


async def _no_sleep(_: float) -> None:
    return None


@pytest.fixture
def no_usage(monkeypatch):
    async def _noop(**kwargs):
        return None

    monkeypatch.setattr(ai_calls, "record_usage", _noop)


async def test_invalid_output_retried_then_accepted(no_usage) -> None:
    call = _Scripted([{"seniority": "galactic"}, {"job_title": "Analyst"}])
    result = await ai_calls.call_validated(
        call, JobExtraction, prompt="p", operation="t", provider="f", model="m", sleep=_no_sleep
    )
    assert result.job_title == "Analyst" and call.calls == 2


async def test_invalid_output_exhausts_retries(no_usage) -> None:
    call = _Scripted([{"seniority": "galactic"}] * 5)
    with pytest.raises(ProviderError) as exc:
        await ai_calls.call_validated(
            call, JobExtraction, prompt="p", operation="t", provider="f", model="m", sleep=_no_sleep
        )
    assert exc.value.code == "AI_MALFORMED_RESPONSE" and call.calls == 3  # bounded


async def test_transient_error_retried(no_usage) -> None:
    transient = ProviderError("busy", code="AI_PROVIDER_RATE_LIMITED", retryable=True)
    call = _Scripted([transient, {"job_title": "A"}])
    result = await ai_calls.call_validated(
        call, JobExtraction, prompt="p", operation="t", provider="f", model="m", sleep=_no_sleep
    )
    assert result.job_title == "A" and call.calls == 2


async def test_quota_exhausted_fails_fast(no_usage) -> None:
    quota = ProviderError("quota", code="AI_PROVIDER_QUOTA_EXHAUSTED", retryable=False)
    call = _Scripted([quota, {"job_title": "A"}])
    with pytest.raises(ProviderError):
        await ai_calls.call_validated(
            call, JobExtraction, prompt="p", operation="t", provider="f", model="m", sleep=_no_sleep
        )
    assert call.calls == 1  # no silent retry / no provider switch
