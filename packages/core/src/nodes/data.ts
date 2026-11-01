import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { barsUntil, type Bar, type Prices } from "../signals/technical.ts";
import { weekdays, type IsoDate } from "../util/dates.ts";
import type { NodeContext } from "../workflow/context.ts";
import { defineNode } from "../workflow/registry.ts";

/** Watchlist tickers plus the configured benchmark. */
function universe(ctx: NodeContext): string[] {
  const b = ctx.services.config.market.benchmark;
  return [...new Set([...ctx.services.watchlist.tickers, ...(b ? [b] : [])])];
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
  description: "Downloads daily bars from stooq.com (free). Tickers map to <code>.jp / <code>.us unless overridden.",
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
