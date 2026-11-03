import type { Prices } from "../signals/technical.ts";
import type { Position, Proposal } from "../strategy/portfolio.ts";
import { tradingMode, type RiskConfig, type TradingMode } from "../strategy/risk.ts";
import type { Db } from "../util/db.ts";
import { weekdays, type IsoDate } from "../util/dates.ts";

export interface AccountState {
  account: string;
  asOf: IsoDate;
  currency: "JPY" | "USD";
  cash: number;
  equity: number;
  peakEquity: number;
  mode: TradingMode;
  positions: Record<string, Position>;
}

export interface Fill {
  runId: string;
  account: string;
  asOf: IsoDate;
  ticker: string;
  side: "buy" | "sell";
  shares: number;
  price: number;
  fee: number;
  reason: string;
}

/** Money is stored as integer minor units (yen, cents) to avoid float drift. */
const MINOR = { JPY: 1, USD: 100 } as const;

export function lastClose(prices: Prices, ticker: string, asOf: IsoDate): number | undefined {
  const bars = prices[ticker];
  if (!bars) return undefined;
  for (let i = bars.length - 1; i >= 0; i--) if (bars[i]!.date <= asOf) return bars[i]!.close;
  return undefined;
}

/**
 * Square-root market impact (Almgren et al. / Grinold–Kahn): coef × daily volatility × √(order value / average
 * daily traded value), as a fraction of the price, capped at 5%. 0 when volume is unknown.
 */
export function marketImpact(orderValue: number, bars: ReadonlyArray<{ close: number; volume: number }>, coef = 1): number {
  if (coef <= 0 || bars.length < 21) return 0;
  const last = bars.slice(-21);
  const adv = last.slice(1).reduce((s, b) => s + b.close * (b.volume || 0), 0) / 20;
  if (!(adv > 0)) return 0;
  const rets = last.slice(1).map((b, i) => Math.log(b.close / last[i]!.close));
  const m = rets.reduce((a, b) => a + b, 0) / rets.length;
  const vol = Math.sqrt(rets.reduce((a, b) => a + (b - m) ** 2, 0) / (rets.length - 1));
  return Math.min(0.05, coef * vol * Math.sqrt(orderValue / adv));
}

/**
 * Simulated broker. Fills at the as-of close ± slippage, plus a fee.
 * (Live paper trading would fill at the next open; close-fill keeps replays simple.)
 */
