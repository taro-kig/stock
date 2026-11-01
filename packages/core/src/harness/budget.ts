import type { Db } from "../util/db.ts";
import type { LLMResponse } from "../llm/types.ts";

/** USD per 1M tokens: [input, output]. */
export type Pricing = Record<string, readonly [number, number]>;

/**
 * Charged for models missing from the pricing table. Deliberately pessimistic,
 * so a config mistake makes us stop early instead of overspending silently.
 */
export const FALLBACK_PRICE_PER_M: readonly [number, number] = [2, 10];

export class BudgetExceeded extends Error {
  override name = "BudgetExceeded";
}

/** H5: cost accounting and a hard daily budget cap. */
export class CostTracker {
  readonly #db: Db;
  readonly pricing: Pricing;
  readonly dailyLimitUsd: number;
  readonly #now: () => Date;

  constructor(db: Db, opts: { pricing?: Pricing; dailyLimitUsd?: number; now?: () => Date } = {}) {
    this.#db = db;
    this.pricing = opts.pricing ?? {};
    this.dailyLimitUsd = opts.dailyLimitUsd ?? 1;
    this.#now = opts.now ?? (() => new Date());
    db.exec(`CREATE TABLE IF NOT EXISTS llm_calls (
      ts TEXT, day TEXT, provider TEXT, model TEXT, input_tokens INT, output_tokens INT,
      cost_usd REAL, latency_ms REAL)`);
  }

  costOf(model: string, inputTokens: number, outputTokens: number): number {
    const [pIn, pOut] = this.pricing[model] ?? FALLBACK_PRICE_PER_M;
    return (inputTokens * pIn + outputTokens * pOut) / 1_000_000;
  }

  #day(): string {
    return this.#now().toISOString().slice(0, 10);
  }

  spentToday(): number {
    const row = this.#db.prepare("SELECT COALESCE(SUM(cost_usd), 0) AS s FROM llm_calls WHERE day = ?").get(this.#day()) as
      | { s: number }
      | undefined;
    return Number(row?.s ?? 0);
  }

  /** Throws BudgetExceeded once today's spend has reached the cap. */
  check(): void {
    const spent = this.spentToday();
    if (spent >= this.dailyLimitUsd) {
      throw new BudgetExceeded(`daily LLM budget reached: $${spent.toFixed(4)} >= $${this.dailyLimitUsd}`);
    }
  }

  record(provider: string, resp: LLMResponse): number {
    const cost = this.costOf(resp.model, resp.inputTokens, resp.outputTokens);
    this.#db
      .prepare("INSERT INTO llm_calls VALUES (?,?,?,?,?,?,?,?)")
      .run(this.#now().toISOString(), this.#day(), provider, resp.model, resp.inputTokens, resp.outputTokens, cost, resp.latencyMs);
    return cost;
  }

  summaryToday(): Array<{ provider: string; calls: number; inputTokens: number; outputTokens: number; costUsd: number }> {
    const rows = this.#db
      .prepare(
        `SELECT provider, COUNT(*) AS calls, SUM(input_tokens) AS i, SUM(output_tokens) AS o, SUM(cost_usd) AS c
         FROM llm_calls WHERE day = ? GROUP BY provider ORDER BY provider`,
      )
      .all(this.#day()) as Array<{ provider: string; calls: number; i: number; o: number; c: number }>;
    return rows.map((r) => ({ provider: r.provider, calls: r.calls, inputTokens: r.i, outputTokens: r.o, costUsd: r.c }));
  }
}
