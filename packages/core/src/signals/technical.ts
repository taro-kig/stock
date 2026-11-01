import type { IsoDate } from "../util/dates.ts";

export interface Bar {
  date: IsoDate;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}
/** ticker -> daily bars, ascending by date. */
export type Prices = Record<string, Bar[]>;

export const TRADING_DAYS = 252;

export function sma(values: readonly number[], n: number): number {
  if (values.length < n) return Number.NaN;
  let s = 0;
  for (let i = values.length - n; i < values.length; i++) s += values[i]!;
  return s / n;
}

const closes = (bars: readonly Bar[]) => bars.map((b) => b.close);

/** 12-month return skipping the most recent month (classic mid-term momentum). */
export function momentum12_1(bars: readonly Bar[]): number {
  if (bars.length < TRADING_DAYS + 1) return Number.NaN;
  return bars.at(-22)!.close / bars.at(-TRADING_DAYS - 1)!.close - 1;
}

export function periodReturn(bars: readonly Bar[], days: number): number {
  if (bars.length <= days) return Number.NaN;
  return bars.at(-1)!.close / bars.at(-days - 1)!.close - 1;
}

export type TrendLabel = "up" | "flat" | "down";

export function trendLabel(bars: readonly Bar[]): TrendLabel | null {
  if (bars.length < 200) return null;
  const c = closes(bars);
  const last = c.at(-1)!;
  const s50 = sma(c, 50);
  const s200 = sma(c, 200);
  if (last > s200 && s50 > s200) return "up";
  if (last < s200 && s50 < s200) return "down";
  return "flat";
}

export function atr(bars: readonly Bar[], n = 20): number {
  if (bars.length < n + 1) return Number.NaN;
  let s = 0;
  for (let i = bars.length - n; i < bars.length; i++) {
    const b = bars[i]!;
    const prev = bars[i - 1]!.close;
    s += Math.max(b.high - b.low, Math.abs(b.high - prev), Math.abs(b.low - prev));
  }
  return s / n;
}

export function realizedVol(bars: readonly Bar[], n = 60): number {
  if (bars.length < n + 1) return Number.NaN;
  const r: number[] = [];
  for (let i = bars.length - n; i < bars.length; i++) r.push(Math.log(bars[i]!.close / bars[i - 1]!.close));
  const mean = r.reduce((a, b) => a + b, 0) / r.length;
  const variance = r.reduce((a, b) => a + (b - mean) ** 2, 0) / (r.length - 1);
  return Math.sqrt(variance * TRADING_DAYS);
}

/** Bars known at the end of `asOf` (point-in-time truncation). */
export function barsUntil(bars: readonly Bar[], asOf: IsoDate): Bar[] {
  return bars.filter((b) => b.date <= asOf);
}
