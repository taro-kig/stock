import { describe, expect, it } from "vitest";
import { StructuredCaller } from "../src/harness/structured.ts";
import { FakeProvider } from "../src/llm/fake.ts";
import { EventExtractor, type ExtractionContext } from "../src/signals/extractor.ts";
import { eventJson, makeDoc } from "./helpers.ts";

const ctx = (): ExtractionContext => ({ doc: makeDoc(), candidates: { "7203": "トヨタ自動車" }, priority: new Set() });
const fake = (name: string, over: Record<string, unknown> = {}) => new FakeProvider(name, [eventJson(over)]);
const extractor = (members: FakeProvider[], escalation?: FakeProvider) =>
  new EventExtractor(new StructuredCaller({ maxRetries: 0 }), members, { quorum: 2, escalation });

describe("Ensemble / EventExtractor (H3)", () => {
  it("accepts agreement and stops early", async () => {
    const [a, b, c] = [fake("a"), fake("b"), fake("c")];
    const r = await extractor([a, b, c]).extract(ctx());
    expect(r.status).toBe("consensus");
    expect(r.value?.eventType).toBe("guidance_up");
    expect(c.calls).toBe(0);
  });

  it("merges conservatively", async () => {
    const r = await extractor([fake("a", { direction: 2, materiality: 3 }), fake("b", { direction: 1, materiality: 2 })]).extract(ctx());
    expect(r.value?.direction).toBe(1);
    expect(r.value?.materiality).toBe(2);
  });

  it("rejects hallucinated evidence", async () => {
    const r = await extractor([fake("a"), fake("b", { evidence: ["営業利益が前年比3倍になる見通し"] })]).extract(ctx());
    expect(r.status).toBe("no_consensus");
    expect(r.votes[1]?.rejected).toMatch(/ungrounded/);
  });

  it("rejects tickers outside the prefilter candidates", async () => {
    const r = await extractor([fake("a", { tickers: ["7267"] }), fake("b", { tickers: ["7267"] })]).extract(ctx());
    expect(r.status).toBe("failed");
  });

  it("escalates important disagreements to a tie-breaker", async () => {
    const strong = fake("strong");
    const r = await extractor([fake("a"), fake("b", { eventType: "earnings_miss", direction: -1 })], strong).extract(ctx());
    expect(r.status).toBe("escalated");
    expect(r.value?.direction).toBe(2);
    expect(strong.calls).toBe(1);
  });

  it("requires the tie-breaker to agree with a cheap model", async () => {
    const strong = fake("strong", { eventType: "m_and_a", direction: 1 });
    const r = await extractor([fake("a"), fake("b", { eventType: "earnings_miss", direction: -1 })], strong).extract(ctx());
    expect(r.status).toBe("no_consensus");
  });

  it("does not escalate unimportant disagreements", async () => {
    const strong = fake("strong");
    const r = await extractor([fake("a", { materiality: 1, direction: 1 }), fake("b", { materiality: 1, direction: -1 })], strong).extract(ctx());
    expect(r.status).toBe("no_consensus");
    expect(strong.calls).toBe(0);
  });

  it("treats unanimous 'irrelevant' as consensus without evidence", async () => {
    const irr = { relevant: false, tickers: [], eventType: "none", direction: 0, materiality: 0, evidence: [] };
    const r = await extractor([fake("a", irr), fake("b", irr)]).extract(ctx());
    expect(r.status).toBe("consensus");
    expect(r.value?.relevant).toBe(false);
  });
});
