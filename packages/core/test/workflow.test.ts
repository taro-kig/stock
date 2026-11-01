import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { AppConfig } from "../src/config.ts";
import { Services } from "../src/services.ts";
import { WaitingForInput } from "../src/workflow/context.ts";
import { Engine } from "../src/workflow/engine.ts";
import { defineNode, NodeRegistry } from "../src/workflow/registry.ts";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { parseWorkflow, stringifyWorkflow, toGraph, validateWorkflow, WorkflowError } from "../src/workflow/spec.ts";

let calls: Record<string, number>;
const bump = (k: string) => (calls[k] = (calls[k] ?? 0) + 1);

const constNode = defineNode({
  type: "t.const", title: "Const", category: "data", description: "emits a number", version: 1, cache: "inputs",
  params: z.object({ value: z.number() }), inputs: {}, outputs: { n: { type: "Count" } },
  async run(_ctx, p) {
    bump(`const:${p.value}`);
    return { n: p.value };
  },
});
const addNode = defineNode({
  type: "t.add", title: "Add", category: "signal", description: "a + b", version: 1, cache: "inputs",
  params: z.object({}), inputs: { a: { type: "Count" }, b: { type: "Count", optional: true } }, outputs: { n: { type: "Count" } },
  async run(_ctx, _p, i) {
    bump("add");
    return { n: i.a + (i.b ?? 0) };
  },
});
const failNode = defineNode({
  type: "t.fail", title: "Fail", category: "data", description: "always throws", version: 1, cache: "inputs",
  params: z.object({ nan: z.boolean().default(false) }), inputs: {}, outputs: { n: { type: "Count" } },
  fallback: () => ({ n: -1 }),
  async run(_ctx, p) {
    bump("fail");
    if (p.nan) return { n: Number.NaN };
    throw new Error("boom");
  },
});
const gateNode = defineNode({
  type: "t.gate", title: "Gate", category: "gate", description: "needs approval", version: 1, cache: "none",
  params: z.object({}), inputs: { n: { type: "Count" } }, outputs: { n: { type: "Count" } },
  async run(ctx, _p, i) {
    bump("gate");
    const a = ctx.approval();
    if (!a) throw new WaitingForInput("approve me");
    return { n: a.decision === "approve" ? i.n : 0 };
  },
});
const docsNode = defineNode({
  type: "t.docs", title: "Docs", category: "source", description: "", version: 1, cache: "none",
  params: z.object({}), inputs: {}, outputs: { docs: { type: "Documents" } },
  async run() {
    return { docs: [] };
  },
});

const registry = () => new NodeRegistry().register(constNode, addNode, failNode, gateNode, docsNode);

let services: Services;
let engine: Engine;
beforeEach(() => {
  calls = {};
  services = new Services(AppConfig.parse({ watchlist: {} }), { dbPath: ":memory:" });
  engine = new Engine({ services, registry: registry(), store: services.runStore });
});

const wf = (yaml: string) => parseWorkflow(yaml);
const SUM = `
name: sum
nodes:
  x: { use: t.const, params: { value: 2 } }
  y: { use: t.const, params: { value: 3 } }
  s: { use: t.add, in: { a: x, b: y.n } }
`;

describe("workflow validation", () => {
  it("reports unknown types, missing inputs, type mismatches, bad refs and cycles", () => {
    const problems = validateWorkflow(
      wf(`
name: bad
nodes:
  a: { use: t.nope }
  b: { use: t.add }
  c: { use: t.add, in: { a: d } }
  d: { use: t.docs }
  e: { use: t.add, in: { a: f } }
  f: { use: t.add, in: { a: e } }
  g: { use: t.add, in: { a: zz.n } }
  h: { use: t.const, params: { value: "x" } }
  i: { use: t.const, params: { value: 1 }, onError: fallback }
`),
      registry(),
    );
    const text = problems.join("\n");
    expect(text).toMatch(/a: unknown node type "t.nope"/);
    expect(text).toMatch(/b: required input "a" \(Count\) is not connected/);
    expect(text).toMatch(/c.in.a: type mismatch, expects Count but d.docs is Documents/);
    expect(text).toMatch(/cycle detected among: e, f/);
    expect(text).toMatch(/g.in.a: unknown node "zz"/);
    expect(text).toMatch(/h.params.value/);
    expect(text).toMatch(/i: onError=fallback but "t.const" has no fallback/);
  });

  it("rejects invalid specs at run time", async () => {
    await expect(engine.run(wf("name: x\nnodes:\n  a: { use: t.nope }"))).rejects.toBeInstanceOf(WorkflowError);
  });

  it("exports a graph for the node UI", () => {
    const g = toGraph(wf(SUM), registry());
    expect(g.nodes.map((n) => n.id)).toEqual(["x", "y", "s"]);
    expect(g.edges).toEqual([
      { from: { node: "x", port: "n" }, to: { node: "s", port: "a" }, type: "Count" },
      { from: { node: "y", port: "n" }, to: { node: "s", port: "b" }, type: "Count" },
    ]);
  });
});

