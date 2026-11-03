import { marketOf, riskOf, watchlistOf } from "./scope.ts";
import { z } from "zod";
import type { BrokerClient, OrderTicket } from "../execution/broker.ts";
import { checkAccountMode, checkLiveInterlock, checkOrder, limitPrice, orderRef } from "../execution/guards.ts";
import { trackOrders } from "../execution/tracking.ts";
import { lastClose, type AccountState } from "../execution/paper.ts";
import type { BrokerKind } from "../services.ts";
import { tradingMode } from "../strategy/risk.ts";
import type { NodeContext } from "../workflow/context.ts";
import { defineNode } from "../workflow/registry.ts";

/** What differs between brokers; everything else (sizing, guards, idempotency, ledger) is shared. */
interface Profile {
  label: string;
  limits: { limitOffsetBps: number; maxOrderValue: number; maxOrdersPerRun: number; market: "jp" | "us" };
  /** Reason the connected account must not be used, or null. */
  accountGuard(accountId: string): string | null;
  /** Orders are only previewed (e.g. Webull has no paper account). */
  forceDryRun: boolean;
}

function profile(ctx: NodeContext, kind: BrokerKind): Profile {
  const s = ctx.services;
  if (kind === "ibkr") {
    const c = s.ibkrConfig;
    return { label: "IBKR", limits: c, forceDryRun: false, accountGuard: (id) => checkAccountMode(id, c.mode, { expectedAccountId: c.accountId, env: s.env }) };
  }
  const c = s.webullConfig;
  return {
    label: "Webull",
    limits: c,
    forceDryRun: c.trading !== "live",
    accountGuard: (id) =>
      c.trading === "live"
        ? checkLiveInterlock(id, { expectedAccountId: c.accountId, env: s.env })
        : c.accountId && c.accountId !== id
          ? `connected account ${id} does not match configured ${c.accountId}`
          : null,
  };
}

async function withBroker<T>(ctx: NodeContext, kind: BrokerKind, fn: (b: BrokerClient) => Promise<T>): Promise<T> {
  const b = await ctx.services.brokerClient(kind);
  try {
    return await fn(b);
  } finally {
    await b.close();
  }
}

function accountNode(type: string, kind: BrokerKind, title: string, description: string) {
  return defineNode({
    type, title, category: "risk", description, version: 1, cache: "none",
    params: z.object({}),
    inputs: { prices: { type: "Prices" } },
    outputs: { account: { type: "Account" } },
    async run(ctx, _p, i) {
      const s = ctx.services;
      const prof = profile(ctx, kind);
      return withBroker(ctx, kind, async (b) => {
        const a = await b.account();
        const bad = prof.accountGuard(a.accountId);
        if (bad) throw new Error(bad);
        if (a.currency !== "JPY" && a.currency !== "USD") throw new Error(`unsupported base currency ${a.currency}`);
        // what became of the orders sent earlier (filled / partly / not), before anything new is decided
        if (ctx.live) {
          try {
            const updates = await trackOrders(s.brokerLedger, b, a, ctx.wallNow());
            for (const u of updates) if (u.state !== "working") ctx.log(`${u.side} ${u.ticker} ${u.shares}: ${u.note}${u.fillPrice ? ` @ ${u.fillPrice.toFixed(2)}` : ""}`);
            for (const st of ["working", "filled", "partial", "unfilled"] as const) ctx.metric(`orders_${st}`, updates.filter((u) => u.state === st).length);
          } catch (e) {
            ctx.log(`order tracking failed: ${e instanceof Error ? e.message : String(e)}`);
            ctx.metric("trackingFailed", 1);
          }
        }
        const positions = s.brokerLedger.reconcile(a.accountId, ctx.asOf, a.positions, (t) => lastClose(i.prices, t, ctx.asOf), (t) => watchlistOf(ctx).sector(t));
        const peakEquity = s.brokerLedger.recordEquity(a.accountId, ctx.asOf, a.netLiquidation, a.currency);
        const account: AccountState = {
          account: a.accountId, asOf: ctx.asOf, currency: a.currency, cash: a.cash, equity: a.netLiquidation, peakEquity,
          mode: tradingMode(a.netLiquidation, peakEquity, riskOf(ctx)), positions,
        };
        ctx.metric("equity", account.equity);
        return { account };
      });
    },
  });
}

