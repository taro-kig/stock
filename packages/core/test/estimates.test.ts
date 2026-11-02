import { describe, expect, it } from "vitest";
import { buildDossier } from "../src/ai/judge.ts";
import { AppConfig } from "../src/config.ts";
import { estimateLines, EstimateStore, parseEarningsEstimates, revisionScore } from "../src/data/estimates.ts";
import { builtinRegistry } from "../src/nodes/index.ts";
import { Services } from "../src/services.ts";
import { openDb } from "../src/util/db.ts";
import { Engine } from "../src/workflow/engine.ts";
import { parseWorkflow } from "../src/workflow/spec.ts";

// The shape described for EARNINGS_ESTIMATES (unverified here: the parser matches field names by pattern).
const AV = {
  symbol: "AAPL",
  estimates: [
    { date: "2026-12-31", horizon: "next fiscal quarter", eps_estimate_average: "2.40", eps_estimate_average_7_days_ago: "2.38", eps_estimate_average_30_days_ago: "2.30", eps_estimate_average_60_days_ago: "2.28", eps_estimate_average_90_days_ago: "2.25", eps_estimate_revision_up_trailing_7_days: "2", eps_estimate_revision_down_trailing_7_days: "0", eps_estimate_revision_up_trailing_30_days: "9", eps_estimate_revision_down_trailing_30_days: "1", eps_estimate_analyst_count: "28" },
    { date: "2027-03-31", horizon: "next fiscal quarter", eps_estimate_average: "1.90" },
    { date: "2027-09-30", horizon: "next fiscal year", eps_estimate_average: "8.00", eps_estimate_average_30_days_ago: "8.10", eps_estimate_average_90_days_ago: "None" },
    { date: "2026-09-30", horizon: "historical fiscal quarter", eps_estimate_average: "1.80" },
  ],
};

