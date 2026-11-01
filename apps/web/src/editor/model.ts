/**
 * Pure operations on a workflow spec for the node editor. Every function returns
 * a new spec (never mutates), so undo/redo is just a list of snapshots.
 */
import type { NodeDescription } from "@stockai/core";

export type OnError = "abort" | "skip" | "fallback";

export interface NodeCfg {
  use: string;
  params: Record<string, unknown>;
  in: Record<string, string>;
  after: string[];
  onError: OnError;
  cache: boolean;
  ui: { x?: number; y?: number };
}

export interface Spec {
  name: string;
  description: string;
  nodes: Record<string, NodeCfg>;
}

export type Catalog = ReadonlyMap<string, NodeDescription>;

export interface PortRef {
  node: string;
  port: string;
}

export interface Edge {
  from: PortRef;
  to: PortRef;
  type: string;
}

export const ID_RE = /^[A-Za-z][A-Za-z0-9_]*$/;
export const NAME_RE = /^[a-z0-9_-]+$/;

export function normalizeNode(raw: Partial<NodeCfg> & { use: string }): NodeCfg {
  return {
    use: raw.use,
    params: { ...(raw.params ?? {}) },
    in: { ...(raw.in ?? {}) },
    after: [...(raw.after ?? [])],
    onError: raw.onError ?? "abort",
    cache: raw.cache ?? true,
    ui: { ...(raw.ui ?? {}) },
  };
}

export function normalizeSpec(raw: { name: string; description?: string; nodes: Record<string, Partial<NodeCfg> & { use: string }> }): Spec {
  return {
    name: raw.name,
    description: raw.description ?? "",
    nodes: Object.fromEntries(Object.entries(raw.nodes).map(([id, n]) => [id, normalizeNode(n)])),
  };
}

const withNodes = (spec: Spec, nodes: Record<string, NodeCfg>): Spec => ({ ...spec, nodes });

/** "node.port" or "node" (single-output shorthand) -> PortRef. */
export function parseRef(ref: string, spec: Spec, catalog: Catalog): PortRef | null {
  const [node, port, ...rest] = ref.split(".");
  if (!node || rest.length) return null;
  const n = spec.nodes[node];
  const outs = n ? Object.keys(catalog.get(n.use)?.outputs ?? {}) : [];
  if (port !== undefined) return outs.includes(port) ? { node, port } : null;
  return outs.length === 1 ? { node, port: outs[0]! } : null;
}

export function edges(spec: Spec, catalog: Catalog): Edge[] {
  const out: Edge[] = [];
  for (const [id, n] of Object.entries(spec.nodes)) {
    const def = catalog.get(n.use);
    for (const [port, ref] of Object.entries(n.in)) {
      const from = parseRef(ref, spec, catalog);
      if (from) out.push({ from, to: { node: id, port }, type: def?.inputs[port]?.type ?? "?" });
    }
  }
  return out;
}

/** Upstream ids of a node (data edges + after). */
function upstream(spec: Spec, id: string): string[] {
  const n = spec.nodes[id];
  return n ? [...Object.values(n.in).map((r) => r.split(".")[0]!), ...n.after] : [];
}

/** True if `ancestor` is reachable going upstream from `id`. */
export function dependsOn(spec: Spec, id: string, ancestor: string): boolean {
  const seen = new Set<string>();
  const stack = [id];
  while (stack.length) {
    const cur = stack.pop()!;
    if (cur === ancestor) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    stack.push(...upstream(spec, cur));
  }
  return false;
}

/** Reason the connection is not allowed, or null. */
export function canConnect(spec: Spec, catalog: Catalog, from: PortRef, to: PortRef): string | null {
  if (from.node === to.node) return "同じノード同士はつなげません";
  const a = spec.nodes[from.node];
  const b = spec.nodes[to.node];
  if (!a || !b) return "ノードがありません";
  const out = catalog.get(a.use)?.outputs[from.port];
  const inp = catalog.get(b.use)?.inputs[to.port];
  if (!out || !inp) return "ポートがありません";
  if (out.type !== inp.type) return `型が違います（${out.type} → ${inp.type}）`;
  if (dependsOn(spec, from.node, to.node)) return "循環します";
  return null;
}

/** Sets (or replaces) the source of an input port. */
export function connect(spec: Spec, from: PortRef, to: PortRef): Spec {
  const n = spec.nodes[to.node]!;
  return withNodes(spec, { ...spec.nodes, [to.node]: { ...n, in: { ...n.in, [to.port]: `${from.node}.${from.port}` } } });
}

export function disconnect(spec: Spec, to: PortRef): Spec {
  const n = spec.nodes[to.node];
  if (!n) return spec;
  const { [to.port]: _gone, ...rest } = n.in;
  return withNodes(spec, { ...spec.nodes, [to.node]: { ...n, in: rest } });
}

/** Removes a node and every reference to it. */
export function removeNode(spec: Spec, id: string): Spec {
  const nodes: Record<string, NodeCfg> = {};
  for (const [k, n] of Object.entries(spec.nodes)) {
    if (k === id) continue;
    nodes[k] = {
      ...n,
      in: Object.fromEntries(Object.entries(n.in).filter(([, r]) => r.split(".")[0] !== id)),
      after: n.after.filter((a) => a !== id),
    };
  }
  return withNodes(spec, nodes);
}

