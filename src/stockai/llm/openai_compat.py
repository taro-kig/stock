"""OpenAI-compatible chat-completions provider.

Covers OpenAI, DeepSeek, OpenRouter, Groq, Together, local vLLM/Ollama, etc.
Using a *different vendor* than Gemini is what makes the ensemble vote useful
(errors of models from different families are less correlated).
"""
from __future__ import annotations

import os
import time

import httpx

from .base import LLMError, LLMResponse, post_with_retry


class OpenAICompatProvider:
    def __init__(self, model: str, *, base_url: str, name: str | None = None,
                 api_key: str | None = None, api_key_env: str = "OPENAI_API_KEY",
                 timeout: float = 60.0):
        self.model = model
        self.name = name or model
        self._url = base_url.rstrip("/") + "/chat/completions"
        self._api_key = api_key or os.environ.get(api_key_env, "")
        if not self._api_key:
            raise LLMError(f"missing API key (env {api_key_env})")
        self._client = httpx.Client(timeout=timeout)

    def generate(self, system: str, user: str, *, temperature: float = 0.0,
                 json_mode: bool = True) -> LLMResponse:
        body: dict = {
            "model": self.model,
            "temperature": temperature,
            "messages": [{"role": "system", "content": system},
                         {"role": "user", "content": user}],
        }
        if json_mode:
            body["response_format"] = {"type": "json_object"}
        t0 = time.monotonic()
        data = post_with_retry(self._client, self._url, json=body,
                               headers={"Authorization": f"Bearer {self._api_key}"})
        try:
            text = data["choices"][0]["message"]["content"] or ""
        except (KeyError, IndexError) as e:
            raise LLMError(f"unexpected response: {str(data)[:300]}") from e
        usage = data.get("usage", {})
        return LLMResponse(text=text, model=self.model,
                           input_tokens=int(usage.get("prompt_tokens", 0)),
                           output_tokens=int(usage.get("completion_tokens", 0)),
                           latency_s=time.monotonic() - t0)
