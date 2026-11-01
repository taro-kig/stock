import type { Db } from "../util/db.ts";
import { sha256, stableStringify } from "../util/hash.ts";
import type { Approval } from "./context.ts";

export type NodeStatus = "pending" | "ok" | "cached" | "fallback" | "failed" | "skipped" | "waiting";
export type RunStatus = "running" | "succeeded" | "partial" | "failed" | "waiting";

export interface RunRow {
  runId: string;
  workflow: string;
  asOf: string;
  status: RunStatus;
  createdAt: string;
  finishedAt: string | null;
  specJson: string;
}

export interface NodeRunRow {
  nodeId: string;
  type: string;
  status: NodeStatus;
  startedAt: string | null;
  durationMs: number;
  /** output port -> artifact hash */
  outputs: Record<string, string>;
  error: string | null;
  metrics: Record<string, number>;
  summary: Record<string, unknown>;
}

export interface RunEvent {
  seq: number;
  ts: string;
  type: "run_started" | "node_finished" | "run_finished" | "log";
  [k: string]: unknown;
}

/** Rejects NaN/Infinity/Date etc. so artifacts round-trip exactly through JSON. */
function strictJson(value: unknown): string {
  return JSON.stringify(value, function (key, v: unknown) {
    if (typeof v === "number" && !Number.isFinite(v)) throw new Error(`non-finite number in node output at "${key}"`);
    if (typeof v === "bigint" || typeof v === "function" || typeof v === "symbol") throw new Error(`non-JSON value in node output at "${key}"`);
    const raw = (this as Record<string, unknown>)[key];
    if (raw instanceof Date || raw instanceof Map || raw instanceof Set) throw new Error(`use plain JSON (not ${raw.constructor.name}) at "${key}"`);
    return v;
  });
}

/** Summary shown in run views without loading the artifact. */
export function summarize(value: unknown): Record<string, unknown> {
  if (Array.isArray(value)) return { kind: "array", length: value.length };
  if (value && typeof value === "object") return { kind: "object", keys: Object.keys(value).length };
  return { kind: typeof value, value };
}

