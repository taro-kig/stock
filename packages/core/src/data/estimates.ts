import { addDays, type IsoDate } from "../util/dates.ts";
import type { Db } from "../util/db.ts";
import { AlphaVantageLimit, alphaVantage, isBurstAnswer } from "./earningsResults.ts";

/**
 * Analyst estimate revisions: is the consensus EPS going up or down? Among the best-known
 * signals for a weeks-to-months horizon. Two sources, both computed by the program:
 *
 * 1. Our own record (free, always on): the earnings calendar downloaded every day carries the
 *    consensus EPS for each company's next report. Each day's value is kept, so after a few
 *    weeks we know how the estimate moved — point in time by construction.
 * 2. Alpha Vantage EARNINGS_ESTIMATES (same key, optional): the current estimate plus the values
 *    7 / 30 / 60 / 90 days ago and the number of upward / downward revisions, so the history is
 *    there from day one. The response is read leniently (field names are matched by pattern);
 *    if the key cannot use the endpoint, source 1 is used alone.
 */
export type EstimateHorizon = "quarter" | "year";

export interface EstimateSnapshot {
  horizon: EstimateHorizon;
  /** Fiscal period end the estimate is for. */
  period: IsoDate;
  average: number | null;
  /** Average n days before the snapshot day. */
  ago: Partial<Record<7 | 30 | 60 | 90, number>>;
  /** Upward / downward revisions over the last 30 days (7 when 30 is not given). */
  up: number | null;
  down: number | null;
  analysts: number | null;
}

export interface Revision {
  horizon: EstimateHorizon;
  period: IsoDate;
  current: number;
  /** Change of the consensus over ~30 / ~90 days, as a fraction (null without a usable base). */
  change30: number | null;
  change90: number | null;
  base30: number | null;
  base90: number | null;
  up: number | null;
  down: number | null;
  analysts: number | null;
  source: "api" | "calendar";
  /** Day the numbers were observed. */
  asOf: IsoDate;
}

export type EstimatesMap = Record<string, Revision[]>;

const num = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() && !/^(none|null|-)$/i.test(v.trim()) ? Number(v) : Number.NaN;
  return Number.isFinite(n) ? n : null;
};
const isDate = (v: unknown): v is IsoDate => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);

/** Finds the array of estimate rows wherever the response puts it. */
function rowsOf(body: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(body)) return body.every((x) => x && typeof x === "object") ? (body as Array<Record<string, unknown>>) : [];
  if (!body || typeof body !== "object") return [];
  for (const v of Object.values(body as Record<string, unknown>)) {
    if (Array.isArray(v) && v.some((x) => x && typeof x === "object" && Object.keys(x).some((k) => /eps.*estimate|estimate.*eps/i.test(k)))) return v as Array<Record<string, unknown>>;
  }
  return [];
}

/**
 * Parses EARNINGS_ESTIMATES leniently. Throws AlphaVantageLimit on rate limits / premium-only answers.
 * The live API labels every quarter "fiscal quarter", past ones too (back to 2017), so with `asOf`
 * periods that ended before it are dropped and the next one to report is kept.
 */
export function parseEarningsEstimates(body: unknown, asOf?: string): EstimateSnapshot[] {
  const o = (body ?? {}) as Record<string, unknown>;
  const msg = o["Error Message"] ?? o["Information"] ?? o["Note"];
  if (typeof msg === "string") throw new AlphaVantageLimit(`Alpha Vantage: ${msg.slice(0, 200)}`);
  const out: EstimateSnapshot[] = [];
  for (const r of rowsOf(body)) {
    const h = String(r["horizon"] ?? r["period"] ?? "").toLowerCase();
    // forward-looking rows only ("next fiscal quarter", "current year", ...); historical quarters are not estimates any more
    if (/histor/.test(h)) continue;
    const horizon: EstimateHorizon | null = /quarter|qtr|q\b/.test(h) ? "quarter" : /year|annual|fy/.test(h) ? "year" : null;
    const period = [r["date"], r["fiscalDateEnding"], r["fiscal_date_ending"], r["period_end"]].find(isDate);
    if (!horizon || !period || (asOf && period < asOf)) continue;
    const ago: EstimateSnapshot["ago"] = {};
    let average: number | null = null;
    let up7: number | null = null;
    let down7: number | null = null;
    let up30: number | null = null;
    let down30: number | null = null;
    let analysts: number | null = null;
    for (const [k, v] of Object.entries(r)) {
      const key = k.toLowerCase();
      if (!key.includes("eps")) continue;
      let m: RegExpMatchArray | null;
      if (/^eps_estimate_(average|avg|mean)$/.test(key)) average = num(v);
      else if ((m = key.match(/^eps_estimate_(?:average|avg|mean)_(\d+)_days?_ago$/))) {
        const d = Number(m[1]);
        if (d === 7 || d === 30 || d === 60 || d === 90) {
          const n = num(v);
          if (n !== null) ago[d] = n;
        }
      } else if ((m = key.match(/revision_(up|down)\w*?_(\d+)_days?/))) {
        const n = num(v);
        if (m[2] === "30") m[1] === "up" ? (up30 = n) : (down30 = n);
        if (m[2] === "7") m[1] === "up" ? (up7 = n) : (down7 = n);
      } else if (/analyst/.test(key) && /count|number|num/.test(key)) analysts = num(v);
    }
    if (average === null) continue;
    out.push({ horizon, period, average, ago, up: up30 ?? up7, down: down30 ?? down7, analysts });
  }
  // the nearest period of each horizon
  return (["quarter", "year"] as const).flatMap((hz) => out.filter((x) => x.horizon === hz).sort((a, b) => a.period.localeCompare(b.period)).slice(0, 1));
}

