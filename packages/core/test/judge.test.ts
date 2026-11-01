import { describe, expect, it } from "vitest";
import { buildDossier, Judge } from "../src/ai/judge.ts";
import { StructuredCaller } from "../src/harness/structured.ts";
import { FakeProvider } from "../src/llm/fake.ts";
import { EventExtraction, type EventRecord } from "../src/signals/models.ts";
import type { FactorRow } from "../src/strategy/factors.ts";

const row: FactorRow = { ticker: "7203", name: "トヨタ自動車", sector: "auto", lastDate: "2026-10-30", close: 3000, atr: 60, momentum: 0.234, relStrength: 0.05, vol: 0.24, trend: "up", ret20: 0.031, fromHigh52: -0.02 };
const event: EventRecord = {
  docHash: "h", title: "t", url: "u", source: "s", learnedAt: "2026-10-29T06:00:00Z", agreement: 1, sourceWeight: 1, nSources: 1,
  event: EventExtraction.parse({ relevant: true, tickers: ["7203"], eventType: "guidance_up", direction: 2, materiality: 3, horizon: "months", confidence: 0.8, evidence: ["営業利益予想を上方修正"] }),
};
const dossier = (events: EventRecord[] = [event]) => buildDossier({ row, asOf: "2026-10-30", rank: 1, universe: 5, events });

const j = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    stance: "bullish", conviction: 0.7, checklist: { trend: "up", news: "positive" }, thesis: "上方修正と上昇トレンド",
    invalidation: ["終値がSMA200を割り込む"], evidence: ["トレンド判定: up (終値とSMA50がSMA200を上回る)"], ...over,
  });
const judge = (a: string, b: string, red?: FakeProvider) => new Judge(new StructuredCaller({ maxRetries: 0 }), [new FakeProvider("a", [a]), new FakeProvider("b", [b])], { redTeam: red });

describe("AI judge", () => {
  it("builds a factual dossier", () => {
    const d = dossier();
    expect(d.trend).toBe("up");
    expect(d.news).toBe("positive");
    expect(d.text).toContain("12-1ヶ月モメンタム: +23.4%");
    expect(dossier([]).news).toBe("none");
  });

  it("accepts a grounded consensus", async () => {
    const r = await judge(j(), j({ conviction: 0.6 })).judge(dossier(), false);
    expect([r.stance, r.status, r.conviction]).toEqual(["bullish", "consensus", 0.6]);
  });

  it("rejects votes that misread the facts", async () => {
    const r = await judge(j(), j({ checklist: { trend: "down", news: "positive" } })).judge(dossier(), false);
    expect(r.stance).toBe("abstain");
    expect(r.votes[1]?.rejected).toMatch(/misread trend/);
  });

  it("rejects votes that invent news", async () => {
    const r = await judge(j({ checklist: { trend: "up", news: "positive" } }), j()).judge(dossier([]), false);
    expect(r.votes[0]?.rejected).toMatch(/misread news/);
  });

  it("rejects directional calls without an invalidation condition", async () => {
    const r = await judge(j({ invalidation: [] }), j()).judge(dossier(), false);
    expect(r.votes[0]?.rejected).toMatch(/invalidation/);
  });

  it("disagreement means abstain", async () => {
    const r = await judge(j(), j({ stance: "neutral" })).judge(dossier(), false);
    expect([r.stance, r.status]).toEqual(["abstain", "no_consensus"]);
  });

  it("a grounded red-team objection vetoes a buy", async () => {
    const red = new FakeProvider("red", [JSON.stringify({ found: true, severity: 2, reason: "ボラが高い", evidence: ["60日ボラティリティ: +24.0%"] })]);
    const r = await judge(j(), j(), red).judge(dossier(), false);
    expect([r.stance, r.status]).toEqual(["neutral", "vetoed"]);
  });

  it("an ungrounded objection is ignored; a broken red team vetoes (fail-safe)", async () => {
    const fake = new FakeProvider("red", [JSON.stringify({ found: true, severity: 3, reason: "x", evidence: ["粉飾決算の疑いがある"] })]);
    expect((await judge(j(), j(), fake).judge(dossier(), false)).stance).toBe("bullish");
    const broken = new FakeProvider("red", ["not json"]);
    const r = await judge(j(), j(), broken).judge(dossier(), false);
    expect(r.status).toBe("vetoed");
    expect(r.vetoReason).toMatch(/unavailable/);
  });
});
