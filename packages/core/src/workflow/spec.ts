import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type { NodeRegistry } from "./registry.ts";

export const NodeConfig = z.strictObject({
  /** Node type, e.g. "llm.extractEvents". */
  use: z.string(),
  params: z.record(z.string(), z.unknown()).default({}),
  /** inputPort -> "node.port" (or "node" when it has a single output). */
  in: z.record(z.string(), z.string()).default({}),
  /** Ordering-only dependencies. */
  after: z.array(z.string()).default([]),
  /** abort: stop the run. skip: mark failed, skip dependants, continue. fallback: use the node's safe default. */
  onError: z.enum(["abort", "skip", "fallback"]).default("abort"),
  cache: z.boolean().default(true),
  /** Layout for the node UI; ignored by the engine. */
  ui: z.object({ x: z.number(), y: z.number() }).partial().default({}),
});
export type NodeConfig = z.output<typeof NodeConfig>;

export const WorkflowSpec = z.strictObject({
  name: z.string().regex(/^[a-z0-9_-]+$/, "lowercase letters, digits, _ and -"),
  description: z.string().default(""),
  nodes: z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9_]*$/, "identifier"), NodeConfig),
});
export type WorkflowSpec = z.output<typeof WorkflowSpec>;

export class WorkflowError extends Error {
  override name = "WorkflowError";
  readonly problems: string[];
  constructor(problems: string[]) {
    super(`invalid workflow:\n- ${problems.join("\n- ")}`);
    this.problems = problems;
  }
}

export function parseWorkflow(text: string): WorkflowSpec {
  const r = WorkflowSpec.safeParse(parseYaml(text));
  if (!r.success) throw new WorkflowError(r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`));
  return r.data;
}

export function loadWorkflow(path: string): WorkflowSpec {
  return parseWorkflow(readFileSync(path, "utf8"));
}

export interface PortRef {
  node: string;
  port: string;
}

/** Resolves "node.port" / "node" against the spec. Returns an error string on failure. */
export function resolveRef(ref: string, spec: WorkflowSpec, registry: NodeRegistry): PortRef | string {
  const [node, port, ...rest] = ref.split(".");
  if (!node || rest.length) return `bad reference "${ref}"`;
  const cfg = spec.nodes[node];
  if (!cfg) return `unknown node "${node}" in "${ref}"`;
  const def = registry.get(cfg.use);
  if (!def) return `node "${node}" has unknown type`;
  const outs = Object.keys(def.outputs);
  if (port === undefined) {
    if (outs.length !== 1) return `"${ref}" is ambiguous; use one of ${outs.map((o) => `${node}.${o}`).join(", ")}`;
    return { node, port: outs[0]! };
  }
  if (!outs.includes(port)) return `"${node}" has no output "${port}" (has: ${outs.join(", ")})`;
  return { node, port };
}

/** Upstream node ids of `id` (data edges + `after`). */
export function dependencies(spec: WorkflowSpec, id: string): string[] {
  const cfg = spec.nodes[id]!;
  return [...new Set([...Object.values(cfg.in).map((r) => r.split(".")[0]!), ...cfg.after])];
}

/** Kahn's algorithm; ties broken by declaration order so runs are deterministic. */
export function topoOrder(spec: WorkflowSpec): string[] {
  const ids = Object.keys(spec.nodes);
  const indeg = new Map(ids.map((id) => [id, 0]));
  const children = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const id of ids) {
    for (const d of dependencies(spec, id)) {
      if (!indeg.has(d)) continue; // reported by validation
      indeg.set(id, indeg.get(id)! + 1);
      children.get(d)!.push(id);
    }
  }
  const pos = new Map(ids.map((id, i) => [id, i]));
  const order: string[] = [];
  const ready = ids.filter((id) => indeg.get(id) === 0);
  while (ready.length) {
    const id = ready.shift()!;
    order.push(id);
    for (const c of children.get(id)!) {
      indeg.set(c, indeg.get(c)! - 1);
      if (indeg.get(c) === 0) {
        ready.push(c);
        ready.sort((a, b) => pos.get(a)! - pos.get(b)!);
      }
    }
  }
  if (order.length !== ids.length) {
    throw new WorkflowError([`cycle detected among: ${ids.filter((id) => !order.includes(id)).join(", ")}`]);
  }
  return order;
}

export function validateWorkflow(spec: WorkflowSpec, registry: NodeRegistry): string[] {
  const problems: string[] = [];
  for (const [id, cfg] of Object.entries(spec.nodes)) {
    const def = registry.get(cfg.use);
    if (!def) {
      problems.push(`${id}: unknown node type "${cfg.use}"`);
      continue;
    }
    const p = def.params.safeParse(cfg.params);
    if (!p.success) for (const i of p.error.issues) problems.push(`${id}.params.${i.path.join(".")}: ${i.message}`);
    for (const port of Object.keys(cfg.in)) if (!(port in def.inputs)) problems.push(`${id}: unknown input "${port}" (has: ${Object.keys(def.inputs).join(", ") || "none"})`);
    for (const [port, decl] of Object.entries(def.inputs)) {
      const ref = cfg.in[port];
      if (ref === undefined) {
        if (!decl.optional) problems.push(`${id}: required input "${port}" (${decl.type}) is not connected`);
        continue;
      }
      const r = resolveRef(ref, spec, registry);
      if (typeof r === "string") {
        problems.push(`${id}.in.${port}: ${r}`);
        continue;
      }
      const srcType = registry.get(spec.nodes[r.node]!.use)!.outputs[r.port]!.type;
      if (srcType !== decl.type) problems.push(`${id}.in.${port}: type mismatch, expects ${decl.type} but ${r.node}.${r.port} is ${srcType}`);
    }
    for (const a of cfg.after) if (!(a in spec.nodes)) problems.push(`${id}.after: unknown node "${a}"`);
    if (cfg.onError === "fallback" && !def.fallback) problems.push(`${id}: onError=fallback but "${cfg.use}" has no fallback`);
  }
  try {
    topoOrder(spec);
  } catch (e) {
    if (e instanceof WorkflowError) problems.push(...e.problems);
    else throw e;
  }
  return problems;
}

export interface WorkflowGraph {
  name: string;
  description: string;
  nodes: Array<{
    id: string; type: string; title: string; category: string;
    params: Record<string, unknown>; onError: string; ui: { x?: number; y?: number };
    inputs: Array<{ name: string; type: string; optional: boolean }>;
    outputs: Array<{ name: string; type: string }>;
  }>;
  edges: Array<{ from: PortRef; to: PortRef; type: string }>;
}

/** Graph form for the node UI. Assumes the spec has been validated. */
export function toGraph(spec: WorkflowSpec, registry: NodeRegistry): WorkflowGraph {
  const nodes: WorkflowGraph["nodes"] = [];
  const edges: WorkflowGraph["edges"] = [];
  for (const [id, cfg] of Object.entries(spec.nodes)) {
    const def = registry.get(cfg.use)!;
    nodes.push({
      id, type: def.type, title: def.title, category: def.category, params: cfg.params, onError: cfg.onError, ui: cfg.ui,
      inputs: Object.entries(def.inputs).map(([name, d]) => ({ name, type: d.type, optional: d.optional ?? false })),
      outputs: Object.entries(def.outputs).map(([name, d]) => ({ name, type: d.type })),
    });
    for (const [port, ref] of Object.entries(cfg.in)) {
      const r = resolveRef(ref, spec, registry);
      if (typeof r !== "string") edges.push({ from: r, to: { node: id, port }, type: def.inputs[port]!.type });
    }
  }
  return { name: spec.name, description: spec.description, nodes, edges };
}
