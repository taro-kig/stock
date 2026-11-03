import { z } from "zod";
import { jquantsClient } from "../nodes/data.ts";
import type { Services } from "../services.ts";
import type { Bar, Prices } from "../signals/technical.ts";
import { computeFactors } from "../strategy/factors.ts";
import { factorColumns } from "../strategy/factorLib.ts";
import { compositeScore } from "../strategy/scoring.ts";
import { addDays, isWeekday, toIsoDate, type IsoDate } from "../util/dates.ts";
import type { ScreenCandidate, ScreenResult } from "./screen.ts";

/**
 * Japanese stocks for the watchlist, from the exchange's own data (J-Quants, JQUANTS_API_KEY):
 * the listed-company master (/v2/equities/master: code, name, 17 / 33 sectors, market segment,
 * TOPIX size category) verifies codes suggested by a model, and a screen ranks the whole market
 * on prices. J-Quants v2 field names (CoName, S17Nm, S33Nm, Mkt, ScaleCat) are read leniently,
 * with the v1 names as fallback. Financial statements are not used here (not verified yet).
 */
export const JP_SEGMENTS = ["prime", "standard", "growth"] as const;
export type JpSegment = (typeof JP_SEGMENTS)[number];
export const JP_SEGMENT_JA: Record<JpSegment, string> = { prime: "プライム", standard: "スタンダード", growth: "グロース" };
/** TSE market codes. */
const MKT: Record<string, JpSegment> = { "0111": "prime", "0112": "standard", "0113": "growth" };

/** TOPIX-17 sector series (S17Nm), for filters. */
export const JP_SECTORS17 = [
  "食品", "エネルギー資源", "建設・資材", "素材・化学", "医薬品", "自動車・輸送機", "鉄鋼・非鉄", "機械", "電機・精密",
  "情報通信・サービスその他", "電気・ガス", "運輸・物流", "商社・卸売", "小売", "銀行", "金融（除く銀行）", "不動産",
] as const;

export type JpSize = "large" | "mid" | "small";
export const JP_SIZE_JA: Record<JpSize, string> = { large: "大型（Core30・Large70）", mid: "中型（Mid400）", small: "小型（Small・その他）" };

export interface JpListing {
  ticker: string;
  name: string;
  nameEn: string;
  sector17: string;
  sector33: string;
  segment: JpSegment | null;
  segmentName: string;
  scale: string;
}

const str = (v: unknown) => (v === null || v === undefined ? "" : String(v).trim());
const nfkc = (s: string) => s.normalize("NFKC");

/** J-Quants codes have 5 characters (72030, 130A0); ours are the 4-character exchange codes. */
export const jpTicker = (code: string): string => (code.length === 5 && code.endsWith("0") ? code.slice(0, 4) : code);

export function sizeOfScale(scale: string): JpSize {
  if (/core30|large70/i.test(scale)) return "large";
  if (/mid400/i.test(scale)) return "mid";
  return "small";
}

/** One page of /v2/equities/master (lenient about field names). */
export function parseJpMaster(body: unknown): { rows: JpListing[]; next: string | undefined } {
  const o = (body ?? {}) as Record<string, unknown>;
  const list = (o["data"] ?? o["info"] ?? o["master"] ?? []) as Array<Record<string, unknown>>;
  if (!Array.isArray(list)) throw new Error("unexpected J-Quants master response");
  const rows: JpListing[] = [];
  for (const r of list) {
    const code = str(r["Code"]);
    if (!code) continue;
    const mkt = str(r["Mkt"] ?? r["MarketCode"]);
    const mktName = nfkc(str(r["MktNm"] ?? r["MarketCodeName"]));
    const segment = MKT[mkt] ?? (/プライム/.test(mktName) ? "prime" : /スタンダード/.test(mktName) ? "standard" : /グロース/.test(mktName) ? "growth" : null);
    rows.push({
      ticker: jpTicker(code),
      name: str(r["CoName"] ?? r["CompanyName"]),
      nameEn: str(r["CoNameEn"] ?? r["CompanyNameEnglish"]),
      sector17: nfkc(str(r["S17Nm"] ?? r["Sector17CodeName"])),
      sector33: nfkc(str(r["S33Nm"] ?? r["Sector33CodeName"])),
      segment,
      segmentName: segment ? JP_SEGMENT_JA[segment] : mktName || mkt,
      scale: str(r["ScaleCat"] ?? r["ScaleCategory"]),
    });
  }
  const next = o["pagination_key"];
  return { rows, next: typeof next === "string" && next ? next : undefined };
}

