import { copyFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.ts";
import { marketOfTicker, marketProfile } from "../src/markets.ts";
import { builtinRegistry } from "../src/nodes/index.ts";
import { Services } from "../src/services.ts";
import { saveWatchlist } from "../src/util/configFile.ts";
import { Engine } from "../src/workflow/engine.ts";
import { parseWorkflow } from "../src/workflow/spec.ts";

const ROOT = resolve(import.meta.dirname, "../../..");

function jpConfigCopy(): string {
  const p = join(mkdtempSync(join(tmpdir(), "stockai-mkt-")), "config.yaml");
  copyFileSync(join(ROOT, "config/config.jp.example.yaml"), p);
  return p;
}

describe("markets", () => {
  it("tells Japanese codes from US tickers", () => {
    expect(["7203", "130A", "8035"].map(marketOfTicker)).toEqual(["jp", "jp", "jp"]);
    expect(["AAPL", "BRK.B", "SPY", "T", "ABCDE"].map(marketOfTicker)).toEqual(["us", "us", "us", "us", "us"]);
  });

  it("settings per market: markets.<id>, else the legacy block for the default market, else defaults", () => {
    const legacyJp = { market: { currency: "JPY" as const, benchmark: "1306" }, risk: { lotSize: 100 } };
    expect(marketProfile(legacyJp, "jp")).toMatchObject({ currency: "JPY", benchmark: "1306", lotSize: 100 });
    expect(marketProfile(legacyJp, "us")).toMatchObject({ currency: "USD", benchmark: "SPY", lotSize: 1 });
    const legacyUs = { market: { currency: "USD" as const, benchmark: "QQQ" }, risk: { lotSize: 1 } };
    expect(marketProfile(legacyUs, "us")).toMatchObject({ benchmark: "QQQ", lotSize: 1 });
    expect(marketProfile(legacyUs, "jp")).toMatchObject({ benchmark: "1306", lotSize: 100 });
    expect(marketProfile({ ...legacyUs, markets: { jp: { benchmark: "1321", lotSize: 1 } } }, "jp")).toMatchObject({ benchmark: "1321", lotSize: 1 });
  });

  it("a mixed watchlist: each workflow sees only its market's stocks, benchmark and lot size", async () => {
    const cfg = loadConfig(join(ROOT, "config/config.jp.example.yaml"));
    cfg.watchlist["AAPL"] = { name: "Apple", aliases: [], sector: "tech" };
    const s = new Services(cfg, { fake: true, dbPath: ":memory:" });
    expect(s.watchlistFor("us").tickers).toEqual(["AAPL"]);
    expect(s.watchlistFor("jp").tickers).toContain("7203");
    expect(s.watchlistFor("jp").tickers).not.toContain("AAPL");
    expect(s.activeMarkets()).toEqual(["jp", "us"]);

    const engine = new Engine({ services: s, registry: builtinRegistry(), store: s.runStore });
    // no market-specific node: the default market (Japanese here)
    const neutral = await engine.run(parseWorkflow("name: n\nnodes:\n  p: { use: data.pricesSynthetic }\n"), { asOf: "2026-06-01" });
    const jp = Object.keys(neutral.output<Record<string, unknown>>("p", "prices"));
    expect(jp).toContain("7203");
    expect(jp).toContain("1306");
    expect(jp).not.toContain("AAPL");
    // a US node in the workflow makes it a US workflow: US stocks and the US benchmark only
    const us = await engine.run(parseWorkflow("name: u\nnodes:\n  p: { use: data.pricesSynthetic }\n  i: { use: data.insider }\n"), { asOf: "2026-06-01" });
    expect(Object.keys(us.output<Record<string, unknown>>("p", "prices")).sort()).toEqual(["AAPL", "SPY"]);
  });

  it("saves a market only when the code does not tell, and a benchmark per market", () => {
    const p = jpConfigCopy();
    saveWatchlist(p, {
      "7203": { name: "トヨタ自動車", sector: "auto" },
      AAPL: { name: "Apple", sector: "tech", market: "us" },
      TM: { name: "Toyota ADR", sector: "auto", market: "jp" }, // odd on purpose: kept because it differs from the code
    }, undefined, { us: "QQQ", jp: "1321" });
    const text = readFileSync(p, "utf8");
    expect(text).toContain("AAPL: { name: Apple, sector: tech }");
    expect(text).toContain("TM: { name: Toyota ADR, sector: auto, market: jp }");
    const cfg = loadConfig(p);
    expect(cfg.market.benchmark).toBe("1321"); // the default market keeps its old place
    expect(cfg.markets?.us?.benchmark).toBe("QQQ");
    const s = new Services(cfg, { fake: true, dbPath: ":memory:" });
    expect(s.marketOf("TM")).toBe("jp");
    expect(s.market("us").benchmark).toBe("QQQ");
    // clearing the US benchmark falls back to the default
    saveWatchlist(p, cfg.watchlist, undefined, { us: "" });
    expect(new Services(loadConfig(p), { fake: true, dbPath: ":memory:" }).market("us").benchmark).toBe("SPY");
  });
});
