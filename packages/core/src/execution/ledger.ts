import type { Position } from "../strategy/portfolio.ts";
import type { Db } from "../util/db.ts";
import { weekdays, type IsoDate } from "../util/dates.ts";
import type { BrokerPosition, OrderTicket } from "./broker.ts";

/** A sent order with what is known about its outcome. */
export interface TrackedOrder {
  ref: string;
  asOf: IsoDate;
  account: string;
  ticker: string;
  side: "buy" | "sell";
  shares: number;
  limitPrice: number;
  brokerOrderId: string | null;
  createdAt: string;
  /** Position when the order was sent (null for orders sent before tracking existed). */
  posBefore: number | null;
  avgBefore: number | null;
  state: "working" | "filled" | "partial" | "unfilled" | null;
  filledShares: number | null;
  fillPrice: number | null;
  note: string | null;
  estimated: boolean;
  checkedAt: string | null;
}

function toTracked(r: Record<string, unknown>): TrackedOrder {
  const n = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  return {
    ref: String(r["ref"]), asOf: String(r["as_of"]), account: String(r["account"]), ticker: String(r["ticker"]), side: r["side"] as "buy" | "sell",
    shares: Number(r["shares"]), limitPrice: Number(r["limit_price"]),
    brokerOrderId: r["broker_order_ref"] != null ? String(r["broker_order_ref"]) : r["broker_order_id"] != null ? String(r["broker_order_id"]) : null,
    createdAt: String(r["created_at"] ?? ""), posBefore: n(r["pos_before"]), avgBefore: n(r["avg_before"]),
    state: (r["state"] ?? null) as TrackedOrder["state"], filledShares: n(r["filled_shares"]), fillPrice: n(r["fill_price"]),
    note: r["track_note"] != null ? String(r["track_note"]) : null, estimated: Number(r["estimated"] ?? 0) === 1, checkedAt: r["checked_at"] != null ? String(r["checked_at"]) : null,
  };
}

/**
 * Local bookkeeping for a real broker account: what the broker does not tell us
 * but the risk rules need (entry date, trailing high, equity peak), plus every
 * order ticket we ever sent (idempotency + audit trail).
 */
