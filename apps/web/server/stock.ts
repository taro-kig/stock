import {
  atr, buildTrades, summarizeTrades, earningsReactions, factorColumns, forwardExcess, periodReturn, resolveRef, scoreContributions, stopPrice, summarizeInsider, valuation,
  WorkflowSpec, type Bar, type EstimatesMap, type FactorTable, type FundamentalsMap, type InsiderMap, type MarketContext, type NodeRegistry, type Prices, type Services,
} from "@stockai/core";
import type { JournalView, StockView, TodayView } from "../shared/types.ts";

const SOURCES = ["twelvedata", "jquants", "stooq"];
const OK = new Set(["ok", "cached", "fallback"]);

function artifactOf<T>(s: Services, row: { status: string; outputs: Record<string, string> } | undefined, port: string): T | undefined {
  const h = row?.outputs[port];
  if (!h || !row || !OK.has(row.status)) return undefined;
  try {
    return s.runStore.getArtifact(h) as T;
  } catch {
    return undefined;
  }
}

/** Daily bars for a ticker: the local price copy, else the newest run that had them (synthetic demo prices). */
export function barsFor(s: Services, registry: NodeRegistry, ticker: string): Bar[] {
  for (const src of SOURCES) {
    const b = s.priceStore.bars(src, ticker);
    if (b.length) return b;
  }
  for (const run of s.runStore.listRuns(40)) {
    const spec = WorkflowSpec.safeParse(JSON.parse(run.specJson));
    if (!spec.success) continue;
    const rows = s.runStore.nodeRuns(run.runId);
    for (const [id, cfg] of Object.entries(spec.data.nodes)) {
      const def = registry.get(cfg.use);
      const port = def && Object.entries(def.outputs).find(([, o]) => o.type === "Prices")?.[0];
      if (!port) continue;
      const prices = artifactOf<Prices>(s, rows.find((r) => r.nodeId === id), port);
      if (prices?.[ticker]?.length) return prices[ticker]!;
    }
  }
  return [];
}

/** The newest composite score that includes the ticker, with each factor's contribution. */
function scoreFor(s: Services, registry: NodeRegistry, ticker: string): StockView["score"] {
  for (const run of s.runStore.listRuns(80)) {
    const parsed = WorkflowSpec.safeParse(JSON.parse(run.specJson));
    if (!parsed.success) continue;
    const spec = parsed.data;
    const ids = Object.entries(spec.nodes).filter(([, c]) => c.use === "signal.score").map(([id]) => id);
    if (!ids.length) continue;
    const rows = s.runStore.nodeRuns(run.runId);
    for (const id of ids) {
      const scores = artifactOf<Record<string, number>>(s, rows.find((r) => r.nodeId === id), "scores");
      if (!scores || !(ticker in scores)) continue;
      const cfg = spec.nodes[id]!;
      const input = <T,>(port: string): T | undefined => {
        const ref = cfg.in[port];
        if (!ref) return undefined;
        const r = resolveRef(ref, spec, registry);
        return typeof r === "string" ? undefined : artifactOf<T>(s, rows.find((x) => x.nodeId === r.node), r.port);
      };
      const factors = input<FactorTable>("factors");
      if (!factors) continue;
      const def = registry.get("signal.score")!;
      const p = def.params.parse(cfg.params) as { weights: Record<string, number>; normalize: "z" | "rank"; sectorNeutral: boolean };
      const tableRows = Object.values(factors.rows);
      const cols = factorColumns({
        asOf: run.asOf, rows: tableRows, events: input<Record<string, number>>("events"), insider: input<InsiderMap>("insider"),
        fundamentals: input<FundamentalsMap>("fundamentals"), estimates: input<EstimatesMap>("estimates"), market: input<MarketContext>("market"),
      });
      const tickers = tableRows.map((r) => r.ticker);
      const contributions = scoreContributions(cols, tickers, p.weights, { method: p.normalize, sectorOf: p.sectorNeutral ? Object.fromEntries(tableRows.map((r) => [r.ticker, r.sector])) : undefined });
      const ranked = Object.keys(scores).sort((a, b) => scores[b]! - scores[a]!);
      return {
        asOf: run.asOf, runId: run.runId, workflow: run.workflow, total: scores[ticker]!, rank: ranked.indexOf(ticker) + 1, of: ranked.length,
        contributions: contributions[ticker] ?? {}, weights: p.weights,
      };
    }
  }
  return null;
}

