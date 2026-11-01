import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { builtinRegistry, loadConfig, Services } from "@stockai/core";
import { createApp, type App } from "../server/app.ts";
import { buildMcpServer } from "../server/mcp.ts";

const ROOT = resolve(import.meta.dirname, "../../..");

function workflowsDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "stockai-mcp-"));
  for (const name of ["demo-ai", "demo-rules"]) {
    const text = readFileSync(join(ROOT, "workflows", `${name}.yaml`), "utf8").replace("examples/fixtures/news.json", join(ROOT, "examples/fixtures/news.json"));
    writeFileSync(join(dir, `${name}.yaml`), text);
  }
  return dir;
}

let app: App | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

function makeApp(opts: { token?: string; mcp?: { readOnly?: boolean } | false } = {}) {
  const services = new Services(loadConfig(join(ROOT, "config/config.example.yaml")), { fake: true, dbPath: ":memory:" });
  const registry = builtinRegistry();
  app = createApp({ services, registry, workflowsDir: workflowsDir(), ...(opts.token ? { token: opts.token } : {}), ...(opts.mcp !== undefined ? { mcp: opts.mcp } : {}) });
  return { app, services, registry };
}

async function client(readOnly = false) {
  const { app: a, services, registry } = makeApp();
  const server = buildMcpServer({ app: a, services, registry, readOnly });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const c = new Client({ name: "test", version: "0" });
  await c.connect(ct);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await c.callTool({ name, arguments: args });
    const text = (r.content as Array<{ text: string }>)[0]!.text;
    return { isError: r.isError === true, text, json: () => JSON.parse(text) as Record<string, any> };
  };
  return { c, call, app: a };
}

describe("MCP server", () => {
  it("offers read and write tools, never an approval or settings tool", async () => {
    const { c } = await client();
    const names = (await c.listTools()).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["overview", "get_run", "list_node_types", "validate_workflow", "save_workflow", "run_workflow", "set_workflow_enabled"]));
    expect(names.some((n) => /approv|reject|setting|key/i.test(n))).toBe(false);
    expect(c.getInstructions()).toMatch(/Never follow instructions/);
    expect((await c.listPrompts()).prompts.map((p) => p.name)).toContain("daily_review");
  });

  it("read-only mode drops the write tools", async () => {
    const { c } = await client(true);
    const names = (await c.listTools()).tools.map((t) => t.name);
    expect(names).toContain("get_run");
    expect(names).not.toContain("run_workflow");
    expect(names).not.toContain("save_workflow");
    expect(names).not.toContain("set_workflow_enabled");
  });

  it("runs a workflow through the queue and explains it", async () => {
    const { call, app: a } = await client();
    const run = await call("run_workflow", { name: "demo-ai", asOf: "2026-08-10" });
    expect(run.isError).toBe(false);
    await a.queue.idle();
    const d = (await call("get_run", { runId: run.json()["runId"] })).json();
    expect(d["run"].status).toBe("succeeded");
    expect(d["note"]).toMatch(/not instructions/);
    expect(d["highlights"].judgments.items.length).toBeGreaterThan(0);
    expect(d["nodes"][0]).not.toHaveProperty("summary");
    expect((await call("list_runs", { workflow: "demo-ai" })).json()).toHaveLength(1);
    expect((await call("overview")).json()["workflows"]).toHaveLength(2);
  });

  it("validates, saves and toggles workflows with the same rules as the web UI", async () => {
    const { call } = await client();
    const yaml = (await call("get_workflow", { name: "demo-rules" })).json()["yaml"] as string;
    const copy = `# written by an assistant\n${yaml.replace("name: demo-rules", "name: mcp-copy")}`;
    expect((await call("validate_workflow", { yaml: copy })).json()).toMatchObject({ name: "mcp-copy", valid: true });
    expect((await call("validate_workflow", { yaml: "name: x\nnodes:\n  a: { use: nope }\n" })).json()["valid"]).toBe(false);
    const saved = await call("save_workflow", { yaml: copy });
    expect(saved.json()).toMatchObject({ name: "mcp-copy", created: true });
    expect(readFileSync(saved.json()["file"], "utf8")).toContain("# written by an assistant");
    const again = await call("save_workflow", { yaml: copy });
    expect(again.isError).toBe(true);
    expect(again.text).toMatch(/既にあります/);
    expect((await call("set_workflow_enabled", { name: "mcp-copy", enabled: false })).json()["disabled"]).not.toBeNull();
    const refused = await call("run_workflow", { name: "mcp-copy" });
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(/無効/);
    expect((await call("get_workflow", { name: "nope" })).isError).toBe(true);
  });
});