describe("workflow engine", () => {
  it("refuses to start a disabled workflow, and runs again once enabled", async () => {
    services.runStore.setDisabled("sum", true, "maintenance");
    await expect(engine.run(wf(SUM))).rejects.toThrow(/disabled/);
    expect(services.runStore.listRuns(10, "sum")).toHaveLength(0);
    services.runStore.setDisabled("sum", false);
    expect((await engine.run(wf(SUM))).status).toBe("succeeded");
  });

  it("runs nodes in dependency order", async () => {
    const r = await engine.run(wf(SUM), { asOf: "2026-10-30" });
    expect(r.status).toBe("succeeded");
    expect(r.output("s", "n")).toBe(5);
    expect(services.runStore.events(r.runId).map((e) => e.type)).toEqual(["run_started", "node_finished", "node_finished", "node_finished", "run_finished"]);
  });

  it("reuses cached node outputs across runs and workflows", async () => {
    await engine.run(wf(SUM));
    const r2 = await engine.run(wf(SUM.replace("name: sum", "name: other")));
    expect(Object.values(r2.nodes).map((n) => n.status)).toEqual(["cached", "cached", "cached"]);
    expect(calls).toEqual({ "const:2": 1, "const:3": 1, add: 1 });
    await engine.run(wf(SUM.replace("value: 3", "value: 4")));
    expect(calls["add"]).toBe(2);
  });

  it("abort stops the run", async () => {
    const r = await engine.run(wf("name: a\nnodes:\n  f: { use: t.fail }\n  x: { use: t.const, params: { value: 1 } }"));
    expect(r.status).toBe("failed");
    expect(r.nodes["f"]?.error).toBe("boom");
    expect(r.nodes["x"]?.status).toBe("skipped");
  });

  it("skip continues independent branches", async () => {
    const r = await engine.run(
      wf("name: s\nnodes:\n  f: { use: t.fail, onError: skip }\n  d: { use: t.add, in: { a: f } }\n  x: { use: t.const, params: { value: 1 } }"),
    );
    expect(r.status).toBe("partial");
    expect([r.nodes["f"]?.status, r.nodes["d"]?.status, r.nodes["x"]?.status]).toEqual(["failed", "skipped", "ok"]);
  });

  it("an optional input from a failed upstream becomes undefined", async () => {
    const r = await engine.run(
      wf("name: o\nnodes:\n  f: { use: t.fail, onError: skip }\n  x: { use: t.const, params: { value: 7 } }\n  s: { use: t.add, in: { a: x, b: f } }"),
    );
    expect(r.output("s", "n")).toBe(7);
  });

  it("fallback substitutes the node's safe default", async () => {
    const r = await engine.run(wf("name: fb\nnodes:\n  f: { use: t.fail, onError: fallback }\n  s: { use: t.add, in: { a: f } }"));
    expect(r.nodes["f"]?.status).toBe("fallback");
    expect(r.output("s", "n")).toBe(-1);
  });

  it("rejects non-JSON outputs such as NaN", async () => {
    const r = await engine.run(wf("name: nan\nnodes:\n  f: { use: t.fail, params: { nan: true } }"));
    expect(r.nodes["f"]?.status).toBe("failed");
    expect(r.nodes["f"]?.error).toMatch(/non-finite/);
  });

  it("pauses at an approval gate and resumes without re-running finished nodes", async () => {
    const spec = wf(`
name: g
nodes:
  x: { use: t.const, params: { value: 5 } }
  g: { use: t.gate, in: { n: x } }
  s: { use: t.add, in: { a: g } }
`);
    const r1 = await engine.run(spec);
    expect(r1.status).toBe("waiting");
    expect([r1.nodes["g"]?.status, r1.nodes["s"]?.status]).toEqual(["waiting", "pending"]);
    services.runStore.setApproval(r1.runId, "g", "approve");
    const r2 = await engine.resume(r1.runId);
    expect(r2.status).toBe("succeeded");
    expect(r2.output("s", "n")).toBe(5);
    expect(calls["const:5"]).toBe(1);
    expect(calls["gate"]).toBe(2);
  });
});

describe("stringifyWorkflow", () => {
  it("round-trips every shipped workflow", () => {
    const dir = resolve(import.meta.dirname, "../../../workflows");
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".yaml"))) {
      const spec = parseWorkflow(readFileSync(resolve(dir, f), "utf8"));
      const text = stringifyWorkflow(spec);
      expect(parseWorkflow(text)).toEqual(spec);
      expect(text.split("\n").filter((l) => l.startsWith("  ") && l.includes("use:")).length).toBe(Object.keys(spec.nodes).length);
    }
  });
});
