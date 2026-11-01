import { copyFileSync, existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { AppConfig, loadConfig } from "../src/config.ts";
import { discordPayload, isDiscordWebhookUrl, sendDiscord } from "../src/notify/discord.ts";
import { Services } from "../src/services.ts";
import { backupDue, backupStatus, runBackup, selectKept, type BackupFile } from "../src/util/backup.ts";
import { editableConfigPath, saveWatchlist } from "../src/util/configFile.ts";
import { openDb } from "../src/util/db.ts";
import { SettingsStore } from "../src/util/settings.ts";
import { Engine } from "../src/workflow/engine.ts";
import { defineNode, NodeRegistry } from "../src/workflow/registry.ts";
import { parseWorkflow } from "../src/workflow/spec.ts";

const ROOT = resolve(import.meta.dirname, "../../..");
const HOOK = "https://discord.com/api/webhooks/123456789/abcDEF_ghi-jkl";
const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));

describe("Discord", () => {
  it("accepts only Discord webhook URLs", () => {
    expect(isDiscordWebhookUrl(HOOK)).toBe(true);
    expect(isDiscordWebhookUrl("https://discordapp.com/api/webhooks/1/x")).toBe(true);
    expect(isDiscordWebhookUrl("https://evil.example/api/webhooks/1/x")).toBe(false);
    expect(isDiscordWebhookUrl("http://discord.com/api/webhooks/1/x")).toBe(false);
  });

  it("never allows mentions and stays within Discord's limits", () => {
    const p = discordPayload({
      title: "x".repeat(400), description: "@everyone " + "d".repeat(5000), tone: "fail",
      fields: Array.from({ length: 40 }, (_, i) => ({ name: `f${i}`, value: "v".repeat(2000) })),
    }) as { allowed_mentions: { parse: string[] }; embeds: Array<{ title: string; description: string; fields: Array<{ value: string }> }> };
    expect(p.allowed_mentions).toEqual({ parse: [] });
    const e = p.embeds[0]!;
    expect(e.title.length).toBeLessThanOrEqual(256);
    expect(e.fields.length).toBeLessThanOrEqual(25);
    expect(e.fields.every((f) => f.value.length <= 1024)).toBe(true);
    expect(JSON.stringify(e).length).toBeLessThan(6500);
  });

  it("posts the embed, waits once on 429, and never puts the URL in errors", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    let n = 0;
    await sendDiscord(HOOK, { title: "t" }, {
      sleep: async () => undefined,
      fetchImpl: async (u, init) => {
        calls.push({ url: String(u), body: JSON.parse(String(init?.body)) });
        return n++ === 0 ? new Response(JSON.stringify({ retry_after: 1.5 }), { status: 429 }) : new Response(null, { status: 204 });
      },
    });
    expect(calls).toHaveLength(2);
    expect((calls[1]!.body as { embeds: Array<{ title: string }> }).embeds[0]!.title).toBe("t");
    const err = await sendDiscord(HOOK, { title: "t" }, { fetchImpl: async () => new Response("Unknown Webhook", { status: 404 }) }).catch((e: Error) => e.message);
    expect(err).toMatch(/404/);
    expect(err).not.toContain("abcDEF");
    await expect(sendDiscord("https://example.com/x", { title: "t" })).rejects.toThrow(/not a Discord webhook/);
  });

  it("the settings store rejects a mistyped webhook URL when saving", () => {
    const st = new SettingsStore({ path: ":memory:", env: {}, shellKeys: new Set() });
    expect(() => st.set("DISCORD_WEBHOOK_URL", "https://discord.com/channels/1/2")).toThrow(/ウェブフック/);
    st.set("DISCORD_WEBHOOK_URL", HOOK);
  });
});

