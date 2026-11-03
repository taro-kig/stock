import { z } from "zod";
import { fundamentalsAt, parseCompanyFacts } from "../data/fundamentals.ts";
import { SecClient } from "../data/sec.ts";
import { loadTwelveData } from "../nodes/data.ts";
import type { Services } from "../services.ts";
import type { Prices } from "../signals/technical.ts";
import { factorColumns } from "../strategy/factorLib.ts";
import type { FactorReport } from "../strategy/factorResearch.ts";
import { computeFactors } from "../strategy/factors.ts";
import { compositeScore } from "../strategy/scoring.ts";
import { addDays, toIsoDate, type IsoDate } from "../util/dates.ts";
import type { NodeContext } from "../workflow/context.ts";
import { BUCKET_JA, parseFrame, SIZE_BUCKETS, sicToSector, type SizeBucket } from "./companies.ts";
import { SECTORS } from "./suggest.ts";

/**
 * Finds stocks from data instead of from a model's memory (which is thin for small companies):
 * 1. the whole market at once from SEC: NYSE / Nasdaq listings × public float (size) × last
 *    year's revenue growth and operating margin (XBRL frames, a handful of requests);
 * 2. filters (size, sector, growth, margin) and a pre-rank, then for a short list only: the
 *    sector (SIC), the company's filings and prices (Twelve Data, 1 credit each);
 * 3. liquidity and price checks, and a final rank with the same factor library as the score
 *    (weights from the latest factor research when there is one).
 * Every reason shown is a number computed here.
 */
export const ScreenRequest = z.strictObject({
  sizes: z.array(z.enum(SIZE_BUCKETS)).min(1).default(["mid", "small"]),
  /** Empty = all sectors. */
  sectors: z.array(z.enum(SECTORS)).default([]),
  count: z.number().int().min(1).max(25).default(10),
  /** Last fiscal year's revenue growth at least this (fraction, e.g. 0.1 = +10%). */
  minRevenueGrowth: z.number().min(-1).max(10).optional(),
  minOperatingMargin: z.number().min(-1).max(1).optional(),
  minPrice: z.number().min(0).default(5),
  minTradedValue: z.number().min(0).default(5_000_000),
  /** Stocks whose prices are downloaded (Twelve Data: 1 credit and ~8 per minute each). */
  maxPriceLookups: z.number().int().min(1).max(60).default(20),
});
export type ScreenRequest = z.input<typeof ScreenRequest>;

export interface ScreenCandidate {
  ticker: string;
  name: string;
  sector: string;
  bucket: SizeBucket;
  exchange: string;
  cik: number;
  float: number;
  revenueGrowth: number | null;
  operatingMargin: number | null;
  price: number | null;
  tradedValue: number | null;
  momentum: number | null;
  score: number;
  /** One line of the numbers behind it. */
  reason: string;
}

export interface ScreenResult {
  asOf: IsoDate;
  request: z.output<typeof ScreenRequest>;
  candidates: ScreenCandidate[];
  /** How many passed each step (for the reviewer). */
  funnel: Array<{ step: string; count: number }>;
  weights: Record<string, number>;
  weightsFrom: "factor-research" | "default";
  notes: string[];
}

/** Last complete calendar year with annual frames, and the one before. */
export function frameYears(today: IsoDate): [number, number] {
  const y = Number(today.slice(0, 4));
  const last = Number(today.slice(5, 7)) >= 5 ? y - 1 : y - 2; // most 10-Ks are in by April
  return [last, last - 1];
}

async function annual(sec: SecClient, concepts: string[], year: number): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  for (const c of concepts) {
    try {
      for (const r of parseFrame(await sec.json(`https://data.sec.gov/api/xbrl/frames/us-gaap/${c}/USD/CY${year}.json`))) if (!out.has(r.cik)) out.set(r.cik, r.val);
    } catch {
      // concept / year not published
    }
  }
  return out;
}

