"""Build providers from the `models:` section of the config."""
from __future__ import annotations

from .base import LLMProvider


def build_provider(spec: dict) -> LLMProvider:
    kind = spec["provider"]
    common = {"name": spec.get("name"), "api_key_env": spec.get("api_key_env")}
    common = {k: v for k, v in common.items() if v}
    if kind == "gemini":
        from .gemini import GeminiProvider
        return GeminiProvider(spec["model"], **common)
    if kind == "openai_compat":
        from .openai_compat import OpenAICompatProvider
        return OpenAICompatProvider(spec["model"], base_url=spec["base_url"], **common)
    raise ValueError(f"unknown provider kind: {kind}")
