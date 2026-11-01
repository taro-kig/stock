import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.ts";
import type { OrderTicket } from "../src/execution/broker.ts";
import { LIVE_ENV_VALUE, LIVE_ENV_VAR } from "../src/execution/guards.ts";
import { asList, clientOrderId, collectClientOrderIds, signRequest, strictEncode, WebullApiError, WebullAuthRequired, WebullClient, WebullConfig } from "../src/execution/webull.ts";
import { builtinRegistry } from "../src/nodes/index.ts";
import { Services } from "../src/services.ts";
import { weekdays } from "../src/util/dates.ts";
import { Engine } from "../src/workflow/engine.ts";
import { loadWorkflow } from "../src/workflow/spec.ts";

// Vectors from an independent stdlib-only re-implementation of the official SDK's
// default_signature_composer.py (see docs/webull.md).
const COMMON = { host: "api.webull.co.jp", appKey: "test-app-key", appSecret: "test-secret", timestamp: "2026-11-02T07:30:00Z", nonce: "0b2f6a2e-1111-4c3b-9d7e-abcdefabcdef" };

describe("Webull signing", () => {
  it("matches the reference for a GET with query", () => {
    const r = signRequest({ ...COMMON, path: "/trading/assets/balances/get", query: { account_id: "ACC123", total_asset_currency: "JPY" } });
    expect(r.toSign).toBe(
      "%2Ftrading%2Fassets%2Fbalances%2Fget%26account_id%3DACC123%26host%3Dapi.webull.co.jp%26total_asset_currency%3DJPY%26x-app-key%3Dtest-app-key%26x-signature-algorithm%3DHMAC-SHA256%26x-signature-nonce%3D0b2f6a2e-1111-4c3b-9d7e-abcdefabcdef%26x-signature-version%3D1.0%26x-timestamp%3D2026-11-02T07%3A30%3A00Z",
    );
    expect(r.headers["x-signature"]).toBe("MgxQ9cp0UaLU2WnyZZR/LPY82wmtaqSIDGYz2OwXzYI=");
  });

  it("matches the reference for a POST with a (Japanese) JSON body", () => {
    const body = { account_id: "ACC123", new_orders: [{ combo_type: "NORMAL", client_order_id: "abc", symbol: "7203", limit_price: "3004", quantity: "100", note: "トヨタ" }] };
    const r = signRequest({ ...COMMON, path: "/trading/orders/place", bodyText: JSON.stringify(body) });
    expect(r.toSign.endsWith("%268CF2737E608FA624D9E5CB4E0177A4E7FD16290A6C55B29CCAFF2A639D722270")).toBe(true);
    expect(r.headers["x-signature"]).toBe("yBNazSJ7pVS8dulZtO+ckOOH1KGfdwyDyQfaIpaatxM=");
  });

  it("encodes like Python's quote(safe='')", () => {
    expect(strictEncode("a b/c:d&e=f!'()*~-._")).toBe("a%20b%2Fc%3Ad%26e%3Df%21%27%28%29%2A~-._");
  });

  it("derives stable 32-hex client order ids and finds them anywhere in a response", () => {
    expect(clientOrderId("sa-2026-11-02-WB1-7203-buy")).toMatch(/^[0-9a-f]{32}$/);
    expect(clientOrderId("x")).toBe(clientOrderId("x"));
    expect(collectClientOrderIds({ data: [{ client_order_id: "a", orders: [{ client_order_id: "b" }] }], pagination_key: "k" })).toEqual(["a", "b"]);
    expect(asList({ items: [1] }, "x")).toEqual([1]);
    expect(() => asList({ nope: 1 }, "x")).toThrow(/unexpected x/);
  });
});

