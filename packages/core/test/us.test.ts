import { describe, expect, it } from "vitest";
import { AppConfig } from "../src/config.ts";
import { PriceStore } from "../src/data/priceStore.ts";
import { isCovered, syncBars, type BarSource } from "../src/data/priceSync.ts";
import { htmlToText, newYorkToUtc, parseSubmissions, pickExhibit } from "../src/data/sec.ts";
import { parseTimeSeries, TwelveDataAuthError, TwelveDataClient } from "../src/data/twelveData.ts";
import { heuristicResponder } from "../src/llm/heuristic.ts";
import { builtinRegistry } from "../src/nodes/index.ts";
import { Services } from "../src/services.ts";
import type { Bar } from "../src/signals/technical.ts";
import { EVENT_PROMPTS } from "../src/signals/prompts.ts";
import { openDb } from "../src/util/db.ts";
import { weekdays } from "../src/util/dates.ts";
import { Engine } from "../src/workflow/engine.ts";
import { parseWorkflow } from "../src/workflow/spec.ts";
import { loadEventSet } from "../src/eval/golden.ts";
import { resolve } from "node:path";
import { makeDoc } from "./helpers.ts";

const ROOT = resolve(import.meta.dirname, "../../..");

const bars = (dates: string[], close = (i: number) => 100 + i): Bar[] =>
  dates.map((date, i) => ({ date, open: close(i), high: close(i) + 1, low: close(i) - 1, close: close(i), volume: 1000 }));

const tdBody = (b: Bar[]) => ({
  meta: { symbol: "X" },
  status: "ok",
  values: b.map((x) => ({ datetime: x.date, open: String(x.open), high: String(x.high), low: String(x.low), close: String(x.close), volume: String(x.volume) })),
});

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("Twelve Data", () => {
  it("parses bars and classifies errors", () => {
    const b = parseTimeSeries(tdBody(bars(["2026-10-02", "2026-10-01"])), "AAPL");
    expect(b.map((x) => x.date)).toEqual(["2026-10-01", "2026-10-02"]);
    expect(b[0]!.close).toBe(101);
    expect(parseTimeSeries({ status: "error", code: 400, message: "No data is available on the specified dates." }, "AAPL")).toEqual([]);
    expect(() => parseTimeSeries({ status: "error", code: 401, message: "bad key" }, "AAPL")).toThrow(TwelveDataAuthError);
    expect(() => parseTimeSeries({ status: "error", code: 404, message: "symbol not found" }, "ZZZZ")).toThrow(/symbol not found/);
    expect(() => parseTimeSeries({ status: "ok", values: [{ datetime: "2026-10-01", open: "x", high: "1", low: "1", close: "1" }] }, "A")).toThrow(/non-numeric/);
  });

  it("sends the key in a header, spaces requests and waits once on a minute limit", async () => {
    const calls: Array<{ url: string; auth: string | null }> = [];
    const sleeps: number[] = [];
    let n = 0;
    const client = new TwelveDataClient({
      apiKey: "secret-key", perMinute: 8, sleep: async (ms) => void sleeps.push(ms), clock: () => 0,
      fetchImpl: async (url, init) => {
        calls.push({ url: String(url), auth: new Headers(init?.headers).get("authorization") });
        return n++ === 0 ? json({ status: "error", code: 429, message: "limit" }) : json(tdBody(bars(["2026-10-01"])));
      },
    });
    expect(await client.dailyBars("AAPL", { outputsize: 300 })).toHaveLength(1);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.url).not.toContain("secret-key");
    expect(calls[0]!.url).toContain("symbol=AAPL");
    expect(calls[0]!.auth).toBe("apikey secret-key");
    expect(sleeps).toContain(61_000);
    expect(sleeps.some((s) => s === 7500)).toBe(true); // 60s / 8 between requests
  });
});

