import type { Db } from "../util/db.ts";

/** H4: content-addressed cache of *validated* LLM outputs. Never pay twice for the same input. */
export class LLMCache {
  readonly #db: Db;

  constructor(db: Db) {
    this.#db = db;
    db.exec("CREATE TABLE IF NOT EXISTS llm_cache (key TEXT PRIMARY KEY, value TEXT, created_at TEXT)");
  }

  get(key: string): unknown {
    const row = this.#db.prepare("SELECT value FROM llm_cache WHERE key = ?").get(key) as { value: string } | undefined;
    return row ? JSON.parse(row.value) : undefined;
  }

  put(key: string, value: unknown): void {
    this.#db
      .prepare("INSERT OR REPLACE INTO llm_cache VALUES (?,?,?)")
      .run(key, JSON.stringify(value), new Date().toISOString());
  }
}
