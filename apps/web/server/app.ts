import { randomUUID } from "node:crypto";
import { copyFileSync, createReadStream, existsSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import { backupDue, backupStatus, editableConfigPath, Engine, logWatchlistChange, SuggestRequest, suggestTickers, parseWorkflow, runBackup, saveWatchlist, settingDefs, type BackupFile, type BackupStatus, stringifyWorkflow, toGraph, validateWorkflow, WorkflowError, WorkflowSpec, type NodeRegistry, type RunEvent, type Services } from "@stockai/core";
import type { ImportResult, Overview, RunDetail, SettingsView, StreamEvent, WatchlistView } from "../shared/types.ts";
import { RunNotifier } from "./notify.ts";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { buildMcpServer } from "./mcp.ts";
import { RunQueue } from "./queue.ts";
import { Scheduler } from "./scheduler.ts";
import { discoverWorkflows, equitySeries, latestScorecard, ranToday, runDetail, summary, workflowInfo, type WorkflowFile } from "./views.ts";

export interface AppOptions {
  services: Services;
  registry: NodeRegistry;
  workflowsDir: string;
  /** Built UI (apps/web/dist). */
  staticDir?: string;
  /** If set, every request must carry it (header x-stockai-token or ?token=). */
  token?: string;
  schedule?: boolean;
  clock?: () => Date;
  /** The config file the services were loaded from (watchlist edits are written back to it). */
  configPath?: string;
  /** MCP endpoint at /mcp (default on). readOnly drops the save / run / enable-disable tools. */
  mcp?: { readOnly?: boolean } | false;
}

export interface App {
  server: Server;
  queue: RunQueue;
  scheduler: Scheduler;
  /** Re-evaluates waiting runs so approval gates can apply their timeout. Returns the runs queued. */
  sweepWaiting(minAgeMs?: number): string[];
  /** Queue a run; resolves with its id immediately. */
  startRun(file: string, asOf?: string): string;
  /** Save an uploaded workflow YAML as is (validation problems → draft). */
  importWorkflow(yaml: string, overwrite: boolean): ImportResult;
  /** Switch a workflow off (no runs from schedule, UI, CLI, MCP) or back on. */
  setWorkflowDisabled(name: string, disabled: boolean, note?: string): { name: string; disabled: { since: string; note: string } | null };
  workflows(): WorkflowFile[];
  overview(): Overview;
  notifier: RunNotifier;
  /** Writes a database snapshot now (and prunes old ones). */
  backupNow(): BackupFile;
  close(): Promise<void>;
}

export { HttpError };

/** An error with an HTTP status; its message is safe to show to the user. */
class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml",
  ".woff2": "font/woff2", ".woff": "font/woff", ".json": "application/json", ".png": "image/png", ".ico": "image/x-icon",
};

function send(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(json);
}

async function readJson(req: IncomingMessage, limit = 64_000): Promise<Record<string, unknown>> {
  // JSON-only POSTs: a cross-site form cannot send application/json without a CORS preflight, which we never allow.
  if (!String(req.headers["content-type"] ?? "").startsWith("application/json")) throw new HttpError(415, "content-type must be application/json");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > limit) throw new HttpError(413, "body too large");
    chunks.push(c as Buffer);
  }
  if (!chunks.length) return {};
  const v: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new HttpError(400, "expected a JSON object");
  return v as Record<string, unknown>;
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
function isLocalHost(host: string | undefined): boolean {
  if (!host) return true; // HTTP/1.0 clients; browsers always send Host
  const name = host.replace(/:\d+$/, "").toLowerCase();
  return LOCAL_HOSTS.has(name);
}

const newRunId = (name: string) => `${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14)}-${name}-${randomUUID().slice(0, 6)}`;