/** A small in-memory stand-in for the Webull JP API (shapes per the official SDK/MCP server). */
function fakeWebull(opts: { tokenRequired?: boolean; approveAfterChecks?: number } = {}) {
  const st = {
    calls: [] as Array<{ method: string; path: string; query: Record<string, string>; body: unknown; headers: Record<string, string> }>,
    cash: 10_000_000,
    positions: [] as Array<{ symbol: string; quantity: number; cost_price: number }>,
    open: [] as string[],
    placed: [] as Array<Record<string, string>>,
    previews: 0,
    checks: 0,
  };
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(url));
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    st.calls.push({ method: init?.method ?? "GET", path: u.pathname, query: Object.fromEntries(u.searchParams), body, headers });
    const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
    if (!headers["x-signature"] || headers["x-version"] !== "v3") return json({ error_code: "SIGN" }, 401);
    const authed = !opts.tokenRequired || headers["x-access-token"] === "tok-1";
    switch (u.pathname) {
      case "/openapi/config":
        return json({ token_check_enabled: Boolean(opts.tokenRequired) });
      case "/auth/tokens/create":
        return json({ token: "tok-1", expires: 1893456000000, status: (body as { token?: string }).token === "tok-1" && st.checks >= (opts.approveAfterChecks ?? 0) ? "NORMAL" : "PENDING" });
      case "/auth/tokens/check":
        st.checks++;
        return json({ token: "tok-1", expires: 1893456000000, status: st.checks >= (opts.approveAfterChecks ?? 1) ? "NORMAL" : "PENDING" });
    }
    if (!authed) return json({ error_code: "TOKEN" }, 401);
    switch (u.pathname) {
      case "/trading/accounts/list":
        return json([{ account_id: "WB1", account_type: "CASH" }]);
      case "/trading/assets/balances/get": {
        const mv = st.positions.reduce((s, p) => s + p.quantity * p.cost_price, 0);
        return json({ total_asset_currency: "JPY", total_cash_balance: String(st.cash), total_market_value: String(mv), account_currency_assets: [] });
      }
      case "/trading/assets/positions/list":
        return json({ data: st.positions.map((p) => ({ symbol: p.symbol, quantity: String(p.quantity), cost_price: String(p.cost_price), instrument_type: "EQUITY" })) });
      case "/trading/orders/open-orders/list":
        return json({ data: st.open.map((c) => ({ client_order_id: c, status: "SUBMITTED" })) });
      case "/trading/orders/preview":
        st.previews++;
        return json({ estimated_amount: "1000", estimated_fee: "0" });
      case "/trading/orders/place": {
        const o = (body as { new_orders: Array<Record<string, string>> }).new_orders[0]!;
        if (st.open.includes(o["client_order_id"]!)) return json({ error_code: "DUPLICATE_CLIENT_ORDER_ID" }, 400);
        st.placed.push(o);
        st.open.push(o["client_order_id"]!);
        return json({ client_order_id: o["client_order_id"], order_id: "9007199254740993123" });
      }
    }
    return json({ error_code: "NOT_FOUND" }, 404);
  }) as typeof fetch;
  return { st, fetchImpl };
}

const ENV = { WEBULL_APP_KEY: "k", WEBULL_APP_SECRET: "s" };
const cfg = (over: Record<string, unknown> = {}) =>
  WebullConfig.parse({ accountTaxType: "SPECIFIC", tokenFile: join(mkdtempSync(join(tmpdir(), "wb-")), "token.json"), ...over });

describe("WebullClient", () => {
  it("refuses unattended runs until the token is approved, then uses it", async () => {
    const { st, fetchImpl } = fakeWebull({ tokenRequired: true, approveAfterChecks: 2 });
    const c = cfg();
    await expect(WebullClient.connect(c, { env: ENV, fetchImpl })).rejects.toBeInstanceOf(WebullAuthRequired);
    const interactive = new WebullClient(c, { env: ENV, fetchImpl, sleep: async () => {} });
    await interactive.ensureToken({ waitSeconds: 60 });
    expect(st.checks).toBe(2);
    expect(JSON.parse(readFileSync(c.tokenFile, "utf8")).status).toBe("NORMAL");
    expect(statSync(c.tokenFile).mode & 0o777).toBe(0o600);
    // next unattended start reuses the approved token
    const again = await WebullClient.connect(c, { env: ENV, fetchImpl });
    expect((await again.account()).accountId).toBe("WB1");
    expect(st.calls.at(-1)?.headers["x-access-token"]).toBe("tok-1");
  });

  it("parses balances and positions sent as strings, and fails closed on garbage", async () => {
    const { st, fetchImpl } = fakeWebull();
    st.positions.push({ symbol: "7203", quantity: 200, cost_price: 3012.5 });
    const c = await WebullClient.connect(cfg(), { env: ENV, fetchImpl });
    const a = await c.account();
    expect(a).toEqual({ accountId: "WB1", currency: "JPY", cash: 10_000_000, netLiquidation: 10_000_000 + 602_500, positions: [{ ticker: "7203", shares: 200, avgCost: 3012.5 }] });
    const bal = st.calls.find((x) => x.path === "/trading/assets/balances/get")!;
    expect(bal.query).toEqual({ account_id: "WB1", total_asset_currency: "JPY" });
    const bad = fakeWebull();
    bad.st.positions.push({ symbol: "7203", quantity: Number.NaN, cost_price: 1 });
    const c2 = await WebullClient.connect(cfg(), { env: ENV, fetchImpl: bad.fetchImpl });
    await expect(c2.account()).rejects.toThrow(/unexpected value for (quantity|total_market_value)/);
  });

  it("builds JP limit orders with string numbers, tax type and category header", async () => {
    const { st, fetchImpl } = fakeWebull();
    const c = await WebullClient.connect(cfg(), { env: ENV, fetchImpl });
    const id = await c.placeLimitOrder({ ref: "sa-2026-11-02-WB1-7203-buy", ticker: "7203", side: "buy", shares: 100, limitPrice: 3005, tif: "DAY" }, "WB1");
    expect(id).toBe("9007199254740993123"); // kept as a string: beyond Number's safe range
    const call = st.calls.find((x) => x.path === "/trading/orders/place")!;
    expect(call.headers["category"]).toBe("JP_EQUITY");
    expect(call.body).toEqual({
      account_id: "WB1",
      new_orders: [{
        combo_type: "NORMAL", client_order_id: clientOrderId("sa-2026-11-02-WB1-7203-buy"), symbol: "7203", instrument_type: "EQUITY", market: "JP",
        order_type: "LIMIT", limit_price: "3005", quantity: "100", support_trading_session: "CORE", side: "BUY", time_in_force: "DAY",
        entrust_type: "QTY", account_tax_type: "SPECIFIC",
      }],
    });
    await expect(c.placeLimitOrder({ ref: "sa-2026-11-02-WB1-7203-buy", ticker: "7203", side: "buy", shares: 100, limitPrice: 3005, tif: "DAY" }, "WB1")).rejects.toBeInstanceOf(WebullApiError);
    const noTax = await WebullClient.connect(cfg({ accountTaxType: undefined }), { env: ENV, fetchImpl });
    await expect(noTax.previewLimitOrder({ ref: "r", ticker: "7203", side: "buy", shares: 100, limitPrice: 1, tif: "DAY" }, "WB1")).rejects.toThrow(/accountTaxType/);
  });

  it("requires credentials", () => {
    expect(() => new WebullClient(cfg(), { env: {} })).toThrow(/WEBULL_APP_KEY/);
  });
});

