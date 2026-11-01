import { z } from "zod";
import { buildScorecard } from "../eval/scorecard.ts";
import { defineNode } from "../workflow/registry.ts";

export const recordPredictions = defineNode({
  type: "eval.record",
  title: "Record predictions",
  category: "eval",
  description: "Stores every judgment (stance + conviction) under a label so it can be graded once the horizon has passed.",
  version: 1,
  cache: "none",
  params: z.object({ label: z.string().optional() }),
  inputs: { judgments: { type: "Judgments" } },
  outputs: { count: { type: "Count" } },
  async run(ctx, p, i) {
    const label = p.label ?? ctx.workflow;
    const count = ctx.services.predictions.record(
      Object.values(i.judgments).map((j) => ({ label, asOf: ctx.asOf, ticker: j.ticker, stance: j.stance, conviction: j.conviction, status: j.status, runId: ctx.runId, prompt: j.prompt ?? null })),
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
