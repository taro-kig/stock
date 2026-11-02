import { z } from "zod";
import { addDays, type IsoDate } from "../util/dates.ts";
import type { Db } from "../util/db.ts";

/**
 * Reported earnings per quarter (EPS actual vs consensus) from Alpha Vantage EARNINGS, so
 * "beat or miss" is a number computed by the program instead of something a model reads out
 * of a long press release. Used three ways: as facts in the judgment sheet, to reject event
 * votes that contradict the data, and to drop such events before they move a score.
 *
 * Point in time: a result counts from its reported date (the daily run happens after the US
 * close, so pre- and post-market reports of that day are both known).
 */
export interface EarningsResult {
  ticker: string;
  fiscalDateEnding: IsoDate;
  reportedDate: IsoDate;
  /** "pre-market" / "post-market" when given. */
  reportTime: string | null;
  reportedEPS: number | null;
  estimatedEPS: number | null;
  /** (reported − estimate) / |estimate|, in %, computed here (not taken from the source). */
  surprisePct: number | null;
}

/** Newest first, only results reported on or before the run date. */
export type EarningsResults = Record<string, EarningsResult[]>;

export type EarningsVerdict = "beat" | "miss" | "inline";

/** Within ±2 % (or a cent) of the estimate counts as in line. */
export function verdictOf(r: EarningsResult, thresholdPct = 2): EarningsVerdict | null {
  if (r.reportedEPS === null || r.estimatedEPS === null || r.surprisePct === null) return null;
  if (Math.abs(r.reportedEPS - r.estimatedEPS) < 0.01) return "inline";
  if (r.surprisePct >= thresholdPct) return "beat";
  if (r.surprisePct <= -thresholdPct) return "miss";
  return "inline";
}

const VERDICT_JA: Record<EarningsVerdict, string> = { beat: "上振れ", miss: "下振れ", inline: "予想どおり" };

const num = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() && v !== "None" ? Number(v) : Number.NaN;
  return Number.isFinite(n) ? n : null;
};
const isoDate = (v: unknown): IsoDate | null => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);

export function surprisePct(reported: number | null, estimated: number | null): number | null {
  if (reported === null || estimated === null || estimated === 0) return null;
  return Math.round(((reported - estimated) / Math.abs(estimated)) * 1000) / 10;
}

const Quarter = z.object({ fiscalDateEnding: z.unknown(), reportedDate: z.unknown(), reportedEPS: z.unknown(), estimatedEPS: z.unknown(), reportTime: z.unknown().optional() });

/** Parses the EARNINGS JSON (errors and rate limits come back as JSON with HTTP 200). */
export function parseEarningsResults(body: unknown, ticker: string): EarningsResult[] {
  const o = (body ?? {}) as Record<string, unknown>;
  const msg = o["Error Message"] ?? o["Information"] ?? o["Note"];
  if (typeof msg === "string") throw new AlphaVantageLimit(`Alpha Vantage: ${msg.slice(0, 200)}`);
  const rows = z.array(Quarter).safeParse(o["quarterlyEarnings"] ?? []);
  if (!rows.success) throw new Error(`unexpected EARNINGS response for ${ticker}`);
  const out: EarningsResult[] = [];
  for (const q of rows.data) {
    const fiscalDateEnding = isoDate(q.fiscalDateEnding);
    const reportedDate = isoDate(q.reportedDate);
    if (!fiscalDateEnding || !reportedDate) continue;
    const reportedEPS = num(q.reportedEPS);
    const estimatedEPS = num(q.estimatedEPS);
    out.push({
      ticker, fiscalDateEnding, reportedDate, reportTime: typeof q.reportTime === "string" && q.reportTime ? q.reportTime : null,
      reportedEPS, estimatedEPS, surprisePct: surprisePct(reportedEPS, estimatedEPS),
    });
  }
  return out.sort((a, b) => b.reportedDate.localeCompare(a.reportedDate));
}

/** An answer that means "stop asking today" (rate limit, invalid key). */
export class AlphaVantageLimit extends Error {
  override name = "AlphaVantageLimit";
}

