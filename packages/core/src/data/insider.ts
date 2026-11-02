import { XMLParser } from "fast-xml-parser";
import type { Db } from "../util/db.ts";
import { addDays, type IsoDate } from "../util/dates.ts";

/**
 * SEC Form 4: officers, directors and 10% owners must report trades in their company's
 * stock within two business days. Open-market purchases (code P) are the informative
 * part: insiders buy with their own money for one reason. Sales (code S) are often
 * pre-planned (Rule 10b5-1) or for taxes and diversification, so they weigh little.
 */
export interface InsiderTrade {
  accession: string;
  ticker: string;
  owner: string;
  title: string;
  officer: boolean;
  director: boolean;
  tenPercent: boolean;
  /** P = open-market purchase, S = open-market sale (others are grants, exercises, gifts …). */
  code: string;
  date: IsoDate;
  shares: number;
  price: number | null;
  value: number | null;
  /** Covered by a Rule 10b5-1 trading plan (box on the form since 2023). */
  plan: boolean;
  /** When EDGAR accepted the filing (UTC): the moment it became public. */
  filedAt: string;
}

export interface InsiderSummary {
  ticker: string;
  windowDays: number;
  buys: number;
  buyers: number;
  buyValue: number;
  sells: number;
  sellers: number;
  sellValue: number;
  /** Sales under a 10b5-1 plan (pre-scheduled: weak signal). */
  plannedSells: number;
  /** 3+ different insiders bought within 30 days. */
  cluster: boolean;
  lastBuy: IsoDate | null;
  /** Largest purchases, newest first. */
  topBuys: Array<{ owner: string; title: string; date: IsoDate; value: number | null; shares: number }>;
}

export type InsiderMap = Record<string, InsiderSummary>;

const parser = new XMLParser({
  ignoreAttributes: true,
  parseTagValue: false,
  trimValues: true,
  isArray: (name) => ["reportingOwner", "nonDerivativeTransaction", "derivativeTransaction"].includes(name),
});

