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
  /** Prompt versions behind an AI judgment (null for rules / older records). */
  prompt?: string | null;
  /** Why (AI judgments; null for rules / older records): read back as "the previous judgment". */
  thesis?: string | null;
  invalidation?: string[] | null;
  /** Every model's answer, so accuracy can be split by model. */
  votes?: PredictionVote[] | null;
  /** Events the fact sheet listed (type and direction), so accuracy can be split by event type. */
  events?: Array<{ eventType: string; direction: number }> | null;
}

export interface PredictionVote {
  provider: string;
  model?: string | undefined;
  stance: Stance | null;
  rejected: boolean;
}

const EXTRA = ["prompt", "thesis", "invalidation_json", "votes_json", "events_json"] as const;
type Row = {
  label: string; as_of: string; ticker: string; stance: Stance; conviction: number; status: string; run_id: string;
  prompt: string | null; thesis: string | null; invalidation_json: string | null; votes_json: string | null; events_json: string | null;
};
const parse = <T,>(s: string | null): T | null => {
  if (!s) return null;
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
};
const fromRow = (r: Row): Prediction => ({
  label: r.label, asOf: r.as_of, ticker: r.ticker, stance: r.stance, conviction: r.conviction, status: r.status, runId: r.run_id,
  prompt: r.prompt, thesis: r.thesis, invalidation: parse(r.invalidation_json), votes: parse(r.votes_json), events: parse(r.events_json),
});

/** Every judgment is recorded so it can be graded against what actually happened. */
export class PredictionStore {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
    db.exec(`CREATE TABLE IF NOT EXISTS predictions (
      label TEXT, as_of TEXT, ticker TEXT, stance TEXT, conviction REAL, status TEXT, run_id TEXT,
      PRIMARY KEY (label, as_of, ticker))`);
    const cols = db.prepare("PRAGMA table_info(predictions)").all() as Array<{ name: string }>;
    for (const c of EXTRA) if (!cols.some((x) => x.name === c)) db.exec(`ALTER TABLE predictions ADD COLUMN ${c} TEXT`);
  }

  record(preds: readonly Prediction[]): number {
    const st = this.#db.prepare(
      "INSERT OR REPLACE INTO predictions (label, as_of, ticker, stance, conviction, status, run_id, prompt, thesis, invalidation_json, votes_json, events_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
    );
    const json = (x: unknown) => (x === undefined || x === null ? null : JSON.stringify(x));
    for (const p of preds) {
      st.run(p.label, p.asOf, p.ticker, p.stance, p.conviction, p.status, p.runId, p.prompt ?? null, p.thesis ?? null, json(p.invalidation), json(p.votes), json(p.events));
    }
    return preds.length;
  }

  /** The latest prediction for a ticker strictly before `asOf` (point in time: "what did we think last time"). */
  previous(label: string, ticker: string, asOf: IsoDate): Prediction | null {
    const r = this.#db.prepare("SELECT * FROM predictions WHERE label = ? AND ticker = ? AND as_of < ? ORDER BY as_of DESC LIMIT 1").get(label, ticker, asOf) as Row | undefined;
    return r ? fromRow(r) : null;
  }

  all(until?: IsoDate): Prediction[] {
    const rows = (until
      ? this.#db.prepare("SELECT * FROM predictions WHERE as_of <= ? ORDER BY as_of, label, ticker").all(until)
      : this.#db.prepare("SELECT * FROM predictions ORDER BY as_of, label, ticker").all()) as Row[];
    return rows.map(fromRow);
  }
}
