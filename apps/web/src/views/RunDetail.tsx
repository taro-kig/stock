import { useEffect, useState } from "react";
import type { Judgment, Proposal } from "@stockai/core";
import type { NodeView, RunDetail as Detail } from "../../shared/types.ts";
import { Dag } from "../components/Dag.tsx";
import { Empty, Pane, PortType, Stance, Status } from "../components/ui.tsx";
import { dateTime, duration, metricsText, MODE_JA, money, num, outputSummary, pct, price, runDuration, EVENT_JA } from "../format.ts";
import { navigate } from "../router.ts";
import { ScorecardTable } from "./Scorecard.tsx";
import { TickerLink } from "./StockPage.tsx";

const STANCE_JA: Record<string, string> = { bullish: "強気", bearish: "弱気", neutral: "中立", abstain: "見送り" };
const safeUrl = (u: string) => (/^https?:\/\//i.test(u) ? u : undefined);

/** Why the AI decided this: quotes, the documents they come from, every model's vote and the fact sheet. */
function JudgmentEvidence({ j }: { j: Judgment }) {
  return (
    <div className="evidence">
      {j.evidence.length > 0 && (
        <div>
          <div className="dim">根拠（資料からの引用。資料にあることを機械的に確認済み）</div>
          {j.evidence.map((q) => <blockquote key={q}>{q}</blockquote>)}
        </div>
      )}
      {j.sources && j.sources.length > 0 && (
        <div>
          <div className="dim">出典（資料に載せたイベント。引用は元の文書にあることを確認済み）</div>
          <ul className="sources">
            {j.sources.map((src, k) => (
              <li key={k}>
                <span className="faint">{src.learnedAt.slice(0, 10)}</span>{" "}
                <span className={src.direction > 0 ? "up" : src.direction < 0 ? "down" : "dim"}>{EVENT_JA[src.eventType] ?? src.eventType} {src.direction > 0 ? "+" : ""}{src.direction}</span>{" "}
                {safeUrl(src.url) ? <a href={safeUrl(src.url)} target="_blank" rel="noreferrer noopener">{src.title} ↗</a> : <span>{src.title}</span>}
                <span className="faint"> · {src.source}</span>
                {src.evidence.map((q) => <blockquote key={q}>{q}</blockquote>)}
              </li>
            ))}
          </ul>
        </div>
      )}
      {j.votes.length > 0 && (
        <div>
          <div className="dim">各モデルの答え</div>
          {j.votes.map((v, k) => (
            <div key={k}>
              <span className="fg2">{v.provider}</span>{" "}
              {v.rejected ? <span className="warn">棄却 — {v.rejected}</span> : <span>{v.stance ? STANCE_JA[v.stance] ?? v.stance : "—"}</span>}
            </div>
          ))}
        </div>
      )}
      {j.dossier && (
        <details>
          <summary className="dim">モデルが読んだ資料</summary>
          <pre className="dossier">{j.dossier}</pre>
        </details>
      )}
      {!j.evidence.length && !j.sources?.length && !j.dossier && <span className="faint">根拠の記録はありません（ルールによる判断、または古い実行）</span>}
    </div>
  );
}

export function JudgmentsTable({ items, names, compact = false }: { items: Judgment[]; names: Record<string, string>; compact?: boolean }) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  if (!items.length) return <Empty>判断なし</Empty>;
  const order = { bullish: 0, bearish: 1, neutral: 2, abstain: 3 } as const;
  const toggle = (t: string) => setOpen((o) => {
    const n = new Set(o);
    if (n.has(t)) n.delete(t);
    else n.add(t);
    return n;
  });
  const cols = compact ? 5 : 6;
  return (
    <table className="t">
      <thead>
        <tr><th>銘柄</th><th>判断</th><th className="num">確信</th><th>合議</th>{!compact && <th className="num">一致</th>}<th>理由 / 撤回条件 / 拒否理由 <span className="faint">（行を押すと根拠）</span></th></tr>
      </thead>
      <tbody>
        {[...items].sort((a, b) => order[a.stance] - order[b.stance] || b.conviction - a.conviction).flatMap((j) => {
          const rejected = j.votes.filter((v) => v.rejected);
          const isOpen = open.has(j.ticker);
          return [
            <tr key={j.ticker} className="clickable" aria-expanded={isOpen} onClick={() => toggle(j.ticker)}>
              <td className="nowrap"><span className="faint">{isOpen ? "▾" : "▸"}</span> <TickerLink t={j.ticker} /> <span className="dim">{names[j.ticker] ?? ""}</span></td>
              <td><Stance s={j.stance} /></td>
              <td className="num">{num(j.conviction)}</td>
              <td className="nowrap"><Status s={j.status === "consensus" || j.status === "rules" ? "ok" : j.status === "escalated" ? "cached" : j.status === "vetoed" ? "fallback" : "skipped"} label={false} />{j.status}</td>
              {!compact && <td className="num">{pct(j.agreement, 0)}</td>}
              <td className="wrap">
                {j.vetoReason ? <span className="warn">拒否: {j.vetoReason}</span> : <span className="fg2">{j.thesis}</span>}
                {j.invalidation.length > 0 && <div className="dim">撤回: {j.invalidation.join(" / ")}</div>}
                {!compact && !isOpen && rejected.length > 0 && <div className="faint">棄却票: {rejected.map((v) => `${v.provider} — ${v.rejected}`).join("; ")}</div>}
                {(j.sources?.length ?? 0) > 0 && !isOpen && <div className="faint">出典 {j.sources!.length} 件</div>}
              </td>
            </tr>,
            ...(isOpen ? [<tr key={`${j.ticker}-ev`} className="evidence-row"><td colSpan={cols}><JudgmentEvidence j={j} /></td></tr>] : []),
          ];
        })}
      </tbody>
    </table>
  );
}

