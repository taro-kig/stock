import type { Bar, Prices } from "../signals/technical.ts";
import { addDays, type IsoDate } from "../util/dates.ts";
import type { Db } from "../util/db.ts";

/**
 * The market around a stock: how its sector is doing against the market, and a few
 * market-wide risk gauges (FRED, free key). Everything is computed by the program; the
 * result goes into the fact sheet, the composite score (sector strength) and the order
 * rules (smaller or no new positions when the market is stressed).
 */

/** Our sector names (watchlist `sector`) → a liquid sector ETF. */
export const SECTOR_ETFS: Record<string, string> = {
  tech: "XLK", semis: "SMH", communication: "XLC", consumer: "XLY", staples: "XLP", healthcare: "XLV",
  financials: "XLF", energy: "XLE", industrials: "XLI", materials: "XLB", utilities: "XLU", real_estate: "XLRE",
};

export const SECTOR_JA: Record<string, string> = {
  tech: "テック", semis: "半導体", communication: "通信・メディア", consumer: "一般消費財", staples: "生活必需品", healthcare: "ヘルスケア",
  financials: "金融", energy: "エネルギー", industrials: "資本財", materials: "素材", utilities: "公益", real_estate: "不動産",
};

/** FRED series used as risk gauges. */
export const MACRO_SERIES = {
  VIXCLS: { label: "VIX（恐怖指数）", unit: "" },
  BAMLH0A0HYM2: { label: "ハイイールド債スプレッド", unit: "%" },
  DGS10: { label: "米10年金利", unit: "%" },
  T10Y2Y: { label: "長短金利差（10年−2年）", unit: "%" },
} as const;
export type MacroId = keyof typeof MACRO_SERIES;
export const MACRO_IDS = Object.keys(MACRO_SERIES) as MacroId[];

export interface Observation {
  date: IsoDate;
  value: number;
}

/** FRED observations JSON → numbers ("." means no value that day). */
export function parseFredObservations(body: unknown): Observation[] {
  const o = (body ?? {}) as { observations?: Array<{ date?: unknown; value?: unknown }>; error_message?: unknown };
  if (typeof o.error_message === "string") throw new Error(`FRED: ${o.error_message.slice(0, 200)}`);
  if (!Array.isArray(o.observations)) throw new Error("unexpected FRED response");
  return o.observations
    .map((r) => ({ date: String(r.date ?? ""), value: Number(r.value) }))
    .filter((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.date) && Number.isFinite(r.value));
}

