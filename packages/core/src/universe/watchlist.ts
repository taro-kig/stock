import type { Services } from "../services.ts";
import { saveWatchlist } from "../util/configFile.ts";
import type { IsoDate } from "../util/dates.ts";

/** A proposed or applied edit of the watchlist (the "universe" the system watches and may buy). */
export interface UniverseAdd {
  ticker: string;
  name: string;
  aliases: string[];
  sector: string;
  reason: string;
  /** Official SEC name and exchange, when verified. */
  listing?: { name: string; exchange: string; cik: number } | null;
  /** Mean daily traded value over the last 20 sessions (price × volume), when checked. */
  avgDollarVolume?: number | null;
}

export interface UniverseRemove {
  ticker: string;
  name: string;
  reasons: string[];
  /** Still held somewhere: removal stops new buys only; stops and exits keep working. */
  held: boolean;
}

export interface UniverseChanges {
  asOf: IsoDate;
  add: UniverseAdd[];
  remove: UniverseRemove[];
  /** Context for the reviewer (past picks, skipped checks …). */
  notes: string[];
  /** Set when the review did not run (too soon, replay …). */
  skipped: string | null;
}

export type ChangeSource = "ui" | "mcp" | "review";

export interface WatchlistChangeRow {
  id: number;
  at: string;
  source: ChangeSource;
  added: Array<{ ticker: string; name: string; reason: string }>;
  removed: Array<{ ticker: string; reason: string }>;
  note: string;
}

function ensure(s: Services): void {
  s.db.exec(`CREATE TABLE IF NOT EXISTS watchlist_changes (
    id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT, source TEXT, added_json TEXT, removed_json TEXT, note TEXT)`);
}

export function logWatchlistChange(s: Services, source: ChangeSource, added: WatchlistChangeRow["added"], removed: WatchlistChangeRow["removed"], note = "", at: Date = new Date()): void {
  if (!added.length && !removed.length) return;
  ensure(s);
  s.db.prepare("INSERT INTO watchlist_changes (at, source, added_json, removed_json, note) VALUES (?,?,?,?,?)")
    .run(at.toISOString(), source, JSON.stringify(added), JSON.stringify(removed), note.slice(0, 500));
}

export function watchlistHistory(s: Services, limit = 50): WatchlistChangeRow[] {
  ensure(s);
  const rows = s.db.prepare("SELECT * FROM watchlist_changes ORDER BY id DESC LIMIT ?").all(limit) as Array<{
    id: number; at: string; source: ChangeSource; added_json: string; removed_json: string; note: string;
  }>;
  return rows.map((r) => ({ id: r.id, at: r.at, source: r.source, added: JSON.parse(r.added_json), removed: JSON.parse(r.removed_json), note: r.note }));
}

/** When each currently watched ticker was (last) added, by whom and why. */
export function additionDates(s: Services): Record<string, { at: string; source: ChangeSource; reason: string }> {
  const out: Record<string, { at: string; source: ChangeSource; reason: string }> = {};
  for (const row of [...watchlistHistory(s, 1000)].reverse()) {
    for (const a of row.added) out[a.ticker] = { at: row.at, source: row.source, reason: a.reason };
    for (const r of row.removed) delete out[r.ticker];
  }
  return out;
}

export interface WatchlistPatch {
  add?: Array<{ ticker: string; name: string; aliases?: string[]; sector?: string; reason?: string; market?: "us" | "jp" }>;
  remove?: Array<{ ticker: string; reason?: string }>;
  benchmark?: string;
}

/**
 * Applies a patch to the *current* watchlist (adds or updates entries, removes others),
 * writes config.yaml (comments kept), switches the running services over and logs it.
 */
export function applyWatchlistPatch(s: Services, patch: WatchlistPatch, source: ChangeSource, note = "", at: Date = new Date()) {
  if (!s.configPath) throw new Error("the config file path is unknown, so the watchlist cannot be saved (start with --config)");
  const next: Record<string, { name: string; aliases: string[]; sector: string; market?: "us" | "jp" | undefined }> = structuredClone(s.config.watchlist);
  const added: WatchlistChangeRow["added"] = [];
  const updated: string[] = [];
  const removed: WatchlistChangeRow["removed"] = [];
  const skipped: string[] = [];
  for (const r of patch.remove ?? []) {
    const t = r.ticker.trim().toUpperCase();
    if (!(t in next)) {
      skipped.push(`${t}: not in the watchlist`);
      continue;
    }
    delete next[t];
    removed.push({ ticker: t, reason: r.reason ?? "" });
  }
  for (const a of patch.add ?? []) {
    const t = a.ticker.trim().toUpperCase();
    const prev = next[t];
    const market = a.market ?? prev?.market;
    next[t] = { name: a.name.trim(), aliases: a.aliases ?? prev?.aliases ?? [], sector: a.sector ?? prev?.sector ?? "unknown", ...(market ? { market } : {}) };
    if (prev) updated.push(t);
    else added.push({ ticker: t, name: a.name.trim(), reason: a.reason ?? "" });
  }
  const r = saveWatchlist(s.configPath, next, patch.benchmark);
  s.updateWatchlist(r.config.watchlist, r.config.market.benchmark ?? "", r.config.markets);
  logWatchlistChange(s, source, added, removed, note, at);
  return { file: r.file, created: r.created, added: added.map((x) => x.ticker), updated, removed: removed.map((x) => x.ticker), skipped, tickers: Object.keys(r.config.watchlist).length };
}
