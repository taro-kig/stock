import { describe, expect, it } from "vitest";
import { checkEvidence, quoteInSource } from "../src/harness/grounding.ts";
import { SOURCE_TEXT } from "./helpers.ts";

describe("grounding (H2)", () => {
  it("accepts an exact quote", () => expect(quoteInSource("円安と北米販売の好調が寄与する", SOURCE_TEXT)).toBe(true));
  it("normalizes full-width characters and spaces", () => expect(quoteInSource("４兆９０００億円 に 上方修正", SOURCE_TEXT)).toBe(true));
  it("rejects a fabricated quote", () => expect(quoteInSource("営業利益予想を6兆円に引き上げた", SOURCE_TEXT)).toBe(false));
  it("rejects trivially short quotes", () => expect(quoteInSource("トヨタ", SOURCE_TEXT)).toBe(false));
  it("tolerates a small edit at the end", () => expect(quoteInSource("円安と北米販売の好調が寄与する…", SOURCE_TEXT)).toBe(true));
  it("requires all quotes and at least one", () => {
    expect(checkEvidence(["円安と北米販売の好調が寄与する", "でっちあげの引用文です"], SOURCE_TEXT)).toEqual({ ok: false, failed: ["でっちあげの引用文です"] });
    expect(checkEvidence([], SOURCE_TEXT)).toEqual({ ok: false, failed: [] });
  });
});