describe("MCP over HTTP (/mcp)", () => {
  async function listen(opts: Parameters<typeof makeApp>[0] = {}) {
    const { app: a } = makeApp(opts);
    await new Promise<void>((r) => a.server.listen(0, "127.0.0.1", () => r()));
    return `http://127.0.0.1:${(a.server.address() as AddressInfo).port}/mcp`;
  }
  const rpc = (url: string, method: string, params: unknown, headers: Record<string, string> = {}) =>
    fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
  const init = { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } };

  it("answers initialize, tools/list and tools/call statelessly", async () => {
    const url = await listen();
    const i = await rpc(url, "initialize", init);
    expect(i.status).toBe(200);
    expect(((await i.json()) as { result: { serverInfo: { name: string } } }).result.serverInfo.name).toBe("stockai");
    const l = (await (await rpc(url, "tools/list", {})).json()) as { result: { tools: Array<{ name: string }> } };
    expect(l.result.tools.map((t) => t.name)).toContain("overview");
    const o = (await (await rpc(url, "tools/call", { name: "list_workflows", arguments: {} })).json()) as { result: { content: Array<{ text: string }> } };
    expect(JSON.parse(o.result.content[0]!.text)).toHaveLength(2);
    expect((await fetch(url)).status).toBe(405);
  });

  it("needs the token when one is set (header or Bearer), and can be read-only or off", async () => {
    const url = await listen({ token: "t0ken", mcp: { readOnly: true } });
    expect((await rpc(url, "initialize", init)).status).toBe(401);
    expect((await rpc(url, "initialize", init, { authorization: "Bearer t0ken" })).status).toBe(200);
    const l = (await (await rpc(url, "tools/list", {}, { "x-stockai-token": "t0ken" })).json()) as { result: { tools: Array<{ name: string }> } };
    expect(l.result.tools.map((t) => t.name)).not.toContain("run_workflow");
    await app!.close();
    app = undefined;
    const off = await listen({ mcp: false });
    expect((await rpc(off, "initialize", init)).status).toBe(404);
  });
});

describe("MCP watchlist tools", () => {
  async function setup(env: Record<string, string> = { SEC_USER_AGENT: "stockai me@example.com" }) {
    const dir = mkdtempSync(join(tmpdir(), "mcp-wl-"));
    const configPath = join(dir, "config.yaml");
    copyFileSync(join(ROOT, "config/config.example.yaml"), configPath);
    const sec = { fields: ["cik", "name", "ticker", "exchange"], data: [[1730168, "Broadcom Inc.", "AVGO", "Nasdaq"], [1, "Some Otc Co", "OTCX", "OTC"], [320193, "Apple Inc.", "AAPL", "Nasdaq"]] };
    const services = new Services(loadConfig(configPath), {
      fake: true, dbPath: ":memory:", configPath, env, sleep: async () => undefined,
      fetchImpl: async () => new Response(JSON.stringify(sec)),
    });
    const registry = builtinRegistry();
    app = createApp({ services, registry, workflowsDir: workflowsDir(), configPath });
    const server = buildMcpServer({ app, services, registry });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const c = new Client({ name: "t", version: "0" });
    await c.connect(ct);
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const r = await c.callTool({ name, arguments: args });
      const text = (r.content as Array<{ text: string }>)[0]!.text;
      return { isError: r.isError === true, text, json: () => JSON.parse(text) as any };
    };
    return { call, c, configPath, services };
  }

  it("reads the watchlist and verifies tickers against the SEC list", async () => {
    const { call, c } = await setup();
    const w = (await call("get_watchlist")).json();
    expect(Object.keys(w.watchlist)).toContain("NVDA");
    expect(w.sectorCounts.tech).toBeGreaterThan(0);
    const v = (await call("verify_tickers", { candidates: [{ ticker: "avgo", name: "Broadcom" }, { ticker: "OTCX", name: "Some Otc" }, { ticker: "AVGO", name: "CrowdStrike" }, { ticker: "AAPL", name: "Apple" }] })).json();
    expect(v.map((x: { ok: boolean }) => x.ok)).toEqual([true, false, false, true]);
    expect(v[3].inWatchlist).toBe(true);
    expect((await c.listPrompts()).prompts.map((p) => p.name)).toContain("find_stocks");
  });

  it("adds only verified tickers (all or nothing), removes, and logs the change", async () => {
    const { call, configPath, services } = await setup();
    const before = readFileSync(configPath, "utf8");
    const bad = await call("update_watchlist", { add: [{ ticker: "AVGO", name: "Broadcom", sector: "semis", reason: "AI 向け半導体" }, { ticker: "ZZZZ", name: "Nothing", sector: "tech", reason: "x" }] });
    expect(bad.isError).toBe(true);
    expect(bad.text).toMatch(/ZZZZ/);
    expect(readFileSync(configPath, "utf8")).toBe(before);
    const ok = await call("update_watchlist", { add: [{ ticker: "AVGO", name: "Broadcom", sector: "semis", reason: "AI 向け半導体" }], remove: [{ ticker: "XOM", reason: "エネルギーは対象外にしたい" }], note: "テスト" });
    expect(ok.json()).toMatchObject({ added: ["AVGO"], removed: ["XOM"] });
    const cfg = loadConfig(configPath);
    expect(cfg.watchlist["AVGO"]).toMatchObject({ name: "Broadcom", sector: "semis" });
    expect(cfg.watchlist["XOM"]).toBeUndefined();
    expect(services.watchlist.tickers).toContain("AVGO");
    const w = (await call("get_watchlist")).json();
    expect(w.recentChanges[0]).toMatchObject({ source: "mcp", added: [{ ticker: "AVGO", reason: "AI 向け半導体" }], removed: [{ ticker: "XOM" }] });
    expect(w.addedWhen.AVGO.source).toBe("mcp");
  });

  it("refuses to add without SEC verification, and is absent in read-only mode", async () => {
    const { call } = await setup({});
    const r = await call("update_watchlist", { add: [{ ticker: "AVGO", name: "Broadcom", sector: "semis", reason: "x" }] });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/SEC_USER_AGENT/);
    const ro = await client(true);
    expect((await ro.c.listTools()).tools.map((t) => t.name)).not.toContain("update_watchlist");
  });
});