const REVENUE = ["RevenueFromContractWithCustomerExcludingAssessedTax", "Revenues", "SalesRevenueNet"];
const pct = (x: number | null) => (x === null ? "不明" : `${x >= 0 ? "+" : ""}${(x * 100).toFixed(0)}%`);
const usd = (x: number) => (x >= 1e9 ? `$${(x / 1e9).toFixed(1)}B` : `$${(x / 1e6).toFixed(0)}M`);

/** Default ranking weights when no factor research is available. */
const SCREEN_WEIGHTS = { quality: 0.25, growth: 0.25, momentum: 0.25, high52: 0.15, sue: 0.1 };

export async function screenStocks(
  s: Services,
  req: ScreenRequest,
  o: { now?: Date; report?: FactorReport | null; exclude?: readonly string[]; log?: (m: string) => void } = {},
): Promise<ScreenResult> {
  const r = ScreenRequest.parse(req);
  const now = o.now ?? new Date();
  const day = toIsoDate(now);
  const ua = s.env["SEC_USER_AGENT"];
  if (!ua) throw new Error("SEC_USER_AGENT が未設定です（⚙ 設定）。データでの銘柄探しには SEC のデータを使います");
  const sec = new SecClient({ userAgent: ua, fetchImpl: s.fetch, sleep: s.sleep });
  const notes: string[] = [];
  const funnel: ScreenResult["funnel"] = [];
  const exclude = new Set([...(o.exclude ?? []), ...s.watchlist.tickers, ...(s.config.market.benchmark ? [s.config.market.benchmark] : [])]);

  // 1. the whole market
  const market = (await s.companies.market(sec, now)).filter((c) => !exclude.has(c.ticker));
  funnel.push({ step: "NYSE / Nasdaq で規模が分かる会社", count: market.length });
  const sized = market.filter((c) => r.sizes.includes(c.bucket));
  funnel.push({ step: `規模: ${r.sizes.map((b) => BUCKET_JA[b]).join("・")}`, count: sized.length });
  const [y1, y0] = frameYears(day);
  const rev1 = await annual(sec, REVENUE, y1);
  const rev0 = await annual(sec, REVENUE, y0);
  const op1 = await annual(sec, ["OperatingIncomeLoss"], y1);
  const rows = sized.map((c) => {
    const a = rev1.get(c.cik);
    const b = rev0.get(c.cik);
    const op = op1.get(c.cik);
    return {
      ...c,
      revenueGrowth: a !== undefined && b !== undefined && b > 0 ? a / b - 1 : null,
      operatingMargin: a !== undefined && op !== undefined && a > 0 ? op / a : null,
    };
  });
  const passed = rows.filter((c) =>
    (r.minRevenueGrowth === undefined || (c.revenueGrowth !== null && c.revenueGrowth >= r.minRevenueGrowth)) &&
    (r.minOperatingMargin === undefined || (c.operatingMargin !== null && c.operatingMargin >= r.minOperatingMargin)));
  funnel.push({ step: `財務の条件（${y1} 年の売上の伸び・営業利益率）`, count: passed.length });

  // 2. pre-rank on what is known for everyone, then the short list
  const pre = compositeScore(
    { growth: Object.fromEntries(passed.map((c) => [c.ticker, c.revenueGrowth])), quality: Object.fromEntries(passed.map((c) => [c.ticker, c.operatingMargin])) },
    passed.map((c) => c.ticker), { growth: 0.5, quality: 0.5 }, { method: "rank" },
  );
  const ordered = [...passed].sort((a, b) => pre[b.ticker]! - pre[a.ticker]!);
  const short: Array<(typeof rows)[number] & { sector: string }> = [];
  let lookups = 0;
  for (const c of ordered) {
    if (short.length >= r.maxPriceLookups || lookups >= 200) break;
    let sector = c.sector;
    if (!sector) {
      lookups++;
      try {
        const { sic } = await s.companies.sic(sec, c.cik, day);
        sector = sic === null ? null : sicToSector(sic);
      } catch {
        continue;
      }
    }
    if (!sector || (r.sectors.length && !r.sectors.includes(sector as (typeof SECTORS)[number]))) continue;
    short.push({ ...c, sector });
  }
  funnel.push({ step: `業種${r.sectors.length ? `（${r.sectors.join("・")}）` : ""}で絞った上位`, count: short.length });
  if (!short.length) return { asOf: day, request: r, candidates: [], funnel, weights: {}, weightsFrom: "default", notes };

  // prices (local copy first) and the companies' filings
  const ctx = { services: s, asOf: addDays(day, 0), wallNow: () => now, live: true, log: o.log ?? (() => undefined) } as unknown as NodeContext;
  let prices: Prices = {};
  try {
    prices = (await loadTwelveData(ctx, short.map((c) => c.ticker), { apiKeyEnv: "TWELVEDATA_API_KEY", symbols: {}, historyBars: 300, perMinute: 8, maxStaleDays: 5 })).prices;
  } catch (e) {
    notes.push(`株価を取得できない（${e instanceof Error ? e.message : String(e)}）`);
  }
  const fundamentals: Record<string, NonNullable<ReturnType<typeof fundamentalsAt>>> = {};
  for (const c of short) {
    try {
      if (s.fundamentals.lastFetch(c.ticker) !== day) {
        s.fundamentals.save(c.ticker, day, parseCompanyFacts(await sec.json(`https://data.sec.gov/api/xbrl/companyfacts/CIK${String(c.cik).padStart(10, "0")}.json`)));
      }
      const f = fundamentalsAt(c.ticker, s.fundamentals.facts(c.ticker, day), day);
      if (f) fundamentals[c.ticker] = f;
    } catch {
      // financials are optional for the ranking
    }
  }

  // 3. liquidity, price, rank
  const table = computeFactors(Object.fromEntries(short.filter((c) => prices[c.ticker]?.length).map((c) => [c.ticker, prices[c.ticker]!])), day, (t) => ({ name: t, sector: short.find((c) => c.ticker === t)!.sector }));
  const ok = short.filter((c) => {
    const row = table.rows[c.ticker];
    if (!row) return false;
    if (row.close < r.minPrice) return false;
    if (row.adv20 != null && row.adv20 < r.minTradedValue) return false;
    return true;
  });
  funnel.push({ step: `株価 $${r.minPrice} 以上・売買代金 ${usd(r.minTradedValue)}/日 以上`, count: ok.length });
  const fromReport = o.report?.suggested && Object.keys(o.report.suggested).length ? o.report.suggested : null;
  const weights = fromReport ?? SCREEN_WEIGHTS;
  const cols = factorColumns({ asOf: day, rows: ok.map((c) => table.rows[c.ticker]!), fundamentals });
  const score = compositeScore(cols, ok.map((c) => c.ticker), weights, { method: "rank" });
  const candidates = ok
    .map((c): ScreenCandidate => {
      const row = table.rows[c.ticker]!;
      const f = fundamentals[c.ticker];
      const growth = f?.revenueTtmYoY ?? c.revenueGrowth;
      const margin = f?.operatingMargin ?? c.operatingMargin;
      return {
        ticker: c.ticker, name: c.name, sector: c.sector, bucket: c.bucket, exchange: c.exchange, cik: c.cik, float: c.float,
        revenueGrowth: growth, operatingMargin: margin, price: row.close, tradedValue: row.adv20 ?? null, momentum: row.momentum, score: score[c.ticker] ?? 0,
        reason: [
          `${BUCKET_JA[c.bucket]}（浮動株 ${usd(c.float)}）`,
          `売上 ${pct(growth)}`,
          `営業利益率 ${margin === null ? "不明" : `${(margin * 100).toFixed(0)}%`}`,
          `12-1モメンタム ${pct(row.momentum)}`,
          row.adv20 != null ? `売買代金 ${usd(row.adv20)}/日` : "",
        ].filter(Boolean).join("、"),
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, r.count);
  funnel.push({ step: "提案", count: candidates.length });
  if (!fromReport) notes.push("因子の検証の結果が無いため、既定の重み（品質・成長・モメンタム・52週高値・SUE）で並べた");
  notes.push("財務の条件は SEC に提出された直近の通期データ。売上の伸びは前年の通期比");
  return { asOf: day, request: r, candidates, funnel, weights, weightsFrom: fromReport ? "factor-research" : "default", notes };
}
