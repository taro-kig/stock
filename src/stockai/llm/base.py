"""Provider-agnostic LLM interface.

Every provider only has to turn (system, user) into text + token counts.
Everything that makes the output trustworthy lives in `stockai.harness`.
"""
from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Protocol, runtime_checkable

import httpx


class LLMError(RuntimeError):
    """Raised when a provider cannot produce a response (after transport retries)."""


@dataclass(frozen=True)
class LLMResponse:
    text: str
    model: str
    input_tokens: int
    output_tokens: int
    latency_s: float = 0.0


@runtime_checkable
class LLMProvider(Protocol):
    name: str   # unique label used in votes / logs, e.g. "gemini-flash-lite"
    model: str  # model id sent to the API (also the key into the pricing table)

    def generate(self, system: str, user: str, *, temperature: float = 0.0,
                 json_mode: bool = True) -> LLMResponse: ...


_RETRY_STATUS = {408, 429, 500, 502, 503, 504}


def post_with_retry(client: httpx.Client, url: str, *, json: dict, headers: dict,
                    max_attempts: int = 4, base_delay: float = 2.0) -> dict:
    """POST with exponential backoff on rate limits / transient server errors."""
    last_err: Exception | None = None
    for attempt in range(max_attempts):
        try:
            r = client.post(url, json=json, headers=headers)
            if r.status_code in _RETRY_STATUS:
                last_err = LLMError(f"HTTP {r.status_code}: {r.text[:200]}")
            elif r.status_code >= 400:
                raise LLMError(f"HTTP {r.status_code}: {r.text[:500]}")
            else:
                return r.json()
        except httpx.TransportError as e:
            last_err = e
        if attempt < max_attempts - 1:
            time.sleep(base_delay * (2 ** attempt))
    raise LLMError(f"request failed after {max_attempts} attempts: {last_err}")
