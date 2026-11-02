import { describe, expect, it } from "vitest";
import { buildDossier, type Judgment } from "../src/ai/judge.ts";
import { AppConfig } from "../src/config.ts";
import { fundamentalLines, fundamentalsAt, needsFundamentals, parseCompanyFacts, quarters, valuation } from "../src/data/fundamentals.ts";
import { builtinRegistry } from "../src/nodes/index.ts";
import { Services } from "../src/services.ts";
import { addDays } from "../src/util/dates.ts";
import { Engine } from "../src/workflow/engine.ts";
import { parseWorkflow } from "../src/workflow/spec.ts";

// Calendar fiscal years 2024–2026. Quarter q of year y: revenue 100 + 10·(y−2024) + q, EPS = revenue / 100.
const QE = ["03-31", "06-30", "09-30", "12-31"];
const QS = ["01-01", "04-01", "07-01", "10-01"];
const rev = (y: number, q: number) => 100 + 10 * (y - 2024) + q;
function companyFacts() {
  const revenue: object[] = [];
  const oldRevenue: object[] = [];
  const eps: object[] = [];
  const opInc: object[] = [];
  const gp: object[] = [];
  for (const y of [2024, 2025, 2026]) {
    for (let q = 1; q <= 3; q++) {
      if (y === 2026 && q === 3) continue; // not filed in this file version; added below
      const end = `${y}-${QE[q - 1]}`;
      const base = { start: `${y}-${QS[q - 1]}`, end, form: "10-Q", filed: addDays(end, 30) };
      (y === 2024 ? oldRevenue : revenue).push({ ...base, val: rev(y, q) * 1e6 });
      eps.push({ ...base, val: rev(y, q) / 100 });
      opInc.push({ ...base, val: rev(y, q) * 0.2e6 });
      gp.push({ ...base, val: rev(y, q) * 0.5e6 });
      if (q === 2) revenue.push({ start: `${y}-01-01`, end, form: "10-Q", filed: addDays(end, 30), val: (rev(y, 1) + rev(y, 2)) * 1e6 }); // YTD: ignored
    }
    if (y === 2026) continue;
    const end = `${y}-12-31`;
    const total = [1, 2, 3, 4].reduce((s, q) => s + rev(y, q), 0);
    const base = { start: `${y}-01-01`, end, form: "10-K", filed: addDays(end, 50) };
    (y === 2024 ? oldRevenue : revenue).push({ ...base, val: total * 1e6 });
    eps.push({ ...base, val: total / 100 });
    opInc.push({ ...base, val: total * 0.2e6 });
    gp.push({ ...base, val: total * 0.5e6 });
  }
  // Q3 2026 filed 2026-10-30, and a restatement of Q2 2026 revenue filed with it
  revenue.push({ start: "2026-07-01", end: "2026-09-30", form: "10-Q", filed: "2026-10-30", val: rev(2026, 3) * 1e6 });
  eps.push({ start: "2026-07-01", end: "2026-09-30", form: "10-Q", filed: "2026-10-30", val: rev(2026, 3) / 100 });
  opInc.push({ start: "2026-07-01", end: "2026-09-30", form: "10-Q", filed: "2026-10-30", val: rev(2026, 3) * 0.25e6 }); // margin improved
  gp.push({ start: "2026-07-01", end: "2026-09-30", form: "10-Q", filed: "2026-10-30", val: rev(2026, 3) * 0.5e6 });
  revenue.push({ start: "2026-04-01", end: "2026-06-30", form: "10-Q", filed: "2026-10-30", val: 999e6 });
  revenue.push({ start: "2026-07-01", end: "2026-09-30", form: "8-K", filed: "2026-10-25", val: 1 }); // not a 10-Q/10-K: ignored
  return {
    cik: 1, entityName: "Example",
    facts: {
      "us-gaap": {
        RevenueFromContractWithCustomerExcludingAssessedTax: { units: { USD: revenue } },
        SalesRevenueNet: { units: { USD: oldRevenue } }, // older concept: the newest-period concept wins
        EarningsPerShareDiluted: { units: { "USD/shares": eps } },
        OperatingIncomeLoss: { units: { USD: opInc } },
        GrossProfit: { units: { USD: gp } },
      },
      dei: { EntityCommonStockSharesOutstanding: { units: { shares: [{ end: "2026-07-20", val: 2e6, form: "10-Q", filed: "2026-07-30" }, { end: "2026-10-20", val: 1.9e6, form: "10-Q", filed: "2026-10-30" }] } } },
    },
  };
}

