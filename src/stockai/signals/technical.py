"""Price-based factors (no LLM). Inputs are daily pandas Series indexed by date."""
from __future__ import annotations

import numpy as np
import pandas as pd

TRADING_DAYS = 252


def momentum_12_1(close: pd.Series) -> float:
    """12-month return skipping the most recent month (classic mid-term momentum)."""
    if len(close) < TRADING_DAYS + 1:
        return float("nan")
    return float(close.iloc[-22] / close.iloc[-TRADING_DAYS - 1] - 1)


def relative_strength(close: pd.Series, index_close: pd.Series, days: int = 126) -> float:
    s, i = close.dropna(), index_close.reindex(close.index).ffill()
    if len(s) <= days:
        return float("nan")
    return float((s.iloc[-1] / s.iloc[-days - 1]) - (i.iloc[-1] / i.iloc[-days - 1]))


def trend_ok(close: pd.Series) -> bool:
    if len(close) < 200:
        return False
    sma50, sma200 = close.rolling(50).mean().iloc[-1], close.rolling(200).mean().iloc[-1]
    return bool(close.iloc[-1] > sma200 and sma50 > sma200)


def atr(high: pd.Series, low: pd.Series, close: pd.Series, n: int = 20) -> float:
    prev = close.shift(1)
    tr = pd.concat([high - low, (high - prev).abs(), (low - prev).abs()], axis=1).max(axis=1)
    return float(tr.rolling(n).mean().iloc[-1])


def realized_vol(close: pd.Series, n: int = 60) -> float:
    r = np.log(close).diff().dropna().iloc[-n:]
    return float(r.std() * np.sqrt(TRADING_DAYS))
