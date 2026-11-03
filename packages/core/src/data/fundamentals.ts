import { addDays, type IsoDate } from "../util/dates.ts";
import type { Db } from "../util/db.ts";

/**
 * Company financials from SEC XBRL "company facts" (free; same User-Agent as the other SEC
 * data). Every number here is computed by the program from what the company filed: revenue
 * and EPS growth, margins, and (with a price) P/E and P/S. Models only read the result.
 *
 * Point in time: each fact keeps its filing date; a run on day D only uses facts filed on or
 * before D, taking the latest version of each period (restatements count from when they were filed).
 */
export const FUNDAMENTAL_METRICS = ["revenue", "grossProfit", "operatingIncome", "netIncome", "eps", "shares"] as const;
export type FundamentalMetric = (typeof FUNDAMENTAL_METRICS)[number];

/**
 * XBRL concepts per metric, preferred first. Companies switch concepts over time: the one with the
 * newest period is used, and older concepts fill in the periods it does not cover.
 */
const CONCEPTS: Record<FundamentalMetric, Array<{ taxonomy: string; concept: string; unit: string }>> = {
  revenue: [
    "RevenueFromContractWithCustomerExcludingAssessedTax", "Revenues", "SalesRevenueNet", "RevenueFromContractWithCustomerIncludingAssessedTax", "RevenuesNetOfInterestExpense",
  ].map((concept) => ({ taxonomy: "us-gaap", concept, unit: "USD" })),
  grossProfit: [{ taxonomy: "us-gaap", concept: "GrossProfit", unit: "USD" }],
  operatingIncome: [{ taxonomy: "us-gaap", concept: "OperatingIncomeLoss", unit: "USD" }],
  netIncome: [{ taxonomy: "us-gaap", concept: "NetIncomeLoss", unit: "USD" }],
  eps: [{ taxonomy: "us-gaap", concept: "EarningsPerShareDiluted", unit: "USD/shares" }, { taxonomy: "us-gaap", concept: "EarningsPerShareBasic", unit: "USD/shares" }],
  shares: [{ taxonomy: "dei", concept: "EntityCommonStockSharesOutstanding", unit: "shares" }],
};

export interface Fact {
  metric: FundamentalMetric;
  /** null for point-in-time values (shares outstanding). */
  start: IsoDate | null;
  end: IsoDate;
  val: number;
  filed: IsoDate;
  form: string;
}

const isDate = (v: unknown): v is IsoDate => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);

/** Picks the facts we use out of a companyfacts JSON (a few hundred rows out of many thousands). */
export function parseCompanyFacts(body: unknown): Fact[] {
  const facts = ((body ?? {}) as { facts?: Record<string, Record<string, { units?: Record<string, unknown[]> }>> }).facts ?? {};
  const out: Fact[] = [];
  for (const metric of FUNDAMENTAL_METRICS) {
    const byConcept: Array<{ facts: Fact[]; end: string }> = [];
    for (const c of CONCEPTS[metric]) {
      const rows = facts[c.taxonomy]?.[c.concept]?.units?.[c.unit];
      if (!Array.isArray(rows)) continue;
      const parsed: Fact[] = [];
      for (const r of rows as Array<Record<string, unknown>>) {
        const val = typeof r["val"] === "number" ? r["val"] : Number(r["val"]);
        const form = String(r["form"] ?? "");
        if (!isDate(r["end"]) || !isDate(r["filed"]) || !Number.isFinite(val)) continue;
        if (!/^(10-K|10-Q|20-F|40-F)/.test(form)) continue; // annual / quarterly reports only (8-K exhibits are not tagged reliably)
        parsed.push({ metric, start: isDate(r["start"]) ? r["start"] : null, end: r["end"], val, filed: r["filed"], form });
      }
      if (parsed.length) byConcept.push({ facts: parsed, end: parsed.reduce((m, f) => (f.end > m ? f.end : m), "") });
    }
    // newest concept first (stable: list order breaks ties); a period comes from the first concept that has it
    byConcept.sort((a, b) => b.end.localeCompare(a.end));
    const covered = new Set<string>();
    for (const { facts: fs } of byConcept) {
      const mine = new Set<string>();
      for (const f of fs) {
        const k = `${f.start ?? ""}|${f.end}`;
        if (covered.has(k)) continue;
        out.push(f);
        mine.add(k);
      }
      for (const k of mine) covered.add(k);
    }
  }
  return out;
}

