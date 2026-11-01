import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { GLYPH } from "../format.ts";

export interface DagNode {
  id: string;
  type: string;
  category: string;
  status?: string;
  layer?: number;
  inputs: Array<{ name: string; type: string }>;
  outputs: Array<{ name: string; type: string }>;
}
export interface DagEdge {
  from: { node: string; port: string };
  to: { node: string; port: string };
  type: string;
}

const W = 156;
const H = 46;
/** Gaps: along the flow and across it, per orientation. */
const GAP = { LR: { along: 48, across: 14 }, TB: { along: 30, across: 18 } } as const;
export type Orientation = "LR" | "TB";

export const CATEGORY_HUE: Record<string, string> = {
  source: "var(--pt-Documents)", filter: "var(--pt-Matches)", llm: "var(--pt-Events)", data: "var(--pt-Prices)",
  signal: "var(--pt-Factors)", decision: "var(--pt-Judgments)", risk: "var(--pt-Account)", gate: "var(--wait)",
  execution: "var(--pt-Fills)", eval: "var(--pt-Scorecard)",
};

function computeLayers(nodes: DagNode[], edges: DagEdge[]): Record<string, number> {
  const preds = new Map<string, string[]>(nodes.map((n) => [n.id, []]));
  for (const e of edges) preds.get(e.to.node)?.push(e.from.node);
  const memo: Record<string, number> = {};
  const depth = (id: string, seen: Set<string>): number => {
    if (id in memo) return memo[id]!;
    if (seen.has(id)) return 0;
    seen.add(id);
    const ps = preds.get(id) ?? [];
    return (memo[id] = ps.length ? 1 + Math.max(...ps.map((p) => depth(p, seen))) : 0);
  };
  for (const n of nodes) depth(n.id, new Set());
  return memo;
}

/** Layered layout (one barycentre pass to reduce crossings), each layer centred across the flow. */
function layout(nodes: DagNode[], edges: DagEdge[], o: Orientation) {
  const computed = computeLayers(nodes, edges);
  const layers: DagNode[][] = [];
  for (const n of nodes) (layers[n.layer ?? computed[n.id] ?? 0] ??= []).push(n);
  const slot = new Map<string, number>();
  layers.forEach((l) => l?.forEach((n, i) => slot.set(n.id, i)));
  for (let c = 1; c < layers.length; c++) {
    const l = layers[c] ?? [];
    const bary = (n: DagNode) => {
      const ps = edges.filter((e) => e.to.node === n.id).map((e) => slot.get(e.from.node) ?? 0);
      return ps.length ? ps.reduce((a, b) => a + b, 0) / ps.length : (slot.get(n.id) ?? 0);
    };
    l.sort((a, b) => bary(a) - bary(b));
    l.forEach((n, i) => slot.set(n.id, i));
  }
  const g = GAP[o];
  const alongSize = o === "LR" ? W : H;
  const acrossSize = o === "LR" ? H : W;
  const widest = Math.max(...layers.map((l) => l?.length ?? 0));
  const pos = new Map<string, { x: number; y: number }>();
  layers.forEach((l, c) => {
    const offset = ((widest - (l?.length ?? 0)) * (acrossSize + g.across)) / 2;
    l?.forEach((n, i) => {
      const along = c * (alongSize + g.along);
      const across = offset + i * (acrossSize + g.across);
      pos.set(n.id, o === "LR" ? { x: along, y: across } : { x: across, y: along });
    });
  });
  const alongTotal = layers.length * (alongSize + g.along) - g.along;
  const acrossTotal = widest * (acrossSize + g.across) - g.across;
  return { pos, width: o === "LR" ? alongTotal : acrossTotal, height: o === "LR" ? acrossTotal : alongTotal };
}

/** Width the left-to-right layout needs (to decide the orientation). */
export function lrWidth(nodes: DagNode[], edges: DagEdge[]): number {
  return layout(nodes, edges, "LR").width + 8;
}