/** Spaced GET against J-Quants v2 (the free plan allows 5 requests a minute). */
function jqGetter(s: Services, apiKey: string, perMinute: number) {
  const spacing = Math.ceil((60_000 / perMinute) * 1.1);
  let last = 0;
  return async (path: string, params: Record<string, string>): Promise<unknown> => {
    for (let limited = 0; ; limited++) {
      const wait = last + spacing - Date.now();
      if (last && wait > 0) await s.sleep(wait);
      last = Date.now();
      const url = new URL(`https://api.jquants.com${path}`);
      for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
      const res = await s.fetch(url, { headers: { "x-api-key": apiKey }, signal: AbortSignal.timeout(30_000) });
      if (res.status === 429 && limited < 2) {
        await s.sleep(120_000);
        continue;
      }
      if (res.status === 401 || res.status === 403) throw new Error(`J-Quants がキーを受け付けない（HTTP ${res.status}）`);
      if (!res.ok) throw Object.assign(new Error(`J-Quants ${path}: HTTP ${res.status}`), { status: res.status });
      return res.json();
    }
  };
}

/** The listed companies (cached a week). Needs JQUANTS_API_KEY. */
export async function jpListings(s: Services, now: Date = new Date()): Promise<Map<string, JpListing>> {
  s.db.exec(`CREATE TABLE IF NOT EXISTS jp_listings (ticker TEXT PRIMARY KEY, json TEXT);
             CREATE TABLE IF NOT EXISTS jp_listings_meta (id INT PRIMARY KEY, fetched_at TEXT);`);
  const meta = s.db.prepare("SELECT fetched_at FROM jp_listings_meta WHERE id = 1").get() as { fetched_at: string } | undefined;
  if (!meta || now.getTime() - Date.parse(meta.fetched_at) > 7 * 86_400_000) {
    const key = s.env["JQUANTS_API_KEY"];
    if (!key) throw new Error("JQUANTS_API_KEY が未設定です（⚙ 設定）。日本株の確認と検索には J-Quants の上場銘柄一覧を使います");
    const get = jqGetter(s, key, 5);
    const fetchAll = async (params: Record<string, string>) => {
      const rows: JpListing[] = [];
      let next: string | undefined;
      do {
        const page = parseJpMaster(await get("/v2/equities/master", { ...params, ...(next ? { pagination_key: next } : {}) }));
        rows.push(...page.rows);
        next = page.next;
      } while (next);
      return rows;
    };
    let rows: JpListing[];
    try {
      rows = await fetchAll({});
    } catch (e) {
      // the free plan only serves dates at least 12 weeks old
      if ((e as { status?: number }).status !== 400) throw e;
      rows = await fetchAll({ date: addDays(toIsoDate(now), -84) });
    }
    if (!rows.length) throw new Error("J-Quants の上場銘柄一覧が空でした");
    const ins = s.db.prepare("INSERT OR REPLACE INTO jp_listings VALUES (?,?)");
    s.db.exec("BEGIN");
    try {
      s.db.exec("DELETE FROM jp_listings");
      for (const r of rows) ins.run(r.ticker, JSON.stringify(r));
      s.db.prepare("INSERT OR REPLACE INTO jp_listings_meta VALUES (1, ?)").run(now.toISOString());
      s.db.exec("COMMIT");
    } catch (e) {
      s.db.exec("ROLLBACK");
      throw e;
    }
  }
  const rows = s.db.prepare("SELECT json FROM jp_listings").all() as Array<{ json: string }>;
  return new Map(rows.map((r) => {
    const l = JSON.parse(r.json) as JpListing;
    return [l.ticker, l];
  }));
}

