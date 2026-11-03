import { describe, expect, it } from "vitest";
import type { BrokerAccount, BrokerClient, OrderTicket } from "../src/execution/broker.ts";
import { BrokerLedger } from "../src/execution/ledger.ts";
import { trackOrders } from "../src/execution/tracking.ts";
import { openDb } from "../src/util/db.ts";

const today = new Date().toISOString().slice(0, 10);

function ticket(ticker: string, side: "buy" | "sell", shares: number, limitPrice = 100): OrderTicket {
  return { ref: `sa-${today}-DU1-${ticker}-${side}`, asOf: today, account: "DU1", ticker, side, shares, limitPrice, tif: "DAY", status: "submitted", brokerOrderId: "9", message: "" };
}

function broker(open: string[], extra: Partial<BrokerClient> = {}): BrokerClient {
  return { account: async () => { throw new Error("unused"); }, openOrderRefs: async () => open, placeLimitOrder: async () => "1", close: async () => {}, ...extra };
}

const account = (positions: BrokerAccount["positions"]): BrokerAccount => ({ accountId: "DU1", currency: "USD", netLiquidation: 1e6, cash: 1e5, positions });

describe("order tracking", () => {
  it("infers filled / partial / unfilled / working from positions and the open-order list", async () => {
    const l = new BrokerLedger(openDb(":memory:"));
    l.recordSubmitted(ticket("AAA", "buy", 10), "r1", { shares: 0, avgCost: null });
    l.recordSubmitted(ticket("BBB", "buy", 10), "r1", { shares: 10, avgCost: 50 });
    l.recordSubmitted(ticket("CCC", "sell", 20), "r1", { shares: 20, avgCost: 30 });
    l.recordSubmitted(ticket("DDD", "buy", 5), "r1", { shares: 0, avgCost: null });
    l.recordSubmitted(ticket("EEE", "buy", 5), "r1"); // sent before tracking existed
    const b = broker([`sa-${today}-DU1-DDD-buy`]);
    const now = new Date();
    const u = await trackOrders(l, b, account([
      { ticker: "AAA", shares: 10, avgCost: 101 },
      { ticker: "BBB", shares: 14, avgCost: (50 * 10 + 60 * 4) / 14 },
      { ticker: "CCC", shares: 20, avgCost: 30 },
    ]), now);
    const by = Object.fromEntries(u.map((x) => [x.ticker, x]));
    expect(by["AAA"]).toMatchObject({ state: "filled", filledShares: 10, estimated: true });
    expect(by["AAA"]!.fillPrice).toBeCloseTo(101);
    expect(by["BBB"]).toMatchObject({ state: "partial", filledShares: 4 });
    expect(by["BBB"]!.fillPrice).toBeCloseTo(60);
    expect(by["CCC"]).toMatchObject({ state: "unfilled", filledShares: 0 });
    expect(by["DDD"]).toMatchObject({ state: "working" });
    expect(by["EEE"]!.note).toContain("結果不明");

    // settled orders are not checked again; the working one is
    const again = await trackOrders(l, broker([]), account([{ ticker: "DDD", shares: 5, avgCost: 99 }]), now);
    expect(again.map((x) => [x.ticker, x.state])).toEqual([["DDD", "filled"]]);
    const rows = Object.fromEntries(l.recentOrders().map((r) => [r.ticker, r]));
    expect(rows["AAA"]).toMatchObject({ state: "filled", filledShares: 10, estimated: true });
    expect(rows["DDD"]).toMatchObject({ state: "filled", posBefore: 0 });
  });

  it("a sell that reduced the position counts as filled; exact broker reports win", async () => {
    const l = new BrokerLedger(openDb(":memory:"));
    l.recordSubmitted(ticket("AAA", "sell", 10), "r1", { shares: 10, avgCost: 80 });
    l.recordSubmitted(ticket("BBB", "buy", 10), "r1", { shares: 0, avgCost: null });
    const b = broker([], {
      orderUpdates: async (orders) => orders.filter((o) => o.ref.includes("BBB")).map((o) => ({ ref: o.ref, state: "partial" as const, filledShares: 3, fillPrice: 99.5, note: "broker" })),
    });
    const u = await trackOrders(l, b, account([]), new Date());
    const by = Object.fromEntries(u.map((x) => [x.ticker, x]));
    expect(by["AAA"]).toMatchObject({ state: "filled", filledShares: 10, fillPrice: null, estimated: true });
    expect(by["BBB"]).toMatchObject({ state: "partial", filledShares: 3, fillPrice: 99.5, estimated: false });
  });
});
