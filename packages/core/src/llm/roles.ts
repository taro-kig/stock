import { z } from "zod";
import { knownPrice, vendorOf } from "./catalog.ts";
import { ModelSpec } from "./factory.ts";

/**
 * Which models each prompt family uses. The same keys as the prompt families, so the
 * prompts screen can show "this prompt, these models" side by side; a workflow node can
 * override both (promptVersion / models, escalation, redTeamModel, model).
 *
 * "auto" (the default) picks from the registered models that have a key: the cheapest model
 * of each vendor votes, a somewhat stronger one breaks ties (see autoAssign).
 */
export const MODEL_USES = ["event", "judge", "redteam", "universe"] as const;
export type ModelUse = (typeof MODEL_USES)[number];

/** Node / API value meaning "no model" (no escalation, no red team). */
export const NO_MODEL = "none";
/** Let the app choose. */
export const AUTO = "auto";

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
    use: z
      .strictObject({
        event: z.union([z.literal(AUTO), Vote]).default(AUTO),
        judge: z.union([z.literal(AUTO), Vote]).default(AUTO),
        /** A pool name, "none" (no red team) or "auto". */
        redteam: z.string().default(AUTO),
        /** A pool name or "auto". */
        universe: z.string().default(AUTO),
      })
      .prefault({}),
  })
  .superRefine((m, ctx) => {
    const names = new Set<string>();
    for (const s of m.pool) {
      if (names.has(s.name)) ctx.addIssue({ code: "custom", path: ["pool"], message: `duplicate model name "${s.name}"` });
      names.add(s.name);
    }
    for (const n of explicitModelNames(m)) {
      if (!names.has(n)) ctx.addIssue({ code: "custom", path: ["use"], message: `"${n}" is not in models.pool (${[...names].join(", ")})` });
    }
    for (const f of ["event", "judge"] as const) {
      const u = m.use[f];
      if (u !== AUTO && new Set(u.vote).size !== u.vote.length) ctx.addIssue({ code: "custom", path: ["use", f, "vote"], message: "the same model votes twice" });
    }
    if (m.use.universe === NO_MODEL) ctx.addIssue({ code: "custom", path: ["use", "universe"], message: "universe needs a model" });
  });

/**
 * The pre-v0.17 shape `{ tier1, tier2?, redTeam? }` still loads: its models become the pool and
 * every family is "auto" (the old fixed roles were the example's defaults, which auto reproduces).
 */
export function fromLegacy(v: unknown): unknown {
  if (!v || typeof v !== "object" || "pool" in v || !("tier1" in v)) return v;
  const o = v as { tier1?: Array<{ name?: unknown }>; tier2?: { name?: unknown }; redTeam?: { name?: unknown } };
  if (!Array.isArray(o.tier1)) return v;
  const specs = [...o.tier1, ...(o.tier2 ? [o.tier2] : []), ...(o.redTeam ? [o.redTeam] : [])];
  return { pool: [...new Map(specs.map((s) => [String(s?.name), s])).values()] };
}

export const ModelsConfig = z.preprocess(fromLegacy, Models);
export type ModelsConfig = z.infer<typeof Models>;

/** Models named in `use` (not auto): these cannot be removed from the pool. */
export function explicitModelNames(m: ModelsConfig): string[] {
  const out: string[] = [];
  for (const f of ["event", "judge"] as const) {
    const u = m.use[f];
    if (u !== AUTO) out.push(...u.vote, ...(u.escalation && u.escalation !== NO_MODEL ? [u.escalation] : []));
  }
  for (const f of ["redteam", "universe"] as const) if (m.use[f] !== AUTO && m.use[f] !== NO_MODEL) out.push(m.use[f]);
  return [...new Set(out)];
}

/** What every family actually uses after "auto" is decided. */
export interface ResolvedUse {
  event: VoteUse;
  judge: VoteUse;
  redteam: string | undefined;
  universe: string | undefined;
  /** Which families were decided automatically. */
  auto: Record<ModelUse, boolean>;
  /** Plain-language warnings about the automatic choice (missing keys, one vendor only, ...). */
  notes: string[];
}

export interface ResolveContext {
  /** Whether the model's API key is set. */
  hasKey: (spec: ModelSpec) => boolean;
  /** config.pricing (USD / 1M tokens). */
  pricing: Record<string, readonly [number, number]>;
  quorum: number;
}

/** Rough cost per call: our prompts are long and the answers short JSON. Reasoning / pro models are slow and verbose. */
function costOf(spec: ModelSpec, pricing: ResolveContext["pricing"]): number {
  const p = pricing[spec.model] ?? knownPrice(spec.model) ?? [2, 10];
  const heavy = /reason|think|-pro\b|pro-|-r1\b|opus|\bo1\b|\bo3\b/i.test(spec.model) ? 4 : 1;
  return (p[0] + p[1] / 4) * heavy;
}

/**
 * The automatic choice. Voters: the cheapest model of each vendor (different vendors make
 * different mistakes), cheapest first; the first `quorum` are always asked, one more only on
 * disagreement. Escalation: the cheapest model that is pricier (stronger) than those voters.
 * Red team and ticker search: the escalation model, else the strongest available one.
 */
