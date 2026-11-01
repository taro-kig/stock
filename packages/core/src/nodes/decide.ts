import { z } from "zod";
import { buildDossier, Judge, type Judgment } from "../ai/judge.ts";
import { BudgetExceeded } from "../harness/budget.ts";
import { rankTickers } from "../strategy/scoring.ts";
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
  version: 1,
  cache: "inputs",
  params: z.object({
    maxCandidates: z.number().int().positive().default(10),
    quorum: z.number().int().min(1).optional(),
    redTeam: z.boolean().default(true),
  }),
  inputs: {
    factors: { type: "Factors" },
    scores: { type: "Scores" },
    events: { type: "Events", optional: true },
    account: { type: "Account", optional: true },
  },
  outputs: { judgments: { type: "Judgments" } },
  fallback: () => ({ judgments: {} }),
  async run(ctx, p, i) {
    const s = ctx.services;
    const judge = new Judge(s.caller, s.tier1(), {
      quorum: p.quorum ?? s.config.harness.quorum,
      escalation: s.tier2(),
      redTeam: p.redTeam ? s.redTeam() : undefined,
    });
    const ranked = rankTickers(i.scores).filter((t) => i.factors.rows[t]);
    const held = Object.keys(i.account?.positions ?? {});
    const candidates = [...new Set([...ranked.slice(0, p.maxCandidates), ...held.filter((t) => i.factors.rows[t])])];
    const judgments: Record<string, Judgment> = {};
    for (const t of candidates) {
      const dossier = buildDossier({
        row: i.factors.rows[t]!, asOf: ctx.asOf, rank: ranked.indexOf(t) + 1, universe: ranked.length,
        events: (i.events ?? []).filter((e) => e.event.tickers.includes(t)).slice(-5),
        position: i.account?.positions[t],
      });
      try {
        judgments[t] = await judge.judge(dossier, held.includes(t));
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
