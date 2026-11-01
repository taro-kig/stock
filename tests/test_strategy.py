import pandas as pd

from stockai.strategy.portfolio import Candidate, Position, RebalanceInput, propose_rebalance
from stockai.strategy.risk import RiskConfig, position_size, trading_mode
from stockai.strategy.scoring import composite_score


def test_position_size_risk_and_lot():
    cfg = RiskConfig(risk_per_trade=0.01, stop_atr_mult=2.0, max_weight=0.5, lot_size=100)
    # risk 10,000 / (2*50) = 100 shares
    assert position_size(1_000_000, 3000, 50, cfg) == 100
    # capped by weight: 0.5*1e6/3000 = 166 -> 100 after lot rounding
    assert position_size(1_000_000, 3000, 5, cfg) == 100
    assert position_size(1_000_000, 3000, 0, cfg) == 0


def test_trading_mode_kill_switch():
    cfg = RiskConfig()
    assert trading_mode(95, 100, cfg) == "normal"
    assert trading_mode(84, 100, cfg) == "no_new_entries"
    assert trading_mode(70, 100, cfg) == "reduce"


def test_composite_score_ranks():
    f = pd.DataFrame({"momentum": [0.5, 0.1, -0.2], "event": [1.0, 0.0, -1.0]}, index=["A", "B", "C"])
    assert list(composite_score(f).index) == ["A", "B", "C"]


def _cands():
    return {t: Candidate(t, price=1000, atr=20, sector=s) for t, s in
            [("A", "auto"), ("B", "auto"), ("C", "tech"), ("D", "bank")]}


def test_rebalance_buys_top_and_respects_sector_cap():
    cfg = RiskConfig(max_weight=0.2, max_sector_weight=0.3, risk_per_trade=0.05, lot_size=100)
    inp = RebalanceInput(pd.Series({"A": 3, "B": 2, "C": 1, "D": 0}), _cands(), {}, equity=1_000_000)
    buys = [p.ticker for p in propose_rebalance(inp, cfg, top_n=4) if p.action == "buy"]
    assert buys == ["A", "C", "D"]  # B blocked: auto sector would exceed 30%


def test_rebalance_exits_and_halts_entries_in_bad_regime():
    cfg = RiskConfig()
    pos = {"D": Position("D", 100, entry_price=1000, highest_close=1000),
           "A": Position("A", 100, entry_price=1000, highest_close=1000)}
    inp = RebalanceInput(pd.Series({"A": 3, "B": 2, "C": 1, "D": 0}), _cands(), pos,
                         equity=1_000_000, regime_ok=False, thesis_broken={"D"})
    props = propose_rebalance(inp, cfg, top_n=2)
    assert [(p.action, p.ticker) for p in props] == [("sell", "D")]
