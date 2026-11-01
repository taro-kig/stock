import { describe, expect, it } from "vitest";
import { proposeRebalance, type Candidate, type Position, type RebalanceInput } from "../src/strategy/portfolio.ts";
import { positionSize, RiskConfig, tradingMode } from "../src/strategy/risk.ts";
import { compositeScore, rankTickers } from "../src/strategy/scoring.ts";

const opt = { topN: 4, exitRankMult: 2, timeStopDays: 60 };

describe("risk", () => {
  it("sizes by risk, caps by weight and rounds to lots", () => {
    const cfg = RiskConfig.parse({ riskPerTrade: 0.01, stopAtrMult: 2, maxWeight: 0.5, lotSize: 100 });
    expect(positionSize(1_000_000, 3000, 50, cfg)).toBe(100);
    expect(positionSize(1_000_000, 3000, 5, cfg)).toBe(100);
    expect(positionSize(1_000_000, 3000, 0, cfg)).toBe(0);
  });
  it("kill switch by drawdown", () => {
    const cfg = RiskConfig.parse({});
    expect(tradingMode(95, 100, cfg)).toBe("normal");
    expect(tradingMode(84, 100, cfg)).toBe("no_new_entries");
    expect(tradingMode(70, 100, cfg)).toBe("reduce");
  });
});

describe("scoring", () => {
  it("ranks by weighted z-scores", () => {
    const s = compositeScore({ momentum: { A: 0.5, B: 0.1, C: -0.2 }, event: { A: 1, B: 0, C: -1 } }, ["A", "B", "C"]);
    expect(rankTickers(s)).toEqual(["A", "B", "C"]);
  });
});

const cands = (): Record<string, Candidate> =>
  Object.fromEntries(
    ([["A", "auto"], ["B", "auto"], ["C", "tech"], ["D", "bank"]] as const).map(([t, s]) => [t, { ticker: t, price: 1000, atr: 20, sector: s, trendOk: true }]),
  );
const pos = (t: string): Position => ({ ticker: t, shares: 100, entryPrice: 1000, highestClose: 1000, sector: "x", entryDate: "2026-10-01", daysHeld: 5 });
const base = (over: Partial<RebalanceInput> = {}): RebalanceInput => ({
  scores: { A: 3, B: 2, C: 1, D: 0 }, candidates: cands(), positions: {}, equity: 1_000_000, mode: "normal", regimeOk: true, thesisBroken: [], ...over,
});

describe("proposeRebalance", () => {
  it("buys the top and respects the sector cap", () => {
    const cfg = RiskConfig.parse({ maxWeight: 0.2, maxSectorWeight: 0.3, riskPerTrade: 0.05, lotSize: 100 });
    expect(proposeRebalance(base(), cfg, opt).map((p) => p.ticker)).toEqual(["A", "C", "D"]);
  });
  it("sells broken theses and halts entries in a bad regime", () => {
    const props = proposeRebalance(base({ positions: { D: pos("D"), A: pos("A") }, regimeOk: false, thesisBroken: ["D"] }), RiskConfig.parse({}), { ...opt, topN: 2 });
    expect(props.map((p) => [p.action, p.ticker])).toEqual([["sell", "D"]]);
  });
  it("does not buy back a name sold in the same rebalance", () => {
    const cfg = RiskConfig.parse({ riskPerTrade: 0.05 });
    // A is top-ranked but its trailing stop is hit (high 1200, ATR 20 -> stop 1140 > price 1000)
    const props = proposeRebalance(base({ positions: { A: { ...pos("A"), highestClose: 1200 } } }), cfg, { ...opt, topN: 2 });
    expect(props.filter((p) => p.ticker === "A").map((p) => p.action)).toEqual(["sell"]);
    expect(props.find((p) => p.ticker === "A")?.reason).toBe("stop hit");
    expect(props.filter((p) => p.action === "buy").map((p) => p.ticker)).toEqual(["B"]);
  });

  it("only buys eligible tickers and keeps exempted holdings", () => {
    const cfg = RiskConfig.parse({ riskPerTrade: 0.05 });
    const props = proposeRebalance(base({ eligible: ["C"], keep: ["D"], positions: { D: pos("D") } }), cfg, { ...opt, topN: 1 });
    expect(props.map((p) => [p.action, p.ticker])).toEqual([]); // C not in top-1, D kept despite rank 4 > 2
    const props2 = proposeRebalance(base({ eligible: ["C"] }), cfg, { ...opt, topN: 3 });
    expect(props2.map((p) => p.ticker)).toEqual(["C"]);
  });
});
