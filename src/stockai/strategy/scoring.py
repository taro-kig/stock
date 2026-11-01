"""Cross-sectional composite score (DESIGN §6.2). Deterministic, no LLM."""
from __future__ import annotations

import pandas as pd

DEFAULT_WEIGHTS = {"momentum": 0.35, "event": 0.35, "rel_strength": 0.15, "quality": 0.15}


def zscore(s: pd.Series, clip: float = 3.0) -> pd.Series:
    sd = s.std(ddof=0)
    if not sd or pd.isna(sd):
        return s * 0.0
    return ((s - s.mean()) / sd).clip(-clip, clip)


def composite_score(factors: pd.DataFrame, weights: dict[str, float] | None = None) -> pd.Series:
    """factors: index = ticker, columns = factor names. Missing values count as neutral (0)."""
    weights = weights or DEFAULT_WEIGHTS
    total = pd.Series(0.0, index=factors.index)
    used = 0.0
    for col, w in weights.items():
        if col in factors:
            total += w * zscore(factors[col].astype(float)).fillna(0.0)
            used += w
    return (total / used if used else total).sort_values(ascending=False)
