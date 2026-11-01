import { describe, expect, it } from "vitest";
import { PaperBook } from "../src/execution/paper.ts";
import type { Bar, Prices } from "../src/signals/technical.ts";
import { RiskConfig } from "../src/strategy/risk.ts";
import { openDb } from "../src/util/db.ts";

const bar = (date: string, close: number): Bar => ({ date, open: close, high: close, low: close, close, volume: 1 });
const prices = (px: number): Prices => ({ A: [bar("2026-10-01", 1000), bar("2026-10-02", px)] });
const opts = { slippageBps: 0, feeBps: 10, lotSize: 100, sectors: { A: "x" } };
const risk = RiskConfig.parse({});

describe("PaperBook", () => {
  it("buys, marks to market, sells, with fees in integer yen", () => {
    const book = new PaperBook(openDb(":memory:"));
    book.ensure("acct", 1_000_000, "JPY");
    const buy = book.apply("r1", "acct", "2026-10-01", [{ action: "buy", ticker: "A", shares: 300, price: 1000, reason: "t" }], prices(1000), opts);
    expect(buy).toMatchObject([{ side: "buy", shares: 300, price: 1000, fee: 300 }]);
    const s = book.state("acct", "2026-10-02", prices(1100), risk);
    expect(s.cash).toBe(1_000_000 - 300_000 - 300);
    expect(s.equity).toBe(s.cash + 300 * 1100);
    expect(s.positions["A"]?.highestClose).toBe(1100);
    book.apply("r2", "acct", "2026-10-02", [{ action: "sell", ticker: "A", shares: 300, price: 1100, reason: "t" }], prices(1100), opts);
    expect(book.state("acct", "2026-10-02", prices(1100), risk).cash).toBe(1_000_000 - 300_300 + 330_000 - 330);
  });

  it("is idempotent per run and never spends more cash than it has", () => {
    const book = new PaperBook(openDb(":memory:"));
    book.ensure("acct", 250_000, "JPY");
    const p = [{ action: "buy" as const, ticker: "A", shares: 1000, price: 1000, reason: "t" }];
    const f1 = book.apply("r1", "acct", "2026-10-01", p, prices(1000), opts);
    expect(f1[0]?.shares).toBe(200); // affordable lots only
    const f2 = book.apply("r1", "acct", "2026-10-01", p, prices(1000), opts);
    expect(f2).toEqual(f1);
    expect(book.state("acct", "2026-10-01", prices(1000), risk).positions["A"]?.shares).toBe(200);
  });
});
