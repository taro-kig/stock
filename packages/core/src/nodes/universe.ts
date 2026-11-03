import { z } from "zod";
import { TwelveDataClient } from "../data/twelveData.ts";
import type { Bar, Prices } from "../signals/technical.ts";
import { latestFactorReport } from "../strategy/factorResearch.ts";
import { ScreenRequest, screenStocks } from "../universe/screen.ts";
import { SIZES, suggestTickers } from "../universe/suggest.ts";
import { additionDates, applyWatchlistPatch, type UniverseAdd, type UniverseChanges, type UniverseRemove } from "../universe/watchlist.ts";
import { addDays } from "../util/dates.ts";
import { WaitingForInput } from "../workflow/context.ts";
import { defineNode } from "../workflow/registry.ts";

/** Mean daily traded value (close × volume) over the last `n` sessions. */
export function avgDollarVolume(bars: readonly Bar[] | undefined, n = 20): number | null {
  const last = (bars ?? []).slice(-n).filter((b) => b.volume > 0);
  if (last.length < Math.min(10, n)) return null;
  return last.reduce((a, b) => a + b.close * b.volume, 0) / last.length;
}

const fmtUsd = (x: number) => (x >= 1e9 ? `$${(x / 1e9).toFixed(1)}B` : `$${Math.round(x / 1e6)}M`);
const pct = (x: number) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}%`;

function ensureReviews(db: { exec(sql: string): void }) {
  db.exec("CREATE TABLE IF NOT EXISTS universe_reviews (run_id TEXT PRIMARY KEY, at TEXT, adds INT, removes INT)");
}

export const universeReview = defineNode({
  type: "universe.review",
  title: "Universe review",
  category: "universe",
  description:
    "Proposes watchlist changes (US stocks): additions from the AI for the given themes, verified against the SEC list and checked for liquidity; removals for low liquidity or missing data, or for two soft signs (no news and an always-neutral AI). Runs at most once per minDaysBetween; live runs only.",
  version: 2, // v2: additions can come from the data screen
  cache: "none",
  params: z.object({
    themes: z.array(z.string()).default([]).describe("empty: diversify the current watchlist"),
    addCount: z.number().int().min(0).max(15).default(5),
    size: z.enum(SIZES).default("any"),
    maxRemove: z.number().int().min(0).max(10).default(3),
    minDollarVolume: z.number().min(0).default(20_000_000),
    minBars: z.number().int().min(20).default(260),
    quietDays: z.number().int().min(14).default(90),
    neutralDays: z.number().int().min(10).default(40),
    /** Names added more recently than this are not judged on the soft signs yet. */
    graceDays: z.number().int().min(0).default(60),
    judgmentLabel: z.string().default("daily-ai"),
    minDaysBetween: z.number().int().min(0).default(28),
    checkLiquidity: z.boolean().default(true),
    /** Prompt version for suggestions (default: config.prompts.universe). */
    promptVersion: z.string().optional(),
    /** Model for this workflow (default: models.use.universe). */
    model: z.string().optional(),
    /** Where additions come from: ai (themes → model → SEC check), screen (SEC + price data, any size), or both. */
    source: z.enum(["ai", "screen", "both"]).default("ai"),
    /** Screen settings (source screen / both): sizes, sectors, minRevenueGrowth, minOperatingMargin, ... */
    screen: ScreenRequest.partial().default({}),
  }),
  inputs: { prices: { type: "Prices" } },
  outputs: { changes: { type: "UniverseChanges" } },
  async run(ctx, p, i) {
    const s = ctx.services;
    const empty = (skipped: string): { changes: UniverseChanges } => ({ changes: { asOf: ctx.asOf, add: [], remove: [], notes: [], skipped } });
    if (!ctx.live) return empty("過去日付の再生では見直さない（AI の知識が今のものなので）");
    if (s.config.market.currency !== "USD") return empty("米国株の設定でのみ動く");
    ensureReviews(s.db);
    const last = s.db.prepare("SELECT at FROM universe_reviews ORDER BY at DESC LIMIT 1").get() as { at: string } | undefined;
    if (last && ctx.wallNow().getTime() - Date.parse(last.at) < p.minDaysBetween * 86_400_000) {
      ctx.metric("skipped", 1);
      return empty(`前回の見直し（${last.at.slice(0, 10)}）から ${p.minDaysBetween} 日たっていない`);
    }

    const notes: string[] = [];
    const prices: Prices = i.prices;
    const bench = s.config.market.benchmark;
    const w = s.watchlist;
    const held = s.heldTickers();
    const added = additionDates(s);

    // ── how earlier picks did (since they were added) ─────────────
    for (const [t, a] of Object.entries(added)) {
      const bars = prices[t];
      const day = a.at.slice(0, 10);
      const from = bars?.find((b) => b.date >= day);
      const to = bars?.at(-1);
      if (!from || !to || from === to) continue;
      const b0 = bench ? prices[bench]?.find((b) => b.date >= day) : undefined;
      const b1 = bench ? prices[bench]?.at(-1) : undefined;
      const rel = b0 && b1 ? ` / ${bench} ${pct(b1.close / b0.close - 1)}` : "";
      notes.push(`${t}（${day} に${a.source === "review" ? "見直し" : a.source === "mcp" ? "Claude" : "画面"}で追加）: ${pct(to.close / from.close - 1)}${rel}`);
    }

    // ── removals ─────────────────────────────────────────────
    const since = (days: number) => new Date(ctx.now.getTime() - days * 86_400_000);
    const events = s.docStore.acceptedEvents(since(p.quietDays), ctx.now, s.config.prompts.event);
    const withNews = new Set(events.flatMap((e) => e.event.tickers));
    const from = addDays(ctx.asOf, -p.neutralDays);
    const preds = s.predictions.all(ctx.asOf).filter((x) => x.label === p.judgmentLabel && x.asOf >= from);
    const remove: UniverseRemove[] = [];
    for (const t of w.tickers) {
      const hard: string[] = [];
      const soft: string[] = [];
      const bars = prices[t];
      if (!bars?.length) hard.push("株価データが取れない（上場廃止・ティッカー変更の可能性）");
      else if (bars.length < p.minBars) hard.push(`株価の履歴が ${bars.length} 日しかない（指標の計算に ${p.minBars} 日必要）`);
      const adv = avgDollarVolume(bars);
      if (adv !== null && adv < p.minDollarVolume) hard.push(`売買代金が少ない（20日平均 ${fmtUsd(adv)} < ${fmtUsd(p.minDollarVolume)}）`);
      const recent = added[t] && ctx.wallNow().getTime() - Date.parse(added[t].at) < p.graceDays * 86_400_000;
      if (!recent) {
        if (!withNews.has(t)) soft.push(`${p.quietDays} 日間、材料になるニュース・開示が無い`);
        const mine = preds.filter((x) => x.ticker === t);
        if (mine.length >= 10 && mine.every((x) => x.stance === "neutral" || x.stance === "abstain")) soft.push(`${p.neutralDays} 日間、AI の判断がずっと中立・棄権（${mine.length} 回）`);
      }
      if (hard.length || soft.length >= 2) remove.push({ ticker: t, name: w.name(t), reasons: [...hard, ...soft], held: t in held });
    }
    remove.sort((a, b) => b.reasons.length - a.reasons.length);
    const removals = remove.slice(0, p.maxRemove);
    if (remove.length > removals.length) notes.push(`外す候補は他に ${remove.length - removals.length} 件（maxRemove = ${p.maxRemove}）`);

    // ── additions ────────────────────────────────────────────
    const add: UniverseAdd[] = [];
    if (p.addCount > 0 && p.source !== "ai") {
      try {
        const r = await screenStocks(s, { ...p.screen, count: p.addCount }, { now: ctx.wallNow(), report: latestFactorReport(s)?.report ?? null, log: ctx.log });
        ctx.metric("screened", r.candidates.length);
        notes.push(`データで探した候補: ${r.funnel.map((f) => `${f.step} ${f.count}`).join(" → ")}（重み: ${r.weightsFrom === "factor-research" ? "因子の検証の提案" : "既定"}）`);
        for (const c of r.candidates) {
          if (add.length >= p.addCount) break;
          add.push({
            ticker: c.ticker, name: c.name, aliases: [], sector: c.sector, reason: `データ: ${c.reason}`,
            listing: { name: c.name, exchange: c.exchange, cik: c.cik }, avgDollarVolume: c.tradedValue,
          });
        }
      } catch (e) {
        notes.push(`データでの銘柄探しができなかった: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (p.addCount > add.length && p.source !== "screen") {
      const theme = p.themes.length ? p.themes.join(" / ") : "今のウォッチリストのセクターの偏りを補う、流動性の高い米国株";
      const r = await suggestTickers(s, { theme, count: Math.min(25, p.addCount + 3), size: p.size }, ctx.wallNow(), p.promptVersion, p.model);
      const already = new Set(add.map((a) => a.ticker));
      r.candidates = r.candidates.filter((c) => !already.has(c.ticker));
      ctx.metric("suggested", r.candidates.length);
      if (r.verificationError) notes.push(`追加候補は確認できなかったため出していない: ${r.verificationError}`);
      const rejected = r.candidates.filter((c) => c.status === "rejected");
      const byProblem = new Map<string, string[]>();
      for (const c of rejected) byProblem.set(c.problem ?? "?", [...(byProblem.get(c.problem ?? "?") ?? []), c.ticker]);
      for (const [problem, ts] of byProblem) notes.push(`AI の候補のうち除外（${problem}）: ${ts.join(", ")}`);
      const key = s.env["TWELVEDATA_API_KEY"];
      const td = p.checkLiquidity && key ? new TwelveDataClient({ apiKey: key, fetchImpl: s.fetch, sleep: s.sleep }) : null;
      if (p.checkLiquidity && !key) notes.push("TWELVEDATA_API_KEY が無いため売買代金を確認していない");
      for (const c of r.candidates.filter((x) => x.status === "ok")) {
        if (add.length >= p.addCount) break;
        let adv: number | null = null;
        if (td) {
          try {
            adv = avgDollarVolume(await td.dailyBars(c.ticker, { outputsize: 30 }));
          } catch (e) {
            notes.push(`${c.ticker}: 売買代金を確認できず除外（${e instanceof Error ? e.message : String(e)}）`);
            continue;
          }
          if (adv === null || adv < p.minDollarVolume) {
            notes.push(`${c.ticker}: 売買代金が少ないため除外（${adv === null ? "データ不足" : fmtUsd(adv)}）`);
            continue;
          }
        }
        add.push({
          ticker: c.ticker, name: c.name, aliases: c.aliases, sector: c.sector, reason: c.reason,
          listing: c.listing ? { name: c.listing.name, exchange: c.listing.exchange, cik: c.listing.cik } : null, avgDollarVolume: adv,
        });
      }
    }

    s.db.prepare("INSERT OR REPLACE INTO universe_reviews VALUES (?,?,?,?)").run(ctx.runId, ctx.wallNow().toISOString(), add.length, removals.length);
    ctx.metric("add", add.length);
    ctx.metric("remove", removals.length);
    return { changes: { asOf: ctx.asOf, add, remove: removals, notes, skipped: null } };
  },
});

