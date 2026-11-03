import { z } from "zod";

/**
 * Markets the system can watch side by side. Each has its own currency, benchmark, lot size,
 * holidays and data sources; a workflow is for one market (decided by its nodes, see
 * workflowMarket) and only sees that market's part of the watchlist. Accounts stay in one
 * currency each, so US and Japanese results are never added up without an exchange rate.
 */
export const MARKET_IDS = ["us", "jp"] as const;
export type MarketId = (typeof MARKET_IDS)[number];

export const MARKET_LABEL: Record<MarketId, string> = { us: "米国株", jp: "日本株" };

const DEFAULTS: Record<MarketId, { currency: "USD" | "JPY"; benchmark: string; lotSize: number }> = {
  us: { currency: "USD", benchmark: "SPY", lotSize: 1 },
  jp: { currency: "JPY", benchmark: "1306", lotSize: 100 },
};

/** One market as written in config.yaml (`markets.us`, `markets.jp`); everything has a default. */
export const MarketConfig = z.strictObject({
  /** Ticker of the index ETF used for relative strength, the regime filter and grading. */
  benchmark: z.string().optional(),
  /** Shares per trading unit (100 for Japanese stocks). */
  lotSize: z.number().int().positive().optional(),
});
export type MarketConfig = z.output<typeof MarketConfig>;

export const MarketsConfig = z.strictObject({ us: MarketConfig.optional(), jp: MarketConfig.optional() });
export type MarketsConfig = z.output<typeof MarketsConfig>;

export interface MarketProfile {
  id: MarketId;
  label: string;
  currency: "USD" | "JPY";
  /** Unset only for the default market of an older config that never named one (as before). */
  benchmark: string | undefined;
  lotSize: number;
}

/** Japanese codes are 4 characters: 4 digits (7203) or 3 digits and a letter (130A). Everything else is US. */
export function marketOfTicker(ticker: string): MarketId {
  return /^\d{3}[0-9A-Z]$/.test(ticker) ? "jp" : "us";
}

/** The parts of the config this module reads (kept narrow so config.ts can depend on it). */
export interface MarketSource {
  market: { currency: "USD" | "JPY"; benchmark?: string | undefined };
  markets?: MarketsConfig | undefined;
  risk: { lotSize: number };
}

/** The market of the legacy `market:` block: workflows that are for no market in particular (demo) run in it. */
export function defaultMarketId(c: MarketSource): MarketId {
  return c.market.currency === "USD" ? "us" : "jp";
}

/**
 * Settings of one market: `markets.<id>`, else (for the default market) the legacy `market:` /
 * `risk.lotSize`, else the built-in defaults (SPY / 1 share, 1306 / 100 shares).
 */
export function marketProfile(c: MarketSource, id: MarketId): MarketProfile {
  const own = c.markets?.[id];
  const legacy = defaultMarketId(c) === id;
  const d = DEFAULTS[id];
  return {
    id,
    label: MARKET_LABEL[id],
    currency: d.currency,
    benchmark: own?.benchmark ?? (legacy ? c.market.benchmark : d.benchmark),
    lotSize: own?.lotSize ?? (legacy ? c.risk.lotSize : d.lotSize),
  };
}

export function marketProfiles(c: MarketSource): Record<MarketId, MarketProfile> {
  return { us: marketProfile(c, "us"), jp: marketProfile(c, "jp") };
}
