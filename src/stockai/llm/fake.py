"""Deterministic provider for tests and dry runs (no network, no cost)."""
from __future__ import annotations

from collections.abc import Callable, Iterable

from .base import LLMResponse


class FakeProvider:
    """Returns scripted responses.

    `responses` may be a list (consumed in order, last one repeats) or a
    callable `(system, user) -> str`.
    """

    def __init__(self, name: str, responses: Iterable[str] | Callable[[str, str], str],
                 model: str | None = None):
        self.name = name
        self.model = model or name
        self._fn = responses if callable(responses) else None
        self._queue = [] if callable(responses) else list(responses)
        self.calls = 0

    def generate(self, system: str, user: str, *, temperature: float = 0.0,
                 json_mode: bool = True) -> LLMResponse:
        self.calls += 1
        if self._fn is not None:
            text = self._fn(system, user)
        else:
            text = self._queue.pop(0) if len(self._queue) > 1 else self._queue[0]
        return LLMResponse(text=text, model=self.model,
                           input_tokens=len(system + user) // 4,
                           output_tokens=len(text) // 4)
