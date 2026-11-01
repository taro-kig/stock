"""H1 + H4 + H5: one structured LLM call = cache -> budget -> call -> validate -> retry."""
from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import Generic, TypeVar

from pydantic import BaseModel, ValidationError

from ..llm.base import LLMError, LLMProvider
from .budget import CostTracker
from .cache import Cache, cache_key

T = TypeVar("T", bound=BaseModel)

_FENCE = re.compile(r"^```(?:json)?\s*|\s*```$", re.MULTILINE)


@dataclass
class CallResult(Generic[T]):
    provider: str
    value: T | None
    attempts: int = 0
    cached: bool = False
    error: str | None = None


def extract_json(text: str) -> dict:
    text = _FENCE.sub("", text.strip())
    start, end = text.find("{"), text.rfind("}")
    if start == -1 or end <= start:
        raise ValueError("no JSON object found in output")
    return json.loads(text[start:end + 1])


def schema_instruction(schema: type[BaseModel]) -> str:
    return ("\n\n# 出力形式\n次の JSON Schema に厳密に従う JSON オブジェクトを1つだけ出力すること。"
            "説明文やコードブロックは不要。\n"
            + json.dumps(schema.model_json_schema(), ensure_ascii=False))


class StructuredCaller:
    def __init__(self, cache: Cache | None = None, budget: CostTracker | None = None,
                 max_retries: int = 2, temperature: float = 0.0):
        self.cache = cache
        self.budget = budget
        self.max_retries = max_retries
        self.temperature = temperature

    def call(self, provider: LLMProvider, schema: type[T], system: str, user: str,
             *, prompt_version: str) -> CallResult[T]:
        """BudgetExceeded propagates on purpose: the caller must stop the LLM stage."""
        system_full = system + schema_instruction(schema)
        key = cache_key(provider.model, prompt_version, schema.__name__, system_full, user)

        if self.cache and (hit := self.cache.get(key)) is not None:
            try:
                return CallResult(provider.name, schema.model_validate(hit), cached=True)
            except ValidationError:
                pass  # schema changed since caching -> recompute

        prompt, last_err = user, None
        for attempt in range(1, self.max_retries + 2):
            if self.budget:
                self.budget.check()
            try:
                resp = provider.generate(system_full, prompt, temperature=self.temperature)
            except LLMError as e:
                return CallResult(provider.name, None, attempts=attempt, error=f"llm: {e}")
            if self.budget:
                self.budget.record(provider.name, resp)
            try:
                value = schema.model_validate(extract_json(resp.text))
            except (ValueError, ValidationError) as e:
                last_err = str(e)[:800]
                prompt = (f"{user}\n\n# 注意\n前回の出力は次の理由で不正だった。"
                          f"スキーマに従った JSON のみを出力し直すこと。\n{last_err}")
                continue
            if self.cache:
                self.cache.put(key, value.model_dump(mode="json"))
            return CallResult(provider.name, value, attempts=attempt)
        return CallResult(provider.name, None, attempts=self.max_retries + 1,
                          error=f"invalid output: {last_err}")