export const universeApply = defineNode({
  type: "universe.apply",
  title: "Apply universe changes",
  category: "universe",
  description:
    "Writes approved watchlist changes to config.yaml (comments kept) and applies them at once. manual: waits for a person in the Approvals screen (expires after timeoutHours). Never applies in replays. Held stocks that are removed keep their stops and exits.",
  version: 1,
  cache: "none",
  params: z.object({ mode: z.enum(["manual", "auto"]).default("manual"), timeoutHours: z.number().positive().default(168) }),
  inputs: { changes: { type: "UniverseChanges" } },
  outputs: { changes: { type: "UniverseChanges" } },
  async run(ctx, p, i) {
    const c = i.changes;
    const none = { changes: { ...c, add: [], remove: [] } };
    if (!c.add.length && !c.remove.length) return none;
    if (!ctx.live) {
      ctx.log("replay: watchlist changes are never applied to a past date");
      return none;
    }
    if (p.mode === "manual") {
      const a = ctx.approval();
      if (!a) {
        if (ctx.wallNow().getTime() - ctx.runCreatedAt.getTime() > p.timeoutHours * 3_600_000) {
          ctx.log("approval expired -> no changes");
          return none;
        }
        throw new WaitingForInput(`watchlist: +${c.add.length} / -${c.remove.length} awaiting approval`, c);
      }
      if (a.decision !== "approve") return none;
    }
    const r = applyWatchlistPatch(
      ctx.services,
      { add: c.add.map((x) => ({ ticker: x.ticker, name: x.name, aliases: x.aliases, sector: x.sector, reason: x.reason })), remove: c.remove.map((x) => ({ ticker: x.ticker, reason: x.reasons.join(" / ") })) },
      "review",
      `run ${ctx.runId}`,
      ctx.wallNow(),
    );
    ctx.log(`watchlist saved to ${r.file}: +${r.added.join(",") || "-"} -${r.removed.join(",") || "-"}`);
    ctx.metric("added", r.added.length);
    ctx.metric("removed", r.removed.length);
    return { changes: { ...c, add: c.add.filter((x) => r.added.includes(x.ticker) || r.updated.includes(x.ticker)), remove: c.remove.filter((x) => r.removed.includes(x.ticker)) } };
  },
});
