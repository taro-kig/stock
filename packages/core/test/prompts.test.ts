import { copyFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { AppConfig, loadConfig } from "../src/config.ts";
import { buildScorecard } from "../src/eval/scorecard.ts";
import { builtinRegistry } from "../src/nodes/index.ts";
import { runPromptEval } from "../src/prompts/evaluate.ts";
import { PromptRegistry } from "../src/prompts/registry.ts";
import { Services } from "../src/services.ts";
import { EVENT_PROMPTS } from "../src/signals/prompts.ts";
import { saveConfigValue } from "../src/util/configFile.ts";
import { Engine } from "../src/workflow/engine.ts";
import { parseWorkflow } from "../src/workflow/spec.ts";

const ROOT = resolve(import.meta.dirname, "../../..");
const tmp = () => mkdtempSync(join(tmpdir(), "prompts-"));
const TEXT = "あなたは慎重なアナリストである。観測報道は確信度を 0.3 以下にする。".repeat(2);

describe("prompt registry", () => {
  it("lists built-ins and creates user versions as Markdown files that inherit the input format", () => {
    const dir = tmp();
    const r = new PromptRegistry(dir);
    expect(r.list("event").map((p) => p.version)).toEqual(["event-v1", "event-v2", "event-us-v1"]);
    expect(r.list("judge").every((p) => p.builtin)).toBe(true);
    const v = r.create("event", { version: "event-us-v1-my1", parent: "event-us-v1", system: TEXT, description: "観測報道を弱く" }, new Date("2026-11-02T00:00:00Z"));
    expect(v).toMatchObject({ builtin: false, parent: "event-us-v1", base: "event-us-v1", description: "観測報道を弱く" });
    const file = readFileSync(join(dir, "event", "event-us-v1-my1.md"), "utf8");
    expect(file).toMatch(/^---\nparent: event-us-v1\n/);
    expect(file).toContain(TEXT);
    // a version of a version still resolves to the built-in's input format
    r.create("event", { version: "event-us-v1-my2", parent: "event-us-v1-my1", system: `${TEXT}追記` });
    expect(r.info("event", "event-us-v1-my2").base).toBe("event-us-v1");
    const p = r.event("event-us-v1-my2");
    expect(p.system).toBe(`${TEXT}追記`);
    expect(p.user).toBe(EVENT_PROMPTS["event-us-v1"].user);
    r.create("judge", { version: "judge-v2-strict", parent: "judge-v2", system: TEXT });
    expect(r.judge("judge-v2-strict").dossier).toBe("v2");
  });

  it("never overwrites, and checks names, parents and length", () => {
    const r = new PromptRegistry(tmp());
    r.create("judge", { version: "judge-a", parent: "judge-v1", system: TEXT });
    expect(() => r.create("judge", { version: "judge-a", parent: "judge-v1", system: TEXT })).toThrow(/already exists/);
    expect(() => r.create("judge", { version: "judge-v1", parent: "judge-v1", system: TEXT })).toThrow(/already exists/);
    expect(() => r.create("judge", { version: "event-x", parent: "judge-v1", system: TEXT })).toThrow(/judge-/);
    expect(() => r.create("judge", { version: "judge-Bad", parent: "judge-v1", system: TEXT })).toThrow();
    expect(() => r.create("judge", { version: "judge-b", parent: "judge-zzz", system: TEXT })).toThrow(/unknown/);
    expect(() => r.create("judge", { version: "judge-c", parent: "judge-v1", system: "短い" })).toThrow(/short/);
  });
});

describe("prompts in workflows", () => {
  it("a workflow can pin its own versions; judgments carry them and the scorecard splits by them", async () => {
    const dir = tmp();
    const config = AppConfig.parse({
      promptsDir: dir, market: { currency: "USD", benchmark: "SPY" },
      watchlist: { AAPL: { name: "Apple", sector: "tech" }, MSFT: { name: "Microsoft", sector: "tech" }, NVDA: { name: "NVIDIA", sector: "semis" } },
    });
    const s = new Services(config, { fake: true, dbPath: ":memory:" });
    s.prompts.create("judge", { version: "judge-v2-my1", parent: "judge-v2", system: TEXT });
    const engine = new Engine({ services: s, registry: builtinRegistry(), store: s.runStore });
    const spec = (name: string, extra: string) => parseWorkflow(`name: ${name}
nodes:
  prices:  { use: data.pricesSynthetic, params: { seed: 1 } }
  factors: { use: signal.factors, in: { prices: prices } }
  score:   { use: signal.score, in: { factors: factors } }
  decide:  { use: decide.ai, in: { factors: factors, scores: score }${extra} }
  record:  { use: eval.record, in: { judgments: decide } }
`);
    const a = await engine.run(spec("wf-a", ""), { asOf: "2026-08-03" });
    const b = await engine.run(spec("wf-b", ", params: { promptVersion: judge-v2-my1, redTeam: false }"), { asOf: "2026-08-03" });
    const ja = Object.values(a.output<Record<string, { prompt?: string }>>("decide", "judgments"));
    const jb = Object.values(b.output<Record<string, { prompt?: string }>>("decide", "judgments"));
    expect(ja.every((j) => j.prompt === "judge-v1+redteam-v1")).toBe(true);
    expect(jb.every((j) => j.prompt === "judge-v2-my1")).toBe(true);
    const preds = s.predictions.all();
    expect(new Set(preds.map((p) => p.prompt))).toEqual(new Set(["judge-v1+redteam-v1", "judge-v2-my1"]));
    // the same label with two prompt versions is split
    const mixed = preds.map((p) => ({ ...p, label: "x" }));
    const prices = a.output<Record<string, never>>("prices", "prices");
    const card = buildScorecard(mixed, prices, "2026-10-30", 20, { minNEff: 100, minWilson: 0.5, mustBeat: [] } as never, "SPY");
    expect(card.labels["x"]!.byPrompt.map((x) => x.prompt).sort()).toEqual(["judge-v1+redteam-v1", "judge-v2-my1"]);
    // an unknown pinned version fails loudly instead of silently using another one
    const bad = await engine.run(spec("wf-c", ", params: { promptVersion: judge-nope }"), { asOf: "2026-08-03" });
    expect(bad.status).toBe("failed");
    expect(bad.nodes["decide"]?.error).toMatch(/unknown judge prompt version "judge-nope"/);
  });

  it("user versions can be evaluated on the golden set", async () => {
    const dir = tmp();
    const s = new Services(AppConfig.parse({ promptsDir: dir, market: { currency: "USD" }, watchlist: {} }), { fake: true, dbPath: ":memory:" });
    s.prompts.create("event", { version: "event-us-v1-my1", parent: "event-us-v1", system: TEXT });
    const set = join(ROOT, "examples/golden/events-us.yaml");
    const r = await runPromptEval(s, { family: "event", versions: ["event-us-v1", "event-us-v1-my1"], models: ["fake-a"], budgetUsd: 1, set });
    expect(r.rows.map((x) => x.version)).toEqual(["event-us-v1", "event-us-v1-my1"]);
    expect(r.set).toBe("events-us-draft-v1");
    await expect(runPromptEval(s, { family: "redteam" })).rejects.toThrow(/no golden set/);
    // default: the versions written for the configured market (US), user ones included
    const d = await runPromptEval(s, { family: "event", models: ["fake-a"], budgetUsd: 1, set });
    expect(d.rows.map((x) => x.version)).toEqual(["event-us-v1", "event-us-v1-my1"]);
  });

  it("switching writes config.yaml and keeps comments", () => {
    const p = join(tmp(), "config.yaml");
    copyFileSync(join(ROOT, "config/config.example.yaml"), p);
    saveConfigValue(p, ["prompts", "judge"], "judge-v2");
    const text = readFileSync(p, "utf8");
    expect(text).toContain("judge: judge-v2");
    expect(text).toContain("# H5: hard daily cap");
    expect(loadConfig(p).prompts.judge).toBe("judge-v2");
  });
});
