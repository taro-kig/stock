import { describe, expect, it } from "vitest";
import { AppConfig } from "../src/config.ts";
import { marketImpact, PaperBook } from "../src/execution/paper.ts";
import { builtinRegistry } from "../src/nodes/index.ts";
import { Services } from "../src/services.ts";
import type { Bar } from "../src/signals/technical.ts";
import { avgTradedValue } from "../src/strategy/factors.ts";
import { proposeRebalance } from "../src/strategy/portfolio.ts";
import { RiskConfig } from "../src/strategy/risk.ts";
import { weekdays } from "../src/util/dates.ts";
import { openDb } from "../src/util/db.ts";

const days = weekdays("2026-06-01", "2026-10-30");
const bars = (close: (i: number) => number, volume: number): Bar[] => days.map((date, i) => ({ date, open: close(i), high: close(i), low: close(i), close: close(i), volume }));

describe("liquidity", () => {
  it("average traded value", () => {
    expect(avgTradedValue(bars(() => 10, 1000))).toBe(10_000);
    expect(avgTradedValue(bars(() => 10, 0))).toBeNull();
  });

  it("market impact grows with the square root of the order vs daily value", () => {
    const b = bars((i) => 100 * (1 + 0.01 * Math.sin(i)), 100_000); // ~$10M a day, ~1% daily moves
    const small = marketImpact(10_000, b);
    const big = marketImpact(1_000_000, b);
    expect(small).toBeGreaterThan(0);
    expect(big / small).toBeCloseTo(10, 0); // √(100)
    expect(marketImpact(1e12, b)).toBe(0.05); // capped
    expect(marketImpact(1_000_000, b, 0)).toBe(0);
  });

  it("caps a new position at a share of the daily traded value", () => {
    const cfg = RiskConfig.parse({});
    const c = { ticker: "A", price: 10, atr: 0.2, sector: "tech", trendOk: true };
    const base = { scores: { A: 2 }, positions: {}, equity: 1_000_000, mode: "normal" as const, regimeOk: true, thesisBroken: [] };
    const free = proposeRebalance({ ...base, candidates: { A: c } }, cfg, { topN: 5, exitRankMult: 2, timeStopDays: 60 })[0]!.shares;
    const capped = proposeRebalance({ ...base, candidates: { A: { ...c, maxShares: 500 } } }, cfg, { topN: 5, exitRankMult: 2, timeStopDays: 60 })[0]!.shares;
    expect(free).toBeGreaterThan(500);
    expect(capped).toBe(500);
  });

  it("the paper broker charges more for orders that are large for the stock", () => {
    const db = openDb(":memory:");
    const book = new PaperBook(db);
    book.ensure("p", 1_000_000, "USD");
    const liquid = bars((i) => 50 * (1 + 0.01 * Math.sin(i)), 10_000_000);
    const thin = bars((i) => 50 * (1 + 0.01 * Math.sin(i)), 20_000);
    const asOf = days.at(-1)!;
    const order = (t: string) => [{ action: "buy" as const, ticker: t, shares: 2000, price: 50, reason: "test" }];
    const opts = { slippageBps: 10, feeBps: 0, lotSize: 1, sectors: {} };
    const a = book.apply("r1", "p", asOf, order("LIQ"), { LIQ: liquid }, opts)[0]!;
    const b = book.apply("r2", "p", asOf, order("THIN"), { THIN: thin }, opts)[0]!;
    const close = liquid.at(-1)!.close;
    expect(a.price / close - 1).toBeLessThan(0.0015);
    // $100k into a stock that trades ~$1M a day: several times the cost of the same order in a liquid one
    expect(b.price / close - (a.price / close)).toBeGreaterThan(0.0015); // ≈ +0.2% of extra impact on top of the same 0.1% spread
  });

  it("propose blocks penny stocks and thinly traded names and says why", async () => {
    const s = new Services(AppConfig.parse({ market: { currency: "USD" }, watchlist: { CHEAP: { name: "c" }, THIN: { name: "t" }, OK: { name: "o" } } }), { fake: true, dbPath: ":memory:" });
    const logs: string[] = [];
    const reg = builtinRegistry();
    const propose = reg.get("portfolio.propose")!;
    const rows = {
      CHEAP: { ticker: "CHEAP", name: "c", sector: "tech", lastDate: days.at(-1)!, close: 3, atr: 0.1, momentum: 0, relStrength: 0, vol: 0.2, trend: "up" as const, ret20: 0, fromHigh52: 0, adv20: 50e6 },
      THIN: { ticker: "THIN", name: "t", sector: "tech", lastDate: days.at(-1)!, close: 30, atr: 1, momentum: 0, relStrength: 0, vol: 0.2, trend: "up" as const, ret20: 0, fromHigh52: 0, adv20: 1e6 },
      OK: { ticker: "OK", name: "o", sector: "tech", lastDate: days.at(-1)!, close: 30, atr: 1, momentum: 0, relStrength: 0, vol: 0.2, trend: "up" as const, ret20: 0, fromHigh52: 0, adv20: 20e6 },
    };
    const j = (t: string) => ({ ticker: t, stance: "bullish" as const, conviction: 0.9, status: "consensus" as const, agreement: 1, thesis: "", invalidation: [], evidence: [], vetoReason: null, votes: [] });
    const out = await propose.run(
      { services: s, asOf: days.at(-1)!, log: (m: string) => logs.push(m), metric: () => undefined } as never,
      propose.params.parse({}),
      { judgments: { CHEAP: j("CHEAP"), THIN: j("THIN"), OK: j("OK") }, factors: { asOf: days.at(-1)!, benchmark: null, rows }, account: { account: "p", currency: "USD", cash: 100_000, equity: 100_000, positions: {}, mode: "normal", peak: 100_000, drawdown: 0 } } as never,
    ) as unknown as { proposals: Array<{ ticker: string; shares: number }> };
    expect(out.proposals.map((p) => p.ticker)).toEqual(["OK"]);
    expect(out.proposals[0]!.shares).toBeLessThanOrEqual(Math.floor((0.02 * 20e6) / 30));
    expect(logs.join("\n")).toMatch(/CHEAP: no new entry, 株価 3 が下限 5 未満/);
    expect(logs.join("\n")).toMatch(/THIN: no new entry, 売買代金が少ない（20日平均 \$1.0M < \$5.0M）/);
  });
});
