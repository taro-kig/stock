import { modelsFor } from "../llm/roles.ts";
import { resolve } from "node:path";
import { loadEventSet, loadJudgeSet } from "../eval/golden.ts";
import { evalEvents, evalJudge, type EvalReport } from "../eval/promptEval.ts";
import type { Services } from "../services.ts";
import type { PromptFamily } from "./registry.ts";

export interface PromptEvalRequest {
  family: PromptFamily;
  /** Default: every version of the family that fits the market (US / JP event prompts). */
  versions?: string[];
  /** Model names from config (default: all configured). */
  models?: string[];
  ensemble?: boolean;
  budgetUsd?: number;
  /** Golden set path (default by family and market). */
  set?: string;
  onProgress?: (msg: string) => void;
}

/** Families with a golden set. The red team and ticker suggestions are compared on live results only. */
export const EVALUABLE: readonly PromptFamily[] = ["event", "judge"];

/** The repository root (golden sets ship with the code, wherever the process was started). */
const REPO = resolve(import.meta.dirname, "../../../..");

export function defaultGoldenSet(s: Services, family: PromptFamily): string {
  if (family === "event") return resolve(REPO, s.config.market.currency === "USD" ? "examples/golden/events-us.yaml" : "examples/golden/events.yaml");
  if (family === "judge") return resolve(REPO, "examples/golden/judge.yaml");
  throw new Error(`no golden set for ${family} prompts (compare them on live results instead)`);
}

/** Versions evaluated by default: for events, only those written for the configured market. */
export function defaultVersions(s: Services, family: PromptFamily): string[] {
  const us = s.config.market.currency === "USD";
  return s.prompts.list(family).filter((p) => family !== "event" || p.base.startsWith("event-us") === us).map((p) => p.version);
}

export async function runPromptEval(s: Services, r: PromptEvalRequest): Promise<EvalReport> {
  if (!EVALUABLE.includes(r.family)) throw new Error(`no golden set for ${r.family} prompts (compare them on live results instead)`);
  const versions = r.versions?.length ? r.versions : defaultVersions(s, r.family);
  // Default: the models this family uses in production (the rest of the pool may have no key).
  const models = s.allModels(r.models?.length ? r.models : s.fake || !s.config.models ? undefined : modelsFor(s.config.models, r.family));
  if (!models.length) throw new Error(`no models to evaluate (configured: ${s.modelNames().join(", ")})`);
  const common = {
    models,
    pricing: s.fake ? Object.fromEntries(models.map((m) => [m.model, [0, 0] as const])) : s.config.pricing,
    budgetUsd: r.budgetUsd ?? 0.5,
    maxRetries: s.config.harness.maxRetries,
    ...(r.onProgress ? { onProgress: r.onProgress } : {}),
  };
  const set = r.set ?? defaultGoldenSet(s, r.family);
  if (r.family === "event") {
    return evalEvents(loadEventSet(set), versions.map((v) => s.prompts.event(v)), {
      ...common,
      ensemble: r.ensemble ? { members: s.voters("event"), quorum: s.config.harness.quorum, escalation: s.escalation("event") } : undefined,
    });
  }
  return evalJudge(loadJudgeSet(set), versions.map((v) => s.prompts.judge(v)), common);
}
