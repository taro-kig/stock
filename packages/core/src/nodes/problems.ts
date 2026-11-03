import type { NodeContext } from "../workflow/context.ts";

/**
 * LLM calls that failed inside a vote (bad key, unknown model name, network, quota) or kept
 * answering in the wrong format. The ensemble treats them as abstentions, which is the safe
 * outcome, but on its own it would leave the node green with no hint why nothing was found.
 * Each distinct problem is logged once (shown in the run view) and counted as a metric.
 */
export class VoteProblems {
  readonly #ctx: NodeContext;
  readonly #seen = new Set<string>();
  #llm = 0;
  #invalid = 0;

  constructor(ctx: NodeContext) {
    this.#ctx = ctx;
  }

  note(votes: ReadonlyArray<{ provider: string; rejected: string | null }>): void {
    for (const v of votes) {
      if (!v.rejected) continue;
      const llm = v.rejected.startsWith("llm:");
      if (!llm && !v.rejected.startsWith("invalid output")) continue; // grounding rejections are the harness working, not a problem
      if (llm) this.#llm++;
      else this.#invalid++;
      const key = `${v.provider}|${v.rejected.slice(0, 120)}`;
      if (this.#seen.has(key) || this.#seen.size >= 10) continue;
      this.#seen.add(key);
      this.#ctx.log(`${v.provider}: ${llm ? "call failed" : "unusable answer"} — ${v.rejected.slice(0, 300)}`);
    }
  }

  finish(): void {
    if (this.#llm) this.#ctx.metric("llmErrors", this.#llm);
    if (this.#invalid) this.#ctx.metric("invalidOutputs", this.#invalid);
  }
}

/** "AAPL: why" lines grouped by reason, for an error message: "AAPL, MSFT: why / SPY: other". */
export function groupFailures(failures: readonly string[], max = 3): string {
  const reasons = new Map<string, string[]>();
  for (const f of failures) {
    const i = f.indexOf(": ");
    const [who, why] = i > 0 ? [f.slice(0, i), f.slice(i + 2)] : ["", f];
    // "AAPL: 404 AAPL not found" and "MSFT: 404 MSFT not found" are the same reason
    const k = who ? why.split(who).join("…") : why;
    const list = reasons.get(k) ?? [];
    if (who) list.push(who);
    reasons.set(k, list);
  }
  return [...reasons]
    .slice(0, max)
    .map(([why, who]) => (who.length ? `${who.slice(0, 4).join(", ")}${who.length > 4 ? ` 他 ${who.length - 4}` : ""}: ${why}` : why))
    .join(" / ") + (reasons.size > max ? ` / 他 ${reasons.size - max} 種類` : "");
}
