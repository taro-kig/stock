import { randomUUID } from "node:crypto";
import { copyFileSync, createReadStream, existsSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import { addDays, FACTOR_INFO, setWorkflowParam, ScreenRequest, screenStocks, vendorOf, AUTO, describeUse, explicitModelNames, type ResolvedUse, FALLBACK_PRICE_PER_M, listModels, MODEL_USES, ModelSpecInput, NO_MODEL, saveModelPool, saveModelUse, testModel, type ModelUse, type ModelUseValue, VENDOR_IDS, VENDORS, type ModelList, type ModelTest, type VendorId, runDoctor, watchlistHistory, backupDue, backupStatus, defaultGoldenSet, US_HOLIDAY_JA, usHoliday, usHolidaysBetween, editableConfigPath, Engine, EVALUABLE, FAMILY_LABELS, logWatchlistChange, PROMPT_FAMILIES, runPromptEval, saveConfigValue, type PromptFamily, SuggestRequest, suggestTickers, parseWorkflow, runBackup, saveWatchlist, settingDefs, type BackupFile, type BackupStatus, stringifyWorkflow, toGraph, validateWorkflow, WorkflowError, WorkflowSpec, type NodeRegistry, type RunEvent, type Services } from "@stockai/core";
import type { CalendarView, ImportResult, ModelsView, WeightTargets, Overview, PromptFamilyView, PromptsView, RunDetail, SettingsView, StreamEvent, WatchlistView } from "../shared/types.ts";
import { RunNotifier } from "./notify.ts";
import { journalView, stockView, todayView } from "./stock.ts";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { buildMcpServer } from "./mcp.ts";
import { RunQueue } from "./queue.ts";
import { Scheduler } from "./scheduler.ts";
import { discoverWorkflows, equitySeries, latestFactorReport, latestScorecard, ranToday, runDetail, summary, workflowInfo, type WorkflowFile } from "./views.ts";

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
  let doctorRunning = false;
  let screening = false;
  const modelLists = new Map<string, { until: number; list: ModelList }>();
  s.promptStore.failStale(clock());
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
      .then(async () => { await notifier.runSettled(runId); await notifier.watch(); });
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
    // US config: no runs on exchange holidays (weekday closures; weekends are handled by `days`)
    ...(s.config.market.currency === "USD" ? { holiday: (d: string) => usHoliday(d) } : {}),
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
        .then(async () => { await notifier.runSettled(r.runId); await notifier.watch(); })
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

  function calendarView(fromQ?: string, toQ?: string): CalendarView {
    const now = clock();
    const pad = (n: number) => String(n).padStart(2, "0");
    const local = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const today = local(now);
    const monday = new Date(now);
    monday.setDate(now.getDate() - ((now.getDay() + 6) % 7) - 7); // from last week's Monday
    const from = fromQ ?? local(monday);
    const to = toQ ?? addDays(from, 41);
    if (to < from || addDays(from, 120) < to) throw new HttpError(400, "range: from <= to, at most 120 days");
    const us = s.config.market.currency === "USD";
    const held = s.heldTickers();
    const names = (t: string) => s.watchlist.entries[t]?.name ?? t;
    const tickers = [...new Set([...s.watchlist.tickers, ...Object.keys(held)])];
    const lastFetch = us ? s.earnings.lastFetch() : null;
    const schedule: CalendarView["schedule"] = [];
    for (let d = today > from ? today : from; d <= to; d = addDays(d, 1)) {
      const [y, m, dd] = d.split("-").map(Number) as [number, number, number];
      for (const e of scheduleEntries) {
        const [hh, mm] = e.at.split(":").map(Number) as [number, number];
        const fire = new Date(y, m - 1, dd, hh, mm, 0, 0);
        if (!e.days.includes(fire.getDay()) || fire < now) continue;
        const h = us && e.skipHolidays !== false ? usHoliday(fire.toISOString().slice(0, 10)) : null;
        const off = s.runStore.disabled(e.workflow);
        schedule.push({ date: d, at: e.at, workflow: e.workflow, skipped: off ? "無効" : h ? `休場（${US_HOLIDAY_JA[h] ?? h}）` : null });
      }
    }
    return {
      from, to, today, market: us ? "us" : "jp",
      holidays: us ? usHolidaysBetween(from, to).map((h) => ({ date: h.date, name: h.nameJa })) : [],
      earnings: us
        ? s.earnings.between(tickers, from, to).map((e) => ({
            date: e.reportDate, ticker: e.ticker, name: names(e.ticker), time: e.time, estimate: e.estimate, held: e.ticker in held,
            daysAway: Math.round((Date.parse(`${e.reportDate}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000),
          }))
        : [],
      schedule,
      runs: s.runStore.listRuns(1000).filter((r) => r.asOf >= from && r.asOf <= to).map((r) => ({ date: r.asOf, workflow: r.workflow, status: r.status, runId: r.runId })),
      earningsSource: { configured: Boolean(s.env["ALPHAVANTAGE_API_KEY"]), lastFetch: lastFetch?.fetchedAt ?? null, rows: lastFetch?.rows ?? null },
    };
  }

  const CONFIG_KEY: Record<PromptFamily, "event" | "judge" | "redTeam" | "universe"> = { event: "event", judge: "judge", redteam: "redTeam", universe: "universe" };

  /** Which workflows pin a prompt version in a node (instead of using config.prompts). */
  function promptUsage(): Record<PromptFamily, Record<string, string[]>> {
    const out: Record<PromptFamily, Record<string, string[]>> = { event: {}, judge: {}, redteam: {}, universe: {} };
    const add = (f: PromptFamily, v: unknown, wf: string) => {
      if (typeof v !== "string") return;
      (out[f][v] ??= []).includes(wf) || out[f][v]!.push(wf);
    };
    for (const w of workflows()) {
      for (const n of Object.values(w.spec?.nodes ?? {})) {
        if (n.use === "llm.extractEvents" || n.use === "signal.eventHistory") add("event", n.params["promptVersion"], w.name);
        if (n.use === "decide.ai") {
          add("judge", n.params["promptVersion"], w.name);
          add("redteam", n.params["redTeamVersion"], w.name);
        }
        if (n.use === "universe.review") add("universe", n.params["promptVersion"], w.name);
      }
    }
    return out;
  }

  function promptsView(): PromptsView {
    const usage = promptUsage();
    return {
      families: PROMPT_FAMILIES.map((family) => {
        const active = s.config.prompts[CONFIG_KEY[family]];
        return {
          family, label: FAMILY_LABELS[family], configKey: CONFIG_KEY[family], active,
          evaluable: EVALUABLE.includes(family),
          goldenSet: EVALUABLE.includes(family) ? defaultGoldenSet(s, family) : null,
          versions: s.prompts.list(family).map((p) => ({ ...p, usedBy: [...(p.version === active ? ["config"] : []), ...(usage[family][p.version] ?? [])] })),
          evals: s.promptStore.evals(family, 10),
          models: familyModels(family),
        };
      }),
      switches: s.promptStore.switches(30),
      models: s.fake ? ["fake-a", "fake-b"] : s.modelNames(),
      pool: (s.config.models?.pool ?? []).map((x) => ({ name: x.name, model: x.model, vendor: VENDORS[vendorOf(x)].label, keySet: Boolean(s.env[x.apiKeyEnv]) })),
      quorum: s.config.harness.quorum,
      editable: Boolean(o.configPath),
      fake: s.fake,
    };
  }

  /** The resolved choice, or null when there is no models section / in --fake. */
  function resolved(): ResolvedUse | null {
    if (s.fake || !s.config.models) return null;
    return s.resolvedModels();
  }

  /** Workflow nodes that pick their own models: name → workflows. */
  function nodeModelRefs(): Record<string, string[]> {
    const out: Record<string, string[]> = {};
    for (const w of workflows()) {
      for (const n of Object.values(w.spec?.nodes ?? {})) {
        for (const k of ["models", "escalation", "redTeamModel", "model"]) {
          const v = n.params[k];
          for (const x of Array.isArray(v) ? v : [v]) {
            if (typeof x !== "string" || x === NO_MODEL || x === AUTO) continue;
            (out[x] ??= []).includes(w.name) || out[x]!.push(w.name);
          }
        }
      }
    }
    return out;
  }

  /**
   * Where each pool model is used now (labels), and which ones cannot be removed: those named
   * explicitly in config or in a workflow node. Models picked by "auto" can go; auto picks again.
   */
  function modelUsage(): { usedBy: Record<string, string[]>; locked: string[] } {
    const usedBy: Record<string, string[]> = {};
    const add = (n: string | undefined, what: string) => {
      if (!n) return;
      (usedBy[n] ??= []).includes(what) || usedBy[n]!.push(what);
    };
    const r = resolved();
    if (r) {
      const tag = (f: ModelUse) => (r.auto[f] ? "（おまかせ）" : "");
      for (const f of ["event", "judge"] as const) {
        r[f].vote.forEach((n) => add(n, `${FAMILY_LABELS[f]}${tag(f)}`));
        add(r[f].escalation, `${FAMILY_LABELS[f]}${tag(f)}`);
      }
      add(r.redteam, `${FAMILY_LABELS.redteam}${tag("redteam")}`);
      add(r.universe, `${FAMILY_LABELS.universe}${tag("universe")}`);
    }
    const refs = nodeModelRefs();
    for (const [n, wfs] of Object.entries(refs)) for (const w of wfs) add(n, `${w}（ノード）`);
    const locked = [...new Set([...(s.config.models ? explicitModelNames(s.config.models) : []), ...Object.keys(refs)])];
    return { usedBy, locked };
  }

  /** What a family uses (auto or chosen), in plain words, and which workflows choose their own models for it. */
  function familyModels(f: PromptFamily): PromptFamilyView["models"] {
    const keys: Record<PromptFamily, { types: string[]; params: string[] }> = {
      event: { types: ["llm.extractEvents"], params: ["models", "escalation"] },
      judge: { types: ["decide.ai"], params: ["models", "escalation"] },
      redteam: { types: ["decide.ai"], params: ["redTeamModel"] },
      universe: { types: ["universe.review"], params: ["model"] },
    };
    const overriddenBy = workflows()
      .filter((w) => Object.values(w.spec?.nodes ?? {}).some((n) => keys[f].types.includes(n.use) && keys[f].params.some((k) => n.params[k] !== undefined)))
      .map((w) => w.name);
    const m = s.config.models;
    const r = resolved();
    const saved = m ? m.use[f] : AUTO;
    const kind = f === "event" || f === "judge" ? "vote" : "single";
    return {
      kind, auto: saved === AUTO,
      manual: saved === AUTO ? null : typeof saved === "string" ? saved : { vote: saved.vote, escalation: saved.escalation ?? null },
      vote: r && (f === "event" || f === "judge") ? r[f].vote : [],
      escalation: r && (f === "event" || f === "judge") ? (r[f].escalation ?? null) : null,
      model: r && (f === "redteam" || f === "universe") ? (r[f] ?? null) : null,
      summary: r ? describeUse(r, f, s.config.harness.quorum) : s.fake ? "疑似モデル（--fake）" : "モデル未設定",
      notes: r && r.auto[f] ? r.notes : [],
      overriddenBy,
    };
  }

  function ensureWeightLog(): void {
    s.db.exec("CREATE TABLE IF NOT EXISTS weight_changes (at TEXT, workflow TEXT, node TEXT, from_json TEXT, to_json TEXT, source TEXT)");
  }

  /** Every signal.score node in the workflows, with the weights it uses now, and the change log. */
  function weightTargets(): WeightTargets {
    ensureWeightLog();
    const def = registry.get("signal.score");
    const targets: WeightTargets["targets"] = [];
    for (const w of workflows()) {
      for (const [id, cfg] of Object.entries(w.spec?.nodes ?? {})) {
        if (cfg.use !== "signal.score" || !def) continue;
        const p = def.params.safeParse(cfg.params);
        if (!p.success) continue;
        targets.push({ workflow: w.name, file: w.file, node: id, weights: (p.data as { weights: Record<string, number> }).weights, explicit: "weights" in cfg.params });
      }
    }
    const history = (s.db.prepare("SELECT * FROM weight_changes ORDER BY at DESC LIMIT 30").all() as Array<{ at: string; workflow: string; node: string; from_json: string; to_json: string; source: string }>)
      .map((r) => ({ at: r.at, workflow: r.workflow, node: r.node, from: JSON.parse(r.from_json) as Record<string, number>, to: JSON.parse(r.to_json) as Record<string, number>, source: r.source }));
    return { targets, history };
  }

  /** One short line of what a family uses, for the switch history. */
  function useLine(f: ModelUse): string {
    const r = resolved();
    if (!r) return "—";
    const auto = r.auto[f] ? "おまかせ: " : "";
    if (f === "event" || f === "judge") return `${auto}${r[f].vote.join(" + ")}${r[f].escalation ? ` / 割れたら ${r[f].escalation}` : ""}`;
    return `${auto}${r[f] ?? "なし"}`;
  }

  /** Runs a config.yaml edit; validation errors become 400s with readable messages. */
  function configEdit<T>(fn: () => T): T {
    try {
      return fn();
    } catch (e) {
      const msg = e instanceof Error && "issues" in e
        ? (e as { issues: Array<{ path: PropertyKey[]; message: string }> }).issues.map((i) => `${i.path.length ? `${i.path.join(".")}: ` : ""}${i.message}`).join("; ")
        : e instanceof Error ? e.message : String(e);
      throw new HttpError(400, msg);
    }
  }

  function switchPrompt(family: PromptFamily, version: string, source: string) {
    s.prompts.info(family, version); // must exist
    if (!o.configPath) throw new HttpError(404, "this server was started without a config file");
    const key = CONFIG_KEY[family];
    const from = s.config.prompts[key];
    if (from === version) return { family, active: version, changed: false };
    const r = saveConfigValue(o.configPath, ["prompts", key], version);
    s.setPrompt(key, version);
    s.promptStore.logSwitch({ at: clock().toISOString(), family, from, to: version, source });
    broadcast({ type: "config_changed" });
    return { family, active: version, changed: true, file: r.file };
  }

  function startPromptEval(family: PromptFamily, versions: string[], models: string[], ensemble: boolean, budgetUsd: number): number {
    if (!EVALUABLE.includes(family)) throw new HttpError(400, `${FAMILY_LABELS[family]}には正解データが無いので評価できません（実運用の確度で比べてください）`);
    for (const v of versions) s.prompts.info(family, v);
    if (!versions.length) throw new HttpError(400, "versions must not be empty");
    const id = s.promptStore.createEval({ family, versions, models, ensemble, budgetUsd }, clock());
    broadcast({ type: "prompt_eval", id, status: "queued" });
    void queue
      .enqueue(`eval ${family} ${versions.join(",")}`, async () => {
        s.promptStore.setEval(id, "running", {}, clock());
        broadcast({ type: "prompt_eval", id, status: "running" });
        const report = await runPromptEval(s, { family, versions, ...(models.length ? { models } : {}), ensemble, budgetUsd });
        s.promptStore.setEval(id, "done", { report }, clock());
        broadcast({ type: "prompt_eval", id, status: "done" });
      })
      .catch((e: unknown) => {
        s.promptStore.setEval(id, "failed", { error: e instanceof Error ? e.message : String(e) }, clock());
        broadcast({ type: "prompt_eval", id, status: "failed" });
      });
    return id;
  }

  function overview(): Overview {
    const runs = s.runStore.listRuns(200);
    const budget = s.budget;
    return {
      now: clock().toISOString(),
      fake: s.fake,
      currency: s.config.market.currency,
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
        .then(async () => { await notifier.runSettled(runId); await notifier.watch(); });
      return send(res, 202, { ok: true });
    }
    if (req.method === "GET" && path === "/api/factors") return send(res, 200, latestFactorReport(s));
    if (req.method === "GET" && path === "/api/today") return send(res, 200, todayView(s, clock()));
    if (req.method === "GET" && path === "/api/journal") return send(res, 200, journalView(s, registry, clock()));
    if (req.method === "GET" && path === "/api/factors/targets") return send(res, 200, weightTargets());
    if (req.method === "POST" && path === "/api/factors/apply") {
      const body = await readJson(req);
      const target = weightTargets().targets.find((t) => t.workflow === body["workflow"] && t.node === body["node"]);
      if (!target) throw new HttpError(404, "そのワークフローに signal.score ノードがありません");
      const weights = body["weights"];
      if (!weights || typeof weights !== "object" || Array.isArray(weights)) throw new HttpError(400, "weights must be an object");
      const clean: Record<string, number> = {};
      for (const [k, v] of Object.entries(weights as Record<string, unknown>)) {
        if (!(k in FACTOR_INFO)) throw new HttpError(400, `unknown factor ${k}`);
        if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 5) throw new HttpError(400, `${k}: 0〜5 の数値`);
        clean[k] = Math.round(v * 1000) / 1000;
      }
      if (!Object.values(clean).some((v) => v > 0)) throw new HttpError(400, "重みが全部 0 です");
      if (JSON.stringify(body["previous"] ?? null) !== JSON.stringify(target.weights)) throw new HttpError(409, "ワークフローの重みが読み込み時から変わっています。画面を再読み込みしてください");
      try {
        setWorkflowParam(target.file, target.node, "weights", clean);
      } catch (e) {
        throw new HttpError(400, e instanceof Error ? e.message : String(e));
      }
      ensureWeightLog();
      s.db.prepare("INSERT INTO weight_changes VALUES (?,?,?,?,?,?)").run(clock().toISOString(), target.workflow, target.node, JSON.stringify(target.weights), JSON.stringify(clean), String(body["source"] ?? "ui").slice(0, 40));
      broadcast({ type: "config_changed" });
      return send(res, 200, { ok: true, file: target.file });
    }
    if (req.method === "GET" && (g = m(/^\/api\/stocks\/([A-Z0-9][A-Z0-9.-]{0,9})$/))) return send(res, 200, stockView(s, registry, g[1]!, clock()));
    if (req.method === "GET" && path === "/api/models") {
      return send(res, 200, {
        pool: s.config.models?.pool ?? [], ...modelUsage(), pricing: s.config.pricing, fallbackPrice: [...FALLBACK_PRICE_PER_M],
        vendors: VENDOR_IDS.map((id) => ({ ...VENDORS[id], keySet: Boolean(s.env[VENDORS[id].apiKeyEnv]) })),
        dailyBudgetUsd: s.config.harness.dailyBudgetUsd,
        editable: Boolean(o.configPath), file: o.configPath ? editableConfigPath(o.configPath) : null, fake: s.fake,
      } satisfies ModelsView);
    }
    if (req.method === "GET" && (g = m(/^\/api\/models\/available\/([a-z]+)$/))) {
      const vendor = g[1] as VendorId;
      if (!VENDOR_IDS.includes(vendor)) throw new HttpError(404, `unknown vendor ${vendor}`);
      const baseUrl = url.searchParams.get("baseUrl") ?? undefined;
      const apiKeyEnv = url.searchParams.get("apiKeyEnv") ?? undefined;
      if (apiKeyEnv !== undefined && !/^[A-Z][A-Z0-9_]*$/.test(apiKeyEnv)) throw new HttpError(400, "apiKeyEnv: A-Z, 0-9, _");
      if (baseUrl !== undefined && !/^https?:\/\//.test(baseUrl)) throw new HttpError(400, "baseUrl: http(s) only");
      const cacheKey = `${vendor}|${baseUrl ?? ""}|${apiKeyEnv ?? ""}|${s.env[apiKeyEnv ?? VENDORS[vendor].apiKeyEnv] ? "k" : "-"}`;
      const hit = modelLists.get(cacheKey);
      if (hit && hit.until > clock().getTime() && url.searchParams.get("refresh") !== "1") return send(res, 200, hit.list);
      const list = await listModels(vendor, { env: s.env, fetch: s.fetch, ...(baseUrl ? { baseUrl } : {}), ...(apiKeyEnv ? { apiKeyEnv } : {}) });
      // Cache successful lists for 10 minutes; failures are retried on the next open.
      if (list.source === "api") modelLists.set(cacheKey, { until: clock().getTime() + 600_000, list });
      return send(res, 200, list);
    }
    if (req.method === "POST" && path === "/api/models/test") {
      const parsed = ModelSpecInput.safeParse((await readJson(req))["spec"]);
      if (!parsed.success) throw new HttpError(400, parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
      const t0 = clock().getTime();
      let r: ModelTest;
      try {
        r = await testModel(s, parsed.data);
      } catch (e) {
        r = { status: "fail", detail: (e instanceof Error ? e.message : String(e)).slice(0, 400) };
      }
      return send(res, 200, { ...r, ms: clock().getTime() - t0 });
    }
    if (req.method === "PUT" && path === "/api/models") {
      if (!o.configPath) throw new HttpError(404, "this server was started without a config file");
      const body = await readJson(req);
      // Optimistic concurrency, like the watchlist: refuse if the file changed since the screen loaded.
      if (JSON.stringify(body["previous"] ?? null) !== JSON.stringify(s.config.models?.pool ?? [])) {
        throw new HttpError(409, "モデル設定が読み込み時から変わっています。画面を再読み込みしてから編集してください");
      }
      const keep = new Set((Array.isArray(body["pool"]) ? body["pool"] : []).map((x: { name?: unknown }) => String(x?.name)));
      const usage = modelUsage();
      const gone = usage.locked.filter((n) => !keep.has(n));
      if (gone.length) throw new HttpError(400, gone.map((n) => `${n} は使用中です（${(usage.usedBy[n] ?? []).join("、")}）`).join("; ") + "。先に別のモデル（またはおまかせ）に切り替えてから外してください");
      const r = configEdit(() => saveModelPool(o.configPath!, { pool: body["pool"], pricing: body["pricing"] ?? {} } as never));
      s.updateModels(r.config.models, r.config.pricing);
      broadcast({ type: "config_changed" });
      return send(res, 200, { ok: true, file: r.file, created: r.created });
    }
    if (req.method === "PUT" && (g = m(/^\/api\/models\/use\/([a-z]+)$/))) {
      if (!o.configPath) throw new HttpError(404, "this server was started without a config file");
      const use = g[1] as ModelUse;
      if (!MODEL_USES.includes(use)) throw new HttpError(404, `unknown use ${use}`);
      const value = (await readJson(req))["value"] as ModelUseValue;
      const quorum = s.config.harness.quorum;
      if (value !== AUTO && (use === "event" || use === "judge") && (!value || typeof value !== "object" || !Array.isArray(value.vote) || value.vote.length < quorum)) {
        throw new HttpError(400, `多数決は ${quorum} 票の一致で採用するので、投票するモデルは ${quorum} つ以上必要です（harness.quorum）`);
      }
      const from = useLine(use);
      const r = configEdit(() => saveModelUse(o.configPath!, use, value));
      s.updateModels(r.config.models, r.config.pricing);
      const to = useLine(use);
      if (from !== to) s.promptStore.logSwitch({ at: clock().toISOString(), family: use, from: `モデル ${from}`, to: `モデル ${to}`, source: "ui" });
      broadcast({ type: "config_changed" });
      return send(res, 200, { ok: true, file: r.file, changed: from !== to });
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
      broadcast({ type: "config_changed" }); // e.g. the model screen shows which keys are set
      return send(res, 200, { ok: true, item: item ?? null });
    }
    if (req.method === "POST" && path === "/api/doctor") {
      await readJson(req);
      if (doctorRunning) throw new HttpError(409, "接続チェックを実行中です");
      doctorRunning = true;
      try {
        return send(res, 200, { at: clock().toISOString(), results: await runDoctor(s, { now: clock() }) });
      } finally {
        doctorRunning = false;
      }
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
    if (req.method === "POST" && path === "/api/universe/screen") {
      if (s.config.market.currency !== "USD") throw new HttpError(400, "データでの銘柄探しは米国株の設定（market.currency: USD）でのみ使えます");
      if (screening) throw new HttpError(409, "別の銘柄探しを実行中です");
      const parsed = ScreenRequest.safeParse(await readJson(req));
      if (!parsed.success) throw new HttpError(400, parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
      screening = true;
      try {
        return send(res, 200, await screenStocks(s, parsed.data, { now: clock(), report: latestFactorReport(s)?.report ?? null }));
      } catch (e) {
        throw new HttpError(400, e instanceof Error ? e.message : String(e));
      } finally {
        screening = false;
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
    if (req.method === "GET" && path === "/api/calendar") {
      const q = (k: string) => url.searchParams.get(k) ?? "";
      const iso = /^\d{4}-\d{2}-\d{2}$/;
      return send(res, 200, calendarView(iso.test(q("from")) ? q("from") : undefined, iso.test(q("to")) ? q("to") : undefined));
    }
    if (req.method === "GET" && path === "/api/prompts") return send(res, 200, promptsView());
    if (req.method === "GET" && (g = m(/^\/api\/prompts\/evals\/(\d+)$/))) {
      const r = s.promptStore.evalReport(Number(g[1]));
      if (!r) throw new HttpError(404, "unknown evaluation");
      return send(res, 200, r);
    }
    if ((g = m(/^\/api\/prompts\/(event|judge|redteam|universe)(\/active|\/eval)?$/))) {
      const family = g[1] as PromptFamily;
      const body = await readJson(req);
      try {
        if (req.method === "POST" && !g[2]) {
          const info = s.prompts.create(family, {
            version: String(body["version"] ?? ""), parent: String(body["parent"] ?? ""), system: String(body["system"] ?? ""),
            description: typeof body["description"] === "string" ? body["description"] : "",
          }, clock());
          return send(res, 201, info);
        }
        if (req.method === "PUT" && g[2] === "/active") return send(res, 200, switchPrompt(family, String(body["version"] ?? ""), "ui"));
        if (req.method === "POST" && g[2] === "/eval") {
          const versions = Array.isArray(body["versions"]) ? body["versions"].map(String) : [];
          const models = Array.isArray(body["models"]) ? body["models"].map(String) : [];
          const budgetUsd = Math.min(5, Math.max(0.01, Number(body["budgetUsd"] ?? 0.3)));
          return send(res, 202, { id: startPromptEval(family, versions, models, body["ensemble"] === true, budgetUsd) });
        }
      } catch (e) {
        if (e instanceof HttpError) throw e;
        throw new HttpError(400, e instanceof Error ? e.message : String(e));
      }
      throw new HttpError(405, "method not allowed");
    }
    if (req.method === "GET" && path === "/api/config/watchlist") {
      return send(res, 200, {
        watchlist: s.config.watchlist, benchmark: s.config.market.benchmark ?? "", currency: s.config.market.currency,
        history: watchlistHistory(s, 30),
        heldNotWatched: Object.keys(s.heldTickers()).filter((t) => !(t in s.config.watchlist)),
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
