"""Position sizing, stops and kill switch (DESIGN §6.4-6.5)."""
from __future__ import annotations

import math
from dataclasses import dataclass


@dataclass(frozen=True)
class RiskConfig:
    risk_per_trade: float = 0.0075   # fraction of equity lost if the stop is hit
    stop_atr_mult: float = 2.5
    trail_atr_mult: float = 3.0
    max_weight: float = 0.10
    max_positions: int = 12
    max_sector_weight: float = 0.30
    lot_size: int = 1                # 100 for Japanese equities (単元株)
    dd_halt_new: float = 0.15        # drawdown that stops new entries
    dd_reduce: float = 0.25          # drawdown that requires de-risking + human review


def position_size(equity: float, price: float, atr: float, cfg: RiskConfig) -> int:
    """Shares such that hitting the ATR stop loses ~risk_per_trade of equity, capped by max_weight."""
    if price <= 0 or atr <= 0 or math.isnan(atr):
        return 0
    by_risk = equity * cfg.risk_per_trade / (cfg.stop_atr_mult * atr)
    by_weight = equity * cfg.max_weight / price
    shares = min(by_risk, by_weight)
    return int(shares // cfg.lot_size) * cfg.lot_size


def stop_price(entry: float, highest_close: float, atr: float, cfg: RiskConfig) -> float:
    """The higher of the initial stop and the trailing stop."""
    return max(entry - cfg.stop_atr_mult * atr, highest_close - cfg.trail_atr_mult * atr)


def drawdown(equity: float, peak_equity: float) -> float:
    return 0.0 if peak_equity <= 0 else max(0.0, 1 - equity / peak_equity)


def trading_mode(equity: float, peak_equity: float, cfg: RiskConfig) -> str:
    """'normal' | 'no_new_entries' | 'reduce'"""
    dd = drawdown(equity, peak_equity)
    if dd >= cfg.dd_reduce:
        return "reduce"
    if dd >= cfg.dd_halt_new:
        return "no_new_entries"
    return "normal"
