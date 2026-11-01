import { z } from "zod";
import { dedup, type Match } from "../signals/prefilter.ts";
import { defineNode } from "../workflow/registry.ts";

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
    const w = ctx.services.watchlist;
    const matches: Match[] = [];
    for (const doc of i.docs) {
      const candidates = w.match(doc);
      if (Object.keys(candidates).length) matches.push({ doc, candidates });
    }
    ctx.metric("skippedNoTicker", i.docs.length - matches.length);
    return { matches };
  },
});