export function autoAssign(pool: readonly ModelSpec[], ctx: ResolveContext): { vote: VoteUse; strong: string | undefined; notes: string[] } {
  const notes: string[] = [];
  let avail = pool.filter((s) => ctx.hasKey(s));
  if (!avail.length) {
    notes.push("API キーが設定されたモデルがありません（⚙ 設定でキーを入れる）");
    avail = [...pool];
  }
  const sorted = [...avail].sort((a, b) => costOf(a, ctx.pricing) - costOf(b, ctx.pricing));
  const vendorKey = (s: ModelSpec) => (s.provider === "openai_compat" && vendorOf(s) === "custom" ? s.baseUrl : vendorOf(s));
  const voters: ModelSpec[] = [];
  const vendors = new Set<string>();
  for (const s of sorted) {
    if (vendors.has(vendorKey(s))) continue;
    vendors.add(vendorKey(s));
    voters.push(s);
  }
  // Not enough vendors: fill with the next cheapest models.
  for (const s of sorted) if (voters.length < ctx.quorum && !voters.includes(s)) voters.push(s);
  const vote = voters.slice(0, Math.max(ctx.quorum, Math.min(ctx.quorum + 1, voters.length)));
  if (vote.length < ctx.quorum) notes.push(`判断には少なくとも ${ctx.quorum} つのモデルが必要です（⚙ 設定 → モデル で追加し、キーを入れる）`);
  else if (vendors.size < 2) notes.push("使えるモデルが 1 社だけです。別の会社（DeepSeek など）のキーも入れると、間違いが重なりにくくなります");
  const core = vote.slice(0, ctx.quorum);
  const top = Math.max(...core.map((s) => costOf(s, ctx.pricing)));
  const escalation = sorted.find((s) => !core.includes(s) && costOf(s, ctx.pricing) > top);
  const strong = escalation ?? sorted.at(-1);
  return {
    vote: { vote: vote.map((s) => s.name), ...(escalation ? { escalation: escalation.name } : {}) },
    strong: strong?.name,
    notes,
  };
}

/**
 * The vote only protects against a model's mistakes when the voters are different models:
 * with quorum 1 one answer decides, and two pool entries of the same model (e.g. deepseek and
 * deepseek-red, both deepseek-chat) answer identically (same prompt, temperature 0, shared cache).
 */
function independenceNotes(m: ModelsConfig, uses: Record<"event" | "judge", VoteUse>, quorum: number): string[] {
  const notes: string[] = [];
  if (quorum < 2) notes.push("harness.quorum が 1 なので、1つのモデルの答えだけで決めています（多数決なし）。2 にすると、別のモデルと答えが一致したものだけを使います");
  const JA = { event: "イベント抽出", judge: "判断" } as const;
  for (const f of ["event", "judge"] as const) {
    const core = uses[f].vote.slice(0, Math.max(quorum, 2));
    const models = core.map((n) => m.pool.find((p) => p.name === n)?.model ?? n);
    const dup = models.find((x, i) => models.indexOf(x) !== i);
    if (dup) notes.push(`${JA[f]}の ${core.filter((_, i) => models[i] === dup).join(" と ")} は同じモデル（${dup}）なので、同じ答えが返り多数決になりません。別の会社のモデルを選ぶか、おまかせに`);
  }
  return notes;
}

/** Decides every "auto" family. */
export function resolveUse(m: ModelsConfig, ctx: ResolveContext): ResolvedUse {
  const a = autoAssign(m.pool, ctx);
  const event = m.use.event === AUTO ? a.vote : m.use.event;
  const judge = m.use.judge === AUTO ? a.vote : m.use.judge;
  const single = (f: "redteam" | "universe"): string | undefined => {
    const v = m.use[f];
    if (v === NO_MODEL) return undefined;
    if (v !== AUTO) return v;
    return judge.escalation ?? a.strong;
  };
  const anyAuto = m.use.event === AUTO || m.use.judge === AUTO || m.use.redteam === AUTO || m.use.universe === AUTO;
  return {
    event, judge, redteam: single("redteam"), universe: single("universe"),
    auto: { event: m.use.event === AUTO, judge: m.use.judge === AUTO, redteam: m.use.redteam === AUTO, universe: m.use.universe === AUTO },
    notes: [...(anyAuto ? a.notes : []), ...independenceNotes(m, { event, judge }, ctx.quorum)],
  };
}

/** The models a family uses: voters then escalation, or its single model. */
export function modelsFor(r: ResolvedUse, use: ModelUse): string[] {
  if (use === "event" || use === "judge") return [...new Set([...r[use].vote, ...(r[use].escalation ? [r[use].escalation] : [])])];
  const n = r[use];
  return n ? [n] : [];
}

/** Every pool model the families use (the ones whose keys must be set). */
export function usedModelNames(r: ResolvedUse): string[] {
  return [...new Set(MODEL_USES.flatMap((f) => modelsFor(r, f)))];
}

/** One plain-language sentence: what this family does with its models. */
export function describeUse(r: ResolvedUse, use: ModelUse, quorum: number): string {
  if (use === "event" || use === "judge") {
    const v = r[use];
    const core = v.vote.slice(0, quorum);
    const extra = v.vote.slice(quorum);
    return [
      `${core.join(" と ")} に同じことを聞き、${core.length < 2 ? "その答え" : "答えが一致したもの"}だけを使う`,
      extra.length ? `。食い違ったら ${extra.join("、")} にも聞く` : "",
      v.escalation ? `。それでも決まらない大事なものは ${v.escalation} が決める` : "",
    ].join("");
  }
  const n = r[use];
  if (use === "redteam") return n ? `${n} が「買い」の結論にわざと反論し、根拠が弱ければ止める` : "使わない（買いを止める役なし）";
  return n ? `${n} がテーマから銘柄の候補を出す` : "モデルなし";
}
