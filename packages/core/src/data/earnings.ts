import type { Db } from "../util/db.ts";
import { addDays, type IsoDate } from "../util/dates.ts";

/**
 * Upcoming earnings dates. Source: Alpha Vantage EARNINGS_CALENDAR (free key, one request
 * returns every US company reporting in the next 3 months, as CSV).
 *
 * Point in time: each (ticker, report date) remembers the first and last day it was seen
 * in a downloaded calendar. A replay of a past date only uses dates that were known on
 * that day, so a later reschedule never leaks into the past.
 */
export interface EarningsEntry {
  ticker: string;
  reportDate: IsoDate;
  fiscalDateEnding: IsoDate | null;
  /** Consensus EPS estimate, when given. */
  estimate: number | null;
  /** "pre-market" / "post-market" when the source says so. */
  time: string | null;
}

/** What a run knows about one ticker's next report. */
export interface NextEarnings extends EarningsEntry {
  /** Calendar days from the run date (0 = today). */
  daysAway: number;
}

export type EarningsMap = Record<string, NextEarnings>;

/** Parses the EARNINGS_CALENDAR CSV (header-driven; extra or missing optional columns are fine). */
export function parseEarningsCsv(text: string): EarningsEntry[] {
  const t = text.trim();
  if (t.startsWith("{")) {
    // Alpha Vantage answers errors and rate limits as JSON with HTTP 200
    let msg = t.slice(0, 200);
    try {
      const o = JSON.parse(t) as Record<string, string>;
      msg = o["Error Message"] ?? o["Information"] ?? o["Note"] ?? msg;
    } catch {
      // keep the raw start
    }
    throw new Error(`Alpha Vantage: ${msg}`);
  }
  const [head, ...lines] = t.split(/\r?\n/);
  const cols = (head ?? "").split(",").map((c) => c.trim());
  const ix = (n: string) => cols.indexOf(n);
  const [si, ri] = [ix("symbol"), ix("reportDate")];
  if (si < 0 || ri < 0) throw new Error(`unexpected earnings calendar header: ${head?.slice(0, 120)}`);
  const fi = ix("fiscalDateEnding");
  const ei = ix("estimate");
  const ti = ix("timeOfTheDay");
  const out: EarningsEntry[] = [];
  for (const line of lines) {
    // company names may contain commas inside quotes
    const f = line.match(/("([^"]|"")*"|[^,]*)(,|$)/g)?.map((x) => x.replace(/,$/, "").replace(/^"|"$/g, "").replace(/""/g, '"')) ?? [];
    const ticker = (f[si] ?? "").trim().toUpperCase().replace(/-/g, ".");
    const reportDate = (f[ri] ?? "").trim();
    if (!ticker || !/^\d{4}-\d{2}-\d{2}$/.test(reportDate)) continue;
    const fd = fi >= 0 ? (f[fi] ?? "").trim() : "";
    const est = ei >= 0 ? Number(f[ei]) : Number.NaN;
    const time = ti >= 0 ? (f[ti] ?? "").trim() : "";
    out.push({ ticker, reportDate, fiscalDateEnding: /^\d{4}-\d{2}-\d{2}$/.test(fd) ? fd : null, estimate: ei >= 0 && f[ei]?.trim() && Number.isFinite(est) ? est : null, time: time || null });
  }
  return out;
}

const dayDiff = (a: IsoDate, b: IsoDate) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