export function createApp(o: AppOptions): App {
  const { services: s, registry } = o;
  const clock = o.clock ?? (() => new Date());
  const subscribers = new Set<ServerResponse>();
  const broadcast = (e: StreamEvent) => {
    const line = `data: ${JSON.stringify(e)}\n\n`;
    for (const r of subscribers) r.write(line);
  };
  const engine = new Engine({
    services: s, registry, store: s.runStore, clock,
    onEvent: (runId: string, event: RunEvent) => broadcast({ type: "run_event", runId, event }),
  });
  const queue = new RunQueue();
  const notifier = new RunNotifier(s, registry, clock);

  function backupNow(): BackupFile {
    return runBackup(s.config, s.db, s.settings, clock());
  }
  /** Daily snapshot while the server runs (checked every 10 minutes; also right after start). */
  function backupTick(): void {
    if (!backupDue(s.config, clock())) return;
    try {
      const f = backupNow();
      console.log(`backup ${f.file}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`backup failed: ${msg}`);
      void notifier.backupFailed(msg);
    }
  }
  const workflows = (): WorkflowFile[] => discoverWorkflows(o.workflowsDir);
  const byName = (name: string) => {
    const w = workflows().find((x) => x.name === name);
    if (!w) throw new HttpError(404, `unknown workflow ${name}`);
    if (!w.spec) throw new HttpError(422, w.error ?? "invalid workflow");
    return w;
  };

  function startRun(file: string, asOf?: string): string {
    const w = workflows().find((x) => resolve(x.file) === resolve(file));
    if (!w?.spec) throw new HttpError(404, `workflow file not found or invalid: ${file}`);
    const spec = w.spec;
    const off = s.runStore.disabled(spec.name);
    if (off) throw new HttpError(409, `${spec.name} は無効になっています（${off.since.slice(0, 10)} から）。有効にしてから実行してください`);
    const runId = newRunId(spec.name);
    broadcast({ type: "queued", runId, workflow: spec.name });
    void queue
      .enqueue(`${spec.name} ${asOf ?? "today"}`, () => engine.run(spec, { runId, ...(asOf ? { asOf } : {}) }))
      .catch(() => undefined)
      .then(() => notifier.runSettled(runId));
    return runId;
  }

  const scheduleEntries = s.config.schedule.map((e) => {
    const wf = workflows().find((w) => resolve(w.file) === resolve(e.workflow));
    return { ...e, file: e.workflow, workflow: wf?.name ?? e.workflow };
  });
  const scheduler = new Scheduler(scheduleEntries, {
    trigger: (f) => {
      try {
        startRun(f);
      } catch (e) {
        console.error(`schedule: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
    ranToday: (w) => ranToday(s, w, clock),
    isDisabled: (w) => s.runStore.disabled(w) !== null,
    clock,
  });

  /** A gate only checks its timeout when it runs, so waiting runs are resumed now and then. */
  const resuming = new Set<string>();
  function sweepWaiting(minAgeMs = 3_600_000): string[] {
    const due = s.runStore
      .listRuns(500)
      .filter((r) => r.status === "waiting" && !resuming.has(r.runId) && clock().getTime() - new Date(r.createdAt).getTime() >= minAgeMs);
    for (const r of due) {
      resuming.add(r.runId);
      void queue
        .enqueue(`timeout check ${r.runId}`, () => engine.resume(r.runId))
        .catch(() => undefined)
        .then(() => notifier.runSettled(r.runId))
        .finally(() => resuming.delete(r.runId));
    }
    return due.map((r) => r.runId);
  }
  let sweeper: NodeJS.Timeout | undefined;
  let backupTimer: NodeJS.Timeout | undefined;
  if (o.schedule) {
    backupTick();
    backupTimer = setInterval(backupTick, 10 * 60_000);
    backupTimer.unref();
    scheduler.start();
    sweeper = setInterval(() => sweepWaiting(), 10 * 60_000);
    sweeper.unref();
  }

  function importWorkflow(text: string, overwrite: boolean): ImportResult {
    if (!text.trim()) throw new HttpError(400, "yaml must be a non-empty string");
    let spec: WorkflowSpec;
    try {
      spec = parseWorkflow(text);
    } catch (e) {
      if (e instanceof WorkflowError) throw new HttpError(422, `YAML を読めません: ${e.problems.join("; ")}`);
      throw new HttpError(422, `YAML を読めません: ${e instanceof Error ? e.message : String(e)}`);
    }
    const existing = workflows().find((w) => w.name === spec.name);
    const file = existing?.file ?? join(o.workflowsDir, `${spec.name}.yaml`);
    if (!resolve(file).startsWith(resolve(o.workflowsDir))) throw new HttpError(400, "refusing to write outside the workflows directory");
    if ((existing || existsSync(file)) && !overwrite) throw new HttpError(409, `ワークフロー ${spec.name} は既にあります（上書きするには overwrite: true）`);
    if (existsSync(file)) copyFileSync(file, `${file}.bak`);
    // Keep the uploaded text as is (comments survive), with a trailing newline.
    writeFileSync(file, text.endsWith("\n") ? text : `${text}\n`, "utf8");
    return { name: spec.name, file, created: !existing, problems: validateWorkflow(spec, registry) };
  }

  function setWorkflowDisabled(name: string, disabled: boolean, note = "") {
    if (!workflows().some((w) => w.name === name)) throw new HttpError(404, `unknown workflow ${name}`);
    s.runStore.setDisabled(name, disabled, note.slice(0, 200), clock());
    broadcast({ type: "workflow_state", workflow: name, disabled });
    return { name, disabled: s.runStore.disabled(name) };
  }

  function overview(): Overview {
    const runs = s.runStore.listRuns(200);
    const budget = s.budget;
    return {
      now: clock().toISOString(),
      fake: s.fake,
      pending: runs.filter((r) => r.status === "waiting").map((r) => ({ run: summary(r), gates: runDetail(s, registry, r).waiting })),
      workflows: workflows().map((w) => workflowInfo(w, s, registry)),
      recent: runs.slice(0, 12).map(summary),
      equity: equitySeries(s),
      scorecard: latestScorecard(s),
      cost: { spentToday: budget.spentToday(), dailyLimit: budget.dailyLimitUsd, byProvider: budget.summaryToday().map((p) => ({ provider: p.provider, calls: p.calls, costUsd: p.costUsd })) },
      schedule: scheduler.status(),
      queue: { running: queue.running, pending: queue.pending },
    };
  }

  function serveStatic(req: IncomingMessage, res: ServerResponse, path: string): void {
    const root = o.staticDir;
    if (!root || !existsSync(join(root, "index.html"))) {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      res.end("stockai web: UI not built. Run `npm run build -w @stockai/web` (API is under /api).");
      return;
    }
    const target = normalize(join(root, path === "/" ? "index.html" : path));
    const file = target.startsWith(resolve(root)) && existsSync(target) && statSync(target).isFile() ? target : join(root, "index.html");
    res.writeHead(200, {
      "content-type": MIME[extname(file)] ?? "application/octet-stream",
      "cache-control": file.includes(`${"/"}assets${"/"}`) ? "public, max-age=31536000, immutable" : "no-cache",
      "x-content-type-options": "nosniff",
    });
    if (req.method === "HEAD") return void res.end();
    createReadStream(file).pipe(res);
  }

  function authorize(req: IncomingMessage, url: URL): void {
    const bearer = /^Bearer (.+)$/i.exec(String(req.headers.authorization ?? ""))?.[1];
    if (o.token && req.headers["x-stockai-token"] !== o.token && bearer !== o.token && url.searchParams.get("token") !== o.token) throw new HttpError(401, "token required");
    // Without a token the server is local-only: refuse other Host names so a web page cannot
    // reach it through DNS rebinding (it holds API keys and can approve orders).
    if (!o.token && !isLocalHost(req.headers.host)) throw new HttpError(403, "non-local Host header (set STOCKAI_WEB_TOKEN to serve other hosts)");
  }

  /** Stateless Streamable HTTP: one MCP server per request, JSON responses. */
  async function handleMcp(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    if (o.mcp === false) throw new HttpError(404, "MCP is disabled on this server");
    authorize(req, url);
    if (req.method !== "POST") {
      res.writeHead(405, { allow: "POST", "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed (stateless server: POST only)" }, id: null }));
      return;
    }
    const body = await readJson(req, 512_000);
    const mcp = buildMcpServer({ app: self!, services: s, registry, readOnly: o.mcp?.readOnly ?? false });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void mcp.close();
    });
    await mcp.connect(transport);
    await transport.handleRequest(req, res, body);
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    if (path === "/mcp") return handleMcp(req, res, url);
    if (!path.startsWith("/api/")) return serveStatic(req, res, path);
    authorize(req, url);
    const m = (re: RegExp) => path.match(re);
    let g: RegExpMatchArray | null;

    if (req.method === "GET" && path === "/api/overview") return send(res, 200, overview());
    if (req.method === "GET" && path === "/api/workflows") return send(res, 200, workflows().map((w) => workflowInfo(w, s, registry)));
    if (req.method === "GET" && (g = m(/^\/api\/workflows\/([\w-]+)$/))) {
      const w = byName(g[1]!);
      return send(res, 200, { info: workflowInfo(w, s, registry), graph: toGraphSafe(w), spec: w.spec });
    }
    if (req.method === "POST" && path === "/api/workflows/validate") {
      const spec = parseSpec((await readJson(req))["spec"]);
      const problems = validateWorkflow(spec, registry);
      return send(res, 200, { problems, graph: problems.some((p) => p.includes("unknown node type")) ? null : toGraphSafe({ name: spec.name, file: "", spec, error: null }) });
    }
    if (req.method === "PUT" && (g = m(/^\/api\/workflows\/([\w-]+)$/))) {
      const body = await readJson(req);
      const spec = parseSpec(body["spec"]);
      if (spec.name !== g[1]) throw new HttpError(400, `spec.name (${spec.name}) must match the URL (${g[1]})`);
      const existing = workflows().find((w) => w.name === spec.name);
      if (body["create"] === true && existing) throw new HttpError(409, `workflow ${spec.name} already exists`);
      const file = existing?.file ?? join(o.workflowsDir, `${spec.name}.yaml`);
      if (!resolve(file).startsWith(resolve(o.workflowsDir))) throw new HttpError(400, "refusing to write outside the workflows directory");
      if (existsSync(file)) copyFileSync(file, `${file}.bak`);
      writeFileSync(file, stringifyWorkflow(spec), "utf8");
      // invalid graphs may be saved as drafts; runs refuse them until fixed
      return send(res, 200, { file, problems: validateWorkflow(spec, registry) });
    }
    if (req.method === "POST" && path === "/api/workflows/import") {
      const body = await readJson(req);
      if (typeof body["yaml"] !== "string") throw new HttpError(400, "yaml must be a non-empty string");
      const r = importWorkflow(body["yaml"], body["overwrite"] === true);
      return send(res, r.created ? 201 : 200, r);
    }
    if (req.method === "POST" && (g = m(/^\/api\/workflows\/([\w-]+)\/(disable|enable)$/))) {
      const body = await readJson(req);
      return send(res, 200, setWorkflowDisabled(g[1]!, g[2] === "disable", typeof body["note"] === "string" ? body["note"] : ""));
    }
    if (req.method === "POST" && (g = m(/^\/api\/workflows\/([\w-]+)\/run$/))) {
      const body = await readJson(req);
      const asOf = typeof body["asOf"] === "string" && body["asOf"] ? body["asOf"] : undefined;
      if (asOf && !/^\d{4}-\d{2}-\d{2}$/.test(asOf)) throw new HttpError(400, "asOf must be YYYY-MM-DD");
      return send(res, 202, { runId: startRun(byName(g[1]!).file, asOf) });
    }
    if (req.method === "GET" && path === "/api/runs") {
      const limit = Math.min(500, Number(url.searchParams.get("limit") ?? 50) || 50);
      return send(res, 200, s.runStore.listRuns(limit, url.searchParams.get("workflow") ?? undefined).map(summary));
    }
    if (req.method === "GET" && (g = m(/^\/api\/runs\/([\w-]+)$/))) {
      const run = s.runStore.getRun(g[1]!);
      if (!run) throw new HttpError(404, "unknown run (it may still be queued)");
      return send(res, 200, runDetail(s, registry, run) satisfies RunDetail);
    }
    if (req.method === "POST" && (g = m(/^\/api\/runs\/([\w-]+)\/approve$/))) {
      const runId = g[1]!;
      const run = s.runStore.getRun(runId);
      if (!run) throw new HttpError(404, "unknown run");
      const body = await readJson(req);
      const node = String(body["node"] ?? "");
      const decision = body["decision"];
      if (decision !== "approve" && decision !== "reject") throw new HttpError(400, "decision must be approve or reject");
      const gate = runDetail(s, registry, run).waiting.find((w) => w.node === node);
      if (!gate) throw new HttpError(409, `node ${node} is not waiting for approval`);
      s.runStore.setApproval(runId, node, decision, typeof body["note"] === "string" ? body["note"].slice(0, 500) : "");
      void queue
        .enqueue(`resume ${runId}`, () => engine.resume(runId))
        .catch(() => undefined)
        .then(() => notifier.runSettled(runId));
      return send(res, 202, { ok: true });
    }
    if (req.method === "GET" && path === "/api/settings") {
      const st = s.settings;
      if (!st) return send(res, 200, { available: false, path: null, items: [] } satisfies SettingsView);
      return send(res, 200, { available: true, path: st.path, items: st.status(settingDefs(s.config)) } satisfies SettingsView);
    }
    if ((req.method === "PUT" || req.method === "DELETE") && (g = m(/^\/api\/settings\/([A-Za-z0-9_]+)$/))) {
      const st = s.settings;
      if (!st) throw new HttpError(404, "settings are not available on this server");
      const name = g[1]!;
      try {
        if (req.method === "PUT") {
          const value = (await readJson(req))["value"];
          if (typeof value !== "string") throw new HttpError(400, "value must be a string");
          st.set(name, value);
        } else st.clear(name);
      } catch (e) {
        if (e instanceof HttpError) throw e;
        throw new HttpError(400, e instanceof Error ? e.message : String(e));
      }
      const item = st.status(settingDefs(s.config)).find((x) => x.name === name);
      return send(res, 200, { ok: true, item: item ?? null });
    }
    if (req.method === "POST" && path === "/api/notify/test") {
      await readJson(req);
      try {
        await notifier.send({ title: "stockai テスト通知", description: "この通知が見えていれば設定は完了です。", tone: "ok" });
      } catch (e) {
        throw new HttpError(400, e instanceof Error ? e.message : String(e));
      }
      return send(res, 200, { ok: true });
    }
    if (req.method === "GET" && path === "/api/backup") return send(res, 200, backupStatus(s.config, clock()) satisfies BackupStatus);
    if (req.method === "POST" && path === "/api/backup") {
      await readJson(req);
      try {
        return send(res, 200, { ok: true, file: backupNow(), status: backupStatus(s.config, clock()) });
      } catch (e) {
        throw new HttpError(500, `バックアップに失敗しました: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (req.method === "POST" && path === "/api/universe/suggest") {
      const body = await readJson(req);
      const parsed = SuggestRequest.safeParse({ theme: body["theme"], count: body["count"], size: body["size"] });
      if (!parsed.success) throw new HttpError(400, parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
      try {
        return send(res, 200, await suggestTickers(s, parsed.data, clock()));
      } catch (e) {
        const budget = e instanceof Error && e.name === "BudgetExceeded";
        throw new HttpError(budget ? 429 : 400, e instanceof Error ? e.message : String(e));
      }
    }
    if (req.method === "GET" && path === "/api/config/watchlist") {
      return send(res, 200, {
        watchlist: s.config.watchlist, benchmark: s.config.market.benchmark ?? "", currency: s.config.market.currency,
        file: o.configPath ? editableConfigPath(o.configPath) : null, loadedFrom: o.configPath ?? null,
      } satisfies WatchlistView);
    }
    if (req.method === "PUT" && path === "/api/config/watchlist") {
      if (!o.configPath) throw new HttpError(404, "this server was started without a config file");
      const body = await readJson(req);
      // Optimistic concurrency: the client says which watchlist it edited. A missing or stale
      // list (another tab, a hand edit, a half-loaded page) must not silently replace the file.
      const previous = body["previous"];
      const current = Object.keys(s.config.watchlist).sort();
      if (!Array.isArray(previous) || JSON.stringify([...previous].map(String).sort()) !== JSON.stringify(current)) {
        throw new HttpError(409, "ウォッチリストが読み込み時から変わっています。画面を再読み込みしてから編集してください");
      }
      let r: ReturnType<typeof saveWatchlist>;
      try {
        r = saveWatchlist(o.configPath, body["watchlist"] as never, typeof body["benchmark"] === "string" ? body["benchmark"] : undefined);
      } catch (e) {
        const msg = e instanceof Error && "issues" in e ? (e as { issues: Array<{ path: PropertyKey[]; message: string }> }).issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") : e instanceof Error ? e.message : String(e);
        throw new HttpError(400, msg);
      }
      const before = s.config.watchlist;
      s.updateWatchlist(r.config.watchlist, r.config.market.benchmark ?? "");
      logWatchlistChange(
        s, "ui",
        Object.keys(r.config.watchlist).filter((t) => !(t in before)).map((t) => ({ ticker: t, name: r.config.watchlist[t]!.name, reason: "" })),
        Object.keys(before).filter((t) => !(t in r.config.watchlist)).map((t) => ({ ticker: t, reason: "" })),
        "", clock(),
      );
      broadcast({ type: "config_changed" });
      return send(res, 200, { ok: true, file: r.file, created: r.created, tickers: Object.keys(r.config.watchlist).length });
    }
    if (req.method === "GET" && path === "/api/nodes") return send(res, 200, registry.describe());
    if (req.method === "GET" && path === "/api/stream") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
      res.write(`data: ${JSON.stringify({ type: "hello", now: clock().toISOString() } satisfies StreamEvent)}\n\n`);
      subscribers.add(res);
      const ping = setInterval(() => res.write(": ping\n\n"), 15_000);
      req.on("close", () => {
        clearInterval(ping);
        subscribers.delete(res);
      });
      return;
    }
    throw new HttpError(404, "not found");
  }

  function parseSpec(v: unknown): WorkflowSpec {
    const r = WorkflowSpec.safeParse(v);
    if (!r.success) throw new HttpError(422, r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
    return r.data;
  }

  function toGraphSafe(w: WorkflowFile) {
    try {
      return w.spec ? toGraph(w.spec, registry) : null;
    } catch {
      return null;
    }
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((e: unknown) => {
      const status = e instanceof HttpError ? e.status : e instanceof SyntaxError ? 400 : 500;
      if (!res.headersSent) send(res, status, { error: e instanceof Error ? e.message : String(e) });
      else res.end();
    });
  });

  const self: App = {
    server, queue, scheduler, startRun, sweepWaiting, importWorkflow, setWorkflowDisabled, workflows, overview, notifier, backupNow,
    async close() {
      scheduler.stop();
      if (sweeper) clearInterval(sweeper);
      if (backupTimer) clearInterval(backupTimer);
      for (const r of subscribers) r.end();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
  return self;
}