describe("SEC financials", () => {
  const facts = parseCompanyFacts(companyFacts());

  it("rebuilds quarters (Q4 = year − Q1..Q3) and ignores year-to-date figures", () => {
    const qs = quarters(facts, "revenue", "2026-11-02");
    // 2024 comes from the older concept (SalesRevenueNet), 2025 on from the current one
    expect(qs.map((q) => q.end)).toEqual([
      "2024-03-31", "2024-06-30", "2024-09-30", "2024-12-31", "2025-03-31", "2025-06-30", "2025-09-30", "2025-12-31", "2026-03-31", "2026-06-30", "2026-09-30",
    ]);
    expect(qs.find((q) => q.end === "2024-12-31")).toMatchObject({ val: 104e6, derived: true });
    expect(qs.find((q) => q.end === "2025-12-31")).toMatchObject({ val: 114e6, derived: true });
  });

  it("computes growth, margins and valuation from what was filed by the run date", () => {
    const f = fundamentalsAt("X", facts, "2026-11-02")!;
    expect(f.periodEnd).toBe("2026-09-30");
    expect(f.filed).toBe("2026-10-30");
    // the Q2 2026 restatement (999) was filed with Q3, so it counts now
    expect(f.revenueTtm).toBe((114 + 121 + 999 + 123) * 1e6);
    expect(f.revenueQYoY).toBeCloseTo(123 / 113 - 1, 6);
    expect(f.epsQYoY).toBeCloseTo(123 / 113 - 1, 6);
    expect(f.operatingMargin).toBeCloseTo((0.2 * (114 + 121 + 122) + 0.25 * 123) / (114 + 121 + 999 + 123), 6);
    expect(f.shares).toBe(1.9e6);
    const v = valuation(f, 50);
    expect(v.marketCap).toBe(95e6);
    expect(v.pe).toBeCloseTo(50 / ((114 + 121 + 122 + 123) / 100), 6);
  });

  it("does not see a filing before its date", () => {
    const f = fundamentalsAt("X", facts, "2026-10-29")!;
    expect(f.periodEnd).toBe("2026-06-30");
    expect(f.revenueTtm).toBe((113 + 114 + 121 + 122) * 1e6); // no restatement yet
    expect(f.revenueTtmYoY).toBeCloseTo((113 + 114 + 121 + 122) / (103 + 104 + 111 + 112) - 1, 6);
    expect(f.shares).toBe(2e6);
    expect(fundamentalsAt("X", facts, "2024-01-01")).toBeNull();
  });

  it("writes plain lines for the fact sheet", () => {
    const f = fundamentalsAt("X", facts, "2026-10-29")!;
    const lines = fundamentalLines(f, 50, "2026-10-29");
    expect(lines[0]).toBe("## 業績（SEC 提出データ。数字はプログラムで計算）");
    expect(lines[1]).toBe("直近の四半期: 2026-06 期（2026-07-30 提出）");
    expect(lines[2]).toBe("売上高: 直近4四半期 470.0M ドル（前年比 +9.3%）、直近四半期の前年同期比 +8.9%");
    expect(lines[4]).toBe("営業利益率: 20.0%（1年前 20.0%）、粗利率: 50.0%（1年前 50.0%）");
    expect(lines[5]).toMatch(/^PER 10\.6 倍、PSR 0\.2 倍（時価総額 100\.0M ドル）$/);
    expect(fundamentalLines(f, 50, "2027-06-01")[1]).toMatch(/古い/);
    expect(fundamentalLines(undefined, 50, "2026-10-29")).toEqual(["## 業績（SEC 提出データ）", "(データなし)"]);
  });

  it("downloads weekly, or daily after a report until the 10-Q is in", () => {
    const o = { lastFetch: "2026-10-28", latestFiled: "2026-07-30", recentReportDates: ["2026-10-29"], today: "2026-10-31", refreshDays: 7 };
    expect(needsFundamentals({ ...o, lastFetch: null })).toBe(true);
    expect(needsFundamentals(o)).toBe(true); // reported 10-29, 10-Q not in yet
    expect(needsFundamentals({ ...o, latestFiled: "2026-10-30" })).toBe(false);
    expect(needsFundamentals({ ...o, lastFetch: "2026-10-31" })).toBe(false);
    expect(needsFundamentals({ ...o, recentReportDates: [], lastFetch: "2026-10-20" })).toBe(true); // weekly
  });

  it("the node downloads, scores quality and growth, and the AI reads the section", async () => {
    const urls: string[] = [];
    const s = new Services(AppConfig.parse({ market: { currency: "USD", benchmark: "SPY" }, watchlist: { AAA: { name: "A" }, BBB: { name: "B" } } }), {
      fake: true, dbPath: ":memory:", env: { SEC_USER_AGENT: "stockai test@example.com" }, sleep: async () => undefined,
      fetchImpl: async (u) => {
        const url = String(u);
        urls.push(url);
        if (url.endsWith("company_tickers.json")) return new Response(JSON.stringify({ 0: { cik_str: 1, ticker: "AAA" }, 1: { cik_str: 2, ticker: "BBB" }, 2: { cik_str: 3, ticker: "SPY" } }));
        const body = companyFacts();
        if (url.includes("CIK0000000002")) body.facts["us-gaap"].OperatingIncomeLoss.units.USD = body.facts["us-gaap"].OperatingIncomeLoss.units.USD.map((r) => ({ ...(r as object), val: 1 }));
        return new Response(JSON.stringify(body));
      },
    });
    const engine = new Engine({ services: s, registry: builtinRegistry(), store: s.runStore, clock: () => new Date("2026-11-02T22:00:00Z") });
    const spec = parseWorkflow(`name: f
nodes:
  prices: { use: data.pricesSynthetic, params: { seed: 1 } }
  factors: { use: signal.factors, in: { prices: prices } }
  fin: { use: data.fundamentals }
  score: { use: signal.score, in: { factors: factors, fundamentals: fin } }
  decide: { use: decide.ai, in: { factors: factors, scores: score, fundamentals: fin } }
`);
    const r = await engine.run(spec, { asOf: "2026-11-02" });
    expect(r.status).toBe("succeeded");
    expect(urls.filter((u) => u.includes("companyfacts"))).toEqual([
      "https://data.sec.gov/api/xbrl/companyfacts/CIK0000000001.json", "https://data.sec.gov/api/xbrl/companyfacts/CIK0000000002.json",
    ]); // never the benchmark
    const fin = r.output<Record<string, { operatingMargin: number }>>("fin", "fundamentals");
    expect(fin["AAA"]!.operatingMargin).toBeGreaterThan(fin["BBB"]!.operatingMargin);
    const js = r.output<Record<string, Judgment>>("decide", "judgments");
    expect(js["AAA"]!.dossier).toContain("## 業績（SEC 提出データ。数字はプログラムで計算）");
    await engine.run(parseWorkflow("name: g\nnodes:\n  fin: { use: data.fundamentals }\n"), { asOf: "2026-11-02" });
    expect(urls.filter((u) => u.includes("companyfacts"))).toHaveLength(2); // once a day
  });

  it("is left out of the fact sheet when not connected", () => {
    const row = { ticker: "X", name: "X", sector: "t", close: 50, atr: 1, momentum: 0.1, relStrength: 0, vol: 0.2, trend: "up" as const, lastDate: "2026-11-02", ret20: 0, fromHigh52: 0 };
    expect(buildDossier({ row, asOf: "2026-11-02", rank: 1, universe: 2, events: [] }).text).not.toContain("業績");
    expect(buildDossier({ row, asOf: "2026-11-02", rank: 1, universe: 2, events: [], fundamentals: null }).text).toContain("(データなし)");
  });
});
