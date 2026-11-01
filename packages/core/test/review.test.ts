import { copyFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { loadConfig } from "../src/config.ts";
import { builtinRegistry } from "../src/nodes/index.ts";
import { avgDollarVolume } from "../src/nodes/universe.ts";
import { Services } from "../src/services.ts";
import type { Bar, Prices } from "../src/signals/technical.ts";
import type { UniverseChanges } from "../src/universe/watchlist.ts";
import { watchlistHistory } from "../src/universe/watchlist.ts";
import { addDays, weekdays } from "../src/util/dates.ts";
import { Engine } from "../src/workflow/engine.ts";
import { defineNode } from "../src/workflow/registry.ts";
import { parseWorkflow } from "../src/workflow/spec.ts";

const ROOT = resolve(import.meta.dirname, "../../..");
const TODAY = "2026-11-06";
const bars = (n: number, close: number, volume: number): Bar[] =>
  weekdays(addDays(TODAY, -Math.ceil(n * 1.45)), TODAY).slice(-n).map((date) => ({ date, open: close, high: close + 1, low: close - 1, close, volume }));

const SEC = {
  fields: ["cik", "name", "ticker", "exchange"],
  data: [
    [1730168, "Broadcom Inc.", "AVGO", "Nasdaq"], [1535527, "CrowdStrike Holdings, Inc.", "CRWD", "Nasdaq"],
    [1327567, "Palo Alto Networks Inc", "PANW", "Nasdaq"], [1373715, "ServiceNow, Inc.", "NOW", "NYSE"],
    [1035267, "INTUITIVE SURGICAL INC", "ISRG", "Nasdaq"],
  ],
};

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "review-"));
  const configPath = join(dir, "config.yaml");
  copyFileSync(join(ROOT, "config/config.example.yaml"), configPath);
  const config = loadConfig(configPath);
  (config as { watchlist: unknown }).watchlist = {
    AAPL: { name: "Apple", aliases: [], sector: "tech" },
    TINY: { name: "Tiny Corp", aliases: [], sector: "tech" },
    NEWCO: { name: "Newco", aliases: [], sector: "consumer" },
  };
  const prices: Prices = { AAPL: bars(300, 200, 50_000_000), TINY: bars(300, 5, 100_000), NEWCO: bars(50, 30, 5_000_000), SPY: bars(300, 500, 80_000_000) };
  const td: Record<string, number> = { AVGO: 20_000_000, CRWD: 1_000, PANW: 10_000_000, NOW: 5_000_000, ISRG: 3_000_000 };
  const s = new Services(config, {
    fake: true, dbPath: ":memory:", configPath, sleep: async () => undefined,
    env: { SEC_USER_AGENT: "stockai me@example.com", TWELVEDATA_API_KEY: "k" },
    fetchImpl: async (u) => {
      const url = new URL(String(u));
      if (url.host === "www.sec.gov") return new Response(JSON.stringify(SEC));
      const sym = url.searchParams.get("symbol")!;
      const b = bars(30, 100, td[sym] ?? 0);
      return new Response(JSON.stringify({ status: "ok", values: b.map((x) => ({ datetime: x.date, open: "100", high: "101", low: "99", close: "100", volume: String(x.volume) })) }));
    },
  });
  const fixed = defineNode({
    type: "t.prices", title: "t", category: "data", description: "", version: 1, cache: "none",
    params: z.object({}), inputs: {}, outputs: { prices: { type: "Prices" } },
    async run() {
      return { prices };
    },
  });
  const clock = { now: new Date(`${TODAY}T22:30:00Z`) };
  const engine = new Engine({ services: s, registry: builtinRegistry().register(fixed), store: s.runStore, clock: () => clock.now });
  const spec = parseWorkflow(`name: universe-review
nodes:
  prices: { use: t.prices }
  review: { use: universe.review, in: { prices: prices }, params: { addCount: 3 } }
  apply:  { use: universe.apply, in: { changes: review } }
`);
  return { s, engine, spec, configPath, clock };
}

describe("universe review", () => {
  it("averages traded value over recent sessions", () => {
    expect(avgDollarVolume(bars(30, 10, 1_000))).toBe(10_000);
    expect(avgDollarVolume(bars(5, 10, 1_000))).toBeNull();
  });

  it("proposes verified, liquid additions and removals with reasons, waits for approval, then edits config.yaml", async () => {
    const { s, engine, spec, configPath, clock } = setup();
    const r = await engine.run(spec);
    expect(r.status).toBe("waiting");
    const c = r.output<UniverseChanges>("review", "changes");
    expect(c.add.map((a) => a.ticker)).toEqual(["AVGO", "PANW", "NOW"]); // CRWD: too little volume; AMD: not on the SEC list
    expect(c.add[0]!.listing).toMatchObject({ exchange: "Nasdaq" });
    expect(c.notes.join("\n")).toMatch(/CRWD: 売買代金が少ない/);
    expect(c.notes.join("\n")).toMatch(/AMD/);
    const removed = Object.fromEntries(c.remove.map((x) => [x.ticker, x.reasons.join(" ")]));
    expect(Object.keys(removed).sort()).toEqual(["NEWCO", "TINY"]);
    expect(removed["TINY"]).toMatch(/売買代金が少ない/);
    expect(removed["NEWCO"]).toMatch(/履歴が 50 日/);
    expect(readFileSync(configPath, "utf8")).not.toContain("AVGO"); // nothing changes before approval

    s.runStore.setApproval(r.runId, "apply", "approve", "");
    const done = await engine.resume(r.runId);
    expect(done.status).toBe("succeeded");
    expect(Object.keys(loadConfig(configPath).watchlist).sort()).toEqual(["AAPL", "AVGO", "NOW", "PANW"]);
    expect(s.watchlist.tickers).toContain("AVGO");
    expect(watchlistHistory(s)[0]).toMatchObject({ source: "review", removed: [{ ticker: "TINY" }, { ticker: "NEWCO" }] });

    clock.now = new Date(`${addDays(TODAY, 7)}T22:30:00Z`); // a week later: too soon for another review
    const again = await engine.run(spec);
    expect(again.output<UniverseChanges>("review", "changes").skipped).toMatch(/28 日/);
    expect(again.status).toBe("succeeded");
  });

  it("a rejected review changes nothing; replays never review", async () => {
    const { s, engine, spec, configPath } = setup();
    const before = readFileSync(configPath, "utf8");
    const r = await engine.run(spec);
    s.runStore.setApproval(r.runId, "apply", "reject", "");
    expect((await engine.resume(r.runId)).status).toBe("succeeded");
    expect(readFileSync(configPath, "utf8")).toBe(before);
    const past = await engine.run(spec, { asOf: "2026-06-01" });
    expect(past.output<UniverseChanges>("review", "changes").skipped).toMatch(/再生/);
  });
});
