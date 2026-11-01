from stockai.harness.budget import BudgetExceeded, CostTracker
from stockai.harness.cache import Cache
from stockai.harness.structured import StructuredCaller
from stockai.llm.fake import FakeProvider
from stockai.signals.models import EventExtraction

import pytest

from conftest import event_json


def test_retries_after_invalid_output_then_succeeds():
    p = FakeProvider("m", ["I think it's bullish!", event_json(direction=5), "```json\n" + event_json() + "\n```"])
    res = StructuredCaller(max_retries=2).call(p, EventExtraction, "sys", "doc", prompt_version="v1")
    assert res.value is not None and res.value.direction == 2
    assert res.attempts == 3


def test_gives_up_after_max_retries():
    p = FakeProvider("m", ["nope"])
    res = StructuredCaller(max_retries=1).call(p, EventExtraction, "sys", "doc", prompt_version="v1")
    assert res.value is None and res.attempts == 2 and "invalid output" in res.error


def test_cache_prevents_second_paid_call():
    p = FakeProvider("m", [event_json()])
    caller = StructuredCaller(cache=Cache())
    first = caller.call(p, EventExtraction, "sys", "doc", prompt_version="v1")
    second = caller.call(p, EventExtraction, "sys", "doc", prompt_version="v1")
    assert not first.cached and second.cached and p.calls == 1
    caller.call(p, EventExtraction, "sys", "doc", prompt_version="v2")  # new prompt version -> new key
    assert p.calls == 2


def test_budget_cap_stops_calls():
    budget = CostTracker({"m": (1_000_000.0, 0.0)}, daily_limit_usd=0.01)  # absurd price -> 1st call blows it
    p = FakeProvider("m", [event_json()])
    caller = StructuredCaller(budget=budget)
    caller.call(p, EventExtraction, "sys", "doc", prompt_version="v1")
    with pytest.raises(BudgetExceeded):
        caller.call(p, EventExtraction, "sys", "other doc", prompt_version="v1")


def test_unknown_model_uses_pessimistic_price():
    t = CostTracker({})
    assert t.cost_of("unknown-model", 1_000_000, 0) > 1.0
