import { z } from "zod";
import { proposeRebalance, type Candidate } from "../strategy/portfolio.ts";
import { defineNode } from "../workflow/registry.ts";

export const accountNode = defineNode({
  type: "portfolio.account",
  title: "Paper account",
  category: "risk",
  description: "Current paper-trading account marked to market: cash, positions, equity, drawdown mode.",
  version: 1,
  cache: "none",
  params: z.object({ account: z.string().optional(), initialCash: z.number().positive().default(10_000_000) }),
  inputs: { prices: { type: "Prices" } },
  outputs: { account: { type: "Account" } },
  async run(ctx, p, i) {
    const s = ctx.services;
    const name = p.account ?? ctx.workflow;
    s.paperBook.ensure(name, p.initialCash, s.config.market.currency);
    const account = s.paperBook.state(name, ctx.asOf, i.prices, s.risk);
    ctx.metric("equity", account.equity);
    return { account };
  },
});

export const proposeNode = defineNode({
  type: "portfolio.propose",
  title: "Propose orders",
  category: "risk",
  description:
    "Turns judgments into orders under hard limits: ATR sizing, lot rounding, max weight/positions/sector, stops, drawdown kill switch. The AI decides what; these rules decide how much.",
  version: 1,
  cache: "inputs",
  params: z.object({
    topN: z.number().int().positive().default(5),
    exitRankMult: z.number().min(1).default(2),
    timeStopDays: z.number().int().positive().default(60),
    requireTrend: z.boolean().default(true),
    minConviction: z.number().min(0).max(1).default(0.5),
    regimeFilter: z.boolean().default(true),
  }),
  inputs: { judgments: { type: "Judgments" }, factors: { type: "Factors" }, account: { type: "Account" } },
  outputs: { proposals: { type: "Proposals" } },
  async run(ctx, p, i) {
    const held = Object.keys(i.account.positions);
    const js = i.judgments;
    const isBuy = (t: string) => js[t]?.stance === "bullish" && js[t].conviction >= p.minConviction;
    const scores: Record<string, number> = {};
    for (const t of new Set([...Object.keys(js), ...held])) scores[t] = isBuy(t) ? 1 + js[t]!.conviction : 0;
    const candidates: Record<string, Candidate> = {};
    for (const r of Object.values(i.factors.rows)) {
      if (r.atr === null) continue; // cannot size without volatility
      candidates[r.ticker] = { ticker: r.ticker, price: r.close, atr: r.atr, sector: r.sector, trendOk: !p.requireTrend || r.trend === "up" };
    }
    const regimeOk = !p.regimeFilter || i.factors.benchmark?.trend !== "down";
    if (!regimeOk) ctx.log(`regime filter: benchmark ${i.factors.benchmark?.ticker} is in a downtrend -> no new entries`);
    if (i.account.mode !== "normal") ctx.log(`account mode ${i.account.mode} -> no new entries`);
    ctx.metric("regimeOk", regimeOk ? 1 : 0);
    const proposals = proposeRebalance(
      {
        scores, candidates, positions: i.account.positions, equity: i.account.equity, mode: i.account.mode,
        regimeOk,
        thesisBroken: held.filter((t) => js[t]?.stance === "bearish"),
        eligible: Object.keys(js).filter(isBuy),
        // don't churn holdings the decision layer is not negative on (or did not judge)
        keep: held.filter((t) => js[t]?.stance !== "bearish"),
      },
      ctx.services.risk,
      { topN: p.topN, exitRankMult: p.exitRankMult, timeStopDays: p.timeStopDays },
    );
    ctx.metric("buys", proposals.filter((x) => x.action === "buy").length);
    ctx.metric("sells", proposals.filter((x) => x.action === "sell").length);
    return { proposals };
  },
});
