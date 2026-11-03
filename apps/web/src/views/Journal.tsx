import { useState } from "react";
import type { TrackedOrder } from "@stockai/core";
import type { JournalView } from "../../shared/types.ts";
import { get, useApi } from "../api.ts";
import { Empty, ErrorLine, Pane, Stance } from "../components/ui.tsx";
import { big, dateTime, num, pct, price, signedPct } from "../format.ts";
import { TickerLink } from "./StockPage.tsx";

/** Paper trades: what was bought, why, how it ended. */
export function Journal() {
  const { data, error } = useApi<JournalView>("/api/journal");
  const [filter, setFilter] = useState<"all" | "open" | "closed">("all");
  if (error) return <ErrorLine error={error} />;
  if (!data) return <Empty>読み込み中</Empty>;
  if (!data.accounts.length && !data.brokerOrders.length) {
    return (
      <div className="stack">
      <ReportPane />
      <Pane title="売買日誌">
        <Empty>まだ取引がありません。</Empty>
        <p className="dim">ペーパー売買で約定すると、銘柄ごとに「買った理由 → 売った理由・結果」がここに並びます。確度の画面が「判断」ごとの成績なのに対し、こちらは実際の「取引」ごとの振り返りです。</p>
      </Pane>
      </div>
    );
  }
  return (
    <div className="stack">
      <div className="seg" role="radiogroup" aria-label="表示">
        {([["all", "すべて"], ["open", "保有中"], ["closed", "決済済み"]] as const).map(([v, label]) => (
          <button key={v} type="button" role="radio" aria-checked={filter === v} className={filter === v ? "on" : ""} onClick={() => setFilter(v)}>{label}</button>
        ))}
      </div>
      {data.accounts.map((a) => {
        const s = a.summary;
        const trades = a.trades.filter((t) => filter === "all" || (filter === "open" ? t.open : !t.open));
        return (
          <Pane key={a.account} title={a.account} aux={`${a.currency} · 決済 ${s.closed} · 保有 ${s.open}`}>
            <div className="journal-stats">
              <div><div className="label">勝率</div><div className="big-count">{pct(s.winRate, 0)}</div></div>
              <div><div className="label">平均の勝ち / 負け</div><div><span className="up">{signedPct(s.avgWin)}</span> / <span className="down">{signedPct(s.avgLoss)}</span></div></div>
              <div><div className="label" title="利益の合計 ÷ 損失の合計。1 より大きければ全体で勝ち">プロフィットファクター</div><div>{s.profitFactor === null ? "—" : num(s.profitFactor)}</div></div>
              <div><div className="label">平均保有</div><div>{s.avgDaysHeld === null ? "—" : `${Math.round(s.avgDaysHeld)} 日`}</div></div>
              <div><div className="label">確定損益</div><div className={s.realized >= 0 ? "up" : "down"}>{big(s.realized, a.currency)}</div></div>
            </div>
            {trades.length === 0 ? <Empty>該当する取引はありません</Empty> : (
              <table className="t">
                <thead>
                  <tr><th>銘柄</th><th>期間</th><th className="num">株数</th><th className="num">買値 → 売値</th><th className="num">損益</th><th>買った理由</th><th>売った理由</th></tr>
                </thead>
                <tbody>
                  {trades.map((t, k) => (
                    <tr key={k}>
                      <td className="nowrap"><TickerLink t={t.ticker} />{t.open && <span className="badge" style={{ marginLeft: "1ch" }}>保有中</span>}</td>
                      <td className="nowrap dim">{t.entryDate} → {t.exitDate ?? "今"}<div className="faint">{t.daysHeld} 日</div></td>
                      <td className="num">{(t.open ? t.openShares : t.shares).toLocaleString()}</td>
                      <td className="num nowrap">{price(t.avgEntry, a.currency)} → {t.avgExit !== null && !t.open ? price(t.avgExit, a.currency) : <span className="faint">{price(t.lastClose, a.currency)}</span>}</td>
                      <td className={`num nowrap ${t.pnl >= 0 ? "up" : "down"}`}>{signedPct(t.ret)}<div className="faint">{big(t.pnl, a.currency)}{t.open ? "（評価）" : ""}</div></td>
                      <td className="wrap">
                        {t.entryJudgment ? <><Stance s={t.entryJudgment.stance} /> <span className="faint">{num(t.entryJudgment.conviction)}</span> {t.entryJudgment.thesis ?? ""}</> : <span className="dim">{t.entryReason}</span>}
                        {t.entryJudgment && <div className="faint">{t.entryReason}</div>}
                      </td>
                      <td className="wrap dim">{t.exitReason ?? <span className="faint">—</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Pane>
        );
      })}
      {data.brokerOrders.length > 0 && <BrokerOrders orders={data.brokerOrders} />}
      <ReportPane />
      <p className="faint">取引 = 最初の買いから株数が 0 に戻るまで。損益は手数料込み、保有中は最新の終値での評価。買った理由はその日の AI の判断（同じワークフローの記録）。</p>
    </div>
  );
}

const STATE: Record<string, { label: string; cls: string }> = {
  working: { label: "注文中", cls: "dim" },
  filled: { label: "約定", cls: "up" },
  partial: { label: "一部約定", cls: "warn" },
  unfilled: { label: "約定せず", cls: "dim" },
};

/** Orders sent to IBKR / Webull and their outcome (checked at the start of the next run). */
function BrokerOrders({ orders }: { orders: TrackedOrder[] }) {
  return (
    <Pane title="ブローカーの注文" aux={`直近 ${orders.length} 件`}>
      <table className="t">
        <thead>
          <tr><th>送信</th><th>口座</th><th>銘柄</th><th>売買</th><th className="num">株数</th><th className="num">指値</th><th>結果</th><th className="num">約定</th><th>メモ</th></tr>
        </thead>
        <tbody>
          {orders.map((o) => {
            const st = o.state ? STATE[o.state] : null;
            return (
              <tr key={o.ref}>
                <td className="nowrap dim">{o.asOf}</td>
                <td className="nowrap faint">{o.account}</td>
                <td className="nowrap"><TickerLink t={o.ticker} /></td>
                <td className={o.side === "buy" ? "up" : "down"}>{o.side === "buy" ? "買い" : "売り"}</td>
                <td className="num">{o.shares.toLocaleString()}</td>
                <td className="num">{price(o.limitPrice)}</td>
                <td className={`nowrap ${st?.cls ?? "faint"}`}>{st?.label ?? "—"}{o.estimated && o.state !== "working" && <span className="faint" title="ブローカーの約定報告ではなく、保有株数の変化から推定"> 推定</span>}</td>
                <td className="num nowrap">{o.filledShares !== null ? `${o.filledShares.toLocaleString()}/${o.shares.toLocaleString()}` : "—"}{o.fillPrice !== null && <div className="faint">約 {price(o.fillPrice)}</div>}</td>
                <td className="wrap faint">{o.note ?? ""}{o.checkedAt && <div>確認 {dateTime(o.checkedAt)}</div>}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="faint">結果は次の実行の最初に確認します（注文一覧に残っていれば注文中、消えていれば保有株数の変化から約定・一部約定・約定せずを判断）。同じ銘柄を手やアプリで売買すると推定がずれます。正確な約定はブローカーの画面で確認してください。</p>
    </Pane>
  );
}

/** The report to paste to Claude: the last 7 or 30 days as Markdown (keys and account numbers masked). */
function ReportPane() {
  const [days, setDays] = useState<number | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function make(d: number) {
    setBusy(true);
    setError(null);
    setCopied(false);
    try {
      const r = await get<{ markdown: string }>(`/api/report?days=${d}`);
      setText(r.markdown);
      setDays(d);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      setError("コピーできませんでした。下の欄を選んでコピーしてください");
    }
  }
  return (
    <Pane title="レポート" aux={days ? `直近 ${days} 日` : "Claude に貼る用"}>
      <div className="btn-row">
        <button className="btn" type="button" disabled={busy} onClick={() => void make(7)}>直近 7 日</button>
        <button className="btn" type="button" disabled={busy} onClick={() => void make(30)}>直近 30 日</button>
        {text && <button className="btn primary" type="button" onClick={() => void copy()}>{copied ? "コピーしました" : "コピー"}</button>}
        <span className="faint">口座・取引・判断・確度・失敗（ログつき）・LLM の費用をまとめます。キー・メール・証券口座の番号は伏せます。<code>task report</code> でも作れます</span>
      </div>
      {error && <p className="warn">{error}</p>}
      {text && <textarea className="input report-text" readOnly value={text} onFocus={(e) => e.currentTarget.select()} aria-label="report" />}
    </Pane>
  );
}
