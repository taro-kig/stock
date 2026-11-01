import type { Document } from "../src/signals/models.ts";

export const SOURCE_TEXT =
  "トヨタ自動車は5日、2026年3月期の連結営業利益予想を従来の4兆3000億円から" +
  "4兆9000億円に上方修正すると発表した。円安と北米販売の好調が寄与する。";

export function eventJson(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    relevant: true,
    tickers: ["7203"],
    eventType: "guidance_up",
    direction: 2,
    materiality: 3,
    horizon: "months",
    confidence: 0.8,
    evidence: ["連結営業利益予想を従来の4兆3000億円から4兆9000億円に上方修正"],
    rationale: "通期予想の上方修正",
    ...over,
  });
}

export function makeDoc(over: Partial<Document> = {}): Document {
  return {
    source: "test",
    url: "https://example.com/a",
    title: "トヨタ、営業益予想を上方修正",
    body: SOURCE_TEXT,
    publishedAt: null,
    fetchedAt: "2026-11-01T06:00:00.000Z",
    sourceWeight: 1,
    alsoSeenIn: [],
    ...over,
  };
}