/** The newest market & sector context (data.market). */
function marketFor(s: Services): MarketContext | null {
  for (const run of s.runStore.listRuns(40)) {
    const spec = WorkflowSpec.safeParse(JSON.parse(run.specJson));
    if (!spec.success) continue;
    const id = Object.entries(spec.data.nodes).find(([, c]) => c.use === "data.market")?.[0];
    if (!id) continue;
    const m = artifactOf<MarketContext>(s, s.runStore.nodeRuns(run.runId).find((r) => r.nodeId === id), "market");
    if (m) return m;
  }
  return null;
}

export function latestMarket(s: Services): MarketContext | null {
  return marketFor(s);
}

export function stockView(s: Services, registry: NodeRegistry, ticker: string, now: Date): StockView {
  const today = now.toISOString().slice(0, 10);
  const w = s.watchlist;
  const held = s.heldTickers();
  const tickerMarket = s.market(s.marketOf(ticker));
  const bench = tickerMarket.benchmark;
  const bars = barsFor(s, registry, ticker);
  const benchBars = bench ? barsFor(s, registry, bench) : [];
  const asOf = bars.at(-1)?.date ?? today;
  const close = bars.at(-1)?.close ?? null;
  const prices: Prices = { [ticker]: bars, ...(bench ? { [bench]: benchBars } : {}) };
  const ret = (n: number) => (bars.length > n ? periodReturn(bars, n) : null);
  const bret = (n: number) => (benchBars.length > n ? periodReturn(benchBars, n) : null);

  const judgments = s.predictions.all().filter((p) => p.ticker === ticker).slice(-200).map((p) => {
    const excess = bars.length ? forwardExcess(prices, p, 20, bench && benchBars.length ? bench : undefined) : null;
    return {
      asOf: p.asOf, label: p.label, stance: p.stance, conviction: p.conviction, thesis: p.thesis ?? null, invalidation: p.invalidation ?? [],
      excess20: excess, hit: excess === null || (p.stance !== "bullish" && p.stance !== "bearish") ? null : p.stance === "bullish" ? excess > 0 : excess < 0,
    };
  });

  const a = bars.length >= 21 ? atr(bars) : null;
  const positions = s.paperBook.openPositions(ticker).map((p) => {
    const px = close ?? p.entryPrice;
    const days = bars.filter((b) => b.date > p.entryDate).length;
    return {
      account: p.account, currency: p.currency, shares: p.shares, entryPrice: p.entryPrice, entryDate: p.entryDate, close: px, daysHeld: days,
      pnl: (px - p.entryPrice) * p.shares, pnlPct: px / p.entryPrice - 1,
      stop: a !== null && Number.isFinite(a) ? stopPrice(p.entryPrice, Math.max(p.highestClose, px), a, s.risk) : null,
    };
  });

  const fundamentals = s.fundamentals.at([ticker], today)[ticker] ?? null;
  const results = s.earningsResults.recent([ticker], today, 8)[ticker] ?? [];
  const insiderTrades = s.insider.trades(ticker, today, now, 180);
  const market = marketFor(s);
  const sectorName = ticker in w.entries ? w.sector(ticker) : (held[ticker] ?? "unknown");
  const sec = market?.sectors[sectorName];
  const events = s.docStore
    .acceptedEvents(new Date(now.getTime() - 180 * 86_400_000), now, s.config.prompts.event)
    .filter((e) => e.event.tickers.includes(ticker))
    .reverse()
    .slice(0, 30)
    .map((e) => ({ learnedAt: e.learnedAt, title: e.title, url: e.url, source: e.source, eventType: e.event.eventType, direction: e.event.direction, materiality: e.event.materiality, evidence: e.event.evidence }));

  return {
    ticker, name: ticker in w.entries ? w.name(ticker) : ticker, sector: sectorName, inWatchlist: ticker in w.entries, held: ticker in held,
    currency: tickerMarket.currency, asOf,
    bars: bars.slice(-400).map((b) => ({ date: b.date, close: b.close })),
    benchmark: bench ?? null,
    returns: { d20: ret(20), d60: ret(60), d250: ret(250), bench60: bret(60) },
    judgments,
    fills: s.paperBook.allFills(ticker),
    positions,
    score: scoreFor(s, registry, ticker),
    fundamentals, valuation: fundamentals && close !== null ? valuation(fundamentals, close) : null,
    estimates: s.estimates.at([ticker], today)[ticker] ?? [],
    earnings: {
      next: s.earnings.nextFor([ticker], today)[ticker] ?? null,
      results,
      reactions: earningsReactions(results, bars, benchBars.length ? benchBars : undefined, asOf),
    },
    insider: insiderTrades.length ? summarizeInsider(ticker, insiderTrades, 180) : null,
    sectorRead: sec ? { etf: sec.etf, rank: sec.rank, of: Object.values(market!.sectors).filter((x) => x.rank !== null).length, rel60: sec.rel60 } : null,
    events,
  };
}