function orderNode(type: string, kind: BrokerKind, title: string, description: string) {
  return defineNode({
    type, title, category: "execution", description, version: 1, cache: "none",
    params: z.object({ dryRun: z.boolean().default(false) }),
    inputs: { proposals: { type: "Proposals" }, prices: { type: "Prices" }, account: { type: "Account" } },
    outputs: { orders: { type: "Orders" } },
    async run(ctx, p, i) {
      const s = ctx.services;
      const prof = profile(ctx, kind);
      const dryRun = p.dryRun || prof.forceDryRun;
      if (i.proposals.length === 0) return { orders: [] }; // e.g. rejected or timed-out approval
      // also blocks approving yesterday's proposals today: stale prices must not reach the market
      if (!ctx.live && !dryRun) throw new Error(`${type} only sends orders for today's run (use dryRun to replay)`);
      return withBroker(ctx, kind, async (b) => {
        const a = await b.account();
        const bad = prof.accountGuard(a.accountId);
        if (bad) throw new Error(bad);
        if (a.accountId !== i.account.account) throw new Error(`account changed between steps (${i.account.account} -> ${a.accountId})`);
        const working = new Set(await b.openOrderRefs());
        const key = (ref: string) => b.refKey?.(ref) ?? ref;
        const orders: OrderTicket[] = [];
        let sent = 0;
        // sells first: they free cash and reduce risk
        for (const prop of [...i.proposals].sort((x, y) => (x.action === y.action ? 0 : x.action === "sell" ? -1 : 1))) {
          const ref = orderRef(ctx.asOf, a.accountId, prop);
          const ref0 = lastClose(i.prices, prop.ticker, ctx.asOf) ?? prop.price;
          const base: OrderTicket = {
            ref, asOf: ctx.asOf, account: a.accountId, ticker: prop.ticker, side: prop.action, shares: prop.shares,
            limitPrice: limitPrice(prop.action, ref0, prof.limits.limitOffsetBps, prof.limits.market), tif: "DAY", status: "submitted", brokerOrderId: null, message: prop.reason,
          };
          const prior = s.brokerLedger.ticket(ref);
          if (prior || working.has(key(ref))) {
            orders.push({ ...(prior ?? base), status: "duplicate", message: "already sent today" });
            continue;
          }
          const blocked = sent >= prof.limits.maxOrdersPerRun
            ? `maxOrdersPerRun ${prof.limits.maxOrdersPerRun} reached`
            : checkOrder(base, a, { maxOrderValue: prof.limits.maxOrderValue, maxOrdersPerRun: prof.limits.maxOrdersPerRun, lotSize: marketOf(ctx).lotSize });
          if (blocked) {
            ctx.log(`blocked ${ref}: ${blocked}`);
            orders.push({ ...base, status: "blocked", message: blocked });
            continue;
          }
          if (dryRun) {
            if (!b.previewLimitOrder) {
              orders.push({ ...base, status: "dry_run" });
              continue;
            }
            try {
              orders.push({ ...base, status: "dry_run", message: `${prof.label} preview ok: ${await b.previewLimitOrder(base, a.accountId)}` });
            } catch (e) {
              orders.push({ ...base, status: "error", message: `${prof.label} preview rejected: ${e instanceof Error ? e.message : String(e)}` });
            }
            continue;
          }
          try {
            const before = a.positions.find((x) => x.ticker === base.ticker);
            const t = { ...base, brokerOrderId: await b.placeLimitOrder(base, a.accountId) };
            s.brokerLedger.recordSubmitted(t, ctx.runId, { shares: before?.shares ?? 0, avgCost: before?.avgCost ?? null });
            orders.push(t);
            sent++;
          } catch (e) {
            orders.push({ ...base, status: "error", message: e instanceof Error ? e.message : String(e) });
          }
        }
        for (const st of ["submitted", "duplicate", "blocked", "error", "dry_run"] as const) ctx.metric(st, orders.filter((o) => o.status === st).length);
        return { orders };
      });
    },
  });
}

const ORDER_RULES =
  "DAY limit orders at close ± offset on the tick grid. Guards: account/mode interlock, no shorting, lot size, max order value, max orders per run, one order per account/day/ticker/side (idempotent).";

export const ibkrAccount = accountNode(
  "portfolio.ibkrAccount", "ibkr", "IBKR account",
  "Reads cash, net liquidation and positions from IBKR (via IB Gateway), checks the account matches the configured mode, and tracks entry dates / trailing highs / equity peak locally.",
);
export const ibkrBroker = orderNode("broker.ibkr", "ibkr", "IBKR orders", `Sends approved proposals to IBKR. ${ORDER_RULES}`);

export const webullAccount = accountNode(
  "portfolio.webullAccount", "webull", "Webull account",
  "Reads cash, market value and positions from Webull Japan OpenAPI (needs an approved access token: `stockai webull auth`) and tracks entry dates / trailing highs / equity peak locally.",
);
export const webullBroker = orderNode(
  "broker.webull", "webull", "Webull orders",
  `Sends approved proposals to Webull Japan. In trading: dry_run (default) every order is only previewed by Webull — nothing is placed. ${ORDER_RULES}`,
);