const days = (a: IsoDate, b: IsoDate) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

interface Quarter {
  start: IsoDate;
  end: IsoDate;
  val: number;
  /** Q4 computed as the year minus three quarters. */
  derived: boolean;
}

/** Quarterly values known on `asOf`: reported quarters, plus Q4 = fiscal year − Q1..Q3 for flow metrics. */
export function quarters(facts: readonly Fact[], metric: FundamentalMetric, asOf: IsoDate): Quarter[] {
  // latest filed version of each period
  const latest = new Map<string, Fact>();
  for (const f of facts) {
    if (f.metric !== metric || f.filed > asOf || !f.start) continue;
    const k = `${f.start}|${f.end}`;
    const prev = latest.get(k);
    if (!prev || f.filed > prev.filed) latest.set(k, f);
  }
  const all = [...latest.values()];
  const q = new Map<IsoDate, Quarter>();
  for (const f of all) {
    const d = days(f.start!, f.end);
    if (d >= 80 && d <= 100) q.set(f.end, { start: f.start!, end: f.end, val: f.val, derived: false });
  }
  for (const y of all) {
    const d = days(y.start!, y.end);
    if (d < 350 || d > 380 || q.has(y.end)) continue;
    const inYear = [...q.values()].filter((x) => !x.derived && x.start >= addDays(y.start!, -5) && x.end < y.end);
    if (inYear.length !== 3) continue;
    const lastEnd = inYear.map((x) => x.end).sort().at(-1)!;
    q.set(y.end, { start: addDays(lastEnd, 1), end: y.end, val: y.val - inYear.reduce((s, x) => s + x.val, 0), derived: true });
  }
  return [...q.values()].sort((a, b) => a.end.localeCompare(b.end));
}

/** Sum of the 4 quarters ending at index i, if they are consecutive (about a year). */
function ttm(qs: readonly Quarter[], i: number): number | null {
  if (i < 3) return null;
  const four = qs.slice(i - 3, i + 1);
  const span = days(four[0]!.start, four[3]!.end);
  return span >= 350 && span <= 380 ? four.reduce((s, x) => s + x.val, 0) : null;
}

/** The same quarter one year earlier (end within ±20 days of a year before). */
function yearAgo(qs: readonly Quarter[], i: number): number {
  const target = addDays(qs[i]!.end, -365);
  return qs.findIndex((x) => Math.abs(days(x.end, target)) <= 20);
}

export interface Fundamentals {
  ticker: string;
  /** End of the latest quarter, and when its report was filed. */
  periodEnd: IsoDate;
  filed: IsoDate;
  revenueTtm: number | null;
  /** Year over year: trailing twelve months vs the twelve months before. */
  revenueTtmYoY: number | null;
  /** Latest quarter vs the same quarter a year earlier. */
  revenueQYoY: number | null;
  epsTtm: number | null;
  epsTtmYoY: number | null;
  epsQYoY: number | null;
  grossMargin: number | null;
  grossMarginPrev: number | null;
  operatingMargin: number | null;
  operatingMarginPrev: number | null;
  netIncomeTtm: number | null;
  shares: number | null;
  /**
   * Standardized unexpected earnings (Foster–Olsen–Shevlin / Bernard–Thomas, seasonal random walk):
   * (EPS of the latest quarter − EPS a year earlier) / standard deviation of that change over the
   * previous quarters (at least 4). No analyst consensus needed, so it works for every SEC filer.
   */
  sue: number | null;
  /** When the quarter behind `sue` was filed (the drift after a surprise fades over ~60 trading days). */
  sueFiled: IsoDate | null;
}

/** SUE of the latest EPS quarter (null with fewer than 5 year-over-year changes). */
export function sueOf(eps: ReadonlyArray<{ end: IsoDate; val: number }>): number | null {
  const diffs: number[] = [];
  for (let i = 0; i < eps.length; i++) {
    const target = addDays(eps[i]!.end, -365);
    const j = eps.findIndex((x) => Math.abs(days(x.end, target)) <= 20);
    if (j >= 0) diffs.push(eps[i]!.val - eps[j]!.val);
  }
  if (diffs.length < 5) return null;
  const last = diffs.at(-1)!;
  const prior = diffs.slice(-9, -1);
  const mean = prior.reduce((a, b) => a + b, 0) / prior.length;
  const sd = Math.sqrt(prior.reduce((a, b) => a + (b - mean) ** 2, 0) / (prior.length - 1));
  return sd > 1e-9 ? last / sd : null;
}

