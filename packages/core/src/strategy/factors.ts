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
    };
  }
  return { asOf, benchmark: bench ? { ticker: bench, trend: trendLabel(prices[bench]!) } : null, rows };
}