export class PaperBook {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
    db.exec(`
      CREATE TABLE IF NOT EXISTS paper_accounts (account TEXT PRIMARY KEY, currency TEXT, cash_minor INT, peak_minor INT, created_at TEXT);
      CREATE TABLE IF NOT EXISTS paper_positions (
        account TEXT, ticker TEXT, shares INT, entry_price REAL, highest_close REAL, sector TEXT, entry_date TEXT,
        PRIMARY KEY (account, ticker));
      CREATE TABLE IF NOT EXISTS paper_fills (
        run_id TEXT, account TEXT, as_of TEXT, ticker TEXT, side TEXT, shares INT, price REAL, fee_minor INT, reason TEXT);
      CREATE TABLE IF NOT EXISTS paper_equity (account TEXT, as_of TEXT, equity_minor INT, PRIMARY KEY (account, as_of));`);
  }

  ensure(account: string, initialCash: number, currency: "JPY" | "USD"): void {
    const m = MINOR[currency];
    this.#db
      .prepare("INSERT OR IGNORE INTO paper_accounts VALUES (?,?,?,?,?)")
      .run(account, currency, Math.round(initialCash * m), Math.round(initialCash * m), new Date().toISOString());
  }

  #account(account: string): { currency: "JPY" | "USD"; cash: number; peak: number } {
    const r = this.#db.prepare("SELECT currency, cash_minor, peak_minor FROM paper_accounts WHERE account = ?").get(account) as
      | { currency: "JPY" | "USD"; cash_minor: number; peak_minor: number }
      | undefined;
    if (!r) throw new Error(`unknown paper account: ${account}`);
    return { currency: r.currency, cash: r.cash_minor, peak: r.peak_minor };
  }

  /** Marks to market at `asOf`, updates trailing highs and the equity peak. */
  state(account: string, asOf: IsoDate, prices: Prices, risk: RiskConfig): AccountState {
    const a = this.#account(account);
    const m = MINOR[a.currency];
    const rows = this.#db.prepare("SELECT * FROM paper_positions WHERE account = ? ORDER BY ticker").all(account) as Array<{
      ticker: string; shares: number; entry_price: number; highest_close: number; sector: string; entry_date: string;
    }>;
    const positions: Record<string, Position> = {};
    let valueMinor = 0;
    for (const r of rows) {
      const px = lastClose(prices, r.ticker, asOf) ?? r.entry_price;
      const high = Math.max(r.highest_close, px);
      if (high !== r.highest_close) this.#db.prepare("UPDATE paper_positions SET highest_close = ? WHERE account = ? AND ticker = ?").run(high, account, r.ticker);
      positions[r.ticker] = {
        ticker: r.ticker, shares: r.shares, entryPrice: r.entry_price, highestClose: high, sector: r.sector, entryDate: r.entry_date,
        daysHeld: Math.max(0, weekdays(r.entry_date, asOf).length - 1),
      };
      valueMinor += Math.round(r.shares * px * m);
    }
    const equityMinor = a.cash + valueMinor;
    const peakMinor = Math.max(a.peak, equityMinor);
    this.#db.prepare("UPDATE paper_accounts SET peak_minor = ? WHERE account = ?").run(peakMinor, account);
    this.#db.prepare("INSERT OR REPLACE INTO paper_equity VALUES (?,?,?)").run(account, asOf, equityMinor);
    const equity = equityMinor / m;
    const peakEquity = peakMinor / m;
    return { account, asOf, currency: a.currency, cash: a.cash / m, equity, peakEquity, mode: tradingMode(equity, peakEquity, risk), positions };
  }

  /** Daily equity per account, for charts. */
  equityHistory(): Array<{ account: string; currency: "JPY" | "USD"; points: Array<[IsoDate, number]> }> {
    const rows = this.#db
      .prepare("SELECT e.account, a.currency, e.as_of, e.equity_minor FROM paper_equity e JOIN paper_accounts a USING (account) ORDER BY e.account, e.as_of")
      .all() as Array<{ account: string; currency: "JPY" | "USD"; as_of: string; equity_minor: number }>;
    const out = new Map<string, { account: string; currency: "JPY" | "USD"; points: Array<[IsoDate, number]> }>();
    for (const r of rows) {
      const e = out.get(r.account) ?? { account: r.account, currency: r.currency, points: [] };
      e.points.push([r.as_of, r.equity_minor / MINOR[r.currency]]);
      out.set(r.account, e);
    }
    return [...out.values()];
  }

  /** Paper accounts and their currencies. */
  accounts(): Array<{ account: string; currency: "JPY" | "USD" }> {
    return this.#db.prepare("SELECT account, currency FROM paper_accounts ORDER BY account").all() as Array<{ account: string; currency: "JPY" | "USD" }>;
  }

  /** Every fill (optionally of one ticker), oldest first, in each account's currency. */
  allFills(ticker?: string): Fill[] {
    const rows = (ticker
      ? this.#db.prepare("SELECT f.*, a.currency FROM paper_fills f JOIN paper_accounts a ON a.account = f.account WHERE f.ticker = ? ORDER BY f.as_of, f.rowid").all(ticker)
      : this.#db.prepare("SELECT f.*, a.currency FROM paper_fills f JOIN paper_accounts a ON a.account = f.account ORDER BY f.as_of, f.rowid").all()) as Array<{
      run_id: string; account: string; as_of: string; ticker: string; side: "buy" | "sell"; shares: number; price: number; fee_minor: number; reason: string; currency: "JPY" | "USD";
    }>;
    return rows.map((r) => ({ runId: r.run_id, account: r.account, asOf: r.as_of, ticker: r.ticker, side: r.side, shares: r.shares, price: r.price, fee: r.fee_minor / MINOR[r.currency], reason: r.reason }));
  }

  /** Open positions (optionally of one ticker) across all paper accounts. */
  openPositions(ticker?: string): Array<{ account: string; currency: "JPY" | "USD"; ticker: string; shares: number; entryPrice: number; highestClose: number; entryDate: IsoDate; sector: string }> {
    const rows = (ticker
      ? this.#db.prepare("SELECT p.*, a.currency FROM paper_positions p JOIN paper_accounts a ON a.account = p.account WHERE p.ticker = ? AND p.shares > 0").all(ticker)
      : this.#db.prepare("SELECT p.*, a.currency FROM paper_positions p JOIN paper_accounts a ON a.account = p.account WHERE p.shares > 0").all()) as Array<{
      account: string; currency: "JPY" | "USD"; ticker: string; shares: number; entry_price: number; highest_close: number; entry_date: string; sector: string | null;
    }>;
    return rows.map((r) => ({ account: r.account, currency: r.currency, ticker: r.ticker, shares: r.shares, entryPrice: r.entry_price, highestClose: r.highest_close, entryDate: r.entry_date, sector: r.sector ?? "unknown" }));
  }

  fillsForRun(runId: string, account: string): Fill[] {
    const rows = this.#db.prepare("SELECT * FROM paper_fills WHERE run_id = ? AND account = ? ORDER BY rowid").all(runId, account) as Array<{
      run_id: string; account: string; as_of: string; ticker: string; side: "buy" | "sell"; shares: number; price: number; fee_minor: number; reason: string;
    }>;
    const m = MINOR[this.#account(account).currency];
    return rows.map((r) => ({ runId: r.run_id, account: r.account, asOf: r.as_of, ticker: r.ticker, side: r.side, shares: r.shares, price: r.price, fee: r.fee_minor / m, reason: r.reason }));
  }

  /** Applies proposals once per run (idempotent: resuming a run never double-fills). */
  apply(
    runId: string, account: string, asOf: IsoDate, proposals: readonly Proposal[], prices: Prices,
    opts: { slippageBps: number; feeBps: number; lotSize: number; sectors: Record<string, string>; impactCoef?: number },
  ): Fill[] {
    const existing = this.fillsForRun(runId, account);
    if (existing.length) return existing;
    const a = this.#account(account);
    const m = MINOR[a.currency];
    let cash = a.cash;
    const fills: Fill[] = [];
    const insert = this.#db.prepare("INSERT INTO paper_fills VALUES (?,?,?,?,?,?,?,?,?)");
    // sells first so their proceeds can fund buys
    for (const p of [...proposals].sort((x, y) => (x.action === y.action ? 0 : x.action === "sell" ? -1 : 1))) {
      const close = lastClose(prices, p.ticker, asOf);
      if (close === undefined) continue;
      // fixed spread + square-root market impact: the bigger the order vs what trades in a day, the worse the price
      const bars = prices[p.ticker]?.filter((b) => b.date <= asOf) ?? [];
      const impact = marketImpact(p.shares * close, bars, opts.impactCoef ?? 1);
      const slip = (p.action === "buy" ? 1 : -1) * (opts.slippageBps / 10_000 + impact);
      const price = close * (1 + slip);
      if (p.action === "sell") {
        const pos = this.#db.prepare("SELECT shares FROM paper_positions WHERE account = ? AND ticker = ?").get(account, p.ticker) as { shares: number } | undefined;
        if (!pos) continue;
        const shares = Math.min(pos.shares, p.shares);
        const gross = Math.round(shares * price * m);
        const fee = Math.round((gross * opts.feeBps) / 10_000);
        cash += gross - fee;
        if (shares === pos.shares) this.#db.prepare("DELETE FROM paper_positions WHERE account = ? AND ticker = ?").run(account, p.ticker);
        else this.#db.prepare("UPDATE paper_positions SET shares = shares - ? WHERE account = ? AND ticker = ?").run(shares, account, p.ticker);
        insert.run(runId, account, asOf, p.ticker, "sell", shares, price, fee, p.reason);
        fills.push({ runId, account, asOf, ticker: p.ticker, side: "sell", shares, price, fee: fee / m, reason: p.reason });
      } else {
        const unitCost = price * m * (1 + opts.feeBps / 10_000);
        const affordable = Math.floor(cash / unitCost / opts.lotSize) * opts.lotSize;
        const shares = Math.min(p.shares, affordable);
        if (shares <= 0) continue;
        const gross = Math.round(shares * price * m);
        const fee = Math.round((gross * opts.feeBps) / 10_000);
        cash -= gross + fee;
        this.#db
          .prepare("INSERT INTO paper_positions VALUES (?,?,?,?,?,?,?)")
          .run(account, p.ticker, shares, price, close, opts.sectors[p.ticker] ?? "unknown", asOf);
        insert.run(runId, account, asOf, p.ticker, "buy", shares, price, fee, p.reason);
        fills.push({ runId, account, asOf, ticker: p.ticker, side: "buy", shares, price, fee: fee / m, reason: p.reason });
      }
    }
    this.#db.prepare("UPDATE paper_accounts SET cash_minor = ? WHERE account = ?").run(cash, account);
    return fills;
  }
}
