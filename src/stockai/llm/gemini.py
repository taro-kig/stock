"""Google Gemini (Generative Language API) provider via plain REST."""
from __future__ import annotations

import os
import time

import httpx

from .base import LLMError, LLMResponse, post_with_retry

_BASE = "https://generativelanguage.googleapis.com/v1beta/models"


class GeminiProvider:
    def __init__(self, model: str, *, name: str | None = None, api_key: str | None = None,
                 api_key_env: str = "GEMINI_API_KEY", timeout: float = 60.0):
        self.model = model
        self.name = name or model
        self._api_key = api_key or os.environ.get(api_key_env, "")
        if not self._api_key:
            raise LLMError(f"missing API key (env {api_key_env})")
        self._client = httpx.Client(timeout=timeout)

    def generate(self, system: str, user: str, *, temperature: float = 0.0,
                 json_mode: bool = True) -> LLMResponse:
        body: dict = {
            "systemInstruction": {"parts": [{"text": system}]},
            "contents": [{"role": "user", "parts": [{"text": user}]}],
            "generationConfig": {"temperature": temperature},
        }
        if json_mode:
            body["generationConfig"]["responseMimeType"] = "application/json"
        t0 = time.monotonic()
        data = post_with_retry(self._client, f"{_BASE}/{self.model}:generateContent",
                               json=body, headers={"x-goog-api-key": self._api_key})
        try:
            parts = data["candidates"][0]["content"]["parts"]
            text = "".join(p.get("text", "") for p in parts)
        except (KeyError, IndexError) as e:
            raise LLMError(f"unexpected Gemini response: {str(data)[:300]}") from e
        usage = data.get("usageMetadata", {})
        return LLMResponse(text=text, model=self.model,
                           input_tokens=int(usage.get("promptTokenCount", 0)),
                           output_tokens=int(usage.get("candidatesTokenCount", 0)),
                           latency_s=time.monotonic() - t0)
