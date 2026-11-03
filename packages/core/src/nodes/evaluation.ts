import { z } from "zod";
import { buildScorecard } from "../eval/scorecard.ts";
import { SECTOR_ETFS } from "../data/market.ts";
import { researchFactors } from "../strategy/factorResearch.ts";
import { defineNode } from "../workflow/registry.ts";
import { researchBuckets, researchUniverse } from "./data.ts";

export const recordPredictions = defineNode({
  type: "eval.record",
  title: "Record predictions",
  category: "eval",
  description: "Stores every judgment (stance, conviction, thesis, each model's vote, the events behind it) under a label so it can be graded once the horizon has passed, split by model and event type, and read back as the previous judgment.",
  version: 2,
  cache: "none",
  params: z.object({ label: z.string().optional() }),
  inputs: { judgments: { type: "Judgments" } },
  outputs: { count: { type: "Count" } },
  async run(ctx, p, i) {
    const label = p.label ?? ctx.workflow;
    const count = ctx.services.predictions.record(
      Object.values(i.judgments).map((j) => ({
        label, asOf: ctx.asOf, ticker: j.ticker, stance: j.stance, conviction: j.conviction, status: j.status, runId: ctx.runId, prompt: j.prompt ?? null,
        thesis: j.thesis || null, invalidation: j.invalidation.length ? j.invalidation : null,
        votes: j.votes.length ? j.votes.map((v) => ({ provider: v.provider, ...(v.model ? { model: v.model } : {}), stance: v.stance, rejected: v.rejected !== null })) : null,
        events: j.sources?.length ? j.sources.map((s) => ({ eventType: s.eventType, direction: s.direction })) : null,
      })),
    );
    return { count };
  },
});

export const scorecardNode = defineNode({
  type: "eval.scorecard",
  title: "Scorecard",
  category: "eval",
  description:
    "Grades all matured predictions vs the benchmark: hit rate, coverage, conviction calibration, non-overlapping sample size and a Wilson lower bound used for the promotion rule.",
  version: 1,
  cache: "none",
  params: z.object({
    horizonDays: z.number().int().positive().default(20),
    minNEff: z.number().int().positive().default(100),
    minWilsonLow: z.number().min(0).max(1).default(0.5),
    baselineLabel: z.string().optional(),
  }),
  inputs: { prices: { type: "Prices" } },
  outputs: { scorecard: { type: "Scorecard" } },
  async run(ctx, p, i) {
    const preds = ctx.services.predictions.all(ctx.asOf);
    return {
      scorecard: buildScorecard(preds, i.prices, ctx.asOf, p.horizonDays, { minNEff: p.minNEff, minWilsonLow: p.minWilsonLow, baselineLabel: p.baselineLabel }, ctx.services.config.market.benchmark),
    };
  },
});

export const factorResearchNode = defineNode({
  type: "eval.factors",
  title: "Factor research",
  category: "eval",
  description:
    "Measures how well each scoring factor predicted the next weeks' excess return on past dates (point in time: prices up to each date, financials filed by it): rank IC, t-statistic on non-overlapping dates, top-minus-bottom fifth, decay at 5 / 60 days, and the composite with the current weights (plain, sector-neutral, rank). Suggests weights; changes nothing by itself. No LLM.",
  version: 1,
  cache: "daily",
  params: z.object({
    /** Trading days ahead. */
    horizon: z.number().int().min(5).max(60).default(20),
    /** Measure every n trading days. */
    step: z.number().int().min(1).max(20).default(5),
    lookbackDays: z.number().int().min(180).max(3650).default(730),
    minStocks: z.number().int().min(5).default(15),
    /** Weights of the composite to evaluate (default: the score node's defaults). */
    weights: z.record(z.string(), z.number()).optional(),
    /** research: the factor-research stocks · watchlist: the stocks you trade (few stocks → noisy). */
    universe: z.enum(["research", "watchlist"]).default("research"),
  }),
  inputs: {
    prices: { type: "Prices" },
    /** Only as a signal that financials were downloaded; their history is read from the local store. */
    fundamentals: { type: "Fundamentals", optional: true },
  },
  outputs: { report: { type: "FactorReport" } },
  async run(ctx, p, i) {
    const s = ctx.services;
    const universe = p.universe === "research"
      ? researchUniverse(ctx)
      : Object.fromEntries(s.watchlist.tickers.map((t) => [t, s.watchlist.sector(t)]));
    const facts = i.fundamentals && Object.keys(i.fundamentals).length
      ? Object.fromEntries(Object.keys(universe).map((t) => [t, s.fundamentals.facts(t, ctx.asOf)]))
      : undefined;
    const report = researchFactors({
      asOf: ctx.asOf, prices: i.prices, universe, benchmark: s.config.market.benchmark, sectorEtfs: SECTOR_ETFS, facts,
      ...(p.universe === "research" ? { buckets: researchBuckets(ctx) } : {}),
      ...(p.weights ? { weights: p.weights } : {}), horizon: p.horizon, step: p.step, lookbackDays: p.lookbackDays, minStocks: p.minStocks,
    });
    ctx.metric("dates", report.factors[0]?.dates ?? 0);
    ctx.metric("stocks", report.universe);
    for (const f of report.factors) if (f.meanIC !== null) ctx.metric(`ic_${f.factor}`, Math.round(f.meanIC * 1000) / 1000);
    return { report };
  },
});
