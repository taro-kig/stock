"""H5: cost accounting and a hard daily budget cap."""
from __future__ import annotations

import datetime as dt
import sqlite3
import threading

from ..llm.base import LLMResponse

# Used when a model is missing from the pricing table: deliberately pessimistic
# so a config mistake makes us stop early rather than overspend silently.
FALLBACK_PRICE_PER_M = (2.0, 10.0)


class BudgetExceeded(RuntimeError):
    pass


class CostTracker:
    def __init__(self, pricing: dict[str, tuple[float, float]] | None = None,
                 daily_limit_usd: float = 1.0, db_path: str = ":memory:"):
        """pricing: model id -> (USD per 1M input tokens, USD per 1M output tokens)."""
        self.pricing = {k: tuple(v) for k, v in (pricing or {}).items()}
        self.daily_limit_usd = daily_limit_usd
        self._lock = threading.Lock()
        self._db = sqlite3.connect(db_path, check_same_thread=False)
        self._db.execute(
            "CREATE TABLE IF NOT EXISTS llm_calls (ts TEXT, day TEXT, provider TEXT, model TEXT,"
            " input_tokens INT, output_tokens INT, cost_usd REAL, latency_s REAL, cached INT)")
        self._db.commit()

    def cost_of(self, model: str, input_tokens: int, output_tokens: int) -> float:
        p_in, p_out = self.pricing.get(model, FALLBACK_PRICE_PER_M)
        return (input_tokens * p_in + output_tokens * p_out) / 1_000_000

    @staticmethod
    def _today() -> str:
        return dt.date.today().isoformat()

    def spent_today(self) -> float:
        row = self._db.execute("SELECT COALESCE(SUM(cost_usd), 0) FROM llm_calls WHERE day = ?",
                               (self._today(),)).fetchone()
        return float(row[0])

    def check(self) -> None:
        spent = self.spent_today()
        if spent >= self.daily_limit_usd:
            raise BudgetExceeded(f"daily LLM budget reached: ${spent:.4f} >= ${self.daily_limit_usd}")

    def record(self, provider: str, resp: LLMResponse, *, cached: bool = False) -> float:
        cost = 0.0 if cached else self.cost_of(resp.model, resp.input_tokens, resp.output_tokens)
        with self._lock:
            self._db.execute("INSERT INTO llm_calls VALUES (?,?,?,?,?,?,?,?,?)",
                             (dt.datetime.now().isoformat(timespec="seconds"), self._today(),
                              provider, resp.model, resp.input_tokens, resp.output_tokens,
                              cost, resp.latency_s, int(cached)))
            self._db.commit()
        return cost

    def summary_today(self) -> list[dict]:
        rows = self._db.execute(
            "SELECT provider, COUNT(*), SUM(cached), SUM(input_tokens), SUM(output_tokens), SUM(cost_usd)"
            " FROM llm_calls WHERE day = ? GROUP BY provider", (self._today(),)).fetchall()
        keys = ("provider", "calls", "cache_hits", "input_tokens", "output_tokens", "cost_usd")
        return [dict(zip(keys, r)) for r in rows]
