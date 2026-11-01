/**
 * H2: verify that quoted evidence literally appears in the source text.
 *
 * The cheapest and most effective anti-hallucination check: a string
 * comparison that costs nothing and that cheap models cannot argue around.
 */
const QUOTES = /[「」『』"'“”‘’]/g;
const WS = /\s+/g;
const ELLIPSIS = /\.{3,}|・{3,}/g; // models add these when trimming a quote

export function normalize(text: string): string {
  // NFKC folds full-width characters (４．９兆円 -> 4.9兆円). Whitespace is dropped
  // because models often insert or remove spaces in Japanese text.
  return text.normalize("NFKC").toLowerCase().replace(QUOTES, "").replace(ELLIPSIS, "").replace(WS, "");
}

/** Length of the longest common substring (O(|s|·|q|), fine for documents of a few KB). */
export function longestCommonSubstring(s: string, q: string): number {
  let best = 0;
  let prev = new Array<number>(q.length + 1).fill(0);
  for (let i = 1; i <= s.length; i++) {
    const cur = new Array<number>(q.length + 1).fill(0);
    for (let j = 1; j <= q.length; j++) {
      if (s[i - 1] === q[j - 1]) {
        const v = prev[j - 1]! + 1;
        cur[j] = v;
        if (v > best) best = v;
      }
    }
    prev = cur;
  }
  return best;
}

export interface GroundingOptions {
  /** Fraction of the quote that must appear as one contiguous block. */
  minRatio?: number;
  /** Quotes shorter than this (after normalization) prove nothing, e.g. a bare company name. */
  minLength?: number;
}

export function quoteInSource(quote: string, source: string, opts: GroundingOptions = {}): boolean {
  const { minRatio = 0.9, minLength = 6 } = opts;
  const q = normalize(quote);
  const s = normalize(source);
  if (q.length < minLength) return false;
  if (s.includes(q)) return true;
  // tolerate a small edit at the ends (an ellipsis, a dropped particle)
  return longestCommonSubstring(s, q) / q.length >= minRatio;
}

/** All quotes must be grounded, and there must be at least `minQuotes` of them. */
export function checkEvidence(
  quotes: readonly string[],
  source: string,
  opts: GroundingOptions & { minQuotes?: number } = {},
): { ok: boolean; failed: string[] } {
  const failed = quotes.filter((q) => !quoteInSource(q, source, opts));
  return { ok: failed.length === 0 && quotes.length >= (opts.minQuotes ?? 1), failed };
}
