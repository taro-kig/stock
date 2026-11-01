import type { Bar, Prices } from "../signals/technical.ts";
import { weekdays, type IsoDate } from "../util/dates.ts";
import type { Prediction } from "./predictions.ts";

/**
 * Grading predictions against what happened (DESIGN §確度).
 *
 * Mid-term trades are too few to judge accuracy quickly, so every *judgment*
 * (bullish/bearish per ticker per day) is graded instead. Daily predictions with
 * a 20-day horizon overlap and are not independent, so significance is computed
 * on a non-overlapping subsample (nEff).
 */
export interface Graded extends Prediction {
  excess: number;
  hit: boolean;
}

export interface LabelCard {
  label: string;
  total: number;
  /** bullish + bearish */
  directional: number;
  coverage: number;
  graded: number;
  hitRate: number | null;
  nEff: number;
  hitRateEff: number | null;
  /** 95% Wilson lower bound of hitRateEff. */
  wilsonLow: number | null;
  meanExcessBullish: number | null;
  meanExcessBearish: number | null;
  byConviction: Array<{ bucket: string; graded: number; hitRate: number | null }>;
  promotion: { eligible: boolean; reason: string };
}

export interface Scorecard {
  asOf: IsoDate;
  horizonDays: number;
  labels: Record<string, LabelCard>;
}

function indexAtOrBefore(bars: readonly Bar[], date: IsoDate): number {
  let lo = 0;
  let hi = bars.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid]!.date <= date) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

function windowReturn(bars: readonly Bar[], d0: IsoDate, d1: IsoDate): number | null {
  const i0 = indexAtOrBefore(bars, d0);
  const i1 = indexAtOrBefore(bars, d1);
  if (i0 < 0 || i1 <= i0) return null;
  return bars[i1]!.close / bars[i0]!.close - 1;
}

/** Forward excess return over `horizon` bars vs the benchmark (or the equal-weight universe). */
export function forwardExcess(prices: Prices, p: Prediction, horizon: number, benchmark?: string): number | null {
  const bars = prices[p.ticker];
  if (!bars) return null;
  const i = indexAtOrBefore(bars, p.asOf);
  if (i < 0 || i + horizon >= bars.length) return null; // not matured yet
  const d0 = bars[i]!.date;
  const d1 = bars[i + horizon]!.date;
  const own = bars[i + horizon]!.close / bars[i]!.close - 1;
  let bench: number | null;
  if (benchmark && prices[benchmark]) bench = windowReturn(prices[benchmark]!, d0, d1);
  else {
    const rs = Object.entries(prices).filter(([t]) => t !== benchmark).map(([, b]) => windowReturn(b, d0, d1)).filter((x): x is number => x !== null);
    bench = rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : null;
  }
  return bench === null ? null : own - bench;
}

export function grade(preds: readonly Prediction[], prices: Prices, horizon: number, benchmark?: string): Graded[] {
  const out: Graded[] = [];
  for (const p of preds) {
    if (p.stance !== "bullish" && p.stance !== "bearish") continue;
    const excess = forwardExcess(prices, p, horizon, benchmark);
    if (excess === null) continue;
    out.push({ ...p, excess, hit: p.stance === "bullish" ? excess > 0 : excess < 0 });
  }
  return out;
}

/** Keeps, per ticker, predictions at least `horizon` weekdays apart (independent windows). */
export function nonOverlapping(graded: readonly Graded[], horizon: number): Graded[] {
  const byTicker = new Map<string, Graded[]>();
  for (const g of graded) byTicker.set(g.ticker, [...(byTicker.get(g.ticker) ?? []), g]);
  const out: Graded[] = [];
  for (const list of byTicker.values()) {
    let last: IsoDate | null = null;
    for (const g of [...list].sort((a, b) => a.asOf.localeCompare(b.asOf))) {
      if (last === null || weekdays(last, g.asOf).length - 1 >= horizon) {
        out.push(g);
        last = g.asOf;
      }
    }
  }
  return out;
}

export function wilsonLower(hits: number, n: number, z = 1.96): number | null {
  if (n === 0) return null;
  const p = hits / n;
  const denom = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return (centre - margin) / denom;
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const rate = (gs: Graded[]) => (gs.length ? gs.filter((g) => g.hit).length / gs.length : null);

export interface PromotionRule {
  minNEff: number;
  minWilsonLow: number;
  baselineLabel?: string | undefined;
}

export function buildScorecard(preds: readonly Prediction[], prices: Prices, asOf: IsoDate, horizon: number, rule: PromotionRule, benchmark?: string): Scorecard {
  const labels: Record<string, LabelCard> = {};
  const byLabel = new Map<string, Prediction[]>();
  for (const p of preds) byLabel.set(p.label, [...(byLabel.get(p.label) ?? []), p]);
  for (const [label, ps] of byLabel) {
    const g = grade(ps, prices, horizon, benchmark);
    const eff = nonOverlapping(g, horizon);
    const directional = ps.filter((p) => p.stance === "bullish" || p.stance === "bearish").length;
    const buckets = [
      ["<0.5", (c: number) => c < 0.5],
      ["0.5-0.7", (c: number) => c >= 0.5 && c < 0.7],
      [">=0.7", (c: number) => c >= 0.7],
    ] as const;
    labels[label] = {
      label,
      total: ps.length,
      directional,
      coverage: ps.length ? directional / ps.length : 0,
      graded: g.length,
      hitRate: rate(g),
      nEff: eff.length,
      hitRateEff: rate(eff),
      wilsonLow: wilsonLower(eff.filter((x) => x.hit).length, eff.length),
      meanExcessBullish: mean(g.filter((x) => x.stance === "bullish").map((x) => x.excess)),
      meanExcessBearish: mean(g.filter((x) => x.stance === "bearish").map((x) => x.excess)),
      byConviction: buckets.map(([bucket, f]) => {
        const gs = g.filter((x) => f(x.conviction));
        return { bucket, graded: gs.length, hitRate: rate(gs) };
      }),
      promotion: { eligible: false, reason: "" },
    };
  }
  for (const card of Object.values(labels)) card.promotion = promotion(card, labels, rule);
  return { asOf, horizonDays: horizon, labels };
}

/** Whether a decision source has *earned* more authority (DESIGN: 権限の段階的委譲). */
function promotion(card: LabelCard, all: Record<string, LabelCard>, rule: PromotionRule): { eligible: boolean; reason: string } {
  if (card.nEff < rule.minNEff) return { eligible: false, reason: `nEff ${card.nEff} < ${rule.minNEff}` };
  if (card.wilsonLow === null || card.wilsonLow <= rule.minWilsonLow) {
    return { eligible: false, reason: `wilsonLow ${card.wilsonLow?.toFixed(3) ?? "n/a"} <= ${rule.minWilsonLow}` };
  }
  const base = rule.baselineLabel ? all[rule.baselineLabel] : undefined;
  if (rule.baselineLabel && rule.baselineLabel !== card.label) {
    if (!base || base.hitRateEff === null) return { eligible: false, reason: `baseline "${rule.baselineLabel}" has no graded data` };
    if ((card.hitRateEff ?? 0) <= base.hitRateEff) return { eligible: false, reason: `does not beat baseline (${card.hitRateEff?.toFixed(3)} <= ${base.hitRateEff.toFixed(3)})` };
  }
  return { eligible: true, reason: "meets promotion rule" };
}
