import type { FactorReport, FactorStats, LabelCard, Scorecard as Card } from "@stockai/core";
import { useApi } from "../api.ts";
import { Empty, Meter, Pane } from "../components/ui.tsx";
import { pct, signedPct, EVENT_JA } from "../format.ts";

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
        {(k.byModel ?? []).length > 0 && (
          <>
            <dt>モデル別</dt>
            <dd>
              {k.byModel.map((b) => (
                <div key={b.model} className="wrap-meta">
                  <span className="fg2" style={{ display: "inline-block", minWidth: "26ch" }}>{b.model}</span>
                  <Meter value={b.hitRate ?? 0} width={16} tone={(b.hitRate ?? 0) > 0.5 ? "ok" : ""} mark={0.5} /> {pct(b.hitRate)}
                  <span className="faint"> 採点 {b.graded} · 重なりなし {pct(b.hitRateEff)}（{b.nEff}）</span>
                </div>
              ))}
              <div className="faint">各モデルが単独で答えた強気・弱気を、そのまま判断にしたと仮定して採点（棄却された票は除く）</div>
            </dd>
          </>
        )}
        {(k.byEvent ?? []).length > 0 && (
          <>
            <dt>イベント別</dt>
            <dd>
              {k.byEvent.map((b) => (
                <div key={`${b.eventType}${b.direction}`} className="wrap-meta">
                  <span style={{ display: "inline-block", minWidth: "26ch" }}><span className={b.direction > 0 ? "up" : "down"}>{b.direction > 0 ? "＋" : "−"}</span> {EVENT_JA[b.eventType] ?? b.eventType}</span>
                  <Meter value={b.hitRate ?? 0} width={16} tone={(b.hitRate ?? 0) > 0.5 ? "ok" : ""} mark={0.5} /> {pct(b.hitRate)}
                  <span className="faint"> n={b.graded} · 平均超過 {signedPct(b.meanExcess, 2)}</span>
                </div>
              ))}
              <div className="faint">資料にそのイベントがあった判断の、その後の値動きがイベントの向き（＋なら上回る）と一致した割合。判断が当たったかとは別。件数が少ないうちは参考程度</div>
            </dd>
          </>
        )}
        <dt>昇格判定</dt><dd className={k.promotion.eligible ? "ok" : "dim"}>{k.promotion.eligible ? "✓ " : "· "}{k.promotion.reason}</dd>
      </dl>
    </Pane>
  );
}

export function Scorecard({ card }: { card: Card | null | undefined }) {
  const accuracy = !card || Object.keys(card.labels).length === 0 ? (
    <Pane title="確度">
      <Empty>まだ採点できる判断がありません。</Empty>
      <p className="dim">判断は毎日記録され、20営業日後に対ベンチマークで採点されます。AI とルールの両方のワークフローを毎日動かすと、ここで比較できます。</p>
    </Pane>
  ) : (
    <>
      <div className="dim">
        {card.horizonDays}営業日後の超過リターンで採点 · 基準日 {card.asOf} ·{" "}
        <span className="faint">期間が重なる判断は独立でないため、実効標本（{card.horizonDays}営業日以上離れた判断）で統計を取ります。</span>
      </div>
      <div className="grid cols-2">
        {Object.values(card.labels).map((k) => <LabelPane key={k.label} k={k} />)}
      </div>
      <Pane title="一覧"><ScorecardTable card={card} /></Pane>
    </>
  );
  return (
    <div className="stack">
      {accuracy}
      <FactorPane />
    </div>
  );
}

const ic = (x: number | null) => (x === null ? "—" : `${x >= 0 ? "+" : ""}${x.toFixed(3)}`);
const tone = (f: FactorStats) => (f.meanIC === null || f.t === null ? "faint" : f.t >= 2 && f.meanIC > 0 ? "up" : f.t <= -2 ? "down" : f.meanIC > 0 ? "" : "dim");

