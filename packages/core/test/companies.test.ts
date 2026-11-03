import { describe, expect, it } from "vitest";
import { AppConfig } from "../src/config.ts";
import { builtinRegistry } from "../src/nodes/index.ts";
import { Services } from "../src/services.ts";
import { bucketOf, floatPeriods, onePerCompany, parseFrame, sampleKey, sicToSector } from "../src/universe/companies.ts";
import { Engine } from "../src/workflow/engine.ts";
import { parseWorkflow } from "../src/workflow/spec.ts";

describe("listed companies from SEC data", () => {
  it("maps SIC codes to our sectors and leaves out SPACs and funds", () => {
    expect(sicToSector(3674)).toBe("semis");
    expect(sicToSector(7372)).toBe("tech");
    expect(sicToSector(2834)).toBe("healthcare");
    expect(sicToSector(6022)).toBe("financials");
    expect(sicToSector(6798)).toBe("real_estate");
    expect(sicToSector(1311)).toBe("energy");
    expect(sicToSector(4911)).toBe("utilities");
    expect(sicToSector(2086)).toBe("staples");
    expect(sicToSector(5331)).toBe("staples");
    expect(sicToSector(5812)).toBe("consumer");
    expect(sicToSector(3711)).toBe("consumer");
    expect(sicToSector(3721)).toBe("industrials");
    expect(sicToSector(2821)).toBe("materials");
    expect(sicToSector(4813)).toBe("communication");
    expect(sicToSector(6770)).toBeNull(); // blank check
    expect(sicToSector(9999)).toBeNull();
  });

  it("sizes, periods, one ticker per company, a fixed sample order", () => {
    expect([bucketOf(20e9), bucketOf(5e9), bucketOf(0.5e9), bucketOf(0.1e9)]).toEqual(["large", "mid", "small", null]);
    expect(floatPeriods("2026-11-03", 3)).toEqual(["CY2026Q3I", "CY2026Q2I", "CY2026Q1I"]);
    expect(parseFrame({ data: [{ cik: 1, entityName: "A", end: "2026-06-30", val: 5e9 }, { cik: "x", val: 1 }] })).toEqual([{ cik: 1, entityName: "A", end: "2026-06-30", val: 5e9 }]);
    const one = onePerCompany([
      { ticker: "GOOGL", cik: 1, name: "Alphabet", exchange: "Nasdaq" }, { ticker: "GOOG", cik: 1, name: "Alphabet", exchange: "Nasdaq" },
      { ticker: "BRK.B", cik: 2, name: "Berkshire", exchange: "NYSE" }, { ticker: "BRKX", cik: 2, name: "Berkshire", exchange: "NYSE" },
      { ticker: "OTCX", cik: 3, name: "OTC Co", exchange: "OTC" },
    ]);
    expect([...one.values()].map((l) => l.ticker)).toEqual(["GOOG", "BRKX"]);
    expect(sampleKey("AAPL", 1)).toBe(sampleKey("AAPL", 1));
    expect(sampleKey("AAPL", 1)).not.toBe(sampleKey("AAPL", 2));
  });

  it("builds a stratified research universe, and the research nodes use it", async () => {
    // 3 large, 3 mid, 3 small companies + one SPAC and one tiny company
    const cos = [
      ["L1", 1, 50e9, 7372], ["L2", 2, 40e9, 3674], ["L3", 3, 30e9, 6022],
      ["M1", 4, 5e9, 2834], ["M2", 5, 4e9, 1311], ["M3", 6, 3e9, 4911],
      ["S1", 7, 1e9, 5812], ["S2", 8, 0.8e9, 3721], ["S3", 9, 0.5e9, 6770],
      ["T1", 10, 0.1e9, 7372],
    ] as const;
    let submissions = 0;
    const s = new Services(AppConfig.parse({ market: { currency: "USD", benchmark: "SPY" }, watchlist: { L1: { name: "L1" } } }), {
      fake: true, dbPath: ":memory:", env: { SEC_USER_AGENT: "stockai test@example.com" }, sleep: async () => undefined,
      fetchImpl: async (u) => {
        const url = String(u);
        if (url.endsWith("company_tickers_exchange.json")) {
          return new Response(JSON.stringify({ fields: ["cik", "name", "ticker", "exchange"], data: cos.map(([t, cik]) => [cik, `${t} Inc`, t, "Nasdaq"]) }));
        }
        if (url.includes("/frames/dei/EntityPublicFloat/USD/CY2026Q2I")) return new Response(JSON.stringify({ data: cos.map(([, cik, val]) => ({ cik, entityName: "x", end: "2026-06-30", val })) }));
        if (url.includes("/frames/")) return new Response("not found", { status: 404 });
        const m = url.match(/submissions\/CIK0*(\d+)\.json/);
        if (m) {
          submissions++;
          return new Response(JSON.stringify({ sic: String(cos.find(([, cik]) => cik === Number(m[1]))![3]), sicDescription: "x" }));
        }
        return new Response("not found", { status: 404 });
      },
    });
    const engine = new Engine({ services: s, registry: builtinRegistry(), store: s.runStore, clock: () => new Date("2026-11-03T22:00:00Z") });
    const r = await engine.run(parseWorkflow("name: u\nnodes:\n  u: { use: data.researchUniverse, params: { perBucket: 10 } }\n"), { asOf: "2026-11-03" });
    expect(r.status).toBe("succeeded");
    // too few for a research universe (< 30): the built-in list stays
    expect(r.output<number>("u", "count")).toBeGreaterThan(100);
    expect(s.companies.research().rows).toEqual([]);
    expect(submissions).toBe(9); // every company with a size was looked up once (T1 is too small: never)
    // with a lower bar it is saved
    const { buildResearchUniverse } = await import("../src/universe/companies.ts");
    const { SecClient } = await import("../src/data/sec.ts");
    const rows = await buildResearchUniverse(s, new SecClient({ userAgent: "stockai test@example.com", fetchImpl: s.fetch, sleep: s.sleep }), new Date("2026-11-03T22:00:00Z"), { perBucket: 2, seed: 1 });
    expect(rows.filter((x) => x.bucket === "large")).toHaveLength(2);
    expect(rows.filter((x) => x.bucket === "small").map((x) => x.ticker).sort()).toEqual(["S1", "S2"]); // the SPAC is skipped
    expect(rows.find((x) => x.ticker === "M2")?.sector ?? "energy").toBe("energy");
    expect(submissions).toBe(9); // SIC codes are cached
  });
});