const growth = (now: number | null, before: number | null) => (now === null || before === null || before <= 0 ? null : now / before - 1);

/** Everything known about one company on `asOf` (null when no quarterly data has been filed yet). */
export function fundamentalsAt(ticker: string, facts: readonly Fact[], asOf: IsoDate): Fundamentals | null {
  const rev = quarters(facts, "revenue", asOf);
  const eps = quarters(facts, "eps", asOf);
  const ni = quarters(facts, "netIncome", asOf);
  const base = rev.length ? rev : ni.length ? ni : eps;
  const last = base.at(-1);
  if (!last) return null;
  const at = (qs: Quarter[], end: IsoDate) => qs.findIndex((x) => x.end === end);
  const ttmAt = (qs: Quarter[], end: IsoDate, back = 0) => {
    const i = at(qs, end);
    return i < 0 ? null : ttm(qs, i - back);
  };
  const qYoY = (qs: Quarter[]) => {
    const i = at(qs, last.end);
    if (i < 0) return null;
    const j = yearAgo(qs, i);
    return j < 0 ? null : growth(qs[i]!.val, qs[j]!.val);
  };
  const margin = (metric: FundamentalMetric, back: number) => {
    const m = ttmAt(quarters(facts, metric, asOf), last.end, back);
    const r = ttmAt(rev, last.end, back);
    return m === null || r === null || r <= 0 ? null : m / r;
  };
  const shares = facts
    .filter((f) => f.metric === "shares" && f.filed <= asOf)
    .sort((a, b) => a.end.localeCompare(b.end) || a.filed.localeCompare(b.filed))
    .at(-1)?.val ?? null;
  const filed = facts.filter((f) => f.filed <= asOf && f.end === last.end && f.start).map((f) => f.filed).sort()[0] ?? last.end;
  const revTtm = ttmAt(rev, last.end);
  const epsTtm = ttmAt(eps, last.end);
  return {
    ticker, periodEnd: last.end, filed,
    revenueTtm: revTtm, revenueTtmYoY: growth(revTtm, ttmAt(rev, last.end, 4)), revenueQYoY: qYoY(rev),
    epsTtm, epsTtmYoY: growth(epsTtm, ttmAt(eps, last.end, 4)), epsQYoY: qYoY(eps),
    grossMargin: margin("grossProfit", 0), grossMarginPrev: margin("grossProfit", 4),
    operatingMargin: margin("operatingIncome", 0), operatingMarginPrev: margin("operatingIncome", 4),
    netIncomeTtm: ttmAt(ni, last.end), shares,
    sue: sueOf(eps),
    sueFiled: eps.length ? (facts.filter((f) => f.metric === "eps" && f.filed <= asOf && f.end === eps.at(-1)!.end && f.start).map((f) => f.filed).sort()[0] ?? null) : null,
  };
}

export type FundamentalsMap = Record<string, Fundamentals>;