function FactorRow({ f, weight, suggested }: { f: FactorStats; weight?: number | undefined; suggested?: number | undefined }) {
  return (
    <tr>
      <td title={f.note}>{f.label} <span className="faint">{f.factor.startsWith("__") ? "" : f.factor}</span></td>
      <td className={`num ${tone(f)}`}>{ic(f.meanIC)}</td>
      <td className={`num ${tone(f)}`}>{f.t === null ? "—" : f.t.toFixed(1)}</td>
      <td className="num">{pct(f.hitRate, 0)}</td>
      <td className="num">{signedPct(f.spread, 2)}</td>
      <td className="num dim">{ic(f.ic5)} / {ic(f.ic60)}</td>
      <td className="num dim">{Math.round(f.coverage)}</td>
      {weight !== undefined || suggested !== undefined ? (
        <>
          <td className="num">{weight === undefined ? "—" : weight.toFixed(2)}</td>
          <td className="num accent">{suggested === undefined ? "0" : suggested.toFixed(2)}</td>
        </>
      ) : <><td /><td /></>}
    </tr>
  );
}

/** How well each scoring factor predicted, measured on past dates (factor-research workflow). */
function FactorPane() {
  const { data, error } = useApi<{ report: FactorReport; runId: string; workflow: string } | null>("/api/factors");
  if (error) return null;
  if (!data) {
    return (
      <Pane title="因子の検証">
        <Empty>まだ検証していません。</Empty>
        <p className="dim">「7 フロー」の factor-research を実行すると、検証用の大型株 約110銘柄で、スコアの各因子が過去に翌月の超過リターンをどれだけ当てたかを測ります（AI は使いません。初回は株価と財務データの取得に時間がかかります）。</p>
      </Pane>
    );
  }
  const r = data.report;
  return (
    <Pane title="因子の検証" aux={`${r.from ?? "—"}〜${r.to ?? "—"} · ${r.universe} 銘柄 · ${r.horizon} 営業日先`}>
      <table className="t">
        <thead>
          <tr>
            <th>因子</th>
            <th className="num" title="因子の順位とその後の超過リターンの順位の相関（日ごとの平均）。実際に効く因子でも 0.02〜0.05 程度">平均 IC</th>
            <th className="num" title="重ならない日付での t 値。2 以上なら偶然ではなさそう">t</th>
            <th className="num" title="IC がプラスだった日の割合">IC＞0</th>
            <th className="num" title="因子の上位 1/5 と下位 1/5 の超過リターンの差（平均）">上位−下位</th>
            <th className="num" title="5 営業日先 / 60 営業日先の平均 IC（効き目の続き方）">5日 / 60日</th>
            <th className="num" title="値のあった銘柄数（平均）">銘柄</th>
            <th className="num">今の重み</th>
            <th className="num" title="測った IC に比例させ、日付が少ないうちは今の重みに寄せた値。自動では変わりません">提案</th>
          </tr>
        </thead>
        <tbody>
          {r.factors.map((f) => <FactorRow key={f.factor} f={f} weight={r.weights[f.factor]} suggested={r.suggested[f.factor]} />)}
          {r.composite.map((f) => <FactorRow key={f.factor} f={f} />)}
        </tbody>
      </table>
      <p className="dim">
        <span className="up">■</span> プラスで t ≥ 2（効いていそう）、<span className="down">■</span> マイナスで t ≤ −2（逆に効いている）。
        提案は、測った IC に比例させた重みを、日付が少ないうちは今の重みに寄せた値です（今の重みと同じ目盛り）。
        提案の重みを使うときは、「7 フロー」で該当ワークフローの signal.score ノードの weights に入れてください（自動では変わりません）。
      </p>
      <div className="btn-row">
        <button className="btn" type="button" onClick={() => void navigator.clipboard?.writeText(JSON.stringify(r.suggested))}>提案の重みをコピー</button>
        <a className="faint" href={`#/runs/${data.runId}`}>実行 {data.runId} ↗</a>
      </div>
      {r.notes.map((n) => <p key={n} className="faint">· {n}</p>)}
    </Pane>
  );
}
