import { describe, expect, it } from "vitest";
import { BudgetExceeded, CostTracker } from "../src/harness/budget.ts";
import { LLMCache } from "../src/harness/cache.ts";
import { StructuredCaller } from "../src/harness/structured.ts";
import { FakeProvider } from "../src/llm/fake.ts";
import { EventExtraction } from "../src/signals/models.ts";
import { openDb } from "../src/util/db.ts";
import { eventJson } from "./helpers.ts";

const args = (promptVersion = "v1", user = "doc") => ({ schemaName: "EventExtraction", system: "sys", user, promptVersion });

describe("StructuredCaller (H1/H4/H5)", () => {
  it("retries after invalid output, then succeeds", async () => {
    const p = new FakeProvider("m", ["I think it's bullish!", eventJson({ direction: 5 }), "```json\n" + eventJson() + "\n```"]);
    const r = await new StructuredCaller({ maxRetries: 2 }).call(p, EventExtraction, args());
    expect(r.value?.direction).toBe(2);
    expect(r.attempts).toBe(3);
  });

  it("gives up after maxRetries", async () => {
    const r = await new StructuredCaller({ maxRetries: 1 }).call(new FakeProvider("m", ["nope"]), EventExtraction, args());
    expect(r.value).toBeNull();
    expect(r.attempts).toBe(2);
    expect(r.error).toMatch(/invalid output/);
  });

  it("caches validated output and keys on prompt version", async () => {
    const p = new FakeProvider("m", [eventJson()]);
    const caller = new StructuredCaller({ cache: new LLMCache(openDb(":memory:")) });
    expect((await caller.call(p, EventExtraction, args())).cached).toBe(false);
    expect((await caller.call(p, EventExtraction, args())).cached).toBe(true);
    expect(p.calls).toBe(1);
    await caller.call(p, EventExtraction, args("v2"));
    expect(p.calls).toBe(2);
  });

  it("stops at the daily budget cap", async () => {
    const budget = new CostTracker(openDb(":memory:"), { pricing: { m: [1_000_000, 0] }, dailyLimitUsd: 0.01 });
    const caller = new StructuredCaller({ budget });
    const p = new FakeProvider("m", [eventJson()]);
    await caller.call(p, EventExtraction, args());
    await expect(caller.call(p, EventExtraction, args("v1", "other doc"))).rejects.toBeInstanceOf(BudgetExceeded);
  });

  it("charges unknown models a pessimistic price", () => {
    expect(new CostTracker(openDb(":memory:")).costOf("unknown", 1_000_000, 0)).toBeGreaterThan(1);
  });
});
