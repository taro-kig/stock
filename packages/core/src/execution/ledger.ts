import type { Position } from "../strategy/portfolio.ts";
import type { Db } from "../util/db.ts";
import { weekdays, type IsoDate } from "../util/dates.ts";
import type { BrokerPosition, OrderTicket } from "./broker.ts";

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
  }

  ticket(ref: string): OrderTicket | undefined {
    const r = this.#db.prepare("SELECT * FROM broker_orders WHERE ref = ?").get(ref) as Record<string, string | number | null> | undefined;
    if (!r) return undefined;
    return {
      ref, asOf: String(r["as_of"]), account: String(r["account"]), ticker: String(r["ticker"]), side: r["side"] as "buy" | "sell",
      shares: Number(r["shares"]), limitPrice: Number(r["limit_price"]), tif: "DAY", status: r["status"] as OrderTicket["status"],
      brokerOrderId: r["broker_order_id"] === null ? null : Number(r["broker_order_id"]), message: String(r["message"] ?? ""),
    };
  }

  /** Only real submissions are recorded: a blocked or failed order may be retried later. */
  recordSubmitted(t: OrderTicket, runId: string): void {
    this.#db
      .prepare("INSERT INTO broker_orders VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(t.ref, t.asOf, t.account, t.ticker, t.side, t.shares, t.limitPrice, t.status, t.brokerOrderId, t.message, runId, new Date().toISOString());
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

  /** Records equity and returns the running peak (for the drawdown kill switch). */
  recordEquity(account: string, asOf: IsoDate, equity: number): number {
    this.#db.prepare("INSERT OR REPLACE INTO broker_equity VALUES (?,?,?)").run(account, asOf, equity);
    const r = this.#db.prepare("SELECT MAX(equity) AS m FROM broker_equity WHERE account = ? AND as_of <= ?").get(account, asOf) as { m: number };
    return Math.max(r.m, equity);
  }
}
