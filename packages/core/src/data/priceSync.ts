import type { Bar } from "../signals/technical.ts";
import type { IsoDate } from "../util/dates.ts";
import type { PriceStore } from "./priceStore.ts";

export interface BarSource {
  dailyBars(symbol: string, q: { outputsize?: number; startDate?: string }): Promise<Bar[]>;
}

export interface SyncOptions {
  /** Bars to download the first time (≥ 1 year is needed for 12-1 momentum and the 52-week high). */
  historyBars: number;
  /** Already-stored bars re-downloaded on each update, to catch late corrections and re-adjustments. */
  overlap?: number;
  /** A stored close differing by more than this means the history was re-adjusted (split): download it all again. */
  adjustTolerance?: number;
}

export interface SyncResult {
  bars: Bar[];
  /** none: served from the local copy; update: last bars only; full: whole history. */
  fetch: "none" | "update" | "full";
}

/**
 * When the bars for `asOf` are final. US regular sessions close at 20:00 UTC (EDT) or
 * 21:00 UTC (EST); providers publish the daily bar shortly after.
 */
const settledAt = (asOf: IsoDate) => new Date(`${asOf}T22:00:00Z`);

/** True if the local copy already holds everything that can exist up to `asOf`. */
export function isCovered(store: PriceStore, source: string, ticker: string, asOf: IsoDate): boolean {
  const bars = store.bars(source, ticker);
  if (bars.some((b) => b.date > asOf)) return true;
  const last = store.lastFetch(source, ticker);
  return last !== null && bars.length > 0 && last >= settledAt(asOf);
}

/** Brings the local copy of one ticker up to date and returns its full history (not truncated). */
export async function syncBars(
  store: PriceStore,
  api: BarSource,
  source: string,
  ticker: string,
  symbol: string,
  wallNow: Date,
  o: SyncOptions,
): Promise<SyncResult> {
  const overlap = o.overlap ?? 5;
  const tol = o.adjustTolerance ?? 0.002;
  const cached = store.bars(source, ticker);
  if (cached.length > overlap) {
    const from = cached[cached.length - 1 - overlap]!.date;
    const fresh = await api.dailyBars(symbol, { startDate: from });
    const byDate = new Map(cached.map((b) => [b.date, b]));
    const readjusted = fresh.some((b) => {
      const old = byDate.get(b.date);
      return old !== undefined && Math.abs(b.close - old.close) / old.close > tol;
    });
    if (!readjusted) {
      store.upsert(source, ticker, fresh);
      store.markFetched(source, ticker, wallNow);
      return { bars: store.bars(source, ticker), fetch: "update" };
    }
  }
  const all = await api.dailyBars(symbol, { outputsize: o.historyBars });
  if (!all.length) throw new Error(`${symbol}: no bars returned`);
  store.replace(source, ticker, all);
  store.markFetched(source, ticker, wallNow);
  return { bars: all, fetch: "full" };
}
