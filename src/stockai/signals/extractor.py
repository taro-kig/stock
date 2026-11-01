"""Event extraction = the generic harness Ensemble configured for EventExtraction."""
from __future__ import annotations

from collections import Counter
from collections.abc import Sequence
from dataclasses import dataclass, field

from ..harness.ensemble import Ensemble, EnsembleResult
from ..harness.grounding import check_evidence
from ..harness.structured import StructuredCaller
from ..llm.base import LLMProvider
from .models import Document, EventExtraction, EventType
from .prompts import EVENT_PROMPT_VERSION, EVENT_SYSTEM, event_user_prompt


@dataclass
class ExtractionContext:
    doc: Document
    candidates: dict[str, str]                       # ticker -> name, from the prefilter
    priority_tickers: set[str] = field(default_factory=set)  # holdings / top candidates


def _sign(x: int) -> int:
    return (x > 0) - (x < 0)


def event_key(e: EventExtraction):
    if not e.relevant or e.event_type == EventType.NONE:
        return ("irrelevant",)
    return (e.event_type.value, _sign(e.direction))


def merge_events(group: list[EventExtraction]) -> EventExtraction:
    """Conservative merge: weakest direction/materiality, only tickers everyone agreed on."""
    first = group[0]
    if not first.relevant:
        return first
    tickers = set(first.tickers)
    for e in group[1:]:
        tickers &= set(e.tickers)
    evidence = list(dict.fromkeys(q for e in group for q in e.evidence))[:3]
    return EventExtraction(
        relevant=True,
        tickers=sorted(tickers),
        event_type=first.event_type,
        direction=min((e.direction for e in group), key=abs),
        materiality=min(e.materiality for e in group),
        horizon=Counter(e.horizon for e in group).most_common(1)[0][0],
        confidence=sum(e.confidence for e in group) / len(group),
        evidence=evidence,
        rationale=first.rationale,
    )


def validate_event(e: EventExtraction, ctx: ExtractionContext) -> str | None:
    """Deterministic checks. Returning a string rejects the vote."""
    if not e.relevant or e.event_type == EventType.NONE:
        return None  # "nothing here" needs no evidence
    if not e.tickers:
        return "relevant but no tickers"
    unknown = set(e.tickers) - set(ctx.candidates)
    if unknown:
        return f"tickers not in candidates: {sorted(unknown)}"
    ok, failed = check_evidence(e.evidence, ctx.doc.text)
    if not ok:
        return f"ungrounded evidence: {failed or 'none given'}"
    return None


def should_escalate(values: list[EventExtraction], ctx: ExtractionContext) -> bool:
    if any(set(v.tickers) & ctx.priority_tickers for v in values):
        return True
    return any(v.relevant and v.materiality >= 2 for v in values)


class EventExtractor:
    def __init__(self, caller: StructuredCaller, members: Sequence[LLMProvider], *,
                 quorum: int = 2, escalation: LLMProvider | None = None):
        self.ensemble = Ensemble(caller, members, EventExtraction, key_fn=event_key,
                                 merge_fn=merge_events, validate_fn=validate_event, quorum=quorum,
                                 escalation=escalation, should_escalate=should_escalate)

    def extract(self, ctx: ExtractionContext) -> EnsembleResult[EventExtraction]:
        result = self.ensemble.run(EVENT_SYSTEM, event_user_prompt(ctx.doc, ctx.candidates),
                                   prompt_version=EVENT_PROMPT_VERSION, context=ctx)
        # the conservative ticker intersection can come out empty -> treat as no signal
        if result.value is not None and result.value.relevant and not result.value.tickers:
            result.status, result.value = "no_consensus", None
        return result
