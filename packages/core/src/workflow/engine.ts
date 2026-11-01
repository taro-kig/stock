import { randomUUID } from "node:crypto";
import type { Services } from "../services.ts";
import { endOfDay, toIsoDate, type IsoDate } from "../util/dates.ts";
import { sha256, stableStringify } from "../util/hash.ts";
import { WaitingForInput, type NodeContext } from "./context.ts";
import type { NodeRegistry } from "./registry.ts";
import { summarize, type NodeRunRow, type NodeStatus, type RunEvent, type RunStatus, type RunStore } from "./runStore.ts";
import { dependencies, resolveRef, topoOrder, validateWorkflow, WorkflowError, WorkflowSpec } from "./spec.ts";

const OK: ReadonlySet<NodeStatus> = new Set(["ok", "cached", "fallback"]);

export interface RunResult {
  runId: string;
  workflow: string;
  asOf: IsoDate;
  status: RunStatus;
  nodes: Record<string, NodeRunRow>;
  /** Output value of a node port (loaded from the artifact store). */
  output<T = unknown>(nodeId: string, port: string): T;
}

export interface EngineOptions {
  services: Services;
  registry: NodeRegistry;
  store: RunStore;
  onEvent?: (runId: string, e: RunEvent) => void;
  /** Wall clock (defaults to real time). A run is "live" when its date is the clock's date. */
  clock?: () => Date;
}

/**
 * Executes workflow specs: validation, deterministic topological order, per-node
 * cache, error policies, pausing for approvals, resuming, and an event log.
 * Nodes run sequentially — this is a daily batch system, clarity beats speed.
 */
export class Engine {
  readonly #o: EngineOptions;
  readonly #clock: () => Date;

  constructor(opts: EngineOptions) {
    this.#o = opts;
    this.#clock = opts.clock ?? (() => new Date());
  }

