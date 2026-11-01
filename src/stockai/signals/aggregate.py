"""Turn accepted event extractions into a per-ticker event score (DESIGN §4.3)."""
from __future__ import annotations

import datetime as dt
import math
from collections import defaultdict
from dataclasses import dataclass

from .models import EventExtraction

HALF_LIFE_DAYS = {"days": 3.0, "weeks": 10.0, "months": 30.0}
MATERIALITY_WEIGHT = {0: 0.0, 1: 0.3, 2: 0.7, 3: 1.0}


@dataclass
class ScoredEvent:
    event: EventExtraction
    as_of: dt.datetime            # when we *learned* it (point-in-time)
    agreement: float              # from the ensemble
    source_weight: float = 1.0
    n_sources: int = 1            # independent outlets carrying the story


def event_scores(events: list[ScoredEvent], now: dt.datetime, *,
                 corroboration_bonus: float = 0.5) -> dict[str, float]:
    scores: dict[str, float] = defaultdict(float)
    for se in events:
        e = se.event
        if not e.relevant or se.as_of > now:  # never use information from the future
            continue
        age_days = (now - se.as_of).total_seconds() / 86400
        decay = math.exp(-math.log(2) * age_days / HALF_LIFE_DAYS[e.horizon])
        s = (e.direction * MATERIALITY_WEIGHT[e.materiality] * e.confidence * se.agreement
             * se.source_weight * decay)
        if se.n_sources >= 2:
            s *= 1 + corroboration_bonus
        for t in e.tickers:
            scores[t] += s
    return dict(scores)
