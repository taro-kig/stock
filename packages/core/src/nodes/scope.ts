import { defaultMarketId, type MarketProfile } from "../markets.ts";
import type { Watchlist } from "../signals/prefilter.ts";
import type { RiskConfig } from "../strategy/risk.ts";
import type { NodeContext } from "../workflow/context.ts";

/**
 * What a node sees of the configuration for its run's market: a US workflow never gets the
 * Japanese stocks of the watchlist (and vice versa), the benchmark, currency and lot size are
 * that market's.
 */
export function marketOf(ctx: NodeContext): MarketProfile {
  return ctx.market ?? ctx.services.market(defaultMarketId(ctx.services.config));
}

export function watchlistOf(ctx: NodeContext): Watchlist {
  return ctx.services.watchlistFor(marketOf(ctx).id);
}

/** Stocks held in any account, of this market. */
export function heldOf(ctx: NodeContext): Record<string, string> {
  return ctx.services.heldTickers(marketOf(ctx).id);
}

/** Risk limits with this market's lot size. */
export function riskOf(ctx: NodeContext): RiskConfig {
  return { ...ctx.services.risk, lotSize: marketOf(ctx).lotSize };
}

export function benchmarkOf(ctx: NodeContext): string | undefined {
  return marketOf(ctx).benchmark;
}
