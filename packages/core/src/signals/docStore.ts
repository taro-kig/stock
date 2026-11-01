import type { EnsembleResult } from "../harness/ensemble.ts";
import type { Db } from "../util/db.ts";
import { docHash, EventExtraction, type Document, type EventRecord } from "./models.ts";

/** Point-in-time record of documents and ensemble outcomes (DESIGN §8). */
export class DocStore {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
    db.exec(`
      CREATE TABLE IF NOT EXISTS documents (
        hash TEXT PRIMARY KEY, source TEXT, url TEXT, title TEXT, body TEXT, published_at TEXT,
        fetched_at TEXT, source_weight REAL, n_sources INT);
      CREATE TABLE IF NOT EXISTS extractions (
        hash TEXT, prompt_version TEXT, status TEXT, agreement REAL, result_json TEXT, votes_json TEXT,
        created_at TEXT, PRIMARY KEY (hash, prompt_version));`);
  }

  saveDocument(doc: Document): void {
    this.#db
      .prepare("INSERT OR IGNORE INTO documents VALUES (?,?,?,?,?,?,?,?,?)")
      .run(docHash(doc), doc.source, doc.url, doc.title, doc.body, doc.publishedAt, doc.fetchedAt, doc.sourceWeight, 1 + doc.alsoSeenIn.length);
  }

  getExtraction(doc: Document, promptVersion: string): { status: string; agreement: number; value: EventExtraction | null } | undefined {
    const row = this.#db.prepare("SELECT status, agreement, result_json FROM extractions WHERE hash = ? AND prompt_version = ?").get(docHash(doc), promptVersion) as
      | { status: string; agreement: number; result_json: string | null }
      | undefined;
    if (!row) return undefined;
    return { status: row.status, agreement: row.agreement, value: row.result_json ? EventExtraction.parse(JSON.parse(row.result_json)) : null };
  }

  saveExtraction(doc: Document, promptVersion: string, res: EnsembleResult<EventExtraction>): void {
    this.#db
      .prepare("INSERT OR REPLACE INTO extractions VALUES (?,?,?,?,?,?,?)")
      .run(docHash(doc), promptVersion, res.status, res.agreement, res.value ? JSON.stringify(res.value) : null, JSON.stringify(res.votes), new Date().toISOString());
  }

  /** Accepted, relevant events learned within [since, until] — never later than `until`. */
  acceptedEvents(since: Date, until: Date, promptVersion: string): EventRecord[] {
    const rows = this.#db
      .prepare(
        `SELECT d.hash, d.title, d.url, d.source, d.fetched_at, d.source_weight, d.n_sources, e.agreement, e.result_json
         FROM extractions e JOIN documents d ON d.hash = e.hash
         WHERE e.prompt_version = ? AND e.status IN ('consensus','escalated') AND e.result_json IS NOT NULL
           AND d.fetched_at >= ? AND d.fetched_at <= ?
         ORDER BY d.fetched_at`,
      )
      .all(promptVersion, since.toISOString(), until.toISOString()) as Array<{
      hash: string; title: string; url: string; source: string; fetched_at: string;
      source_weight: number; n_sources: number; agreement: number; result_json: string;
    }>;
    return rows
      .map((r) => ({
        docHash: r.hash, title: r.title, url: r.url, source: r.source, learnedAt: r.fetched_at,
        agreement: r.agreement, sourceWeight: r.source_weight, nSources: r.n_sources,
        event: EventExtraction.parse(JSON.parse(r.result_json)),
      }))
      .filter((r) => r.event.relevant);
  }
}
