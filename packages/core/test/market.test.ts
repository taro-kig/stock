import { describe, expect, it } from "vitest";
import { buildDossier } from "../src/ai/judge.ts";
import { AppConfig } from "../src/config.ts";
import { computeMarket, MacroStore, marketLines, parseFredObservations, SECTOR_ETFS } from "../src/data/market.ts";
import { builtinRegistry } from "../src/nodes/index.ts";
import { Services } from "../src/services.ts";
import type { Bar } from "../src/signals/technical.ts";
import { proposeRebalance } from "../src/strategy/portfolio.ts";
import { RiskConfig } from "../src/strategy/risk.ts";
import { weekdays } from "../src/util/dates.ts";
import { openDb } from "../src/util/db.ts";
import { Engine } from "../src/workflow/engine.ts";
import { parseWorkflow } from "../src/workflow/spec.ts";

const days = weekdays("2026-06-01", "2026-10-30");
const series = (f: (i: number) => number): Bar[] => days.map((date, i) => ({ date, open: f(i), high: f(i), low: f(i), close: f(i), volume: 1 }));
const obs = (vals: number[]) => vals.map((value, i) => ({ date: days[days.length - vals.length - 1 + i]!, value }));

describe("market & sectors", () => {
  it("reads FRED observations, skipping missing days", () => {
    expect(parseFredObservations({ observations: [{ date: "2026-10-01", value: "18.2" }, { date: "2026-10-02", value: "." }] })).toEqual([{ date: "2026-10-01", value: 18.2 }]);
    expect(() => parseFredObservations({ error_message: "Bad Request. The value for variable api_key is not registered." })).toThrow(/api_key/);
  });

  it("ranks sectors against the market and sets the risk level from VIX and credit spreads", () => {
    const prices = { SPY: series((i) => 100 * 1.001 ** i), XLK: series((i) => 100 * 1.003 ** i), XLE: series((i) => 100 * 0.999 ** i) };
    const calm = computeMarket({ asOf: days.at(-1)!, benchmark: "SPY", prices, sectorEtfs: { tech: "XLK", energy: "XLE", utilities: "XLU" }, macro: { VIXCLS: obs([15, 16]) } });
    expect(calm.sectors["tech"]).toMatchObject({ etf: "XLK", rank: 1 });
    expect(calm.sectors["energy"]!.rank).toBe(2);
    expect(calm.sectors["tech"]!.rel60).toBeCloseTo(1.003 ** 60 - 1.001 ** 60, 6);
    expect(calm.sectors["utilities"]).toBeUndefined(); // no data
    expect(calm.risk).toBe("normal");

    const vix = (v: number) => computeMarket({ asOf: days.at(-1)!, prices, sectorEtfs: {}, macro: { VIXCLS: obs([v]) } });
    expect(vix(24).risk).toBe("caution");
    expect(vix(35)).toMatchObject({ risk: "stress", reasons: ["VIX 35.0 ≥ 30"] });
    const hy = (vals: number[]) => computeMarket({ asOf: days.at(-1)!, prices, sectorEtfs: {}, macro: { BAMLH0A0HYM2: obs(vals), VIXCLS: obs([24]) } });
    expect(hy([3.0, ...Array(19).fill(3.1), 3.7]).risk).toBe("caution"); // +0.7pt in ~a month (and VIX 24)
    expect(hy([3.0, ...Array(19).fill(3.1), 4.2])).toMatchObject({ risk: "stress" }); // +1.2pt: stress wins over VIX caution
    expect(hy([6.5]).reasons[1]).toMatch(/6.50% ≥ 6%/);
  });

  it("writes the fact-sheet section for the stock's sector", () => {
    const mc = computeMarket({ asOf: days.at(-1)!, benchmark: "SPY", prices: { SPY: series(() => 100), XLK: series((i) => 100 + i * 0.1) }, sectorEtfs: { tech: "XLK" }, macro: { VIXCLS: obs([20, 23]), DGS10: obs([4.1, 4.3]) } });
    const lines = marketLines(mc, "tech");
    expect(lines[0]).toBe("## 相場全体と業種（データ。プログラムで計算）");
    expect(lines[1]).toBe("市場（SPY）: 20日 +0.0%、60日 +0.0%");
    expect(lines[2]).toMatch(/^業種 テック（XLK）: 20日 \+\d+\.\d%、60日 \+\d+\.\d%（市場との差 \+\d+\.\d%、1 業種中 1 位）$/);
    expect(lines).toContain("VIX（恐怖指数）: 23.00");
    expect(lines.at(-1)).toBe("相場の警戒度: 警戒（新規の買いは半分の大きさ） — VIX 23.0 ≥ 22");
    expect(marketLines(mc, "energy")[2]).toBe("業種 エネルギー: 対応する業種 ETF のデータなし");
    expect(marketLines(undefined, "tech")).toEqual([]);
    const row = { ticker: "X", name: "X", sector: "tech", close: 50, atr: 1, momentum: 0.1, relStrength: 0, vol: 0.2, trend: "up" as const, lastDate: days.at(-1)!, ret20: 0, fromHigh52: 0 };
    expect(buildDossier({ row, asOf: days.at(-1)!, rank: 1, universe: 2, events: [], market: mc }).text).toContain("業種 テック（XLK）");
  });

  it("uses a FRED value only from the next day (publication lag)", () => {
    const st = new MacroStore(openDb(":memory:"));
    st.save("VIXCLS", "2026-10-30", [{ date: "2026-10-29", value: 18 }, { date: "2026-10-30", value: 25 }]);
    expect(st.series("VIXCLS", "2026-10-30").map((o) => o.value)).toEqual([18]);
    expect(st.series("VIXCLS", "2026-10-31").map((o) => o.value)).toEqual([18, 25]);
  });

  it("caution halves new positions, stress stops them", async () => {
    const cfg = RiskConfig.parse({});
    const base = {
      scores: { A: 2 }, candidates: { A: { ticker: "A", price: 100, atr: 2, sector: "tech", trendOk: true } }, positions: {}, equity: 1_000_000,
      mode: "normal" as const, regimeOk: true, thesisBroken: [],
    };
    const full = proposeRebalance(base, cfg, { topN: 5, exitRankMult: 2, timeStopDays: 60 })[0]!.shares;
    const half = proposeRebalance({ ...base, sizeMult: 0.5 }, cfg, { topN: 5, exitRankMult: 2, timeStopDays: 60 })[0]!.shares;
    expect(half).toBeLessThan(full);
    expect(half).toBeGreaterThanOrEqual(Math.floor(full / 2) - cfg.lotSize);
  });

  it("the node downloads sector ETFs and FRED once a day and feeds the score and the order rules", async () => {
    const urls: string[] = [];
    const s = new Services(AppConfig.parse({ market: { currency: "USD", benchmark: "SPY" }, watchlist: { AAA: { name: "A", sector: "tech" }, BBB: { name: "B", sector: "energy" } } }), {
      fake: true, dbPath: ":memory:", env: { TWELVEDATA_API_KEY: "k", FRED_API_KEY: "f" }, sleep: async () => undefined,
      fetchImpl: async (u) => {
        const url = new URL(String(u));
        urls.push(url.host + url.pathname + (url.searchParams.get("symbol") ?? url.searchParams.get("series_id") ?? ""));
        if (url.host === "api.stlouisfed.org") {
          const id = url.searchParams.get("series_id");
          return new Response(JSON.stringify({ observations: [{ date: "2026-10-28", value: id === "VIXCLS" ? "35" : "3" }] }));
        }
        const sym = url.searchParams.get("symbol")!;
        const f = sym === "XLK" ? (i: number) => 100 * 1.003 ** i : sym === "XLE" ? (i: number) => 100 * 0.997 ** i : () => 100;
        return new Response(JSON.stringify({ status: "ok", values: series(f).reverse().map((b) => ({ datetime: b.date, open: `${b.open}`, high: `${b.high}`, low: `${b.low}`, close: `${b.close}`, volume: "1" })) }));
      },
    });
    const engine = new Engine({ services: s, registry: builtinRegistry(), store: s.runStore, clock: () => new Date("2026-10-30T22:00:00Z") });
    const r = await engine.run(parseWorkflow(`name: m
nodes:
  m: { use: data.market }
`), { asOf: "2026-10-30" });
    expect(r.status).toBe("succeeded");
    const mc = r.output<{ risk: string; sectors: Record<string, { rank: number }> }>("m", "market");
    expect(mc.risk).toBe("stress"); // VIX 35
    expect(mc.sectors["tech"]!.rank).toBe(1);
    expect(urls.filter((u) => u.includes("stlouisfed"))).toHaveLength(4);
    expect(urls.filter((u) => u.startsWith("api.twelvedata.com")).length).toBe(Object.keys(SECTOR_ETFS).length + 1); // + SPY
    await engine.run(parseWorkflow("name: m2\nnodes:\n  m: { use: data.market }\n"), { asOf: "2026-10-30" });
    expect(urls.filter((u) => u.includes("stlouisfed"))).toHaveLength(4); // once a day
  });
});
