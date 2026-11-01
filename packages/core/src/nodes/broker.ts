import { z } from "zod";
import { defineNode } from "../workflow/registry.ts";

export const paperBroker = defineNode({
  type: "broker.paper",
  title: "Paper broker",
  category: "execution",
  description: "Simulated fills at the close ± slippage with fees. Idempotent per run (resuming never double-fills).",
  version: 1,
  cache: "none",
  params: z.object({ slippageBps: z.number().min(0).default(10), feeBps: z.number().min(0).default(5) }),
  inputs: { proposals: { type: "Proposals" }, prices: { type: "Prices" }, account: { type: "Account" } },
  outputs: { fills: { type: "Fills" }, account: { type: "Account" } },
  async run(ctx, p, i) {
    const s = ctx.services;
    const name = i.account.account;
    const sectors = Object.fromEntries(Object.keys(s.config.watchlist).map((t) => [t, s.watchlist.sector(t)]));
    const fills = s.paperBook.apply(ctx.runId, name, ctx.asOf, i.proposals, i.prices, { ...p, lotSize: s.risk.lotSize, sectors });
    ctx.metric("fills", fills.length);
    return { fills, account: s.paperBook.state(name, ctx.asOf, i.prices, s.risk) };
  },
});