describe("price sync", () => {
  const days = weekdays("2026-01-01", "2026-03-31");

  function fakeApi(series: () => Bar[]): BarSource & { calls: Array<{ startDate?: string; outputsize?: number }> } {
    const calls: Array<{ startDate?: string; outputsize?: number }> = [];
    return {
      calls,
      async dailyBars(_s, q) {
        calls.push(q);
        const all = series();
        return q.startDate ? all.filter((b) => b.date >= q.startDate!) : all.slice(-(q.outputsize ?? all.length));
      },
    };
  }

  it("downloads everything once, then only the last bars; re-downloads after a split re-adjustment", async () => {
    const store = new PriceStore(openDb(":memory:"));
    let upto = 40;
    let factor = 1;
    const api = fakeApi(() => bars(days.slice(0, upto), (i) => (100 + i) * factor));
    const r1 = await syncBars(store, api, "td", "AAPL", "AAPL", new Date(), { historyBars: 1000 });
    expect(r1.fetch).toBe("full");
    upto = 42;
    const r2 = await syncBars(store, api, "td", "AAPL", "AAPL", new Date(), { historyBars: 1000 });
    expect(r2.fetch).toBe("update");
    expect(api.calls[1]!.startDate).toBe(days[34]); // 5 stored bars of overlap
    expect(store.bars("td", "AAPL")).toHaveLength(42);
    factor = 0.25; // 4-for-1 split: every past close changes
    const r3 = await syncBars(store, api, "td", "AAPL", "AAPL", new Date(), { historyBars: 1000 });
    expect(r3.fetch).toBe("full");
    expect(store.bars("td", "AAPL")[0]!.close).toBe(25);
  });

  it("knows when the local copy already covers a date", () => {
    const store = new PriceStore(openDb(":memory:"));
    store.upsert("td", "AAPL", bars(["2026-10-01", "2026-10-02"]));
    expect(isCovered(store, "td", "AAPL", "2026-10-01")).toBe(true); // a later bar exists
    expect(isCovered(store, "td", "AAPL", "2026-10-02")).toBe(false); // never fetched after that close
    store.markFetched("td", "AAPL", new Date("2026-10-02T23:00:00Z"));
    expect(isCovered(store, "td", "AAPL", "2026-10-02")).toBe(true);
    store.markFetched("td", "AAPL", new Date("2026-10-02T19:00:00Z")); // during the session
    expect(isCovered(store, "td", "AAPL", "2026-10-02")).toBe(false);
  });
});

const usConfig = () =>
  AppConfig.parse({
    market: { currency: "USD", benchmark: "SPY" },
    watchlist: { AAPL: { name: "Apple", sector: "tech" }, MSFT: { name: "Microsoft", sector: "tech" } },
    risk: { lotSize: 1 },
  });

describe("data.pricesTwelveData node", () => {
  const spec = parseWorkflow("name: t\nnodes:\n  prices: { use: data.pricesTwelveData }\n");
  const history = weekdays("2025-01-01", "2026-10-30");

  function setup(env: Record<string, string>, fail: Set<string> = new Set()) {
    const requests: string[] = [];
    const s = new Services(usConfig(), {
      dbPath: ":memory:", env, sleep: async () => undefined,
      fetchImpl: async (url) => {
        const sym = new URL(String(url)).searchParams.get("symbol")!;
        requests.push(sym);
        if (fail.has(sym)) throw new TypeError("fetch failed");
        return json(tdBody(bars(history)));
      },
    });
    return { s, requests, engine: (now: string) => new Engine({ services: s, registry: builtinRegistry(), store: s.runStore, clock: () => new Date(now) }) };
  }

  it("downloads the watchlist and benchmark, then serves replays from the local copy", async () => {
    const { s, requests, engine } = setup({ TWELVEDATA_API_KEY: "k" });
    const r = await engine("2026-10-30T22:30:00Z").run(spec, {});
    expect(r.status).toBe("succeeded");
    expect(requests.sort()).toEqual(["AAPL", "MSFT", "SPY"]);
    const prices = r.output<Record<string, Bar[]>>("prices", "prices");
    expect(prices["AAPL"]!.at(-1)!.date).toBe("2026-10-30");
    // replaying a past date: no network, truncated at that date
    const past = await engine("2026-10-30T22:30:00Z").run(spec, { asOf: "2026-06-15" });
    expect(requests).toHaveLength(3);
    expect(past.output<Record<string, Bar[]>>("prices", "prices")["MSFT"]!.at(-1)!.date).toBe("2026-06-15");
    expect(s.priceStore.bars("twelvedata", "SPY").length).toBe(history.length);
  });

  it("needs the key only when it has to download, and stops on a missing key", async () => {
    const { engine } = setup({});
    const r = await engine("2026-10-30T22:30:00Z").run(spec, {});
    expect(r.status).toBe("failed");
    expect(JSON.stringify(r)).toMatch(/TWELVEDATA_API_KEY is not set/);
  });

  it("falls back to a recent local copy when one download fails", async () => {
    const fail = new Set<string>();
    const { s, engine } = setup({ TWELVEDATA_API_KEY: "k" }, fail);
    await engine("2026-10-29T22:30:00Z").run(spec, { asOf: "2026-10-29" });
    fail.add("MSFT");
    s.priceStore.markFetched("twelvedata", "MSFT", new Date("2026-10-29T12:00:00Z")); // make the next run want fresh bars
    s.priceStore.replace("twelvedata", "MSFT", bars(history.filter((d) => d <= "2026-10-29")));
    const r = await engine("2026-10-30T22:30:00Z").run(spec, {});
    expect(r.status).toBe("succeeded");
    expect(r.output<Record<string, Bar[]>>("prices", "prices")["MSFT"]!.at(-1)!.date).toBe("2026-10-29");
  });

  it("says why when nothing could be downloaded", async () => {
    const { engine } = setup({ TWELVEDATA_API_KEY: "k" }, new Set(["AAPL", "MSFT", "SPY"]));
    const r = await engine("2026-10-30T22:30:00Z").run(spec, {});
    expect(r.status).toBe("failed");
    expect(r.nodes["prices"]!.error).toBe("no price data from Twelve Data (3 failed) — AAPL, MSFT, SPY: cannot reach api.twelvedata.com: fetch failed");
  });
});

