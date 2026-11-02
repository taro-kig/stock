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

/** Options for free-text params whose valid values are known (e.g. prompt versions). */
export type Choices = Record<string, {
  options: string[];
  defaultLabel: string;
  /** Option value → label (e.g. "none" → "使わない"). */
  labels?: Record<string, string>;
  /** An ordered list of options (e.g. voting models). */
  multi?: boolean;
  /** Fewest items that make sense (multi). */
  min?: number;
  unknownLabel?: string;
}>;

function Field({ k, p, value, required, onSet, choice }: { k: string; p: Prop; value: unknown; required: boolean; onSet: (v: unknown) => void; choice?: Choices[string] | undefined }) {
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

  if (choice?.multi) {
    const list = Array.isArray(value) ? value.map(String) : [];
    const rest = choice.options.filter((o) => !list.includes(o));
    const commitList = (l: string[]) => onSet(l.length ? l : undefined);
    return (
      <div className="ed-field">
        {label}
        {list.length === 0 && <span className="faint">{choice.defaultLabel}</span>}
        {list.map((o, i) => (
          <div key={o} className="btn-row" style={{ gap: "0.5ch", flexWrap: "nowrap" }}>
            <span className="ellipsis" style={{ flex: 1 }}>{i + 1}. {choice.labels?.[o] ?? o}{choice.options.includes(o) ? "" : `（${choice.unknownLabel ?? "不明"}）`}</span>
            <button className="btn icon" type="button" disabled={i === 0} aria-label="上へ" onClick={() => { const c = [...list]; [c[i - 1], c[i]] = [c[i]!, c[i - 1]!]; commitList(c); }}>↑</button>
            <button className="btn icon" type="button" aria-label="外す" onClick={() => commitList(list.filter((x) => x !== o))}>✕</button>
          </div>
        ))}
        {list.length > 0 && choice.min !== undefined && list.length < choice.min && <span className="warn">{choice.min} つ以上必要（quorum）</span>}
        {rest.length > 0 && (
          <select className="input" value="" onChange={(e) => e.target.value && commitList([...list, e.target.value])}>
            <option value="">＋ 追加</option>
            {rest.map((o) => <option key={o} value={o}>{choice.labels?.[o] ?? o}</option>)}
          </select>
        )}
      </div>
    );
  }

  if (choice) {
    return (
      <label className="ed-field">
        {label}
        <select className="input" value={typeof value === "string" ? value : ""} onChange={(e) => onSet(e.target.value === "" ? undefined : e.target.value)}>
          <option value="">{choice.defaultLabel}</option>
          {typeof value === "string" && !choice.options.includes(value) && <option value={value}>{value}（{choice.unknownLabel ?? "不明な版"}）</option>}
          {choice.options.map((o) => <option key={o} value={o}>{choice.labels?.[o] ?? o}</option>)}
        </select>
      </label>
    );
  }

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
export function ParamsForm({ schema, values, onSet, choices }: { schema: unknown; values: Record<string, unknown>; onSet: (key: string, v: unknown) => void; choices?: Choices }) {
  const s = (schema ?? {}) as Schema;
  const props = Object.entries(s.properties ?? {});
  if (!props.length) return <div className="faint">パラメータなし</div>;
  return (
    <div className="ed-form">
      {props.map(([k, p]) => (
        <Field key={k} k={k} p={p} value={values[k]} required={s.required?.includes(k) ?? false} onSet={(v) => onSet(k, v)} choice={choices?.[k]} />
      ))}
    </div>
  );
}