export function OrdersTable({ items, names, currency }: { items: Proposal[]; names: Record<string, string>; currency?: string | null }) {
  if (!items.length) return <Empty>注文なし</Empty>;
  return (
    <table className="t">
      <thead><tr><th>売買</th><th>銘柄</th><th className="num">株数</th><th className="num">価格</th><th className="num">金額</th><th className="num">損切り</th><th>理由</th></tr></thead>
      <tbody>
        {items.map((p) => (
          <tr key={p.action + p.ticker}>
            <td className={p.action === "buy" ? "up strong" : "down strong"}>{p.action === "buy" ? "買" : "売"}</td>
            <td className="nowrap"><TickerLink t={p.ticker} /> <span className="dim">{names[p.ticker] ?? ""}</span></td>
            <td className="num">{p.shares.toLocaleString()}</td>
            <td className="num">{price(p.price, currency)}</td>
            <td className="num">{money(p.shares * p.price, currency)}</td>
            <td className="num dim">{p.stop ? price(p.stop, currency) : "—"}</td>
            <td className="dim">{p.reason}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Metrics that mean part of the node's work failed (it still finished). */
const PROBLEM_METRICS = /^(failed|pricesFailed|macroFailed|feedsFailed|buildFailed|trackingFailed|llmErrors|invalidOutputs|limited|budgetStopped|textUnavailable)$/;
function problemCount(m: Record<string, number>): number {
  return Object.entries(m).filter(([k, v]) => PROBLEM_METRICS.test(k) && v > 0).length;
}

function NodeInspector({ n }: { n: NodeView }) {
  return (
    <dl className="kv">
      <dt>node</dt><dd><Status s={n.status} /> <b>{n.id}</b> <span className="dim">{n.type}</span></dd>
      <dt>入力</dt>
      <dd>{n.inputs.length ? n.inputs.map((i) => <div key={i.name}>{i.name}{i.optional ? "?" : ""} <PortType t={i.type} /> <span className="faint">← {i.from ? `${i.from.node}.${i.from.port}` : "未接続"}</span></div>) : <span className="faint">—</span>}</dd>
      <dt>出力</dt><dd>{n.outputs.map((o) => <span key={o.name}>{o.name} <PortType t={o.type} />  </span>)} <span className="dim">{outputSummary(n.summary)}</span></dd>
      <dt>設定</dt><dd className="fg2">{Object.keys(n.params).length ? JSON.stringify(n.params) : "—"} <span className="faint">onError={n.onError}</span></dd>
      <dt>計測</dt><dd className="fg2">{metricsText(n.metrics) || "—"} <span className="faint">{duration(n.durationMs)}</span></dd>
      {n.error && (<><dt>エラー</dt><dd className={n.status === "waiting" ? "wait" : "fail"}>{n.error}</dd></>)}
      {n.logs.length > 0 && (<><dt>ログ</dt><dd className="fg2 node-logs">{n.logs.map((l, i) => <div key={i}>{l}</div>)}</dd></>)}
    </dl>
  );
}

type Tab = "judgments" | "orders" | "fills" | "broker" | "account" | "scorecard" | "nodes";

export function RunDetailView({ d }: { d: Detail }) {
  const h = d.highlights;
  const [node, setNode] = useState<string | null>(null);
  const tabs: Array<[Tab, string, number | null]> = [
    ["judgments", "判断", h.judgments?.items.length ?? null],
    ["orders", h.proposals?.approved ? "注文 (承認後)" : "注文案", h.proposals?.items.length ?? null],
    ["fills", "約定", h.fills?.length ?? null],
    ["broker", "ブローカー注文", h.orders?.length ?? null],
    ["account", "口座", h.account ? Object.keys(h.account.positions).length : null],
    ["scorecard", "確度", h.scorecard ? Object.keys(h.scorecard.labels).length : null],
    ["nodes", "ノード", d.nodes.length],
  ];
  const available = tabs.filter(([, , n]) => n !== null);
  const [tab, setTab] = useState<Tab>(available[0]?.[0] ?? "nodes");
  useEffect(() => {
    if (!available.some(([t]) => t === tab)) setTab(available[0]?.[0] ?? "nodes");
  }, [d.run.runId]); // eslint-disable-line
  const selected = d.nodes.find((n) => n.id === node);
  const failed = d.nodes.filter((n) => n.status === "failed");

  return (
    <div className="stack">
      <div>
        <div style={{ display: "flex", alignItems: "baseline", gap: "2ch", flexWrap: "wrap" }}>
          <span className="h1">{d.run.workflow}</span>
          <Status s={d.run.status} />
          <span className="dim">基準日 {d.run.asOf}</span>
          <span className="faint">{dateTime(d.run.createdAt)} · {runDuration(d.run)}</span>
          {d.waiting.length > 0 && <button className="btn primary" onClick={() => navigate("approvals", d.run.runId)}>承認へ →</button>}
        </div>
        <div className="dim">{d.description}</div>
        <div className="faint">{d.run.runId}</div>
      </div>

      {failed.length > 0 && <div className="callout fail">{failed.map((n) => <div key={n.id}>✕ {n.id}: {n.error}</div>)}</div>}

      <Pane title="結果">
        <div className="subtabs" role="tablist">
          {available.map(([t, label, n]) => (
            <button key={t} className="subtab" role="tab" aria-selected={tab === t} onClick={() => setTab(t)}>
              {label}<span className="n">{n}</span>
            </button>
          ))}
        </div>
        {tab === "judgments" && h.judgments && <JudgmentsTable items={h.judgments.items} names={d.names} />}
        {tab === "orders" && h.proposals && <OrdersTable items={h.proposals.items} names={d.names} currency={d.currency} />}
        {tab === "fills" && h.fills && (h.fills.length ? (
          <table className="t">
            <thead><tr><th>売買</th><th>銘柄</th><th className="num">株数</th><th className="num">約定値</th><th className="num">手数料</th><th>理由</th></tr></thead>
            <tbody>{h.fills.map((f, i) => <tr key={i}><td className={f.side === "buy" ? "up" : "down"}>{f.side === "buy" ? "買" : "売"}</td><td>{f.ticker} <span className="dim">{d.names[f.ticker] ?? ""}</span></td><td className="num">{f.shares}</td><td className="num">{price(f.price, d.currency)}</td><td className="num">{money(f.fee, d.currency)}</td><td className="dim">{f.reason}</td></tr>)}</tbody>
          </table>
        ) : <Empty>約定なし</Empty>)}
        {tab === "broker" && h.orders && (
          <table className="t">
            <thead><tr><th>状態</th><th>売買</th><th>銘柄</th><th className="num">株数</th><th className="num">指値</th><th>ref / メッセージ</th></tr></thead>
            <tbody>{h.orders.map((o) => <tr key={o.ref}><td className={o.status === "submitted" ? "ok" : o.status === "blocked" || o.status === "error" ? "fail" : "dim"}>{o.status}</td><td className={o.side === "buy" ? "up" : "down"}>{o.side === "buy" ? "買" : "売"}</td><td>{o.ticker}</td><td className="num">{o.shares}</td><td className="num">{price(o.limitPrice, d.currency)}</td><td className="dim wrap">{o.ref} {o.message}</td></tr>)}</tbody>
          </table>
        )}
        {tab === "account" && h.account && (
          <div>
            <dl className="kv">
              <dt>口座</dt><dd>{h.account.account} <span className="faint">{h.account.currency}</span></dd>
              <dt>評価額</dt><dd>{money(h.account.equity, h.account.currency)} <span className="dim">ピーク {money(h.account.peakEquity, h.account.currency)}</span></dd>
              <dt>現金</dt><dd>{money(h.account.cash, h.account.currency)}</dd>
              <dt>モード</dt><dd className={h.account.mode === "normal" ? "ok" : "warn"}>{MODE_JA[h.account.mode] ?? h.account.mode}</dd>
            </dl>
            <hr className="rule" />
            {Object.keys(h.account.positions).length === 0 ? <Empty>保有なし</Empty> : (
              <table className="t">
                <thead><tr><th>銘柄</th><th className="num">株数</th><th className="num">取得単価</th><th className="num">高値</th><th>取得日</th><th className="num">保有日数</th></tr></thead>
                <tbody>{Object.values(h.account.positions).map((p) => <tr key={p.ticker}><td>{p.ticker} <span className="dim">{d.names[p.ticker] ?? ""}</span></td><td className="num">{p.shares}</td><td className="num">{price(p.entryPrice, d.currency)}</td><td className="num">{price(p.highestClose, d.currency)}</td><td>{p.entryDate}</td><td className="num">{p.daysHeld}</td></tr>)}</tbody>
              </table>
            )}
          </div>
        )}
        {tab === "scorecard" && h.scorecard && <ScorecardTable card={h.scorecard} />}
        {tab === "nodes" && (
          <table className="t">
            <thead><tr><th></th><th>node</th><th>type</th><th className="num">ms</th><th>出力</th><th>計測 / エラー</th></tr></thead>
            <tbody>
              {d.nodes.map((n) => (
                <tr key={n.id} className="clickable" aria-selected={node === n.id} onClick={() => setNode(n.id)}>
                  <td><Status s={n.status} label={false} /></td>
                  <td>{n.id}</td>
                  <td className="dim">{n.type}</td>
                  <td className="num dim">{Math.round(n.durationMs)}</td>
                  <td className="dim">{outputSummary(n.summary)}</td>
                  <td className={n.error ? (n.status === "waiting" ? "wait" : "fail") : "faint"}>
                    {n.error ?? metricsText(n.metrics)}
                    {!n.error && problemCount(n.metrics) > 0 && <span className="warn" title="一部が失敗。ノードを選ぶとログに理由"> ⚠ 一部失敗</span>}
                    {n.logs.length > 0 && <span className="faint" title="ノードを選ぶと表示"> · ログ {n.logs.length}</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Pane>

      <Pane title="フロー" aux={`${d.nodes.length} nodes`} actions={node ? <span className="dim" style={{ cursor: "pointer" }} onClick={() => setNode(null)}>Esc 選択解除</span> : <span className="faint">ノードをクリックで詳細</span>}>
        <Dag nodes={d.nodes} edges={d.edges} selected={node} onSelect={(id) => setNode(id === node ? null : id)} />
        {selected && (<><hr className="rule" /><NodeInspector n={selected} /></>)}
      </Pane>

    </div>
  );
}
