import type { ReactNode } from "react";
import { GLYPH, STANCE_JA, STATUS_JA } from "../format.ts";

export function Status({ s, label = true }: { s: string; label?: boolean }) {
  return (
    <span className={`st st-${s}`} title={s}>
      <span className="st-g" aria-hidden>
        {GLYPH[s] ?? "·"}
      </span>
      {label && (STATUS_JA[s] ?? s)}
    </span>
  );
}

export function Stance({ s }: { s: string }) {
  const arrow = s === "bullish" ? "▲" : s === "bearish" ? "▼" : s === "neutral" ? "–" : "·";
  return (
    <span className={`stance stance-${s}`}>
      {arrow} {STANCE_JA[s] ?? s}
    </span>
  );
}

export function Pane(props: { title: ReactNode; aux?: ReactNode; actions?: ReactNode; className?: string; children: ReactNode }) {
  return (
    <section className={`pane ${props.className ?? ""}`}>
      <header className="pane-title">
        <b>{props.title}</b>
        {props.aux !== undefined && <span className="aux">{props.aux}</span>}
      </header>
      {props.actions && <div className="pane-actions">{props.actions}</div>}
      {props.children}
    </section>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="cap">{children}</kbd>;
}

/** Horizontal meter. `value` in [0,1]; optional reference mark (e.g. 50%) and confidence band. */
export function Meter(props: { value: number | null | undefined; width?: number; tone?: string; mark?: number; band?: [number, number]; point?: number }) {
  const w = props.width ?? 16;
  const clamp = (x: number) => Math.max(0, Math.min(1, x));
  return (
    <span className="meter" style={{ width: `${w}ch` }} aria-hidden>
      {props.band && <span className="band" style={{ left: `${clamp(props.band[0]) * 100}%`, width: `${(clamp(props.band[1]) - clamp(props.band[0])) * 100}%` }} />}
      {props.value !== null && props.value !== undefined && props.point === undefined && <i className={props.tone ?? ""} style={{ width: `${clamp(props.value) * 100}%` }} />}
      {props.point !== undefined && <span className="pt" style={{ left: `${clamp(props.point) * 100}%` }} />}
      {props.mark !== undefined && <span className="mark" style={{ left: `${clamp(props.mark) * 100}%` }} />}
    </span>
  );
}

/** Minimal line+area sparkline. Coloured by direction from first to last point. */
export function Spark({ values, width = 220, height = 44 }: { values: number[]; width?: number; height?: number }) {
  if (values.length < 2) return <svg className="spark" width={width} height={height} />;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const x = (i: number) => (i / (values.length - 1)) * width;
  const y = (v: number) => height - 2 - ((v - min) / span) * (height - 4);
  const line = values.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join("");
  const dir = values.at(-1)! > values[0]! ? "up" : values.at(-1)! < values[0]! ? "down" : "";
  return (
    <svg className={`spark ${dir}`} width={width} height={height} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none">
      <line className="base" x1={0} x2={width} y1={y(values[0]!)} y2={y(values[0]!)} />
      <path className="area" d={`${line}L${width},${height}L0,${height}Z`} />
      <path className="line" d={line} />
    </svg>
  );
}

export function PortType({ t }: { t: string }) {
  return (
    <span className="ptype" style={{ ["--c" as string]: `var(--pt-${t}, var(--dim))` }}>
      {t}
    </span>
  );
}

export function ErrorLine({ error }: { error: string | undefined }) {
  if (!error) return null;
  return <div className="callout fail">✕ {error}</div>;
}

/** Small switch between sibling screens (e.g. ワークフロー | ノード under the フロー tab). */
export function SubTabs({ items, current }: { items: Array<{ href: string; label: string; id: string }>; current: string }) {
  return (
    <div className="subtabs" role="tablist">
      {items.map((i) => (
        <a key={i.id} href={i.href} role="tab" aria-selected={i.id === current} className="subtab">{i.label}</a>
      ))}
    </div>
  );
}

export const FLOW_TABS = [
  { id: "workflows", href: "#/workflows", label: "ワークフロー" },
  { id: "nodes", href: "#/nodes", label: "ノード" },
];