/** `asOf`: the day of the download (periods that ended before it are past quarters, not estimates). */
export async function fetchEarningsEstimates(apiKey: string, ticker: string, asOf: string, fetchImpl: typeof fetch, sleep?: (ms: number) => Promise<void>): Promise<EstimateSnapshot[]> {
  const url = `https://www.alphavantage.co/query?function=EARNINGS_ESTIMATES&symbol=${encodeURIComponent(ticker.replace(/\./g, "-"))}&apikey=${encodeURIComponent(apiKey)}`;
  return alphaVantage(async () => {
    let res: Response;
    try {
      res = await fetchImpl(url, { signal: AbortSignal.timeout(30_000) });
    } catch (e) {
      throw new Error(`cannot reach www.alphavantage.co: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!res.ok) throw new Error(`Alpha Vantage answered HTTP ${res.status}`);
    return parseEarningsEstimates(await res.json(), asOf);
  }, sleep);
}

/** This key cannot use the function. The per-second refusal also mentions the premium plans: that one is not it. */
export const isPremiumAnswer = (e: unknown) => e instanceof AlphaVantageLimit && /premium/i.test(e.message) && !isBurstAnswer(e);

const change = (now: number, base: number | null | undefined) => (base === null || base === undefined || Math.abs(base) < 0.005 ? null : (now - base) / Math.abs(base));

export class EstimateStore {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
    db.exec(`
      CREATE TABLE IF NOT EXISTS estimate_snapshots (
        ticker TEXT, horizon TEXT, period TEXT, day TEXT, average REAL, ago_json TEXT, up INT, down INT, analysts INT,
        PRIMARY KEY (ticker, horizon, period, day));
      CREATE TABLE IF NOT EXISTS estimate_fetches (ticker TEXT PRIMARY KEY, day TEXT);
      CREATE TABLE IF NOT EXISTS calendar_estimates (ticker TEXT, report_date TEXT, day TEXT, estimate REAL, PRIMARY KEY (ticker, report_date, day));`);
  }

  /** One API download (also recorded as fetched when empty, so a ticker without coverage is not asked daily). */
  save(ticker: string, day: IsoDate, snaps: readonly EstimateSnapshot[]): void {
    const up = this.#db.prepare("INSERT OR REPLACE INTO estimate_snapshots VALUES (?,?,?,?,?,?,?,?,?)");
    for (const s of snaps) up.run(ticker, s.horizon, s.period, day, s.average, JSON.stringify(s.ago), s.up, s.down, s.analysts);
    this.#db.prepare("INSERT OR REPLACE INTO estimate_fetches VALUES (?,?)").run(ticker, day);
  }

  lastFetch(ticker: string): IsoDate | null {
    return (this.#db.prepare("SELECT day FROM estimate_fetches WHERE ticker = ?").get(ticker) as { day: string } | undefined)?.day ?? null;
  }

  /** The calendar's consensus for each next report, as seen on `day` (called with every calendar download). */
  saveCalendar(day: IsoDate, rows: ReadonlyArray<{ ticker: string; reportDate: IsoDate; estimate: number | null }>): void {
    const up = this.#db.prepare("INSERT OR REPLACE INTO calendar_estimates VALUES (?,?,?,?)");
    this.#db.exec("BEGIN");
    try {
      for (const r of rows) if (r.estimate !== null) up.run(r.ticker, r.reportDate, day, r.estimate);
      this.#db.exec("COMMIT");
    } catch (e) {
      this.#db.exec("ROLLBACK");
      throw e;
    }
  }

  /** What was known on `asOf`: the API snapshot (if recent), else our own calendar record. */
  at(tickers: readonly string[], asOf: IsoDate, maxAgeDays = 21): EstimatesMap {
    const out: EstimatesMap = {};
    for (const t of tickers) {
      const list: Revision[] = [];
      const api = this.#db
        .prepare("SELECT horizon, period, day, average, ago_json, up, down, analysts FROM estimate_snapshots WHERE ticker = ? AND day <= ? AND day >= ? AND period >= ? ORDER BY day DESC")
        .all(t, asOf, addDays(asOf, -maxAgeDays), asOf) as Array<{ horizon: EstimateHorizon; period: string; day: string; average: number | null; ago_json: string; up: number | null; down: number | null; analysts: number | null }>;
      for (const hz of ["quarter", "year"] as const) {
        const r = api.filter((x) => x.horizon === hz).sort((a, b) => b.day.localeCompare(a.day) || a.period.localeCompare(b.period))[0];
        if (!r || r.average === null) continue;
        let ago: EstimateSnapshot["ago"] = {};
        try {
          ago = JSON.parse(r.ago_json) as EstimateSnapshot["ago"];
        } catch {
          ago = {};
        }
        list.push({
          horizon: hz, period: r.period, current: r.average, base30: ago[30] ?? null, base90: ago[90] ?? null,
          change30: change(r.average, ago[30]), change90: change(r.average, ago[90]), up: r.up, down: r.down, analysts: r.analysts, source: "api", asOf: r.day,
        });
      }
      if (!list.some((x) => x.horizon === "quarter")) {
        const cal = this.#calendarRevision(t, asOf);
        if (cal) list.unshift(cal);
      }
      if (list.length) out[t] = list;
    }
    return out;
  }

  /** Next-quarter revision from the calendar values we stored ourselves. */
  #calendarRevision(ticker: string, asOf: IsoDate): Revision | null {
    const latest = this.#db
      .prepare("SELECT report_date, day, estimate FROM calendar_estimates WHERE ticker = ? AND day <= ? AND day >= ? AND report_date >= ? ORDER BY report_date ASC, day DESC LIMIT 1")
      .get(ticker, asOf, addDays(asOf, -7), asOf) as { report_date: string; day: string; estimate: number } | undefined;
    if (!latest) return null;
    const baseAt = (days: number) =>
      (this.#db
        .prepare("SELECT estimate FROM calendar_estimates WHERE ticker = ? AND report_date = ? AND day <= ? AND day >= ? ORDER BY day DESC LIMIT 1")
        .get(ticker, latest.report_date, addDays(latest.day, -days), addDays(latest.day, -days - 10)) as { estimate: number } | undefined)?.estimate ?? null;
    const b30 = baseAt(30);
    const b90 = baseAt(90);
    return {
      horizon: "quarter", period: latest.report_date, current: latest.estimate, base30: b30, base90: b90,
      change30: change(latest.estimate, b30), change90: change(latest.estimate, b90), up: null, down: null, analysts: null, source: "calendar", asOf: latest.day,
    };
  }
}

/** A single number per ticker for the composite score: the year's 30-day revision, else the quarter's. */
export function revisionScore(rs: readonly Revision[] | undefined): number | null {
  if (!rs?.length) return null;
  const pick = rs.find((r) => r.horizon === "year" && r.change30 !== null) ?? rs.find((r) => r.change30 !== null);
  return pick?.change30 ?? null;
}

const pct = (x: number | null) => (x === null ? "不明" : `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}%`);

export function estimateLines(rs: readonly Revision[] | undefined): string[] {
  if (!rs?.length) return ["## アナリスト予想の修正", "(データなし)"];
  return [
    "## アナリスト予想の修正（データ。変化率はプログラムで計算）",
    ...rs.map((r) => {
      const what = r.source === "calendar" ? `次の決算（${r.period} 発表予定）` : r.horizon === "quarter" ? `次の四半期（${r.period.slice(0, 7)} 期）` : `今期（${r.period.slice(0, 7)} 期末）`;
      const b30 = r.base30 === null ? "30日前 記録なし" : `30日前 ${r.base30.toFixed(2)} → ${pct(r.change30)}`;
      const b90 = r.base90 === null ? "" : `、90日前 ${r.base90.toFixed(2)} → ${pct(r.change90)}`;
      const counts = r.up !== null || r.down !== null ? `。修正 上方 ${r.up ?? 0} 件 / 下方 ${r.down ?? 0} 件` : "";
      const n = r.analysts !== null ? `（アナリスト ${r.analysts} 人）` : "";
      return `${what} EPS 予想 ${r.current.toFixed(2)}（${b30}${b90}）${counts}${n}`;
    }),
  ];
}
