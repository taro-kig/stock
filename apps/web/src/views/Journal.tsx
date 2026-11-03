import { useState } from "react";
import type { JournalView } from "../../shared/types.ts";
import { useApi } from "../api.ts";
import { Empty, ErrorLine, Pane, Stance } from "../components/ui.tsx";
import { big, num, pct, price, signedPct } from "../format.ts";
import { TickerLink } from "./StockPage.tsx";

/** Paper trades: what was bought, why, how it ended. */
export function Journal() {
  const { data, error } = useApi<JournalView>("/api/journal");
  const [filter, setFilter] = useState<"all" | "open" | "closed">("all");
  if (error) return <ErrorLine error={error} />;
  if (!data) return <Empty>読み込み中</Empty>;
  if (!data.accounts.length) {
    return (
      <Pane title="売買日誌">
        <Empty>まだ取引がありません。</Empty>
        <p className="dim">ペーパー売買で約定すると、銘柄ごとに「買った理由 → 売った理由・結果」がここに並びます。確度の画面が「判断」ごとの成績なのに対し、こちらは実際の「取引」ごとの振り返りです。</p>
      </Pane>
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
      <p className="faint">取引 = 最初の買いから株数が 0 に戻るまで。損益は手数料込み、保有中は最新の終値での評価。買った理由はその日の AI の判断（同じワークフローの記録）。</p>
    </div>
  );
}
