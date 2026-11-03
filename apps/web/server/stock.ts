import {
  atr, earningsReactions, factorColumns, forwardExcess, periodReturn, resolveRef, scoreContributions, stopPrice, summarizeInsider, valuation,
  WorkflowSpec, type Bar, type EstimatesMap, type FactorTable, type FundamentalsMap, type InsiderMap, type MarketContext, type NodeRegistry, type Prices, type Services,
} from "@stockai/core";
import type { StockView } from "../shared/types.ts";

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
  const bench = s.config.market.benchmark;
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
    currency: s.config.market.currency, asOf,
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
