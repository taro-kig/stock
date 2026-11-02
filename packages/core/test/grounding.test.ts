import { describe, expect, it } from "vitest";
import { checkEvidence, checkNumbers, quoteInSource } from "../src/harness/grounding.ts";
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

describe("numbers in free text (H2b)", () => {
  const PR = "Apple reported revenue of $94.9 billion, up 6% year over year, and diluted EPS of $1.64, up 12.3%. Gross margin was 46.2 percent. The company repurchased 1,250 million dollars of stock in Q3 2026.";
  it("accepts numbers that are in the source, rounded or rescaled", () => {
    expect(checkNumbers("売上高 94.9B ドル、前年比 6% 増、EPS は 12% 増", PR)).toEqual({ ok: true, failed: [] });
    expect(checkNumbers("自社株買い 1.25 billion", PR).ok).toBe(true); // 1,250 million
    expect(checkNumbers("粗利益率 46.2%", PR).ok).toBe(true);
  });
  it("rejects a figure the source never gives", () => {
    expect(checkNumbers("EPS は 25% 増と大幅に伸びた", PR)).toEqual({ ok: false, failed: ["25%"] });
    expect(checkNumbers("売上高 98.1B ドル", PR).failed).toEqual(["98.1"]);
  });
  it("ignores small counts and years", () => {
    expect(checkNumbers("2 四半期連続で 3 つの事業が伸びた（2026 年）", PR).ok).toBe(true);
  });
  it("reads full-width digits", () => {
    expect(checkNumbers("営業利益予想を４兆９０００億円に", SOURCE_TEXT).ok).toBe(true);
    expect(checkNumbers("営業利益は 5.2 兆円", SOURCE_TEXT).ok).toBe(false);
  });
});