describe("backups", () => {
  const cfg = (dir: string, over: Record<string, unknown> = {}) => AppConfig.parse({ watchlist: {}, dataDir: dir, backup: { dir: join(dir, "b"), ...over } });

  it("writes a consistent, restorable copy with mode 600", () => {
    const dir = tmp("bk-");
    const db = openDb(join(dir, "stockai.sqlite"));
    db.exec("CREATE TABLE t (x INT); INSERT INTO t VALUES (42);");
    const f = runBackup(cfg(dir), db, undefined, new Date(2026, 10, 3, 12, 31, 5));
    expect(f.name).toBe("stockai-20261103-123105.sqlite");
    const copy = new DatabaseSync(f.file);
    expect(copy.prepare("SELECT x FROM t").get()).toEqual({ x: 42 });
    copy.close();
    if (process.platform !== "win32") expect(statSync(f.file).mode & 0o777).toBe(0o600);
    expect(existsSync(join(dir, "b", "settings-20261103-123105.sqlite"))).toBe(false); // keys are not copied by default
  });

  it("copies settings only when asked", () => {
    const dir = tmp("bk-");
    const settings = new SettingsStore({ path: join(dir, "settings.sqlite"), env: {}, shellKeys: new Set() });
    runBackup(cfg(dir, { includeSettings: true }), openDb(join(dir, "s.sqlite")), settings, new Date(2026, 10, 3, 13, 0, 0));
    expect(existsSync(join(dir, "b", "settings-20261103-130000.sqlite"))).toBe(true);
  });

  it("is due once a day after the configured time", () => {
    const dir = tmp("bk-");
    const c = cfg(dir, { at: "12:30" });
    expect(backupDue(c, new Date(2026, 10, 3, 12, 0))).toBe(false);
    expect(backupDue(c, new Date(2026, 10, 3, 12, 45))).toBe(true);
    runBackup(c, openDb(join(dir, "x.sqlite")), undefined, new Date(2026, 10, 3, 12, 45));
    expect(backupDue(c, new Date(2026, 10, 3, 18, 0))).toBe(false);
    expect(backupDue(c, new Date(2026, 10, 4, 12, 31))).toBe(true);
    expect(backupStatus(c, new Date(2026, 10, 3, 18, 0))).toMatchObject({ count: 1, doneToday: true });
    expect(backupDue(cfg(dir, { enabled: false }), new Date(2026, 10, 4, 13, 0))).toBe(false);
  });

  it("keeps the newest per day for N days and per month for M months", () => {
    const f = (at: string): BackupFile => ({ file: at, name: at, at, size: 1 });
    const files = [
      f("2026-08-31T12:00:00"), f("2026-09-15T12:00:00"), f("2026-09-30T12:00:00"),
      f("2026-10-30T12:00:00"), f("2026-10-31T09:00:00"), f("2026-10-31T12:00:00"), f("2026-11-01T12:00:00"),
    ];
    const keep = selectKept(files, 2, 3);
    expect([...keep].sort()).toEqual(["2026-09-30T12:00:00", "2026-10-31T12:00:00", "2026-11-01T12:00:00"]);
  });
});

describe("config file edits", () => {
  function copyConfig(name = "config.yaml"): string {
    const dir = tmp("cfg-");
    const p = join(dir, name);
    copyFileSync(join(ROOT, "config/config.jp.example.yaml"), p);
    return p;
  }

  it("replaces the watchlist and keeps comments and every other setting", () => {
    const p = copyConfig();
    const before = readFileSync(p, "utf8");
    const r = saveWatchlist(p, { "7203": { name: "トヨタ自動車", aliases: ["トヨタ"], sector: "auto" }, "8035": { name: "東京エレクトロン", sector: "semis" } }, "1306");
    const after = readFileSync(p, "utf8");
    expect(r.created).toBe(false);
    expect(after).toContain("# H5: hard daily cap for all LLM calls");
    expect(after).toContain('"8035": { name: 東京エレクトロン, sector: semis }');
    expect(after).not.toContain("6758");
    expect(readFileSync(`${p}.bak`, "utf8")).toBe(before);
    const cfg = loadConfig(p);
    expect(Object.keys(cfg.watchlist)).toEqual(["7203", "8035"]); // ticker stays a string
    expect(cfg.harness.dailyBudgetUsd).toBe(0.5);
  });

  it("never edits an example file: config.yaml is created next to it", () => {
    const ex = copyConfig("config.example.yaml");
    const before = readFileSync(ex, "utf8");
    expect(editableConfigPath(ex)).toBe(join(ex, "..", "config.yaml"));
    const r = saveWatchlist(ex, { AAPL: { name: "Apple", sector: "tech" } });
    expect(r.created).toBe(true);
    expect(readFileSync(ex, "utf8")).toBe(before);
    expect(Object.keys(loadConfig(r.file).watchlist)).toEqual(["AAPL"]);
    expect(() => saveWatchlist(ex, { MSFT: { name: "Microsoft" } })).toThrow(/restart the server/);
  });

  it("rejects bad tickers and empty names without touching the file", () => {
    const p = copyConfig();
    const before = readFileSync(p, "utf8");
    expect(() => saveWatchlist(p, { "aapl!": { name: "x" } })).toThrow();
    expect(() => saveWatchlist(p, { AAPL: { name: " " } })).toThrow();
    expect(() => saveWatchlist(p, { AAPL: { name: "Apple" } }, "bad bench")).toThrow(/benchmark/);
    expect(readFileSync(p, "utf8")).toBe(before);
  });
});