export class EarningsStore {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
    db.exec(`
      CREATE TABLE IF NOT EXISTS earnings_calendar (
        ticker TEXT, report_date TEXT, fiscal_end TEXT, estimate REAL, time TEXT, first_seen TEXT, last_seen TEXT,
        PRIMARY KEY (ticker, report_date));
      CREATE TABLE IF NOT EXISTS earnings_fetches (day TEXT PRIMARY KEY, rows INT, fetched_at TEXT);`);
  }

  /** Records one downloaded calendar as seen on `day`. */
  save(day: IsoDate, entries: readonly EarningsEntry[], at: Date = new Date()): void {
    const up = this.#db.prepare(`INSERT INTO earnings_calendar VALUES (?,?,?,?,?,?,?)
      ON CONFLICT (ticker, report_date) DO UPDATE SET fiscal_end = excluded.fiscal_end, estimate = excluded.estimate, time = excluded.time,
        first_seen = MIN(first_seen, excluded.first_seen), last_seen = MAX(last_seen, excluded.last_seen)`);
    this.#db.exec("BEGIN");
    try {
      for (const e of entries) up.run(e.ticker, e.reportDate, e.fiscalDateEnding, e.estimate, e.time, day, day);
      this.#db.prepare("INSERT OR REPLACE INTO earnings_fetches VALUES (?,?,?)").run(day, entries.length, at.toISOString());
      this.#db.exec("COMMIT");
    } catch (e) {
      this.#db.exec("ROLLBACK");
      throw e;
    }
  }

  fetchedOn(day: IsoDate): boolean {
    return this.#db.prepare("SELECT 1 FROM earnings_fetches WHERE day = ?").get(day) !== undefined;
  }

  lastFetch(): { day: IsoDate; rows: number; fetchedAt: string } | null {
    const r = this.#db.prepare("SELECT day, rows, fetched_at FROM earnings_fetches ORDER BY day DESC LIMIT 1").get() as { day: string; rows: number; fetched_at: string } | undefined;
    return r ? { day: r.day, rows: r.rows, fetchedAt: r.fetched_at } : null;
  }

  /**
   * Next known report on or after `asOf` for each ticker, as known on `asOf`: the entry
   * must have been seen on or before asOf and still be listed around then (within
   * `staleDays`, which bridges days without a download such as weekends).
   */
  nextFor(tickers: readonly string[], asOf: IsoDate, staleDays = 7): EarningsMap {
    if (!tickers.length) return {};
    const rows = this.#db
      .prepare(
        `SELECT ticker, report_date, fiscal_end, estimate, time FROM earnings_calendar
         WHERE ticker IN (${tickers.map(() => "?").join(",")}) AND report_date >= ? AND first_seen <= ? AND last_seen >= ?
         ORDER BY report_date`,
      )
      .all(...tickers, asOf, asOf, addDays(asOf, -staleDays)) as Array<{ ticker: string; report_date: string; fiscal_end: string | null; estimate: number | null; time: string | null }>;
    const out: EarningsMap = {};
    for (const r of rows) {
      if (out[r.ticker]) continue;
      out[r.ticker] = { ticker: r.ticker, reportDate: r.report_date, fiscalDateEnding: r.fiscal_end, estimate: r.estimate, time: r.time, daysAway: dayDiff(asOf, r.report_date) };
    }
    return out;
  }

  /** Everything known (latest download) between two dates, for the calendar screen. */
  between(tickers: readonly string[], from: IsoDate, to: IsoDate): EarningsEntry[] {
    if (!tickers.length) return [];
    const last = this.lastFetch();
    if (!last) return [];
    const rows = this.#db
      .prepare(
        `SELECT ticker, report_date, fiscal_end, estimate, time FROM earnings_calendar
         WHERE ticker IN (${tickers.map(() => "?").join(",")}) AND report_date BETWEEN ? AND ? AND last_seen >= ?
         ORDER BY report_date, ticker`,
      )
      .all(...tickers, from, to, addDays(last.day, -7)) as Array<{ ticker: string; report_date: string; fiscal_end: string | null; estimate: number | null; time: string | null }>;
    return rows.map((r) => ({ ticker: r.ticker, reportDate: r.report_date, fiscalDateEnding: r.fiscal_end, estimate: r.estimate, time: r.time }));
  }
}

/** Downloads the calendar. The key is part of the URL (Alpha Vantage requires it), so URLs are never logged. */
export async function fetchEarningsCalendar(apiKey: string, fetchImpl: typeof fetch, horizon: "3month" | "6month" | "12month" = "3month"): Promise<EarningsEntry[]> {
  const url = `https://www.alphavantage.co/query?function=EARNINGS_CALENDAR&horizon=${horizon}&apikey=${encodeURIComponent(apiKey)}`;
  let res: Response;
  try {
    res = await fetchImpl(url, { signal: AbortSignal.timeout(30_000) });
  } catch (e) {
    const cause = e instanceof Error && e.cause instanceof Error ? `: ${e.cause.message}` : "";
    throw new Error(`cannot reach www.alphavantage.co: ${e instanceof Error ? e.message : String(e)}${cause}`);
  }
  if (!res.ok) throw new Error(`Alpha Vantage answered HTTP ${res.status}`);
  return parseEarningsCsv(await res.text());
}
