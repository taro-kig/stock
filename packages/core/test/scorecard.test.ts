import { describe, expect, it } from "vitest";
import type { Prediction } from "../src/eval/predictions.ts";
import { buildScorecard, grade, nonOverlapping, wilsonLower } from "../src/eval/scorecard.ts";
import type { Prices } from "../src/signals/technical.ts";
import { weekdays } from "../src/util/dates.ts";

const days = weekdays("2026-01-05", "2026-04-30");
const series = (f: (i: number) => number) => days.map((date, i) => ({ date, open: f(i), high: f(i), low: f(i), close: f(i), volume: 1 }));
const prices: Prices = { UP: series((i) => 100 * 1.01 ** i), DOWN: series((i) => 100 * 0.99 ** i), FLAT: series(() => 100) };
const pred = (ticker: string, stance: Prediction["stance"], asOf: string, label = "ai"): Prediction => ({ label, asOf, ticker, stance, conviction: 0.6, status: "consensus", runId: "r" });

describe("scorecard", () => {
  it("grades against the equal-weight universe and skips immature predictions", () => {
    const g = grade([pred("UP", "bullish", days[0]!), pred("DOWN", "bullish", days[0]!), pred("UP", "bullish", days.at(-3)!), pred("FLAT", "neutral", days[0]!)], prices, 20);
    expect(g.map((x) => [x.ticker, x.hit])).toEqual([["UP", true], ["DOWN", false]]);
  });

  it("uses non-overlapping windows for significance", () => {
    const g = grade(days.slice(0, 40).map((d) => pred("UP", "bullish", d)), prices, 20);
    expect(g).toHaveLength(40);
    expect(nonOverlapping(g, 20)).toHaveLength(2);
  });

  it("wilson lower bound", () => {
    expect(wilsonLower(0, 0)).toBeNull();
    expect(wilsonLower(60, 100)!).toBeCloseTo(0.502, 2);
  });

  it("promotion needs enough independent evidence and must beat the baseline", () => {
    const ps = days.slice(0, 60).flatMap((d) => [pred("UP", "bullish", d), pred("DOWN", "bearish", d), pred("UP", "neutral", d, "base"), pred("UP", "bullish", d, "base")]);
    const loose = buildScorecard(ps, prices, days.at(-1)!, 20, { minNEff: 4, minWilsonLow: 0.3, baselineLabel: "base" });
    expect(loose.labels["ai"]?.hitRate).toBe(1);
    expect(loose.labels["ai"]?.coverage).toBe(1);
    expect(loose.labels["base"]?.coverage).toBe(0.5);
    expect(loose.labels["ai"]?.promotion.reason).toMatch(/does not beat baseline/); // both 100%: not strictly better
    const strict = buildScorecard(ps, prices, days.at(-1)!, 20, { minNEff: 100, minWilsonLow: 0.5 });
    expect(strict.labels["ai"]?.promotion).toEqual({ eligible: false, reason: "nEff 6 < 100" });
  });
});
