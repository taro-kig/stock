import { useState } from "react";

interface Prop {
  type?: string | string[];
  enum?: unknown[];
  default?: unknown;
  description?: string;
  minimum?: number;
  maximum?: number;
}
interface Schema {
  properties?: Record<string, Prop>;
  required?: string[];
}

function Field({ k, p, value, required, onSet }: { k: string; p: Prop; value: unknown; required: boolean; onSet: (v: unknown) => void }) {
  const type = Array.isArray(p.type) ? p.type[0] : p.type;
  const [text, setText] = useState(() => (value === undefined ? "" : typeof value === "string" || typeof value === "number" ? String(value) : JSON.stringify(value)));
  const [err, setErr] = useState<string | null>(null);
  const placeholder = p.default === undefined ? (required ? "必須" : "未設定") : `既定: ${JSON.stringify(p.default)}`;
  const label = (
    <div className="ed-plabel-row">
      <span>{k}{required && <span className="accent">*</span>}</span>
      {p.description && <span className="faint ellipsis" title={p.description}>{p.description}</span>}
    </div>
  );

  if (p.enum || type === "boolean") {
    const options = p.enum ?? [true, false];
    return (
      <label className="ed-field">
        {label}
        <select className="input" value={value === undefined ? "" : JSON.stringify(value)} onChange={(e) => onSet(e.target.value === "" ? undefined : JSON.parse(e.target.value))}>
          <option value="">{p.default === undefined ? "—" : `既定 (${JSON.stringify(p.default)})`}</option>
          {options.map((o) => <option key={JSON.stringify(o)} value={JSON.stringify(o)}>{String(o)}</option>)}
        </select>
      </label>
    );
  }

  const commit = () => {
    const t = text.trim();
    if (t === "") return (setErr(null), onSet(undefined));
    if (type === "number" || type === "integer") {
      const n = Number(t);
      if (!Number.isFinite(n) || (type === "integer" && !Number.isInteger(n))) return setErr(type === "integer" ? "整数" : "数値");
      if (p.minimum !== undefined && n < p.minimum) return setErr(`≥ ${p.minimum}`);
      if (p.maximum !== undefined && n > p.maximum) return setErr(`≤ ${p.maximum}`);
      return (setErr(null), onSet(n));
    }
    if (type === "string") return (setErr(null), onSet(t));
    try {
      setErr(null);
      onSet(JSON.parse(t));
    } catch {
      setErr("JSON");
    }
  };
  const multiline = type !== "string" && type !== "number" && type !== "integer";
  return (
    <label className="ed-field">
      {label}
      {multiline ? (
        <textarea className={`input ed-json ${err ? "bad" : ""}`} rows={3} value={text} placeholder={placeholder} onChange={(e) => setText(e.target.value)} onBlur={commit} spellCheck={false} />
      ) : (
        <input
          className={`input ${err ? "bad" : ""}`}
          value={text}
          placeholder={placeholder}
          inputMode={type === "string" ? "text" : "decimal"}
          onChange={(e) => setText(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => e.key === "Enter" && (e.currentTarget as HTMLInputElement).blur()}
        />
      )}
      {err && <span className="fail">✕ {err}</span>}
    </label>
  );
}

/** Form generated from a node's params JSON Schema. Commits on blur/Enter (one undo step per edit). */
export function ParamsForm({ schema, values, onSet }: { schema: unknown; values: Record<string, unknown>; onSet: (key: string, v: unknown) => void }) {
  const s = (schema ?? {}) as Schema;
  const props = Object.entries(s.properties ?? {});
  if (!props.length) return <div className="faint">パラメータなし</div>;
  return (
    <div className="ed-form">
      {props.map(([k, p]) => (
        <Field key={k} k={k} p={p} value={values[k]} required={s.required?.includes(k) ?? false} onSet={(v) => onSet(k, v)} />
      ))}
    </div>
  );
}
