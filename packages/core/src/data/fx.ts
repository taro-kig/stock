import type { Services } from "../services.ts";
import { addDays, toIsoDate, type IsoDate } from "../util/dates.ts";
import { fetchFredSeries } from "./market.ts";
import { TwelveDataClient } from "./twelveData.ts";

/**
 * The USD/JPY rate, kept like prices (source "fx", ticker "USDJPY"), so US and Japanese accounts
 * can be shown together. Twelve Data (forex is on the free plan, 1 credit) when its key is set,
 * else FRED's DEXJPUS (noon New York buying rate, one day behind). Refreshed at most once a day.
 */
const SOURCE = "fx";
const TICKER = "USDJPY";

export interface FxRate {
  /** Yen per dollar. */
  rate: number;
  date: IsoDate;
}

export function latestUsdJpy(s: Services, asOf?: IsoDate): FxRate | null {
  const bars = s.priceStore.bars(SOURCE, TICKER).filter((b) => !asOf || b.date <= asOf);
  const last = bars.at(-1);
  return last ? { rate: last.close, date: last.date } : null;
}

/** Downloads the recent rates unless done today. Returns where they came from, or why not. */
export async function refreshUsdJpy(s: Services, now: Date): Promise<{ status: "fresh" | "updated" | "unavailable"; detail: string }> {
  const last = s.priceStore.lastFetch(SOURCE, TICKER);
  if (last && toIsoDate(last) === toIsoDate(now)) return { status: "fresh", detail: "今日は取得済み" };
  const td = s.env["TWELVEDATA_API_KEY"];
  const fred = s.env["FRED_API_KEY"];
  if (td) {
    const bars = await new TwelveDataClient({ apiKey: td, perMinute: 8, fetchImpl: s.fetch, sleep: s.sleep }).dailyBars("USD/JPY", { outputsize: 30 });
    if (bars.length) {
      s.priceStore.upsert(SOURCE, TICKER, bars.map((b) => ({ ...b, volume: 0 })));
      s.priceStore.markFetched(SOURCE, TICKER, now);
      return { status: "updated", detail: `Twelve Data USD/JPY ${bars.at(-1)!.close}（${bars.at(-1)!.date}）` };
    }
  }
  if (fred) {
    const obs = await fetchFredSeries(fred, "DEXJPUS", addDays(toIsoDate(now), -40), s.fetch);
    const bars = obs.map((o) => ({ date: o.date, open: o.value, high: o.value, low: o.value, close: o.value, volume: 0 }));
    if (bars.length) {
      s.priceStore.upsert(SOURCE, TICKER, bars);
      s.priceStore.markFetched(SOURCE, TICKER, now);
      return { status: "updated", detail: `FRED DEXJPUS ${bars.at(-1)!.close}（${bars.at(-1)!.date}）` };
    }
  }
  return { status: "unavailable", detail: "TWELVEDATA_API_KEY も FRED_API_KEY も無いため為替レートを取得できない" };
}

/** Converts between yen and dollars at the given rate. */
export function convert(amount: number, from: "USD" | "JPY", to: "USD" | "JPY", rate: number): number {
  if (from === to) return amount;
  return from === "USD" ? amount * rate : amount / rate;
}
