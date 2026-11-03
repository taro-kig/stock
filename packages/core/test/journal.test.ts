import { describe, expect, it } from "vitest";
import { buildTrades, summarize } from "../src/eval/journal.ts";
import type { Prediction } from "../src/eval/predictions.ts";
import type { Fill } from "../src/execution/paper.ts";

const f = (asOf: string, side: "buy" | "sell", shares: number, price: number, reason: string, ticker = "A"): Fill => ({ runId: "r", account: "acc", asOf, ticker, side, shares, price, fee: 1, reason });

describe("trade journal", () => {
  it("groups fills into trades from the first buy until back to zero, with the entry judgment", () => {
    const fills = [
      f("2026-01-05", "buy", 100, 10, "rank 1"),
      f("2026-01-20", "buy", 50, 13, "rank 2"),           // add
      f("2026-02-10", "sell", 150, 12, "stop hit"),        // closes the first trade
      f("2026-03-01", "buy", 10, 20, "rank 1"),            // a second, still open
      f("2026-03-01", "buy", 5, 50, "rank 3", "B"),
      f("2026-03-10", "sell", 5, 40, "thesis broken", "B"),
    ];
    const preds: Prediction[] = [{ label: "acc", asOf: "2026-01-05", ticker: "A", stance: "bullish", conviction: 0.8, status: "consensus", runId: "r", thesis: "上昇トレンド" }];
    const trades = buildTrades(fills, preds, { lastClose: (t) => ({ close: t === "A" ? 25 : 40, date: "2026-03-20" }), today: "2026-11-01" });
    const a1 = trades.find((t) => t.ticker === "A" && !t.open)!;
    expect(a1).toMatchObject({ entryDate: "2026-01-05", exitDate: "2026-02-10", shares: 150, avgEntry: 11, avgExit: 12, fees: 3, daysHeld: 36, entryReason: "rank 1", exitReason: "stop hit" });
    expect(a1.pnl).toBeCloseTo(150 * (12 - 11) - 3, 9);
    expect(a1.entryJudgment).toEqual({ label: "acc", stance: "bullish", conviction: 0.8, thesis: "上昇トレンド" });
    const a2 = trades.find((t) => t.ticker === "A" && t.open)!;
    expect(a2).toMatchObject({ openShares: 10, avgEntry: 20, exitDate: null, daysHeld: 19 });
    expect(a2.pnl).toBeCloseTo(10 * (25 - 20) - 1, 9); // unrealized at the last close, after the fee
    const b = trades.find((t) => t.ticker === "B")!;
    expect(b.pnl).toBeCloseTo(5 * (40 - 50) - 2, 9);
    const s = summarize(trades);
    expect(s).toMatchObject({ closed: 2, open: 1, winRate: 0.5 });
    expect(s.profitFactor).toBeCloseTo(147 / 52, 9);
    expect(s.realized).toBeCloseTo(147 - 52, 9);
  });
});