  validate(spec: WorkflowSpec): void {
    const problems = validateWorkflow(spec, this.#o.registry);
    if (problems.length) throw new WorkflowError(problems);
  }

  async run(spec: WorkflowSpec, opts: { asOf?: IsoDate; runId?: string } = {}): Promise<RunResult> {
    this.validate(spec);
    const asOf = opts.asOf ?? toIsoDate(this.#clock());
    const runId = opts.runId ?? `${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14)}-${spec.name}-${randomUUID().slice(0, 6)}`;
    this.#o.store.createRun(runId, spec.name, asOf, JSON.stringify(spec));
    return this.#execute(spec, runId, asOf, {});
  }

  /** Re-runs everything that did not finish (waiting / pending / failed / skipped). */
  async resume(runId: string): Promise<RunResult> {
    const run = this.#o.store.getRun(runId);
    if (!run) throw new Error(`unknown run: ${runId}`);
    const spec = WorkflowSpec.parse(JSON.parse(run.specJson));
    this.validate(spec);
    const prior = Object.fromEntries(this.#o.store.nodeRuns(runId).map((n) => [n.nodeId, n]));
    this.#o.store.setRunStatus(runId, "running");
    return this.#execute(spec, runId, run.asOf, prior);
  }

  #emit(runId: string, e: Omit<RunEvent, "seq" | "ts">): void {
    const full = this.#o.store.addEvent(runId, e);
    this.#o.onEvent?.(runId, full);
  }

  async #execute(spec: WorkflowSpec, runId: string, asOf: IsoDate, prior: Record<string, NodeRunRow>): Promise<RunResult> {
    const { registry, store, services } = this.#o;
    const live = asOf === toIsoDate(this.#clock());
    const now = live ? this.#clock() : endOfDay(asOf);
    const runCreatedAt = new Date(store.getRun(runId)!.createdAt);
    const values = new Map<string, Record<string, unknown>>();
    const results: Record<string, NodeRunRow> = {};
    let aborted = false;

    this.#emit(runId, { type: "run_started", workflow: spec.name, asOf, resumed: Object.keys(prior).length > 0 });

    for (const id of topoOrder(spec)) {
      const cfg = spec.nodes[id]!;
      const def = registry.get(cfg.use)!;
      const base: NodeRunRow = { nodeId: id, type: def.type, status: "pending", startedAt: null, durationMs: 0, outputs: {}, error: null, metrics: {}, summary: {} };
      const finish = (row: NodeRunRow) => {
        results[id] = row;
        store.saveNodeRun(runId, row);
        this.#emit(runId, { type: "node_finished", node: id, status: row.status, durationMs: row.durationMs, error: row.error, metrics: row.metrics, summary: row.summary });
      };

      const prev = prior[id];
      if (prev && OK.has(prev.status)) {
        values.set(id, Object.fromEntries(Object.entries(prev.outputs).map(([p, h]) => [p, store.getArtifact(h)])));
        results[id] = prev;
        continue;
      }
      if (aborted) {
        finish({ ...base, status: "skipped", error: "run aborted upstream" });
        continue;
      }

      // dependency gate: optional inputs from a non-ok upstream become undefined
      const optionalSources = new Set(
        Object.entries(cfg.in).filter(([port]) => def.inputs[port]?.optional).map(([, ref]) => ref.split(".")[0]!),
      );
      const requiredSources = new Set(
        Object.entries(cfg.in).filter(([port]) => !def.inputs[port]?.optional).map(([, ref]) => ref.split(".")[0]!),
      );
      const deps = dependencies(spec, id).map((d) => ({ d, s: results[d]!.status }));
      if (deps.some(({ s }) => s === "waiting" || s === "pending")) {
        finish({ ...base, status: "pending", error: "waiting on upstream" });
        continue;
      }
      const bad = deps.filter(({ d, s }) => !OK.has(s) && (requiredSources.has(d) || !optionalSources.has(d)));
      if (bad.length) {
        finish({ ...base, status: "skipped", error: `upstream ${bad.map(({ d, s }) => `${d}=${s}`).join(", ")}` });
        continue;
      }

      const inputs: Record<string, unknown> = {};
      const inputHashes: Record<string, string> = {};
      for (const port of Object.keys(def.inputs)) {
        const ref = cfg.in[port];
        if (!ref) continue;
        const r = resolveRef(ref, spec, registry);
        if (typeof r === "string" || !OK.has(results[r.node]!.status)) continue;
        inputs[port] = values.get(r.node)![r.port];
        inputHashes[port] = results[r.node]!.outputs[r.port]!;
      }
      const params = def.params.parse(cfg.params);
      const cacheKey =
        cfg.cache && def.cache !== "none"
          ? sha256(def.type, String(def.version), stableStringify(params), stableStringify(inputHashes), def.cache === "daily" ? asOf : "")
          : null;

      const startedAt = new Date();
      const hit = cacheKey ? store.cacheGet(cacheKey) : undefined;
      if (hit) {
        const out = Object.fromEntries(Object.entries(hit).map(([p, h]) => [p, store.getArtifact(h)]));
        values.set(id, out);
        finish({ ...base, status: "cached", startedAt: startedAt.toISOString(), outputs: hit, summary: summaries(out) });
        continue;
      }

      const metrics: Record<string, number> = {};
      const ctx: NodeContext = {
        runId, workflow: spec.name, nodeId: id, asOf, now, live, runCreatedAt, services,
        log: (message, data) => this.#emit(runId, { type: "log", node: id, message, data }),
        metric: (name, v) => {
          metrics[name] = (metrics[name] ?? 0) + v;
        },
        approval: () => store.getApproval(runId, id),
      };
      const costBefore = services.costSnapshot();
      let status: NodeStatus;
      let out: Record<string, unknown> | undefined;
      let error: string | null = null;
      try {
        out = await def.run(ctx, params, inputs as never);
        const missing = Object.keys(def.outputs).filter((p) => !(p in out!));
        if (missing.length) throw new Error(`node returned no value for output(s): ${missing.join(", ")}`);
        status = "ok";
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
        if (e instanceof WaitingForInput) status = "waiting";
        else if (cfg.onError === "fallback" && def.fallback) {
          out = def.fallback(params);
          status = "fallback";
        } else {
          status = "failed";
          if (cfg.onError === "abort") aborted = true;
        }
      }
      const cost = services.costSnapshot() - costBefore;
      if (cost > 0) metrics["costUsd"] = cost;

      const hashes: Record<string, string> = {};
      if (out) {
        try {
          for (const p of Object.keys(def.outputs)) hashes[p] = store.putArtifact(out[p]);
        } catch (e) {
          status = "failed";
          error = `output not storable: ${e instanceof Error ? e.message : String(e)}`;
          out = undefined;
          if (cfg.onError === "abort") aborted = true;
        }
      }
      if (out) values.set(id, out);
      if (status === "ok" && cacheKey) store.cachePut(cacheKey, hashes);
      finish({
        ...base, status, startedAt: startedAt.toISOString(), durationMs: Date.now() - startedAt.getTime(),
        outputs: hashes, error, metrics, summary: out ? summaries(out) : {},
      });
    }

    const statuses = Object.values(results).map((r) => r.status);
    const runStatus: RunStatus = aborted
      ? "failed"
      : statuses.some((s) => s === "waiting" || s === "pending")
        ? "waiting"
        : statuses.every((s) => s === "ok" || s === "cached")
          ? "succeeded"
          : "partial";
    store.setRunStatus(runId, runStatus);
    this.#emit(runId, { type: "run_finished", status: runStatus });

    return {
      runId, workflow: spec.name, asOf, status: runStatus, nodes: results,
      output: <T>(nodeId: string, port: string): T => {
        const h = results[nodeId]?.outputs[port];
        if (!h) throw new Error(`no output ${nodeId}.${port} (status ${results[nodeId]?.status ?? "unknown"})`);
        return store.getArtifact(h) as T;
      },
    };
  }
}

function summaries(out: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, summarize(v)]));
}
