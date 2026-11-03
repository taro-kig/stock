import { copyFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { setWorkflowParam } from "../src/workflow/editFile.ts";

const ROOT = resolve(import.meta.dirname, "../../..");

describe("editing one node parameter in a workflow file", () => {
  it("sets the weights, keeps comments and layout, and keeps the previous file", () => {
    const f = join(mkdtempSync(join(tmpdir(), "wf-")), "daily-ai.yaml");
    copyFileSync(join(ROOT, "workflows/daily-ai.yaml"), f);
    const before = readFileSync(f, "utf8");
    const r = setWorkflowParam(f, "score", "weights", { momentum: 0.3, quality: 0.2, high52: 0.1 });
    const after = readFileSync(f, "utf8");
    expect(r.previous).toBeNull(); // the defaults were used before
    expect(r.spec.nodes["score"]!.params["weights"]).toEqual({ momentum: 0.3, quality: 0.2, high52: 0.1 });
    expect(after).toContain("# ── information (English news + SEC filings)");
    expect(after).toMatch(/score: +\{ use: signal\.score, .*params: \{ weights: \{ momentum: 0\.3, quality: 0\.2, high52: 0\.1 \} \}/);
    expect(readFileSync(`${f}.bak`, "utf8")).toBe(before);
    expect(after.split("\n").length).toBe(before.split("\n").length); // nothing else moved
    const again = setWorkflowParam(f, "score", "weights", { momentum: 1 });
    expect(again.previous).toEqual({ momentum: 0.3, quality: 0.2, high52: 0.1 });
  });

  it("refuses unknown nodes", () => {
    const f = join(mkdtempSync(join(tmpdir(), "wf-")), "w.yaml");
    copyFileSync(join(ROOT, "workflows/daily-ai.yaml"), f);
    expect(() => setWorkflowParam(f, "nope", "weights", {})).toThrow(/no node "nope"/);
  });
});
