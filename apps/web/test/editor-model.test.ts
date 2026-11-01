import { describe, expect, it } from "vitest";
import { builtinRegistry } from "@stockai/core";
import { addNode, autoLayout, canConnect, connect, disconnect, edges, localProblems, normalizeSpec, removeNode, renameNode, type Catalog } from "../src/editor/model.ts";

const catalog: Catalog = new Map(builtinRegistry().describe().map((d) => [d.type, d]));
const base = () =>
  normalizeSpec({
    name: "t",
    nodes: {
      prices: { use: "data.pricesSynthetic" },
      factors: { use: "signal.factors", in: { prices: "prices" } },
      score: { use: "signal.score", in: { factors: "factors.factors" } },
      grade: { use: "eval.scorecard", in: { prices: "prices" }, after: ["score"] },
    },
  });

describe("editor model", () => {
  it("derives edges, resolving single-output shorthand", () => {
    expect(edges(base(), catalog).map((e) => `${e.from.node}.${e.from.port}->${e.to.node}.${e.to.port}:${e.type}`)).toEqual([
      "prices.prices->factors.prices:Prices",
      "factors.factors->score.factors:Factors",
      "prices.prices->grade.prices:Prices",
    ]);
  });

  it("only connects matching types without cycles", () => {
    const s = base();
    expect(canConnect(s, catalog, { node: "prices", port: "prices" }, { node: "score", port: "factors" })).toMatch(/型が違います/);
    expect(canConnect(s, catalog, { node: "score", port: "scores" }, { node: "score", port: "events" })).toMatch(/同じノード/);
    const withEvents = addNode(s, "signal.eventScores", { x: 0, y: 0 });
    expect(canConnect(withEvents.spec, catalog, { node: "score", port: "scores" }, { node: "factors", port: "prices" })).toMatch(/型が違います/);
    const s2 = addNode(s, "data.pricesSynthetic", { x: 0, y: 0 });
    expect(s2.id).toBe("pricesSynthetic");
    expect(canConnect(s2.spec, catalog, { node: s2.id, port: "prices" }, { node: "factors", port: "prices" })).toBeNull();
    const rewired = connect(s2.spec, { node: s2.id, port: "prices" }, { node: "factors", port: "prices" });
    expect(rewired.nodes["factors"]!.in["prices"]).toBe("pricesSynthetic.prices");
    // a cycle: feed score's output back into something upstream of score
    const dec = addNode(rewired, "decide.rules", { x: 0, y: 0 });
    const wired = connect(connect(dec.spec, { node: "score", port: "scores" }, { node: dec.id, port: "scores" }), { node: "factors", port: "factors" }, { node: dec.id, port: "factors" });
    expect(canConnect(wired, catalog, { node: dec.id, port: "judgments" }, { node: "factors", port: "prices" })).toMatch(/型が違います/);
    expect(localProblems(wired, catalog)).toEqual({});
    expect(localProblems(disconnect(wired, { node: dec.id, port: "factors" }), catalog)[dec.id]?.[0]).toMatch(/必須入力 factors/);
  });

  it("detects cycles through after-dependencies", () => {
    const s = base();
    const p = addNode(s, "eval.scorecard", { x: 0, y: 0 });
    const s2 = { ...p.spec, nodes: { ...p.spec.nodes, prices: { ...p.spec.nodes["prices"]!, after: [p.id] } } };
    const x = addNode(s2, "data.pricesSynthetic", { x: 0, y: 0 });
    // grade2 waits for nothing; prices waits for grade2; connecting prices -> grade2 closes the loop
    expect(canConnect(x.spec, catalog, { node: "prices", port: "prices" }, { node: p.id, port: "prices" })).toMatch(/循環/);
  });

  it("renames and removes with references", () => {
    const r = renameNode(base(), "prices", "px");
    if (typeof r === "string") throw new Error(r);
    expect(Object.keys(r.nodes)).toEqual(["px", "factors", "score", "grade"]);
    expect(r.nodes["factors"]!.in["prices"]).toBe("px");
    expect(renameNode(base(), "prices", "factors")).toMatch(/既にあります/);
    expect(renameNode(base(), "prices", "9x")).toMatch(/英字/);
    const removed = removeNode(base(), "score");
    expect(removed.nodes["grade"]!.after).toEqual([]);
    expect(Object.keys(removed.nodes)).toEqual(["prices", "factors", "grade"]);
  });

  it("lays out left to right by depth", () => {
    const l = autoLayout(base(), catalog);
    expect(l.nodes["prices"]!.ui.x).toBe(0);
    expect(l.nodes["factors"]!.ui.x).toBeGreaterThan(0);
    expect(l.nodes["score"]!.ui.x).toBeGreaterThan(l.nodes["factors"]!.ui.x!);
    expect(l.nodes["grade"]!.ui.x).toBe(l.nodes["prices"]!.ui.x! + 3 * (l.nodes["factors"]!.ui.x! - l.nodes["prices"]!.ui.x!)); // after score
  });
});
