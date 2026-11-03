import { marketOf, riskOf, watchlistOf } from "./scope.ts";
import { z } from "zod";
import { defineNode } from "../workflow/registry.ts";

export const paperBroker = defineNode({
  type: "broker.paper",
  title: "Paper broker",
  category: "execution",
  description:
    "Simulated fills at the close ± slippage ± market impact (coef × daily volatility × √(order value / average daily traded value), capped at 5%) with fees, so thinly traded stocks do not look better on paper than they would trade. Idempotent per run (resuming never double-fills).",
  version: 2,
  cache: "none",
  params: z.object({
    slippageBps: z.number().min(0).default(10),
    feeBps: z.number().min(0).default(5),
    /** Market impact scale (0 = off). */
    impactCoef: z.number().min(0).default(1),
  }),
  inputs: { proposals: { type: "Proposals" }, prices: { type: "Prices" }, account: { type: "Account" } },
  outputs: { fills: { type: "Fills" }, account: { type: "Account" } },
  async run(ctx, p, i) {
    const s = ctx.services;
    const name = i.account.account;
    const sectors = Object.fromEntries(Object.keys(s.config.watchlist).map((t) => [t, watchlistOf(ctx).sector(t)]));
    const fills = s.paperBook.apply(ctx.runId, name, ctx.asOf, i.proposals, i.prices, { ...p, lotSize: marketOf(ctx).lotSize, sectors });
    ctx.metric("fills", fills.length);
    return { fills, account: s.paperBook.state(name, ctx.asOf, i.prices, riskOf(ctx)) };
  },
});
