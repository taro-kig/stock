"""Weekly rebalance proposals with hysteresis and hard constraints (DESIGN §6.3-6.5).

Output is a list of *proposals*. Whether they are executed (paper / human
approval / automatic) is decided downstream.
"""
from __future__ import annotations

from dataclasses import dataclass, field

import pandas as pd

from .risk import RiskConfig, position_size, stop_price


@dataclass
class Position:
    ticker: str
    shares: int
    entry_price: float
    highest_close: float
    sector: str = "unknown"
    days_held: int = 0


@dataclass
class Candidate:
    ticker: str
    price: float
    atr: float
    sector: str = "unknown"
    trend_ok: bool = True
    blocked_reason: str | None = None   # e.g. "earnings in 2 days", "negative material event"


@dataclass
class Proposal:
    action: str          # "buy" | "sell"
    ticker: str
    shares: int
    reason: str
    stop: float | None = None


@dataclass
class RebalanceInput:
    scores: pd.Series                       # ticker -> composite score, any order
    candidates: dict[str, Candidate]
    positions: dict[str, Position]
    equity: float
    mode: str = "normal"                    # from risk.trading_mode
    regime_ok: bool = True                  # index above its 200DMA
    thesis_broken: set[str] = field(default_factory=set)


def propose_rebalance(inp: RebalanceInput, cfg: RiskConfig, *, top_n: int = 10,
                      exit_rank_mult: float = 2.0, time_stop_days: int = 60) -> list[Proposal]:
    ranked = list(inp.scores.sort_values(ascending=False).index)
    rank = {t: i + 1 for i, t in enumerate(ranked)}
    out: list[Proposal] = []

    # --- exits first ---
    remaining: dict[str, Position] = {}
    for t, p in inp.positions.items():
        c = inp.candidates.get(t)
        reason = None
        if t in inp.thesis_broken:
            reason = "thesis broken (material negative event)"
        elif c and c.price <= stop_price(p.entry_price, p.highest_close, c.atr, cfg):
            reason = "stop hit"
        elif rank.get(t, 10**9) > top_n * exit_rank_mult:
            reason = f"rank {rank.get(t, 'n/a')} > {int(top_n * exit_rank_mult)}"
        elif p.days_held >= time_stop_days and c and c.price <= p.entry_price:
            reason = f"time stop ({p.days_held}d without profit)"
        elif inp.mode == "reduce":
            reason = "drawdown limit: reduce exposure"
        if reason:
            out.append(Proposal("sell", t, p.shares, reason))
        else:
            remaining[t] = p

    # --- entries ---
    if inp.mode != "normal" or not inp.regime_ok:
        return out
    sector_value: dict[str, float] = {}
    for t, p in remaining.items():
        px = inp.candidates[t].price if t in inp.candidates else p.entry_price
        sector_value[p.sector] = sector_value.get(p.sector, 0.0) + p.shares * px
    slots = cfg.max_positions - len(remaining)
    for t in ranked[:top_n]:
        if slots <= 0:
            break
        c = inp.candidates.get(t)
        if t in remaining or c is None or not c.trend_ok or c.blocked_reason:
            continue
        shares = position_size(inp.equity, c.price, c.atr, cfg)
        value = shares * c.price
        if shares == 0:
            continue
        if (sector_value.get(c.sector, 0.0) + value) / inp.equity > cfg.max_sector_weight:
            continue
        sector_value[c.sector] = sector_value.get(c.sector, 0.0) + value
        slots -= 1
        out.append(Proposal("buy", t, shares, f"rank {rank[t]}",
                            stop=c.price - cfg.stop_atr_mult * c.atr))
    return out
