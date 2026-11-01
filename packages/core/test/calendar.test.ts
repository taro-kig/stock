import { describe, expect, it } from "vitest";
import { buildDossier } from "../src/ai/judge.ts";
import { AppConfig } from "../src/config.ts";
import { EarningsStore, parseEarningsCsv } from "../src/data/earnings.ts";
import { builtinRegistry } from "../src/nodes/index.ts";
import { Services } from "../src/services.ts";
import { proposeRebalance } from "../src/strategy/portfolio.ts";
import { openDb } from "../src/util/db.ts";
import { isUsTradingDay, usMarketHolidays, usTradingDays } from "../src/util/marketCalendar.ts";
import { Engine } from "../src/workflow/engine.ts";
import { parseWorkflow } from "../src/workflow/spec.ts";

describe("US market holidays", () => {
  it("match the published NYSE schedules", () => {
    expect([...usMarketHolidays(2025).keys()].sort()).toEqual([
      "2025-01-01", "2025-01-20", "2025-02-17", "2025-04-18", "2025-05-26", "2025-06-19", "2025-07-04", "2025-09-01", "2025-11-27", "2025-12-25",
    ]);
    expect([...usMarketHolidays(2026).keys()].sort()).toEqual([
      "2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25", "2026-06-19", "2026-07-03", "2026-09-07", "2026-11-26", "2026-12-25",
    ]);
    // Saturday/Sunday observance: 2027-06-19 Sat -> Fri 18, 07-04 Sun -> Mon 5, 12-25 Sat -> Fri 24; Good Friday 2027-03-26
    const y27 = usMarketHolidays(2027);
    for (const d of ["2027-03-26", "2027-06-18", "2027-07-05", "2027-12-24"]) expect(y27.has(d)).toBe(true);
    // New Year's Day on a Saturday is not observed on the previous Friday (2022-01-01)
    expect(usMarketHolidays(2021).has("2021-12-31")).toBe(false);
    expect(usMarketHolidays(2022).has("2022-06-20")).toBe(true); // first Juneteenth, observed Monday
    expect(usMarketHolidays(2021).has("2021-06-18")).toBe(false); // not a market holiday before 2022
  });

  it("trading days skip weekends and holidays", () => {
    expect(isUsTradingDay("2026-11-26")).toBe(false); // Thanksgiving
    expect(isUsTradingDay("2026-11-27")).toBe(true);
    expect(usTradingDays("2026-11-23", "2026-11-30")).toEqual(["2026-11-23", "2026-11-24", "2026-11-25", "2026-11-27", "2026-11-30"]);
  });
});

const CSV = `symbol,name,reportDate,fiscalDateEnding,estimate,currency,timeOfTheDay
AAPL,Apple Inc,2026-11-20,2026-09-30,1.85,USD,post-market
MSFT,"Microsoft Corp, Inc",2026-11-05,2026-09-30,,USD,
BRK-B,Berkshire Hathaway Inc,2026-11-07,2026-09-30,5.1,USD,pre-market
`;

