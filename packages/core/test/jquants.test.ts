import { describe, expect, it } from "vitest";
import { JQuantsAuthError, jquantsClient, jquantsPrices, parseJQuantsBars, type JQuantsRow } from "../src/nodes/data.ts";

const row = (date: string, close: number | null): JQuantsRow => ({ Date: date, AdjO: close, AdjH: close, AdjL: close, AdjC: close, AdjVo: close === null ? null : 100 });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

function fakeFetch(responses: Response[]) {
  const urls: URL[] = [];
  const keys: (string | null)[] = [];
  const impl = (async (input: URL, init: RequestInit) => {
    urls.push(input);
    keys.push(new Headers(init.headers).get("x-api-key"));
    return responses.shift() ?? json({ data: [] });
  }) as unknown as typeof fetch;
  return { impl, urls, keys };
}

function clientWith(responses: Response[], requestsPerMinute = 5) {
  const f = fakeFetch(responses);
  const slept: number[] = [];
  const client = jquantsClient({ apiKey: "secret-key", requestsPerMinute, fetchImpl: f.impl, sleep: async (ms) => void slept.push(ms) });
  return { client, slept, ...f };
}

describe("parseJQuantsBars", () => {
  it("uses adjusted prices, sorts, and drops days without trades", () => {
    const bars = parseJQuantsBars([row("2026-10-02", 110), row("2026-10-01", 100), row("2026-10-05", null)]);
    expect(bars.map((b) => [b.date, b.close])).toEqual([["2026-10-01", 100], ["2026-10-02", 110]]);
  });
});

describe("jquantsClient", () => {
  it("sends the key and follows pagination", async () => {
    const c = clientWith([json({ data: [row("2026-10-01", 100)], pagination_key: "next" }), json({ data: [row("2026-10-02", 110)] })]);
    expect((await c.client.bars("7203")).length).toBe(2);
    expect(c.keys).toEqual(["secret-key", "secret-key"]);
    expect(c.urls[0]!.searchParams.get("code")).toBe("7203");
    expect(c.urls[1]!.searchParams.get("pagination_key")).toBe("next");
  });

  it("spaces requests below the plan limit, across tickers", async () => {
    const c = clientWith([json({ data: [] }), json({ data: [] }), json({ data: [] })]);
    await c.client.bars("7203");
    await c.client.bars("7267");
    await c.client.bars("6758");
    expect(c.slept.length).toBe(2);
    for (const ms of c.slept) expect(ms).toBeGreaterThan(12_000); // 5/min
  });

  it("waits and retries on 429, then gives up", async () => {
    const ok = clientWith([json({}, 429), json({ data: [row("2026-10-01", 100)] })]);
    expect((await ok.client.bars("7203")).length).toBe(1);
    expect(ok.slept).toContain(120_000);
    const bad = clientWith([json({}, 429), json({}, 429), json({}, 429)]);
    await expect(bad.client.bars("7203")).rejects.toThrow("HTTP 429");
  });

  it("reports a rejected key as an auth error without leaking it", async () => {
    const c = clientWith([json({}, 403)]);
    const err = await c.client.bars("7203").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(JQuantsAuthError);
    expect((err as Error).message).not.toContain("secret-key");
  });
});

describe("data.pricesJQuants", () => {
  const ctx = (env: NodeJS.ProcessEnv) => ({
    asOf: "2026-11-02",
    log: () => {},
    services: { env, config: { market: { benchmark: undefined } }, watchlist: { tickers: ["7203"] }, heldTickers: () => ({}) },
  });

  it("refuses to run without a key", async () => {
    await expect(jquantsPrices.run(ctx({}) as never, { requestsPerMinute: 5, maxStaleDays: 7 }, {} as never)).rejects.toThrow("JQUANTS_API_KEY");
  });

  it("fails on prices older than maxStaleDays (Free plan delay)", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = fakeFetch([json({ data: [row("2026-08-07", 100)] })]).impl;
    try {
      await expect(jquantsPrices.run(ctx({ JQUANTS_API_KEY: "k" }) as never, { requestsPerMinute: 5, maxStaleDays: 7 }, {} as never)).rejects.toThrow("Free plan");
    } finally {
      globalThis.fetch = original;
    }
  });

  it("accepts recent prices", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = fakeFetch([json({ data: [row("2026-10-30", 100)] })]).impl;
    try {
      const out = await jquantsPrices.run(ctx({ JQUANTS_API_KEY: "k" }) as never, { requestsPerMinute: 5, maxStaleDays: 7 }, {} as never);
      expect(out.prices["7203"]!.length).toBe(1);
    } finally {
      globalThis.fetch = original;
    }
  });
});
