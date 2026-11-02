import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { JUDGE_PROMPTS } from "../src/ai/prompts.ts";
import { AppConfig } from "../src/config.ts";
import { loadEventSet, loadJudgeSet, type EventCase } from "../src/eval/golden.ts";
import { evalEvents, evalJudge, judgeCaseDossier, scoreEvent } from "../src/eval/promptEval.ts";
import { StructuredCaller } from "../src/harness/structured.ts";
import { FakeProvider } from "../src/llm/fake.ts";
import { heuristicResponder } from "../src/llm/heuristic.ts";
import { LLMError } from "../src/llm/types.ts";
import { EventExtractor } from "../src/signals/extractor.ts";
import { EventExtraction } from "../src/signals/models.ts";
import { EVENT_PROMPTS } from "../src/signals/prompts.ts";
import { PromptRegistry } from "../src/prompts/registry.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = resolve(import.meta.dirname, "../../..");
const events = loadEventSet(resolve(ROOT, "examples/golden/events.yaml"));
const judge = loadJudgeSet(resolve(ROOT, "examples/golden/judge.yaml"));

describe("golden sets", () => {
  it("load, and their labels are internally consistent", () => {
    expect(events.cases.length).toBeGreaterThanOrEqual(40);
    for (const c of events.cases) {
      for (const t of c.expect.tickers ?? []) expect(Object.keys(c.candidates), c.id).toContain(t);
      const relevant = Array.isArray(c.expect.relevant) ? c.expect.relevant : [c.expect.relevant];
      if (!relevant.includes(true)) expect(c.expect.eventType, c.id).toBeUndefined();
    }
    expect(judge.cases.length).toBeGreaterThanOrEqual(12);
  });

  it("judge dossiers render for every prompt version with the facts the checklist must match", () => {
    for (const c of judge.cases) {
      for (const v of Object.keys(JUDGE_PROMPTS) as Array<keyof typeof JUDGE_PROMPTS>) {
        const d = judgeCaseDossier(c, v);
        expect(d.trend, c.id).toBe(c.row.trend ?? "unknown");
        expect(d.news, c.id).toBe(c.events.length === 0 ? "none" : d.news);
        expect(d.text.includes("20日リターン"), `${c.id} ${v}`).toBe(v === "judge-v2");
      }
    }
  });
});

const ev = (over: Partial<EventExtraction> = {}): EventExtraction =>
  EventExtraction.parse({ relevant: true, tickers: ["X1"], eventType: "guidance_up", direction: 2, materiality: 3, horizon: "months", confidence: 0.9, evidence: ["x".repeat(10)], ...over });
const kase = (expect: EventCase["expect"]): EventCase => ({ id: "c", note: "", reviewed: false, candidates: { X1: "A" }, doc: { source: "s", title: "t", body: "", publishedAt: null }, expect });

describe("scoreEvent", () => {
  it("checks each labelled field against its acceptable values", () => {
    const c = kase({ relevant: true, tickers: ["X1"], eventType: ["guidance_up"], direction: [1, 2], materiality: [3] });
    expect(scoreEvent(c, ev()).ok).toBe(true);
    const s = scoreEvent(c, ev({ direction: -1 }));
    expect(s.ok).toBe(false);
    expect(s.fields.direction).toBe(false);
    expect(s.fields.eventType).toBe(true);
    expect(s.fields.horizon).toBeNull(); // not labelled
  });

  it("supports cases where either relevance is defensible", () => {
    const c = kase({ relevant: [false, true], materiality: [0, 1] });
    expect(scoreEvent(c, ev({ relevant: false, eventType: "none", direction: 0, materiality: 0, tickers: [] })).ok).toBe(true);
    expect(scoreEvent(c, ev({ materiality: 1 })).ok).toBe(true);
    expect(scoreEvent(c, ev({ materiality: 3 })).ok).toBe(false);
    expect(scoreEvent(kase({ relevant: false }), ev()).ok).toBe(false);
    expect(scoreEvent(c, null).ok).toBe(false);
  });
});

