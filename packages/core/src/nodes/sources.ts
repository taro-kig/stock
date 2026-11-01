import { readFileSync } from "node:fs";
import { z } from "zod";
import { DocumentSchema, type Document } from "../signals/models.ts";
import { SEC_ITEMS, SecClient } from "../data/sec.ts";
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

export const secFilings = defineNode({
  type: "source.secFilings",
  title: "SEC filings (EDGAR)",
  category: "source",
  description:
    "US company filings (8-K etc.) for the watchlist from SEC EDGAR, free. Needs SEC_USER_AGENT with a contact e-mail. Point-in-time: a filing counts from the moment EDGAR accepted it, so past dates can be replayed.",
  version: 1,
  cache: "daily",
  params: z.object({
    forms: z.array(z.string()).default(["8-K"]),
    lookbackDays: z.number().positive().default(3),
    fetchText: z.boolean().default(true),
    maxChars: z.number().int().positive().default(6000),
    userAgentEnv: z.string().default("SEC_USER_AGENT"),
    /** Ticker -> CIK when the SEC ticker list does not have it. */
    ciks: z.record(z.string(), z.number().int().positive()).default({}),
    weight: z.number().min(0).default(1),
  }),
  inputs: {},
  outputs: { docs: { type: "Documents" } },
  fallback: () => ({ docs: [] }),
  async run(ctx, p) {
    const s = ctx.services;
    const ua = s.env[p.userAgentEnv];
    if (!ua) throw new Error(`${p.userAgentEnv} is not set (SEC requires e.g. "stockai you@example.com")`);
    const sec = new SecClient({ userAgent: ua, fetchImpl: s.fetch, sleep: s.sleep });
    const tickers = s.watchlist.tickers;
    const needMap = tickers.some((t) => p.ciks[t] === undefined);
    const map = needMap ? await sec.tickerMap() : {};
    const from = ctx.now.getTime() - p.lookbackDays * 86_400_000;
    const forms = new Set(p.forms.map((f) => f.toUpperCase()));
    const docs: Document[] = [];
    let failed = 0;
    for (const t of tickers) {
      const cik = p.ciks[t] ?? map[t.toUpperCase()];
      if (cik === undefined) {
        ctx.log(`${t}: no CIK in the SEC ticker list (set params.ciks)`);
        continue;
      }
      try {
        const { filings } = await sec.submissions(cik);
        for (const f of filings) {
          const at = Date.parse(f.acceptedAt);
          if (!forms.has(f.form.toUpperCase()) || at <= from || at > ctx.now.getTime()) continue;
          const items = f.items.map((i) => `Item ${i} ${SEC_ITEMS[i] ?? ""}`.trim());
          let text = "";
          if (p.fetchText) {
            try {
              text = await sec.filingText(f, p.maxChars);
            } catch (e) {
              ctx.log(`${t} ${f.accession}: text unavailable: ${e instanceof Error ? e.message : String(e)}`);
            }
          }
          docs.push({
            source: "sec_edgar",
            url: f.url,
            title: `${s.watchlist.name(t)} (${t}) ${f.form}${items.length ? `: ${items.join("; ")}` : f.description ? `: ${f.description}` : ""}`,
            body: [`Form ${f.form} filed ${f.filingDate}`, text].filter(Boolean).join("\n\n"),
            publishedAt: f.acceptedAt,
            fetchedAt: f.acceptedAt,
            sourceWeight: p.weight,
            alsoSeenIn: [],
          });
        }
      } catch (e) {
        failed++;
        ctx.log(`${t}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    ctx.metric("docs", docs.length);
    ctx.metric("failed", failed);
    if (tickers.length > 0 && failed === tickers.length) throw new Error("all SEC requests failed");
    return { docs };
  },
});
