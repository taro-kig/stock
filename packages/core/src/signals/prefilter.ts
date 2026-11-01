import { docText, type Document } from "./models.ts";

export interface WatchlistEntry {
  name: string;
  aliases?: string[] | undefined;
  sector?: string | undefined;
}

const norm = (s: string) => s.normalize("NFKC").toLowerCase();
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const isAscii = (s: string) => /^[\x00-\x7f]*$/.test(s);

/** Tier 0: decide *without an LLM* which documents are worth paying for. */
export class Watchlist {
  readonly entries: Readonly<Record<string, WatchlistEntry>>;
  readonly #patterns = new Map<string, RegExp[]>();

  constructor(entries: Record<string, WatchlistEntry>) {
    this.entries = entries;
    for (const [ticker, e] of Object.entries(entries)) {
      const aliases = new Set([e.name, ...(e.aliases ?? [])].filter(Boolean).map(norm));
      // ASCII aliases need word boundaries ("sony" must not match "sonya"); Japanese has
      // no spaces, so a plain substring match is used there.
      this.#patterns.set(
        ticker,
        [...aliases].map((a) => (isAscii(a) ? new RegExp(`(?<![a-z0-9])${escapeRe(a)}(?![a-z0-9])`) : new RegExp(escapeRe(a)))),
      );
    }
  }

  get tickers(): string[] {
    return Object.keys(this.entries);
  }

  name(ticker: string): string {
    return this.entries[ticker]?.name ?? ticker;
  }

  sector(ticker: string): string {
    return this.entries[ticker]?.sector ?? "unknown";
  }

  match(doc: Document): Record<string, string> {
    const text = norm(docText(doc));
    const out: Record<string, string> = {};
    for (const [t, pats] of this.#patterns) if (pats.some((p) => p.test(text))) out[t] = this.name(t);
    return out;
  }
}

/** Near-duplicate key: a story syndicated by several sites usually keeps its headline. */
export function titleKey(title: string): string {
  return norm(title)
    .replace(/\s[-|｜]\s[^-|｜]+$/u, "") // drop trailing " - Publisher"
    .replace(/[\p{P}\p{S}\s_]+/gu, "");
}

/** Keeps the first copy of each story and records which other sources carried it. */
export function dedup(docs: readonly Document[]): Document[] {
  const kept = new Map<string, Document>();
  for (const d of docs) {
    const k = titleKey(d.title) || docText(d);
    const first = kept.get(k);
    if (!first) kept.set(k, { ...d, alsoSeenIn: [...d.alsoSeenIn] });
    else if (d.source !== first.source && !first.alsoSeenIn.includes(d.source)) first.alsoSeenIn.push(d.source);
  }
  return [...kept.values()];
}

/** A document plus the watchlist tickers it mentions (the LLM may only pick from these). */
export interface Match {
  doc: Document;
  candidates: Record<string, string>;
}
