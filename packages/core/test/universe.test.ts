import { describe, expect, it } from "vitest";
import { AppConfig } from "../src/config.ts";
import { Services } from "../src/services.ts";
import { namesMatch, suggestTickers, verify, type Listing } from "../src/universe/suggest.ts";

const L = (ticker: string, name: string, exchange = "Nasdaq", cik = 1): Listing => ({ ticker, name, exchange, cik });
const c = (ticker: string, name: string) => ({ ticker, name, aliases: [], sector: "tech" as const, reason: "r" });

describe("ticker verification", () => {
  it("matches common names to SEC names and catches a ticker paired with another company", () => {
    expect(namesMatch("Broadcom", "Broadcom Inc.")).toBe(true);
    expect(namesMatch("JPMorgan Chase", "JPMORGAN CHASE & CO")).toBe(true);
    expect(namesMatch("Eli Lilly", "ELI LILLY & Co")).toBe(true);
    expect(namesMatch("Palo Alto Networks", "Palo Alto Networks Inc")).toBe(true);
    expect(namesMatch("Procter & Gamble", "PROCTER & GAMBLE Co")).toBe(true);
    expect(namesMatch("ExxonMobil", "EXXON MOBIL CORP")).toBe(true);
    expect(namesMatch("CrowdStrike", "Palantir Technologies Inc.")).toBe(false);
  });

  it("accepts only listed NYSE/Nasdaq companies whose name fits, never ones already watched", () => {
    const listings = new Map([
      ["AVGO", L("AVGO", "Broadcom Inc.")], ["BRK.B", L("BRK.B", "BERKSHIRE HATHAWAY INC", "NYSE")],
      ["OTCX", L("OTCX", "Some Otc Co", "OTC")], ["PLTR", L("PLTR", "Palantir Technologies Inc.")],
    ]);
    const ex = new Set(["AAPL"]);
    expect(verify(c("avgo", "Broadcom"), listings, ex)).toMatchObject({ ticker: "AVGO", status: "ok" });
    expect(verify(c("BRK-B", "Berkshire Hathaway"), listings, ex)).toMatchObject({ ticker: "BRK.B", status: "ok" });
    expect(verify(c("AAPL", "Apple"), listings, ex).problem).toMatch(/すでに/);
    expect(verify(c("ZZZZ", "Nothing"), listings, ex).problem).toMatch(/リストに無い/);
    expect(verify(c("OTCX", "Some Otc"), listings, ex).problem).toMatch(/NYSE \/ Nasdaq ではない/);
    expect(verify(c("PLTR", "CrowdStrike"), listings, ex).problem).toMatch(/一致しない/);
    expect(verify(c("AV GO", "x"), listings, ex).status).toBe("rejected");
    expect(verify(c("AVGO", "Broadcom"), null, ex).status).toBe("unverified");
  });
});

describe("suggestTickers", () => {
  const exchangeList = {
    fields: ["cik", "name", "ticker", "exchange"],
    data: [
      [1730168, "Broadcom Inc.", "AVGO", "Nasdaq"], [2488, "ADVANCED MICRO DEVICES INC", "AMD", "Nasdaq"],
      [1535527, "CrowdStrike Holdings, Inc.", "CRWD", "Nasdaq"], [1327567, "Palo Alto Networks Inc", "PANW", "Nasdaq"],
      [1373715, "ServiceNow, Inc.", "NOW", "NYSE"], [1035267, "INTUITIVE SURGICAL INC", "ISRG", "Nasdaq"],
      [18230, "CATERPILLAR INC", "CAT", "NYSE"],
    ],
  };

  function services(env: Record<string, string>, currency: "USD" | "JPY" = "USD") {
    let secCalls = 0;
    const s = new Services(
      AppConfig.parse({ market: { currency, benchmark: "SPY" }, watchlist: { AMD: { name: "Advanced Micro Devices", sector: "semis" } } }),
      {
        fake: true, dbPath: ":memory:", env, sleep: async () => undefined,
        fetchImpl: async (url) => {
          secCalls++;
          expect(String(url)).toBe("https://www.sec.gov/files/company_tickers_exchange.json");
          return new Response(JSON.stringify(exchangeList), { headers: { "content-type": "application/json" } });
        },
      },
    );
    return { s, calls: () => secCalls };
  }

  it("proposes, verifies against the SEC list (cached for a week) and leaves out what is already watched", async () => {
    const { s, calls } = services({ SEC_USER_AGENT: "stockai me@example.com" });
    const r = await suggestTickers(s, { theme: "半導体", count: 5 }, new Date("2026-11-02T00:00:00Z"));
    expect(r.verification).toBe("sec");
    const ok = r.candidates.filter((x) => x.status === "ok").map((x) => x.ticker);
    expect(ok).toEqual(["AVGO", "CRWD", "PANW", "NOW", "ISRG"]); // AMD is already in the watchlist
    expect(r.candidates.filter((x) => x.status === "rejected").every((x) => x.problem)).toBe(true);
    expect(r.candidates.find((x) => x.ticker === "AVGO")!.listing).toMatchObject({ cik: 1730168, exchange: "Nasdaq" });
    await suggestTickers(s, { theme: "別のテーマ", count: 5 }, new Date("2026-11-03T00:00:00Z"));
    expect(calls()).toBe(1);
  });

  it("without SEC_USER_AGENT nothing is marked verified", async () => {
    const { s, calls } = services({});
    const r = await suggestTickers(s, { theme: "半導体", count: 3 });
    expect(r.verification).toBe("unavailable");
    expect(r.verificationError).toMatch(/SEC_USER_AGENT/);
    expect(r.candidates.every((x) => x.status === "unverified")).toBe(true);
    expect(calls()).toBe(0);
  });

  it("is for US stocks only and validates the request", async () => {
    await expect(suggestTickers(services({}, "JPY").s, { theme: "半導体" })).rejects.toThrow(/USD/);
    await expect(suggestTickers(services({}).s, { theme: "x" })).rejects.toThrow();
    await expect(suggestTickers(services({}).s, { theme: "半導体", count: 100 })).rejects.toThrow();
  });
});
