import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { builtinRegistry, loadConfig, Services } from "@stockai/core";
import type { WatchlistView } from "../shared/types.ts";
import { createApp, type App } from "../server/app.ts";
import { Scheduler } from "../server/scheduler.ts";

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

describe("AI ticker suggestions", () => {
  it("is offered for US configs only", async () => {
    const { call } = await start();
    const r = await call<{ error: string }>("POST", "/api/universe/suggest", { theme: "半導体", count: 5 });
    expect(r.status).toBe(400); // the test config is the Japanese one
    expect(r.body.error).toMatch(/USD/);
    expect((await call<{ currency: string }>("GET", "/api/config/watchlist")).body.currency).toBe("JPY");
    expect((await call("POST", "/api/universe/suggest", { theme: "x" })).status).toBe(400);
  });
});


describe("prompts API", () => {
  async function startUs() {
    const dir = mkdtempSync(join(tmpdir(), "stockai-prompts-"));
    const cfgPath = join(dir, "config.yaml");
    copyFileSync(join(ROOT, "config/config.example.yaml"), cfgPath);
    const wf = join(dir, "wf");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(wf);
    writeFileSync(join(wf, "pinned.yaml"), "name: pinned\nnodes:\n  p: { use: data.pricesSynthetic }\n  f: { use: signal.factors, in: { prices: p } }\n  s: { use: signal.score, in: { factors: f } }\n  d: { use: decide.ai, in: { factors: f, scores: s }, params: { promptVersion: judge-v2 } }\n");
    const config = loadConfig(cfgPath);
    (config as { promptsDir: string }).promptsDir = join(dir, "prompts");
    const services = new Services(config, { fake: true, dbPath: ":memory:", configPath: cfgPath });
    app = createApp({ services, registry: builtinRegistry(), workflowsDir: wf, configPath: cfgPath });
    await new Promise<void>((r) => app!.server.listen(0, "127.0.0.1", () => r()));
    const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    const call = async <T>(method: string, path: string, body?: unknown) => {
      const res = await fetch(base + path, { method, headers: { "content-type": "application/json" }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
      return { status: res.status, body: (await res.json()) as T };
    };
    return { call, services, cfgPath, dir };
  }
  type View = { families: Array<{ family: string; active: string; evaluable: boolean; versions: Array<{ version: string; usedBy: string[]; builtin: boolean }>; evals: Array<{ id: number; status: string; summary: Array<{ version: string; accuracy: number | null }> }> }>; switches: Array<{ from: string; to: string }> };

  it("lists versions with where they are used, creates a version, evaluates it and switches to it", async () => {
    const { call, services, cfgPath } = await startUs();
    let v = (await call<View>("GET", "/api/prompts")).body;
    const judge = v.families.find((f) => f.family === "judge")!;
    expect(judge.active).toBe("judge-v1");
    expect(judge.versions.find((x) => x.version === "judge-v1")!.usedBy).toEqual(["config"]);
    expect(judge.versions.find((x) => x.version === "judge-v2")!.usedBy).toEqual(["pinned"]);
    expect(v.families.find((f) => f.family === "universe")!.evaluable).toBe(false);

    const text = "あなたは慎重な運用担当者である。根拠が弱ければ neutral を選ぶ。".repeat(2);
    const created = await call<{ version: string; base: string }>("POST", "/api/prompts/event", { version: "event-us-v1-my1", parent: "event-us-v1", system: text, description: "test" });
    expect(created.status).toBe(201);
    expect(created.body.base).toBe("event-us-v1");
    expect((await call("POST", "/api/prompts/event", { version: "event-us-v1-my1", parent: "event-us-v1", system: text })).status).toBe(400);

    const ev = await call<{ id: number }>("POST", "/api/prompts/event/eval", { versions: ["event-us-v1", "event-us-v1-my1"], models: ["fake-a"], budgetUsd: 0.1 });
    expect(ev.status).toBe(202);
    await app!.queue.idle();
    v = (await call<View>("GET", "/api/prompts")).body;
    const job = v.families.find((f) => f.family === "event")!.evals[0]!;
    expect(job).toMatchObject({ id: ev.body.id, status: "done" });
    expect(job.summary.map((x) => x.version)).toEqual(["event-us-v1", "event-us-v1-my1"]);
    expect((await call<{ report: { rows: unknown[] } }>("GET", `/api/prompts/evals/${ev.body.id}`)).body.report.rows).toHaveLength(2);
    expect((await call("POST", "/api/prompts/universe/eval", { versions: ["universe-v1"] })).status).toBe(400);

    const sw = await call<{ changed: boolean }>("PUT", "/api/prompts/event/active", { version: "event-us-v1-my1" });
    expect(sw.body.changed).toBe(true);
    expect(services.config.prompts.event).toBe("event-us-v1-my1");
    expect(loadConfig(cfgPath).prompts.event).toBe("event-us-v1-my1");
    expect(readFileSync(cfgPath, "utf8")).toContain("# H5: hard daily cap");
    expect((await call<View>("GET", "/api/prompts")).body.switches[0]).toMatchObject({ from: "event-us-v1", to: "event-us-v1-my1" });
    expect((await call("PUT", "/api/prompts/event/active", { version: "event-nope" })).status).toBe(400);
  });
});

describe("calendar", () => {
  it("the scheduler skips US market holidays but not the weekend review", () => {
    const fired: string[] = [];
    const holiday = (d: string) => (d === "2026-11-26" ? "Thanksgiving Day" : null);
    const mk = (now: Date, skipHolidays?: boolean) =>
      new Scheduler([{ workflow: "w", file: "w.yaml", at: "06:40", days: [0, 1, 2, 3, 4, 5, 6], ...(skipHolidays === undefined ? {} : { skipHolidays }) }], {
        trigger: (f) => void fired.push(f), ranToday: () => null, holiday, clock: () => now,
      });
    // the run date is the UTC date of the firing time
    expect(mk(new Date("2026-11-26T21:45:00Z")).tick()).toEqual([]);
    expect(mk(new Date("2026-11-26T21:45:00Z"), false).tick()).toEqual(["w.yaml"]);
    expect(mk(new Date("2026-11-27T21:45:00Z")).tick()).toEqual(["w.yaml"]);
  });

  it("serves holidays, earnings, upcoming runs and past runs for a date range", async () => {
    const dir = mkdtempSync(join(tmpdir(), "stockai-cal-"));
    const cfgPath = join(dir, "config.yaml");
    copyFileSync(join(ROOT, "config/config.example.yaml"), cfgPath);
    const services = new Services(loadConfig(cfgPath), { fake: true, dbPath: ":memory:", configPath: cfgPath, env: {} });
    services.earnings.save("2026-11-20", [
      { ticker: "NVDA", reportDate: "2026-11-25", fiscalDateEnding: null, estimate: 0.9, time: "post-market" },
      { ticker: "ZZZZ", reportDate: "2026-11-25", fiscalDateEnding: null, estimate: null, time: null },
    ]);
    const wf = join(dir, "wf");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(wf);
    app = createApp({ services, registry: builtinRegistry(), workflowsDir: wf, configPath: cfgPath, clock: () => new Date(2026, 10, 20, 12, 0) });
    await new Promise<void>((r) => app!.server.listen(0, "127.0.0.1", () => r()));
    const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    const c = (await (await fetch(`${base}/api/calendar?from=2026-11-16&to=2026-12-31`)).json()) as {
      holidays: Array<{ date: string; name: string }>; earnings: Array<{ ticker: string; time: string; daysAway: number }>;
      schedule: Array<{ date: string; workflow: string; skipped: string | null }>; market: string;
    };
    expect(c.market).toBe("us");
    expect(c.holidays).toEqual([{ date: "2026-11-26", name: "感謝祭" }, { date: "2026-12-25", name: "クリスマス" }]);
    expect(c.earnings).toEqual([expect.objectContaining({ ticker: "NVDA", time: "post-market", daysAway: 5 })]); // ZZZZ is not watched
    expect(c.schedule.some((x) => x.workflow === "workflows/daily-ai.yaml" || x.workflow === "daily-ai")).toBe(true);
    expect((await fetch(`${base}/api/calendar?from=2026-01-01&to=2026-12-31`)).status).toBe(400);
  });
});
