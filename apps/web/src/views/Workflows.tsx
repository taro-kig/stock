import { useState } from "react";
import type { WorkflowGraph } from "@stockai/core";
import type { WorkflowInfo } from "../../shared/types.ts";
import { post, useApi } from "../api.ts";
import { Dag } from "../components/Dag.tsx";
import { Empty, ErrorLine, Kbd, Pane, Status } from "../components/ui.tsx";
import { ago } from "../format.ts";
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

  async function run() {
    if (!sel) return;
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
    j: () => wfs[step(idx, wfs.length, 1)] && navigate("workflows", wfs[step(idx, wfs.length, 1)]!.name),
    k: () => wfs[step(idx, wfs.length, -1)] && navigate("workflows", wfs[step(idx, wfs.length, -1)]!.name),
  });

  const g = detail.data?.graph;
  const cfg = g?.nodes.find((n) => n.id === node);
  return (
    <div className="split-view">
      <nav className="split-list">
        <div className="list-head"><span>ワークフロー {wfs.length}</span><span>j/k</span></div>
        {wfs.map((w) => (
          <div key={w.name} className="list-item" aria-selected={w === sel} onClick={() => navigate("workflows", w.name)}>
            {w.problems.length ? <span className="fail">✕</span> : w.lastRun ? <Status s={w.lastRun.status} label={false} /> : <span className="faint">·</span>}
            <span className="ellipsis">{w.name}</span>
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
            <div className="btn-row">
              <button className="btn primary" onClick={() => void run()} disabled={sel.problems.length > 0}>{asOf ? `${asOf} で実行` : "今日の分を実行"} <kbd>r</kbd></button>
              <input className="input" type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} title="過去日付で再生（空欄 = 今日）" />
              {asOf && <button className="btn" onClick={() => setAsOf("")}>今日に戻す</button>}
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
            <p className="faint">いずれノードエディタでこのグラフを直接編集できるようにします。いまは YAML（<Kbd>{sel.file}</Kbd>）が正です。</p>
          </div>
        )}
      </section>
    </div>
  );
}
