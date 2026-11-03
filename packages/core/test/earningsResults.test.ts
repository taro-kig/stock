import { describe, expect, it } from "vitest";
import { buildDossier, validateJudgment, type TradeJudgment } from "../src/ai/judge.ts";
import { AppConfig } from "../src/config.ts";
import { AlphaVantageLimit, alphaVantage, contradictsResults, fetchEarningsResults, isBurstAnswer, needsResults, parseEarningsResults, resultLines, verdictOf, type EarningsResult } from "../src/data/earningsResults.ts";
import { isPremiumAnswer } from "../src/data/estimates.ts";
import { checkEventsNode } from "../src/nodes/filters.ts";
import { builtinRegistry } from "../src/nodes/index.ts";
import { Services } from "../src/services.ts";
import { validateEvent } from "../src/signals/extractor.ts";
import type { EventRecord } from "../src/signals/models.ts";
import { Engine } from "../src/workflow/engine.ts";
import { parseWorkflow } from "../src/workflow/spec.ts";

const AV = {
  symbol: "AAPL",
  quarterlyEarnings: [
    { fiscalDateEnding: "2026-09-30", reportedDate: "2026-10-30", reportedEPS: "1.52", estimatedEPS: "1.60", surprise: "-0.08", surprisePercentage: "-5", reportTime: "post-market" },
    { fiscalDateEnding: "2026-06-30", reportedDate: "2026-07-30", reportedEPS: "1.40", estimatedEPS: "1.35", surprise: "0.05", surprisePercentage: "3.7", reportTime: "post-market" },
    { fiscalDateEnding: "2026-03-31", reportedDate: "2026-04-30", reportedEPS: "1.50", estimatedEPS: "1.495", reportTime: "post-market" },
    { fiscalDateEnding: "2025-12-31", reportedDate: "2026-01-29", reportedEPS: "None", estimatedEPS: "2.10" },
  ],
};
const r = (o: Partial<EarningsResult>): EarningsResult => ({ ticker: "AAPL", fiscalDateEnding: "2026-09-30", reportedDate: "2026-10-30", reportTime: null, reportedEPS: 1.52, estimatedEPS: 1.6, surprisePct: -5, ...o });

const BURST = "Thank you for using Alpha Vantage! Please consider spreading out your free API requests more sparingly (1 request per second). You may subscribe to any of the premium plans at https://www.alphavantage.co/premium/ to lift the free key rate limit.";

describe("Alpha Vantage requests", () => {
  it("tells the per-second refusal apart from the daily limit and premium-only functions", () => {
    expect(isBurstAnswer(new AlphaVantageLimit(`Alpha Vantage: ${BURST}`))).toBe(true);
    expect(isPremiumAnswer(new AlphaVantageLimit(`Alpha Vantage: ${BURST}`))).toBe(false);
    expect(isPremiumAnswer(new AlphaVantageLimit("Alpha Vantage: This is a premium endpoint. Please subscribe to any of the premium plans"))).toBe(true);
    expect(isBurstAnswer(new AlphaVantageLimit("Alpha Vantage: We have detected your API key and our standard API rate limit is 25 requests per day."))).toBe(false);
  });

  it("keeps requests over a second apart", async () => {
    const slept: number[] = [];
    const sleep = async (ms: number) => void slept.push(ms);
    await alphaVantage(async () => 1, sleep);
    await alphaVantage(async () => 2, sleep);
    expect(slept.length).toBeGreaterThan(0);
    expect(Math.max(...slept)).toBeGreaterThan(1000);
  });

  it("waits and asks once more after a per-second refusal, then gives up", async () => {
    const answers = [{ Information: BURST }, AV];
    const fetchImpl = (async () => new Response(JSON.stringify(answers.shift()))) as unknown as typeof fetch;
    const rs = await fetchEarningsResults("k", "AAPL", fetchImpl, async () => undefined);
    expect(rs).toHaveLength(4);
    const always = (async () => new Response(JSON.stringify({ Information: BURST }))) as unknown as typeof fetch;
    await expect(fetchEarningsResults("k", "AAPL", always, async () => undefined)).rejects.toThrow(/per second/);
  });
});

