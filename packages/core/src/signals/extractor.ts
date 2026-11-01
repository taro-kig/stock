import { Ensemble, type EnsembleResult } from "../harness/ensemble.ts";
import { checkEvidence } from "../harness/grounding.ts";
import type { StructuredCaller } from "../harness/structured.ts";
import type { LLMProvider } from "../llm/types.ts";
import { docText, EventExtraction, type Document } from "./models.ts";
import { EVENT_PROMPT_VERSION, EVENT_SYSTEM, eventUserPrompt } from "./prompts.ts";

export interface ExtractionContext {
  doc: Document;
  /** ticker -> name, produced by the Tier-0 prefilter. */
  candidates: Record<string, string>;
  /** Holdings / top candidates: disagreements about these get escalated. */
  priority: ReadonlySet<string>;
}

const sign = (x: number) => Math.sign(x);
const isNone = (e: EventExtraction) => !e.relevant || e.eventType === "none";

export function eventKey(e: EventExtraction): string {
  return isNone(e) ? "irrelevant" : `${e.eventType}:${sign(e.direction)}`;
}

/** Conservative merge: weakest direction/materiality, only tickers everyone agreed on. */
export function mergeEvents(group: EventExtraction[]): EventExtraction {
  const first = group[0]!;
  if (isNone(first)) return first;
  const tickers = group.slice(1).reduce((acc, e) => acc.filter((t) => e.tickers.includes(t)), first.tickers);
  const horizonCounts = new Map<EventExtraction["horizon"], number>();
  for (const e of group) horizonCounts.set(e.horizon, (horizonCounts.get(e.horizon) ?? 0) + 1);
  return {
    relevant: true,
    tickers,
    eventType: first.eventType,
    direction: group.map((e) => e.direction).reduce((a, b) => (Math.abs(b) < Math.abs(a) ? b : a)),
    materiality: Math.min(...group.map((e) => e.materiality)),
    horizon: [...horizonCounts.entries()].sort((a, b) => b[1] - a[1])[0]![0],
    confidence: group.reduce((s, e) => s + e.confidence, 0) / group.length,
    evidence: [...new Set(group.flatMap((e) => e.evidence))].slice(0, 3),
    rationale: first.rationale,
  };
}

/** Deterministic checks. A returned string rejects the vote. */
export function validateEvent(e: EventExtraction, ctx: ExtractionContext): string | null {
  if (isNone(e)) return null; // "nothing here" needs no evidence
  if (e.tickers.length === 0) return "relevant but no tickers";
  const unknown = e.tickers.filter((t) => !(t in ctx.candidates));
  if (unknown.length) return `tickers not in candidates: ${unknown.join(",")}`;
  const { ok, failed } = checkEvidence(e.evidence, docText(ctx.doc));
  if (!ok) return `ungrounded evidence: ${failed.length ? failed.join(" | ") : "none given"}`;
  return null;
}

export function shouldEscalateEvent(values: EventExtraction[], ctx: ExtractionContext): boolean {
  return values.some((v) => v.tickers.some((t) => ctx.priority.has(t)) || (v.relevant && v.materiality >= 2));
}

export class EventExtractor {
  readonly #ensemble: Ensemble<typeof EventExtraction, ExtractionContext>;

  constructor(caller: StructuredCaller, members: readonly LLMProvider[], opts: { quorum?: number; escalation?: LLMProvider | undefined } = {}) {
    this.#ensemble = new Ensemble({
      caller,
      members,
      schema: EventExtraction,
      key: eventKey,
      merge: mergeEvents,
      validate: validateEvent,
      quorum: opts.quorum ?? 2,
      escalation: opts.escalation,
      shouldEscalate: shouldEscalateEvent,
    });
  }

  async extract(ctx: ExtractionContext): Promise<EnsembleResult<EventExtraction>> {
    const res = await this.#ensemble.run(
      { schemaName: "EventExtraction", system: EVENT_SYSTEM, user: eventUserPrompt(ctx.doc, ctx.candidates), promptVersion: EVENT_PROMPT_VERSION },
      ctx,
    );
    // the conservative ticker intersection can come out empty -> no signal
    if (res.value && res.value.relevant && res.value.tickers.length === 0) return { ...res, status: "no_consensus", value: null };
    return res;
  }
}
