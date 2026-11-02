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

/**
 * H2b: numbers in free text (a rationale, a thesis, an objection) must come from the source.
 * Quotes are checked word for word above; this catches a made-up figure in the model's own words
 * ("EPS rose 25%" when the document never says 25). Small counts ("2 quarters") and years are
 * not checked; a number passes if the source has the same value, rounded to the precision
 * written, ignoring sign and thousands/millions scaling (1.2 billion = 1,200 million).
 */
const NUMBER = /([$¥€£]\s?)?(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?)(\s?%|\s?(?:bp|bps)\b)?/g;

interface Num {
  text: string;
  value: number;
  decimals: number;
  checkable: boolean;
}

function numbersIn(text: string): Num[] {
  const out: Num[] = [];
  for (const m of text.normalize("NFKC").matchAll(NUMBER)) {
    const digits = m[2]!.replace(/,/g, "");
    const value = Number(digits);
    if (!Number.isFinite(value)) continue;
    const decimals = digits.includes(".") ? digits.split(".")[1]!.length : 0;
    const unit = Boolean(m[1] || m[3]);
    const year = decimals === 0 && value >= 1900 && value <= 2100 && !unit;
    out.push({ text: m[0].trim(), value, decimals, checkable: !year && (decimals > 0 || unit || value >= 100) });
  }
  return out;
}

function sameNumber(x: Num, v: number): boolean {
  for (const scale of [1, 1e3, 1e-3, 1e6, 1e-6]) {
    const s = Math.abs(v) * scale;
    const f = 10 ** x.decimals;
    if (Math.abs(Math.round(s * f) / f - x.value) < 1e-9) return true;
  }
  return false;
}

export function checkNumbers(text: string, source: string): { ok: boolean; failed: string[] } {
  const src = numbersIn(source).map((n) => n.value);
  const failed = numbersIn(text)
    .filter((n) => n.checkable && !src.some((v) => sameNumber(n, v)))
    .map((n) => n.text);
  return { ok: failed.length === 0, failed: [...new Set(failed)] };
}