export class BrokerLedger {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
    db.exec(`
      CREATE TABLE IF NOT EXISTS broker_orders (
        ref TEXT PRIMARY KEY, as_of TEXT, account TEXT, ticker TEXT, side TEXT, shares INT, limit_price REAL,
        status TEXT, broker_order_id INT, message TEXT, run_id TEXT, created_at TEXT);
      CREATE TABLE IF NOT EXISTS broker_positions (
        account TEXT, ticker TEXT, entry_date TEXT, entry_price REAL, highest_close REAL, sector TEXT, PRIMARY KEY (account, ticker));
      CREATE TABLE IF NOT EXISTS broker_equity (account TEXT, as_of TEXT, equity REAL, PRIMARY KEY (account, as_of));`);
    // v2: broker order ids are strings (an INT column would round Webull's large ids)
    const cols = db.prepare("PRAGMA table_info(broker_orders)").all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === "broker_order_ref")) db.exec("ALTER TABLE broker_orders ADD COLUMN broker_order_ref TEXT");
    // v3: what became of each order (see execution/tracking.ts)
    for (const [c, t] of [["pos_before", "REAL"], ["avg_before", "REAL"], ["state", "TEXT"], ["filled_shares", "REAL"], ["fill_price", "REAL"], ["track_note", "TEXT"], ["checked_at", "TEXT"], ["estimated", "INT"]] as const) {
      if (!cols.some((x) => x.name === c)) db.exec(`ALTER TABLE broker_orders ADD COLUMN ${c} ${t}`);
    }
    // v4: the account's currency next to its equity (US and Japanese accounts are shown together)
    if (!(db.prepare("PRAGMA table_info(broker_equity)").all() as Array<{ name: string }>).some((c) => c.name === "currency")) db.exec("ALTER TABLE broker_equity ADD COLUMN currency TEXT");
  }

  /** Orders sent in the last `days` days whose outcome is not known yet. */
  pendingOrders(account: string, days = 10): TrackedOrder[] {
    const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
    return (this.#db.prepare("SELECT * FROM broker_orders WHERE account = ? AND status = 'submitted' AND (state IS NULL OR state = 'working') AND as_of >= ? ORDER BY created_at").all(account, since) as Array<Record<string, unknown>>).map(toTracked);
  }

  updateOrder(ref: string, u: { state: string; filledShares: number; fillPrice: number | null; note: string; estimated: boolean }, at: Date): void {
    this.#db.prepare("UPDATE broker_orders SET state = ?, filled_shares = ?, fill_price = ?, track_note = ?, estimated = ?, checked_at = ? WHERE ref = ?")
      .run(u.state, u.filledShares, u.fillPrice, u.note, u.estimated ? 1 : 0, at.toISOString(), ref);
  }

  /** Recent orders sent to brokers with their outcome, newest first. */
  recentOrders(limit = 100): TrackedOrder[] {
    return (this.#db.prepare("SELECT * FROM broker_orders ORDER BY created_at DESC LIMIT ?").all(limit) as Array<Record<string, unknown>>).map(toTracked);
  }

  ticket(ref: string): OrderTicket | undefined {
    const r = this.#db.prepare("SELECT * FROM broker_orders WHERE ref = ?").get(ref) as Record<string, string | number | null> | undefined;
    if (!r) return undefined;
    return {
      ref, asOf: String(r["as_of"]), account: String(r["account"]), ticker: String(r["ticker"]), side: r["side"] as "buy" | "sell",
      shares: Number(r["shares"]), limitPrice: Number(r["limit_price"]), tif: "DAY", status: r["status"] as OrderTicket["status"],
      brokerOrderId: r["broker_order_ref"] != null ? String(r["broker_order_ref"]) : r["broker_order_id"] != null ? String(r["broker_order_id"]) : null,
      message: String(r["message"] ?? ""),
    };
  }

  /** Only real submissions are recorded: a blocked or failed order may be retried later. */
  recordSubmitted(t: OrderTicket, runId: string, before?: { shares: number; avgCost: number | null }): void {
    this.#db
      .prepare(
        `INSERT INTO broker_orders (ref, as_of, account, ticker, side, shares, limit_price, status, broker_order_id, message, run_id, created_at, broker_order_ref, pos_before, avg_before, state)
         VALUES (?,?,?,?,?,?,?,?,NULL,?,?,?,?,?,?,?)`,
      )
      .run(t.ref, t.asOf, t.account, t.ticker, t.side, t.shares, t.limitPrice, t.status, t.message, runId, new Date().toISOString(), t.brokerOrderId,
        before ? before.shares : null, before ? before.avgCost : null, "working");
  }

  /** Aligns local metadata with the broker's positions; returns positions in the strategy's shape. */
  reconcile(account: string, asOf: IsoDate, held: readonly BrokerPosition[], lastClose: (t: string) => number | undefined, sector: (t: string) => string): Record<string, Position> {
    const rows = this.#db.prepare("SELECT * FROM broker_positions WHERE account = ?").all(account) as Array<{
      ticker: string; entry_date: string; entry_price: number; highest_close: number; sector: string;
    }>;
    const known = new Map(rows.map((r) => [r.ticker, r]));
    const live = new Set(held.filter((p) => p.shares !== 0).map((p) => p.ticker));
    for (const t of known.keys()) if (!live.has(t)) this.#db.prepare("DELETE FROM broker_positions WHERE account = ? AND ticker = ?").run(account, t);
    const out: Record<string, Position> = {};
    for (const p of held) {
      if (p.shares === 0) continue;
      const px = lastClose(p.ticker) ?? p.avgCost;
      const k = known.get(p.ticker);
      const entryDate = k?.entry_date ?? asOf;
      const entryPrice = k?.entry_price ?? p.avgCost;
      const high = Math.max(k?.highest_close ?? px, px);
      this.#db
        .prepare("INSERT OR REPLACE INTO broker_positions VALUES (?,?,?,?,?,?)")
        .run(account, p.ticker, entryDate, entryPrice, high, k?.sector ?? sector(p.ticker));
      out[p.ticker] = {
        ticker: p.ticker, shares: p.shares, entryPrice, highestClose: high, sector: k?.sector ?? sector(p.ticker), entryDate,
        daysHeld: Math.max(0, weekdays(entryDate, asOf).length - 1),
      };
    }
    return out;
  }

  equityHistory(): Array<{ account: string; currency: string | null; points: Array<[IsoDate, number]> }> {
    const rows = this.#db.prepare("SELECT account, as_of, equity, currency FROM broker_equity ORDER BY account, as_of").all() as Array<{ account: string; as_of: string; equity: number; currency: string | null }>;
    const out = new Map<string, { currency: string | null; points: Array<[IsoDate, number]> }>();
    for (const r of rows) {
      const e = out.get(r.account) ?? { currency: null, points: [] };
      e.points.push([r.as_of, r.equity]);
      if (r.currency) e.currency = r.currency;
      out.set(r.account, e);
    }
    return [...out.entries()].map(([account, e]) => ({ account, currency: e.currency, points: e.points }));
  }

  /** Records equity and returns the running peak (for the drawdown kill switch). */
  recordEquity(account: string, asOf: IsoDate, equity: number, currency: string | null = null): number {
    this.#db.prepare("INSERT OR REPLACE INTO broker_equity (account, as_of, equity, currency) VALUES (?,?,?,?)").run(account, asOf, equity, currency);
    const r = this.#db.prepare("SELECT MAX(equity) AS m FROM broker_equity WHERE account = ? AND as_of <= ?").get(account, asOf) as { m: number };
    return Math.max(r.m, equity);
  }
}