describe("SEC EDGAR", () => {
  it("reads EDGAR times as New York time across DST", () => {
    expect(newYorkToUtc("2026-07-30T16:31:02.000Z")).toBe("2026-07-30T20:31:02.000Z"); // EDT = UTC-4
    expect(newYorkToUtc("2026-01-29T16:31:02.000Z")).toBe("2026-01-29T21:31:02.000Z"); // EST = UTC-5
  });

  it("parses submissions, filing text and exhibits", () => {
    const sub = parseSubmissions({
      cik: 320193, name: "Apple Inc.",
      filings: { recent: {
        accessionNumber: ["0000320193-26-000071", "0000320193-26-000070"],
        filingDate: ["2026-10-29", "2026-10-20"],
        acceptanceDateTime: ["2026-10-29T16:30:15.000Z", "2026-10-20T08:00:00.000Z"],
        form: ["8-K", "4"], items: ["2.02,9.01", ""],
        primaryDocument: ["aapl-20261029.htm", "xslF345X05/wk-form4.xml"], primaryDocDescription: ["8-K", "FORM 4"],
      } },
    });
    expect(sub.filings).toHaveLength(2);
    expect(sub.filings[0]).toMatchObject({ form: "8-K", items: ["2.02", "9.01"], acceptedAt: "2026-10-29T20:30:15.000Z", url: "https://www.sec.gov/Archives/edgar/data/320193/000032019326000071/aapl-20261029.htm" });
    expect(htmlToText("<html><ix:header>hidden</ix:header><p>Revenue was $94.9&nbsp;billion,&#160;up 6%</p><script>x()</script><p>Q&amp;A</p></html>")).toBe("Revenue was $94.9 billion, up 6%\nQ&A");
    expect(pickExhibit({ directory: { item: [{ name: "aapl-20261029.htm" }, { name: "a8-kex991q4fy26.htm" }, { name: "R1.xml" }] } })).toBe("a8-kex991q4fy26.htm");
  });

  it("source.secFilings: watchlist 8-Ks with text, point-in-time, with the required User-Agent", async () => {
    const seen: Array<{ url: string; ua: string | null }> = [];
    const s = new Services(usConfig(), {
      dbPath: ":memory:", env: { SEC_USER_AGENT: "stockai test@example.com" }, sleep: async () => undefined,
      fetchImpl: async (u, init) => {
        const url = String(u);
        seen.push({ url, ua: new Headers(init?.headers).get("user-agent") });
        if (url.endsWith("company_tickers.json")) return json({ 0: { cik_str: 320193, ticker: "AAPL", title: "Apple Inc." }, 1: { cik_str: 789019, ticker: "MSFT", title: "MICROSOFT CORP" } });
        if (url.includes("CIK0000320193")) {
          return json({ cik: 320193, name: "Apple Inc.", filings: { recent: {
            accessionNumber: ["0000320193-26-000071", "0000320193-26-000060"], filingDate: ["2026-10-29", "2026-09-01"],
            acceptanceDateTime: ["2026-10-29T16:30:15.000Z", "2026-09-01T16:30:00.000Z"], form: ["8-K", "8-K"], items: ["2.02,9.01", "8.01"],
            primaryDocument: ["aapl-20261029.htm", "old.htm"], primaryDocDescription: ["8-K", "8-K"],
          } } });
        }
        if (url.includes("CIK0000789019")) return json({ cik: 789019, name: "MICROSOFT CORP", filings: { recent: {} } });
        if (url.endsWith("/index.json")) return json({ directory: { item: [{ name: "aapl-20261029.htm" }, { name: "ex991.htm" }] } });
        if (url.endsWith("ex991.htm")) return new Response("<p>Apple reports fourth quarter results. Quarterly revenue of $102.5 billion, up 8 percent year over year.</p>");
        if (url.endsWith("aapl-20261029.htm")) return new Response("<p>Item 2.02 Results of Operations and Financial Condition.</p>");
        return new Response("not found", { status: 404 });
      },
    });
    const spec = parseWorkflow("name: t\nnodes:\n  sec: { use: source.secFilings }\n");
    const engine = new Engine({ services: s, registry: builtinRegistry(), store: s.runStore, clock: () => new Date("2026-10-30T12:00:00Z") });
    const r = await engine.run(spec, {});
    expect(r.status).toBe("succeeded");
    const docs = r.output<Array<{ title: string; body: string; fetchedAt: string; url: string }>>("sec", "docs");
    expect(docs).toHaveLength(1); // the September filing is outside the 3-day lookback
    expect(docs[0]!.title).toBe("Apple (AAPL) 8-K: Item 2.02 Results of Operations and Financial Condition; Item 9.01 Financial Statements and Exhibits");
    expect(docs[0]!.body).toContain("Quarterly revenue of $102.5 billion");
    expect(docs[0]!.fetchedAt).toBe("2026-10-29T20:30:15.000Z");
    expect(seen.every((x) => x.ua === "stockai test@example.com")).toBe(true);
    // replaying the day before the filing must not see it
    const before = await engine.run(spec, { asOf: "2026-10-28" });
    expect(before.output<unknown[]>("sec", "docs")).toHaveLength(0);
    // and the matcher picks it up for the watchlist
    expect(s.watchlist.match(makeDoc({ title: docs[0]!.title, body: docs[0]!.body }))).toEqual({ AAPL: "Apple" });
  });

  it("refuses to run without a contact User-Agent", async () => {
    const s = new Services(usConfig(), { dbPath: ":memory:", env: {} });
    const spec = parseWorkflow("name: t\nnodes:\n  sec: { use: source.secFilings }\n");
    const r = await new Engine({ services: s, registry: builtinRegistry(), store: s.runStore }).run(spec, {});
    expect(JSON.stringify(r)).toMatch(/SEC_USER_AGENT is not set/);
  });
});

describe("US prompt and golden set", () => {
  it("has an English-filing event prompt and a loadable US golden set", () => {
    expect(EVENT_PROMPTS["event-us-v1"].system).toMatch(/Item 4\.02/);
    const set = loadEventSet(resolve(ROOT, "examples/golden/events-us.yaml"));
    expect(set.cases.length).toBeGreaterThanOrEqual(20);
    for (const c of set.cases) for (const t of c.expect.tickers ?? []) expect(Object.keys(c.candidates)).toContain(t);
  });

  it("the offline heuristic reads English", () => {
    const doc = makeDoc({ title: "Apple raises full-year outlook", body: "Apple Inc. raised its full-year revenue outlook to $420 billion. Shares rose." });
    const out = JSON.parse(heuristicResponder({ system: "", user: EVENT_PROMPTS["event-us-v1"].user(doc, { AAPL: "Apple" }) } as never)) as { relevant: boolean; tickers: string[]; evidence: string[] };
    expect(out.relevant).toBe(true);
    expect(out.tickers).toEqual(["AAPL"]);
    expect(doc.body + doc.title).toContain(out.evidence[0]!.replace(/\.$/, ""));
  });
});
