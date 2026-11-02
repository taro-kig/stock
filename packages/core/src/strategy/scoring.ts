/** Cross-sectional composite score (DESIGN §6.2). Deterministic, no LLM. */
/**
 * Factors that are not connected are skipped and the rest renormalized (insider needs the Form 4
 * input; quality = operating margin and growth = revenue growth need the SEC financials input;
 * revision = 30-day change of the consensus EPS needs the estimates input; sector = the sector ETF's
 * 60-day return vs the market needs the market input).
 */
export const DEFAULT_WEIGHTS: Record<string, number> = { momentum: 0.35, event: 0.35, relStrength: 0.15, quality: 0.15, growth: 0.15, revision: 0.15, sector: 0.1, insider: 0.15 };

/** z-scores clipped to ±clip; non-finite inputs become 0 (neutral). */
export function zscores(values: Record<string, number | null | undefined>, clip = 3): Record<string, number> {
  const finite = Object.values(values).filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  const mean = finite.reduce((a, b) => a + b, 0) / (finite.length || 1);
  const sd = Math.sqrt(finite.reduce((a, b) => a + (b - mean) ** 2, 0) / (finite.length || 1));
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(values)) {
    out[k] = typeof v === "number" && Number.isFinite(v) && sd > 0 ? Math.max(-clip, Math.min(clip, (v - mean) / sd)) : 0;
  }
  return out;
}

/** factors: factorName -> (ticker -> value). Returns ticker -> score, weights renormalized to the factors present. */
export function compositeScore(
  factors: Record<string, Record<string, number | null | undefined>>,
  tickers: readonly string[],
  weights: Record<string, number> = DEFAULT_WEIGHTS,
): Record<string, number> {
  const total: Record<string, number> = Object.fromEntries(tickers.map((t) => [t, 0]));
  let used = 0;
  for (const [name, w] of Object.entries(weights)) {
    const col = factors[name];
    if (!col) continue;
    const z = zscores(Object.fromEntries(tickers.map((t) => [t, col[t]])));
    for (const t of tickers) total[t]! += w * z[t]!;
    used += w;
  }
  if (used > 0) for (const t of tickers) total[t]! /= used;
  return total;
}

/** Tickers ordered best-first. */
export function rankTickers(scores: Record<string, number>): string[] {
  return Object.keys(scores).sort((a, b) => scores[b]! - scores[a]! || a.localeCompare(b));
}
