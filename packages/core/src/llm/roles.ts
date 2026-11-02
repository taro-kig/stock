import { z } from "zod";
import { ModelSpec } from "./factory.ts";

/**
 * Which models each prompt family uses. The same keys as the prompt families, so the
 * prompts screen can show "this prompt, these models" side by side; a workflow node can
 * override both (promptVersion / models, escalation, redTeamModel, model).
 */
export const MODEL_USES = ["event", "judge", "redteam", "universe"] as const;
export type ModelUse = (typeof MODEL_USES)[number];

/** Node / API value meaning "no escalation model". */
export const NO_MODEL = "none";

const Vote = z.strictObject({
  /** Voting members in call order: the first `quorum` are always called, the rest only on disagreement. */
  vote: z.array(z.string()).min(1),
  /** Tie-breaker for important disagreements (omit for none). */
  escalation: z.string().optional(),
});
export type VoteUse = z.infer<typeof Vote>;

const Models = z
  .strictObject({
    /** Every model that may be used (vendor, model id, key). Names are what `use` and nodes refer to. */
    pool: z.array(ModelSpec).min(1),
    use: z.strictObject({
      event: Vote,
      judge: Vote,
      /** Default: judge.escalation. "none" = no red team. */
      redteam: z.string().optional(),
      /** Default: judge.escalation, else the first judge voter. */
      universe: z.string().optional(),
    }),
  })
  .superRefine((m, ctx) => {
    const names = new Set<string>();
    for (const s of m.pool) {
      if (names.has(s.name)) ctx.addIssue({ code: "custom", path: ["pool"], message: `duplicate model name "${s.name}"` });
      names.add(s.name);
    }
    const check = (n: string | undefined, path: PropertyKey[]) => {
      if (n !== undefined && !names.has(n)) ctx.addIssue({ code: "custom", path, message: `"${n}" is not in models.pool (${[...names].join(", ")})` });
    };
    for (const f of ["event", "judge"] as const) {
      m.use[f].vote.forEach((n, i) => check(n, ["use", f, "vote", i]));
      if (new Set(m.use[f].vote).size !== m.use[f].vote.length) ctx.addIssue({ code: "custom", path: ["use", f, "vote"], message: "the same model votes twice" });
      check(m.use[f].escalation, ["use", f, "escalation"]);
    }
    check(m.use.redteam === NO_MODEL ? undefined : m.use.redteam, ["use", "redteam"]);
    check(m.use.universe, ["use", "universe"]);
  });

/**
 * The pre-v0.17 shape `{ tier1, tier2?, redTeam? }` still loads: tier1 votes for both events and
 * judgments, tier2 escalates, redTeam (else tier2) is the red team, tier2 (else tier1[0]) the universe model.
 */
export function fromLegacy(v: unknown): unknown {
  if (!v || typeof v !== "object" || "pool" in v || !("tier1" in v)) return v;
  const o = v as { tier1?: Array<{ name?: unknown }>; tier2?: { name?: unknown }; redTeam?: { name?: unknown } };
  if (!Array.isArray(o.tier1)) return v;
  const specs = [...o.tier1, ...(o.tier2 ? [o.tier2] : []), ...(o.redTeam ? [o.redTeam] : [])];
  const pool = [...new Map(specs.map((s) => [String(s?.name), s])).values()];
  const name = (s: { name?: unknown } | undefined) => (s ? String(s.name) : undefined);
  const vote = { vote: o.tier1.map((s) => String(s?.name)), ...(o.tier2 ? { escalation: name(o.tier2) } : {}) };
  return {
    pool,
    use: {
      event: vote, judge: vote,
      ...(o.redTeam ? { redteam: name(o.redTeam) } : {}),
      ...(o.tier2 ? { universe: name(o.tier2) } : {}),
    },
  };
}

export const ModelsConfig = z.preprocess(fromLegacy, Models);
export type ModelsConfig = z.infer<typeof Models>;

/** The single model a family resolves to by default (redteam / universe), or undefined for none. */
export function defaultSingle(m: ModelsConfig, use: "redteam" | "universe"): string | undefined {
  if (use === "redteam") return m.use.redteam ?? m.use.judge.escalation;
  return m.use.universe ?? m.use.judge.escalation ?? m.use.judge.vote[0];
}

/** The models a family uses by default: voters then escalation, or its single model. */
export function modelsFor(m: ModelsConfig, use: ModelUse): string[] {
  if (use === "event" || use === "judge") return [...m.use[use].vote, ...(m.use[use].escalation ? [m.use[use].escalation] : [])].filter((n, i, a) => a.indexOf(n) === i);
  const n = defaultSingle(m, use);
  return n && n !== NO_MODEL ? [n] : [];
}

/** Every pool model referenced by `use` (the ones whose keys must be set). */
export function usedModelNames(m: ModelsConfig): string[] {
  const out = [
    ...m.use.event.vote, ...m.use.judge.vote,
    ...[m.use.event.escalation, m.use.judge.escalation, defaultSingle(m, "redteam"), defaultSingle(m, "universe")].filter((x): x is string => Boolean(x) && x !== NO_MODEL),
  ];
  return [...new Set(out)];
}
