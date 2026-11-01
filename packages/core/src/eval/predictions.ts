import type { Stance } from "../ai/judge.ts";
import type { Db } from "../util/db.ts";
import type { IsoDate } from "../util/dates.ts";

export interface Prediction {
  label: string;
  asOf: IsoDate;
  ticker: string;
  stance: Stance;
  conviction: number;
  status: string;
  runId: string;
}

/** Every judgment is recorded so it can be graded against what actually happened. */
export class PredictionStore {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
    db.exec(`CREATE TABLE IF NOT EXISTS predictions (
      label TEXT, as_of TEXT, ticker TEXT, stance TEXT, conviction REAL, status TEXT, run_id TEXT,
      PRIMARY KEY (label, as_of, ticker))`);
  }

  record(preds: readonly Prediction[]): number {
    const st = this.#db.prepare("INSERT OR REPLACE INTO predictions VALUES (?,?,?,?,?,?,?)");
    for (const p of preds) st.run(p.label, p.asOf, p.ticker, p.stance, p.conviction, p.status, p.runId);
    return preds.length;
  }

  all(until?: IsoDate): Prediction[] {
    const rows = (until
      ? this.#db.prepare("SELECT * FROM predictions WHERE as_of <= ? ORDER BY as_of, label, ticker").all(until)
      : this.#db.prepare("SELECT * FROM predictions ORDER BY as_of, label, ticker").all()) as Array<{
      label: string; as_of: string; ticker: string; stance: Stance; conviction: number; status: string; run_id: string;
    }>;
    return rows.map((r) => ({ label: r.label, asOf: r.as_of, ticker: r.ticker, stance: r.stance, conviction: r.conviction, status: r.status, runId: r.run_id }));
  }
}