const ROOT = resolve(import.meta.dirname, "../../..");

describe("Webull workflow", () => {
  const setup = (fake: ReturnType<typeof fakeWebull>, webull: Record<string, unknown>, env: Record<string, string>, clock: () => Date) => {
    const config = loadConfig(resolve(ROOT, "config/config.example.yaml"));
    config.webull = cfg({ maxOrderValue: 5_000_000, ...webull });
    const services = new Services(config, { fake: true, dbPath: ":memory:", env: { ...ENV, ...env }, brokerFactory: async () => WebullClient.connect(config.webull!, { env: { ...ENV, ...env }, fetchImpl: fake.fetchImpl }) });
    const spec = loadWorkflow(resolve(ROOT, "workflows/webull-jp.yaml"));
    spec.nodes["news"] = { ...spec.nodes["news"]!, use: "source.fixture", params: { path: resolve(ROOT, "examples/fixtures/news.json"), lookbackDays: 7 } };
    spec.nodes["prices"] = { ...spec.nodes["prices"]!, use: "data.pricesSynthetic", params: { seed: 6 } };
    spec.nodes["approve"]!.params["mode"] = "auto";
    return { services, spec, engine: new Engine({ services, registry: builtinRegistry(), store: services.runStore, clock }) };
  };

  async function tradingDay(): Promise<string> {
    for (const d of weekdays("2026-06-01", "2026-10-30")) {
      const fake = fakeWebull();
      const { spec, engine } = setup(fake, {}, {}, () => new Date(`${d}T07:00:00Z`));
      const r = await engine.run(spec);
      if (r.status === "succeeded" && r.output<OrderTicket[]>("execute", "orders").some((o) => o.side === "buy")) return d;
    }
    throw new Error("no trading day");
  }

  it("dry_run (default) only previews; live needs the interlock and sends each order once", async () => {
    const d = await tradingDay();
    const clock = () => new Date(`${d}T07:00:00Z`);

    const dry = fakeWebull();
    const r0 = await setup(dry, {}, {}, clock).engine.run(setup(dry, {}, {}, clock).spec);
    expect(r0.output<OrderTicket[]>("execute", "orders").every((o) => o.status === "dry_run" && o.message.includes("preview ok"))).toBe(true);
    expect(dry.st.previews).toBeGreaterThan(0);
    expect(dry.st.placed).toHaveLength(0);

    const live = fakeWebull();
    const noLock = setup(live, { trading: "live", accountId: "WB1" }, {}, clock);
    const r1 = await noLock.engine.run(noLock.spec);
    expect(r1.nodes["account"]?.error).toMatch(new RegExp(LIVE_ENV_VAR));
    expect(live.st.placed).toHaveLength(0);

    const ok = setup(live, { trading: "live", accountId: "WB1" }, { [LIVE_ENV_VAR]: LIVE_ENV_VALUE }, clock);
    const r2 = await ok.engine.run(ok.spec);
    const sent = r2.output<OrderTicket[]>("execute", "orders").filter((o) => o.status === "submitted");
    expect(sent.length).toBeGreaterThan(0);
    expect(sent[0]?.brokerOrderId).toBe("9007199254740993123");
    expect(live.st.placed).toHaveLength(sent.length);
    // a second run the same day: the ledger and Webull's open orders both say "already sent"
    const r3 = await ok.engine.run(ok.spec);
    expect(r3.output<OrderTicket[]>("execute", "orders").filter((o) => o.status === "submitted")).toHaveLength(0);
    expect(live.st.placed).toHaveLength(sent.length);
  });

  it("does not create a token file when the API does not require tokens", () => {
    const c = cfg();
    expect(existsSync(c.tokenFile)).toBe(false);
  });
});