export function Dag(props: { nodes: DagNode[]; edges: DagEdge[]; selected?: string | null; onSelect?: (id: string) => void }) {
  const { nodes, edges } = props;
  const box = useRef<HTMLDivElement>(null);
  const [avail, setAvail] = useState(0);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setAvail(el.clientWidth));
    ro.observe(el);
    setAvail(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  const o: Orientation = avail && lrWidth(nodes, edges) > avail ? "TB" : "LR";
  const { pos, width, height } = useMemo(() => layout(nodes, edges, o), [nodes, edges, o]);
  const [hover, setHover] = useState<string | null>(null);
  const focus = hover ?? props.selected ?? null;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  /** Port position relative to the node box. */
  const portAt = (n: DagNode | undefined, port: string, side: "in" | "out") => {
    const list = side === "in" ? n?.inputs ?? [] : n?.outputs ?? [];
    const i = Math.max(0, list.findIndex((p) => p.name === port));
    const frac = (i + 1) / (list.length + 1);
    return o === "LR" ? { x: side === "in" ? 0 : W, y: H * frac } : { x: W * frac, y: side === "in" ? 0 : H };
  };
  const hotEdge = (e: DagEdge) => focus !== null && (e.from.node === focus || e.to.node === focus);
  const neighbours = new Set(focus ? edges.filter(hotEdge).flatMap((e) => [e.from.node, e.to.node]) : []);

  return (
    <div ref={box} className={`dag ${focus ? "dimmed" : ""}`}>
      <div className="dag-canvas" style={{ width: width + 8, height: height + 8, margin: o === "TB" ? "0 auto" : undefined }}>
        <svg width={width + 8} height={height + 8}>
          {edges.map((e, k) => {
            const a = pos.get(e.from.node);
            const b = pos.get(e.to.node);
            if (!a || !b) return null;
            const pa = portAt(byId.get(e.from.node), e.from.port, "out");
            const pb = portAt(byId.get(e.to.node), e.to.port, "in");
            const x1 = a.x + pa.x + 4, y1 = a.y + pa.y + 4, x2 = b.x + pb.x + 4, y2 = b.y + pb.y + 4;
            const d = o === "LR"
              ? (() => { const dx = Math.max(24, (x2 - x1) / 2); return `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`; })()
              : (() => { const dy = Math.max(16, (y2 - y1) / 2); return `M${x1},${y1} C${x1},${y1 + dy} ${x2},${y2 - dy} ${x2},${y2}`; })();
            return <path key={k} className={`edge ${hotEdge(e) ? "hot" : ""}`} stroke={`var(--pt-${e.type}, var(--dim))`} d={d} />;
          })}
        </svg>
        {nodes.map((n) => {
          const p = pos.get(n.id)!;
          const st = n.status ?? "pending";
          const dot = (port: { name: string; type: string }, side: "in" | "out") => {
            const at = portAt(n, port.name, side);
            return (
              <span
                key={side + port.name}
                className="port"
                title={`${port.name}: ${port.type}`}
                style={{ left: at.x - 3, top: at.y - 3, marginTop: 0, background: `var(--pt-${port.type}, var(--dim))` }}
              />
            );
          };
          return (
            <div
              key={n.id}
              className={`dag-node s-${st} ${neighbours.has(n.id) ? "hot" : ""}`}
              aria-selected={props.selected === n.id}
              style={{ left: p.x + 4, top: p.y + 4, width: W, height: H }}
              onMouseEnter={() => setHover(n.id)}
              onMouseLeave={() => setHover(null)}
              onClick={() => props.onSelect?.(n.id)}
              title={`${n.id} — ${n.type}`}
            >
              <span className="cat" style={{ background: CATEGORY_HUE[n.category] ?? "var(--line-2)" }} />
              {n.inputs.map((port) => dot(port, "in"))}
              {n.outputs.map((port) => dot(port, "out"))}
              <span className="n-id">
                {n.status && <span className={`st-${st}`}>{GLYPH[st] ?? "·"} </span>}
                {n.id}
              </span>
              <span className="n-type">{n.type}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
