import type { z } from "zod";
import type { LLMProvider } from "../llm/types.ts";
import type { CallArgs, StructuredCaller } from "./structured.ts";

/**
 * H3: cross-vendor voting with early stopping and conditional escalation.
 *
 * Members are called one by one and we stop as soon as `quorum` agree, so in
 * the common (easy) case we only pay for `quorum` calls. A stronger model is
 * consulted only when the cheap ones disagree *and* the item is important. It
 * acts as a tie-breaker and must agree with at least one cheap model, so with
 * quorum >= 2 no single model can ever create a signal on its own.
 */
export type EnsembleStatus = "consensus" | "escalated" | "no_consensus" | "failed";

export interface Vote<T> {
  provider: string;
  value: T | null;
  /** Why this vote was discarded (invalid output, ungrounded evidence, ...). */
  rejected: string | null;
  cached: boolean;
}

export interface EnsembleResult<T> {
  status: EnsembleStatus;
  value: T | null;
  /** Share of all votes cast that ended up in the winning group. */
  agreement: number;
  votes: Vote<T>[];
}

export interface EnsembleOptions<S extends z.ZodType, C> {
  caller: StructuredCaller;
  members: readonly LLMProvider[];
  schema: S;
  /** Votes with equal keys agree. */
  key: (v: z.output<S>) => string;
  /** Combine an agreeing group into one value (should be conservative). */
  merge: (group: z.output<S>[]) => z.output<S>;
  /** Deterministic checks; return a reason to reject the vote, or null. */
  validate?: (v: z.output<S>, ctx: C) => string | null;
  quorum?: number;
  escalation?: LLMProvider | undefined;
  shouldEscalate?: (values: z.output<S>[], ctx: C) => boolean;
}

export const isValidVote = <T>(v: Vote<T>): v is Vote<T> & { value: T } => v.value !== null && v.rejected === null;

export class Ensemble<S extends z.ZodType, C = undefined> {
  readonly #o: EnsembleOptions<S, C> & { quorum: number };

  constructor(opts: EnsembleOptions<S, C>) {
    const quorum = opts.quorum ?? 2;
    if (quorum < 1 || quorum > opts.members.length) throw new Error(`quorum ${quorum} invalid for ${opts.members.length} members`);
    this.#o = { ...opts, quorum };
  }

  async #vote(p: LLMProvider, args: CallArgs, ctx: C): Promise<Vote<z.output<S>>> {
    const r = await this.#o.caller.call(p, this.#o.schema, args);
    if (r.value === null) return { provider: p.name, value: null, rejected: r.error ?? "no value", cached: r.cached };
    return { provider: p.name, value: r.value, rejected: this.#o.validate?.(r.value, ctx) ?? null, cached: r.cached };
  }

  #groups(votes: Vote<z.output<S>>[]): Map<string, z.output<S>[]> {
    const g = new Map<string, z.output<S>[]>();
    for (const v of votes) {
      if (!isValidVote(v)) continue;
      const k = this.#o.key(v.value);
      g.set(k, [...(g.get(k) ?? []), v.value]);
    }
    return g;
  }

  async run(args: CallArgs, ctx: C): Promise<EnsembleResult<z.output<S>>> {
    const { members, quorum } = this.#o;
    const votes: Vote<z.output<S>>[] = [];
    for (let i = 0; i < members.length; i++) {
      votes.push(await this.#vote(members[i]!, args, ctx));
      const best = Math.max(0, ...[...this.#groups(votes).values()].map((g) => g.length));
      if (best >= quorum) break;
      if (best + (members.length - i - 1) < quorum) break; // quorum unreachable: stop paying
    }

    const groups = this.#groups(votes);
    const ranked = [...groups.values()].sort((a, b) => b.length - a.length);
    const top = ranked[0];
    if (top && top.length >= quorum && (ranked.length === 1 || top.length > ranked[1]!.length)) {
      return { status: "consensus", value: this.#o.merge(top), agreement: top.length / votes.length, votes };
    }

    const valid = votes.filter(isValidVote).map((v) => v.value);
    const { escalation, shouldEscalate } = this.#o;
    if (escalation && valid.length > 0 && (!shouldEscalate || shouldEscalate(valid, ctx))) {
      const ev = await this.#vote(escalation, args, ctx);
      votes.push(ev);
      const match = isValidVote(ev) ? groups.get(this.#o.key(ev.value)) : undefined;
      if (match && isValidVote(ev)) {
        const group = [...match, ev.value];
        return { status: "escalated", value: this.#o.merge(group), agreement: group.length / votes.length, votes };
      }
    }
    return { status: votes.some(isValidVote) ? "no_consensus" : "failed", value: null, agreement: 0, votes };
  }
}
