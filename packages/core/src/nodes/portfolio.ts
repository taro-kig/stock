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
  version: 4, // v2: no buy-back of a name sold in the same rebalance · v3: new entries only from the watchlist · v4: market risk level
  cache: "inputs",
  params: z.object({
    topN: z.number().int().positive().default(5),
    exitRankMult: z.number().min(1).default(2),
    timeStopDays: z.number().int().positive().default(60),
    requireTrend: z.boolean().default(true),
    minConviction: z.number().min(0).max(1).default(0.5),
    regimeFilter: z.boolean().default(true),
    /** No new buys this many calendar days before an earnings report (needs the earnings input; 0 = off). */
    earningsBlackoutDays: z.number().int().min(0).default(3),
    /** Size of new positions when the market input says "caution" (1 = unchanged). "stress" always stops new buys unless marketFilter is off. */
    cautionSize: z.number().min(0).max(1).default(0.5),
    marketFilter: z.boolean().default(true),
  }),
  inputs: { judgments: { type: "Judgments" }, factors: { type: "Factors" }, account: { type: "Account" }, earnings: { type: "Earnings", optional: true }, market: { type: "Market", optional: true } },
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
      const e = i.earnings?.[r.ticker];
      const blocked = e && p.earningsBlackoutDays > 0 && e.daysAway <= p.earningsBlackoutDays ? `決算まで ${e.daysAway} 日（${e.reportDate}）` : undefined;
      candidates[r.ticker] = { ticker: r.ticker, price: r.close, atr: r.atr, sector: r.sector, trendOk: !p.requireTrend || r.trend === "up", blockedReason: blocked };
      if (blocked && js[r.ticker] && isBuy(r.ticker)) ctx.log(`${r.ticker}: no new entry, ${blocked}`);
    }
    const stressed = p.marketFilter && i.market?.risk === "stress";
    const regimeOk = (!p.regimeFilter || i.factors.benchmark?.trend !== "down") && !stressed;
    if (!regimeOk) ctx.log(stressed ? `market stress (${i.market!.reasons.join(", ")}) -> no new entries` : `regime filter: benchmark ${i.factors.benchmark?.ticker} is in a downtrend -> no new entries`);
    const sizeMult = p.marketFilter && i.market?.risk === "caution" ? p.cautionSize : 1;
    if (sizeMult !== 1) ctx.log(`market caution (${i.market!.reasons.join(", ")}) -> new positions x${sizeMult}`);
    if (i.account.mode !== "normal") ctx.log(`account mode ${i.account.mode} -> no new entries`);
    ctx.metric("regimeOk", regimeOk ? 1 : 0);
    const proposals = proposeRebalance(
      {
        scores, candidates, positions: i.account.positions, equity: i.account.equity, mode: i.account.mode,
        regimeOk,
        sizeMult,
        thesisBroken: held.filter((t) => js[t]?.stance === "bearish"),
        // held names that left the watchlist are still managed (stops, exits) but never bought again
        eligible: Object.keys(js).filter((t) => isBuy(t) && t in ctx.services.watchlist.entries),
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
