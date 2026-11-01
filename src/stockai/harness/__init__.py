"""Reliability harness: makes cheap, unreliable LLMs usable as components.

H1 structured.py  - JSON + schema validation + retry with error feedback
H2 grounding.py   - evidence quotes must literally exist in the source
H3 ensemble.py    - cross-vendor voting with early stop and escalation
H4 cache.py       - content-hash cache, never pay twice for the same input
H5 budget.py      - daily cost cap (fail-safe: no LLM -> no signal)
"""
from .budget import BudgetExceeded, CostTracker
from .cache import Cache
from .ensemble import Ensemble, EnsembleResult, Vote
from .grounding import check_evidence, quote_in_source
from .structured import CallResult, StructuredCaller

__all__ = [
    "BudgetExceeded", "CostTracker", "Cache", "Ensemble", "EnsembleResult", "Vote",
    "check_evidence", "quote_in_source", "CallResult", "StructuredCaller",
]
