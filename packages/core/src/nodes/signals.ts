import { z } from "zod";
import { insiderScore } from "../data/insider.ts";
import { eventScores } from "../signals/aggregate.ts";
import type { EventRecord } from "../signals/models.ts";
import { computeFactors } from "../strategy/factors.ts";
import { compositeScore, DEFAULT_WEIGHTS } from "../strategy/scoring.ts";
import { defineNode } from "../workflow/registry.ts";

export const eventHistory = defineNode({
  type: "signal.eventHistory",
  title: "Event history",
  category: "signal",
  description: "Accepted events learned in the lookback window up to now (point-in-time), merged with today's.",
  version: 1,
  cache: "daily",
  params: z.object({
    lookbackDays: z.number().positive().default(90),
    /** Same as llm.extractEvents' promptVersion (default: config.prompts.event). */
    promptVersion: z.string().optional(),
  }),
  inputs: { today: { type: "Events", optional: true } },
  outputs: { events: { type: "Events" } },
  async run(ctx, p, i) {
    const since = new Date(ctx.now.getTime() - p.lookbackDays * 86_400_000);
    const byHash = new Map<string, EventRecord>();
    for (const e of [...ctx.services.docStore.acceptedEvents(since, ctx.now, p.promptVersion ?? ctx.services.config.prompts.event), ...(i.today ?? [])]) {
      if (new Date(e.learnedAt) <= ctx.now) byHash.set(e.docHash, e);
    }
    return { events: [...byHash.values()].sort((a, b) => a.learnedAt.localeCompare(b.learnedAt)) };
  },
});

export const eventScoreNode = defineNode({
  type: "signal.eventScores",
  title: "Event scores",
  category: "signal",
  description: "Per-ticker score from events: direction × materiality × confidence × agreement × source weight, decayed by age.",
  version: 1,
  cache: "daily",
  params: z.object({ corroborationBonus: z.number().min(0).default(0.5) }),
  inputs: { events: { type: "Events" } },
  outputs: { scores: { type: "Scores" } },
  async run(ctx, p, i) {
    return { scores: eventScores(i.events, ctx.now, { corroborationBonus: p.corroborationBonus }) };
  },
});

export const factorsNode = defineNode({
  type: "signal.factors",
  title: "Price factors",
  category: "signal",
  description: "Momentum 12-1, relative strength, trend, ATR, volatility, 20-day return and distance from the 52-week high per ticker. No LLM.",
  version: 3, // v2: ret20, fromHigh52 · v3: also held tickers that left the watchlist
  cache: "daily",
  params: z.object({ benchmark: z.string().optional(), relDays: z.number().int().positive().default(126) }),
  inputs: { prices: { type: "Prices" } },
  outputs: { factors: { type: "Factors" } },
  async run(ctx, p, i) {
    const w = ctx.services.watchlist;
    const held = ctx.services.heldTickers();
    const watched = Object.fromEntries(
      Object.entries(i.prices).filter(([t]) => t in w.entries || t in held || t === (p.benchmark ?? ctx.services.config.market.benchmark)),
    );
    return {
      factors: computeFactors(watched, ctx.asOf, (t) => ({ name: w.name(t), sector: t in w.entries ? w.sector(t) : (held[t] ?? "unknown") }), {
        benchmark: p.benchmark ?? ctx.services.config.market.benchmark,
        relDays: p.relDays,
      }),
    };
  },
});

export const scoreNode = defineNode({
  type: "signal.score",
  title: "Composite score",
  category: "signal",
  description: "Weighted, clipped z-scores of factors (and event scores, insider buying and SEC financials — quality = operating margin, growth = revenue growth — if connected).",
  version: 2,
  cache: "inputs",
  params: z.object({ weights: z.record(z.string(), z.number()).default(DEFAULT_WEIGHTS) }),
  inputs: { factors: { type: "Factors" }, events: { type: "Scores", optional: true }, insider: { type: "Insider", optional: true }, fundamentals: { type: "Fundamentals", optional: true } },
  outputs: { scores: { type: "Scores" } },
  async run(_ctx, p, i) {
    const rows = Object.values(i.factors.rows);
    const col = (f: (r: (typeof rows)[number]) => number | null) => Object.fromEntries(rows.map((r) => [r.ticker, f(r)]));
    const factors: Record<string, Record<string, number | null>> = {
      momentum: col((r) => r.momentum),
      relStrength: col((r) => r.relStrength),
    };
    if (i.events) factors["event"] = col((r) => i.events?.[r.ticker] ?? 0);
    // an empty map means "not available" (no SEC_USER_AGENT): leave the factor out rather than score everyone 0
    if (i.insider && Object.keys(i.insider).length) factors["insider"] = col((r) => insiderScore(i.insider?.[r.ticker]));
    if (i.fundamentals && Object.keys(i.fundamentals).length) {
      factors["quality"] = col((r) => i.fundamentals?.[r.ticker]?.operatingMargin ?? null);
      factors["growth"] = col((r) => i.fundamentals?.[r.ticker]?.revenueTtmYoY ?? null);
    }
    return { scores: compositeScore(factors, rows.map((r) => r.ticker), p.weights) };
  },
});
