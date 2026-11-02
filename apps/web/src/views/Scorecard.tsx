import type { LabelCard, Scorecard as Card } from "@stockai/core";
import { Empty, Meter, Pane } from "../components/ui.tsx";
import { pct, signedPct } from "../format.ts";

const needOf = (k: LabelCard) => Number(/nEff \d+ < (\d+)/.exec(k.promotion.reason)?.[1] ?? 100);

export function ScorecardTable({ card }: { card: Card }) {
  const labels = Object.values(card.labels);
  if (!labels.length) return <Empty>採点データなし</Empty>;
  return (
    <table className="t">
      <thead><tr><th>判断元</th><th className="num">判断</th><th className="num">カバー</th><th className="num">採点</th><th className="num">的中</th><th className="num">実効</th><th className="num">的中(実効)</th><th className="num">下限95%</th><th>昇格</th></tr></thead>
      <tbody>
        {labels.map((k) => (
          <tr key={k.label}>
            <td>{k.label}</td>
            <td className="num">{k.total}</td>
            <td className="num">{pct(k.coverage, 0)}</td>
            <td className="num">{k.graded}</td>
            <td className="num">{pct(k.hitRate)}</td>
            <td className="num">{k.nEff}</td>
            <td className="num">{pct(k.hitRateEff)}</td>
            <td className="num">{pct(k.wilsonLow)}</td>
            <td className={k.promotion.eligible ? "ok" : "faint"}>{k.promotion.eligible ? "✓ 可" : k.promotion.reason}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function LabelPane({ k }: { k: LabelCard }) {
  const need = needOf(k);
  const eff = k.hitRateEff;
  return (
    <Pane title={k.label} aux={k.promotion.eligible ? "昇格可" : "記録中"} className={k.promotion.eligible ? "focus" : ""}>
      <div style={{ display: "flex", gap: "4ch", alignItems: "end", flexWrap: "wrap" }}>
        <div>
          <div className="label">的中率 (重なりなし)</div>
          <div className="big-count">{pct(eff)}</div>
        </div>
        <div style={{ flex: 1, minWidth: "30ch" }}>
          <div className="label">95% 下限 {pct(k.wilsonLow)} ─ 推定 {pct(eff)} <span className="faint">（縦線 = 50%）</span></div>
          <Meter value={null} width={40} band={[k.wilsonLow ?? 0, eff ?? 0]} point={eff ?? 0} mark={0.5} />
          <div className="faint nowrap" style={{ display: "flex", justifyContent: "space-between", width: "40ch" }}><span>0%</span><span>50%</span><span>100%</span></div>
        </div>
      </div>
      <hr className="rule" />
      <dl className="kv">
        <dt>実効標本</dt><dd className="nowrap"><Meter value={Math.min(1, k.nEff / need)} width={24} tone="accent" /> {k.nEff} / {need}</dd>
        <dt>判断数</dt><dd>{k.total} <span className="dim">（方向あり {k.directional} · カバー率 {pct(k.coverage, 0)}）</span></dd>
        <dt>採点済み</dt><dd>{k.graded} <span className="dim">的中 {pct(k.hitRate)}</span></dd>
        <dt>超過リターン</dt>
        <dd>
          <span className="dim">強気</span> <span className={(k.meanExcessBullish ?? 0) >= 0 ? "up" : "down"}>{signedPct(k.meanExcessBullish, 2)}</span>
          <span className="dim">  弱気</span> <span className={(k.meanExcessBearish ?? 0) <= 0 ? "up" : "down"}>{signedPct(k.meanExcessBearish, 2)}</span>
          <span className="faint">  （弱気はマイナスが当たり）</span>
        </dd>
        <dt>確信度別</dt>
        <dd>
          {k.byConviction.map((b) => (
            <div key={b.bucket} className="nowrap">
              <span style={{ display: "inline-block", width: "8ch" }} className="dim">{b.bucket}</span>
              <Meter value={b.hitRate ?? 0} width={16} tone={(b.hitRate ?? 0) > 0.5 ? "ok" : ""} mark={0.5} /> {pct(b.hitRate)} <span className="faint">n={b.graded}</span>
            </div>
          ))}
        </dd>
        {(k.byPrompt ?? []).some((b) => b.prompt !== "—") && (
          <>
            <dt>プロンプト別</dt>
            <dd>
              {(k.byPrompt ?? []).map((b) => (
                <div key={b.prompt} className="wrap-meta">
                  <a className="accent" style={{ display: "inline-block", minWidth: "26ch" }} href={b.prompt === "—" ? undefined : `#/prompts/judge/${b.prompt.split("+")[0]}`}>{b.prompt === "—" ? "（記録なし）" : b.prompt}</a>
                  <Meter value={b.hitRateEff ?? 0} width={16} tone={(b.hitRateEff ?? 0) > 0.5 ? "ok" : ""} mark={0.5} /> {pct(b.hitRateEff)}
                  <div className="faint">下限 {pct(b.wilsonLow)} · 実効 {b.nEff} · {b.first}〜{b.last}</div>
                </div>
              ))}
            </dd>
          </>
        )}
        <dt>昇格判定</dt><dd className={k.promotion.eligible ? "ok" : "dim"}>{k.promotion.eligible ? "✓ " : "· "}{k.promotion.reason}</dd>
      </dl>
    </Pane>
  );
}

export function Scorecard({ card }: { card: Card | null | undefined }) {
  if (!card || Object.keys(card.labels).length === 0) {
    return (
      <Pane title="確度">
        <Empty>まだ採点できる判断がありません。</Empty>
        <p className="dim">判断は毎日記録され、20営業日後に対ベンチマークで採点されます。AI とルールの両方のワークフローを毎日動かすと、ここで比較できます。</p>
      </Pane>
    );
  }
  return (
    <div className="stack">
      <div className="dim">
        {card.horizonDays}営業日後の超過リターンで採点 · 基準日 {card.asOf} ·{" "}
        <span className="faint">期間が重なる判断は独立でないため、実効標本（{card.horizonDays}営業日以上離れた判断）で統計を取ります。</span>
      </div>
      <div className="grid cols-2">
        {Object.values(card.labels).map((k) => <LabelPane key={k.label} k={k} />)}
      </div>
      <Pane title="一覧"><ScorecardTable card={card} /></Pane>
    </div>
  );
}