type X = Record<string, unknown>;
const v = (o: unknown): string => {
  if (o === undefined || o === null) return "";
  if (typeof o === "object") return v((o as X)["value"] ?? "");
  return String(o).trim();
};
const flag = (o: unknown) => ["1", "true"].includes(v(o).toLowerCase());
const num = (o: unknown): number | null => {
  const s = v(o);
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

/** Parses one Form 4 XML document (ownershipDocument). Only non-derivative trades are returned. */
export function parseForm4(xml: string, meta: { accession: string; filedAt: string }): InsiderTrade[] {
  const doc = (parser.parse(xml) as X)["ownershipDocument"] as X | undefined;
  if (!doc) throw new Error(`${meta.accession}: not a Form 4 ownership document`);
  const ticker = v((doc["issuer"] as X | undefined)?.["issuerTradingSymbol"]).toUpperCase().replace(/-/g, ".");
  const owners = ((doc["reportingOwner"] as X[] | undefined) ?? []).map((o) => {
    const id = (o["reportingOwnerId"] ?? {}) as X;
    const rel = (o["reportingOwnerRelationship"] ?? {}) as X;
    const officer = flag(rel["isOfficer"]);
    const director = flag(rel["isDirector"]);
    const tenPercent = flag(rel["isTenPercentOwner"]);
    const title = v(rel["officerTitle"]) || (director ? "Director" : tenPercent ? "10% owner" : v(rel["otherText"]) || "Other");
    return { name: v(id["rptOwnerName"]), officer, director, tenPercent, title };
  });
  // joint filings: attribute the trade to the first owner, but keep every role
  const owner = owners[0] ?? { name: "?", officer: false, director: false, tenPercent: false, title: "?" };
  const plan = flag(doc["aff10b5One"]);
  const rows = (((doc["nonDerivativeTable"] as X | undefined)?.["nonDerivativeTransaction"] as X[] | undefined) ?? []);
  const out: InsiderTrade[] = [];
  for (const t of rows) {
    const coding = (t["transactionCoding"] ?? {}) as X;
    const amounts = (t["transactionAmounts"] ?? {}) as X;
    const code = v(coding["transactionCode"]).toUpperCase();
    const date = v(t["transactionDate"]).slice(0, 10);
    const shares = num(amounts["transactionShares"]);
    if (!code || !/^\d{4}-\d{2}-\d{2}$/.test(date) || shares === null) continue;
    const price = num(amounts["transactionPricePerShare"]);
    out.push({
      accession: meta.accession, ticker, owner: owner.name, title: owner.title,
      officer: owners.some((o) => o.officer), director: owners.some((o) => o.director), tenPercent: owners.some((o) => o.tenPercent),
      code, date, shares, price, value: price !== null ? Math.round(price * shares) : null, plan, filedAt: meta.filedAt,
    });
  }
  return out;
}

/** The raw XML of a Form 4 (EDGAR's primaryDocument points at an XSL-rendered copy). */
export const rawForm4Document = (primaryDocument: string) => primaryDocument.replace(/^xsl[^/]+\//i, "");

/** Summarizes open-market trades known at `until` within the window. */
export function summarizeInsider(ticker: string, trades: readonly InsiderTrade[], windowDays: number): InsiderSummary {
  const buys = trades.filter((t) => t.code === "P");
  const sells = trades.filter((t) => t.code === "S");
  const sum = (xs: InsiderTrade[]) => xs.reduce((a, t) => a + (t.value ?? 0), 0);
  const byDate = [...buys].sort((a, b) => b.date.localeCompare(a.date));
  let cluster = false;
  for (const b of byDate) {
    const from = addDays(b.date, -30);
    if (new Set(buys.filter((x) => x.date >= from && x.date <= b.date).map((x) => x.owner)).size >= 3) {
      cluster = true;
      break;
    }
  }
  return {
    ticker, windowDays,
    buys: buys.length, buyers: new Set(buys.map((t) => t.owner)).size, buyValue: sum(buys),
    sells: sells.length, sellers: new Set(sells.map((t) => t.owner)).size, sellValue: sum(sells),
    plannedSells: sells.filter((t) => t.plan).length,
    cluster, lastBuy: byDate[0]?.date ?? null,
    topBuys: [...buys].sort((a, b) => (b.value ?? 0) - (a.value ?? 0)).slice(0, 3)
      .map((t) => ({ owner: t.owner, title: t.title, date: t.date, value: t.value, shares: t.shares })),
  };
}

/** Score input: larger and broader open-market buying → higher; no buying → 0. */
export function insiderScore(s: InsiderSummary | undefined): number {
  if (!s || s.buys === 0) return 0;
  return Math.log1p(s.buyValue / 100_000) * (1 + 0.5 * (s.buyers - 1)) * (s.cluster ? 1.5 : 1);
}

export class InsiderStore {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
    db.exec(`
      CREATE TABLE IF NOT EXISTS insider_filings (accession TEXT PRIMARY KEY, ticker TEXT, filed_at TEXT, trades INT);
      CREATE TABLE IF NOT EXISTS insider_trades (
        accession TEXT, idx INT, ticker TEXT, owner TEXT, title TEXT, officer INT, director INT, ten_pct INT,
        code TEXT, date TEXT, shares REAL, price REAL, value REAL, plan INT, filed_at TEXT, PRIMARY KEY (accession, idx));`);
  }

  has(accession: string): boolean {
    return this.#db.prepare("SELECT 1 FROM insider_filings WHERE accession = ?").get(accession) !== undefined;
  }

  save(accession: string, ticker: string, filedAt: string, trades: readonly InsiderTrade[]): void {
    this.#db.exec("BEGIN");
    try {
      const st = this.#db.prepare("INSERT OR REPLACE INTO insider_trades VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
      trades.forEach((t, i) =>
        st.run(accession, i, ticker, t.owner, t.title, t.officer ? 1 : 0, t.director ? 1 : 0, t.tenPercent ? 1 : 0, t.code, t.date, t.shares, t.price, t.value, t.plan ? 1 : 0, filedAt),
      );
      this.#db.prepare("INSERT OR REPLACE INTO insider_filings VALUES (?,?,?,?)").run(accession, ticker, filedAt, trades.length);
      this.#db.exec("COMMIT");
    } catch (e) {
      this.#db.exec("ROLLBACK");
      throw e;
    }
  }

  /** Open-market trades (P/S) public by `now` and dated within the window before `asOf`. */
  trades(ticker: string, asOf: IsoDate, now: Date, windowDays: number): InsiderTrade[] {
    const rows = this.#db
      .prepare(`SELECT * FROM insider_trades WHERE ticker = ? AND code IN ('P','S') AND date > ? AND date <= ? AND filed_at <= ? ORDER BY date`)
      .all(ticker, addDays(asOf, -windowDays), asOf, now.toISOString()) as Array<Record<string, string | number>>;
    return rows.map((r) => ({
      accession: String(r["accession"]), ticker: String(r["ticker"]), owner: String(r["owner"]), title: String(r["title"]),
      officer: r["officer"] === 1, director: r["director"] === 1, tenPercent: r["ten_pct"] === 1, code: String(r["code"]), date: String(r["date"]),
      shares: Number(r["shares"]), price: r["price"] === null ? null : Number(r["price"]), value: r["value"] === null ? null : Number(r["value"]),
      plan: r["plan"] === 1, filedAt: String(r["filed_at"]),
    }));
  }
}
