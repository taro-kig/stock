import { useEffect, useRef, useState } from "react";
import type { Overview, RunDetail } from "../../shared/types.ts";
import { post, useApi } from "../api.ts";
import { Empty, Kbd, Pane, Status } from "../components/ui.tsx";
import { ago, MODE_JA, money, moneyOrDash, pct, until } from "../format.ts";
import { step, useKeys } from "../keys.ts";
import { navigate } from "../router.ts";
import { JudgmentsTable, OrdersTable } from "./RunDetail.tsx";

export function Approvals({ overview, param, toast }: { overview: Overview | undefined; param: string | null; toast: (m: string, err?: boolean) => void }) {
  const gates = (overview?.pending ?? []).flatMap((p) => p.gates.map((g) => ({ run: p.run, gate: g })));
  const sel = gates.find((g) => g.run.runId === param) ?? gates[0];
  const idx = sel ? gates.indexOf(sel) : -1;
  const detail = useApi<RunDetail>(sel ? `/api/runs/${sel.run.runId}` : null);
  const [armed, setArmed] = useState<"approve" | "reject" | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    setArmed(null);
    setNote("");
  }, [sel?.run.runId]);

  async function decide(decision: "approve" | "reject") {
    if (!sel || busy) return;
    if (armed !== decision) {
      setArmed(decision);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setArmed(null), 4000);
      return;
    }
    setBusy(true);
    try {
      await post(`/api/runs/${sel.run.runId}/approve`, { node: sel.gate.node, decision, note });
      toast(decision === "approve" ? `承認しました — ${sel.run.workflow} を再開` : `却下しました — ${sel.run.workflow}`);
      setArmed(null);
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), true);
    } finally {
      setBusy(false);
    }
  }

  useKeys({
    a: () => void decide("approve"),
    x: () => void decide("reject"),
    Escape: () => setArmed(null),
    j: () => gates[step(idx, gates.length, 1)] && navigate("approvals", gates[step(idx, gates.length, 1)]!.run.runId),
    k: () => gates[step(idx, gates.length, -1)] && navigate("approvals", gates[step(idx, gates.length, -1)]!.run.runId),
  });

  if (!overview) return <Empty>読み込み中…</Empty>;
  if (!sel) {
    const next = overview.schedule.filter((s) => s.nextAt).sort((a, b) => (a.nextAt! < b.nextAt! ? -1 : 1))[0];
    return (
      <Pane title="承認">
        <div className="big-count faint">0</div>
        <p className="dim">承認待ちの注文はありません。{next && <>次の自動実行: <span className="fg2">{next.workflow}</span> {until(next.nextAt)}。</>}</p>
        <p className="faint">承認ゲート（gate.approval が manual）のあるワークフローが注文を出すと、ここに表示されます。</p>
      </Pane>
    );
  }

  const ps = sel.gate.proposals;
  const buys = ps.filter((p) => p.action === "buy");
  const sells = ps.filter((p) => p.action === "sell");
  const buyValue = buys.reduce((s, p) => s + p.shares * p.price, 0);
  const sellValue = sells.reduce((s, p) => s + p.shares * p.price, 0);
  const account = detail.data?.highlights.account;
  const names = detail.data?.names ?? {};
  const tickers = new Set(ps.map((p) => p.ticker));
  const relevant = detail.data?.highlights.judgments?.items.filter((j) => tickers.has(j.ticker)) ?? [];

  return (
    <div className="stack">
      {gates.length > 1 && (
        <div className="btn-row">
          {gates.map((g, i) => (
            <button key={g.run.runId} className="btn" aria-pressed={g === sel} style={g === sel ? { borderColor: "var(--wait)" } : undefined} onClick={() => navigate("approvals", g.run.runId)}>
              <Status s="waiting" label={false} />{g.run.workflow} {g.run.asOf}<span className="faint"> {i + 1}/{gates.length}</span>
            </button>
          ))}
        </div>
      )}

      <Pane title="承認待ち" aux={`${sel.run.workflow} · 基準日 ${sel.run.asOf} · ${ago(sel.run.createdAt)}`} className="alert">
        <div style={{ display: "flex", gap: "5ch", flexWrap: "wrap", alignItems: "end" }}>
          <div><div className="label">注文</div><div className="big-count">{ps.length}</div></div>
          <div><div className="label">買い</div><div className={`h1 ${buyValue ? "up" : "faint"}`}>{moneyOrDash(buyValue)}</div><div className="dim">{buys.length} 件{account ? ` · 資産の ${pct(buyValue / account.equity, 1)}` : ""}</div></div>
          <div><div className="label">売り</div><div className={`h1 ${sellValue ? "down" : "faint"}`}>{moneyOrDash(sellValue)}</div><div className="dim">{sells.length} 件</div></div>
          {account && <div><div className="label">口座</div><div className="h1">{money(account.equity, account.currency)}</div><div className="dim">現金 {money(account.cash, account.currency)} · {MODE_JA[account.mode] ?? account.mode}</div></div>}
        </div>
        <hr className="rule" />
        <OrdersTable items={ps} names={names} />
        <hr className="rule" />
        <div className="btn-row">
          <button className={`btn ${armed === "approve" ? "primary" : ""}`} disabled={busy} onClick={() => void decide("approve")}>
            {armed === "approve" ? "もう一度で承認を確定" : "承認"} <kbd>a</kbd>
          </button>
          <button className={`btn danger`} disabled={busy} onClick={() => void decide("reject")} style={armed === "reject" ? { background: "var(--fail)", color: "var(--bg)" } : undefined}>
            {armed === "reject" ? "もう一度で却下を確定" : "却下"} <kbd>x</kbd>
          </button>
          <input className="input" style={{ flex: 1, minWidth: "24ch" }} placeholder="メモ（任意・記録に残ります）" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
          <span className="faint">誤操作防止のため2回押しで確定 · <Kbd>Esc</Kbd> 取消</span>
        </div>
      </Pane>

      <Pane title="この注文の根拠" aux={detail.data?.highlights.judgments?.source === "ai" ? "AI 合議" : "ルール"}>
        {relevant.length ? <JudgmentsTable items={relevant} names={names} compact /> : <Empty>判断データなし（売りは損切り・順位低下など、ルールによるものがあります）</Empty>}
      </Pane>
    </div>
  );
}
