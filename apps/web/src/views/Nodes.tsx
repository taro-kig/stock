import type { NodeDescription } from "@stockai/core";
import { useApi } from "../api.ts";
import { Empty, Pane, PortType } from "../components/ui.tsx";
import { step, useKeys } from "../keys.ts";
import { navigate } from "../router.ts";

const CATEGORY_JA: Record<string, string> = {
  source: "情報源", filter: "フィルタ", llm: "LLM", data: "データ", signal: "シグナル",
  decision: "判断", risk: "リスク", gate: "承認", execution: "執行", eval: "評価", universe: "銘柄",
};

interface Schema {
  properties?: Record<string, { type?: string | string[]; default?: unknown; description?: string; enum?: unknown[]; anyOf?: unknown[] }>;
  required?: string[];
}

export function Nodes({ param }: { param: string | null }) {
  const { data } = useApi<NodeDescription[]>("/api/nodes");
  const nodes = data ?? [];
  const sel = nodes.find((n) => n.type === param) ?? nodes[0];
  const idx = sel ? nodes.indexOf(sel) : -1;
  useKeys({
    j: () => nodes[step(idx, nodes.length, 1)] && navigate("nodes", nodes[step(idx, nodes.length, 1)]!.type),
    k: () => nodes[step(idx, nodes.length, -1)] && navigate("nodes", nodes[step(idx, nodes.length, -1)]!.type),
  });
  let lastCat = "";
  const schema = (sel?.paramsSchema ?? {}) as Schema;
  const props = Object.entries(schema.properties ?? {});
  return (
    <div className="split-view">
      <nav className="split-list">
        <div className="list-head"><span>ノード {nodes.length}</span><span>j/k</span></div>
        {nodes.map((n) => {
          const head = n.category !== lastCat ? <div className="list-group">{CATEGORY_JA[n.category] ?? n.category}</div> : null;
          lastCat = n.category;
          return (
            <div key={n.type}>
              {head}
              <div className="list-item" aria-selected={n === sel} onClick={() => navigate("nodes", n.type)}>
                <span className="faint">·</span><span className="ellipsis">{n.type}</span><span className="dim">{n.cache}</span>
              </div>
            </div>
          );
        })}
      </nav>
      <section className="split-detail">
        {!sel ? <Empty>読み込み中…</Empty> : (
          <div className="stack">
            <div>
              <span className="h1">{sel.title}</span> <span className="dim">{sel.type}</span>
              <div className="fg2" style={{ maxWidth: "96ch" }}>{sel.description}</div>
            </div>
            <div className="grid cols-2">
              <Pane title="ポート">
                <table className="t">
                  <thead><tr><th>向き</th><th>名前</th><th>型</th></tr></thead>
                  <tbody>
                    {Object.entries(sel.inputs).map(([k, p]) => <tr key={`i${k}`}><td className="dim">入力</td><td>{k}{p.optional ? <span className="faint">?</span> : ""}</td><td><PortType t={p.type} /></td></tr>)}
                    {Object.entries(sel.outputs).map(([k, p]) => <tr key={`o${k}`}><td className="dim">出力</td><td>{k}</td><td><PortType t={p.type} /></td></tr>)}
                  </tbody>
                </table>
              </Pane>
              <Pane title="性質">
                <dl className="kv">
                  <dt>分類</dt><dd>{CATEGORY_JA[sel.category] ?? sel.category}</dd>
                  <dt>キャッシュ</dt><dd>{sel.cache} <span className="faint">{sel.cache === "none" ? "毎回実行（副作用あり）" : sel.cache === "daily" ? "入力+日付が同じなら再利用" : "入力が同じなら再利用"}</span></dd>
                  <dt>代替値</dt><dd>{sel.hasFallback ? "あり（onError: fallback 可）" : "なし"}</dd>
                  <dt>版</dt><dd>v{sel.version}</dd>
                </dl>
              </Pane>
            </div>
            <Pane title="パラメータ" aux={props.length ? `${props.length}` : undefined}>
              {props.length === 0 ? <Empty>パラメータなし</Empty> : (
                <table className="t">
                  <thead><tr><th>名前</th><th>型</th><th>既定値</th><th>説明</th></tr></thead>
                  <tbody>
                    {props.map(([k, p]) => (
                      <tr key={k}>
                        <td>{k}{schema.required?.includes(k) ? <span className="accent">*</span> : ""}</td>
                        <td className="dim">{p.enum ? p.enum.join(" | ") : Array.isArray(p.type) ? p.type.join(" | ") : (p.type ?? (p.anyOf ? "union" : "any"))}</td>
                        <td className="fg2">{p.default === undefined ? "—" : JSON.stringify(p.default)}</td>
                        <td className="dim wrap">{p.description ?? ""}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </Pane>
          </div>
        )}
      </section>
    </div>
  );
}
