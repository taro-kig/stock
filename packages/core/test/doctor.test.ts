import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AppConfig } from "../src/config.ts";
import { runDoctor } from "../src/doctor.ts";
import { FakeProvider } from "../src/llm/fake.ts";
import { Services } from "../src/services.ts";

const HOOK = "https://discord.com/api/webhooks/1/tok";
const RSS = `<?xml version="1.0"?><rss version="2.0"><channel><title>t</title>
<item><title>Apple raises outlook</title><link>https://x/1</link><description>Apple Inc. raised its outlook.</description><pubDate>Mon, 02 Nov 2026 10:00:00 GMT</pubDate></item>
<item><title>Markets close higher</title><link>https://x/2</link><description>Stocks rose.</description><pubDate>Mon, 02 Nov 2026 11:00:00 GMT</pubDate></item>
</channel></rss>`;

function setup(env: Record<string, string>, opts: { tdStatus?: number } = {}) {
  const calls: Array<{ url: string; method: string }> = [];
  const dataDir = mkdtempSync(join(tmpdir(), "doctor-"));
  const config = AppConfig.parse({
    dataDir, market: { currency: "USD", benchmark: "SPY" },
    watchlist: { AAPL: { name: "Apple" }, ZZZQ: { name: "Nothing" } },
    models: { tier1: [{ name: "g", provider: "gemini", model: "gemini-2.5-flash-lite", apiKeyEnv: "GEMINI_API_KEY" }, { name: "d", provider: "openai_compat", baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat", apiKeyEnv: "DEEPSEEK_API_KEY" }] },
    sources: [{ name: "feed", url: "https://feeds.example/rss?s={tickers}" }],
    ibkr: { mode: "paper" },
  });
  const s = new Services(config, {
    dbPath: ":memory:", env, sleep: async () => undefined,
    fetchImpl: async (u, init) => {
      const url = String(u);
      calls.push({ url, method: init?.method ?? "GET" });
      if (url.startsWith("https://api.twelvedata.com")) {
        if (opts.tdStatus) return new Response("{}", { status: opts.tdStatus });
        return new Response(JSON.stringify({ status: "ok", values: [{ datetime: "2026-10-30", open: "1", high: "1", low: "1", close: "512.3", volume: "1" }] }));
      }
      if (url.endsWith("company_tickers.json")) return new Response(JSON.stringify({ 0: { cik_str: 320193, ticker: "AAPL", title: "Apple Inc." } }));
      if (url.includes("/companyfacts/CIK0000320193")) {
        const q = (start: string, end: string, val: number, filed: string) => ({ start, end, val, filed, form: "10-Q" });
        return new Response(JSON.stringify({ facts: { "us-gaap": { Revenues: { units: { USD: [
          q("2025-07-01", "2025-09-30", 100, "2025-10-31"), q("2025-10-01", "2025-12-31", 100, "2026-01-30"), q("2026-01-01", "2026-03-31", 100, "2026-05-01"),
          q("2026-04-01", "2026-06-30", 100, "2026-08-01"), q("2026-07-01", "2026-09-30", 110, "2026-10-31"),
        ] } } } } }));
      }
      if (url.includes("CIK0000320193")) {
        return new Response(JSON.stringify({ cik: 320193, name: "Apple Inc.", filings: { recent: {
          accessionNumber: ["a", "b", "c"], filingDate: ["2026-10-30", "2026-10-29", "2026-10-01"], acceptanceDateTime: ["2026-10-30T17:00:00.000Z", "2026-10-29T17:00:00.000Z", "2026-10-01T17:00:00.000Z"],
          form: ["4", "8-K", "SCHEDULE 13D"], items: ["", "2.02", ""], primaryDocument: ["x.xml", "y.htm", "z.xml"], primaryDocDescription: ["", "", ""],
        } } }));
      }
      if (url.includes("function=EARNINGS_ESTIMATES")) {
        return new Response(JSON.stringify({ symbol: "AAPL", estimates: [{ date: "2026-12-31", horizon: "next fiscal quarter", eps_estimate_average: "2.40", eps_estimate_average_30_days_ago: "2.30", eps_estimate_revision_up_trailing_30_days: "3", eps_estimate_revision_down_trailing_30_days: "1" }] }));
      }
      if (url.startsWith("https://www.alphavantage.co")) return new Response("symbol,name,reportDate,fiscalDateEnding,estimate,currency\nAAPL,Apple,2026-11-20,2026-09-30,1.8,USD\nMSFT,Microsoft,2026-11-05,2026-09-30,,USD\n");
      if (url.startsWith("https://feeds.example")) return new Response(RSS);
      if (url === HOOK) return new Response(JSON.stringify({ name: "stockai", channel_id: "123" }));
      return new Response("not found", { status: 404 });
    },
  });
  const buildModel = (spec: { name: string }) => new FakeProvider(spec.name, () => (spec.name === "d" ? "not json" : '{"ok": true}'));
  return { s, calls, buildModel };
}

describe("doctor", () => {
  it("checks every service with one small request and reports what it found", async () => {
    const env = { GEMINI_API_KEY: "k", DEEPSEEK_API_KEY: "k", TWELVEDATA_API_KEY: "k", SEC_USER_AGENT: "stockai me@example.com", ALPHAVANTAGE_API_KEY: "k", DISCORD_WEBHOOK_URL: HOOK };
    const { s, calls, buildModel } = setup(env);
    const r = await runDoctor(s, { buildModel: buildModel as never, probePort: async () => false, now: new Date("2026-11-02T10:00:00Z") });
    const by = Object.fromEntries(r.map((x) => [x.id, x]));
    expect(by["config"]!.status).toBe("ok");
    expect(by["prompts"]!.status).toBe("ok");
    expect(by["llm:g"]).toMatchObject({ status: "ok" });
    expect(by["llm:d"]).toMatchObject({ status: "warn" }); // answered, but not JSON
    expect(by["twelvedata"]).toMatchObject({ status: "ok" });
    expect(by["twelvedata"]!.detail).toContain("SPY 終値 512.3");
    expect(by["sec"]!.status).toBe("warn"); // ZZZQ is not on the SEC list
    expect(by["sec"]!.detail).toMatch(/8-K 1件・Form 4 1件・13D 1件 · 財務データ: 2026-09 期まで/);
    expect(s.fundamentals.lastFetch("AAPL")).toBe("2026-11-02"); // the daily run will not download it again today
    expect(by["alphavantage"]!.detail).toContain("次: AAPL 2026-11-20");
    expect(s.earnings.fetchedOn("2026-11-02")).toBe(true); // counts as today's download
    expect(by["estimates"]).toMatchObject({ status: "ok", detail: "AAPL · 四半期 2026-12-31: 2.4 · 過去値 30 日前 · 修正件数 3↑ 1↓" });
    expect(s.estimates.lastFetch("AAPL")).toBe("2026-11-02");
    expect(by["rss:feed"]!.detail).toBe("2 件 · ウォッチリストに関係 1 件");
    expect(calls.find((c) => c.url.startsWith("https://feeds.example"))!.url).toContain("s=AAPL,ZZZQ");
    expect(by["discord"]).toMatchObject({ status: "ok" });
    expect(calls.filter((c) => c.url === HOOK).every((c) => c.method === "GET")).toBe(true); // nothing posted
    expect(by["ibkr"]!.status).toBe("skip");
    expect(by["storage"]!.status).toBe("warn"); // no backup yet
    expect(r.every((x) => x.status !== "fail")).toBe(true);
    expect(s.budget.spentToday()).toBeGreaterThanOrEqual(0);
  });

  it("explains missing keys and rejected keys, and skips optional services", async () => {
    const { s, buildModel } = setup({ TWELVEDATA_API_KEY: "bad" }, { tdStatus: 401 });
    const r = await runDoctor(s, { buildModel: buildModel as never, probePort: async () => true });
    const by = Object.fromEntries(r.map((x) => [x.id, x]));
    expect(by["llm:g"]).toMatchObject({ status: "fail", detail: "GEMINI_API_KEY が未設定" });
    expect(by["llm:g"]!.hint).toContain("⚙ 設定");
    expect(by["twelvedata"]).toMatchObject({ status: "fail" });
    expect(by["twelvedata"]!.detail).toMatch(/401/);
    expect(by["sec"]).toMatchObject({ status: "fail", detail: "SEC_USER_AGENT が未設定" });
    expect(by["alphavantage"]!.status).toBe("skip");
    expect(by["discord"]!.status).toBe("skip");
    expect(by["ibkr"]!.status).toBe("ok");
  });

  it("skips LLM calls with fake models and can be limited to groups", async () => {
    const s = new Services(AppConfig.parse({ dataDir: mkdtempSync(join(tmpdir(), "doctor-")), watchlist: { AAPL: { name: "Apple" } } }), { fake: true, dbPath: ":memory:" });
    const r = await runDoctor(s, { groups: ["config", "llm"] });
    expect(r.map((x) => x.id)).toEqual(["config", "prompts", "llm"]);
    expect(r.find((x) => x.id === "llm")!.status).toBe("skip");
  });
});
