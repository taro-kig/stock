import { useEffect, useMemo, useState } from "react";
import type { EvalJob, EvalReport } from "@stockai/core";
import type { PromptFamilyView, PromptsView, PromptVersionView } from "../../shared/types.ts";
import { get, post, put, useApi } from "../api.ts";
import { Empty, ErrorLine, Kbd, Pane } from "../components/ui.tsx";
import { ago, pct, time, usd } from "../format.ts";
import { step, useKeys } from "../keys.ts";
import { navigate } from "../router.ts";

type Toast = (m: string, err?: boolean) => void;

/** Line diff (LCS) between two prompt texts: [kind, line] with kind " ", "+" or "-". */
export function lineDiff(a: string, b: string): Array<[" " | "+" | "-", string]> {
  const x = a.split("\n");
  const y = b.split("\n");
  const n = x.length;
  const m = y.length;
  const L = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i]![j] = x[i] === y[j] ? L[i + 1]![j + 1]! + 1 : Math.max(L[i + 1]![j]!, L[i]![j + 1]!);
  const out: Array<[" " | "+" | "-", string]> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) {
      out.push([" ", x[i]!]);
      i++;
      j++;
    } else if (L[i + 1]![j]! >= L[i]![j + 1]!) out.push(["-", x[i++]!]);
    else out.push(["+", y[j++]!]);
  }
  while (i < n) out.push(["-", x[i++]!]);
  while (j < m) out.push(["+", y[j++]!]);
  return out;
}

function Diff({ from, to }: { from: string; to: string }) {
  const d = lineDiff(from, to);
  const changed = d.filter(([k]) => k !== " ").length;
  if (!changed) return <Empty>違いはありません</Empty>;
  // show changes with 3 lines of context; collapse the rest
  const near = new Set<number>();
  d.forEach(([k], i) => {
    if (k !== " ") for (let j = i - 3; j <= i + 3; j++) near.add(j);
  });
  const out: Array<{ kind: "line"; i: number } | { kind: "gap"; n: number; i: number }> = [];
  for (let i = 0; i < d.length; i++) {
    if (near.has(i)) out.push({ kind: "line", i });
    else {
      const last = out.at(-1);
      if (last?.kind === "gap") last.n++;
      else out.push({ kind: "gap", n: 1, i });
    }
  }
  return (
    <pre className="prompt-text diff">
      <div className="faint">+{d.filter(([k]) => k === "+").length} 行 / −{d.filter(([k]) => k === "-").length} 行</div>
      {out.map((o) =>
        o.kind === "gap" ? (
          <div key={`g${o.i}`} className="gap">┄ 変更なし {o.n} 行 ┄</div>
        ) : (
          <div key={o.i} className={d[o.i]![0] === "+" ? "add" : d[o.i]![0] === "-" ? "del" : "same"}>{d[o.i]![0]} {d[o.i]![1] || " "}</div>
        ),
      )}
    </pre>
  );
}

const key = (f: string, v: string) => `${f}/${v}`;

export function Prompts({ param, toast }: { param: string | null; toast: Toast }) {
  const { data, error, reload } = useApi<PromptsView>("/api/prompts");
  const all = useMemo(() => (data?.families ?? []).flatMap((f) => f.versions.map((v) => ({ f, v }))), [data]);
  const sel = all.find((x) => key(x.f.family, x.v.version) === param) ?? all.find((x) => x.v.usedBy.includes("config")) ?? all[0];
  const idx = sel ? all.indexOf(sel) : -1;
  const [mode, setMode] = useState<"view" | "diff" | "edit">("view");
  useEffect(() => setMode("view"), [param]);
  useKeys({
    j: () => all[step(idx, all.length, 1)] && navigate("prompts", key(all[step(idx, all.length, 1)]!.f.family, all[step(idx, all.length, 1)]!.v.version)),
    k: () => all[step(idx, all.length, -1)] && navigate("prompts", key(all[step(idx, all.length, -1)]!.f.family, all[step(idx, all.length, -1)]!.v.version)),
  }, mode !== "edit");

  if (error) return <ErrorLine error={error} />;
  if (!data || !sel) return <Empty>読み込み中</Empty>;
  return (
    <div className="split-view">
      <nav className="split-list">
        <div className="list-head"><span>プロンプト</span><span>j/k</span></div>
        {data.families.map((f) => (
          <div key={f.family}>
            <div className="list-group">{f.label} <span className="faint">· 使用中 {f.active}</span></div>
            {f.versions.map((v) => (
              <div key={v.version} className="list-item" aria-selected={sel.v === v} onClick={() => navigate("prompts", key(f.family, v.version))}>
                {v.usedBy.includes("config") ? <span className="ok" title="既定で使用中">●</span> : v.usedBy.length ? <span className="cache" title="ワークフローで指定">◆</span> : <span className="faint">·</span>}
                <span className="ellipsis">{v.version}</span>
                <span className="dim">{v.builtin ? "組込" : "自作"}</span>
                <span className="sub ellipsis">{v.description || (v.parent ? `${v.parent} から` : "")}</span>
              </div>
            ))}
          </div>
        ))}
      </nav>
      <section className="split-detail">
        <div className="stack">
          <VersionPane f={sel.f} v={sel.v} view={data} mode={mode} setMode={setMode} toast={toast} reload={reload} />
          <EvalPane f={sel.f} selected={sel.v} view={data} toast={toast} />
          <HistoryPane view={data} family={sel.f.family} />
        </div>
      </section>
    </div>
  );
}

