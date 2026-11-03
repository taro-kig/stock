import type { Overview as OverviewData, TodayView } from "../../shared/types.ts";
import { useApi } from "../api.ts";
import { TickerLink } from "./StockPage.tsx";
import { Empty, Kbd, Meter, Pane, Spark, Status } from "../components/ui.tsx";
import { ago, money, moneyOrDash, pct, runDuration, signedPct, time, until, usd } from "../format.ts";
import { navigate, tabKey } from "../router.ts";

export function Overview({ data }: { data: OverviewData | undefined }) {
  if (!data) return <Empty>読み込み中…</Empty>;
  const now = new Date(data.now).getTime();
  const gates = data.pending.flatMap((p) => p.gates.map((g) => ({ run: p.run, gate: g })));
  const card = data.scorecard;

  return (
    <div className="grid cols-2">
      <div className="stack">
        <Pane title="承認待ち" aux={gates.length ? `${gates.length} 件` : undefined} className={gates.length ? "alert" : ""} actions={gates.length ? <span><Kbd>{tabKey("approvals")}</Kbd> 承認へ</span> : undefined}>
          {gates.length === 0 ? (
            <div className="dim">
              承認待ちの注文はありません。
              {data.schedule[0] && <span className="faint"> 次の自動実行は {until(data.schedule.find((s) => s.nextAt)?.nextAt, now)}。</span>}
            </div>
          ) : (
            <table className="t">
              <thead><tr><th>ワークフロー</th><th>基準日</th><th className="num">注文</th><th className="num">買い</th><th className="num">売り</th><th>待機</th></tr></thead>
              <tbody>
                {gates.map(({ run, gate }) => {
                  const buy = gate.proposals.filter((p) => p.action === "buy");
                  const sell = gate.proposals.filter((p) => p.action === "sell");
                  return (
                    <tr key={run.runId + gate.node} className="clickable" onClick={() => navigate("approvals", run.runId)}>
                      <td><Status s="waiting" label={false} />{run.workflow}</td>
                      <td>{run.asOf}</td>
                      <td className="num">{gate.proposals.length}</td>
                      <td className="num up">{moneyOrDash(buy.reduce((s, p) => s + p.shares * p.price, 0), data.currency)}</td>
                      <td className="num down">{moneyOrDash(sell.reduce((s, p) => s + p.shares * p.price, 0), data.currency)}</td>
                      <td className="dim">{ago(run.createdAt, now)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </Pane>

        <Pane title="ワークフロー" aux={`${data.workflows.length}`} actions={<span><Kbd>{tabKey("workflows")}</Kbd></span>}>
          <table className="t">
            <thead><tr><th>名前</th><th>最終実行</th><th>基準日</th><th className="num">所要</th><th>次回</th></tr></thead>
            <tbody>
              {data.workflows.map((w) => {
                const sched = data.schedule.find((s) => s.workflow === w.name);
                return (
                  <tr key={w.name} className={`clickable ${w.disabled ? "disabled-row" : ""}`} onClick={() => (w.lastRun ? navigate("runs", w.lastRun.runId) : navigate("workflows", w.name))}>
                    <td className="nowrap">{w.lastRun ? <Status s={w.lastRun.status} label={false} /> : <span className="st-g faint">·</span>}{w.name}{w.problems.length > 0 && <span className="fail"> ✕</span>}{w.marketMismatch && <span className="warn" title={w.marketMismatch}> ⚠ {w.market === "us" ? "米国株用" : "日本株用"}</span>}{w.disabled && <span className="badge off">無効</span>}</td>
                    <td className="dim">{w.lastRun ? ago(w.lastRun.createdAt, now) : "—"}</td>
                    <td>{w.lastRun?.asOf ?? "—"}</td>
                    <td className="num dim">{w.lastRun ? runDuration(w.lastRun) : "—"}</td>
                    <td className="dim nowrap">{w.disabled ? <span className="faint">停止中</span> : sched ? `${sched.at} · ${until(sched.nextAt, now)}` : "手動"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Pane>

        <Pane title="最近の実行" actions={<span><Kbd>{tabKey("runs")}</Kbd></span>}>
          {data.recent.length === 0 ? (
            <Empty>まだ実行がありません。<Kbd>{tabKey("workflows")}</Kbd> からワークフローを実行できます。</Empty>
          ) : (
            <table className="t">
              <thead><tr><th>状態</th><th>ワークフロー</th><th>基準日</th><th>開始</th><th className="num">所要</th></tr></thead>
              <tbody>
                {data.recent.map((r) => (
                  <tr key={r.runId} className="clickable" onClick={() => navigate("runs", r.runId)}>
                    <td><Status s={r.status} /></td>
                    <td>{r.workflow}</td>
                    <td>{r.asOf}</td>
                    <td className="dim">{time(r.createdAt)}</td>
                    <td className="num dim">{runDuration(r)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Pane>
      </div>

      <div className="stack">
        <TodayPane />
        <Pane title="口座" aux={data.equity.length ? `${data.equity.length}` : undefined}>
          {data.equity.length === 0 ? (
            <Empty>口座の記録はまだありません。</Empty>
          ) : (
            data.equity.map((e, i) => {
              const vals = e.points.map((p) => p[1]);
              const last = vals.at(-1) ?? 0;
              const first = vals[0] ?? last;
              const peak = Math.max(...vals);
              return (
                <div key={e.account}>
                  {i > 0 && <hr className="rule" />}
                  <div className="nowrap">
                    <span className="fg2">{e.account}</span> <span className="tag">{e.kind === "paper" ? "ペーパー" : "証券口座"}</span>
                    <span className="faint"> · {e.points.length} 日</span>
                  </div>
                  <div style={{ display: "flex", alignItems: "end", justifyContent: "space-between", gap: "2ch" }}>
                    <div>
                      <div className="h1">{money(last, e.currency)}</div>
                      <div className="nowrap">
                        <span className={last >= first ? "up" : "down"}>{signedPct(first ? last / first - 1 : 0, 2)}</span>
                        <span className="dim"> 開始比 · DD </span>
                        <span className={peak > last ? "warn" : "dim"}>{pct(peak ? 1 - last / peak : 0, 1)}</span>
                      </div>
                    </div>
                    <Spark values={vals} width={200} height={44} />
                  </div>
                </div>
              );
            })
          )}
        </Pane>

        <Pane title="確度" aux={card ? `${card.horizonDays}営業日 · ${card.asOf}` : undefined} actions={<span><Kbd>{tabKey("scorecard")}</Kbd></span>}>
          {!card || Object.keys(card.labels).length === 0 ? (
            <Empty>採点できる判断がまだありません。判断から{card?.horizonDays ?? 20}営業日後に採点されます。</Empty>
          ) : (
            <table className="t">
              <thead><tr><th>判断元</th><th>的中 (実効)</th><th className="num">実効標本</th><th>昇格</th></tr></thead>
              <tbody>
                {Object.values(card.labels).map((k) => {
                  const need = Number(/< (\d+)/.exec(k.promotion.reason)?.[1] ?? 100);
                  return (
                    <tr key={k.label}>
                      <td className="nowrap">{k.label}</td>
                      <td className="nowrap"><Meter value={k.hitRateEff ?? 0} width={12} tone={(k.hitRateEff ?? 0) > 0.5 ? "ok" : ""} mark={0.5} /> {pct(k.hitRateEff)}</td>
                      <td className="num nowrap"><Meter value={Math.min(1, k.nEff / need)} width={8} tone="accent" /> {k.nEff}</td>
                      <td>{k.promotion.eligible ? <span className="ok">✓ 可</span> : <span className="faint">—</span>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </Pane>

        <Pane title="LLM コスト" aux="本日">
          <div className="nowrap">
            <Meter value={data.cost.dailyLimit ? data.cost.spentToday / data.cost.dailyLimit : 0} width={24} tone={data.cost.spentToday / (data.cost.dailyLimit || 1) > 0.8 ? "warn" : "accent"} />{" "}
            {usd(data.cost.spentToday)} <span className="dim">/ {usd(data.cost.dailyLimit, 2)}</span>
          </div>
          {data.cost.byProvider.length > 0 && (
            <table className="t" style={{ marginTop: "calc(var(--lh) * 0.5)" }}>
              <tbody>
                {data.cost.byProvider.map((p) => (
                  <tr key={p.provider}><td className="dim">{p.provider}</td><td className="num">{p.calls} 回</td><td className="num">{usd(p.costUsd)}</td></tr>
                ))}
              </tbody>
            </table>
          )}
        </Pane>
      </div>
    </div>
  );
}

const RISK: Record<string, { text: string; cls: string; note: string }> = {
  normal: { text: "平常", cls: "ok", note: "" },
  caution: { text: "警戒", cls: "warn", note: "新規の買いは半分の大きさ" },
  stress: { text: "緊張", cls: "fail", note: "新規の買いは止める" },
};
const SECTOR_JA: Record<string, string> = {
  tech: "テック", semis: "半導体", communication: "通信", consumer: "一般消費財", staples: "生活必需品", healthcare: "ヘルスケア",
  financials: "金融", energy: "エネルギー", industrials: "資本財", materials: "素材", utilities: "公益", real_estate: "不動産",
};

/** Market risk level, sector strength, gauges, earnings of holdings, data freshness. */
function TodayPane() {
  const { data } = useApi<TodayView>("/api/today");
  if (!data) return null;
  const m = data.market;
  const r = m ? RISK[m.risk] ?? RISK["normal"]! : null;
  const sectors = m ? Object.values(m.sectors).filter((x) => x.rank !== null).sort((a, b) => a.rank! - b.rank!) : [];
  const stale = data.freshness.filter((f) => f.stale);
  const missing = data.freshness.filter((f) => f.day === null).length;
  return (
    <Pane title="今日の相場" aux={m ? `${m.asOf} 時点` : undefined} className={m?.risk === "stress" ? "alert" : ""}>
      {!m ? <p className="dim">相場のデータがまだありません（data.market を含むワークフローを実行すると出ます）。</p> : (
        <dl className="kv">
          <dt>警戒度</dt>
          <dd><b className={r!.cls}>{r!.text}</b>{r!.note && <span className="dim"> · {r!.note}</span>}{m.reasons.length > 0 && <div className="faint">{m.reasons.join("、")}</div>}</dd>
          {m.benchmark && <><dt>市場（{m.benchmark.ticker}）</dt><dd>20日 <span className={(m.benchmark.ret20 ?? 0) >= 0 ? "up" : "down"}>{signedPct(m.benchmark.ret20)}</span> · 60日 <span className={(m.benchmark.ret60 ?? 0) >= 0 ? "up" : "down"}>{signedPct(m.benchmark.ret60)}</span></dd></>}
          {sectors.length > 0 && (
            <>
              <dt>強い業種</dt><dd>{sectors.slice(0, 3).map((x) => <span key={x.sector} className="nowrap">{SECTOR_JA[x.sector] ?? x.sector} <span className="up">{signedPct(x.rel60)}</span>　</span>)}</dd>
              <dt>弱い業種</dt><dd>{sectors.slice(-3).reverse().map((x) => <span key={x.sector} className="nowrap">{SECTOR_JA[x.sector] ?? x.sector} <span className="down">{signedPct(x.rel60)}</span>　</span>)}</dd>
            </>
          )}
          {m.macro.map((x) => (
            <div key={x.id} style={{ display: "contents" }}>
              <dt>{x.label}</dt>
              <dd>{x.value.toFixed(2)}{x.unit} {x.change20 !== null && <span className="faint">（約1か月で {x.change20 >= 0 ? "+" : ""}{x.change20.toFixed(2)}）</span>}</dd>
            </div>
          ))}
        </dl>
      )}
      {data.earnings.length > 0 && (
        <p>保有株の決算: {data.earnings.map((e) => <span key={e.ticker} className="nowrap"><TickerLink t={e.ticker} /> {e.reportDate}（{e.daysAway === 0 ? "今日" : `${e.daysAway}日後`}）　</span>)}</p>
      )}
      <details>
        <summary className={stale.length ? "warn" : "dim"}>
          データの鮮度: {[stale.length ? `古いもの ${stale.length} 件` : "", missing ? `未取得 ${missing} 件` : "", !stale.length && !missing ? "問題なし" : ""].filter(Boolean).join("・")}
        </summary>
        <table className="t">
          <tbody>
            {data.freshness.map((f) => (
              <tr key={f.label}>
                <td>{f.label}</td>
                <td className={f.day === null ? "faint" : f.stale ? "warn" : "dim"}>{f.day === null ? "未取得" : `${f.day}（${f.age === 0 ? "今日" : `${f.age} 日前`}）`}</td>
                <td className="faint">{f.day === null || f.stale ? f.hint : ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </Pane>
  );
}
