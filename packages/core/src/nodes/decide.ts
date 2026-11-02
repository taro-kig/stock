import { z } from "zod";
import { buildDossier, Judge, type Judgment } from "../ai/judge.ts";
import { BudgetExceeded } from "../harness/budget.ts";
import { earningsReactions, previousJudgment } from "../strategy/history.ts";
import { rankTickers } from "../strategy/scoring.ts";
import { addDays } from "../util/dates.ts";
import { defineNode } from "../workflow/registry.ts";

export const rulesDecide = defineNode({
  type: "decide.rules",
  title: "Decide (rules)",
  category: "decision",
  description: "Baseline: bullish on the top-N by composite score (optionally only in an up-trend), bearish on the bottom-N.",
  version: 1,
  cache: "inputs",
  params: z.object({ topN: z.number().int().positive().default(5), bottomN: z.number().int().min(0).default(0), requireTrend: z.boolean().default(true) }),
  inputs: { scores: { type: "Scores" }, factors: { type: "Factors" } },
  outputs: { judgments: { type: "Judgments" } },
  async run(_ctx, p, i) {
    const ranked = rankTickers(i.scores);
    const n = ranked.length;
    const judgments: Record<string, Judgment> = {};
    ranked.forEach((t, idx) => {
      const row = i.factors.rows[t];
      const top = idx < p.topN && (!p.requireTrend || row?.trend === "up");
      const bottom = idx >= n - p.bottomN;
      judgments[t] = {
        ticker: t, stance: top ? "bullish" : bottom ? "bearish" : "neutral", conviction: n > 1 ? 1 - idx / (n - 1) : 1,
        status: "rules", agreement: 1, thesis: `rank ${idx + 1}/${n}`, invalidation: [], evidence: [], vetoReason: null, votes: [],
      };
    });
    return { judgments };
  },
});

export const aiDecide = defineNode({
  type: "decide.ai",
  title: "Decide (AI ensemble)",
  category: "decision",
  description:
    "Cheap models vote on a 20-day stance per candidate from a fact dossier. Votes that misread the facts or quote things not in the dossier are rejected; no consensus => abstain; a red-team model may veto buys.",
  // v5: the fact sheet also has the previous judgment, past earnings reactions, SEC financials and estimate revisions
  version: 6, // v6: market & sector section
  cache: "inputs",
  params: z.object({
    maxCandidates: z.number().int().positive().default(10),
    quorum: z.number().int().min(1).optional(),
    redTeam: z.boolean().default(true),
    /** Prompt versions for this workflow (default: config.prompts.judge / redTeam). Two workflows with different versions = a live A/B test. */
    promptVersion: z.string().optional(),
    redTeamVersion: z.string().optional(),
    /** Voting models for this workflow, in call order (default: models.use.judge.vote). */
    models: z.array(z.string()).min(1).optional(),
    /** Tie-breaker model, or "none" (default: models.use.judge.escalation). */
    escalation: z.string().optional(),
    /** Red-team model, or "none" (default: models.use.redteam). */
    redTeamModel: z.string().optional(),
    /** Read back the last judgment (eval.record label; default: this workflow's name). 0 days = off. */
    historyLabel: z.string().optional(),
    previousMaxDays: z.number().int().min(0).max(365).default(30),
  }),
  inputs: {
    factors: { type: "Factors" },
    scores: { type: "Scores" },
    events: { type: "Events", optional: true },
    account: { type: "Account", optional: true },
    earnings: { type: "Earnings", optional: true },
    insider: { type: "Insider", optional: true },
    results: { type: "EarningsResults", optional: true },
    /** For the previous judgment's outcome and past earnings reactions. */
    prices: { type: "Prices", optional: true },
    fundamentals: { type: "Fundamentals", optional: true },
    estimates: { type: "Estimates", optional: true },
    market: { type: "Market", optional: true },
  },
  outputs: { judgments: { type: "Judgments" } },
  fallback: () => ({ judgments: {} }),
  async run(ctx, p, i) {
    const s = ctx.services;
    const judgePrompt = s.prompts.judge(p.promptVersion ?? s.config.prompts.judge);
    const judge = new Judge(s.caller, s.voters("judge", p.models), {
      quorum: p.quorum ?? s.config.harness.quorum,
      escalation: s.escalation("judge", p.escalation),
      redTeam: p.redTeam ? s.redTeam(p.redTeamModel) : undefined,
      prompt: judgePrompt,
      redTeamPrompt: s.prompts.redTeam(p.redTeamVersion ?? s.config.prompts.redTeam),
    });
    const variant = judgePrompt.dossier;
    const ranked = rankTickers(i.scores).filter((t) => i.factors.rows[t]);
    const held = Object.keys(i.account?.positions ?? {});
    const candidates = [...new Set([...ranked.slice(0, p.maxCandidates), ...held.filter((t) => i.factors.rows[t])])];
    const judgments: Record<string, Judgment> = {};
    const bench = s.config.market.benchmark;
    const label = p.historyLabel ?? ctx.workflow;
    const lastJudgment = (t: string) => {
      const prev = s.predictions.previous(label, t, ctx.asOf);
      return prev && prev.asOf >= addDays(ctx.asOf, -p.previousMaxDays) ? prev : null;
    };
    for (const t of candidates) {
      const events = (i.events ?? []).filter((e) => e.event.tickers.includes(t)).slice(-5);
      const dossier = buildDossier({
        row: i.factors.rows[t]!, asOf: ctx.asOf, rank: ranked.indexOf(t) + 1, universe: ranked.length,
        events,
        position: i.account?.positions[t],
        // an empty calendar means "not available" (no key): leave the section out rather than claim "no report"
        earnings: i.earnings && Object.keys(i.earnings).length ? (i.earnings[t] ?? null) : undefined,
        insider: i.insider && Object.keys(i.insider).length ? i.insider[t] : undefined,
        // empty = not connected (no key): leave the section out
        results: i.results && Object.keys(i.results).length ? (i.results[t] ?? []) : undefined,
        reactions: i.prices && i.results && Object.keys(i.results).length ? earningsReactions(i.results[t], i.prices[t], bench ? i.prices[bench] : undefined, ctx.asOf) : undefined,
        fundamentals: i.fundamentals && Object.keys(i.fundamentals).length ? (i.fundamentals[t] ?? null) : undefined,
        estimates: i.estimates && Object.keys(i.estimates).length ? (i.estimates[t] ?? []) : undefined,
        market: i.market,
        previous: p.previousMaxDays > 0 ? previousJudgment(lastJudgment(t), ctx.asOf, i.prices?.[t], bench ? i.prices?.[bench] : undefined) : undefined,
      }, variant);
      try {
        judgments[t] = {
          ...(await judge.judge(dossier, held.includes(t))),
          dossier: dossier.text,
          sources: events.map((e) => ({
            title: e.title, url: e.url, source: e.source, learnedAt: e.learnedAt, eventType: e.event.eventType,
            direction: e.event.direction, materiality: e.event.materiality, evidence: e.event.evidence,
          })),
        };
        ctx.metric(`stance_${judgments[t].stance}`, 1);
        if (judgments[t].status === "vetoed") ctx.metric("vetoed", 1);
      } catch (e) {
        if (!(e instanceof BudgetExceeded)) throw e;
        ctx.log(`${e.message} -> stopping (fail-safe: remaining candidates are not judged)`);
        ctx.metric("budgetStopped", 1);
        break;
      }
    }
    return { judgments };
  },
});
