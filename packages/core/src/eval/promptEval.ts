/**
 * Prompt/model evaluation on golden sets (DESIGN H6). Measures what the production
 * harness would accept, per prompt version and per model, plus the ensemble result.
 * Runs without the LLM cache (fresh answers) and with its own budget cap.
 */
import { buildDossier, TradeJudgment, validateJudgment, type Stance } from "../ai/judge.ts";
import { JUDGE_PROMPTS, type DossierVariant } from "../ai/prompts.ts";
import { BudgetExceeded, CostTracker, type Pricing } from "../harness/budget.ts";
import { StructuredCaller } from "../harness/structured.ts";
import type { LLMProvider } from "../llm/types.ts";
import { EventExtractor, validateEvent } from "../signals/extractor.ts";
import { EventExtraction, type EventRecord } from "../signals/models.ts";
import { EVENT_PROMPTS, type EventPrompt } from "../signals/prompts.ts";

/** A prompt to evaluate: a built-in version name, or a resolved version (e.g. a user version from the registry). */
export type EventPromptArg = string | (EventPrompt & { version: string });
export type JudgePromptArg = string | { version: string; system: string; dossier: DossierVariant };

function asEvent(v: EventPromptArg): EventPrompt & { version: string } {
  if (typeof v !== "string") return v;
  const p = EVENT_PROMPTS[v as keyof typeof EVENT_PROMPTS];
  if (!p) throw new Error(`unknown built-in event prompt ${v}`);
  return { version: v, ...p };
}

function asJudge(v: JudgePromptArg): { version: string; system: string; dossier: DossierVariant } {
  if (typeof v !== "string") return v;
  const p = JUDGE_PROMPTS[v as keyof typeof JUDGE_PROMPTS];
  if (!p) throw new Error(`unknown built-in judge prompt ${v}`);
  return { version: v, ...p };
}
import type { FactorRow } from "../strategy/factors.ts";
import { openDb } from "../util/db.ts";
import type { EventCase, EventGoldenSet, JudgeCase, JudgeGoldenSet } from "./golden.ts";

const FIELDS = ["relevant", "tickers", "eventType", "direction", "materiality", "horizon"] as const;
type Field = (typeof FIELDS)[number];

export interface EventScore {
  ok: boolean;
  /** true/false per field; null = not applicable (e.g. no label, or relevance already wrong). */
  fields: Record<Field, boolean | null>;
}

const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && [...a].sort().join() === [...b].sort().join();

/**
 * Which fields missed and what was expected, e.g.
 * "horizon=weeks（期待 months） · direction=+2（期待 +1）".
 */
export function explainMismatch(c: EventCase, v: EventExtraction, s: EventScore): string {
  const e = c.expect;
  const sign = (n: number) => (n > 0 ? `+${n}` : String(n));
  const show: Record<Field, () => string> = {
    relevant: () => `relevant=${v.relevant && v.eventType !== "none"}（期待 ${(Array.isArray(e.relevant) ? e.relevant : [e.relevant]).join("/")}）`,
    tickers: () => `tickers=${v.tickers.join(",") || "なし"}（期待 ${(e.tickers ?? []).join(",")}）`,
    eventType: () => `eventType=${v.eventType}（期待 ${(e.eventType ?? []).join("/")}）`,
    direction: () => `direction=${sign(v.direction)}（期待 ${(e.direction ?? []).map(sign).join("/")}）`,
    materiality: () => `materiality=${v.materiality}（期待 ${(e.materiality ?? []).join("/")}）`,
    horizon: () => `horizon=${v.horizon}（期待 ${(e.horizon ?? []).join("/")}）`,
  };
  const missed = (Object.entries(s.fields) as Array<[Field, boolean | null]>).filter(([, ok]) => ok === false).map(([f]) => show[f]());
  return missed.length ? missed.join(" · ") : "?";
}

export function scoreEvent(c: EventCase, v: EventExtraction | null): EventScore {
  const fields = Object.fromEntries(FIELDS.map((f) => [f, null])) as Record<Field, boolean | null>;
  if (!v) return { ok: false, fields: { ...fields, relevant: false } };
  const e = c.expect;
  const allowed = Array.isArray(e.relevant) ? e.relevant : [e.relevant];
  const gotRelevant = v.relevant && v.eventType !== "none";
  fields.relevant = allowed.includes(gotRelevant);
  if (!fields.relevant) return { ok: false, fields };
  if (!gotRelevant) return { ok: true, fields };
  if (e.tickers) fields.tickers = sameSet(v.tickers, e.tickers);
  if (e.eventType) fields.eventType = e.eventType.includes(v.eventType);
  if (e.direction) fields.direction = e.direction.includes(v.direction);
  if (e.materiality) fields.materiality = e.materiality.includes(v.materiality);
  if (e.horizon) fields.horizon = e.horizon.includes(v.horizon);
  return { ok: Object.values(fields).every((x) => x !== false), fields };
}

