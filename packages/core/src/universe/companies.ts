import type { SecClient } from "../data/sec.ts";
import type { Services } from "../services.ts";
import { addDays, type IsoDate } from "../util/dates.ts";
import { normTicker, secListings, type Listing } from "./suggest.ts";

/**
 * The whole listed US market from SEC data, for building a research universe and for screening:
 * - who is listed: company_tickers_exchange.json (NYSE / Nasdaq)
 * - how big: the public float (market value held by non-insiders) from the 10-K cover page, for
 *   every filer at once via the XBRL "frames" API (one request per quarter)
 * - what business: the SIC code from each company's submissions file, mapped to our sectors.
 */
export const SIZE_BUCKETS = ["large", "mid", "small"] as const;
export type SizeBucket = (typeof SIZE_BUCKETS)[number];

/** Float thresholds (USD): large ≥ $10B, mid $2–10B, small $0.3–2B. Below $300M is left out (too illiquid). */
export function bucketOf(float: number): SizeBucket | null {
  if (float >= 10e9) return "large";
  if (float >= 2e9) return "mid";
  if (float >= 0.3e9) return "small";
  return null;
}

export const BUCKET_JA: Record<SizeBucket, string> = { large: "大型", mid: "中型", small: "小型" };

/** SIC code → our sector (null: blank-check companies, funds and anything unmapped). */
export function sicToSector(sic: number): string | null {
  const between = (a: number, b: number) => sic >= a && sic <= b;
  if (sic === 6770 || between(6720, 6726) || sic === 6799) return null; // blank checks (SPACs), funds, investors
  if (sic === 3674) return "semis";
  if (between(3570, 3579) || between(3661, 3679) || between(7370, 7379) || sic === 3577) return "tech";
  if (between(4800, 4899) || between(2710, 2799) || between(7810, 7829)) return "communication";
  if (between(2830, 2836) || between(3841, 3851) || between(8000, 8099) || sic === 6324 || sic === 5122 || sic === 8731) return "healthcare";
  if (sic === 6798 || between(6500, 6599)) return "real_estate";
  if (between(6000, 6411) || sic === 6141 || sic === 6153 || sic === 6199) return "financials";
  if (sic === 1311 || between(1381, 1389) || sic === 2911 || between(1220, 1241) || between(4922, 4925) || sic === 5171 || sic === 5172) return "energy";
  if (between(4900, 4991)) return "utilities";
  if (between(2000, 2199) || between(2840, 2844) || between(5400, 5499) || sic === 5912 || sic === 5331 || sic === 5399 || sic === 5141) return "staples";
  if (between(1000, 1499) || between(2800, 2829) || between(2845, 2899) || between(3300, 3399) || between(2600, 2699) || between(3200, 3299) || between(2400, 2499)) return "materials";
  if (between(3710, 3716) || between(2300, 2399) || between(3940, 3949) || between(5200, 5999) || between(7000, 7099) || between(7900, 7999) || between(3630, 3639) || sic === 3711) return "consumer";
  if (between(3400, 3599) || between(3600, 3699) || between(3700, 3799) || between(3800, 3899) || between(4000, 4799) || between(1500, 1799) || between(5000, 5199) || between(7300, 7399) || between(8700, 8799)) return "industrials";
  return null;
}

export interface FrameRow {
  cik: number;
  entityName: string;
  end: IsoDate;
  val: number;
}

/** Parses an XBRL frames response (one fact per filer for a calendar period). */
export function parseFrame(body: unknown): FrameRow[] {
  const data = ((body ?? {}) as { data?: unknown[] }).data;
  if (!Array.isArray(data)) throw new Error("unexpected SEC frames response");
  const out: FrameRow[] = [];
  for (const r of data as Array<Record<string, unknown>>) {
    const cik = Number(r["cik"]);
    const val = Number(r["val"]);
    const end = String(r["end"] ?? "");
    if (Number.isFinite(cik) && Number.isFinite(val) && /^\d{4}-\d{2}-\d{2}$/.test(end)) out.push({ cik, entityName: String(r["entityName"] ?? ""), end, val });
  }
  return out;
}

