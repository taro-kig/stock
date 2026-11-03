import { describe, expect, it } from "vitest";
import { sueOf } from "../src/data/fundamentals.ts";
import type { Bar, Prices } from "../src/signals/technical.ts";
import { factorColumns } from "../src/strategy/factorLib.ts";
import { researchFactors, spearman } from "../src/strategy/factorResearch.ts";
import { compositeScore, normalize, ranks } from "../src/strategy/scoring.ts";
import { weekdays } from "../src/util/dates.ts";

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const days = weekdays("2023-01-02", "2026-10-30");

/** 40 stocks, each with its own persistent drift (so past winners keep winning), plus noise. */
function market(): { prices: Prices; universe: Record<string, string> } {
  const r = rng(7);
  const prices: Prices = {};
  const universe: Record<string, string> = {};
  for (let k = 0; k < 40; k++) {
    const t = `S${k}`;
    const drift = (k - 20) * 0.00012;
    let p = 100;
    const bars: Bar[] = [];
    for (const date of days) {
      p *= 1 + drift + (r() - 0.5) * 0.02;
      bars.push({ date, open: p, high: p, low: p, close: p, volume: 1e6 });
    }
    prices[t] = bars;
    universe[t] = k % 2 ? "tech" : "energy";
  }
  prices["SPY"] = days.map((date) => ({ date, open: 100, high: 100, low: 100, close: 100, volume: 1 }));
  return { prices, universe };
}

describe("factor research", () => {
  it("rank tools", () => {
    expect(ranks({ a: 3, b: 1, c: 3, d: null })).toEqual({ a: 2.5, b: 1, c: 2.5, d: null });
    expect(spearman({ a: 1, b: 2, c: 3 }, { a: 10, b: 20, c: 30 }, 3)).toBeCloseTo(1, 9);
    expect(spearman({ a: 1, b: 2, c: 3 }, { a: 30, b: 20, c: 10 }, 3)).toBeCloseTo(-1, 9);
    expect(spearman({ a: 1, b: 2 }, { a: 1, b: 2 }, 3)).toBeNull();
    // sector-neutral: each sector compared with itself
    const z = normalize({ a: 1, b: 2, c: 3, x: 101, y: 102, z: 103 }, { sectorOf: { a: "s1", b: "s1", c: "s1", x: "s2", y: "s2", z: "s2" } });
    expect(z["a"]).toBeCloseTo(z["x"]!, 9);
    // rank normalization: an outlier cannot dominate
    const plain = compositeScore({ f: { a: 1, b: 2, c: 1000 } }, ["a", "b", "c"], { f: 1 });
    const ranked = compositeScore({ f: { a: 1, b: 2, c: 1000 } }, ["a", "b", "c"], { f: 1 }, { method: "rank" });
    expect(ranked["b"]! - ranked["a"]!).toBeGreaterThan(plain["b"]! - plain["a"]!);
  });

  it("SUE: this quarter's year-over-year change in units of its usual size", () => {
    const q = (end: string, val: number) => ({ end, val });
    const eps = [q("2024-03-31", 1), q("2024-06-30", 1), q("2024-09-30", 1), q("2024-12-31", 1),
      q("2025-03-31", 1.1), q("2025-06-30", 1.05), q("2025-09-30", 1.12), q("2025-12-31", 1.08), q("2026-03-31", 1.6)];
    expect(sueOf(eps.slice(0, 8))).toBeNull(); // only 4 changes
    const s = sueOf(eps)!;
    expect(s).toBeGreaterThan(5); // +0.5 vs changes of about ±0.03
  });

  it("finds a planted signal: momentum predicts, short-term reversal does not here", () => {
    const { prices, universe } = market();
    const rep = researchFactors({ asOf: "2026-10-30", prices, universe, benchmark: "SPY", horizon: 20, step: 5, lookbackDays: 500, minStocks: 15 });
    const by = Object.fromEntries(rep.factors.map((f) => [f.factor, f]));
    expect(rep.universe).toBe(40);
    expect(by["momentum"]!.meanIC!).toBeGreaterThan(0.15);
    expect(by["momentum"]!.t!).toBeGreaterThan(2);
    expect(by["momentum"]!.spread!).toBeGreaterThan(0);
    expect(by["reversal"]!.meanIC!).toBeLessThan(0); // with persistent drift, last month's winners keep winning
    expect(by["quality"]).toBeUndefined(); // no financials given
    expect(rep.notes.join()).toMatch(/財務データ/);
    expect(rep.composite.map((c) => c.factor)).toEqual(["__composite", "__composite_sector", "__composite_rank"]);
    expect(rep.composite[0]!.meanIC!).toBeGreaterThan(0.05);
    // suggested weights lean toward what worked, never toward a negative IC
    expect(rep.suggested["reversal"] ?? 0).toBe(0);
    expect(rep.suggested["momentum"]!).toBeGreaterThan(0);
    // on the same scale as the current weights: a factor that did not work is pulled down, not up
    const w = researchFactors({ asOf: "2026-10-30", prices, universe, benchmark: "SPY", lookbackDays: 500, weights: { momentum: 0.35, reversal: 0.3 } });
    expect(w.suggested["reversal"] ?? 0).toBeLessThan(0.3);
    const total = Object.values(w.suggested).reduce((x, y) => x + y, 0);
    expect(total).toBeCloseTo(0.65, 1); // same total as the current weights
    expect(total - (w.suggested["reversal"] ?? 0)).toBeGreaterThan(0.35); // moved to the factors that worked
    // point in time: nothing after the run date is used
    const early = researchFactors({ asOf: "2025-06-30", prices, universe, benchmark: "SPY", lookbackDays: 365 });
    expect(early.to! <= "2025-06-30").toBe(true);
  });

  it("the same factor library feeds the daily score", () => {
    const rows = [
      { ticker: "A", name: "A", sector: "tech", lastDate: "2026-10-30", close: 10, atr: 1, momentum: 0.1, relStrength: 0, vol: 0.2, trend: "up" as const, ret20: 0.05, fromHigh52: -0.1 },
      { ticker: "B", name: "B", sector: "tech", lastDate: "2026-10-30", close: 10, atr: 1, momentum: 0.2, relStrength: 0, vol: 0.4, trend: "up" as const, ret20: -0.02, fromHigh52: 0 },
    ];
    const cols = factorColumns({ asOf: "2026-10-30", rows });
    expect(cols["high52"]).toEqual({ A: 0.9, B: 1 });
    expect(cols["lowvol"]).toEqual({ A: -0.2, B: -0.4 });
    expect(cols["reversal"]).toEqual({ A: -0.05, B: 0.02 });
    expect(cols["quality"]).toBeUndefined();
  });
});
