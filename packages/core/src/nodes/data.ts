import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { isCovered, syncBars } from "../data/priceSync.ts";
import { TwelveDataAuthError, TwelveDataClient } from "../data/twelveData.ts";
import { barsUntil, type Bar, type Prices } from "../signals/technical.ts";
import { addDays, toIsoDate, weekdays, type IsoDate } from "../util/dates.ts";
import { fetchEarningsCalendar } from "../data/earnings.ts";
import { AlphaVantageLimit, fetchEarningsResults, needsResults } from "../data/earningsResults.ts";
import { fetchEarningsEstimates, isPremiumAnswer } from "../data/estimates.ts";
import type { NodeContext } from "../workflow/context.ts";
import { defineNode } from "../workflow/registry.ts";

/** Watchlist tickers, anything still held (even if removed from the watchlist) and the benchmark. */
export function universe(ctx: NodeContext): string[] {
  const b = ctx.services.config.market.benchmark;
  return [...new Set([...ctx.services.watchlist.tickers, ...Object.keys(ctx.services.heldTickers()), ...(b ? [b] : [])])];
}

/** Parses "Date,Open,High,Low,Close,Volume" CSV (any column order, case-insensitive). */
export function parsePriceCsv(text: string): Bar[] {
  const [header, ...lines] = text.trim().split(/\r?\n/);
  const cols = (header ?? "").toLowerCase().split(",").map((c) => c.trim());
  const ix = (name: string) => {
    const i = cols.indexOf(name);
    if (i < 0) throw new Error(`price CSV missing column "${name}"`);
    return i;
  };
  const [d, o, h, l, c] = ["date", "open", "high", "low", "close"].map(ix) as [number, number, number, number, number];
  const v = cols.indexOf("volume");
  const bars: Bar[] = [];
  for (const line of lines) {
    const f = line.split(",");
    const bar = { date: f[d]!.trim(), open: Number(f[o]), high: Number(f[h]), low: Number(f[l]), close: Number(f[c]), volume: v >= 0 ? Number(f[v]) : 0 };
    if (/^\d{4}-\d{2}-\d{2}$/.test(bar.date) && [bar.open, bar.high, bar.low, bar.close].every((x) => Number.isFinite(x) && x > 0)) bars.push(bar);
  }
  return bars.sort((a, b) => a.date.localeCompare(b.date));
}

export const csvPrices = defineNode({
  type: "data.pricesCsv",
  title: "Prices (CSV)",
  category: "data",
  description: "Reads <dir>/<ticker>.csv for the watchlist and benchmark, truncated at the run date.",
  version: 1,
  cache: "daily",
  params: z.object({ dir: z.string() }),
  inputs: {},
  outputs: { prices: { type: "Prices" } },
  async run(ctx, p) {
    const prices: Prices = {};
    for (const t of universe(ctx)) {
      const f = join(p.dir, `${t}.csv`);
      if (!existsSync(f)) {
        ctx.log(`no price file for ${t}`);
        continue;
      }
      prices[t] = barsUntil(parsePriceCsv(readFileSync(f, "utf8")), ctx.asOf);
    }
    if (!Object.keys(prices).length) throw new Error(`no price data found in ${p.dir}`);
    return { prices };
  },
});

