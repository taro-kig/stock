import type { Proposal } from "../strategy/portfolio.ts";
import type { BrokerAccount, OrderRequest } from "./broker.ts";

/**
 * Deterministic pre-trade checks. They run after sizing/limits/approval as a
 * last line of defence against bugs and misconfiguration (wrong account,
 * fat finger, shorting by accident, prices off the tick grid).
 */
export type TradingMode = "paper" | "live";

export const LIVE_ENV_VAR = "STOCKAI_LIVE_TRADING";
export const LIVE_ENV_VALUE = "yes-i-understand";

/** IBKR paper accounts start with "D" (DU…/DF…); live accounts do not. */
export function checkAccountMode(accountId: string, mode: TradingMode, opts: { expectedAccountId?: string | undefined; env: NodeJS.ProcessEnv }): string | null {
  const isPaper = /^D/i.test(accountId);
  if (opts.expectedAccountId && opts.expectedAccountId !== accountId) return `connected account ${accountId} does not match configured ${opts.expectedAccountId}`;
  if (mode === "paper" && !isPaper) return `mode is paper but ${accountId} looks like a live account — refusing`;
  if (mode === "live") {
    if (isPaper) return `mode is live but ${accountId} is a paper account`;
    if (!opts.expectedAccountId) return "live mode requires ibkr.accountId in config";
    if (opts.env[LIVE_ENV_VAR] !== LIVE_ENV_VALUE) return `live mode requires ${LIVE_ENV_VAR}=${LIVE_ENV_VALUE}`;
  }
  return null;
}

/**
 * Broker-agnostic lock for real-money trading: the configured account must be the connected
 * one, and the operator must have opted in through the environment.
 */
export function checkLiveInterlock(accountId: string, opts: { expectedAccountId?: string | undefined; env: NodeJS.ProcessEnv }): string | null {
  if (!opts.expectedAccountId) return "live trading requires accountId in config";
  if (opts.expectedAccountId !== accountId) return `connected account ${accountId} does not match configured ${opts.expectedAccountId}`;
  if (opts.env[LIVE_ENV_VAR] !== LIVE_ENV_VALUE) return `live trading requires ${LIVE_ENV_VAR}=${LIVE_ENV_VALUE}`;
  return null;
}

/** Tokyo Stock Exchange standard tick sizes (呼値). Valid for TOPIX500 names too (their ticks are finer divisors). */
const JP_TICKS: Array<[number, number]> = [
  [3_000, 1], [5_000, 5], [30_000, 10], [50_000, 50], [300_000, 100], [500_000, 500],
  [3_000_000, 1_000], [5_000_000, 5_000], [30_000_000, 10_000], [50_000_000, 50_000], [Number.POSITIVE_INFINITY, 100_000],
];

export function tickSize(price: number, market: "jp" | "us"): number {
  if (market === "us") return price >= 1 ? 0.01 : 0.0001;
  return JP_TICKS.find(([upTo]) => price <= upTo)![1];
}

/** Limit price around the reference close, on the tick grid, never more aggressive than `offsetBps`. */
export function limitPrice(side: "buy" | "sell", refPrice: number, offsetBps: number, market: "jp" | "us"): number {
  const raw = refPrice * (1 + ((side === "buy" ? 1 : -1) * offsetBps) / 10_000);
  const t = tickSize(raw, market);
  const ticks = side === "buy" ? Math.floor(raw / t + 1e-9) : Math.ceil(raw / t - 1e-9);
  return Number((ticks * t).toFixed(4));
}

export interface OrderLimits {
  maxOrderValue: number;
  maxOrdersPerRun: number;
  lotSize: number;
}

/** Returns a reason to block the order, or null. */
export function checkOrder(req: OrderRequest, account: BrokerAccount, limits: OrderLimits): string | null {
  if (!Number.isInteger(req.shares) || req.shares <= 0) return `invalid share count ${req.shares}`;
  if (!(req.limitPrice > 0)) return `invalid limit price ${req.limitPrice}`;
  if (req.side === "buy") {
    if (req.shares % limits.lotSize !== 0) return `shares ${req.shares} not a multiple of lot ${limits.lotSize}`;
    const value = req.shares * req.limitPrice;
    if (value > limits.maxOrderValue) return `order value ${Math.round(value)} exceeds maxOrderValue ${limits.maxOrderValue}`;
  } else {
    const held = account.positions.find((p) => p.ticker === req.ticker)?.shares ?? 0;
    if (req.shares > held) return `sell ${req.shares} > held ${held} (no shorting)`;
  }
  return null;
}

export function orderRef(asOf: string, account: string, p: Pick<Proposal, "ticker" | "action">): string {
  return `sa-${asOf}-${account}-${p.ticker}-${p.action}`;
}