/** Day of the newest row of a table column (null when the table does not exist or is empty). */
function latestDay(s: Services, table: string, column: string): string | null {
  try {
    const r = s.db.prepare(`SELECT MAX(${column}) AS d FROM ${table}`).get() as { d: string | null } | undefined;
    return r?.d ? String(r.d).slice(0, 10) : null;
  } catch {
    return null;
  }
}

/** The overview's "today in the market": risk level, sectors, gauges, earnings of holdings, and how fresh each data source is. */
export function todayView(s: Services, now: Date): TodayView {
  const today = now.toISOString().slice(0, 10);
  const held = Object.keys(s.heldTickers());
  const next = s.earnings.nextFor(held, today);
  const daysOld = (d: string | null) => (d ? Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${d}T00:00:00Z`)) / 86_400_000) : null);
  const src = (label: string, day: string | null, maxDays: number, hint: string): TodayView["freshness"][number] => {
    const age = daysOld(day);
    return { label, day, age, stale: age !== null && age > maxDays, hint };
  };
  return {
    market: latestMarket(s),
    earnings: Object.values(next).filter((e) => e.daysAway <= 14).sort((a, b) => a.daysAway - b.daysAway).map((e) => ({ ticker: e.ticker, reportDate: e.reportDate, daysAway: e.daysAway, time: e.time })),
    freshness: [
      src("株価", latestDay(s, "price_fetches", "fetched_at"), 4, "株価ノードを含むワークフローの実行"),
      src("決算予定（Alpha Vantage）", s.earnings.lastFetch()?.day ?? null, 4, "data.earnings"),
      src("決算実績", latestDay(s, "earnings_result_fetches", "day"), 30, "data.earningsResults（決算後だけ取得）"),
      src("予想の記録", latestDay(s, "calendar_estimates", "day"), 4, "data.earnings（毎日の予想を記録）"),
      src("財務データ（SEC）", latestDay(s, "fundamental_fetches", "day"), 10, "data.fundamentals"),
      src("インサイダー（SEC）", latestDay(s, "insider_filings", "filed_at"), 10, "data.insider"),
      src("相場の指標（FRED）", latestDay(s, "macro_fetches", "day"), 4, "data.market と FRED_API_KEY"),
      src("検証用の銘柄", latestDay(s, "research_universe", "built"), 40, "factor-research"),
    ],
  };
}

/** Paper trades per account, with the judgment behind each entry. */
export function journalView(s: Services, registry: NodeRegistry, now: Date): JournalView {
  const today = now.toISOString().slice(0, 10);
  const closes = new Map<string, { close: number; date: string } | null>();
  const lastClose = (t: string) => {
    if (!closes.has(t)) {
      const b = barsFor(s, registry, t).at(-1);
      closes.set(t, b ? { close: b.close, date: b.date } : null);
    }
    return closes.get(t)!;
  };
  const trades = buildTrades(s.paperBook.allFills(), s.predictions.all(), { lastClose, today });
  return {
    accounts: s.paperBook.accounts().map((a) => {
      const ts = trades.filter((t) => t.account === a.account);
      return { account: a.account, currency: a.currency, summary: summarizeTrades(ts), trades: ts };
    }).filter((a) => a.trades.length),
    brokerOrders: s.brokerLedger.recentOrders(50),
  };
}
