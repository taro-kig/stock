import { describe, expect, it } from "vitest";
import { groupFailures, VoteProblems } from "../src/nodes/problems.ts";
import type { NodeContext } from "../src/workflow/context.ts";

describe("node problem reporting", () => {
  it("groups the same reason across symbols", () => {
    expect(groupFailures(["AAPL: 404 AAPL not found", "MSFT: 404 MSFT not found", "SPY: HTTP 500"])).toBe("AAPL, MSFT: 404 … not found / SPY: HTTP 500");
    expect(groupFailures(["A: x", "B: y", "C: z", "D: w"], 2)).toBe("A: x / B: y / 他 2 種類");
    expect(groupFailures(["plain message"])).toBe("plain message");
  });

  it("logs each failed LLM call once and counts them; grounding rejections are not problems", () => {
    const logs: string[] = [];
    const metrics: Record<string, number> = {};
    const ctx = { log: (m: string) => logs.push(m), metric: (k: string, v: number) => (metrics[k] = (metrics[k] ?? 0) + v) } as unknown as NodeContext;
    const p = new VoteProblems(ctx);
    for (let i = 0; i < 3; i++) {
      p.note([
        { provider: "gemini-lite", rejected: "llm: HTTP 404 models/gemini-9 is not found" },
        { provider: "deepseek", rejected: "quote not found in source" },
        { provider: "deepseek", rejected: null },
      ]);
    }
    p.note([{ provider: "deepseek", rejected: "invalid output: stance: expected one of ..." }]);
    p.finish();
    expect(logs).toEqual([
      "gemini-lite: call failed — llm: HTTP 404 models/gemini-9 is not found",
      "deepseek: unusable answer — invalid output: stance: expected one of ...",
    ]);
    expect(metrics).toEqual({ llmErrors: 3, invalidOutputs: 1 });
  });
});