export class FundamentalsStore {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
    db.exec(`
      CREATE TABLE IF NOT EXISTS fundamental_facts (
        ticker TEXT, metric TEXT, start TEXT, end TEXT, val REAL, filed TEXT, form TEXT,
        PRIMARY KEY (ticker, metric, start, end, filed));
      CREATE TABLE IF NOT EXISTS fundamental_fetches (ticker TEXT PRIMARY KEY, day TEXT);`);
  }

  save(ticker: string, day: IsoDate, facts: readonly Fact[]): void {
    const up = this.#db.prepare("INSERT OR REPLACE INTO fundamental_facts VALUES (?,?,?,?,?,?,?)");
    this.#db.exec("BEGIN");
    try {
      // keep old rows: a later download never erases what was known on an earlier day
      for (const f of facts) up.run(ticker, f.metric, f.start ?? "", f.end, f.val, f.filed, f.form);
      this.#db.prepare("INSERT OR REPLACE INTO fundamental_fetches VALUES (?,?)").run(ticker, day);
      this.#db.exec("COMMIT");
    } catch (e) {
      this.#db.exec("ROLLBACK");
      throw e;
    }
  }

  lastFetch(ticker: string): IsoDate | null {
    return (this.#db.prepare("SELECT day FROM fundamental_fetches WHERE ticker = ?").get(ticker) as { day: string } | undefined)?.day ?? null;
  }

  latestFiled(ticker: string): IsoDate | null {
    return (this.#db.prepare("SELECT MAX(filed) AS d FROM fundamental_facts WHERE ticker = ?").get(ticker) as { d: string | null } | undefined)?.d ?? null;
  }

  facts(ticker: string, asOf: IsoDate): Fact[] {
    const rows = this.#db.prepare("SELECT metric, start, end, val, filed, form FROM fundamental_facts WHERE ticker = ? AND filed <= ?").all(ticker, asOf) as Array<{ metric: FundamentalMetric; start: string; end: string; val: number; filed: string; form: string }>;
    return rows.map((r) => ({ metric: r.metric, start: r.start || null, end: r.end, val: r.val, filed: r.filed, form: r.form }));
  }

  at(tickers: readonly string[], asOf: IsoDate): FundamentalsMap {
    const out: FundamentalsMap = {};
    for (const t of tickers) {
      const f = fundamentalsAt(t, this.facts(t, asOf), asOf);
      if (f) out[t] = f;
    }
    return out;
  }
}

/**
 * Download again when: never fetched; weekly; or a report date passed recently and nothing filed
 * since (the 10-Q usually follows the earnings release within days to a few weeks) — at most daily.
 */
export function needsFundamentals(o: { lastFetch: IsoDate | null; latestFiled: IsoDate | null; recentReportDates: IsoDate[]; today: IsoDate; refreshDays: number }): boolean {
  if (!o.lastFetch) return true;
  if (o.lastFetch === o.today) return false;
  if (o.lastFetch <= addDays(o.today, -o.refreshDays)) return true;
  return o.recentReportDates.some((d) => d <= o.today && (!o.latestFiled || o.latestFiled < d));
}

const pct = (x: number | null) => (x === null ? "不明" : `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}%`);
const usd = (x: number | null) => {
  if (x === null) return "不明";
  const a = Math.abs(x);
  return a >= 1e9 ? `${(x / 1e9).toFixed(1)}B ドル` : a >= 1e6 ? `${(x / 1e6).toFixed(1)}M ドル` : `${x.toFixed(0)} ドル`;
};

/** P/E and P/S at a price (null when not meaningful, e.g. a loss). */
export function valuation(f: Fundamentals, price: number): { pe: number | null; ps: number | null; marketCap: number | null } {
  const marketCap = f.shares !== null ? price * f.shares : null;
  return {
    pe: f.epsTtm !== null && f.epsTtm > 0 ? price / f.epsTtm : null,
    ps: marketCap !== null && f.revenueTtm !== null && f.revenueTtm > 0 ? marketCap / f.revenueTtm : null,
    marketCap,
  };
}

/** Lines for the judgment fact sheet. */
export function fundamentalLines(f: Fundamentals | undefined, price: number, asOf: IsoDate): string[] {
  if (!f) return ["## 業績（SEC 提出データ）", "(データなし)"];
  const v = valuation(f, price);
  const old = days(f.periodEnd, asOf) > 200 ? "（古い: 最新の四半期報告がまだ取り込まれていない可能性）" : "";
  const mg = (now: number | null, prev: number | null) => (now === null ? "不明" : `${(now * 100).toFixed(1)}%${prev === null ? "" : `（1年前 ${(prev * 100).toFixed(1)}%）`}`);
  return [
    "## 業績（SEC 提出データ。数字はプログラムで計算）",
    `直近の四半期: ${f.periodEnd.slice(0, 7)} 期（${f.filed} 提出）${old}`,
    `売上高: 直近4四半期 ${usd(f.revenueTtm)}（前年比 ${pct(f.revenueTtmYoY)}）、直近四半期の前年同期比 ${pct(f.revenueQYoY)}`,
    `EPS（希薄化後）: 直近4四半期 ${f.epsTtm === null ? "不明" : f.epsTtm.toFixed(2)}（前年比 ${pct(f.epsTtmYoY)}）、直近四半期の前年同期比 ${pct(f.epsQYoY)}`,
    `営業利益率: ${mg(f.operatingMargin, f.operatingMarginPrev)}、粗利率: ${mg(f.grossMargin, f.grossMarginPrev)}`,
    `PER ${v.pe === null ? "算出不可（赤字かデータ不足）" : `${v.pe.toFixed(1)} 倍`}、PSR ${v.ps === null ? "不明" : `${v.ps.toFixed(1)} 倍`}（時価総額 ${usd(v.marketCap)}）`,
  ];
}
