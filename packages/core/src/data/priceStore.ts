import type { Bar } from "../signals/technical.ts";
import type { Db } from "../util/db.ts";

/**
 * Local copy of downloaded daily bars, per (source, ticker). Lets daily runs fetch only
 * the last few bars, lets replays of past dates run without the network, and keeps
 * free-tier API credits for what is new.
 */
export class PriceStore {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
    db.exec(`
      CREATE TABLE IF NOT EXISTS price_bars (
        source TEXT, ticker TEXT, date TEXT, open REAL, high REAL, low REAL, close REAL, volume REAL,
        PRIMARY KEY (source, ticker, date));
      CREATE TABLE IF NOT EXISTS price_fetches (source TEXT, ticker TEXT, fetched_at TEXT, PRIMARY KEY (source, ticker));`);
  }

  bars(source: string, ticker: string): Bar[] {
    return this.#db
      .prepare("SELECT date, open, high, low, close, volume FROM price_bars WHERE source = ? AND ticker = ? ORDER BY date")
      .all(source, ticker) as unknown as Bar[];
  }

  /** Inserts or overwrites the given dates. */
  upsert(source: string, ticker: string, bars: readonly Bar[]): void {
    const st = this.#db.prepare("INSERT OR REPLACE INTO price_bars VALUES (?,?,?,?,?,?,?,?)");
    this.#tx(() => {
      for (const b of bars) st.run(source, ticker, b.date, b.open, b.high, b.low, b.close, b.volume);
    });
  }

  /** Replaces the whole history (e.g. after a split re-adjusted every past bar). */
  replace(source: string, ticker: string, bars: readonly Bar[]): void {
    this.#tx(() => {
      this.#db.prepare("DELETE FROM price_bars WHERE source = ? AND ticker = ?").run(source, ticker);
      const st = this.#db.prepare("INSERT OR REPLACE INTO price_bars VALUES (?,?,?,?,?,?,?,?)");
      for (const b of bars) st.run(source, ticker, b.date, b.open, b.high, b.low, b.close, b.volume);
    });
  }

  /** Wall-clock time of the last successful download, if any. */
  lastFetch(source: string, ticker: string): Date | null {
    const r = this.#db.prepare("SELECT fetched_at FROM price_fetches WHERE source = ? AND ticker = ?").get(source, ticker) as
      | { fetched_at: string }
      | undefined;
    return r ? new Date(r.fetched_at) : null;
  }

  markFetched(source: string, ticker: string, at: Date): void {
    this.#db.prepare("INSERT OR REPLACE INTO price_fetches VALUES (?,?,?)").run(source, ticker, at.toISOString());
  }

  #tx(fn: () => void): void {
    this.#db.exec("BEGIN");
    try {
      fn();
      this.#db.exec("COMMIT");
    } catch (e) {
      this.#db.exec("ROLLBACK");
      throw e;
    }
  }
}
