"""Provider selection from configuration."""

from __future__ import annotations

from dataclasses import dataclass
from functools import lru_cache

from pydantic import BaseModel

from app.core.config import Settings, get_settings
from app.core.errors import ConfigurationError
from app.providers.base import (
    EvaluationProvider,
    JSONResult,
    LiveInterviewProvider,
    TextGenerationProvider,
)
from app.providers.gemini_live import GeminiLiveProvider
from app.providers.gemini_text import GeminiTextProvider
from app.providers.groq_text import GroqTextProvider


class TextBackedEvaluationProvider(EvaluationProvider):
    """Evaluation through a text provider, with a low temperature for consistency."""

    def __init__(self, text: TextGenerationProvider) -> None:
        self._text = text
        self.name = text.name
        self.model = text.model

    def is_configured(self) -> bool:
        return self._text.is_configured()

    async def evaluate(self, *, system: str, prompt: str, schema: type[BaseModel]) -> JSONResult:
        return await self._text.generate_json(
            system=system, prompt=prompt, schema=schema, temperature=0.1, max_output_tokens=16384
        )


@dataclass
class ProviderRegistry:
    text: TextGenerationProvider
    evaluation: EvaluationProvider
    live: LiveInterviewProvider

    def status(self) -> dict[str, dict[str, object]]:
        return {
            "text": {
                "provider": self.text.name,
                "model": self.text.model,
                "configured": self.text.is_configured(),
            },
            "evaluation": {
                "provider": self.evaluation.name,
                "model": self.evaluation.model,
                "configured": self.evaluation.is_configured(),
            },
            "live": {
                "provider": self.live.name,
                "model": self.live.model,
                "configured": self.live.is_configured(),
            },
        }


def _text_provider(name: str, settings: Settings, *, evaluation: bool) -> TextGenerationProvider:
    if name == "gemini":
        model = settings.gemini_evaluation_model if evaluation else settings.gemini_text_model
        return GeminiTextProvider(settings, model=model)
    if name == "groq":
        return GroqTextProvider(settings)
    raise ConfigurationError(f"Unknown AI provider '{name}'.", code="AI_PROVIDER_UNKNOWN")


def build_registry(settings: Settings) -> ProviderRegistry:
    if settings.live_ai_provider != "gemini_live":
        raise ConfigurationError(
            f"Unknown live provider '{settings.live_ai_provider}'.", code="AI_PROVIDER_UNKNOWN"
        )
    return ProviderRegistry(
        text=_text_provider(settings.text_ai_provider, settings, evaluation=False),
        evaluation=TextBackedEvaluationProvider(
            _text_provider(settings.evaluation_ai_provider, settings, evaluation=True)
        ),
        live=GeminiLiveProvider(settings),
    )


@lru_cache
def _registry() -> ProviderRegistry:
    return build_registry(get_settings())


def get_provider_registry() -> ProviderRegistry:
    return _registry()
