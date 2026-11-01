import { readFileSync } from "node:fs";
import { z } from "zod";
import { DocumentSchema, type Document } from "../signals/models.ts";
import { fetchFeed } from "../signals/rss.ts";
import { defineNode } from "../workflow/registry.ts";

export const rssSource = defineNode({
  type: "source.rss",
  title: "RSS",
  category: "source",
  description: "Fetches RSS/Atom feeds (defaults to config.sources). Live runs only: a feed cannot show the past.",
  version: 1,
  cache: "daily",
  params: z.object({
    feeds: z.array(z.object({ name: z.string(), url: z.url(), weight: z.number().min(0).default(1) })).optional(),
  }),
  inputs: {},
  outputs: { docs: { type: "Documents" } },
  fallback: () => ({ docs: [] }),
  async run(ctx, p) {
    if (!ctx.live) throw new Error("source.rss cannot replay a past date (no point-in-time history); use source.fixture or stored documents");
    const feeds = p.feeds ?? ctx.services.config.sources;
    const docs: Document[] = [];
    let failed = 0;
    for (const f of feeds) {
      try {
        const got = await fetchFeed(f.url, f.name, { weight: f.weight });
        docs.push(...got.map((d) => ({ ...d, fetchedAt: ctx.now.toISOString() })));
      } catch (e) {
        failed++;
        ctx.log(`feed ${f.name} failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    ctx.metric("feedsFailed", failed);
    ctx.metric("docs", docs.length);
    if (feeds.length > 0 && failed === feeds.length) throw new Error("all feeds failed");
    return { docs };
  },
});

export const fixtureSource = defineNode({
  type: "source.fixture",
  title: "Fixture documents",
  category: "source",
  description: "Loads documents from a JSON file, keeping those learned within the lookback window before `now` (point-in-time). For demos, tests and replays.",
  version: 1,
  cache: "daily",
  params: z.object({ path: z.string(), lookbackDays: z.number().positive().default(3) }),
  inputs: {},
  outputs: { docs: { type: "Documents" } },
  async run(ctx, p) {
    const all = z.array(DocumentSchema).parse(JSON.parse(readFileSync(p.path, "utf8")));
    const from = ctx.now.getTime() - p.lookbackDays * 86_400_000;
    const docs = all.filter((d) => {
      const t = Date.parse(d.fetchedAt);
      return t > from && t <= ctx.now.getTime();
    });
    ctx.metric("docs", docs.length);
    return { docs };
  },
});
