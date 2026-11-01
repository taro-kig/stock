import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.ts";
import { FakeBroker, type OrderTicket } from "../src/execution/broker.ts";
import { checkAccountMode, checkOrder, LIVE_ENV_VALUE, LIVE_ENV_VAR, limitPrice, orderRef, tickSize } from "../src/execution/guards.ts";
import { ibContract, IbkrConfig } from "../src/execution/ibkr.ts";
import { BrokerLedger } from "../src/execution/ledger.ts";
import { builtinRegistry } from "../src/nodes/index.ts";
import { Services } from "../src/services.ts";
import { openDb } from "../src/util/db.ts";
import { weekdays } from "../src/util/dates.ts";
import { Engine } from "../src/workflow/engine.ts";
import { loadWorkflow } from "../src/workflow/spec.ts";

describe("pre-trade guards", () => {
  it("interlocks account and mode", () => {
    const env = {};
    expect(checkAccountMode("DU123", "paper", { env })).toBeNull();
    expect(checkAccountMode("U123", "paper", { env })).toMatch(/looks like a live account/);
    expect(checkAccountMode("DU123", "paper", { expectedAccountId: "DU999", env })).toMatch(/does not match/);
    expect(checkAccountMode("U123", "live", { expectedAccountId: "U123", env })).toMatch(new RegExp(LIVE_ENV_VAR));
    expect(checkAccountMode("U123", "live", { env: { [LIVE_ENV_VAR]: LIVE_ENV_VALUE } })).toMatch(/requires ibkr.accountId/);
    expect(checkAccountMode("U123", "live", { expectedAccountId: "U123", env: { [LIVE_ENV_VAR]: LIVE_ENV_VALUE } })).toBeNull();
    expect(checkAccountMode("DU1", "live", { expectedAccountId: "DU1", env: { [LIVE_ENV_VAR]: LIVE_ENV_VALUE } })).toMatch(/paper account/);
  });

  it("puts limit prices on the TSE tick grid, never beyond the offset", () => {
    expect([tickSize(2999, "jp"), tickSize(4000, "jp"), tickSize(20_000, "jp"), tickSize(40_000, "jp")]).toEqual([1, 5, 10, 50]);
    expect(limitPrice("buy", 2990, 50, "jp")).toBe(3000); // 3004.95 is in the 5-yen band -> 3000 (3004 would be rejected)
    expect(limitPrice("buy", 2980, 50, "jp")).toBe(2994); // 2994.9 is in the 1-yen band
    expect(limitPrice("buy", 4000, 50, "jp")).toBe(4020); // 4020 exactly on 5-yen grid
    expect(limitPrice("buy", 4001, 50, "jp")).toBe(4020); // 4021.0 -> floor to 5
    expect(limitPrice("sell", 4001, 50, "jp")).toBe(3985); // 3980.995 -> ceil to 5
    expect(limitPrice("buy", 187.333, 50, "us")).toBe(188.26);
  });

  it("blocks shorting, odd lots and oversized orders", () => {
    const acct = { accountId: "DU1", currency: "JPY", netLiquidation: 1e7, cash: 1e7, positions: [{ ticker: "7203", shares: 100, avgCost: 3000 }] };
    const lim = { maxOrderValue: 1_000_000, maxOrdersPerRun: 5, lotSize: 100 };
    const o = (over: object) => ({ ref: "r", ticker: "7203", side: "buy" as const, shares: 100, limitPrice: 3000, tif: "DAY" as const, ...over });
    expect(checkOrder(o({}), acct, lim)).toBeNull();
    expect(checkOrder(o({ shares: 150 }), acct, lim)).toMatch(/multiple of lot/);
    expect(checkOrder(o({ shares: 400 }), acct, lim)).toMatch(/exceeds maxOrderValue/);
    expect(checkOrder(o({ side: "sell", shares: 200 }), acct, lim)).toMatch(/no shorting/);
    expect(checkOrder(o({ side: "sell", ticker: "6758" }), acct, lim)).toMatch(/no shorting/);
  });

  it("maps tickers to IB contracts", () => {
    expect(ibContract("7203", IbkrConfig.parse({}))).toEqual({ symbol: "7203", secType: "STK", exchange: "TSEJ", currency: "JPY" });
    expect(ibContract("AAPL", IbkrConfig.parse({ market: "us" }))).toMatchObject({ exchange: "SMART", currency: "USD" });
    expect(orderRef("2026-11-02", "DU1", { ticker: "7203", action: "buy" })).toBe("sa-2026-11-02-DU1-7203-buy");
  });
});

describe("broker ledger", () => {
  it("keeps entry dates and trailing highs across reconciliations", () => {
    const l = new BrokerLedger(openDb(":memory:"));
    const p1 = l.reconcile("DU1", "2026-10-01", [{ ticker: "A", shares: 100, avgCost: 1000 }], () => 1100, () => "x");
    expect(p1["A"]).toMatchObject({ entryDate: "2026-10-01", entryPrice: 1000, highestClose: 1100, daysHeld: 0 });
    const p2 = l.reconcile("DU1", "2026-10-08", [{ ticker: "A", shares: 100, avgCost: 1000 }], () => 1050, () => "x");
    expect(p2["A"]).toMatchObject({ entryDate: "2026-10-01", highestClose: 1100, daysHeld: 5 });
    expect(l.reconcile("DU1", "2026-10-09", [], () => 1, () => "x")).toEqual({});
    expect(l.reconcile("DU1", "2026-10-10", [{ ticker: "A", shares: 100, avgCost: 900 }], () => 900, () => "x")["A"]?.entryDate).toBe("2026-10-10");
  });
  it("tracks the equity peak", () => {
    const l = new BrokerLedger(openDb(":memory:"));
    expect(l.recordEquity("DU1", "2026-10-01", 100)).toBe(100);
    expect(l.recordEquity("DU1", "2026-10-02", 120)).toBe(120);
    expect(l.recordEquity("DU1", "2026-10-03", 90)).toBe(120);
  });
});

