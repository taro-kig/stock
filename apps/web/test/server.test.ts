import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { request } from "node:http";
import { builtinRegistry, loadConfig, Services, SettingsStore } from "@stockai/core";
import type { Overview, RunDetail, SettingsView, StreamEvent } from "../shared/types.ts";
import { createApp, type App } from "../server/app.ts";
import { Scheduler } from "../server/scheduler.ts";

const ROOT = resolve(import.meta.dirname, "../../..");

/** Demo workflows rewritten with absolute fixture paths into a temp dir. */
function workflowsDir(gate: "auto" | "manual" = "auto"): string {
  const dir = mkdtempSync(join(tmpdir(), "stockai-wf-"));
  for (const name of ["demo-ai", "demo-rules"]) {
    const text = readFileSync(join(ROOT, "workflows", `${name}.yaml`), "utf8")
      .replace("examples/fixtures/news.json", join(ROOT, "examples/fixtures/news.json"))
      .replace("mode: auto", `mode: ${gate}`);
    writeFileSync(join(dir, `${name}.yaml`), text);
  }
  return dir;
}

let app: App | undefined;
let lastDir = "";
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function start(opts: { gate?: "auto" | "manual"; token?: string; clock?: () => Date; settings?: SettingsStore } = {}) {
  const services = new Services(loadConfig(join(ROOT, "config/config.jp.example.yaml")), { fake: true, dbPath: ":memory:", ...(opts.settings ? { settings: opts.settings } : {}) });
  lastDir = workflowsDir(opts.gate);
  app = createApp({
    services, registry: builtinRegistry(), workflowsDir: lastDir,
    ...(opts.token ? { token: opts.token } : {}), ...(opts.clock ? { clock: opts.clock } : {}),
  });
  await new Promise<void>((r) => app!.server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  const api = async <T>(path: string, init?: RequestInit): Promise<{ status: number; body: T }> => {
    const res = await fetch(base + path, init);
    return { status: res.status, body: (await res.json()) as T };
  };
  const post = <T>(path: string, body: unknown) => api<T>(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  return { app, base, api, post };
}

describe("web server", () => {
  it("lists workflows and runs one in the background", async () => {
    const { app, api, post } = await start();
    const ov = await api<Overview>("/api/overview");
    expect(ov.body.workflows.map((w) => w.name)).toEqual(["demo-ai", "demo-rules"]);
    expect(ov.body.fake).toBe(true);
    const { status, body } = await post<{ runId: string }>("/api/workflows/demo-ai/run", { asOf: "2026-07-21" });
    expect(status).toBe(202);
    await app.queue.idle();
    const d = await api<RunDetail>(`/api/runs/${body.runId}`);
    expect(d.body.run.status).toBe("succeeded");
    expect(d.body.nodes).toHaveLength(16);
    expect(d.body.nodes.find((n) => n.id === "news")?.layer).toBe(0);
    expect(d.body.nodes.find((n) => n.id === "decide")!.layer).toBeGreaterThan(d.body.nodes.find((n) => n.id === "score")!.layer);
    expect(d.body.highlights.judgments?.source).toBe("ai");
    expect(d.body.highlights.scorecard).toBeDefined();
    expect((await api<Overview>("/api/overview")).body.equity.map((e) => e.account)).toEqual(["demo-ai"]);
  });

  it("validates input", async () => {
    const { api, post } = await start();
    expect((await post("/api/workflows/nope/run", {})).status).toBe(404);
    expect((await post("/api/workflows/demo-ai/run", { asOf: "07/21/2026" })).status).toBe(400);
    expect((await api("/api/runs/does-not-exist")).status).toBe(404);
    expect((await api("/api/workflows/demo-ai/run", { method: "POST", body: "{}" })).status).toBe(415);
  });

  it("approves a waiting gate from the API", async () => {
    const { app, api, post } = await start({ gate: "manual" });
    let waiting: string | undefined;
    for (const d of ["2026-07-20", "2026-07-21", "2026-07-22", "2026-08-03", "2026-08-10"]) {
      const { body } = await post<{ runId: string }>("/api/workflows/demo-ai/run", { asOf: d });
      await app.queue.idle();
      if ((await api<RunDetail>(`/api/runs/${body.runId}`)).body.run.status === "waiting") {
        waiting = body.runId;
        break;
      }
    }
    expect(waiting).toBeDefined();
    const ov = (await api<Overview>("/api/overview")).body;
    const gate = ov.pending.find((p) => p.run.runId === waiting)!.gates[0]!;
    expect(gate.node).toBe("approve");
    expect(gate.proposals.length).toBeGreaterThan(0);
    expect((await post(`/api/runs/${waiting}/approve`, { node: "propose", decision: "approve" })).status).toBe(409);
    expect((await post(`/api/runs/${waiting}/approve`, { node: "approve", decision: "maybe" })).status).toBe(400);
    expect((await post(`/api/runs/${waiting}/approve`, { node: "approve", decision: "approve", note: "ok" })).status).toBe(202);
    await app.queue.idle();
    const done = (await api<RunDetail>(`/api/runs/${waiting}`)).body;
    expect(done.run.status).toBe("succeeded");
    expect(done.highlights.fills?.length).toBeGreaterThan(0);
  });

  it("times out unattended approvals: the gate rejects after its timeout", async () => {
    let now = Date.parse("2026-11-02T07:00:00Z");
    const { app, api, post } = await start({ gate: "manual", clock: () => new Date(now) });
    let waiting: string | undefined;
    for (const d of ["2026-07-20", "2026-07-21", "2026-07-22", "2026-08-03", "2026-08-10"]) {
      const { body } = await post<{ runId: string }>("/api/workflows/demo-ai/run", { asOf: d });
      await app.queue.idle();
      if ((await api<RunDetail>(`/api/runs/${body.runId}`)).body.run.status === "waiting") {
        waiting = body.runId;
        break;
      }
    }
    expect(waiting).toBeDefined();
    expect(app.sweepWaiting()).toEqual([]); // younger than an hour: left alone
    now += 2 * 3_600_000;
    expect(app.sweepWaiting()).toEqual([waiting]); // re-checked, but the 12h timeout has not passed
    await app.queue.idle();
    expect((await api<RunDetail>(`/api/runs/${waiting}`)).body.run.status).toBe("waiting");
    now += 11 * 3_600_000;
    expect(app.sweepWaiting()).toEqual([waiting]);
    await app.queue.idle();
    const done = (await api<RunDetail>(`/api/runs/${waiting}`)).body;
    expect(done.run.status).toBe("succeeded");
    expect(done.highlights.proposals?.approved).toBe(true);
    expect(done.highlights.proposals?.items).toEqual([]); // rejected by timeout
    expect(done.highlights.fills).toEqual([]);
  });

  it("validates and saves edited workflows as YAML", async () => {
    const { api, post } = await start();
    const put = <T,>(path: string, body: unknown) => api<T>(path, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const { body: wf } = await api<{ graph: { nodes: unknown[] } }>("/api/workflows/demo-rules");
    expect(wf.graph.nodes).toHaveLength(15);
    const spec = { name: "my-flow", nodes: { p: { use: "data.pricesSynthetic", ui: { x: 10, y: 20 } }, f: { use: "signal.factors", in: { prices: "p" } } } };
    expect((await post<{ problems: string[] }>("/api/workflows/validate", { spec })).body.problems).toEqual([]);
    const bad = { name: "my-flow", nodes: { f: { use: "signal.factors", in: { prices: "nope.prices" } } } };
    expect((await post<{ problems: string[] }>("/api/workflows/validate", { spec: bad })).body.problems.join()).toMatch(/unknown node "nope"/);
    expect((await post("/api/workflows/validate", { spec: { name: "Bad Name", nodes: {} } })).status).toBe(422);

    expect((await put("/api/workflows/other", { spec })).status).toBe(400);
    const saved = await put<{ file: string; problems: string[] }>("/api/workflows/my-flow", { spec, create: true });
    expect(saved.status).toBe(200);
    expect(readFileSync(join(lastDir, "my-flow.yaml"), "utf8")).toContain("p: { use: data.pricesSynthetic, ui: { x: 10, y: 20 } }");
    expect((await put("/api/workflows/my-flow", { spec, create: true })).status).toBe(409);
    // overwrite keeps a backup; drafts with problems are saved but reported
    const r = await put<{ problems: string[] }>("/api/workflows/my-flow", { spec: { ...bad, name: "my-flow" } });
    expect(r.body.problems.length).toBeGreaterThan(0);
    expect(readFileSync(join(lastDir, "my-flow.yaml.bak"), "utf8")).toContain("data.pricesSynthetic");
    expect((await api<Array<{ name: string }>>("/api/workflows")).body.map((w) => w.name)).toContain("my-flow");
  });

  it("requires the token when configured", async () => {
    const { base } = await start({ token: "s3cret" });
    expect((await fetch(`${base}/api/overview`)).status).toBe(401);
    expect((await fetch(`${base}/api/overview`, { headers: { "x-stockai-token": "s3cret" } })).status).toBe(200);
    expect((await fetch(`${base}/api/overview?token=s3cret`)).status).toBe(200);
  });

  it("streams run events", async () => {
    const { app, base, post } = await start();
    const ctrl = new AbortController();
    const res = await fetch(`${base}/api/stream`, { signal: ctrl.signal });
    const reader = res.body!.getReader();
    const events: StreamEvent[] = [];
    const reading = (async () => {
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buf += new TextDecoder().decode(value);
        let i: number;
        while ((i = buf.indexOf("\n\n")) >= 0) {
          const chunk = buf.slice(0, i);
          buf = buf.slice(i + 2);
          if (chunk.startsWith("data: ")) events.push(JSON.parse(chunk.slice(6)) as StreamEvent);
        }
      }
    })().catch(() => undefined);
    await post("/api/workflows/demo-rules/run", { asOf: "2026-07-21" });
    await app.queue.idle();
    await new Promise((r) => setTimeout(r, 50));
    ctrl.abort();
    await reading;
    expect(events[0]?.type).toBe("hello");
    expect(events.some((e) => e.type === "queued")).toBe(true);
    const kinds = events.flatMap((e) => (e.type === "run_event" ? [String(e.event["type"])] : []));
    expect(kinds[0]).toBe("run_started");
    expect(kinds.at(-1)).toBe("run_finished");
  });
});

describe("scheduler", () => {
  it("fires once per day at or after the time, on scheduled days, unless already run", () => {
    let now = new Date(2026, 10, 2, 16, 0); // Mon 2 Nov 2026, 16:00 local
    const fired: string[] = [];
    let ran = false;
    const s = new Scheduler([{ workflow: "w", file: "w.yaml", at: "16:30", days: [1, 2, 3, 4, 5] }], {
      trigger: (f) => fired.push(f), ranToday: () => (ran ? { runId: "x", workflow: "w", asOf: "", status: "succeeded", createdAt: "", finishedAt: null } : null), clock: () => now,
    });
    expect(s.tick()).toEqual([]);
    now = new Date(2026, 10, 2, 16, 31);
    expect(s.tick()).toEqual(["w.yaml"]);
    expect(s.tick()).toEqual([]);
    now = new Date(2026, 10, 3, 17, 0); // Tue, already run manually
    ran = true;
    expect(s.tick()).toEqual([]);
    now = new Date(2026, 10, 7, 17, 0); // Sat
    ran = false;
    expect(s.tick()).toEqual([]);
    expect(new Date(s.status()[0]!.nextAt!).getDay()).toBe(1); // next Monday
    expect(fired).toEqual(["w.yaml"]);
  });

  it("settings: stores keys, reports where each comes from, never returns a secret", async () => {
    const env: NodeJS.ProcessEnv = { WEBULL_APP_KEY: "from-shell" };
    const settings = new SettingsStore({ path: ":memory:", env, shellKeys: new Set(["WEBULL_APP_KEY"]) });
    const { api } = await start({ settings });
    const put = (name: string, value: unknown) => api(`/api/settings/${name}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ value }) });
    expect((await put("GEMINI_API_KEY", "AIzaSy-very-secret-value-9876")).status).toBe(200);
    expect(env["GEMINI_API_KEY"]).toBe("AIzaSy-very-secret-value-9876");
    const view = await api<SettingsView>("/api/settings");
    expect(view.body.available).toBe(true);
    expect(JSON.stringify(view.body)).not.toContain("very-secret");
    const by = Object.fromEntries(view.body.items.map((i) => [i.name, i]));
    expect(by["GEMINI_API_KEY"]).toMatchObject({ set: true, source: "settings", preview: "…9876" });
    expect(by["WEBULL_APP_KEY"]!.source).toBe("shell");
    expect((await put("WEBULL_APP_KEY", "x")).status).toBe(400); // the shell wins
    expect((await put("STOCKAI_LIVE_TRADING", "yes-i-understand")).status).toBe(400);
    expect((await put("GEMINI_API_KEY", 42)).status).toBe(400);
    expect((await api("/api/settings/GEMINI_API_KEY", { method: "PUT", body: "{}" })).status).toBe(415); // no cross-site form posts
    expect((await api("/api/settings/GEMINI_API_KEY", { method: "DELETE" })).status).toBe(200);
    expect(env["GEMINI_API_KEY"]).toBeUndefined();
  });

  it("refuses foreign Host headers when serving without a token (DNS rebinding)", async () => {
    const { base } = await start();
    const status = (host: string) =>
      new Promise<number>((ok, fail) => {
        const u = new URL(`${base}/api/overview`);
        request({ host: u.hostname, port: u.port, path: u.pathname, headers: { host } }, (res) => {
          res.resume();
          ok(res.statusCode ?? 0);
        }).on("error", fail).end();
      });
    expect(await status("evil.example:4317")).toBe(403);
    expect(await status(`localhost:${new URL(base).port}`)).toBe(200);
    expect(await status(`127.0.0.1:${new URL(base).port}`)).toBe(200);
  });
});
