import type { EvalReport } from "../eval/promptEval.ts";
import type { Db } from "../util/db.ts";
import type { PromptFamily } from "./registry.ts";

export interface PromptSwitch {
  at: string;
  family: PromptFamily;
  from: string;
  to: string;
  source: string;
}

export type EvalJobStatus = "queued" | "running" | "done" | "failed";

export interface EvalJob {
  id: number;
  family: PromptFamily;
  versions: string[];
  models: string[];
  ensemble: boolean;
  budgetUsd: number;
  status: EvalJobStatus;
  createdAt: string;
  finishedAt: string | null;
  error: string | null;
  /** One line per version × model (and ensemble), without the per-case failures. */
  summary: Array<{ version: string; model: string; accuracy: number | null; accepted: number | null; n: number; costUsd: number }>;
  stoppedByBudget: boolean;
  set: string | null;
  reviewedShare: number | null;
}

/** Which prompt was active when (for the scorecard and the UI timeline), and evaluation jobs. */
export class PromptStore {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
    db.exec(`
      CREATE TABLE IF NOT EXISTS prompt_switches (at TEXT, family TEXT, from_version TEXT, to_version TEXT, source TEXT);
      CREATE TABLE IF NOT EXISTS prompt_evals (
        id INTEGER PRIMARY KEY AUTOINCREMENT, family TEXT, versions_json TEXT, models_json TEXT, ensemble INT, budget REAL,
        status TEXT, created_at TEXT, finished_at TEXT, error TEXT, report_json TEXT);`);
  }

  logSwitch(s: PromptSwitch): void {
    this.#db.prepare("INSERT INTO prompt_switches VALUES (?,?,?,?,?)").run(s.at, s.family, s.from, s.to, s.source);
  }

  switches(limit = 50): PromptSwitch[] {
    const rows = this.#db.prepare("SELECT * FROM prompt_switches ORDER BY at DESC LIMIT ?").all(limit) as Array<{ at: string; family: PromptFamily; from_version: string; to_version: string; source: string }>;
    return rows.map((r) => ({ at: r.at, family: r.family, from: r.from_version, to: r.to_version, source: r.source }));
  }

  createEval(j: { family: PromptFamily; versions: string[]; models: string[]; ensemble: boolean; budgetUsd: number }, at: Date = new Date()): number {
    const r = this.#db
      .prepare("INSERT INTO prompt_evals (family, versions_json, models_json, ensemble, budget, status, created_at) VALUES (?,?,?,?,?,?,?)")
      .run(j.family, JSON.stringify(j.versions), JSON.stringify(j.models), j.ensemble ? 1 : 0, j.budgetUsd, "queued", at.toISOString());
    return Number(r.lastInsertRowid);
  }

  setEval(id: number, status: EvalJobStatus, r: { report?: EvalReport; error?: string } = {}, at: Date = new Date()): void {
    this.#db
      .prepare("UPDATE prompt_evals SET status = ?, finished_at = ?, error = ?, report_json = COALESCE(?, report_json) WHERE id = ?")
      .run(status, status === "done" || status === "failed" ? at.toISOString() : null, r.error ?? null, r.report ? JSON.stringify(r.report) : null, id);
  }

  #row(r: Record<string, unknown>): EvalJob {
    const report = r["report_json"] ? (JSON.parse(String(r["report_json"])) as EvalReport) : null;
    const summary = report
      ? [
          ...report.rows.map((x) => ({ version: x.version, model: x.model, accuracy: x.accuracy, accepted: x.n ? x.accepted / x.n : null, n: x.n, costUsd: x.costUsd })),
          ...report.ensemble.map((x) => ({ version: x.version, model: `合議 ${x.members}`, accuracy: x.precision, accepted: x.coverage, n: x.n, costUsd: x.costUsd })),
        ]
      : [];
    return {
      id: Number(r["id"]), family: r["family"] as PromptFamily, versions: JSON.parse(String(r["versions_json"])), models: JSON.parse(String(r["models_json"])),
      ensemble: r["ensemble"] === 1, budgetUsd: Number(r["budget"]), status: r["status"] as EvalJobStatus, createdAt: String(r["created_at"]),
      finishedAt: (r["finished_at"] as string | null) ?? null, error: (r["error"] as string | null) ?? null, summary,
      stoppedByBudget: report?.stoppedByBudget ?? false, set: report?.set ?? null, reviewedShare: report?.reviewedShare ?? null,
    };
  }

  evals(family?: PromptFamily, limit = 30): EvalJob[] {
    const rows = (family
      ? this.#db.prepare("SELECT * FROM prompt_evals WHERE family = ? ORDER BY id DESC LIMIT ?").all(family, limit)
      : this.#db.prepare("SELECT * FROM prompt_evals ORDER BY id DESC LIMIT ?").all(limit)) as Array<Record<string, unknown>>;
    return rows.map((r) => this.#row(r));
  }

  evalReport(id: number): { job: EvalJob; report: EvalReport | null } | null {
    const r = this.#db.prepare("SELECT * FROM prompt_evals WHERE id = ?").get(id) as Record<string, unknown> | undefined;
    if (!r) return null;
    return { job: this.#row(r), report: r["report_json"] ? (JSON.parse(String(r["report_json"])) as EvalReport) : null };
  }

  /** Jobs left queued/running by a restart can never finish. */
  failStale(at: Date = new Date()): void {
    this.#db.prepare("UPDATE prompt_evals SET status = 'failed', error = 'interrupted (server restarted)', finished_at = ? WHERE status IN ('queued','running')").run(at.toISOString());
  }
}
