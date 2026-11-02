import type { Overview as OverviewData } from "../../shared/types.ts";
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
                    <td className="nowrap">{w.lastRun ? <Status s={w.lastRun.status} label={false} /> : <span className="st-g faint">·</span>}{w.name}{w.problems.length > 0 && <span className="fail"> ✕</span>}{w.disabled && <span className="badge off">無効</span>}</td>
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