describe("evalEvents / evalJudge", () => {
  const sub = { ...events, cases: events.cases.slice(0, 6) };

  it("scores a model that answers from the labels perfectly, and reports usage", async () => {
    const byTitle = new Map(sub.cases.map((c) => [c.doc.title, c]));
    const oracle = new FakeProvider("oracle", (req) => {
      const c = [...byTitle.entries()].find(([t]) => req.user.includes(`タイトル: ${t}`))![1];
      const e = c.expect;
      const relevant = Array.isArray(e.relevant) ? e.relevant[0]! : e.relevant;
      if (!relevant) return JSON.stringify({ relevant: false, tickers: [], eventType: "none", direction: 0, materiality: 0, horizon: "days", confidence: 0.5, evidence: [] });
      const quote = c.doc.body.split(/[。\n]/).map((x) => x.trim()).find((x) => x.length >= 10)!;
      return JSON.stringify({
        relevant: true, tickers: e.tickers ?? Object.keys(c.candidates), eventType: e.eventType?.[0] ?? "other", direction: e.direction?.[0] ?? 0,
        materiality: e.materiality?.[0] ?? 1, horizon: e.horizon?.[0] ?? "months", confidence: 0.8, evidence: [quote.slice(0, 80)],
      });
    });
    const r = await evalEvents(sub, ["event-v1", "event-v2"], { models: [oracle], pricing: { oracle: [1, 1] }, budgetUsd: 10, ensemble: { members: [oracle, oracle], quorum: 2 } });
    expect(r.rows.map((x) => [x.version, x.accuracy])).toEqual([["event-v1", 1], ["event-v2", 1]]);
    expect(r.rows[0]!.inputTokens).toBeGreaterThan(0);
    expect(r.rows[1]!.inputTokens).toBeGreaterThan(r.rows[0]!.inputTokens); // v2 carries definitions + examples
    expect(r.ensemble.map((x) => x.precision)).toEqual([1, 1]);
    expect(r.reviewedShare).toBe(0);
  });

  it("rejected outputs never count as correct, and the budget stops the run", async () => {
    const liar = new FakeProvider("liar", () => JSON.stringify({ relevant: true, tickers: ["X101"], eventType: "guidance_up", direction: 2, materiality: 3, horizon: "months", confidence: 0.9, evidence: ["この文は原文にありません"] }));
    const r = await evalEvents(sub, ["event-v1"], { models: [liar], pricing: {}, budgetUsd: 10 });
    expect(r.rows[0]!.correct).toBe(0);
    expect(r.rows[0]!.failures.some((f) => f.reason.includes("ungrounded"))).toBe(true);
    const capped = await evalEvents(sub, ["event-v1"], { models: [liar], pricing: { liar: [1_000_000, 0] }, budgetUsd: 0.01 });
    expect(capped.stoppedByBudget).toBe(true);
  });

  it("skips a model it cannot reach instead of failing every case slowly", async () => {
    const down = { name: "down", model: "down", generate: async () => { throw new LLMError("connection refused"); } };
    const r = await evalEvents(sub, ["event-v1"], { models: [down], pricing: {}, budgetUsd: 1 });
    expect(r.rows[0]!.failures.length).toBe(4); // 3 cases + the skip note
    expect(r.rows[0]!.failures.at(-1)?.reason).toMatch(/skipped: first 3 calls could not reach the model/);
  });

  it("judge sanity: the offline heuristic is caught going bearish on a TOB target", async () => {
    const r = await evalJudge(judge, ["judge-v2"], { models: [new FakeProvider("h", heuristicResponder)], pricing: {}, budgetUsd: 10 });
    expect(r.rows[0]!.extra?.["misread"]).toBe(0);
    expect(r.rows[0]!.failures.map((f) => f.id)).toContain("down-trend-tob-target");
  });
});

describe("prompt versions", () => {
  it("are selectable in config and reach the model", async () => {
    expect(AppConfig.parse({ watchlist: {} }).prompts).toEqual({ event: "event-v1", judge: "judge-v1", redTeam: "redteam-v1", universe: "universe-v1" });
    // any well-formed name passes the config (user versions live in prompts/); unknown ones fail when used
    expect(() => AppConfig.parse({ watchlist: {}, prompts: { event: "judge-v1" } })).toThrow();
    expect(() => new PromptRegistry(mkdtempSync(join(tmpdir(), "p-"))).event("event-v9")).toThrow(/unknown event prompt version "event-v9"/);
    let seen = "";
    const spy = new FakeProvider("spy", (req) => ((seen = req.system), heuristicResponder(req)));
    const ex = new EventExtractor(new StructuredCaller(), [spy], { quorum: 1, prompt: { version: "event-v2", ...EVENT_PROMPTS["event-v2"] } });
    await ex.extract({ doc: { source: "s", url: "u", title: "架空精機が上方修正", body: "通期の営業利益を50億円から60億円に上方修正する。", publishedAt: null, fetchedAt: "2026-01-01T00:00:00Z", sourceWeight: 1, alsoSeenIn: [] }, candidates: { X101: "架空精機" }, priority: new Set() });
    expect(seen.startsWith(EVENT_PROMPTS["event-v2"].system)).toBe(true);
    expect(seen).toContain("## eventType の判定基準");
  });
});

describe("failure reasons", () => {
  it("name the fields that missed and what was expected", async () => {
    const { explainMismatch, scoreEvent } = await import("../src/eval/promptEval.ts");
    const { EventCase } = await import("../src/eval/golden.ts");
    const c = EventCase.parse({
      id: "x", candidates: { X101: "架空精機" }, doc: { title: "t" },
      expect: { relevant: true, tickers: ["X101"], eventType: ["guidance_up"], direction: [2], materiality: [3], horizon: ["months"] },
    });
    const v = { relevant: true, tickers: ["X101"], eventType: "guidance_up" as const, direction: 1, materiality: 3, horizon: "weeks" as const, confidence: 0.9, evidence: [], rationale: "" };
    const s = scoreEvent(c, v);
    expect(s.ok).toBe(false);
    expect(explainMismatch(c, v, s)).toBe("direction=+1（期待 +2） · horizon=weeks（期待 months）");
  });
});