const ROOT = resolve(import.meta.dirname, "../../..");

describe("IBKR workflow (fake broker)", () => {
  const setup = (broker: FakeBroker, ibkr: Record<string, unknown> = {}, clock?: () => Date) => {
    const cfg = loadConfig(resolve(ROOT, "config/config.example.yaml"));
    cfg.ibkr = IbkrConfig.parse({ maxOrderValue: 5_000_000, ...ibkr });
    const services = new Services(cfg, { fake: true, dbPath: ":memory:", brokerFactory: async () => broker });
    const spec = loadWorkflow(resolve(ROOT, "workflows/ibkr-paper.yaml"));
    spec.nodes["news"] = { ...spec.nodes["news"]!, use: "source.fixture", params: { path: resolve(ROOT, "examples/fixtures/news.json"), lookbackDays: 7 } };
    spec.nodes["prices"] = { ...spec.nodes["prices"]!, use: "data.pricesSynthetic", params: { seed: 6 } };
    return { services, spec, engine: new Engine({ services, registry: builtinRegistry(), store: services.runStore, clock }) };
  };

  it("validates the shipped workflow", () => {
    const { spec, engine } = setup(new FakeBroker());
    expect(() => engine.validate(spec)).not.toThrow();
  });

  /** First replay date on which the strategy wants to trade (found with a dry run). */
  async function tradingDay(): Promise<string> {
    const { spec, engine } = setup(new FakeBroker());
    spec.nodes["approve"]!.params["mode"] = "auto";
    spec.nodes["execute"]!.params["dryRun"] = true;
    for (const d of weekdays("2026-06-01", "2026-10-30")) {
      const r = await engine.run(spec, { asOf: d });
      if (r.output<OrderTicket[]>("execute", "orders").some((o) => o.status === "dry_run" && o.side === "buy")) return d;
    }
    throw new Error("no trading day found");
  }

  it("pauses for approval, then sends each limit order exactly once per day", async () => {
    const d = await tradingDay();
    const broker = new FakeBroker("DU7654321");
    const { services, spec, engine } = setup(broker, {}, () => new Date(`${d}T07:00:00Z`));
    const r1 = await engine.run(spec);
    expect(r1.status).toBe("waiting");
    expect(broker.placed).toHaveLength(0); // nothing leaves before approval
    services.runStore.setApproval(r1.runId, "approve", "approve");
    const orders = (await engine.resume(r1.runId)).output<OrderTicket[]>("execute", "orders");
    expect(orders.length).toBeGreaterThan(0);
    expect(orders.every((o) => o.status === "submitted" && o.ref.startsWith(`sa-${d}-DU7654321-`))).toBe(true);
    expect(broker.placed.map((p) => p.ref)).toEqual(orders.map((o) => o.ref));

    // same day, new run: whatever is proposed again must come back as duplicate, not be re-sent
    const r2 = await engine.run(spec);
    if (r2.status === "waiting") {
      services.runStore.setApproval(r2.runId, "approve", "approve");
      const again = (await engine.resume(r2.runId)).output<OrderTicket[]>("execute", "orders");
      for (const o of again) if (orders.some((x) => x.ref === o.ref)) expect(o.status).toBe("duplicate");
    }
    expect(new Set(broker.placed.map((p) => p.ref)).size).toBe(broker.placed.length);
  });

  it("does not send real orders when replaying a past date", async () => {
    const d = await tradingDay();
    const broker = new FakeBroker();
    const { spec, engine } = setup(broker, {}, () => new Date("2026-11-30T07:00:00Z"));
    spec.nodes["approve"]!.params["mode"] = "auto";
    const r = await engine.run(spec, { asOf: d });
    expect(r.nodes["execute"]?.status).toBe("failed");
    expect(r.nodes["execute"]?.error).toMatch(/only sends orders for today's run/);
    expect(broker.placed).toHaveLength(0);
  });

  it("refuses to trade a live-looking account in paper mode", async () => {
    const { spec, engine } = setup(new FakeBroker("U1234567"));
    const r = await engine.run(spec);
    expect(r.status).toBe("failed");
    expect(r.nodes["account"]?.error).toMatch(/looks like a live account/);
  });

  it("sends orders on some day of a dry-run replay", async () => {
    const broker = new FakeBroker();
    const { spec, engine } = setup(broker);
    spec.nodes["approve"]!.params["mode"] = "auto";
    spec.nodes["execute"]!.params["dryRun"] = true;
    let dry = 0;
    for (const d of weekdays("2026-06-01", "2026-10-30", 5)) {
      const r = await engine.run(spec, { asOf: d });
      expect(r.status).toBe("succeeded");
      dry += r.output<OrderTicket[]>("execute", "orders").filter((o) => o.status === "dry_run").length;
    }
    expect(dry).toBeGreaterThan(0);
    expect(broker.placed).toHaveLength(0);
  });
});
