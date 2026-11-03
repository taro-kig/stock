import { describe, expect, it } from "vitest";
import { AppConfig } from "../src/config.ts";
import { Services } from "../src/services.ts";
import { frameYears, screenStocks } from "../src/universe/screen.ts";
import { weekdays } from "../src/util/dates.ts";

const days = weekdays("2025-06-02", "2026-11-02");

// ticker, cik, float, sic, revenue last year, revenue the year before, operating income, daily volume, price trend
const COS = [
  ["GROW", 1, 1.2e9, 7372, 150, 100, 30, 1_000_000, 1.002],   // small software, +50%, 20% margin, rising
  ["SLOW", 2, 1.5e9, 7372, 101, 100, 5, 1_000_000, 1.0],      // small, +1%
  ["THIN", 3, 0.9e9, 7372, 200, 100, 50, 1_000, 1.002],       // small, great numbers, barely trades
  ["PENNY", 4, 0.5e9, 7372, 200, 100, 40, 5_000_000, 1.0],    // small, price $2
  ["BANK", 5, 5e9, 6022, 130, 100, 30, 1_000_000, 1.001],     // mid bank
  ["BIGCO", 6, 50e9, 7372, 130, 100, 30, 1_000_000, 1.001],   // large
  ["HAVE", 7, 1.1e9, 7372, 150, 100, 30, 1_000_000, 1.002],   // already watched
] as const;

function setup() {
  const urls: string[] = [];
  const s = new Services(AppConfig.parse({ market: { currency: "USD", benchmark: "SPY" }, watchlist: { HAVE: { name: "Have" } } }), {
    fake: true, dbPath: ":memory:", env: { SEC_USER_AGENT: "stockai test@example.com", TWELVEDATA_API_KEY: "k" }, sleep: async () => undefined,
    fetchImpl: async (u) => {
      const url = String(u);
      urls.push(url);
      const json = (b: unknown) => new Response(JSON.stringify(b));
      if (url.endsWith("company_tickers_exchange.json")) return json({ fields: ["cik", "name", "ticker", "exchange"], data: COS.map(([t, cik]) => [cik, `${t} Inc`, t, "Nasdaq"]) });
      if (url.includes("/frames/dei/EntityPublicFloat/USD/CY2026Q2I")) return json({ data: COS.map(([, cik, f]) => ({ cik, entityName: "x", end: "2026-06-30", val: f })) });
      const [y1, y0] = frameYears("2026-11-02");
      if (url.includes(`/frames/us-gaap/Revenues/USD/CY${y1}.json`)) return json({ data: COS.map(([, cik, , , r1]) => ({ cik, entityName: "x", end: `${y1}-12-31`, val: r1 * 1e6 })) });
      if (url.includes(`/frames/us-gaap/Revenues/USD/CY${y0}.json`)) return json({ data: COS.map(([, cik, , , , r0]) => ({ cik, entityName: "x", end: `${y0}-12-31`, val: r0 * 1e6 })) });
      if (url.includes(`/frames/us-gaap/OperatingIncomeLoss/USD/CY${y1}.json`)) return json({ data: COS.map(([, cik, , , , , op]) => ({ cik, entityName: "x", end: `${y1}-12-31`, val: op * 1e6 })) });
      if (url.includes("/frames/")) return new Response("not found", { status: 404 });
      const sub = url.match(/submissions\/CIK0*(\d+)\.json/);
      if (sub) return json({ sic: String(COS.find(([, cik]) => cik === Number(sub[1]))![3]) });
      if (url.includes("/companyfacts/")) return json({ facts: {} });
      if (url.startsWith("https://api.twelvedata.com")) {
        const sym = new URL(url).searchParams.get("symbol")!;
        const co = COS.find(([t]) => t === sym)!;
        const base = sym === "PENNY" ? 2 : 50;
        return json({ status: "ok", values: days.map((d, i) => ({ datetime: d, open: "1", high: "1", low: "1", close: String(base * co[8] ** i), volume: String(co[7]) })).reverse() });
      }
      return new Response("not found", { status: 404 });
    },
  });
  return { s, urls };
}

describe("data screen", () => {
  it("filters the whole market by size, sector, growth, liquidity and price, and explains each pick with numbers", async () => {
    const { s, urls } = setup();
    const r = await screenStocks(s, { sizes: ["small"], minRevenueGrowth: 0.1, count: 5 }, { now: new Date("2026-11-02T22:00:00Z") });
    expect(r.candidates.map((c) => c.ticker)).toEqual(["GROW"]);
    expect(r.candidates[0]!.reason).toMatch(/^小型（浮動株 \$1\.2B）、売上 \+50%、営業利益率 20%、12-1モメンタム \+\d+%、売買代金 \$\d+M\/日$/);
    expect(r.funnel.map((f) => f.count)).toEqual([6, 4, 3, 3, 1, 1]); // HAVE excluded · small · growth ≥ 10% (GROW, THIN, PENNY) · sector · liquidity/price · picks
    expect(r.weightsFrom).toBe("default");
    // prices only for the short list, never for the whole market
    expect(urls.filter((u) => u.startsWith("https://api.twelvedata.com")).length).toBe(3);
  });

  it("sector filter and the weights from factor research", async () => {
    const { s } = setup();
    const r = await screenStocks(s, { sizes: ["small", "mid", "large"], sectors: ["financials"] }, {
      now: new Date("2026-11-02T22:00:00Z"),
      report: { suggested: { momentum: 0.5, quality: 0.5 } } as never,
    });
    expect(r.candidates.map((c) => c.ticker)).toEqual(["BANK"]);
    expect(r.weightsFrom).toBe("factor-research");
    expect(r.weights).toEqual({ momentum: 0.5, quality: 0.5 });
  });

  it("needs the SEC user agent", async () => {
    const s = new Services(AppConfig.parse({ watchlist: {} }), { fake: true, dbPath: ":memory:", env: {} });
    await expect(screenStocks(s, {})).rejects.toThrow(/SEC_USER_AGENT/);
  });
});
