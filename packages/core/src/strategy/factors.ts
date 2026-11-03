import type { IsoDate } from "../util/dates.ts";
import { atr, momentum12_1, periodReturn, realizedVol, trendLabel, type Prices, type TrendLabel } from "../signals/technical.ts";

export interface FactorRow {
  ticker: string;
  name: string;
  sector: string;
  lastDate: IsoDate;
  close: number;
  atr: number | null;
  momentum: number | null;
  relStrength: number | null;
  vol: number | null;
  trend: TrendLabel | null;
  /** Return over the last 20 trading days. */
  ret20: number | null;
  /** close / max(close over 252 days) - 1 (0 = at the 52-week high). */
  fromHigh52: number | null;
  /** Average daily traded value (close × volume) over 20 days, in the price currency (null without volume). */
  adv20?: number | null;
}

/** Average close × volume over the last n bars (null when volume is missing). */
export function avgTradedValue(bars: readonly { close: number; volume: number }[], n = 20): number | null {
  const last = bars.slice(-n);
  if (last.length < Math.min(n, 5) || last.every((b) => !b.volume)) return null;
  return last.reduce((s, b) => s + b.close * (b.volume || 0), 0) / last.length;
}

export interface FactorTable {
  asOf: IsoDate;
  benchmark: { ticker: string; trend: TrendLabel | null } | null;
  rows: Record<string, FactorRow>;
}

/** NaN/Infinity -> null: port data must be plain JSON. */
export const finiteOrNull = (x: number): number | null => (Number.isFinite(x) ? x : null);

export function computeFactors(
  prices: Prices,
  asOf: IsoDate,
  info: (ticker: string) => { name: string; sector: string },
  opts: { benchmark?: string | undefined; relDays?: number } = {},
): FactorTable {
  const relDays = opts.relDays ?? 126;
  const bench = opts.benchmark && prices[opts.benchmark]?.length ? opts.benchmark : undefined;
  const tickers = Object.keys(prices).filter((t) => t !== bench && (prices[t]?.length ?? 0) > 0);
  const rets = tickers.map((t) => periodReturn(prices[t]!, relDays)).filter(Number.isFinite);
  const benchRet = bench ? periodReturn(prices[bench]!, relDays) : rets.reduce((a, b) => a + b, 0) / (rets.length || 1);
  const rows: Record<string, FactorRow> = {};
  for (const t of tickers) {
    const bars = prices[t]!;
    const last = bars.at(-1)!;
    rows[t] = {
      ticker: t, ...info(t), lastDate: last.date, close: last.close,
      atr: finiteOrNull(atr(bars)),
      momentum: finiteOrNull(momentum12_1(bars)),
      relStrength: finiteOrNull(periodReturn(bars, relDays) - benchRet),
      vol: finiteOrNull(realizedVol(bars)),
      trend: trendLabel(bars),
      ret20: finiteOrNull(periodReturn(bars, 20)),
      fromHigh52: bars.length >= 20 ? finiteOrNull(last.close / Math.max(...bars.slice(-252).map((b) => b.close)) - 1) : null,
      adv20: avgTradedValue(bars),
    };
  }
  return { asOf, benchmark: bench ? { ticker: bench, trend: trendLabel(prices[bench]!) } : null, rows };
}