describe("node cache and config changes", () => {
  it("a watchlist edit invalidates cached node results", async () => {
    let calls = 0;
    const node = defineNode({
      type: "t.tickers", title: "t", category: "data", description: "", version: 1, cache: "daily",
      params: z.object({}), inputs: {}, outputs: { n: { type: "Count" } },
      async run(ctx) {
        calls++;
        return { n: ctx.services.watchlist.tickers.length };
      },
    });
    const s = new Services(AppConfig.parse({ watchlist: { AAPL: { name: "Apple" } } }), { dbPath: ":memory:" });
    const engine = new Engine({ services: s, registry: new NodeRegistry().register(node), store: s.runStore });
    const spec = parseWorkflow("name: t\nnodes:\n  a: { use: t.tickers }\n");
    await engine.run(spec, { asOf: "2026-11-02" });
    expect((await engine.run(spec, { asOf: "2026-11-02" })).nodes["a"]?.status).toBe("cached");
    s.updateWatchlist({ AAPL: { name: "Apple", aliases: [], sector: "tech" }, MSFT: { name: "Microsoft", aliases: [], sector: "tech" } });
    const r = await engine.run(spec, { asOf: "2026-11-02" });
    expect(r.nodes["a"]?.status).toBe("ok");
    expect(r.output<number>("a", "n")).toBe(2);
    expect(calls).toBe(2);
  });
});

it("example configs still load", () => {
  for (const f of ["config/config.example.yaml", "config/config.jp.example.yaml"]) expect(() => loadConfig(join(ROOT, f))).not.toThrow();
});

describe("held positions outside the watchlist", () => {
  it("keep getting prices and factors (stops, valuation) but are never bought again", async () => {
    const { builtinRegistry } = await import("../src/nodes/index.ts");
    const s = new Services(AppConfig.parse({ market: { currency: "USD", benchmark: "SPY" }, watchlist: { AAPL: { name: "Apple", sector: "tech" } }, risk: { lotSize: 1 } }), { fake: true, dbPath: ":memory:" });
    s.paperBook.ensure("p", 100_000, "USD");
    s.db.prepare("INSERT INTO paper_positions VALUES (?,?,?,?,?,?,?)").run("p", "MSFT", 10, 400, 410, "tech", "2026-06-01");
    expect(s.heldTickers()).toEqual({ MSFT: "tech" });
    const engine = new Engine({ services: s, registry: builtinRegistry(), store: s.runStore });
    const spec = parseWorkflow(`name: t
nodes:
  prices:  { use: data.pricesSynthetic, params: { seed: 1 } }
  factors: { use: signal.factors, in: { prices: prices } }
  account: { use: portfolio.account, params: { account: p }, in: { prices: prices } }
  decide:  { use: decide.rules, in: { scores: score, factors: factors } }
  score:   { use: signal.score, in: { factors: factors } }
  propose: { use: portfolio.propose, in: { judgments: decide, factors: factors, account: account } }
`);
    const r = await engine.run(spec, { asOf: "2026-10-30" });
    expect(Object.keys(r.output<Record<string, unknown>>("prices", "prices")).sort()).toEqual(["AAPL", "MSFT", "SPY"]);
    expect(r.output<{ rows: Record<string, { sector: string }> }>("factors", "factors").rows["MSFT"]?.sector).toBe("tech");
    const proposals = r.output<Array<{ action: string; ticker: string; price: number }>>("propose", "proposals");
    expect(proposals.some((x) => x.action === "buy" && x.ticker === "MSFT")).toBe(false);
    for (const x of proposals.filter((y) => y.ticker === "MSFT")) expect(x.price).not.toBe(400); // priced at the market, not the entry
  });
});
