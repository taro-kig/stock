import { fundamentalsAt, type Fact, type FundamentalsMap } from "../data/fundamentals.ts";
import type { MarketContext } from "../data/market.ts";
import type { Bar, Prices } from "../signals/technical.ts";
import type { IsoDate } from "../util/dates.ts";
import { FACTOR_INFO, factorColumns } from "./factorLib.ts";
import { computeFactors } from "./factors.ts";
import { compositeScore, DEFAULT_WEIGHTS, ranks } from "./scoring.ts";

/**
 * Factor research: do the factors actually predict? On past dates (every `step` trading days),
 * each factor is computed from what was known on that date only (prices up to it, financials
 * filed by it) and compared with the excess return that followed. No LLM involved.
 *
 * Measures, per factor:
 * - IC: Spearman rank correlation between the factor and the next `horizon`-day excess return,
 *   across stocks, on each date. The mean IC is the "edge"; 0.02–0.05 is typical of real factors.
 * - t: mean IC / its standard deviation × √(number of non-overlapping dates). |t| ≥ 2 ≈ unlikely by chance.
 * - spread: average excess return of the top fifth minus the bottom fifth.
 * - decay: mean IC for 5 and 60 days ahead, to see how long the signal lasts.
 */
export interface FactorStats {
  factor: string;
  label: string;
  note: string;
  /** Dates with enough stocks to compute an IC. */
  dates: number;
  /** Average stocks with a value per date. */
  coverage: number;
  meanIC: number | null;
  /** Share of dates with a positive IC. */
  hitRate: number | null;
  /** Non-overlapping dates behind t. */
  nEff: number;
  t: number | null;
  /** Top fifth minus bottom fifth, mean excess return over the horizon. */
  spread: number | null;
  ic5: number | null;
  ic60: number | null;
  /** Mean IC within each size bucket (large / mid / small), when the universe has buckets. */
  byBucket?: Record<string, { meanIC: number | null; dates: number }>;
}

export interface FactorReport {
  asOf: IsoDate;
  horizon: number;
  step: number;
  from: IsoDate | null;
  to: IsoDate | null;
  universe: number;
  factors: FactorStats[];
  /** The composite with the weights in use, plain and sector-neutral / rank-normalized. */
  composite: FactorStats[];
  weights: Record<string, number>;
  /** Weights from the measured ICs, shrunk toward the current ones while the sample is small. A suggestion: nothing changes by itself. */
  suggested: Record<string, number>;
  notes: string[];
}

function indexAtOrBefore(bars: readonly Bar[], date: IsoDate): number {
  let lo = 0;
  let hi = bars.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid]!.date <= date) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

/** Spearman rank correlation of paired values (null with fewer than `min` pairs). */
export function spearman(x: Record<string, number | null | undefined>, y: Record<string, number | null | undefined>, min = 10): number | null {
  const keys = Object.keys(x).filter((k) => typeof x[k] === "number" && Number.isFinite(x[k]) && typeof y[k] === "number" && Number.isFinite(y[k]));
  if (keys.length < min) return null;
  const rx = ranks(Object.fromEntries(keys.map((k) => [k, x[k]])));
  const ry = ranks(Object.fromEntries(keys.map((k) => [k, y[k]])));
  const n = keys.length;
  const m = (n + 1) / 2;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (const k of keys) {
    const a = rx[k]! - m;
    const b = ry[k]! - m;
    sxy += a * b;
    sxx += a * a;
    syy += b * b;
  }
  return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : null;
}

function quintileSpread(x: Record<string, number | null>, y: Record<string, number | null>): number | null {
  const keys = Object.keys(x).filter((k) => x[k] != null && y[k] != null).sort((a, b) => x[a]! - x[b]!);
  const q = Math.floor(keys.length / 5);
  if (q < 2) return null;
  const mean = (ks: string[]) => ks.reduce((s, k) => s + y[k]!, 0) / ks.length;
  return mean(keys.slice(-q)) - mean(keys.slice(0, q));
}

const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

export interface ResearchInput {
  asOf: IsoDate;
  prices: Prices;
  /** Ticker → sector (the stocks measured). */
  universe: Record<string, string>;
  benchmark?: string | undefined;
  /** Sector → ETF, for the sector factor's history. */
  sectorEtfs?: Record<string, string>;
  /** Stored SEC facts per ticker (financial factors are skipped when absent). */
  facts?: Record<string, Fact[]>;
  weights?: Record<string, number>;
  horizon?: number;
  step?: number;
  lookbackDays?: number;
  /** Fewest stocks with a value for a date to count. */
  minStocks?: number;
  /** Ticker → size bucket, for IC per bucket. */
  buckets?: Record<string, string>;
}

