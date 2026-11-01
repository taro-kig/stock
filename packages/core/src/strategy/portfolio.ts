import type { IsoDate } from "../util/dates.ts";
import { positionSize, stopPrice, type RiskConfig, type TradingMode } from "./risk.ts";
import { rankTickers } from "./scoring.ts";

export interface Position {
  ticker: string;
  shares: number;
  entryPrice: number;
  highestClose: number;
  sector: string;
  entryDate: IsoDate;
  daysHeld: number;
}

export interface Candidate {
  ticker: string;
  price: number;
  atr: number;
  sector: string;
  trendOk: boolean;
  /** e.g. "earnings in 2 days" — blocks entry. */
  blockedReason?: string | undefined;
}

export interface Proposal {
  action: "buy" | "sell";
  ticker: string;
  shares: number;
  price: number;
  reason: string;
  stop?: number | undefined;
}

export interface RebalanceInput {
  /** ticker -> desirability; higher is better. */
  scores: Record<string, number>;
  candidates: Record<string, Candidate>;
  positions: Record<string, Position>;
  equity: number;
  mode: TradingMode;
  /** Market regime (e.g. index above its 200DMA). */
  regimeOk: boolean;
  /** Held tickers whose thesis is broken -> sell. */
  thesisBroken: readonly string[];
  /** If set, only these may be bought (e.g. AI consensus "bullish"). */
  eligible?: readonly string[] | undefined;
  /** Held tickers exempt from the rank-based exit (e.g. AI still neutral/bullish). */
  keep?: readonly string[] | undefined;
}

export interface RebalanceOptions {
  topN: number;
  exitRankMult: number;
  timeStopDays: number;
}

/** Rebalance proposals with hysteresis and hard constraints (DESIGN §6.3–6.5). */
export function proposeRebalance(inp: RebalanceInput, cfg: RiskConfig, opt: RebalanceOptions): Proposal[] {
  const ranked = rankTickers(inp.scores);
  const rank = new Map(ranked.map((t, i) => [t, i + 1]));
  const keep = new Set(inp.keep ?? []);
  const broken = new Set(inp.thesisBroken);
  const out: Proposal[] = [];

  // --- exits first ---
  const remaining: Position[] = [];
  for (const p of Object.values(inp.positions)) {
    const c = inp.candidates[p.ticker];
    const price = c?.price ?? p.entryPrice;
    const r = rank.get(p.ticker) ?? Number.POSITIVE_INFINITY;
    let reason: string | null = null;
    if (broken.has(p.ticker)) reason = "thesis broken";
    else if (c && c.price <= stopPrice(p.entryPrice, p.highestClose, c.atr, cfg)) reason = "stop hit";
    else if (!keep.has(p.ticker) && r > opt.topN * opt.exitRankMult) reason = `rank ${Number.isFinite(r) ? r : "n/a"} > ${opt.topN * opt.exitRankMult}`;
    else if (p.daysHeld >= opt.timeStopDays && price <= p.entryPrice) reason = `time stop (${p.daysHeld}d without profit)`;
    else if (inp.mode === "reduce") reason = "drawdown limit: reduce exposure";
    if (reason) out.push({ action: "sell", ticker: p.ticker, shares: p.shares, price, reason });
    else remaining.push(p);
  }

  // --- entries ---
  if (inp.mode !== "normal" || !inp.regimeOk) return out;
  const eligible = inp.eligible ? new Set(inp.eligible) : null;
  const held = new Set(remaining.map((p) => p.ticker));
  // never buy back what this same rebalance just sold (e.g. a stop hit on a still top-ranked name)
  const exitedNow = new Set(out.filter((p) => p.action === "sell").map((p) => p.ticker));
  const sectorValue = new Map<string, number>();
  for (const p of remaining) {
    const px = inp.candidates[p.ticker]?.price ?? p.entryPrice;
    sectorValue.set(p.sector, (sectorValue.get(p.sector) ?? 0) + p.shares * px);
  }
  let slots = cfg.maxPositions - remaining.length;
  for (const t of ranked.slice(0, opt.topN)) {
    if (slots <= 0) break;
    const c = inp.candidates[t];
    if (held.has(t) || exitedNow.has(t) || !c || !c.trendOk || c.blockedReason || (eligible && !eligible.has(t))) continue;
    const shares = positionSize(inp.equity, c.price, c.atr, cfg);
    if (shares === 0) continue;
    const value = shares * c.price;
    if (((sectorValue.get(c.sector) ?? 0) + value) / inp.equity > cfg.maxSectorWeight) continue;
    sectorValue.set(c.sector, (sectorValue.get(c.sector) ?? 0) + value);
    slots--;
    out.push({ action: "buy", ticker: t, shares, price: c.price, reason: `rank ${rank.get(t)}`, stop: c.price - cfg.stopAtrMult * c.atr });
  }
  return out;
}