describe("analyst estimate revisions", () => {
  it("reads EARNINGS_ESTIMATES leniently and keeps the nearest period of each horizon", () => {
    const s = parseEarningsEstimates(AV);
    expect(s).toEqual([
      { horizon: "quarter", period: "2026-12-31", average: 2.4, ago: { 7: 2.38, 30: 2.3, 60: 2.28, 90: 2.25 }, up: 9, down: 1, analysts: 28 },
      { horizon: "year", period: "2027-09-30", average: 8, ago: { 30: 8.1 }, up: null, down: null, analysts: null },
    ]);
    expect(() => parseEarningsEstimates({ Information: "Thank you for using Alpha Vantage! This is a premium endpoint." })).toThrow(/premium/);
    expect(parseEarningsEstimates({ unexpected: true })).toEqual([]);
  });

  it("computes revisions from the API snapshot, or from our own daily calendar record", () => {
    const st = new EstimateStore(openDb(":memory:"));
    st.save("AAPL", "2026-11-01", parseEarningsEstimates(AV));
    const api = st.at(["AAPL"], "2026-11-02")["AAPL"]!;
    expect(api[0]).toMatchObject({ horizon: "quarter", source: "api", current: 2.4, base30: 2.3, up: 9, down: 1 });
    expect(api[0]!.change30).toBeCloseTo(0.1 / 2.3, 6);
    expect(api[1]!.change30).toBeCloseTo(-0.1 / 8.1, 6);
    expect(revisionScore(api)).toBeCloseTo(-0.1 / 8.1, 6); // the year first
    expect(st.at(["AAPL"], "2026-10-31")).toEqual({}); // not fetched yet on that day
    expect(st.at(["AAPL"], "2026-12-15")).toEqual({}); // too old to use

    // own record: MSFT's next report consensus seen daily
    st.saveCalendar("2026-09-20", [{ ticker: "MSFT", reportDate: "2026-11-20", estimate: 3.0 }]);
    st.saveCalendar("2026-10-01", [{ ticker: "MSFT", reportDate: "2026-11-20", estimate: 3.1 }]);
    st.saveCalendar("2026-11-01", [{ ticker: "MSFT", reportDate: "2026-11-20", estimate: 3.3 }]);
    const own = st.at(["MSFT"], "2026-11-02")["MSFT"]!;
    expect(own).toEqual([expect.objectContaining({ horizon: "quarter", source: "calendar", period: "2026-11-20", current: 3.3, base30: 3.1, base90: null })]);
    expect(own[0]!.change30).toBeCloseTo(0.2 / 3.1, 6);
    expect(st.at(["MSFT"], "2026-10-02")["MSFT"]![0]!.base30).toBeNull(); // the record was too short then
    expect(estimateLines(own)).toEqual([
      "## アナリスト予想の修正（データ。変化率はプログラムで計算）",
      "次の決算（2026-11-20 発表予定） EPS 予想 3.30（30日前 3.10 → +6.5%）",
    ]);
    expect(estimateLines(api)[1]).toBe("次の四半期（2026-12 期） EPS 予想 2.40（30日前 2.30 → +4.3%、90日前 2.25 → +6.7%）。修正 上方 9 件 / 下方 1 件（アナリスト 28 人）");
  });

  it("the node falls back to our own record when the key cannot use the endpoint, and the score uses revisions", async () => {
    const calls: string[] = [];
    const s = new Services(AppConfig.parse({ market: { currency: "USD", benchmark: "SPY" }, watchlist: { AAA: { name: "A" }, BBB: { name: "B" } } }), {
      fake: true, dbPath: ":memory:", env: { ALPHAVANTAGE_API_KEY: "k" },
      fetchImpl: async (u) => {
        calls.push(new URL(String(u)).searchParams.get("function")!);
        return new Response(JSON.stringify({ Information: "This is a premium endpoint." }));
      },
    });
    s.estimates.saveCalendar("2026-10-01", [{ ticker: "AAA", reportDate: "2026-11-20", estimate: 1.0 }, { ticker: "BBB", reportDate: "2026-11-25", estimate: 1.0 }]);
    s.estimates.saveCalendar("2026-11-01", [{ ticker: "AAA", reportDate: "2026-11-20", estimate: 1.2 }, { ticker: "BBB", reportDate: "2026-11-25", estimate: 0.9 }]);
    const engine = new Engine({ services: s, registry: builtinRegistry(), store: s.runStore, clock: () => new Date("2026-11-02T22:00:00Z") });
    const r = await engine.run(parseWorkflow(`name: e
nodes:
  prices: { use: data.pricesSynthetic, params: { seed: 1 } }
  factors: { use: signal.factors, in: { prices: prices } }
  est: { use: data.estimates }
  score: { use: signal.score, in: { factors: factors, estimates: est }, params: { weights: { revision: 1 } } }
  decide: { use: decide.ai, in: { factors: factors, scores: score, estimates: est } }
`), { asOf: "2026-11-02" });
    expect(r.status).toBe("succeeded");
    expect(calls).toEqual(["EARNINGS_ESTIMATES"]); // stops after the first "premium" answer
    const scores = r.output<Record<string, number>>("score", "scores");
    expect(scores["AAA"]!).toBeGreaterThan(scores["BBB"]!);
    const d = r.output<Record<string, { dossier: string }>>("decide", "judgments")["AAA"]!.dossier;
    expect(d).toContain("次の決算（2026-11-20 発表予定） EPS 予想 1.20（30日前 1.00 → +20.0%）");
  });

  it("is left out of the fact sheet when not connected", () => {
    const row = { ticker: "X", name: "X", sector: "t", close: 50, atr: 1, momentum: 0.1, relStrength: 0, vol: 0.2, trend: "up" as const, lastDate: "2026-11-02", ret20: 0, fromHigh52: 0 };
    expect(buildDossier({ row, asOf: "2026-11-02", rank: 1, universe: 2, events: [] }).text).not.toContain("アナリスト予想");
    expect(buildDossier({ row, asOf: "2026-11-02", rank: 1, universe: 2, events: [], estimates: [] }).text).toContain("(データなし)");
  });
});
