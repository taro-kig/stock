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

/** Ranks (1..n, ties averaged) for the finite values; others stay null. Robust to outliers. */
export function ranks(values: Record<string, number | null | undefined>): Record<string, number | null> {
  const xs = Object.entries(values).filter((e): e is [string, number] => typeof e[1] === "number" && Number.isFinite(e[1])).sort((a, b) => a[1] - b[1]);
  const out: Record<string, number | null> = Object.fromEntries(Object.keys(values).map((k) => [k, null]));
  for (let i = 0; i < xs.length; ) {
    let j = i;
    while (j + 1 < xs.length && xs[j + 1]![1] === xs[i]![1]) j++;
    for (let k = i; k <= j; k++) out[xs[k]![0]] = (i + j) / 2 + 1;
    i = j + 1;
  }
  return out;
}

export interface NormalizeOptions {
  /** z: clipped z-scores of the values · rank: z-scores of the ranks (outliers cannot dominate). */
  method?: "z" | "rank";
  /** Ticker → sector: compare within the sector (sectors with fewer than minGroup values use the whole set). */
  sectorOf?: Record<string, string> | undefined;
  minGroup?: number;
}

/** One factor column → comparable scores (0 = average / missing). */
export function normalize(values: Record<string, number | null | undefined>, o: NormalizeOptions = {}): Record<string, number> {
  const base = o.method === "rank" ? ranks(values) : values;
  const global = zscores(base);
  if (!o.sectorOf) return global;
  const out = { ...global };
  const groups = new Map<string, string[]>();
  for (const t of Object.keys(values)) {
    const v = base[t];
    if (typeof v !== "number" || !Number.isFinite(v)) continue;
    const g = o.sectorOf[t] ?? "unknown";
    groups.set(g, [...(groups.get(g) ?? []), t]);
  }
  for (const members of groups.values()) {
    if (members.length < (o.minGroup ?? 3)) continue;
    const z = zscores(Object.fromEntries(members.map((t) => [t, base[t]])));
    for (const t of members) out[t] = z[t]!;
  }
  return out;
}

/** factors: factorName -> (ticker -> value). Returns ticker -> score, weights renormalized to the factors present. */
export function compositeScore(
  factors: Record<string, Record<string, number | null | undefined>>,
  tickers: readonly string[],
  weights: Record<string, number> = DEFAULT_WEIGHTS,
  opts: NormalizeOptions = {},
): Record<string, number> {
  const total: Record<string, number> = Object.fromEntries(tickers.map((t) => [t, 0]));
  let used = 0;
  for (const [name, w] of Object.entries(weights)) {
    const col = factors[name];
    if (!col || w === 0) continue;
    const z = normalize(Object.fromEntries(tickers.map((t) => [t, col[t]])), opts);
    for (const t of tickers) total[t]! += w * z[t]!;
    used += w;
  }
  if (used > 0) for (const t of tickers) total[t]! /= used;
  return total;
}

/**
 * What each factor added to each ticker's composite (weight × normalized value ÷ total weight
 * used), so the contributions sum to the composite score. For "why is this stock ranked here".
 */
export function scoreContributions(
  factors: Record<string, Record<string, number | null | undefined>>,
  tickers: readonly string[],
  weights: Record<string, number> = DEFAULT_WEIGHTS,
  opts: NormalizeOptions = {},
): Record<string, Record<string, number>> {
  const used = Object.entries(weights).filter(([name, w]) => factors[name] && w !== 0);
  const total = used.reduce((s, [, w]) => s + w, 0);
  const out: Record<string, Record<string, number>> = Object.fromEntries(tickers.map((t) => [t, {}]));
  if (!total) return out;
  for (const [name, w] of used) {
    const z = normalize(Object.fromEntries(tickers.map((t) => [t, factors[name]![t]])), opts);
    for (const t of tickers) out[t]![name] = (w * z[t]!) / total;
  }
  return out;
}

/** Tickers ordered best-first. */
export function rankTickers(scores: Record<string, number>): string[] {
  return Object.keys(scores).sort((a, b) => scores[b]! - scores[a]! || a.localeCompare(b));
}
