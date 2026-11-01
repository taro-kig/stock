import { z } from "zod";
import type { BrokerClient, OrderTicket } from "../execution/broker.ts";
import { checkAccountMode, checkOrder, limitPrice, orderRef } from "../execution/guards.ts";
import { lastClose, type AccountState } from "../execution/paper.ts";
import { tradingMode } from "../strategy/risk.ts";
import type { NodeContext } from "../workflow/context.ts";
import { defineNode } from "../workflow/registry.ts";

async function withBroker<T>(ctx: NodeContext, fn: (b: BrokerClient) => Promise<T>): Promise<T> {
  const b = await ctx.services.brokerClient();
  try {
    return await fn(b);
  } finally {
    await b.close();
  }
}

export const ibkrAccount = defineNode({
  type: "portfolio.ibkrAccount",
  title: "IBKR account",
  category: "risk",
  description:
    "Reads cash, net liquidation and positions from IBKR (via IB Gateway), checks the account matches the configured mode, and tracks entry dates / trailing highs / equity peak locally.",
  version: 1,
  cache: "none",
  params: z.object({}),
  inputs: { prices: { type: "Prices" } },
  outputs: { account: { type: "Account" } },
  async run(ctx, _p, i) {
    const s = ctx.services;
    const cfg = s.ibkrConfig;
    return withBroker(ctx, async (b) => {
      const a = await b.account();
      const bad = checkAccountMode(a.accountId, cfg.mode, { expectedAccountId: cfg.accountId, env: s.env });
      if (bad) throw new Error(bad);
      if (a.currency !== "JPY" && a.currency !== "USD") throw new Error(`unsupported base currency ${a.currency}`);
      const positions = s.brokerLedger.reconcile(a.accountId, ctx.asOf, a.positions, (t) => lastClose(i.prices, t, ctx.asOf), (t) => s.watchlist.sector(t));
      const peakEquity = s.brokerLedger.recordEquity(a.accountId, ctx.asOf, a.netLiquidation);
      const account: AccountState = {
        account: a.accountId, asOf: ctx.asOf, currency: a.currency, cash: a.cash, equity: a.netLiquidation, peakEquity,
        mode: tradingMode(a.netLiquidation, peakEquity, s.risk), positions,
      };
      ctx.metric("equity", account.equity);
      return { account };
    });
  },
});

export const ibkrBroker = defineNode({
  type: "broker.ibkr",
  title: "IBKR orders",
  category: "execution",
  description:
    "Sends approved proposals to IBKR as DAY limit orders (close ± offset, on the tick grid). Guards: account/mode interlock, no shorting, lot size, max order value, max orders per run, one order per account/day/ticker/side (idempotent).",
  version: 1,
  cache: "none",
  params: z.object({ dryRun: z.boolean().default(false) }),
  inputs: { proposals: { type: "Proposals" }, prices: { type: "Prices" }, account: { type: "Account" } },
  outputs: { orders: { type: "Orders" } },
  async run(ctx, p, i) {
    const s = ctx.services;
    const cfg = s.ibkrConfig;
    if (i.proposals.length === 0) return { orders: [] }; // e.g. rejected or timed-out approval
    // also blocks approving yesterday's proposals today: stale prices must not reach the market
    if (!ctx.live && !p.dryRun) throw new Error("broker.ibkr only sends orders for today's run (use dryRun to replay)");
    return withBroker(ctx, async (b) => {
      const a = await b.account();
      const bad = checkAccountMode(a.accountId, cfg.mode, { expectedAccountId: cfg.accountId, env: s.env });
      if (bad) throw new Error(bad);
      if (a.accountId !== i.account.account) throw new Error(`account changed between steps (${i.account.account} -> ${a.accountId})`);
      const working = new Set(await b.openOrderRefs());
      const orders: OrderTicket[] = [];
      let sent = 0;
      // sells first: they free cash and reduce risk
      for (const prop of [...i.proposals].sort((x, y) => (x.action === y.action ? 0 : x.action === "sell" ? -1 : 1))) {
        const ref = orderRef(ctx.asOf, a.accountId, prop);
        const ref0 = lastClose(i.prices, prop.ticker, ctx.asOf) ?? prop.price;
        const base: OrderTicket = {
          ref, asOf: ctx.asOf, account: a.accountId, ticker: prop.ticker, side: prop.action, shares: prop.shares,
          limitPrice: limitPrice(prop.action, ref0, cfg.limitOffsetBps, cfg.market), tif: "DAY", status: "submitted", brokerOrderId: null, message: prop.reason,
        };
        const prior = s.brokerLedger.ticket(ref);
        if (prior || working.has(ref)) {
          orders.push({ ...(prior ?? base), status: "duplicate", message: "already sent today" });
          continue;
        }
        const blocked = sent >= cfg.maxOrdersPerRun ? `maxOrdersPerRun ${cfg.maxOrdersPerRun} reached` : checkOrder(base, a, { maxOrderValue: cfg.maxOrderValue, maxOrdersPerRun: cfg.maxOrdersPerRun, lotSize: s.risk.lotSize });
        if (blocked) {
          ctx.log(`blocked ${ref}: ${blocked}`);
          orders.push({ ...base, status: "blocked", message: blocked });
          continue;
        }
        if (p.dryRun) {
          orders.push({ ...base, status: "dry_run" });
          continue;
        }
        try {
          const id = await b.placeLimitOrder(base, a.accountId);
          const t = { ...base, brokerOrderId: id };
          s.brokerLedger.recordSubmitted(t, ctx.runId);
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