function VersionPane(props: {
  f: PromptFamilyView; v: PromptVersionView; view: PromptsView; mode: "view" | "diff" | "edit";
  setMode: (m: "view" | "diff" | "edit") => void; toast: Toast; reload: () => void;
}) {
  const { f, v, view, mode, setMode, toast, reload } = props;
  const parent = v.parent ? f.versions.find((x) => x.version === v.parent) : undefined;
  const active = v.usedBy.includes("config");
  const pinned = v.usedBy.filter((u) => u !== "config");
  const [armed, setArmed] = useState(false);
  useEffect(() => setArmed(false), [v.version]);

  async function use() {
    if (!armed) return setArmed(true);
    try {
      await put(`/api/prompts/${f.family}/active`, { version: v.version });
      toast(`${f.label}を ${v.version} に切り替えました（次の実行から。確度は版ごとに分けて集計されます）`);
      reload();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), true);
    } finally {
      setArmed(false);
    }
  }

  return (
    <Pane title={`${f.label} · ${v.version}`} aux={v.builtin ? "組み込み（読み取り専用）" : `自作 · ${time(v.createdAt)}`} className={active ? "focus" : ""}>
      <dl className="kv">
        <dt>説明</dt><dd>{v.description || <span className="faint">—</span>}</dd>
        {v.parent && <><dt>元の版</dt><dd><a className="accent" href={`#/prompts/${f.family}/${v.parent}`}>{v.parent}</a> <span className="faint">（入力の形式は {v.base} と同じ）</span></dd></>}
        <dt>使用</dt>
        <dd>
          {active ? <span className="ok">● 既定（config.yaml の prompts.{f.configKey}）</span> : <span className="faint">既定ではない</span>}
          {pinned.length > 0 && <span className="cache"> · ◆ ワークフローで指定: {pinned.join(", ")}</span>}
        </dd>
        {v.file && <><dt>ファイル</dt><dd><code>{v.file}</code></dd></>}
      </dl>
      <div className="btn-row" style={{ margin: "calc(var(--lh) * 0.5) 0" }}>
        <button className={`btn ${mode === "view" ? "primary" : ""}`} onClick={() => setMode("view")}>本文</button>
        {parent && <button className={`btn ${mode === "diff" ? "primary" : ""}`} onClick={() => setMode("diff")}>{v.parent} との差分</button>}
        <button className={`btn ${mode === "edit" ? "primary" : ""}`} onClick={() => setMode("edit")}>この版から新しい版を作る</button>
        <span className="spacer" style={{ flex: 1 }} />
        {!active && view.editable && (
          <button className={`btn ${armed ? "danger" : ""}`} onClick={() => void use()} onBlur={() => setArmed(false)}>{armed ? "もう一度押して切り替え" : "この版を使う"}</button>
        )}
      </div>
      {mode === "view" && <pre className="prompt-text">{v.system}</pre>}
      {mode === "diff" && parent && <Diff from={parent.system} to={v.system} />}
      {mode === "edit" && <Editor f={f} parent={v} toast={toast} onCreated={(name) => { reload(); navigate("prompts", `${f.family}/${name}`); }} />}
    </Pane>
  );
}