/** The instant quarters to ask for (the cover page reports the float as of the end of Q2 of the fiscal year). */
export function floatPeriods(today: IsoDate, n = 6): string[] {
  const out: string[] = [];
  let y = Number(today.slice(0, 4));
  let q = Math.floor((Number(today.slice(5, 7)) - 1) / 3) + 1;
  for (let i = 0; i < n; i++) {
    q--;
    if (q === 0) [q, y] = [4, y - 1];
    out.push(`CY${y}Q${q}I`);
  }
  return out;
}

/** Latest public float per CIK (USD) from the last few quarters' frames. */
export async function publicFloats(sec: SecClient, today: IsoDate): Promise<Map<number, { float: number; end: IsoDate }>> {
  const out = new Map<number, { float: number; end: IsoDate }>();
  for (const period of floatPeriods(today)) {
    let rows: FrameRow[];
    try {
      rows = parseFrame(await sec.json(`https://data.sec.gov/api/xbrl/frames/dei/EntityPublicFloat/USD/${period}.json`));
    } catch {
      continue; // a frame not published yet
    }
    for (const r of rows) {
      const prev = out.get(r.cik);
      if (!prev || r.end > prev.end) out.set(r.cik, { float: r.val, end: r.end });
    }
  }
  return out;
}

/** Small deterministic hash: the same sample every time for the same seed (no hidden randomness). */
export function sampleKey(ticker: string, seed: number): number {
  let h = 2166136261 ^ seed;
  for (const ch of ticker) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  return h >>> 0;
}

export interface CompanyRow {
  ticker: string;
  cik: number;
  name: string;
  exchange: string;
  sector: string;
  bucket: SizeBucket;
  float: number;
}

/** One ticker per company: ordinary symbols before class shares, then alphabetical (GOOG before GOOGL). */
export function onePerCompany(listings: Iterable<Listing>): Map<number, Listing> {
  const out = new Map<number, Listing>();
  for (const l of listings) {
    if (!/^(nasdaq|nyse)/i.test(l.exchange)) continue;
    const prev = out.get(l.cik);
    const better = !prev || (l.ticker.includes(".") ? 1 : 0) - (prev.ticker.includes(".") ? 1 : 0) < 0 || ((l.ticker.includes(".") === prev.ticker.includes(".")) && l.ticker < prev.ticker);
    if (better) out.set(l.cik, l);
  }
  return out;
}

export class CompanyStore {
  readonly #s: Services;

  constructor(s: Services) {
    this.#s = s;
    s.db.exec(`
      CREATE TABLE IF NOT EXISTS company_info (cik INT PRIMARY KEY, sic INT, sic_desc TEXT, fetched TEXT);
      CREATE TABLE IF NOT EXISTS company_floats (cik INT PRIMARY KEY, float REAL, end TEXT, fetched TEXT);
      CREATE TABLE IF NOT EXISTS research_universe (ticker TEXT PRIMARY KEY, cik INT, name TEXT, sector TEXT, bucket TEXT, float REAL, built TEXT);`);
  }

  /** SIC of a company (cached; one submissions request when unknown). */
  async sic(sec: SecClient, cik: number, today: IsoDate): Promise<{ sic: number | null; desc: string }> {
    const hit = this.#s.db.prepare("SELECT sic, sic_desc FROM company_info WHERE cik = ?").get(cik) as { sic: number | null; sic_desc: string } | undefined;
    if (hit) return { sic: hit.sic, desc: hit.sic_desc };
    const body = (await sec.json(`https://data.sec.gov/submissions/CIK${String(cik).padStart(10, "0")}.json`)) as { sic?: unknown; sicDescription?: unknown };
    const sic = Number(body.sic);
    const out = { sic: Number.isFinite(sic) && sic > 0 ? sic : null, desc: String(body.sicDescription ?? "") };
    this.#s.db.prepare("INSERT OR REPLACE INTO company_info VALUES (?,?,?,?)").run(cik, out.sic, out.desc, today);
    return out;
  }

