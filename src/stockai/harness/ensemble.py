"""H3: cross-vendor voting with early stopping and conditional escalation.

Members are called sequentially and we stop as soon as `quorum` of them
agree, so in the common (easy) case we pay for only `quorum` calls.  A
stronger model is consulted only when the cheap ones disagree *and* the
item is important; it acts as a tie-breaker and must agree with at least one
cheap model, so a single model can never create a signal alone.
"""
from __future__ import annotations

from collections.abc import Callable, Hashable, Sequence
from dataclasses import dataclass, field
from typing import Any, Generic, Literal, TypeVar

from pydantic import BaseModel

from ..llm.base import LLMProvider
from .structured import StructuredCaller

T = TypeVar("T", bound=BaseModel)
Status = Literal["consensus", "escalated", "no_consensus", "failed"]


@dataclass
class Vote(Generic[T]):
    provider: str
    value: T | None
    rejected: str | None = None  # why this vote was discarded (invalid output, grounding, ...)
    cached: bool = False

    @property
    def valid(self) -> bool:
        return self.value is not None and self.rejected is None


@dataclass
class EnsembleResult(Generic[T]):
    status: Status
    value: T | None
    agreement: float
    votes: list[Vote[T]] = field(default_factory=list)


class Ensemble(Generic[T]):
    def __init__(self, caller: StructuredCaller, members: Sequence[LLMProvider], schema: type[T], *,
                 key_fn: Callable[[T], Hashable],
                 merge_fn: Callable[[list[T]], T],
                 validate_fn: Callable[[T, Any], str | None] | None = None,
                 quorum: int = 2,
                 escalation: LLMProvider | None = None,
                 should_escalate: Callable[[list[T], Any], bool] | None = None):
        if quorum > len(members):
            raise ValueError("quorum cannot exceed number of members")
        self.caller, self.members, self.schema = caller, list(members), schema
        self.key_fn, self.merge_fn, self.validate_fn = key_fn, merge_fn, validate_fn
        self.quorum, self.escalation, self.should_escalate = quorum, escalation, should_escalate

    def _vote(self, provider: LLMProvider, system: str, user: str, prompt_version: str,
              context: Any) -> Vote[T]:
        res = self.caller.call(provider, self.schema, system, user, prompt_version=prompt_version)
        if res.value is None:
            return Vote(provider.name, None, rejected=res.error or "no value", cached=res.cached)
        reason = self.validate_fn(res.value, context) if self.validate_fn else None
        return Vote(provider.name, res.value, rejected=reason, cached=res.cached)

    def _groups(self, votes: list[Vote[T]]) -> dict[Hashable, list[T]]:
        groups: dict[Hashable, list[T]] = {}
        for v in votes:
            if v.valid:
                groups.setdefault(self.key_fn(v.value), []).append(v.value)
        return groups

    def run(self, system: str, user: str, *, prompt_version: str,
            context: Any = None) -> EnsembleResult[T]:
        votes: list[Vote[T]] = []
        for i, member in enumerate(self.members):
            votes.append(self._vote(member, system, user, prompt_version, context))
            groups = self._groups(votes)
            best = max((len(g) for g in groups.values()), default=0)
            if best >= self.quorum:
                break
            if best + (len(self.members) - i - 1) < self.quorum:
                break  # quorum is no longer reachable, stop paying

        groups = self._groups(votes)
        ranked = sorted(groups.values(), key=len, reverse=True)
        if ranked and len(ranked[0]) >= self.quorum and (len(ranked) == 1 or len(ranked[0]) > len(ranked[1])):
            return EnsembleResult("consensus", self.merge_fn(ranked[0]),
                                  len(ranked[0]) / len(votes), votes)

        valid = [v.value for v in votes if v.valid]
        if (self.escalation and valid
                and (self.should_escalate is None or self.should_escalate(valid, context))):
            ev = self._vote(self.escalation, system, user, prompt_version, context)
            votes.append(ev)
            if ev.valid and (match := groups.get(self.key_fn(ev.value))):
                group = match + [ev.value]
                return EnsembleResult("escalated", self.merge_fn(group), len(group) / len(votes), votes)

        status: Status = "no_consensus" if any(v.valid for v in votes) else "failed"
        return EnsembleResult(status, None, 0.0, votes)