const CORP_JA = /株式会社|\(株\)|㈱|ホールディングス|ホールディング|グループ|フィナンシャル|コーポレーション|HD$/g;
const squash = (s: string) => nfkc(s).toLowerCase().replace(CORP_JA, "").replace(/[\s・.,'’()（）&-]/g, "");
const EN_CORP = /\b(co|ltd|inc|corp|corporation|company|holdings?|group|kabushiki|kaisha|the)\b/g;
const squashEn = (s: string) => nfkc(s).toLowerCase().replace(/[.,]/g, " ").replace(EN_CORP, "").replace(/[^a-z0-9]/g, "");

/** Does a suggested name (Japanese or English, often shortened) belong to the listed company? */
export function jpNamesMatch(suggested: string, l: Pick<JpListing, "name" | "nameEn">): boolean {
  const a = squash(suggested);
  const b = squash(l.name);
  if (a && b && (a.includes(b) || b.includes(a))) return true;
  const ae = squashEn(suggested);
  const be = squashEn(l.nameEn);
  return Boolean(ae && be && ae.length >= 3 && (be.startsWith(ae) || ae.startsWith(be)));
}

export type JpCheck =
  | { ticker: string; status: "ok"; problem: null; listing: JpListing }
  | { ticker: string; status: "rejected" | "unverified"; problem: string; listing: JpListing | null };

export function verifyJp(ticker: string, name: string, listings: Map<string, JpListing> | null, exclude: Set<string>): JpCheck {
  const t = nfkc(ticker).trim().toUpperCase();
  if (!/^\d{3}[0-9A-Z]$/.test(t)) return { ticker: t, status: "rejected", problem: "証券コードの形式が不正（4 文字）", listing: null };
  if (exclude.has(t)) return { ticker: t, status: "rejected", problem: "すでにウォッチリストにある", listing: null };
  if (!listings) return { ticker: t, status: "unverified", problem: "J-Quants の上場銘柄一覧で確認できていない", listing: null };
  const l = listings.get(t);
  if (!l) return { ticker: t, status: "rejected", problem: "東証の上場銘柄一覧に無い（誤り・上場廃止の可能性）", listing: null };
  if (!l.segment) return { ticker: t, status: "rejected", problem: `プライム・スタンダード・グロース以外（${l.segmentName || "区分不明"}）`, listing: l };
  if (!jpNamesMatch(name, l)) return { ticker: t, status: "rejected", problem: `コード ${t} は「${l.name}」で、提案の「${name}」と一致しない`, listing: l };
  return { ticker: t, status: "ok", problem: null, listing: l };
}

// ── data screen ────────────────────────────────────────────────

export const JpScreenRequest = z.strictObject({
  segments: z.array(z.enum(JP_SEGMENTS)).min(1).default(["prime", "standard"]),
  sizes: z.array(z.enum(["large", "mid", "small"])).min(1).default(["mid", "small"]),
  /** TOPIX-17 sector names; empty = all. */
  sectors: z.array(z.string().max(40)).default([]),
  count: z.number().int().min(1).max(25).default(10),
  /** Yen. */
  minPrice: z.number().min(0).default(300),
  /** Mean daily traded value, yen. */
  minTradedValue: z.number().min(0).default(100_000_000),
  /** Stocks whose full history is downloaded (J-Quants free plan: 5 requests a minute). */
  maxPriceLookups: z.number().int().min(1).max(40).default(10),
  requestsPerMinute: z.number().positive().default(5),
});
export type JpScreenRequest = z.input<typeof JpScreenRequest>;

interface Snap {
  date: IsoDate;
  rows: Map<string, { close: number; volume: number }>;
}

/** Every stock's bar on one date (one request, paginated), or null when the date has no data. */
async function snapshot(get: ReturnType<typeof jqGetter>, date: IsoDate): Promise<Snap | null> {
  const rows = new Map<string, { close: number; volume: number }>();
  let next: string | undefined;
  do {
    const body = (await get("/v2/equities/bars/daily", { date, ...(next ? { pagination_key: next } : {}) })) as { data?: Array<Record<string, unknown>>; pagination_key?: string };
    for (const r of body.data ?? []) {
      const c = Number(r["AdjC"]);
      if (r["Code"] && Number.isFinite(c) && c > 0) rows.set(jpTicker(String(r["Code"])), { close: c, volume: Number(r["AdjVo"] ?? 0) || 0 });
    }
    next = body.pagination_key || undefined;
  } while (next);
  return rows.size ? { date, rows } : null;
}

/** The latest weekday at or before `from` with data, looking back up to `days`. */
async function snapshotNear(get: ReturnType<typeof jqGetter>, from: IsoDate, days: number): Promise<Snap | null> {
  for (let i = 0, d = from; i <= days; i++, d = addDays(d, -1)) {
    if (!isWeekday(d)) continue;
    try {
      const s = await snapshot(get, d);
      if (s) return s;
    } catch (e) {
      if ((e as { status?: number }).status !== 400) throw e; // 400: outside the plan's dates
    }
  }
  return null;
}

const yen = (x: number) => (x >= 1e8 ? `¥${(x / 1e8).toFixed(1)}億` : `¥${Math.round(x / 1e4).toLocaleString()}万`);
const pct = (x: number | null) => (x === null ? "不明" : `${x >= 0 ? "+" : ""}${(x * 100).toFixed(0)}%`);

/**
 * Japanese stocks from data: the listing (segment, size, sector) narrows the market, one day of
 * prices for every stock (three dates) gives a 12-1 momentum and traded value for all of them to
 * pre-rank, then the short list gets full price histories and is ranked on price factors
 * (momentum, distance from the 52-week high, low volatility) after liquidity and price checks.
 */
export async function screenJpStocks(s: Services, req: JpScreenRequest, o: { now?: Date; exclude?: readonly string[] } = {}): Promise<ScreenResult> {
  const r = JpScreenRequest.parse(req);
  const now = o.now ?? new Date();
  const day = toIsoDate(now);
  const key = s.env["JQUANTS_API_KEY"];
  if (!key) throw new Error("JQUANTS_API_KEY が未設定です（⚙ 設定）。日本株のデータでの検索には J-Quants を使います");
  const notes: string[] = [];
  const funnel: ScreenResult["funnel"] = [];
  const bench = s.market("jp").benchmark;
  const exclude = new Set([...(o.exclude ?? []), ...s.watchlist.tickers, ...(bench ? [bench] : [])]);

  const listings = [...(await jpListings(s, now)).values()].filter((l) => !exclude.has(l.ticker));
  funnel.push({ step: "東証の上場銘柄", count: listings.length });
  const wantSectors = r.sectors.map(nfkc);
  const filtered = listings.filter((l) => l.segment && r.segments.includes(l.segment) && r.sizes.includes(sizeOfScale(l.scale)) && (!wantSectors.length || wantSectors.includes(l.sector17)));
  funnel.push({ step: `${r.segments.map((x) => JP_SEGMENT_JA[x]).join("・")} · ${r.sizes.map((x) => JP_SIZE_JA[x as JpSize].split("（")[0]).join("・")}${r.sectors.length ? ` · ${r.sectors.join("・")}` : ""}`, count: filtered.length });
  if (!filtered.length) return { asOf: day, request: r, candidates: [], funnel, weights: {}, weightsFrom: "default", notes };

  // pre-rank everyone on one bar per stock at three dates
  const get = jqGetter(s, key, r.requestsPerMinute);
  let pre: Map<string, { mom: number | null; value: number; close: number }> | null = null;
  try {
    let t0 = await snapshotNear(get, addDays(day, -1), 6);
    if (!t0) t0 = await snapshotNear(get, addDays(day, -85), 7); // free plan: 12 weeks behind
    if (t0) {
      if (t0.date < addDays(day, -20)) notes.push(`株価は ${t0.date} 時点（J-Quants の無料プランは直近 12 週間が出ない）`);
      const t21 = await snapshotNear(get, addDays(t0.date, -30), 7);
      const t252 = await snapshotNear(get, addDays(t0.date, -365), 7);
      pre = new Map();
      for (const l of filtered) {
        const a = t0.rows.get(l.ticker);
        if (!a) continue;
        const b = t21?.rows.get(l.ticker);
        const c = t252?.rows.get(l.ticker);
        pre.set(l.ticker, { mom: b && c ? b.close / c.close - 1 : null, value: a.close * a.volume, close: a.close });
      }
    }
  } catch (e) {
    notes.push(`全銘柄の株価をまとめて取れなかった（${e instanceof Error ? e.message : String(e)}）。規模の大きい順に確認した`);
  }
  let ordered: typeof filtered;
  if (pre) {
    const liquid = filtered.filter((l) => {
      const p = pre!.get(l.ticker);
      return p && p.close >= r.minPrice && p.value >= r.minTradedValue / 2; // one day is noisy: half the bar here, the full one on 20 days below
    });
    funnel.push({ step: `株価 ¥${r.minPrice} 以上・売買代金がおおむね ${yen(r.minTradedValue)}/日 以上（1日分）`, count: liquid.length });
    ordered = liquid.sort((a, b) => (pre!.get(b.ticker)!.mom ?? -9) - (pre!.get(a.ticker)!.mom ?? -9));
  } else {
    const rank = { large: 0, mid: 1, small: 2 } as const;
    ordered = [...filtered].sort((a, b) => rank[sizeOfScale(a.scale)] - rank[sizeOfScale(b.scale)] || a.ticker.localeCompare(b.ticker));
  }
  const short = ordered.slice(0, r.maxPriceLookups);
  funnel.push({ step: "12-1 モメンタムの上位（詳しく確認）", count: short.length });

  const client = jquantsClient({ apiKey: key, requestsPerMinute: r.requestsPerMinute, fetchImpl: s.fetch, sleep: s.sleep });
  const prices: Prices = {};
  for (const l of short) {
    try {
      const bars: Bar[] = (await client.bars(l.ticker)).filter((b) => b.date <= day);
      if (bars.length) prices[l.ticker] = bars;
    } catch (e) {
      notes.push(`${l.ticker}: 株価を取得できない（${e instanceof Error ? e.message : String(e)}）`);
    }
  }
  const table = computeFactors(prices, day, (t) => ({ name: t, sector: short.find((l) => l.ticker === t)?.sector17 ?? "unknown" }));
  const ok = short.filter((l) => {
    const row = table.rows[l.ticker];
    return row && row.close >= r.minPrice && (row.adv20 == null || row.adv20 >= r.minTradedValue);
  });
  funnel.push({ step: `株価 ¥${r.minPrice} 以上・売買代金 ${yen(r.minTradedValue)}/日 以上（20日平均）`, count: ok.length });
  const weights = { momentum: 0.4, high52: 0.3, lowvol: 0.3 };
  const asOf = Object.values(prices).map((b) => b.at(-1)!.date).sort().at(-1) ?? day;
  const cols = factorColumns({ asOf, rows: ok.map((l) => table.rows[l.ticker]!) });
  const score = compositeScore(cols, ok.map((l) => l.ticker), weights, { method: "rank" });
  const candidates = ok
    .map((l): ScreenCandidate => {
      const row = table.rows[l.ticker]!;
      const size = sizeOfScale(l.scale);
      return {
        ticker: l.ticker, name: l.name, sector: l.sector17 || l.sector33 || "unknown", bucket: size, exchange: `東証${l.segmentName}`, cik: 0, float: 0,
        revenueGrowth: null, operatingMargin: null, price: row.close, tradedValue: row.adv20 ?? null, momentum: row.momentum, score: score[l.ticker] ?? 0,
        reason: [
          `${l.segmentName} · ${l.scale && l.scale !== "-" ? l.scale : "TOPIX 外"}`,
          `12-1モメンタム ${pct(row.momentum)}`,
          row.fromHigh52 != null ? `52週高値から ${pct(row.fromHigh52)}` : "",
          row.adv20 != null ? `売買代金 ${yen(row.adv20)}/日` : "",
        ].filter(Boolean).join("、"),
      };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, r.count);
  funnel.push({ step: "提案", count: candidates.length });
  notes.push("日本株は株価の因子（モメンタム・52週高値・低ボラティリティ）だけで並べた。財務の条件は未対応");
  return { asOf: day, request: r, candidates, funnel, weights, weightsFrom: "default", notes };
}