/** Renames a node and rewrites references. Returns an error string if not possible. Keeps key order. */
export function renameNode(spec: Spec, from: string, to: string): Spec | string {
  if (from === to) return spec;
  if (!ID_RE.test(to)) return "英字で始まる英数字と _ のみ";
  if (spec.nodes[to]) return `${to} は既にあります`;
  const fix = (ref: string) => {
    const [n, ...rest] = ref.split(".");
    return n === from ? [to, ...rest].join(".") : ref;
  };
  const nodes: Record<string, NodeCfg> = {};
  for (const [k, n] of Object.entries(spec.nodes)) {
    nodes[k === from ? to : k] = {
      ...n,
      in: Object.fromEntries(Object.entries(n.in).map(([p, r]) => [p, fix(r)])),
      after: n.after.map((a) => (a === from ? to : a)),
    };
  }
  return withNodes(spec, nodes);
}

export function uniqueId(spec: Spec, base: string): string {
  const clean = base.replace(/[^A-Za-z0-9_]/g, "") || "node";
  const b = /^[A-Za-z]/.test(clean) ? clean : `n${clean}`;
  if (!spec.nodes[b]) return b;
  for (let i = 2; ; i++) if (!spec.nodes[`${b}${i}`]) return `${b}${i}`;
}

/** "signal.factors" -> "factors"; "decide.ai" -> "decideAi" when the short name would be vague. */
export function idFor(type: string): string {
  const [ns, short] = type.split(".");
  if (!short) return type;
  return short.length <= 3 ? `${ns}${short[0]!.toUpperCase()}${short.slice(1)}` : short;
}

export function addNode(spec: Spec, type: string, at: { x: number; y: number }): { spec: Spec; id: string } {
  const id = uniqueId(spec, idFor(type));
  return { id, spec: withNodes(spec, { ...spec.nodes, [id]: normalizeNode({ use: type, ui: { x: Math.round(at.x), y: Math.round(at.y) } }) }) };
}

export function patchNode(spec: Spec, id: string, patch: Partial<NodeCfg>): Spec {
  const n = spec.nodes[id];
  return n ? withNodes(spec, { ...spec.nodes, [id]: { ...n, ...patch } }) : spec;
}

export function setParam(spec: Spec, id: string, key: string, value: unknown): Spec {
  const n = spec.nodes[id];
  if (!n) return spec;
  const params = { ...n.params };
  if (value === undefined) delete params[key];
  else params[key] = value;
  return patchNode(spec, id, { params });
}

/** Geometry shared by canvas and layout. */
export const NODE_W = 212;
export const HEADER_H = 28;
export const ROW_H = 20;
/** Vertical centre of the i-th port row, relative to the node's top edge. */
export const portY = (i: number): number => HEADER_H + 4 + i * ROW_H + ROW_H / 2;
export function nodeHeight(def: NodeDescription | undefined): number {
  const rows = Math.max(1, Object.keys(def?.inputs ?? {}).length, Object.keys(def?.outputs ?? {}).length);
  return HEADER_H + rows * ROW_H + 8;
}

/** Layered left-to-right layout (longest path), written into ui.x / ui.y. */
export function autoLayout(spec: Spec, catalog: Catalog): Spec {
  const ids = Object.keys(spec.nodes);
  const memo: Record<string, number> = {};
  const depth = (id: string, seen: Set<string>): number => {
    if (id in memo) return memo[id]!;
    if (seen.has(id)) return 0;
    seen.add(id);
    const ups = upstream(spec, id).filter((u) => u in spec.nodes);
    return (memo[id] = ups.length ? 1 + Math.max(...ups.map((u) => depth(u, seen))) : 0);
  };
  const cols: string[][] = [];
  for (const id of ids) (cols[depth(id, new Set())] ??= []).push(id);
  const nodes: Record<string, NodeCfg> = { ...spec.nodes };
  cols.forEach((col, c) => {
    let y = 0;
    for (const id of col ?? []) {
      nodes[id] = { ...nodes[id]!, ui: { x: c * (NODE_W + 72), y } };
      y += nodeHeight(catalog.get(nodes[id]!.use)) + 28;
    }
  });
  return withNodes(spec, nodes);
}

/** Cheap client-side checks for instant feedback (the server has the final word). */
export function localProblems(spec: Spec, catalog: Catalog): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const add = (id: string, msg: string) => (out[id] ??= []).push(msg);
  for (const [id, n] of Object.entries(spec.nodes)) {
    const def = catalog.get(n.use);
    if (!def) {
      add(id, `未知の種類 ${n.use}`);
      continue;
    }
    for (const [port, d] of Object.entries(def.inputs)) {
      const ref = n.in[port];
      if (!ref) {
        if (!d.optional) add(id, `必須入力 ${port} (${d.type}) が未接続`);
        continue;
      }
      if (!parseRef(ref, spec, catalog)) add(id, `${port} の接続先 ${ref} がありません`);
    }
  }
  return out;
}

export const blankSpec = (name: string): Spec => ({ name, description: "", nodes: {} });