function Editor({ f, parent, toast, onCreated }: { f: PromptFamilyView; parent: PromptVersionView; toast: Toast; onCreated: (v: string) => void }) {
  const suggest = () => {
    const stem = parent.version.replace(/-my\d+$/, "");
    for (let i = 1; ; i++) if (!f.versions.some((x) => x.version === `${stem}-my${i}`)) return `${stem}-my${i}`;
  };
  const [name, setName] = useState(suggest);
  const [desc, setDesc] = useState("");
  const [text, setText] = useState(parent.system);
  const [showDiff, setShowDiff] = useState(false);
  const [busy, setBusy] = useState(false);
  const changed = lineDiff(parent.system, text).filter(([k]) => k !== " ").length;
  const nameOk = new RegExp(`^${f.family}-[a-z0-9][a-z0-9.-]{0,47}$`).test(name) && !f.versions.some((x) => x.version === name);

  async function save() {
    setBusy(true);
    try {
      await post(`/api/prompts/${f.family}`, { version: name, parent: parent.version, system: text, description: desc });
      toast(`${name} を作りました。評価してから「この版を使う」で切り替えられます`);
      onCreated(name);
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="stack" style={{ gap: 6 }}>
      <div className="btn-row">
        <label className="dim">名前 <input className={`input ${nameOk ? "" : "bad"}`} style={{ width: "28ch" }} value={name} onChange={(e) => setName(e.target.value.toLowerCase())} /></label>
        <label className="dim" style={{ flex: 1 }}>説明 <input className="input" style={{ width: "calc(100% - 4ch)" }} value={desc} maxLength={300} onChange={(e) => setDesc(e.target.value)} placeholder="何を変えたか（例: 観測報道の確信度を下げる）" /></label>
      </div>
      <textarea className="input prompt-edit" value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} />
      <div className="btn-row">
        <button className="btn primary" disabled={!nameOk || changed === 0 || busy} onClick={() => void save()}>新しい版として保存</button>
        <button className="btn" onClick={() => setShowDiff((x) => !x)}>{showDiff ? "差分を隠す" : `差分を見る（${changed} 行）`}</button>
        <span className="faint">
          保存先 prompts/{f.family}/{name}.md。保存した版は書き換えられません（結果やキャッシュが版の名前で記録されるため）。
          編集できるのは指示文だけで、入力の形式と出力の項目は {parent.base} と同じです。
        </span>
      </div>
      {!nameOk && <p className="warn">名前は「{f.family}-」で始まる英小文字・数字・. - で、既存の版と重ならないこと</p>}
      {showDiff && <Diff from={parent.system} to={text} />}
    </div>
  );
}

function EvalPane({ f, selected, view, toast }: { f: PromptFamilyView; selected: PromptVersionView; view: PromptsView; toast: Toast }) {
  const [versions, setVersions] = useState<Set<string>>(new Set());
  const [models, setModels] = useState<Set<string>>(new Set());
  const [ensemble, setEnsemble] = useState(false);
  const [budget, setBudget] = useState(0.3);
  const [open, setOpen] = useState<number | null>(null);
  const [detail, setDetail] = useState<EvalReport | null>(null);
  useEffect(() => {
    setVersions(new Set([f.active, selected.version]));
    setModels(new Set(view.models.slice(0, 1)));
  }, [f.family, f.active, selected.version, view.models]);
  useEffect(() => {
    setDetail(null);
    if (open !== null) void get<{ report: EvalReport | null }>(`/api/prompts/evals/${open}`).then((r) => setDetail(r.report)).catch(() => undefined);
  }, [open]);

  if (!f.evaluable) {
    return (
      <Pane title="評価" aux="正解データなし">
        <p className="dim">{f.label}には正解データ（ゴールデンセット）が無いため、ここでは評価できません。版を切り替えたあとの実際の結果で比べてください。</p>
      </Pane>
    );
  }
  const toggle = (set: Set<string>, setter: (s: Set<string>) => void, v: string) => {
    const n = new Set(set);
    if (n.has(v)) n.delete(v);
    else n.add(v);
    setter(n);
  };
  async function run() {
    try {
      await post(`/api/prompts/${f.family}/eval`, { versions: [...versions], models: [...models], ensemble, budgetUsd: budget });
      toast("評価をキューに入れました（ワークフローの実行と同じキューで順番に動きます）");
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), true);
    }
  }

  return (
    <Pane title="評価（正解データ）" aux={f.goldenSet ?? ""}>
      <div className="eval-form">
        <div><span className="label">版</span>{f.versions.map((v) => (
          <label key={v.version} className="check"><input type="checkbox" checked={versions.has(v.version)} onChange={() => toggle(versions, setVersions, v.version)} />{v.version}</label>
        ))}</div>
        <div><span className="label">モデル</span>{view.models.map((m) => (
          <label key={m} className="check"><input type="checkbox" checked={models.has(m)} onChange={() => toggle(models, setModels, m)} />{m}</label>
        ))}
          {f.family === "event" && <label className="check"><input type="checkbox" checked={ensemble} onChange={(e) => setEnsemble(e.target.checked)} />本番と同じ合議も</label>}
        </div>
        <div className="btn-row">
          <label className="dim">上限 <input className="input" type="number" min={0.01} max={5} step={0.05} style={{ width: "9ch" }} value={budget} onChange={(e) => setBudget(Number(e.target.value))} /> USD</label>
          <button className="btn primary" disabled={!versions.size || (!models.size && !ensemble)} onClick={() => void run()}>評価する</button>
          <span className="faint">{view.fake ? "疑似モデル（費用なし・結果に意味はない）" : "LLM を実際に呼びます（上限で打ち切り）"}</span>
        </div>
      </div>
      {f.evals.length === 0 ? <Empty>まだ評価していません</Empty> : (
        <table className="t">
          <thead><tr><th>#</th><th>状態</th><th>版 × モデル</th><th className="num">正解率</th><th className="num">採用</th><th className="num">費用</th><th>実行</th></tr></thead>
          <tbody>
            {f.evals.map((j) => <EvalRows key={j.id} j={j} open={open === j.id} onOpen={() => setOpen(open === j.id ? null : j.id)} detail={open === j.id ? detail : null} />)}
          </tbody>
        </table>
      )}
      <p className="faint">正解率 = 期待ラベルと一致した割合（取り違えは不正解）。採用 = ハーネスの検証を通った割合。正解データはまだ人がレビューしていない下書きなので、差が小さいときは結論を出さないこと。</p>
    </Pane>
  );
}

