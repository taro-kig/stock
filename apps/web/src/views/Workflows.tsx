import { useRef, useState } from "react";
import type { WorkflowGraph } from "@stockai/core";
import type { ImportResult, WorkflowInfo } from "../../shared/types.ts";
import { ApiError, post, useApi } from "../api.ts";
import { Dag } from "../components/Dag.tsx";
import { FLOW_TABS, SubTabs, Empty, ErrorLine, Kbd, Pane, Status } from "../components/ui.tsx";
import { ago, time } from "../format.ts";
import { step, useKeys } from "../keys.ts";
import { navigate } from "../router.ts";

export function Workflows({ param, toast }: { param: string | null; toast: (m: string, err?: boolean) => void }) {
  const list = useApi<WorkflowInfo[]>("/api/workflows");
  const wfs = list.data ?? [];
  const sel = wfs.find((w) => w.name === param) ?? wfs[0];
  const idx = sel ? wfs.indexOf(sel) : -1;
  const detail = useApi<{ info: WorkflowInfo; graph: WorkflowGraph | null }>(sel ? `/api/workflows/${sel.name}` : null);
  const [asOf, setAsOf] = useState("");
  const [node, setNode] = useState<string | null>(null);
  const [conflict, setConflict] = useState<{ yaml: string; file: string; message: string } | null>(null);
  const [dropping, setDropping] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  async function upload(yaml: string, file: string, overwrite = false) {
    try {
      const r = await post<ImportResult>("/api/workflows/import", { yaml, overwrite });
      setConflict(null);
      toast(`${file} を ${r.name} として${r.created ? "追加" : "上書き"}しました${r.problems.length ? `（要修正 ${r.problems.length} 件: 直すまで実行できません）` : ""}`, r.problems.length > 0);
      list.reload();
      navigate("workflows", r.name);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409 && !overwrite) setConflict({ yaml, file, message: e.message });
      else toast(e instanceof Error ? e.message : String(e), true);
    }
  }

  async function pickFile(f: File | undefined) {
    if (!f) return;
    if (!/\.ya?ml$/i.test(f.name)) return toast(`${f.name}: .yaml / .yml のファイルを選んでください`, true);
    if (f.size > 60_000) return toast(`${f.name}: 大きすぎます（60KB まで）`, true);
    await upload(await f.text(), f.name);
  }

  async function toggle() {
    if (!sel) return;
    const off = !sel.disabled;
    try {
      await post(`/api/workflows/${sel.name}/${off ? "disable" : "enable"}`, {});
      toast(off ? `${sel.name} を無効にしました（自動実行・手動実行とも止まります）` : `${sel.name} を有効にしました`);
      list.reload();
      detail.reload();
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), true);
    }
  }

  async function run() {
    if (!sel || sel.disabled) return;
    try {
      const { runId } = await post<{ runId: string }>(`/api/workflows/${sel.name}/run`, asOf ? { asOf } : {});
      toast(`${sel.name} をキューに追加しました${asOf ? `（基準日 ${asOf}）` : ""}`);
      navigate("runs", runId);
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), true);
    }
  }

  useKeys({
    r: () => void run(),
    e: () => sel && navigate("editor", sel.name),
    n: () => navigate("editor", null),
    u: () => fileInput.current?.click(),
    d: () => void toggle(),
    j: () => wfs[step(idx, wfs.length, 1)] && navigate("workflows", wfs[step(idx, wfs.length, 1)]!.name),
    k: () => wfs[step(idx, wfs.length, -1)] && navigate("workflows", wfs[step(idx, wfs.length, -1)]!.name),
  });

  const g = detail.data?.graph;
  const cfg = g?.nodes.find((n) => n.id === node);
  return (
    <div className="split-view">
      <nav
        className={`split-list ${dropping ? "dropping" : ""}`}
        onDragOver={(e) => {
          if (![...e.dataTransfer.types].includes("Files")) return;
          e.preventDefault();
          setDropping(true);
        }}
        onDragLeave={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropping(false);
        }}
        onDrop={(e) => {
          e.preventDefault();
          setDropping(false);
          void pickFile(e.dataTransfer.files[0]);
        }}
      >
        <SubTabs items={FLOW_TABS} current="workflows" />
        <div className="list-head"><span>ワークフロー {wfs.length}</span><span>j/k</span></div>
        <div className="btn-row" style={{ padding: "0 2ch calc(var(--lh) * 0.5)" }}>
          <button className="btn" onClick={() => navigate("editor", null)}>＋ 新規 <kbd>n</kbd></button>
          <button className="btn" onClick={() => fileInput.current?.click()} title="YAML ファイルを選ぶか、この一覧にドラッグ＆ドロップ">↑ YAML <kbd>u</kbd></button>
          <input
            ref={fileInput}
            type="file"
            accept=".yaml,.yml,application/yaml,text/yaml"
            hidden
            onChange={(e) => {
              void pickFile(e.target.files?.[0]);
              e.target.value = "";
            }}
          />
        </div>
        {conflict && (
          <div className="callout warn" style={{ margin: "0 2ch calc(var(--lh) * 0.5)" }}>
            <div>{conflict.message.replace(/（上書きするには.*）/, "")}</div>
            <div className="btn-row" style={{ marginTop: 4 }}>
              <button className="btn danger" onClick={() => void upload(conflict.yaml, conflict.file, true)}>上書きする</button>
              <button className="btn" onClick={() => setConflict(null)}>やめる</button>
              <span className="faint">直前の版は .bak に残ります</span>
            </div>
          </div>
        )}
        {dropping && <div className="drop-hint">ここに YAML をドロップ</div>}
        {wfs.map((w) => (
          <div key={w.name} className={`list-item ${w.disabled ? "disabled-row" : ""}`} aria-selected={w === sel} onClick={() => navigate("workflows", w.name)}>
            {w.problems.length ? <span className="fail">✕</span> : w.disabled ? <span className="faint">⏸</span> : w.lastRun ? <Status s={w.lastRun.status} label={false} /> : <span className="faint">·</span>}
            <span className="ellipsis">{w.name}{w.disabled && <span className="badge off">無効</span>}</span>
            <span className="dim">{w.nodeCount}</span>
            <span className="sub ellipsis">{w.lastRun ? `${ago(w.lastRun.createdAt)} · ${w.lastRun.asOf}` : "未実行"}</span>
          </div>
        ))}
      </nav>
      <section className="split-detail">
        {!sel ? <Empty>workflows/ にワークフローがありません</Empty> : (
          <div className="stack">
            <div>
              <span className="h1">{sel.name}</span> <span className="faint">{sel.file}</span>
              <div className="dim">{sel.description}</div>
            </div>
            {sel.problems.length > 0 && <div className="callout fail">{sel.problems.map((p) => <div key={p}>✕ {p}</div>)}</div>}
            {sel.disabled && (
              <div className="callout warn">
                ⏸ 無効（{time(sel.disabled.since)} から）。スケジュール・画面・CLI のどこからも実行されません。承認待ちの実行があれば、承認・却下はできます。
              </div>
            )}
            <div className="btn-row">
              <button className="btn" onClick={() => navigate("editor", sel.name)}>編集 <kbd>e</kbd></button>
              <button className="btn primary" onClick={() => void run()} disabled={sel.problems.length > 0 || sel.disabled !== null}>{asOf ? `${asOf} で実行` : "今日の分を実行"} <kbd>r</kbd></button>
              <input className="input" type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} title="過去日付で再生（空欄 = 今日）" />
              {asOf && <button className="btn" onClick={() => setAsOf("")}>今日に戻す</button>}
              <button className={`btn ${sel.disabled ? "" : "danger"}`} onClick={() => void toggle()}>{sel.disabled ? "▶ 有効にする" : "⏸ 無効にする"} <kbd>d</kbd></button>
              {sel.lastRun && <button className="btn" onClick={() => navigate("runs", sel.lastRun!.runId)}>最終実行を見る <Status s={sel.lastRun.status} label={false} /></button>}
              <span className="faint">実行はキューで1つずつ処理されます</span>
            </div>
            <ErrorLine error={detail.error} />
            <Pane title="グラフ" aux={g ? `${g.nodes.length} nodes · ${g.edges.length} edges` : undefined}>
              {g ? <Dag nodes={g.nodes} edges={g.edges} selected={node} onSelect={(id) => setNode(id === node ? null : id)} /> : <Empty>表示できません</Empty>}
              {cfg && (
                <>
                  <hr className="rule" />
                  <dl className="kv">
                    <dt>node</dt><dd><b>{cfg.id}</b> <span className="dim">{cfg.type} · {cfg.title}</span></dd>
                    <dt>設定</dt><dd className="fg2">{Object.keys(cfg.params).length ? JSON.stringify(cfg.params) : "—"}</dd>
                    <dt>onError</dt><dd>{cfg.onError}</dd>
                    <dt>種類</dt><dd><a className="accent" href={`#/nodes/${encodeURIComponent(cfg.type)}`}>{cfg.type} の説明 →</a></dd>
                  </dl>
                </>
              )}
            </Pane>
            <p className="faint">保存先は YAML（<Kbd>{sel.file}</Kbd>）。エディタでの保存や YAML のアップロードで上書きすると、直前の版が <Kbd>.bak</Kbd> に残ります。</p>
          </div>
        )}
      </section>
    </div>
  );
}