export interface ModelRow {
  version: string;
  model: string;
  n: number;
  /** Parsed and schema-valid. */
  schemaOk: number;
  /** Also passed the harness checks (grounding, ticker whitelist / fact reading). */
  accepted: number;
  /** Accepted and correct by the labels. */
  correct: number;
  accuracy: number;
  fields: Record<string, { right: number; total: number }>;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  failures: Array<{ id: string; reason: string }>;
  extra?: Record<string, number>;
}

export interface EnsembleRow {
  version: string;
  members: string;
  n: number;
  /** consensus or escalated. */
  accepted: number;
  correctAccepted: number;
  /** Correct among accepted (what reaches the strategy). */
  precision: number;
  /** Accepted share. */
  coverage: number;
  costUsd: number;
  failures: Array<{ id: string; reason: string }>;
}

export interface EvalReport {
  task: "events" | "judge";
  set: string;
  createdAt: string;
  reviewedShare: number;
  rows: ModelRow[];
  ensemble: EnsembleRow[];
  stoppedByBudget: boolean;
}

export interface EvalOptions {
  models: LLMProvider[];
  pricing: Pricing;
  budgetUsd: number;
  maxRetries?: number;
  /** Also run the production ensemble with these settings. */
  ensemble?: { members: LLMProvider[]; quorum: number; escalation?: LLMProvider | undefined } | undefined;
  onProgress?: (msg: string) => void;
}

function tracker(o: EvalOptions): { caller: StructuredCaller; budget: CostTracker } {
  const budget = new CostTracker(openDb(":memory:"), { pricing: o.pricing, dailyLimitUsd: o.budgetUsd });
  return { budget, caller: new StructuredCaller({ budget, maxRetries: o.maxRetries ?? 2 }) };
}

function usage(b: CostTracker) {
  const s = b.summaryToday();
  return {
    costUsd: s.reduce((a, x) => a + x.costUsd, 0),
    inputTokens: s.reduce((a, x) => a + x.inputTokens, 0),
    outputTokens: s.reduce((a, x) => a + x.outputTokens, 0),
  };
}

/** A model that fails its first calls at the transport level (no key, blocked host, outage) is skipped. */
const GIVE_UP_AFTER = 3;
function giveUp(error: string | undefined, row: ModelRow, consecutive: number): boolean {
  if (!error?.startsWith("llm:") || consecutive < GIVE_UP_AFTER) return false;
  row.failures.push({ id: "(model)", reason: `skipped: first ${GIVE_UP_AFTER} calls could not reach the model — check the API key and network access` });
  return true;
}

const docOf = (c: EventCase) => ({ ...c.doc, url: `golden:${c.id}`, fetchedAt: "2026-01-01T00:00:00.000Z", sourceWeight: 1, alsoSeenIn: [] });

export async function evalEvents(set: EventGoldenSet, prompts: EventPromptArg[], o: EvalOptions): Promise<EvalReport> {
  const report: EvalReport = {
    task: "events", set: set.name, createdAt: new Date().toISOString(),
    reviewedShare: set.cases.filter((c) => c.reviewed).length / set.cases.length, rows: [], ensemble: [], stoppedByBudget: false,
  };
  try {
    for (const arg of prompts) {
      const prompt = asEvent(arg);
      const version = prompt.version;
      for (const model of o.models) {
        const { caller, budget } = tracker(o);
        const row: ModelRow = { version, model: model.name, n: set.cases.length, schemaOk: 0, accepted: 0, correct: 0, accuracy: 0, fields: {}, costUsd: 0, inputTokens: 0, outputTokens: 0, failures: [] };
        for (const f of FIELDS) row.fields[f] = { right: 0, total: 0 };
        let unreachable = 0;
        for (const c of set.cases) {
          o.onProgress?.(`${version} ${model.name} ${c.id}`);
          const doc = docOf(c);
          const r = await caller.call(model, EventExtraction, { schemaName: "EventExtraction", system: prompt.system, user: prompt.user(doc, c.candidates), promptVersion: version });
          if (!r.value) {
            row.failures.push({ id: c.id, reason: r.error ?? "no output" });
            if (giveUp(r.error, row, ++unreachable)) break;
            continue;
          }
          unreachable = -Infinity; // reached the model at least once: never give up on transport errors after that
          row.schemaOk++;
          const rejected = validateEvent(r.value, { doc, candidates: c.candidates, priority: new Set() });
          const s = scoreEvent(c, r.value);
          for (const f of FIELDS) if (s.fields[f] !== null) (row.fields[f]!.total++, s.fields[f] && row.fields[f]!.right++);
          if (rejected) row.failures.push({ id: c.id, reason: `rejected: ${rejected}` });
          else {
            row.accepted++;
            if (s.ok) row.correct++;
            else row.failures.push({ id: c.id, reason: `wrong: ${explainMismatch(c, r.value, s)}` });
          }
        }
        Object.assign(row, usage(budget), { accuracy: row.correct / row.n });
        report.rows.push(row);
      }
      if (o.ensemble) {
        const { caller, budget } = tracker(o);
        const ex = new EventExtractor(caller, o.ensemble.members, { quorum: o.ensemble.quorum, escalation: o.ensemble.escalation, prompt });
        const row: EnsembleRow = { version, members: o.ensemble.members.map((m) => m.name).join("+"), n: set.cases.length, accepted: 0, correctAccepted: 0, precision: 0, coverage: 0, costUsd: 0, failures: [] };
        for (const c of set.cases) {
          o.onProgress?.(`${version} ensemble ${c.id}`);
          const res = await ex.extract({ doc: docOf(c), candidates: c.candidates, priority: new Set() });
          if (res.status !== "consensus" && res.status !== "escalated") {
            row.failures.push({ id: c.id, reason: res.status });
            continue;
          }
          row.accepted++;
          const sc = scoreEvent(c, res.value);
          if (sc.ok) row.correctAccepted++;
          else row.failures.push({ id: c.id, reason: `accepted but wrong: ${res.value ? explainMismatch(c, res.value, sc) : "no value"}` });
        }
        Object.assign(row, { costUsd: usage(budget).costUsd, precision: row.accepted ? row.correctAccepted / row.accepted : 0, coverage: row.accepted / row.n });
        report.ensemble.push(row);
      }
    }
  } catch (e) {
    if (!(e instanceof BudgetExceeded)) throw e;
    report.stoppedByBudget = true;
  }
  return report;
}