  /** Public floats, refreshed when older than `maxAgeDays`. */
  async floats(sec: SecClient, today: IsoDate, maxAgeDays = 30): Promise<Map<number, { float: number; end: IsoDate }>> {
    const last = (this.#s.db.prepare("SELECT MAX(fetched) AS d FROM company_floats").get() as { d: string | null } | undefined)?.d;
    if (!last || last < addDays(today, -maxAgeDays)) {
      const fresh = await publicFloats(sec, today);
      if (fresh.size) {
        const up = this.#s.db.prepare("INSERT OR REPLACE INTO company_floats VALUES (?,?,?,?)");
        this.#s.db.exec("BEGIN");
        try {
          for (const [cik, f] of fresh) up.run(cik, f.float, f.end, today);
          this.#s.db.exec("COMMIT");
        } catch (e) {
          this.#s.db.exec("ROLLBACK");
          throw e;
        }
      }
    }
    const rows = this.#s.db.prepare("SELECT cik, float, end FROM company_floats").all() as Array<{ cik: number; float: number; end: string }>;
    return new Map(rows.map((r) => [r.cik, { float: r.float, end: r.end }]));
  }

  /** Every NYSE / Nasdaq company with a known size (sector filled in only where already cached). */
  async market(sec: SecClient, today: Date): Promise<Array<Omit<CompanyRow, "sector"> & { sector: string | null }>> {
    const day = today.toISOString().slice(0, 10);
    const listings = onePerCompany((await secListings(this.#s, sec, today)).values());
    const floats = await this.floats(sec, day);
    const info = new Map((this.#s.db.prepare("SELECT cik, sic FROM company_info").all() as Array<{ cik: number; sic: number | null }>).map((r) => [r.cik, r.sic]));
    const out: Array<Omit<CompanyRow, "sector"> & { sector: string | null }> = [];
    for (const [cik, l] of listings) {
      const f = floats.get(cik);
      const bucket = f ? bucketOf(f.float) : null;
      if (!f || !bucket) continue;
      const sic = info.get(cik);
      out.push({ ticker: normTicker(l.ticker), cik, name: l.name, exchange: l.exchange, bucket, float: f.float, sector: sic == null ? null : sicToSector(sic) });
    }
    return out;
  }

  saveResearch(rows: readonly CompanyRow[], day: IsoDate): void {
    this.#s.db.exec("BEGIN");
    try {
      this.#s.db.exec("DELETE FROM research_universe");
      const up = this.#s.db.prepare("INSERT INTO research_universe VALUES (?,?,?,?,?,?,?)");
      for (const r of rows) up.run(r.ticker, r.cik, r.name, r.sector, r.bucket, r.float, day);
      this.#s.db.exec("COMMIT");
    } catch (e) {
      this.#s.db.exec("ROLLBACK");
      throw e;
    }
  }

  research(): { built: IsoDate | null; rows: CompanyRow[] } {
    const rows = this.#s.db.prepare("SELECT ticker, cik, name, sector, bucket, float, built FROM research_universe ORDER BY ticker").all() as unknown as Array<CompanyRow & { built: string }>;
    return { built: rows[0]?.built ?? null, rows: rows.map(({ built: _b, ...r }) => ({ ...r, exchange: "" })) };
  }
}

/**
 * A stratified, deterministic sample: `perBucket` companies from each size bucket, in a fixed
 * pseudo-random order (seeded hash), skipping companies whose sector is unknown. Sectors are
 * looked up (one SEC request each) only for the companies considered.
 */
export async function buildResearchUniverse(
  s: Services,
  sec: SecClient,
  today: Date,
  o: { perBucket: number; seed: number; maxLookups?: number },
): Promise<CompanyRow[]> {
  const day = today.toISOString().slice(0, 10);
  const companies = await s.companies.market(sec, today);
  const store = s.companies;
  const out: CompanyRow[] = [];
  let lookups = 0;
  for (const bucket of SIZE_BUCKETS) {
    const pool = companies.filter((c) => c.bucket === bucket).sort((a, b) => sampleKey(a.ticker, o.seed) - sampleKey(b.ticker, o.seed));
    let n = 0;
    for (const c of pool) {
      if (n >= o.perBucket) break;
      let sector = c.sector;
      if (sector === null) {
        if (lookups >= (o.maxLookups ?? 2000)) break;
        lookups++;
        try {
          const { sic } = await store.sic(sec, c.cik, day);
          sector = sic === null ? null : sicToSector(sic);
        } catch {
          continue;
        }
      }
      if (!sector) continue;
      out.push({ ...c, sector });
      n++;
    }
  }
  return out;
}