function EvalRows({ j, open, onOpen, detail }: { j: EvalJob; open: boolean; onOpen: () => void; detail: EvalReport | null }) {
  const status = { queued: <span className="faint">待機</span>, running: <span className="wait">実行中</span>, done: <span className="ok">完了</span>, failed: <span className="fail">失敗</span> }[j.status];
  const best = Math.max(...j.summary.map((r) => r.accuracy ?? -1));
  if (!j.summary.length) {
    return (
      <tr>
        <td className="dim">{j.id}</td><td>{status}</td>
        <td colSpan={4} className={j.error ? "fail" : "dim"}>{j.error ?? `${j.versions.join(", ")} × ${j.models.join(", ") || "既定"}`}</td>
        <td className="dim">{ago(j.createdAt)}</td>
      </tr>
    );
  }
  return (
    <>
      {j.summary.map((r, i) => (
        <tr key={i} className="clickable" onClick={onOpen}>
          <td className="dim">{i === 0 ? j.id : ""}</td>
          <td>{i === 0 ? status : ""}</td>
          <td><b>{r.version}</b> <span className="dim">× {r.model}</span></td>
          <td className={`num ${r.accuracy === best ? "ok" : ""}`}>{pct(r.accuracy)}</td>
          <td className="num dim">{pct(r.accepted)}</td>
          <td className="num dim">{usd(r.costUsd)}</td>
          <td className="dim">{i === 0 ? <>{ago(j.createdAt)}{j.stoppedByBudget && <span className="warn"> 上限で打ち切り</span>}</> : ""}</td>
        </tr>
      ))}
      {open && (
        <tr>
          <td colSpan={7}>
            {!detail ? <span className="faint">読み込み中…</span> : detail.rows.map((r) => (
              <details key={`${r.version}-${r.model}`} className="eval-fail">
                <summary>{r.version} × {r.model}: 不正解・不採用 {r.failures.length} 件</summary>
                {r.failures.map((x) => <div key={x.id} className="dim"><b>{x.id}</b> {x.reason}</div>)}
              </details>
            ))}
          </td>
        </tr>
      )}
    </>
  );
}

function HistoryPane({ view, family }: { view: PromptsView; family: string }) {
  const rows = view.switches.filter((s) => s.family === family);
  return (
    <Pane title="切り替えの履歴" aux={`${rows.length}`}>
      {rows.length === 0 ? <Empty>切り替えはまだありません</Empty> : (
        <table className="t">
          <tbody>{rows.map((s, i) => <tr key={i}><td className="dim nowrap">{time(s.at)}</td><td>{s.from} → <b>{s.to}</b></td><td className="faint">{s.source}</td></tr>)}</tbody>
        </table>
      )}
      <p className="faint">確度（4 確度）は判断に使った版ごとにも分けて表示されます。途中で切り替えても前後の成績は混ざりません。<Kbd>j</Kbd>/<Kbd>k</Kbd> で版を移動。</p>
    </Pane>
  );
}