describe("reported earnings", () => {
  it("parses Alpha Vantage EARNINGS and computes the surprise itself", () => {
    const rs = parseEarningsResults(AV, "AAPL");
    expect(rs.map((x) => x.reportedDate)).toEqual(["2026-10-30", "2026-07-30", "2026-04-30", "2026-01-29"]);
    expect(rs[0]).toMatchObject({ reportedEPS: 1.52, estimatedEPS: 1.6, surprisePct: -5 });
    expect(rs[1]!.surprisePct).toBe(3.7);
    expect(rs[3]).toMatchObject({ reportedEPS: null, surprisePct: null });
    expect(rs.map(verdictOf)).toEqual(["miss", "beat", "inline", null]);
    expect(() => parseEarningsResults({ Information: "rate limit is 25 requests per day" }, "AAPL")).toThrow(/25 requests/);
  });

  it("downloads only when a report has just passed, once a day", () => {
    const base = { today: "2026-10-31", latestReported: "2026-07-30", recentReportDates: ["2026-10-30"] };
    expect(needsResults({ ...base, lastFetch: null })).toBe(true);
    expect(needsResults({ ...base, lastFetch: "2026-10-20" })).toBe(true); // a report passed since
    expect(needsResults({ ...base, lastFetch: "2026-10-31" })).toBe(false); // already today
    expect(needsResults({ ...base, lastFetch: "2026-10-20", latestReported: "2026-10-30" })).toBe(false); // covered
    expect(needsResults({ ...base, lastFetch: "2026-10-20", recentReportDates: [] })).toBe(false);
  });

  it("rejects a beat / miss label the numbers contradict, and only that", () => {
    const results = { AAPL: [r({})] };
    expect(contradictsResults({ eventType: "earnings_beat", tickers: ["AAPL"] }, "2026-10-31", results)).toMatch(/EPS 1.52 vs estimate 1.60 \(-5%, miss\)/);
    expect(contradictsResults({ eventType: "earnings_miss", tickers: ["AAPL"] }, "2026-10-31", results)).toBeNull();
    expect(contradictsResults({ eventType: "guidance_up", tickers: ["AAPL"] }, "2026-10-31", results)).toBeNull();
    expect(contradictsResults({ eventType: "earnings_beat", tickers: ["AAPL"] }, "2026-12-15", results)).toBeNull(); // about another report
    const inline = { AAPL: [r({ reportedEPS: 1.61, surprisePct: 0.6 })] };
    expect(contradictsResults({ eventType: "earnings_beat", tickers: ["AAPL"] }, "2026-10-31", inline)).toBeNull(); // revenue may decide
  });

  it("the extractor rejects such a vote", () => {
    const doc = { source: "sec", url: "https://www.sec.gov/x", title: "Apple Q4", body: "Apple reported diluted EPS of $1.52, ahead of last year.", publishedAt: "2026-10-30T20:30:00Z", fetchedAt: "2026-10-30T22:00:00Z", sourceWeight: 1, alsoSeenIn: [] };
    const e = { relevant: true, tickers: ["AAPL"], eventType: "earnings_beat" as const, direction: 1, materiality: 2, horizon: "weeks" as const, confidence: 0.8, evidence: ["Apple reported diluted EPS of $1.52"], rationale: "EPS 1.52 ドル" };
    const ctx = { doc, candidates: { AAPL: "Apple" }, priority: new Set<string>() };
    expect(validateEvent(e, ctx)).toBeNull();
    expect(validateEvent(e, { ...ctx, crossCheck: (x) => contradictsResults(x, "2026-10-30", { AAPL: [r({})] }) })).toMatch(/contradicts reported earnings/);
    expect(validateEvent({ ...e, rationale: "EPS は 15% 増" }, ctx)).toMatch(/number not in the document: 15%/);
  });

  it("goes into the fact sheet, and a thesis may only use its numbers", () => {
    const row = { ticker: "AAPL", name: "Apple", sector: "tech", close: 200, atr: 4, momentum: 0.2, relStrength: 0.05, vol: 0.25, trend: "up" as const, lastDate: "2026-11-03", ret20: 0.02, fromHigh52: -0.03 };
    const d = buildDossier({ row, asOf: "2026-11-03", rank: 1, universe: 10, events: [], results: parseEarningsResults(AV, "AAPL") });
    expect(d.text).toContain("直近: 2026-10-30 発表（2026-09 期）: EPS 実績 1.52 / 予想 1.60（-5.0%、下振れ）");
    expect(d.text).toContain("その前: 2026-07-30 発表（2026-06 期）: EPS 実績 1.40 / 予想 1.35（+3.7%、上振れ）");
    expect(resultLines([])).toEqual(["## 決算の実績", "(データなし)"]);
    expect(buildDossier({ row, asOf: "2026-11-03", rank: 1, universe: 10, events: [] }).text).not.toContain("決算の実績"); // not connected
    const j: TradeJudgment = { stance: "neutral", conviction: 0.3, checklist: { trend: "up", news: "none" }, thesis: "EPS は予想を 5.0% 下回った", invalidation: [], evidence: ["EPS 実績 1.52 / 予想 1.60"] };
    expect(validateJudgment(j, { dossier: d, priority: false })).toBeNull();
    expect(validateJudgment({ ...j, thesis: "EPS は予想を 8% 下回った" }, { dossier: d, priority: false })).toMatch(/number not in the fact sheet: 8%/);
  });

  it("the node fetches due tickers within its cap, stops on the rate limit, and the check node drops contradicted events", async () => {
    const calls: string[] = [];
    let limited = false;
    const s = new Services(AppConfig.parse({ market: { currency: "USD", benchmark: "SPY" }, watchlist: { AAPL: { name: "Apple" }, MSFT: { name: "Microsoft" }, NVDA: { name: "NVIDIA" } } }), {
      dbPath: ":memory:", env: { ALPHAVANTAGE_API_KEY: "k" }, sleep: async () => undefined,
      fetchImpl: async (u) => {
        const sym = new URL(String(u)).searchParams.get("symbol")!;
        calls.push(sym);
        if (limited) return new Response(JSON.stringify({ Information: "rate limit" }));
        return new Response(JSON.stringify({ ...AV, symbol: sym }));
      },
    });
    const engine = new Engine({ services: s, registry: builtinRegistry(), store: s.runStore, clock: () => new Date("2026-10-31T22:00:00Z") });
    const spec = (name: string, max: number) => parseWorkflow(`name: ${name}\nnodes:\n  r: { use: data.earningsResults, params: { maxFetches: ${max} } }\n`);
    const first = await engine.run(spec("a", 2));
    expect(calls).toEqual(["AAPL", "MSFT"]); // never SPY; NVDA waits for the next run
    expect(first.output<Record<string, EarningsResult[]>>("r", "results")["AAPL"]![0]!.reportedDate).toBe("2026-10-30");
    limited = true;
    await engine.run(spec("b", 5));
    expect(calls).toEqual(["AAPL", "MSFT", "NVDA"]); // AAPL / MSFT done today; the limit stops after NVDA
    expect(s.earningsResults.lastFetch("NVDA")).toBeNull(); // not recorded as fetched

    const ev = (eventType: string): EventRecord => ({
      docHash: eventType, title: `Apple ${eventType}`, url: "https://x", source: "sec", learnedAt: "2026-10-30T22:00:00Z", agreement: 1, sourceWeight: 1, nSources: 1,
      event: { relevant: true, tickers: ["AAPL"], eventType: eventType as "earnings_beat", direction: 1, materiality: 2, horizon: "weeks", confidence: 0.8, evidence: [], rationale: "" },
    });
    const out = await checkEventsNode.run({ log: () => undefined, metric: () => undefined } as never, {}, { events: [ev("earnings_beat"), ev("guidance_up")], results: first.output("r", "results") });
    expect(out.events.map((e) => e.event.eventType)).toEqual(["guidance_up"]);
  });
});
