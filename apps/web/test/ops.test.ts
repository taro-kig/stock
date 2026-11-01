import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { builtinRegistry, loadConfig, Services } from "@stockai/core";
import type { WatchlistView } from "../shared/types.ts";
import { createApp, type App } from "../server/app.ts";

const ROOT = resolve(import.meta.dirname, "../../..");
const HOOK = "https://discord.com/api/webhooks/1/token_abc";

let app: App | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function start(opts: { webhook?: boolean; gate?: "auto" | "manual"; events?: string[] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "stockai-ops-"));
  const wf = join(dir, "wf");
  const cfgPath = join(dir, "config.yaml");
  copyFileSync(join(ROOT, "config/config.jp.example.yaml"), cfgPath);
  const { mkdirSync } = await import("node:fs");
  mkdirSync(wf);
  for (const name of ["demo-ai"]) {
    writeFileSync(join(wf, `${name}.yaml`), readFileSync(join(ROOT, "workflows", `${name}.yaml`), "utf8")
      .replace("examples/fixtures/news.json", join(ROOT, "examples/fixtures/news.json"))
      .replace("mode: auto", `mode: ${opts.gate ?? "auto"}`));
  }
  const config = loadConfig(cfgPath);
  (config.backup as { dir?: string }).dir = join(dir, "backups");
  if (opts.events) (config.notify as { events: string[] }).events = opts.events;
  const posts: Array<{ embeds: Array<{ title: string; description?: string; url?: string; fields?: Array<{ name: string; value: string }> }> }> = [];
  const services = new Services(config, {
    fake: true, dbPath: ":memory:", env: opts.webhook ? { DISCORD_WEBHOOK_URL: HOOK } : {},
    fetchImpl: async (url, init) => {
      if (String(url) !== HOOK) throw new Error(`unexpected fetch ${String(url)}`);
      posts.push(JSON.parse(String(init?.body)));
      return new Response(null, { status: 204 });
    },
  });
  app = createApp({ services, registry: builtinRegistry(), workflowsDir: wf, configPath: cfgPath });
  await new Promise<void>((r) => app!.server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  const call = async <T>(method: string, path: string, body?: unknown) => {
    const res = await fetch(base + path, { method, headers: { "content-type": "application/json" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
    return { status: res.status, body: (await res.json()) as T };
  };
  const settle = async () => {
    await app!.queue.idle();
    await new Promise((r) => setTimeout(r, 20)); // notifications run right after the queue
  };
  return { app, services, posts, call, settle, cfgPath, dir };
}

describe("Discord notifications", () => {
  it("announces a pending approval once (timeout checks do not repeat it), with a link and the orders", async () => {
    const { posts, call, settle, app: a } = await start({ webhook: true, gate: "manual" });
    let waiting: string | undefined;
    for (const d of ["2026-07-20", "2026-07-21", "2026-07-22", "2026-08-03", "2026-08-10"]) {
      const { body } = await call<{ runId: string }>("POST", "/api/workflows/demo-ai/run", { asOf: d });
      await settle();
      if ((await call<{ run: { status: string } }>("GET", `/api/runs/${body.runId}`)).body.run.status === "waiting") {
        waiting = body.runId;
        break;
      }
    }
    expect(waiting).toBeDefined();
    const approvals = posts.filter((p) => p.embeds[0]!.title.startsWith("⏳"));
    expect(approvals).toHaveLength(1);
    expect(approvals[0]!.embeds[0]!.url).toBe(`http://127.0.0.1:4317/#/approvals/${waiting}`);
    expect(approvals[0]!.embeds[0]!.fields!.length).toBeGreaterThan(0);
    a.sweepWaiting(0); // resumes waiting runs (still waiting: timeout not reached)
    await settle();
    expect(posts.filter((p) => p.embeds[0]!.title.startsWith("⏳"))).toHaveLength(1);
  });

  it("stays silent without a webhook, and the test button reports what is wrong", async () => {
    const { posts, call, settle } = await start({ webhook: false, events: ["success", "approval", "failure"] });
    await call("POST", "/api/workflows/demo-ai/run", { asOf: "2026-07-21" });
    await settle();
    expect(posts).toHaveLength(0);
    const t = await call<{ error: string }>("POST", "/api/notify/test", {});
    expect(t.status).toBe(400);
    expect(t.body.error).toMatch(/DISCORD_WEBHOOK_URL/);
  });

  it("sends the test notice and success notices when enabled", async () => {
    const { posts, call, settle } = await start({ webhook: true, events: ["success", "fills"] });
    expect((await call("POST", "/api/notify/test", {})).status).toBe(200);
    expect(posts[0]!.embeds[0]!.title).toMatch(/テスト/);
    await call("POST", "/api/workflows/demo-ai/run", { asOf: "2026-07-21" });
    await settle();
    expect(posts.some((p) => p.embeds[0]!.title.startsWith("● 完了"))).toBe(true);
  });
});

describe("watchlist editing", () => {
  it("saves to the config file (comments kept) and applies at once", async () => {
    const { call, services, cfgPath } = await start();
    const view = (await call<WatchlistView>("GET", "/api/config/watchlist")).body;
    expect(view.file).toBe(cfgPath);
    expect(Object.keys(view.watchlist)).toContain("7203");
    const next = { ...view.watchlist, "8035": { name: "東京エレクトロン", aliases: ["TEL"], sector: "semis" } };
    delete (next as Record<string, unknown>)["9984"];
    const previous = Object.keys(view.watchlist);
    // a client that did not load the list (or loaded an older one) cannot overwrite it
    expect((await call("PUT", "/api/config/watchlist", { watchlist: { AAPL: { name: "Apple" } } })).status).toBe(409);
    expect((await call("PUT", "/api/config/watchlist", { watchlist: { AAPL: { name: "Apple" } }, previous: [] })).status).toBe(409);
    expect((await call("PUT", "/api/config/watchlist", { watchlist: {}, previous })).status).toBe(400);
    const r = await call<{ tickers: number }>("PUT", "/api/config/watchlist", { watchlist: next, benchmark: "1306", previous });
    expect(r.status).toBe(200);
    expect(services.watchlist.tickers).toContain("8035");
    expect(services.watchlist.tickers).not.toContain("9984");
    expect(readFileSync(cfgPath, "utf8")).toContain("# H5: hard daily cap");
    const after = Object.keys(next);
    const bad = await call<{ error: string }>("PUT", "/api/config/watchlist", { watchlist: { "bad ticker": { name: "x" } }, previous: after });
    expect(bad.status).toBe(400);
    expect(services.watchlist.tickers).toContain("8035");
  });
});

describe("backup API", () => {
  it("backs up on demand and reports status", async () => {
    const { call, dir } = await start();
    expect((await call<{ count: number }>("GET", "/api/backup")).body.count).toBe(0);
    const r = await call<{ file: { file: string } }>("POST", "/api/backup", {});
    expect(r.status).toBe(200);
    expect(r.body.file.file.startsWith(join(dir, "backups"))).toBe(true);
    expect((await call<{ count: number; doneToday: boolean }>("GET", "/api/backup")).body).toMatchObject({ count: 1, doneToday: true });
  });
});