export function judgeCaseDossier(c: JudgeCase, prompt: JudgePromptArg) {
  const row: FactorRow = { lastDate: "2026-01-01", ...c.row };
  const events: EventRecord[] = c.events.map((e, i) => ({
    docHash: `${c.id}-${i}`, title: e.evidence, url: "", source: "golden", learnedAt: `${e.date}T06:00:00.000Z`, agreement: 1, sourceWeight: 1, nSources: 1,
    event: EventExtraction.parse({ relevant: true, tickers: [c.row.ticker], eventType: e.eventType, direction: e.direction, materiality: e.materiality, horizon: "months", confidence: 0.8, evidence: [e.evidence] }),
  }));
  const position = c.held
    ? { ticker: c.row.ticker, shares: 100, entryPrice: c.held.entryPrice, highestClose: Math.max(c.held.entryPrice, c.row.close), sector: c.row.sector, entryDate: "2025-12-01", daysHeld: c.held.daysHeld }
    : undefined;
  return buildDossier({ row, asOf: "2026-01-01", rank: c.rank, universe: c.universe, events, position }, asJudge(prompt).dossier);
}

export async function evalJudge(set: JudgeGoldenSet, prompts: JudgePromptArg[], o: EvalOptions): Promise<EvalReport> {
  const report: EvalReport = {
    task: "judge", set: set.name, createdAt: new Date().toISOString(),
    reviewedShare: set.cases.filter((c) => c.reviewed).length / set.cases.length, rows: [], ensemble: [], stoppedByBudget: false,
  };
  try {
    for (const arg of prompts) {
      const prompt = asJudge(arg);
      const version = prompt.version;
      for (const model of o.models) {
        const { caller, budget } = tracker(o);
        const row: ModelRow = { version, model: model.name, n: set.cases.length, schemaOk: 0, accepted: 0, correct: 0, accuracy: 0, fields: {}, costUsd: 0, inputTokens: 0, outputTokens: 0, failures: [] };
        const stances: Record<Stance, number> = { bullish: 0, bearish: 0, neutral: 0, abstain: 0 };
        let misread = 0;
        let unreachable = 0;
        for (const c of set.cases) {
          o.onProgress?.(`${version} ${model.name} ${c.id}`);
          const dossier = judgeCaseDossier(c, prompt);
          const r = await caller.call(model, TradeJudgment, { schemaName: "TradeJudgment", system: prompt.system, user: dossier.text, promptVersion: version });
          if (!r.value) {
            row.failures.push({ id: c.id, reason: r.error ?? "no output" });
            if (giveUp(r.error, row, ++unreachable)) break;
            continue;
          }
          unreachable = -Infinity;
          row.schemaOk++;
          const rejected = validateJudgment(r.value, { dossier, priority: false });
          if (rejected) {
            if (rejected.startsWith("misread")) misread++;
            row.failures.push({ id: c.id, reason: `rejected: ${rejected}` });
            continue;
          }
          row.accepted++;
          stances[r.value.stance]++;
          if (c.expect.allowed.includes(r.value.stance)) row.correct++;
          else row.failures.push({ id: c.id, reason: `insane stance ${r.value.stance} (allowed: ${c.expect.allowed.join("/")})` });
        }
        Object.assign(row, usage(budget), { accuracy: row.correct / row.n, extra: { ...stances, misread } });
        report.rows.push(row);
      }
    }
  } catch (e) {
    if (!(e instanceof BudgetExceeded)) throw e;
    report.stoppedByBudget = true;
  }
  return report;
}