export const stooqPrices = defineNode({
  type: "data.pricesStooq",
  title: "Prices (Stooq)",
  category: "data",
  description:
    "Downloads daily bars from stooq.com. Since 2026 stooq requires an API key and a browser check, so this usually fails; use data.pricesJQuants (JP), data.pricesTwelveData (US) or data.pricesCsv.",
  version: 1,
  cache: "daily",
  params: z.object({ market: z.enum(["jp", "us"]), symbols: z.record(z.string(), z.string()).default({}) }),
  inputs: {},
  outputs: { prices: { type: "Prices" } },
  async run(ctx, p) {
    const prices: Prices = {};
    for (const t of universe(ctx)) {
      const sym = p.symbols[t] ?? `${t.toLowerCase()}.${p.market}`;
      try {
        const res = await fetch(`https://stooq.com/q/d/l/?s=${encodeURIComponent(sym)}&i=d`, { signal: AbortSignal.timeout(20_000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        prices[t] = barsUntil(parsePriceCsv(await res.text()), ctx.asOf);
      } catch (e) {
        ctx.log(`stooq ${sym} failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (!Object.keys(prices).length) throw new Error("no price data from stooq");
    return { prices };
  },
});

const JQUANTS_URL = "https://api.jquants.com/v2/equities/bars/daily";
const JQUANTS_RETRY_WAIT_MS = 120_000; // 429 carries no Retry-After; J-Quants recommends waiting up to 2 minutes
const JQUANTS_MAX_429 = 2;

/** The fields we read from one /v2/equities/bars/daily record. Days without trades are all null. */
export interface JQuantsRow {
  Date: string;
  AdjO: number | null;
  AdjH: number | null;
  AdjL: number | null;
  AdjC: number | null;
  AdjVo: number | null;
}

/** Split-adjusted bars, dropping days without trades. */
export function parseJQuantsBars(rows: readonly JQuantsRow[]): Bar[] {
  const bars: Bar[] = [];
  for (const r of rows) {
    if (r.AdjO === null || r.AdjH === null || r.AdjL === null || r.AdjC === null) continue;
    bars.push({ date: r.Date, open: r.AdjO, high: r.AdjH, low: r.AdjL, close: r.AdjC, volume: r.AdjVo ?? 0 });
  }
  return bars.sort((a, b) => a.date.localeCompare(b.date));
}

/** 401/403: no other ticker can succeed either, so the node stops instead of waiting through the rest. */
export class JQuantsAuthError extends Error {}

export interface JQuantsClientOptions {
  apiKey: string;
  requestsPerMinute: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

/** Rate-limited client; every page counts as one request. */
export function jquantsClient(o: JQuantsClientOptions) {
  const fetchImpl = o.fetchImpl ?? fetch;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const spacingMs = Math.ceil((60_000 / o.requestsPerMinute) * 1.1); // the limit uses a sliding window: keep a margin
  let requested = false;

  async function page(code: string, paginationKey: string | undefined): Promise<{ data: JQuantsRow[]; pagination_key?: string }> {
    const url = new URL(JQUANTS_URL);
    url.searchParams.set("code", code);
    if (paginationKey) url.searchParams.set("pagination_key", paginationKey);
    for (let limited = 0; ; limited++) {
      if (requested) await sleep(spacingMs);
      requested = true;
      const res = await fetchImpl(url, { headers: { "x-api-key": o.apiKey }, signal: AbortSignal.timeout(30_000) });
      if (res.status === 429 && limited < JQUANTS_MAX_429) {
        await sleep(JQUANTS_RETRY_WAIT_MS);
        continue;
      }
      if (res.status === 401 || res.status === 403) throw new JQuantsAuthError(`J-Quants rejected the API key (HTTP ${res.status})`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return (await res.json()) as { data: JQuantsRow[]; pagination_key?: string };
    }
  }

  return {
    async bars(code: string): Promise<Bar[]> {
      const rows: JQuantsRow[] = [];
      let key: string | undefined;
      do {
        const r = await page(code, key);
        rows.push(...r.data);
        key = r.pagination_key;
      } while (key);
      return parseJQuantsBars(rows);
    },
  };
}

export const jquantsPrices = defineNode({
  type: "data.pricesJQuants",
  title: "Prices (J-Quants)",
  category: "data",
  description: "Downloads split-adjusted daily bars from J-Quants (JPX). Needs JQUANTS_API_KEY. Fails rather than decide on stale prices: the Free plan omits the latest 12 weeks.",
  version: 1,
  cache: "daily",
  params: z.object({
    requestsPerMinute: z.number().positive().default(5), // Free: 5, Light: 60, Standard: 120
    maxStaleDays: z.number().int().positive().default(7),
  }),
  inputs: {},
  outputs: { prices: { type: "Prices" } },
  async run(ctx, p) {
    const apiKey = ctx.services.env["JQUANTS_API_KEY"];
    if (!apiKey) throw new Error("JQUANTS_API_KEY is not set (settings screen or .env)");
    const client = jquantsClient({ apiKey, requestsPerMinute: p.requestsPerMinute });
    const prices: Prices = {};
    let stale = 0;
    for (const t of universe(ctx)) {
      try {
        const bars = barsUntil(await client.bars(t), ctx.asOf);
        const last = bars.at(-1)?.date;
        if (!last || (Date.parse(ctx.asOf) - Date.parse(last)) / 86_400_000 > p.maxStaleDays) {
          ctx.log(`jquants ${t} is stale: latest bar ${last ?? "none"}, run date ${ctx.asOf}`);
          stale++;
          continue;
        }
        prices[t] = bars;
      } catch (e) {
        if (e instanceof JQuantsAuthError) throw e;
        ctx.log(`jquants ${t} failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (!Object.keys(prices).length) {
      throw new Error(stale ? `J-Quants prices are older than ${p.maxStaleDays} days (the Free plan omits the latest 12 weeks)` : "no price data from J-Quants");
    }
    return { prices };
  },
});

export const twelveDataPrices = defineNode({
  type: "data.pricesTwelveData",
  title: "Prices (Twelve Data)",
  category: "data",
  description:
    "US daily bars from Twelve Data (free plan: 800 requests/day, 8/min; key in TWELVEDATA_API_KEY). Keeps a local copy, so daily runs download only the last bars and replays of past dates need no network.",
  version: 1,
  cache: "daily",
  params: z.object({
    apiKeyEnv: z.string().default("TWELVEDATA_API_KEY"),
    /** Ticker -> Twelve Data symbol when they differ. */
    symbols: z.record(z.string(), z.string()).default({}),
    historyBars: z.number().int().min(300).max(5000).default(1000),
    perMinute: z.number().positive().default(8),
    /** Use the local copy when a download fails, if its last bar is at most this many days old. */
    maxStaleDays: z.number().int().min(0).default(5),
  }),
  inputs: {},
  outputs: { prices: { type: "Prices" } },
  async run(ctx, p) {
    const s = ctx.services;
    const store = s.priceStore;
    const SRC = "twelvedata";
    let client: TwelveDataClient | undefined;
    const api = () => {
      if (client) return client;
      const key = s.env[p.apiKeyEnv];
      if (!key) throw new TwelveDataAuthError(`${p.apiKeyEnv} is not set (get a free key at twelvedata.com and put it in .env)`);
      return (client = new TwelveDataClient({ apiKey: key, perMinute: p.perMinute, fetchImpl: s.fetch, sleep: s.sleep }));
    };
    const prices: Prices = {};
    const counts = { cached: 0, update: 0, full: 0, stale: 0, failed: 0 };
    for (const t of universe(ctx)) {
      const sym = p.symbols[t] ?? t;
      let bars: Bar[];
      if (isCovered(store, SRC, t, ctx.asOf)) {
        bars = store.bars(SRC, t);
        counts.cached++;
      } else {
        try {
          const r = await syncBars(store, api(), SRC, t, sym, ctx.wallNow(), { historyBars: p.historyBars });
          bars = r.bars;
          counts[r.fetch === "full" ? "full" : "update"]++;
        } catch (e) {
          if (e instanceof TwelveDataAuthError) throw e; // every other ticker would fail the same way
          const msg = e instanceof Error ? e.message : String(e);
          bars = store.bars(SRC, t).filter((b) => b.date <= ctx.asOf);
          const last = bars.at(-1)?.date;
          if (last && last >= addDays(ctx.asOf, -p.maxStaleDays)) {
            counts.stale++;
            ctx.log(`${sym}: download failed, using local copy through ${last}: ${msg}`);
          } else {
            counts.failed++;
            ctx.log(`${sym}: download failed and no recent local copy: ${msg}`);
            continue;
          }
        }
      }
      const until = barsUntil(bars, ctx.asOf);
      if (until.length) prices[t] = until;
    }
    for (const [k, v] of Object.entries(counts)) ctx.metric(k, v);
    if (!Object.keys(prices).length) throw new Error("no price data from Twelve Data");
    return { prices };
  },
});

export const earningsCalendar = defineNode({
  type: "data.earnings",
  title: "Earnings calendar",
  category: "data",
  description:
    "Next earnings date per ticker (US). Downloads the Alpha Vantage calendar once a day (free key ALPHAVANTAGE_API_KEY: 25 requests/day, one is enough) and keeps what was known on each day, so replays only see dates known at the time.",
  version: 1,
  cache: "daily",
  params: z.object({ apiKeyEnv: z.string().default("ALPHAVANTAGE_API_KEY"), staleDays: z.number().int().min(1).default(7) }),
  inputs: {},
  outputs: { earnings: { type: "Earnings" } },
  async run(ctx, p) {
    const s = ctx.services;
    const today = toIsoDate(ctx.wallNow());
    if (ctx.live && !s.earnings.fetchedOn(today)) {
      const key = s.env[p.apiKeyEnv];
      if (!key) {
        // optional feature: no key is a choice, not a failure (the run stays green)
        ctx.log(`${p.apiKeyEnv} is not set: no earnings calendar (free key at alphavantage.co, settings screen)`);
        ctx.metric("disabled", 1);
        return { earnings: {} };
      }
      try {
        const entries = await fetchEarningsCalendar(key, s.fetch);
        s.earnings.save(today, entries, ctx.wallNow());
        // keep today's consensus for our companies: the record that estimate revisions are computed from
        const ours = new Set(universe(ctx));
        s.estimates.saveCalendar(today, entries.filter((e) => ours.has(e.ticker)));
        ctx.metric("downloaded", entries.length);
      } catch (e) {
        const last = s.earnings.lastFetch();
        if (!last || last.day < addDays(today, -p.staleDays)) throw e;
        ctx.log(`download failed, using the calendar from ${last.day}: ${e instanceof Error ? e.message : String(e)}`);
        ctx.metric("stale", 1);
      }
    }
    const earnings = s.earnings.nextFor(universe(ctx), ctx.asOf, p.staleDays);
    ctx.metric("tickers", Object.keys(earnings).length);
    ctx.metric("within7d", Object.values(earnings).filter((e) => e.daysAway <= 7).length);
    return { earnings };
  },
});

export const earningsResultsNode = defineNode({
  type: "data.earningsResults",
  title: "Earnings results",
  category: "data",
  description:
    "Reported EPS vs consensus per ticker (US, Alpha Vantage EARNINGS, same free key as the calendar). Downloads a ticker only when a report has just passed or it was never fetched (at most maxFetches per run, once a day per ticker) to stay within 25 requests/day. Beat / miss is computed here, not read by a model.",
  version: 1,
  cache: "daily",
  params: z.object({
    apiKeyEnv: z.string().default("ALPHAVANTAGE_API_KEY"),
    /** Requests per run (the free key allows 25 a day; the calendar uses one). */
    maxFetches: z.number().int().min(0).max(20).default(5),
    /** How far back a passed report date triggers a download. */
    lookbackDays: z.number().int().min(1).max(30).default(10),
  }),
  inputs: {},
  outputs: { results: { type: "EarningsResults" } },
  async run(ctx, p) {
    const s = ctx.services;
    const benchmark = s.config.market.benchmark;
    const tickers = universe(ctx).filter((t) => t !== benchmark); // an index ETF has no earnings
    const today = toIsoDate(ctx.wallNow());
    if (ctx.live) {
      const key = s.env[p.apiKeyEnv];
      if (!key) {
        ctx.log(`${p.apiKeyEnv} is not set: no reported earnings (free key at alphavantage.co, settings screen)`);
        ctx.metric("disabled", 1);
        return { results: {} };
      }
      const due = tickers.filter((t) => needsResults({
        lastFetch: s.earningsResults.lastFetch(t), latestReported: s.earningsResults.latestReported(t),
        recentReportDates: s.earnings.reportDates(t, addDays(today, -p.lookbackDays), today), today,
      }));
      let fetched = 0;
      for (const t of due.slice(0, p.maxFetches)) {
        try {
          s.earningsResults.save(t, today, await fetchEarningsResults(key, t, s.fetch));
          fetched++;
        } catch (e) {
          ctx.log(`${t}: ${e instanceof Error ? e.message : String(e)}`);
          if (e instanceof AlphaVantageLimit) break; // rate limit / bad key: try again tomorrow
        }
      }
      ctx.metric("fetched", fetched);
      if (due.length > p.maxFetches) ctx.metric("deferred", due.length - p.maxFetches);
    }
    const results = s.earningsResults.recent(tickers, ctx.asOf);
    ctx.metric("tickers", Object.keys(results).length);
    return { results };
  },
});

export const estimatesNode = defineNode({
  type: "data.estimates",
  title: "Analyst estimate revisions",
  category: "data",
  description:
    "How the consensus EPS estimate moved over ~30 / ~90 days, with up / down revision counts when available. Always uses our own daily record of the calendar's consensus (from data.earnings, free); also asks Alpha Vantage EARNINGS_ESTIMATES (same key, weekly per ticker, max maxFetches per run) and falls back silently when the key cannot use it.",
  version: 1,
  cache: "daily",
  params: z.object({
    apiKeyEnv: z.string().default("ALPHAVANTAGE_API_KEY"),
    /** API requests per run (the free key allows 25 a day, shared with the calendar and results). 0 = calendar record only. */
    maxFetches: z.number().int().min(0).max(20).default(4),
    refreshDays: z.number().int().min(1).max(60).default(7),
  }),
  inputs: {},
  outputs: { estimates: { type: "Estimates" } },
  async run(ctx, p) {
    const s = ctx.services;
    const benchmark = s.config.market.benchmark;
    const tickers = universe(ctx).filter((t) => t !== benchmark);
    const today = toIsoDate(ctx.wallNow());
    const key = s.env[p.apiKeyEnv];
    if (ctx.live && key && p.maxFetches > 0) {
      const due = tickers.filter((t) => {
        const last = s.estimates.lastFetch(t);
        return !last || last <= addDays(today, -p.refreshDays);
      });
      let fetched = 0;
      for (const t of due.slice(0, p.maxFetches)) {
        try {
          s.estimates.save(t, today, await fetchEarningsEstimates(key, t, s.fetch));
          fetched++;
        } catch (e) {
          if (isPremiumAnswer(e)) {
            ctx.log("EARNINGS_ESTIMATES is not available to this key: using our own calendar record only");
            ctx.metric("apiUnavailable", 1);
            break;
          }
          ctx.log(`${t}: ${e instanceof Error ? e.message : String(e)}`);
          if (e instanceof AlphaVantageLimit) break;
        }
      }
      ctx.metric("fetched", fetched);
    }
    const estimates = s.estimates.at(tickers, ctx.asOf);
    ctx.metric("tickers", Object.keys(estimates).length);
    ctx.metric("withRevision", Object.values(estimates).filter((rs) => rs.some((r) => r.change30 !== null)).length);
    return { estimates };
  },
});

/** mulberry32: small, fast, seedable PRNG. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seedOf(s: string, base: number): number {
  let h = base;
  for (const ch of s) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return h >>> 0;
}

/** Deterministic random-walk bars; the value on a date never depends on the run date (point-in-time safe). */
export function syntheticBars(ticker: string, start: IsoDate, end: IsoDate, seed: number, vol: number): Bar[] {
  const r = rng(seedOf(ticker, seed));
  const normal = () => Math.sqrt(-2 * Math.log(r() || 1e-12)) * Math.cos(2 * Math.PI * r());
  let price = 1000 + r() * 4000;
  let mu = 0;
  const out: Bar[] = [];
  for (const date of weekdays(start, end)) {
    mu = 0.98 * mu + 0.0004 * normal(); // slowly drifting trend so regimes change
    const ret = mu + (vol / Math.sqrt(252)) * normal();
    const open = price;
    price = Math.max(1, price * Math.exp(ret));
    const span = Math.abs(normal()) * (vol / Math.sqrt(252)) * price * 0.5;
    out.push({ date, open, high: Math.max(open, price) + span, low: Math.max(0.5, Math.min(open, price) - span), close: price, volume: Math.round(1e5 + r() * 1e6) });
  }
  return out;
}

export const syntheticPrices = defineNode({
  type: "data.pricesSynthetic",
  title: "Prices (synthetic)",
  category: "data",
  description: "Seeded random-walk prices for offline demos and tests. Has no relation to real markets.",
  version: 1,
  cache: "daily",
  params: z.object({ seed: z.number().int().default(42), start: z.string().default("2024-06-03"), vol: z.number().positive().default(0.25) }),
  inputs: {},
  outputs: { prices: { type: "Prices" } },
  async run(ctx, p) {
    const prices: Prices = {};
    for (const t of universe(ctx)) prices[t] = syntheticBars(t, p.start, ctx.asOf, p.seed, p.vol);
    return { prices };
  },
});