export function researchFactors(r: ResearchInput): FactorReport {
  const horizon = r.horizon ?? 20;
  const step = r.step ?? 5;
  const minStocks = r.minStocks ?? 15;
  const weights = r.weights ?? DEFAULT_WEIGHTS;
  const bench = r.benchmark && r.prices[r.benchmark]?.length ? r.benchmark : undefined;
  const tickers = Object.keys(r.universe).filter((t) => (r.prices[t]?.length ?? 0) > 0);
  const notes: string[] = [];
  const clock = bench ? r.prices[bench]! : r.prices[tickers[0] ?? ""] ?? [];
  const startDate = new Date(Date.parse(`${r.asOf}T00:00:00Z`) - (r.lookbackDays ?? 730) * 86_400_000).toISOString().slice(0, 10);
  // dates where the longest horizon (60) may still be unknown; IC uses what is known
  const lastIdx = indexAtOrBefore(clock, r.asOf);
  const dates: IsoDate[] = [];
  for (let i = lastIdx - horizon; i >= 0 && clock[i]!.date >= startDate; i -= step) dates.unshift(clock[i]!.date);

  type Daily = { cols: Record<string, Record<string, number | null>>; fwd: Record<number, Record<string, number | null>> };
  const daily: Daily[] = [];
  const fwdOf = (t: string, d: IsoDate, h: number): number | null => {
    const bars = r.prices[t]!;
    const i = indexAtOrBefore(bars, d);
    if (i < 0 || bars[i]!.date !== d || i + h >= bars.length || bars[i + h]!.date > r.asOf) return null;
    const own = bars[i + h]!.close / bars[i]!.close - 1;
    if (!bench) return own;
    const b = r.prices[bench]!;
    const j = indexAtOrBefore(b, d);
    const k = indexAtOrBefore(b, bars[i + h]!.date);
    return j < 0 || k <= j ? null : own - (b[k]!.close / b[j]!.close - 1);
  };
  const ret60 = (bars: Bar[] | undefined, d: IsoDate) => {
    if (!bars) return null;
    const i = indexAtOrBefore(bars, d);
    return i >= 60 ? bars[i]!.close / bars[i - 60]!.close - 1 : null;
  };

  for (const d of dates) {
    const cut: Prices = {};
    for (const t of [...tickers, ...(bench ? [bench] : [])]) {
      const bars = r.prices[t]!;
      const i = indexAtOrBefore(bars, d);
      if (i >= 0) cut[t] = bars.slice(0, i + 1);
    }
    const table = computeFactors(cut, d, (t) => ({ name: t, sector: r.universe[t] ?? "unknown" }), { benchmark: bench });
    const rows = Object.values(table.rows).filter((x) => x.lastDate === d && x.ticker in r.universe);
    let fundamentals: FundamentalsMap | undefined;
    if (r.facts && Object.keys(r.facts).length) {
      fundamentals = {};
      for (const row of rows) {
        const f = r.facts[row.ticker] ? fundamentalsAt(row.ticker, r.facts[row.ticker]!, d) : null;
        if (f) fundamentals[row.ticker] = f;
      }
    }
    let market: MarketContext | undefined;
    if (r.sectorEtfs) {
      const b60 = bench ? ret60(r.prices[bench], d) : null;
      const sectors: MarketContext["sectors"] = {};
      for (const [sector, etf] of Object.entries(r.sectorEtfs)) {
        const x = ret60(r.prices[etf], d);
        if (x !== null) sectors[sector] = { sector, etf, ret20: null, ret60: x, rel60: b60 === null ? x : x - b60, rank: null };
      }
      if (Object.keys(sectors).length) market = { asOf: d, benchmark: null, sectors, macro: [], risk: "normal", reasons: [] };
    }
    const cols = factorColumns({ asOf: d, rows, fundamentals, market });
    const ts = rows.map((x) => x.ticker);
    const sectorOf = Object.fromEntries(rows.map((x) => [x.ticker, x.sector]));
    cols["__composite"] = compositeScore(cols, ts, weights);
    cols["__composite_sector"] = compositeScore(cols, ts, weights, { sectorOf });
    cols["__composite_rank"] = compositeScore(cols, ts, weights, { method: "rank" });
    const fwd: Daily["fwd"] = {};
    for (const h of [5, horizon, 60]) fwd[h] = Object.fromEntries(ts.map((t) => [t, fwdOf(t, d, h)]));
    daily.push({ cols, fwd });
  }

  const stats = (factor: string, label: string, note: string): FactorStats => {
    const ics: number[] = [];
    const spreads: number[] = [];
    const covered: number[] = [];
    const ic5: number[] = [];
    const ic60: number[] = [];
    const icByDate: Array<number | null> = [];
    const bucketNames = [...new Set(Object.values(r.buckets ?? {}))];
    const perBucket = new Map<string, number[]>(bucketNames.map((b) => [b, []]));
    for (const day of daily) {
      const xb = day.cols[factor];
      if (xb && r.buckets) {
        for (const b of bucketNames) {
          const keep = (o: Record<string, number | null>) => Object.fromEntries(Object.entries(o).filter(([t]) => r.buckets![t] === b));
          const v = spearman(keep(xb), keep(day.fwd[horizon]!), Math.max(8, Math.floor(minStocks / 2)));
          if (v !== null) perBucket.get(b)!.push(v);
        }
      }
      const x = day.cols[factor];
      if (!x) {
        icByDate.push(null);
        continue;
      }
      covered.push(Object.values(x).filter((v) => v != null).length);
      const ic = spearman(x, day.fwd[horizon]!, minStocks);
      icByDate.push(ic);
      if (ic !== null) ics.push(ic);
      const sp = quintileSpread(x, day.fwd[horizon]!);
      if (sp !== null) spreads.push(sp);
      const a = spearman(x, day.fwd[5]!, minStocks);
      if (a !== null) ic5.push(a);
      const b = spearman(x, day.fwd[60]!, minStocks);
      if (b !== null) ic60.push(b);
    }
    // non-overlapping: every ceil(horizon / step)-th date
    const every = Math.max(1, Math.ceil(horizon / step));
    const indep = icByDate.filter((v, i): v is number => i % every === 0 && v !== null);
    const m = avg(indep);
    const sd = indep.length > 1 && m !== null ? Math.sqrt(indep.reduce((s, v) => s + (v - m) ** 2, 0) / (indep.length - 1)) : null;
    return {
      factor, label, note, dates: ics.length, coverage: avg(covered) ?? 0,
      meanIC: avg(ics), hitRate: ics.length ? ics.filter((v) => v > 0).length / ics.length : null,
      nEff: indep.length, t: m !== null && sd ? (m / sd) * Math.sqrt(indep.length) : null,
      spread: avg(spreads), ic5: avg(ic5), ic60: avg(ic60),
      ...(bucketNames.length > 1 ? { byBucket: Object.fromEntries([...perBucket].map(([b, xs]) => [b, { meanIC: avg(xs), dates: xs.length }])) } : {}),
    };
  };

  const present = new Set(daily.flatMap((d) => Object.keys(d.cols)));
  const factors = Object.keys(FACTOR_INFO).filter((f) => present.has(f)).map((f) => stats(f, FACTOR_INFO[f]!.label, FACTOR_INFO[f]!.note));
  const composite = [
    stats("__composite", "合成スコア（今の重み）", "signal.score と同じ計算"),
    stats("__composite_sector", "合成スコア（業種内で比較）", "sectorNeutral: true"),
    stats("__composite_rank", "合成スコア（順位で正規化）", "normalize: rank"),
  ];

  // IC-proportional weights (only factors with t ≥ 1), shrunk toward the current weights: λ = n / (n + 24)
  const usable = factors.filter((f) => f.meanIC !== null && f.meanIC > 0 && (f.t ?? 0) >= 1);
  const nEff = Math.min(...factors.map((f) => f.nEff), Number.POSITIVE_INFINITY);
  const lambda = Number.isFinite(nEff) ? nEff / (nEff + 24) : 0;
  const icSum = usable.reduce((s, f) => s + f.meanIC!, 0);
  const curSum = Object.entries(weights).filter(([k]) => present.has(k)).reduce((s, [, w]) => s + w, 0) || 1;
  const suggested: Record<string, number> = {};
  for (const f of factors) {
    const fromIC = icSum > 0 && usable.includes(f) ? f.meanIC! / icSum : 0;
    const cur = (weights[f.factor] ?? 0) / curSum;
    // same scale as the current weights of the measured factors, so the two columns compare directly
    const w = (lambda * fromIC + (1 - lambda) * cur) * curSum;
    if (w > 0.005) suggested[f.factor] = Math.round(w * 100) / 100;
  }

  if (!bench) notes.push("ベンチマークの株価が無いため、超過リターンではなく素のリターンで測定");
  if (!r.facts || !Object.keys(r.facts).length) notes.push("財務データ（SEC）が無いため、品質・成長・SUE は測定していない");
  notes.push("イベント・インサイダー・予想修正は、検証用の銘柄群に過去データが無いため測定していない");
  notes.push("今の大型株で過去を測るため、勝ち組を選ぶ因子（モメンタム・52週高値）はやや良く見える（生存者バイアス）");
  if (dates.length < 50) notes.push(`測定した日付が ${dates.length} 日と少ない。株価の履歴が溜まると精度が上がる`);

  return {
    asOf: r.asOf, horizon, step, from: dates[0] ?? null, to: dates.at(-1) ?? null, universe: tickers.length,
    factors, composite, weights, suggested, notes,
  };
}
