import { groupFailures } from "./problems.ts";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { DocumentSchema, type Document } from "../signals/models.ts";
import { parseForm4, rawForm4Document, summarizeInsider, type InsiderMap } from "../data/insider.ts";
import { needsFundamentals, parseCompanyFacts } from "../data/fundamentals.ts";
import { accessionPath, SEC_ITEMS, SecClient, type Filing } from "../data/sec.ts";
import { addDays, toIsoDate } from "../util/dates.ts";
import { fetchFeed } from "../signals/rss.ts";
import { defineNode } from "../workflow/registry.ts";
import { researchUniverse } from "./data.ts";

export const rssSource = defineNode({
  type: "source.rss",
  title: "RSS",
  category: "source",
  description: "Fetches RSS/Atom feeds (defaults to config.sources; {tickers} in a URL becomes the watchlist). Live runs only: a feed cannot show the past.",
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
    // "{tickers}" in a feed URL becomes the watchlist (e.g. Yahoo Finance headline feeds), so it follows watchlist edits.
    const tickers = ctx.services.watchlist.tickers.map(encodeURIComponent).join(",");
    const feeds = (p.feeds ?? ctx.services.config.sources).map((f) => ({ ...f, url: f.url.replaceAll("{tickers}", tickers) }));
    const docs: Document[] = [];
    let failed = 0;
    const failures: string[] = [];
    for (const f of feeds) {
      try {
        const got = await fetchFeed(f.url, f.name, { weight: f.weight, fetchImpl: ctx.services.fetch });
        docs.push(...got.map((d) => ({ ...d, fetchedAt: ctx.now.toISOString() })));
      } catch (e) {
        failed++;
        failures.push(`${f.name}: ${e instanceof Error ? e.message : String(e)}`);
        ctx.log(`feed ${f.name} failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    ctx.metric("feedsFailed", failed);
    ctx.metric("docs", docs.length);
    if (feeds.length > 0 && failed === feeds.length) throw new Error(`all feeds failed — ${groupFailures(failures)}`);
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
  version: 2, // v2: Schedule 13D by default
  cache: "daily",
  params: z.object({
    /** 8-K: material events. Schedule 13D: someone crossed 5% with intent to influence (activists); "SC 13D" before 2025, "SCHEDULE 13D" after. */
    forms: z.array(z.string()).default(["8-K", "SC 13D", "SC 13D/A", "SCHEDULE 13D", "SCHEDULE 13D/A"]),
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
    const failures: string[] = [];
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
          const formNote = /13D/i.test(f.form) ? "Schedule 13D: beneficial ownership over 5% with intent to influence (activist / control)" : "";
          let text = "";
          if (p.fetchText) {
            try {
              text = await sec.filingText(f, p.maxChars);
            } catch (e) {
              ctx.log(`${t} ${f.accession}: text unavailable: ${e instanceof Error ? e.message : String(e)}`);
              ctx.metric("textUnavailable", 1);
            }
          }
          docs.push({
            source: "sec_edgar",
            url: f.url,
            title: `${s.watchlist.name(t)} (${t}) ${f.form}${items.length ? `: ${items.join("; ")}` : formNote ? `: ${formNote}` : f.description ? `: ${f.description}` : ""}`,
            body: [`Form ${f.form} filed ${f.filingDate}`, text].filter(Boolean).join("\n\n"),
            publishedAt: f.acceptedAt,
            fetchedAt: f.acceptedAt,
            sourceWeight: p.weight,
            alsoSeenIn: [],
          });
        }
      } catch (e) {
        failed++;
        failures.push(`${t}: ${e instanceof Error ? e.message : String(e)}`);
        ctx.log(`${t}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    ctx.metric("docs", docs.length);
    ctx.metric("failed", failed);
    if (tickers.length > 0 && failed === tickers.length) throw new Error(`all SEC requests failed — ${groupFailures(failures)}`);
    return { docs };
  },
});

export const insiderTrades = defineNode({
  type: "data.insider",
  title: "Insider trades (SEC Form 4)",
  category: "data",
  description:
    "Open-market buys and sells by officers, directors and 10% owners of the watched (and held) US stocks, from SEC Form 4 (filed within 2 business days). Downloads only new filings; a trade counts from the moment EDGAR accepted it. Needs SEC_USER_AGENT; without it the node stays green and outputs nothing.",
  version: 1,
  cache: "daily",
  params: z.object({
    windowDays: z.number().int().min(7).max(365).default(90),
    userAgentEnv: z.string().default("SEC_USER_AGENT"),
    /** Upper bound of Form 4 documents downloaded per run (the first run fills the window). */
    maxFilings: z.number().int().min(1).default(300),
  }),
  inputs: {},
  outputs: { insider: { type: "Insider" } },
  async run(ctx, p) {
    const s = ctx.services;
    const tickers = [...new Set([...s.watchlist.tickers, ...Object.keys(s.heldTickers())])];
    if (ctx.live) {
      const ua = s.env[p.userAgentEnv];
      if (!ua) {
        ctx.log(`${p.userAgentEnv} is not set: no insider trades (settings screen)`);
        ctx.metric("disabled", 1);
        return { insider: {} };
      }
      const sec = new SecClient({ userAgent: ua, fetchImpl: s.fetch, sleep: s.sleep });
      const map = await sec.tickerMap();
      const since = ctx.now.getTime() - (p.windowDays + 7) * 86_400_000;
      let fetched = 0;
      let failed = 0;
      for (const t of tickers) {
        const cik = map[t.toUpperCase()];
        if (cik === undefined) continue;
        let filings: Filing[];
        try {
          filings = (await sec.submissions(cik)).filings;
        } catch (e) {
          failed++;
          ctx.log(`${t}: ${e instanceof Error ? e.message : String(e)}`);
          continue;
        }
        for (const f of filings) {
          if ((f.form !== "4" && f.form !== "4/A") || Date.parse(f.acceptedAt) < since || Date.parse(f.acceptedAt) > ctx.now.getTime()) continue;
          if (s.insider.has(f.accession)) continue;
          if (fetched >= p.maxFilings) break;
          try {
            const xml = await sec.text(`${accessionPath(f.cik, f.accession)}/${rawForm4Document(f.primaryDocument)}`);
            const trades = parseForm4(xml, { accession: f.accession, filedAt: f.acceptedAt });
            // the filing is about the issuer whose list it came from, whatever symbol the filer typed
            s.insider.save(f.accession, t, f.acceptedAt, trades.map((x) => ({ ...x, ticker: t })));
            fetched++;
          } catch (e) {
            failed++;
            ctx.log(`${t} ${f.accession}: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
      }
      ctx.metric("downloaded", fetched);
      ctx.metric("failed", failed);
    }
    const insider: InsiderMap = {};
    for (const t of tickers) insider[t] = summarizeInsider(t, s.insider.trades(t, ctx.asOf, ctx.now, p.windowDays), p.windowDays);
    ctx.metric("withBuys", Object.values(insider).filter((x) => x.buys > 0).length);
    ctx.metric("clusters", Object.values(insider).filter((x) => x.cluster).length);
    return { insider };
  },
});

export const fundamentalsNode = defineNode({
  type: "data.fundamentals",
  title: "Financials (SEC XBRL)",
  category: "data",
  description:
    "Revenue / EPS growth, margins and shares outstanding per US ticker from SEC company facts (free; needs SEC_USER_AGENT). Downloads a company weekly, or daily after a report date until its 10-Q / 10-K is in. Numbers are computed by the program and count from their filing date (point in time).",
  version: 1,
  cache: "daily",
  params: z.object({
    userAgentEnv: z.string().default("SEC_USER_AGENT"),
    /** Companies downloaded per run (each is one request of a few MB). */
    maxFetches: z.number().int().min(0).max(600).default(15),
    refreshDays: z.number().int().min(1).max(90).default(7),
    /** watchlist (+ held) · research: the factor-research stocks (raise maxFetches for the first fill). */
    universe: z.enum(["watchlist", "research"]).default("watchlist"),
  }),
  inputs: {},
  outputs: { fundamentals: { type: "Fundamentals" } },
  async run(ctx, p) {
    const s = ctx.services;
    const benchmark = s.config.market.benchmark;
    const tickers = (p.universe === "research" ? Object.keys(researchUniverse(ctx)) : [...new Set([...s.watchlist.tickers, ...Object.keys(s.heldTickers())])]).filter((t) => t !== benchmark);
    if (ctx.live) {
      const ua = s.env[p.userAgentEnv];
      if (!ua) {
        ctx.log(`${p.userAgentEnv} is not set: no financials (settings screen)`);
        ctx.metric("disabled", 1);
        return { fundamentals: {} };
      }
      const today = toIsoDate(ctx.wallNow());
      const due = tickers.filter((t) => needsFundamentals({
        lastFetch: s.fundamentals.lastFetch(t), latestFiled: s.fundamentals.latestFiled(t),
        recentReportDates: s.earnings.reportDates(t, addDays(today, -45), today), today, refreshDays: p.refreshDays,
      }));
      if (due.length) {
        const sec = new SecClient({ userAgent: ua, fetchImpl: s.fetch, sleep: s.sleep });
        const map = await sec.tickerMap();
        let fetched = 0;
        let failed = 0;
        for (const t of due.slice(0, p.maxFetches)) {
          const cik = map[t.toUpperCase()];
          if (cik === undefined) {
            ctx.log(`${t}: not in the SEC ticker list (not a US filer?)`);
            ctx.metric("notInSec", 1);
            continue;
          }
          try {
            s.fundamentals.save(t, today, parseCompanyFacts(await sec.json(`https://data.sec.gov/api/xbrl/companyfacts/CIK${String(cik).padStart(10, "0")}.json`)));
            fetched++;
          } catch (e) {
            failed++;
            ctx.log(`${t}: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
        ctx.metric("downloaded", fetched);
        if (failed) ctx.metric("failed", failed);
        if (due.length > p.maxFetches) ctx.metric("deferred", due.length - p.maxFetches);
      }
    }
    const fundamentals = s.fundamentals.at(tickers, ctx.asOf);
    ctx.metric("tickers", Object.keys(fundamentals).length);
    return { fundamentals };
  },
});