/** Persistence for workflow runs: run/node records, content-addressed artifacts, node cache, events, approvals. */
export class RunStore {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
    db.exec(`
      CREATE TABLE IF NOT EXISTS wf_runs (
        run_id TEXT PRIMARY KEY, workflow TEXT, as_of TEXT, status TEXT, created_at TEXT, finished_at TEXT, spec_json TEXT);
      CREATE TABLE IF NOT EXISTS wf_node_runs (
        run_id TEXT, node_id TEXT, type TEXT, status TEXT, started_at TEXT, duration_ms REAL, outputs_json TEXT,
        error TEXT, metrics_json TEXT, summary_json TEXT, PRIMARY KEY (run_id, node_id));
      CREATE TABLE IF NOT EXISTS wf_artifacts (hash TEXT PRIMARY KEY, json TEXT, size INT, created_at TEXT);
      CREATE TABLE IF NOT EXISTS wf_node_cache (key TEXT PRIMARY KEY, outputs_json TEXT, created_at TEXT);
      CREATE TABLE IF NOT EXISTS wf_events (run_id TEXT, seq INT, ts TEXT, json TEXT, PRIMARY KEY (run_id, seq));
      CREATE TABLE IF NOT EXISTS wf_approvals (
        run_id TEXT, node_id TEXT, decision TEXT, note TEXT, decided_at TEXT, PRIMARY KEY (run_id, node_id));
      CREATE TABLE IF NOT EXISTS wf_disabled (workflow TEXT PRIMARY KEY, disabled_at TEXT, note TEXT);`);
  }

  /** Disabled workflows are not started (schedule, UI, CLI). Runs already waiting can still be decided. */
  disabled(workflow: string): { since: string; note: string } | null {
    const r = this.#db.prepare("SELECT disabled_at, note FROM wf_disabled WHERE workflow = ?").get(workflow) as { disabled_at: string; note: string } | undefined;
    return r ? { since: r.disabled_at, note: r.note } : null;
  }

  setDisabled(workflow: string, disabled: boolean, note = "", at: Date = new Date()): void {
    if (disabled) this.#db.prepare("INSERT OR REPLACE INTO wf_disabled VALUES (?,?,?)").run(workflow, at.toISOString(), note);
    else this.#db.prepare("DELETE FROM wf_disabled WHERE workflow = ?").run(workflow);
  }

  createRun(runId: string, workflow: string, asOf: string, specJson: string, createdAt: Date = new Date()): void {
    this.#db.prepare("INSERT INTO wf_runs VALUES (?,?,?,?,?,?,?)").run(runId, workflow, asOf, "running", createdAt.toISOString(), null, specJson);
  }

  setRunStatus(runId: string, status: RunStatus): void {
    const finished = status === "running" || status === "waiting" ? null : new Date().toISOString();
    this.#db.prepare("UPDATE wf_runs SET status = ?, finished_at = ? WHERE run_id = ?").run(status, finished, runId);
  }

  getRun(runId: string): RunRow | undefined {
    const r = this.#db.prepare("SELECT * FROM wf_runs WHERE run_id = ?").get(runId) as Record<string, string | null> | undefined;
    return r ? toRun(r) : undefined;
  }

  listRuns(limit = 20, workflow?: string): RunRow[] {
    const rows = workflow
      ? this.#db.prepare("SELECT * FROM wf_runs WHERE workflow = ? ORDER BY created_at DESC LIMIT ?").all(workflow, limit)
      : this.#db.prepare("SELECT * FROM wf_runs ORDER BY created_at DESC LIMIT ?").all(limit);
    return (rows as Array<Record<string, string | null>>).map(toRun);
  }

  /** Stores a value; returns its content hash. */
  putArtifact(value: unknown): string {
    const json = strictJson(value) ?? "null";
    const hash = sha256(json);
    this.#db.prepare("INSERT OR IGNORE INTO wf_artifacts VALUES (?,?,?,?)").run(hash, json, json.length, new Date().toISOString());
    return hash;
  }

  getArtifact(hash: string): unknown {
    const r = this.#db.prepare("SELECT json FROM wf_artifacts WHERE hash = ?").get(hash) as { json: string } | undefined;
    if (!r) throw new Error(`artifact not found: ${hash}`);
    return JSON.parse(r.json);
  }

  cacheGet(key: string): Record<string, string> | undefined {
    const r = this.#db.prepare("SELECT outputs_json FROM wf_node_cache WHERE key = ?").get(key) as { outputs_json: string } | undefined;
    return r ? (JSON.parse(r.outputs_json) as Record<string, string>) : undefined;
  }

  cachePut(key: string, outputs: Record<string, string>): void {
    this.#db.prepare("INSERT OR REPLACE INTO wf_node_cache VALUES (?,?,?)").run(key, stableStringify(outputs), new Date().toISOString());
  }

  saveNodeRun(runId: string, n: NodeRunRow): void {
    this.#db
      .prepare("INSERT OR REPLACE INTO wf_node_runs VALUES (?,?,?,?,?,?,?,?,?,?)")
      .run(runId, n.nodeId, n.type, n.status, n.startedAt, n.durationMs, JSON.stringify(n.outputs), n.error, JSON.stringify(n.metrics), JSON.stringify(n.summary));
  }

  nodeRuns(runId: string): NodeRunRow[] {
    const rows = this.#db.prepare("SELECT * FROM wf_node_runs WHERE run_id = ? ORDER BY rowid").all(runId) as Array<Record<string, string | number | null>>;
    return rows.map((r) => ({
      nodeId: String(r["node_id"]), type: String(r["type"]), status: r["status"] as NodeStatus,
      startedAt: (r["started_at"] as string | null) ?? null, durationMs: Number(r["duration_ms"] ?? 0),
      outputs: JSON.parse(String(r["outputs_json"] ?? "{}")) as Record<string, string>,
      error: (r["error"] as string | null) ?? null,
      metrics: JSON.parse(String(r["metrics_json"] ?? "{}")) as Record<string, number>,
      summary: JSON.parse(String(r["summary_json"] ?? "{}")) as Record<string, unknown>,
    }));
  }

  addEvent(runId: string, event: Omit<RunEvent, "seq" | "ts">): RunEvent {
    const r = this.#db.prepare("SELECT COALESCE(MAX(seq), 0) AS m FROM wf_events WHERE run_id = ?").get(runId) as { m: number };
    const full = { ...event, seq: r.m + 1, ts: new Date().toISOString() } as RunEvent;
    this.#db.prepare("INSERT INTO wf_events VALUES (?,?,?,?)").run(runId, full.seq, full.ts, JSON.stringify(full));
    return full;
  }

  /** Events after `afterSeq` — a UI can poll this to animate a live run. */
  events(runId: string, afterSeq = 0): RunEvent[] {
    const rows = this.#db.prepare("SELECT json FROM wf_events WHERE run_id = ? AND seq > ? ORDER BY seq").all(runId, afterSeq) as Array<{ json: string }>;
    return rows.map((r) => JSON.parse(r.json) as RunEvent);
  }

  setApproval(runId: string, nodeId: string, decision: Approval["decision"], note = ""): void {
    this.#db.prepare("INSERT OR REPLACE INTO wf_approvals VALUES (?,?,?,?,?)").run(runId, nodeId, decision, note, new Date().toISOString());
  }

  getApproval(runId: string, nodeId: string): Approval | undefined {
    const r = this.#db.prepare("SELECT decision, note, decided_at FROM wf_approvals WHERE run_id = ? AND node_id = ?").get(runId, nodeId) as
      | { decision: Approval["decision"]; note: string; decided_at: string }
      | undefined;
    return r ? { decision: r.decision, note: r.note, decidedAt: r.decided_at } : undefined;
  }
}

function toRun(r: Record<string, string | null>): RunRow {
  return {
    runId: r["run_id"]!, workflow: r["workflow"]!, asOf: r["as_of"]!, status: r["status"] as RunStatus,
    createdAt: r["created_at"]!, finishedAt: r["finished_at"] ?? null, specJson: r["spec_json"]!,
  };
}