export async function fetchFredSeries(apiKey: string, id: string, since: IsoDate, fetchImpl: typeof fetch): Promise<Observation[]> {
  const q = new URLSearchParams({ series_id: id, api_key: apiKey, file_type: "json", observation_start: since });
  let res: Response;
  try {
    res = await fetchImpl(`https://api.stlouisfed.org/fred/series/observations?${q}`, { signal: AbortSignal.timeout(20_000) });
  } catch (e) {
    throw new Error(`cannot reach api.stlouisfed.org: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (res.status === 400 || res.status === 403) throw new Error(`FRED refused the request (HTTP ${res.status}): check FRED_API_KEY`);
  if (!res.ok) throw new Error(`FRED answered HTTP ${res.status}`);
  return parseFredObservations(await res.json());
}

export class MacroStore {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
    db.exec(`
      CREATE TABLE IF NOT EXISTS macro_obs (series TEXT, date TEXT, value REAL, PRIMARY KEY (series, date));
      CREATE TABLE IF NOT EXISTS macro_fetches (series TEXT PRIMARY KEY, day TEXT);`);
  }

  save(series: string, day: IsoDate, obs: readonly Observation[]): void {
    const up = this.#db.prepare("INSERT OR REPLACE INTO macro_obs VALUES (?,?,?)");
    this.#db.exec("BEGIN");
    try {
      for (const o of obs) up.run(series, o.date, o.value);
      this.#db.prepare("INSERT OR REPLACE INTO macro_fetches VALUES (?,?)").run(series, day);
      this.#db.exec("COMMIT");
    } catch (e) {
      this.#db.exec("ROLLBACK");
      throw e;
    }
  }

  lastFetch(series: string): IsoDate | null {
    return (this.#db.prepare("SELECT day FROM macro_fetches WHERE series = ?").get(series) as { day: string } | undefined)?.day ?? null;
  }

  lastDate(series: string): IsoDate | null {
    return (this.#db.prepare("SELECT MAX(date) AS d FROM macro_obs WHERE series = ?").get(series) as { d: string | null } | undefined)?.d ?? null;
  }

  /** Observations dated before the run date (a day's value is published the next day). */
  series(series: string, asOf: IsoDate, n = 260): Observation[] {
    const rows = this.#db.prepare("SELECT date, value FROM macro_obs WHERE series = ? AND date < ? ORDER BY date DESC LIMIT ?").all(series, asOf, n) as Array<{ date: string; value: number }>;
    return rows.reverse();
  }
}

export interface SectorRead {
  sector: string;
  etf: string;
  ret20: number | null;
  ret60: number | null;
  /** 60-day return minus the benchmark's. */
  rel60: number | null;
  /** 1 = strongest of the sectors with data. */
  rank: number | null;
}

export interface MacroRead {
  id: MacroId;
  label: string;
  unit: string;
  value: number;
  date: IsoDate;
  /** Change over ~20 trading days (same unit). */
  change20: number | null;
}

export type RiskLevel = "normal" | "caution" | "stress";

export interface MarketContext {
  asOf: IsoDate;
  benchmark: { ticker: string; ret20: number | null; ret60: number | null } | null;
  sectors: Record<string, SectorRead>;
  macro: MacroRead[];
  risk: RiskLevel;
  /** Why the risk level is what it is. */
  reasons: string[];
}

export interface RiskThresholds {
  vixCaution: number;
  vixStress: number;
  /** High-yield spread level (%) that counts as stress. */
  hyStress: number;
  /** Rise of the high-yield spread over ~20 trading days (percentage points). */
  hyJumpCaution: number;
  hyJumpStress: number;
}

export const DEFAULT_THRESHOLDS: RiskThresholds = { vixCaution: 22, vixStress: 30, hyStress: 6, hyJumpCaution: 0.5, hyJumpStress: 1 };

function ret(bars: readonly Bar[] | undefined, n: number): number | null {
  if (!bars || bars.length <= n) return null;
  const a = bars[bars.length - 1 - n]!.close;
  const b = bars.at(-1)!.close;
  return a > 0 ? b / a - 1 : null;
}

export function computeMarket(o: {
  asOf: IsoDate;
  benchmark?: string | undefined;
  prices: Prices;
  sectorEtfs: Record<string, string>;
  macro: Partial<Record<MacroId, Observation[]>>;
  thresholds?: RiskThresholds;
}): MarketContext {
  const th = o.thresholds ?? DEFAULT_THRESHOLDS;
  const bBars = o.benchmark ? o.prices[o.benchmark] : undefined;
  const b60 = ret(bBars, 60);
  const sectors: Record<string, SectorRead> = {};
  for (const [sector, etf] of Object.entries(o.sectorEtfs)) {
    const bars = o.prices[etf];
    if (!bars?.length) continue;
    const r60 = ret(bars, 60);
    sectors[sector] = { sector, etf, ret20: ret(bars, 20), ret60: r60, rel60: r60 !== null && b60 !== null ? r60 - b60 : r60, rank: null };
  }
  const ranked = Object.values(sectors).filter((x) => x.rel60 !== null).sort((a, b) => b.rel60! - a.rel60!);
  ranked.forEach((x, i) => (x.rank = i + 1));

  const macro: MacroRead[] = [];
  for (const id of MACRO_IDS) {
    const obs = o.macro[id];
    const last = obs?.at(-1);
    if (!obs || !last) continue;
    const prev = obs.length > 20 ? obs[obs.length - 21]! : null;
    macro.push({ id, ...MACRO_SERIES[id], value: last.value, date: last.date, change20: prev ? last.value - prev.value : null });
  }
  const m = (id: MacroId) => macro.find((x) => x.id === id);
  const reasons: string[] = [];
  let risk: RiskLevel = "normal";
  const raise = (to: RiskLevel, why: string) => {
    reasons.push(why);
    if (to === "stress" || risk === "normal") risk = to;
  };
  const vix = m("VIXCLS");
  const hy = m("BAMLH0A0HYM2");
  if (vix && vix.value >= th.vixStress) raise("stress", `VIX ${vix.value.toFixed(1)} ≥ ${th.vixStress}`);
  else if (vix && vix.value >= th.vixCaution) raise("caution", `VIX ${vix.value.toFixed(1)} ≥ ${th.vixCaution}`);
  if (hy && hy.value >= th.hyStress) raise("stress", `ハイイールド債スプレッド ${hy.value.toFixed(2)}% ≥ ${th.hyStress}%`);
  if (hy?.change20 != null && hy.change20 >= th.hyJumpStress) raise("stress", `ハイイールド債スプレッドが約1か月で +${hy.change20.toFixed(2)}pt`);
  else if (hy?.change20 != null && hy.change20 >= th.hyJumpCaution) raise("caution", `ハイイールド債スプレッドが約1か月で +${hy.change20.toFixed(2)}pt`);
  return {
    asOf: o.asOf,
    benchmark: o.benchmark && bBars ? { ticker: o.benchmark, ret20: ret(bBars, 20), ret60: b60 } : null,
    sectors, macro, risk, reasons,
  };
}

const pct = (x: number | null) => (x === null ? "不明" : `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}%`);
const RISK_JA: Record<RiskLevel, string> = { normal: "平常", caution: "警戒（新規の買いは半分の大きさ）", stress: "緊張（新規の買いは止める）" };

/** Lines for the judgment fact sheet of a stock in `sector`. */
export function marketLines(mc: MarketContext | undefined, sector: string): string[] {
  if (!mc) return [];
  const s = mc.sectors[sector];
  const n = Object.values(mc.sectors).filter((x) => x.rank !== null).length;
  const out = ["## 相場全体と業種（データ。プログラムで計算）"];
  if (mc.benchmark) out.push(`市場（${mc.benchmark.ticker}）: 20日 ${pct(mc.benchmark.ret20)}、60日 ${pct(mc.benchmark.ret60)}`);
  out.push(s
    ? `業種 ${SECTOR_JA[sector] ?? sector}（${s.etf}）: 20日 ${pct(s.ret20)}、60日 ${pct(s.ret60)}（市場との差 ${pct(s.rel60)}、${n} 業種中 ${s.rank ?? "—"} 位）`
    : `業種 ${SECTOR_JA[sector] ?? sector}: 対応する業種 ETF のデータなし`);
  for (const x of mc.macro) {
    const ch = x.change20 === null ? "" : `（約1か月で ${x.change20 >= 0 ? "+" : ""}${x.change20.toFixed(2)}${x.unit ? "pt" : ""}）`;
    out.push(`${x.label}: ${x.value.toFixed(2)}${x.unit}${ch}`);
  }
  out.push(`相場の警戒度: ${RISK_JA[mc.risk]}${mc.reasons.length ? ` — ${mc.reasons.join("、")}` : ""}`);
  return out;
}

/** ETFs to download: the sectors of the watched / held stocks plus every other sector, for the ranking. */
export function sectorEtfs(overrides: Record<string, string> = {}): Record<string, string> {
  return { ...SECTOR_ETFS, ...overrides };
}

/** How far back to ask FRED on the first download. */
export const macroSince = (today: IsoDate) => addDays(today, -400);
