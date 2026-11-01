import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig, type AppConfig } from "../src/config.ts";
import type { Scorecard } from "../src/eval/scorecard.ts";
import type { Fill } from "../src/execution/paper.ts";
import { builtinRegistry } from "../src/nodes/index.ts";
import { Services } from "../src/services.ts";
import { weekdays } from "../src/util/dates.ts";
import { Engine } from "../src/workflow/engine.ts";
import { loadWorkflow, type WorkflowSpec } from "../src/workflow/spec.ts";

const ROOT = resolve(import.meta.dirname, "../../..");
const config = (): AppConfig => loadConfig(resolve(ROOT, "config/config.jp.example.yaml"));
const demo = (name: string, gate?: "manual"): WorkflowSpec => {
  const spec = loadWorkflow(resolve(ROOT, `workflows/${name}.yaml`));
  spec.nodes["news"]!.params["path"] = resolve(ROOT, "examples/fixtures/news.json");
  if (gate) spec.nodes["approve"]!.params["mode"] = gate;
  return spec;
};
const setup = () => {
  const services = new Services(config(), { fake: true, dbPath: ":memory:" });
  return { services, engine: new Engine({ services, registry: builtinRegistry(), store: services.runStore }) };
};

describe("end to end (offline, fake models)", () => {
  it("replays the AI and rules workflows, trades, records and grades predictions", async () => {
    const { services, engine } = setup();
    let fills = 0;
    let card: Scorecard | undefined;
    for (const d of weekdays("2026-05-04", "2026-10-30", 10)) {
      for (const wf of ["demo-rules", "demo-ai"]) {
        const r = await engine.run(demo(wf), { asOf: d });
        expect(r.status).toBe("succeeded");
        fills += r.output<Fill[]>("execute", "fills").length;
        if (wf === "demo-ai") card = r.output<Scorecard>("grade", "scorecard");
      }
    }
    expect(fills).toBeGreaterThan(0);
    expect(card?.labels["demo-ai"]?.graded).toBeGreaterThan(0);
    expect(card?.labels["demo-rules"]?.graded).toBeGreaterThan(0);
    const preds = services.predictions.all();
    expect(new Set(preds.map((p) => p.label))).toEqual(new Set(["demo-ai", "demo-rules"]));
    expect(services.budget.spentToday()).toBe(0); // fake models are free
  });

  it("shares cached nodes between workflows", async () => {
    const { engine } = setup();
    await engine.run(demo("demo-rules"), { asOf: "2026-07-21" });
    const ai = await engine.run(demo("demo-ai"), { asOf: "2026-07-21" });
    for (const id of ["news", "dedup", "match", "extract", "prices", "factors", "score"]) expect(ai.nodes[id]?.status).toBe("cached");
  });

  it("pauses for approval, then fills exactly once", async () => {
    const { services, engine } = setup();
    const spec = demo("demo-ai", "manual");
    let waiting;
    for (const d of weekdays("2026-06-01", "2026-10-30")) {
      const r = await engine.run(spec, { asOf: d });
      if (r.status === "waiting") {
        waiting = r;
        break;
      }
    }
    expect(waiting, "expected some day to produce orders").toBeDefined();
    expect(waiting!.nodes["execute"]?.status).toBe("pending");
    services.runStore.setApproval(waiting!.runId, "approve", "approve");
    const r1 = await engine.resume(waiting!.runId);
    expect(r1.status).toBe("succeeded");
    const f1 = r1.output<Fill[]>("execute", "fills");
    expect(f1.length).toBeGreaterThan(0);
    // even if the execution step is forced to re-run, the same run never fills twice
    services.db.prepare("UPDATE wf_node_runs SET status = 'failed' WHERE run_id = ? AND node_id = 'execute'").run(waiting!.runId);
    const r2 = await engine.resume(waiting!.runId);
    expect(r2.output<Fill[]>("execute", "fills")).toEqual(f1);
  });

  it("a rejected approval places no orders", async () => {
    const { services, engine } = setup();
    const spec = demo("demo-ai", "manual");
    for (const d of weekdays("2026-06-01", "2026-10-30")) {
      const r = await engine.run(spec, { asOf: d });
      if (r.status !== "waiting") continue;
      services.runStore.setApproval(r.runId, "approve", "reject");
      const done = await engine.resume(r.runId);
      expect(done.output<Fill[]>("execute", "fills")).toEqual([]);
      return;
    }
    throw new Error("no day produced orders");
  });
});
