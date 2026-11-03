import { watchlistOf } from "./scope.ts";
import { z } from "zod";
import { dedup, type Match } from "../signals/prefilter.ts";
import { contradictsResults } from "../data/earningsResults.ts";
import { defineNode } from "../workflow/registry.ts";

export const mergeDocs = defineNode({
  type: "filter.merge",
  title: "Merge documents",
  category: "filter",
  description: "Combines up to four document streams (e.g. news + SEC filings). Inputs from failed or skipped sources are left out.",
  version: 1,
  cache: "inputs",
  params: z.object({}),
  inputs: {
    a: { type: "Documents", optional: true },
    b: { type: "Documents", optional: true },
    c: { type: "Documents", optional: true },
    d: { type: "Documents", optional: true },
  },
  outputs: { docs: { type: "Documents" } },
  async run(ctx, _p, i) {
    const docs = [...(i.a ?? []), ...(i.b ?? []), ...(i.c ?? []), ...(i.d ?? [])];
    ctx.metric("docs", docs.length);
    return { docs };
  },
});

export const dedupNode = defineNode({
  type: "filter.dedup",
  title: "Deduplicate",
  category: "filter",
  description: "Drops syndicated copies of the same story and records which other sources carried it (corroboration).",
  version: 1,
  cache: "inputs",
  params: z.object({}),
  inputs: { docs: { type: "Documents" } },
  outputs: { docs: { type: "Documents" } },
  async run(ctx, _p, i) {
    const docs = dedup(i.docs);
    ctx.metric("dropped", i.docs.length - docs.length);
    return { docs };
  },
});

export const watchlistFilter = defineNode({
  type: "filter.watchlist",
  title: "Watchlist match",
  category: "filter",
  description: "Tier 0: keeps only documents that mention a watchlist company (no LLM, no cost).",
  version: 1,
  cache: "inputs",
  params: z.object({}),
  inputs: { docs: { type: "Documents" } },
  outputs: { matches: { type: "Matches" } },
  async run(ctx, _p, i) {
    const w = watchlistOf(ctx);
    const matches: Match[] = [];
    for (const doc of i.docs) {
      const candidates = w.match(doc);
      if (Object.keys(candidates).length) matches.push({ doc, candidates });
    }
    ctx.metric("skippedNoTicker", i.docs.length - matches.length);
    return { matches };
  },
});

export const checkEventsNode = defineNode({
  type: "filter.checkEvents",
  title: "Check events against data",
  category: "filter",
  description:
    "Drops events whose label the structured data contradicts (e.g. \"earnings beat\" when reported EPS missed the estimate), before they reach scores and the judgment sheet. Events extracted before the numbers were available are caught here too.",
  version: 1,
  cache: "inputs",
  params: z.object({}),
  inputs: { events: { type: "Events" }, results: { type: "EarningsResults", optional: true } },
  outputs: { events: { type: "Events" } },
  async run(ctx, _p, i) {
    const kept = i.events.filter((e) => {
      const why = contradictsResults(e.event, e.learnedAt.slice(0, 10), i.results);
      if (why) ctx.log(`dropped "${e.title.slice(0, 80)}": ${why}`);
      return !why;
    });
    ctx.metric("dropped", i.events.length - kept.length);
    return { events: kept };
  },
});