/** One request per ticker. The key is part of the URL (Alpha Vantage requires it), so URLs are never logged. */
export async function fetchEarningsResults(apiKey: string, ticker: string, fetchImpl: typeof fetch): Promise<EarningsResult[]> {
  const url = `https://www.alphavantage.co/query?function=EARNINGS&symbol=${encodeURIComponent(ticker.replace(/\./g, "-"))}&apikey=${encodeURIComponent(apiKey)}`;
  let res: Response;
  try {
    res = await fetchImpl(url, { signal: AbortSignal.timeout(30_000) });
  } catch (e) {
    throw new Error(`cannot reach www.alphavantage.co: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!res.ok) throw new Error(`Alpha Vantage answered HTTP ${res.status}`);
  return parseEarningsResults(await res.json(), ticker);
}

export class EarningsResultStore {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
    db.exec(`
      CREATE TABLE IF NOT EXISTS earnings_results (
        ticker TEXT, fiscal_end TEXT, reported_date TEXT, report_time TEXT, reported_eps REAL, estimated_eps REAL,
        PRIMARY KEY (ticker, fiscal_end));
      CREATE TABLE IF NOT EXISTS earnings_result_fetches (ticker TEXT, day TEXT, PRIMARY KEY (ticker, day));`);
  }

  save(ticker: string, day: IsoDate, results: readonly EarningsResult[]): void {
    const up = this.#db.prepare("INSERT OR REPLACE INTO earnings_results VALUES (?,?,?,?,?,?)");
    this.#db.exec("BEGIN");
    try {
      for (const r of results) up.run(ticker, r.fiscalDateEnding, r.reportedDate, r.reportTime, r.reportedEPS, r.estimatedEPS);
      this.#db.prepare("INSERT OR REPLACE INTO earnings_result_fetches VALUES (?,?)").run(ticker, day);
      this.#db.exec("COMMIT");
    } catch (e) {
      this.#db.exec("ROLLBACK");
      throw e;
    }
  }

  lastFetch(ticker: string): IsoDate | null {
    const r = this.#db.prepare("SELECT MAX(day) AS d FROM earnings_result_fetches WHERE ticker = ?").get(ticker) as { d: string | null } | undefined;
    return r?.d ?? null;
  }

  latestReported(ticker: string): IsoDate | null {
    const r = this.#db.prepare("SELECT MAX(reported_date) AS d FROM earnings_results WHERE ticker = ?").get(ticker) as { d: string | null } | undefined;
    return r?.d ?? null;
  }

  /** The newest `n` results per ticker reported on or before `asOf`. */
  recent(tickers: readonly string[], asOf: IsoDate, n = 4): EarningsResults {
    if (!tickers.length) return {};
    const rows = this.#db
      .prepare(
        `SELECT ticker, fiscal_end, reported_date, report_time, reported_eps, estimated_eps FROM earnings_results
         WHERE ticker IN (${tickers.map(() => "?").join(",")}) AND reported_date <= ? ORDER BY reported_date DESC`,
      )
      .all(...tickers, asOf) as Array<{ ticker: string; fiscal_end: string; reported_date: string; report_time: string | null; reported_eps: number | null; estimated_eps: number | null }>;
    const out: EarningsResults = {};
    for (const r of rows) {
      const list = (out[r.ticker] ??= []);
      if (list.length >= n) continue;
      list.push({
        ticker: r.ticker, fiscalDateEnding: r.fiscal_end, reportedDate: r.reported_date, reportTime: r.report_time,
        reportedEPS: r.reported_eps, estimatedEPS: r.estimated_eps, surprisePct: surprisePct(r.reported_eps, r.estimated_eps),
      });
    }
    return out;
  }
}

/**
 * Whether a ticker's results should be downloaded today: never fetched, or a report date has
 * passed recently that the stored results do not cover yet (at most once a day per ticker).
 */
export function needsResults(o: { lastFetch: IsoDate | null; latestReported: IsoDate | null; recentReportDates: IsoDate[]; today: IsoDate }): boolean {
  if (o.lastFetch === o.today) return false;
  if (!o.lastFetch) return true;
  return o.recentReportDates.some((d) => d <= o.today && (!o.latestReported || o.latestReported < d));
}

/** The result an event published on `eventDate` is most likely about (reported within the 5 days before, or the next day). */
export function resultNear(results: readonly EarningsResult[] | undefined, eventDate: IsoDate): EarningsResult | undefined {
  return results?.find((r) => r.reportedDate >= addDays(eventDate, -5) && r.reportedDate <= addDays(eventDate, 1));
}

const eps = (x: number | null) => (x === null ? "不明" : x.toFixed(2));

/**
 * Rejects an earnings_beat / earnings_miss label that the reported numbers contradict.
 * "In line" results accept either (revenue or guidance may decide), so only clear conflicts fail.
 */
export function contradictsResults(e: { eventType: string; tickers: readonly string[] }, eventDate: IsoDate, results: EarningsResults | undefined): string | null {
  if (!results || (e.eventType !== "earnings_beat" && e.eventType !== "earnings_miss")) return null;
  for (const t of e.tickers) {
    const r = resultNear(results[t], eventDate);
    const v = r ? verdictOf(r) : null;
    if (!r || !v) continue;
    if ((e.eventType === "earnings_beat" && v === "miss") || (e.eventType === "earnings_miss" && v === "beat")) {
      return `contradicts reported earnings: ${t} EPS ${eps(r.reportedEPS)} vs estimate ${eps(r.estimatedEPS)} (${r.surprisePct! >= 0 ? "+" : ""}${r.surprisePct}%, ${v})`;
    }
  }
  return null;
}

/** Lines for the judgment fact sheet (numbers computed here, so the model does not have to). */
export function resultLines(results: readonly EarningsResult[] | undefined): string[] {
  if (!results?.length) return ["## 決算の実績", "(データなし)"];
  const fmt = (r: EarningsResult) => {
    const v = verdictOf(r);
    const sp = r.surprisePct === null ? "" : `（${r.surprisePct >= 0 ? "+" : ""}${r.surprisePct.toFixed(1)}%${v ? `、${VERDICT_JA[v]}` : ""}）`;
    return `${r.reportedDate} 発表（${r.fiscalDateEnding.slice(0, 7)} 期）: EPS 実績 ${eps(r.reportedEPS)} / 予想 ${eps(r.estimatedEPS)}${sp}`;
  };
  const [last, ...rest] = results;
  return [
    "## 決算の実績（データ。数字はプログラムで計算）",
    `直近: ${fmt(last!)}`,
    ...rest.slice(0, 3).map((r) => `その前: ${fmt(r)}`),
  ];
}