describe("earnings calendar", () => {
  it("parses the CSV (quoted names, empty estimates, class shares) and reports API errors", () => {
    const e = parseEarningsCsv(CSV);
    expect(e).toHaveLength(3);
    expect(e[0]).toEqual({ ticker: "AAPL", reportDate: "2026-11-20", fiscalDateEnding: "2026-09-30", estimate: 1.85, time: "post-market" });
    expect(e[1]).toMatchObject({ ticker: "MSFT", estimate: null, time: null });
    expect(e[2]!.ticker).toBe("BRK.B");
    expect(() => parseEarningsCsv('{"Information": "We have detected your API key as ... rate limit"}')).toThrow(/rate limit/);
    expect(() => parseEarningsCsv("a,b\n1,2")).toThrow(/header/);
  });

  it("answers what was known on a date (reschedules never leak into the past)", () => {
    const st = new EarningsStore(openDb(":memory:"));
    st.save("2026-11-02", [{ ticker: "AAPL", reportDate: "2026-11-20", fiscalDateEnding: null, estimate: null, time: null }]);
    st.save("2026-11-03", [{ ticker: "AAPL", reportDate: "2026-11-20", fiscalDateEnding: null, estimate: null, time: null }]);
    // rescheduled: from the 4th the calendar says the 13th
    st.save("2026-11-04", [{ ticker: "AAPL", reportDate: "2026-11-13", fiscalDateEnding: null, estimate: null, time: "post-market" }]);
    expect(st.nextFor(["AAPL"], "2026-11-03")["AAPL"]).toMatchObject({ reportDate: "2026-11-20", daysAway: 17 });
    expect(st.nextFor(["AAPL"], "2026-11-04")["AAPL"]).toMatchObject({ reportDate: "2026-11-13", daysAway: 9 });
    expect(st.nextFor(["AAPL"], "2026-11-01")["AAPL"]).toBeUndefined(); // nothing known yet
    expect(st.nextFor(["AAPL"], "2026-12-01")["AAPL"]).toBeUndefined(); // past
    expect(st.lastFetch()?.day).toBe("2026-11-04");
  });

  it("the node downloads once a day, and without a key stays green and empty", async () => {
    const run = async (env: Record<string, string>) => {
      let calls = 0;
      const s = new Services(AppConfig.parse({ market: { currency: "USD", benchmark: "SPY" }, watchlist: { AAPL: { name: "Apple" }, MSFT: { name: "Microsoft" } } }), {
        dbPath: ":memory:", env,
        fetchImpl: async (u) => {
          calls++;
          expect(String(u)).toContain("function=EARNINGS_CALENDAR");
          return new Response(CSV);
        },
      });
      const engine = new Engine({ services: s, registry: builtinRegistry(), store: s.runStore, clock: () => new Date("2026-11-03T22:00:00Z") });
      const spec = parseWorkflow("name: t\nnodes:\n  e: { use: data.earnings }\n");
      const r = await engine.run(spec);
      await engine.run(parseWorkflow("name: t2\nnodes:\n  e: { use: data.earnings }\n"));
      return { r, calls };
    };
    const withKey = await run({ ALPHAVANTAGE_API_KEY: "k" });
    expect(withKey.r.status).toBe("succeeded");
    expect(withKey.calls).toBe(1); // second workflow the same day reuses the download
    expect(withKey.r.output<Record<string, { daysAway: number }>>("e", "earnings")).toMatchObject({ AAPL: { daysAway: 17 }, MSFT: { daysAway: 2 } });
    const without = await run({});
    expect(without.r.status).toBe("succeeded");
    expect(without.calls).toBe(0);
    expect(without.r.output("e", "earnings")).toEqual({});
  });

  it("goes into the judgment dossier and blocks new buys just before a report", () => {
    const row = { ticker: "AAPL", name: "Apple", sector: "tech", close: 200, atr: 4, momentum: 0.2, relStrength: 0.05, vol: 0.25, trend: "up" as const, lastDate: "2026-11-03", ret20: 0.02, fromHigh52: -0.03 };
    const args = { row, asOf: "2026-11-03", rank: 1, universe: 10, events: [] };
    expect(buildDossier(args).text).not.toContain("## 予定"); // no calendar connected
    expect(buildDossier({ ...args, earnings: null }).text).toContain("3か月以内の予定は見つからない");
    expect(buildDossier({ ...args, earnings: { ticker: "AAPL", reportDate: "2026-11-05", fiscalDateEnding: null, estimate: 1.85, time: "post-market", daysAway: 2 } }).text)
      .toContain("次の決算発表: 2026-11-05（2日後・引け後） EPS 予想 1.85");
    const base = {
      scores: { AAPL: 2, MSFT: 1.9 }, positions: {}, equity: 100_000, mode: "normal" as const, regimeOk: true, thesisBroken: [], eligible: ["AAPL", "MSFT"],
      candidates: {
        AAPL: { ticker: "AAPL", price: 200, atr: 4, sector: "tech", trendOk: true, blockedReason: "決算まで 2 日（2026-11-05）" },
        MSFT: { ticker: "MSFT", price: 400, atr: 8, sector: "tech2", trendOk: true },
      },
    };
    const out = proposeRebalance(base, AppConfig.parse({ watchlist: {} }).risk, { topN: 5, exitRankMult: 2, timeStopDays: 60 });
    expect(out.filter((p) => p.action === "buy").map((p) => p.ticker)).toEqual(["MSFT"]);
  });
});
