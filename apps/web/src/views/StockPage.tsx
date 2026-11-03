import { useEffect, useMemo, useRef, useState } from "react";
import type { StockView } from "../../shared/types.ts";
import { useApi } from "../api.ts";
import { Empty, ErrorLine, Pane, Stance } from "../components/ui.tsx";
import { big, EVENT_JA, FACTOR_JA, num, pct, price, signedPct, STANCE_JA } from "../format.ts";
import { navigate } from "../router.ts";

const RANGES: Array<[string, number]> = [["3か月", 63], ["6か月", 126], ["1年", 252], ["全期間", 100_000]];
const safeUrl = (u: string) => (/^https?:\/\//i.test(u) ? u : undefined);

/** Close prices with fills on the line and a strip of the AI's judgments underneath; hover for the day. */
/** Width of an element in CSS pixels (so the chart draws at its real size: text never scales). */
function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(900);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => e && setW(Math.max(320, Math.round(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

function PriceChart({ d }: { d: StockView }) {
  const [range, setRange] = useState(252);
  const [hover, setHover] = useState<number | null>(null);
  const ref = useRef<SVGSVGElement>(null);
  const [wrap, W] = useWidth<HTMLDivElement>();
  const bars = d.bars.slice(-range);
  const H = 220;
  const STRIP = 12;
  const pad = { l: 8, r: 64, t: 10, b: 22 };
  const view = useMemo(() => {
    if (bars.length < 2) return null;
    const lo = Math.min(...bars.map((b) => b.close));
    const hi = Math.max(...bars.map((b) => b.close));
    const span = hi - lo || 1;
    const x = (i: number) => pad.l + (i / (bars.length - 1)) * (W - pad.l - pad.r);
    const y = (v: number) => pad.t + (1 - (v - (lo - span * 0.05)) / (span * 1.1)) * (H - pad.t - pad.b);
    const idx = new Map(bars.map((b, i) => [b.date, i]));
    const ticks = [0, 1, 2, 3].map((k) => lo - span * 0.05 + (span * 1.1 * k) / 3);
    return { x, y, idx, ticks, path: bars.map((b, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(b.close).toFixed(1)}`).join("") };
  }, [d.bars, range, W]);
  if (!view) return <Empty>株価のデータがありません（実行するか、株価ノードを動かすと出ます）</Empty>;
  const judgByDate = new Map<string, StockView["judgments"]>();
  for (const j of d.judgments) judgByDate.set(j.asOf, [...(judgByDate.get(j.asOf) ?? []), j]);
  const fills = d.fills.filter((f) => view.idx.has(f.asOf));
  const step = (W - pad.l - pad.r) / Math.max(1, bars.length - 1);
  const hb = hover !== null ? bars[hover] : undefined;
  const onMove = (e: React.MouseEvent) => {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    const px = ((e.clientX - r.left) / r.width) * W;
    setHover(Math.max(0, Math.min(bars.length - 1, Math.round((px - pad.l) / step))));
  };
  const tipLeft = hover !== null ? Math.min(78, Math.max(0, (view.x(hover) / W) * 100 - 8)) : 0;
  return (
    <div className="pchart">
      <div className="seg" role="radiogroup" aria-label="期間">
        {RANGES.map(([label, n]) => <button key={label} type="button" role="radio" aria-checked={range === n} className={range === n ? "on" : ""} onClick={() => setRange(n)}>{label}</button>)}
      </div>
      <div className="pchart-wrap" ref={wrap}>
        <svg ref={ref} width={W} height={H + STRIP + 6} viewBox={`0 0 ${W} ${H + STRIP + 6}`} role="img" aria-label={`${d.ticker} の終値`} onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
          {view.ticks.map((t) => (
            <g key={t}>
              <line x1={pad.l} x2={W - pad.r} y1={view.y(t)} y2={view.y(t)} className="grid" />
              <text x={W - pad.r + 6} y={view.y(t) + 4} className="axis">{num(t, t >= 100 ? 0 : 2)}</text>
            </g>
          ))}
          <text x={pad.l} y={H - 4} className="axis">{bars[0]!.date}</text>
          <text x={W - pad.r} y={H - 4} className="axis" textAnchor="end">{bars.at(-1)!.date}</text>
          <path d={view.path} className="line" />
          {fills.map((f, k) => {
            const i = view.idx.get(f.asOf)!;
            return <circle key={k} cx={view.x(i)} cy={view.y(bars[i]!.close)} r={5} className={`fill-mark ${f.side}`} />;
          })}
          {bars.map((b, i) => {
            const js = judgByDate.get(b.date);
            if (!js) return null;
            const s = js.some((j) => j.stance === "bullish") ? "bullish" : js.some((j) => j.stance === "bearish") ? "bearish" : "neutral";
            return <rect key={b.date} x={view.x(i) - Math.max(1, step / 2)} y={H + 4} width={Math.max(2, step)} height={STRIP} className={`jstrip ${s}`} />;
          })}
          {hover !== null && <line x1={view.x(hover)} x2={view.x(hover)} y1={pad.t} y2={H + STRIP + 4} className="cross" />}
          {hover !== null && hb && <circle cx={view.x(hover)} cy={view.y(hb.close)} r={4} className="hover-dot" />}
        </svg>
        {hb && (
          <div className="tip" style={{ left: `${tipLeft}%` }}>
            <div><b>{hb.date}</b> 終値 {price(hb.close, d.currency)}</div>
            {(judgByDate.get(hb.date) ?? []).map((j, k) => <div key={k}>{j.label}: <Stance s={j.stance} /> {num(j.conviction)}</div>)}
            {d.fills.filter((f) => f.asOf === hb.date).map((f, k) => <div key={`f${k}`}>{f.side === "buy" ? "買" : "売"} {f.shares.toLocaleString()} 株 @ {price(f.price, d.currency)}</div>)}
          </div>
        )}
      </div>
      <div className="legend faint">
        <span><span className="sw up">■</span> AI 強気</span> <span><span className="sw down">■</span> AI 弱気</span> <span><span className="sw neutral">■</span> 中立・棄権</span>
        <span>（下の帯 = その日の判断）</span> <span><span className="sw up">●</span> 買</span> <span><span className="sw down">●</span> 売</span>
      </div>
    </div>
  );
}

function Contributions({ d }: { d: StockView }) {
  const s = d.score;
  if (!s) return <Empty>スコアの記録がありません（スコアのノードを含むワークフローを実行すると出ます）</Empty>;
  const rows = Object.entries(s.contributions).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
  const max = Math.max(0.01, ...rows.map(([, v]) => Math.abs(v)));
  return (
    <>
      <p className="dim">合成スコア <b className="fg2">{s.total >= 0 ? "+" : ""}{num(s.total)}</b> <span className="faint">（{s.of} 銘柄中 {s.rank} 位 · {s.workflow} · {s.asOf}）</span></p>
      <div className="contrib">
        {rows.map(([f, v]) => (
          <div key={f} className="contrib-row" title={`重み ${s.weights[f] ?? 0}`}>
            <span className="contrib-label">{FACTOR_JA[f] ?? f}</span>
            <span className="contrib-track">
              <span className="contrib-mid" />
              <span className={`contrib-bar ${v >= 0 ? "pos" : "neg"}`} style={{ width: `${(Math.abs(v) / max) * 50}%`, [v >= 0 ? "left" : "right"]: "50%" }} />
            </span>
            <span className="num contrib-val">{v >= 0 ? "+" : ""}{v.toFixed(2)}</span>
          </div>
        ))}
      </div>
      <p className="faint">各因子が合成スコアに足した分（重み × 銘柄間で比べた値）。合計が合成スコア。0 は平均的という意味。</p>
    </>
  );
}

export function StockPage({ ticker }: { ticker: string }) {
  const { data: d, error } = useApi<StockView>(`/api/stocks/${encodeURIComponent(ticker)}`);
  if (error) return <ErrorLine error={error} />;
  if (!d) return <Empty>読み込み中</Empty>;
  const c = d.currency;
  const f = d.fundamentals;
  const graded = d.judgments.filter((j) => j.hit !== null);
  return (
    <div className="stack">
      <div className="stock-head">
        <span className="stock-ticker">{d.ticker}</span>
        <span className="fg2">{d.name}</span>
        <span className="dim">{d.sector}</span>
        {d.held && <span className="badge">保有中</span>}
        {!d.inWatchlist && <span className="badge off">ウォッチリスト外</span>}
        <span className="spacer" style={{ flex: 1 }} />
        <span className="dim">
          {d.bars.length ? <>終値 {price(d.bars.at(-1)!.close, c)}（{d.asOf}）· </> : null}
          20日 <span className={(d.returns.d20 ?? 0) >= 0 ? "up" : "down"}>{signedPct(d.returns.d20)}</span> · 60日 <span className={(d.returns.d60 ?? 0) >= 0 ? "up" : "down"}>{signedPct(d.returns.d60)}</span>
          {d.benchmark && <> <span className="faint">（{d.benchmark} {signedPct(d.returns.bench60)}）</span></>} · 1年 {signedPct(d.returns.d250)}
        </span>
      </div>
      <Pane title="株価と AI の判断"><PriceChart d={d} /></Pane>
      <div className="grid cols-2">
        <Pane title="スコアの内訳"><Contributions d={d} /></Pane>
        <Pane title="保有">
          {d.positions.length === 0 ? <Empty>保有していません</Empty> : (
            <dl className="kv">
              {d.positions.map((p) => (
                <div key={p.account} style={{ display: "contents" }}>
                  <dt>{p.account}</dt>
                  <dd>
                    {p.shares.toLocaleString()} 株 · 取得 {price(p.entryPrice, p.currency)}（{p.entryDate}、{p.daysHeld} 営業日）·{" "}
                    <span className={p.pnl >= 0 ? "up" : "down"}>{signedPct(p.pnlPct)}（{big(p.pnl, p.currency)}）</span>
                    {p.stop !== null && <> · 損切り {price(p.stop, p.currency)}</>}
                  </dd>
                </div>
              ))}
            </dl>
          )}
        </Pane>
        <Pane title="業績（SEC）" aux={f ? `${f.periodEnd.slice(0, 7)} 期 · ${f.filed} 提出` : undefined}>
          {!f ? <Empty>財務データがありません（米国株で SEC_USER_AGENT があれば取得されます）</Empty> : (
            <dl className="kv">
              <dt>売上（直近4四半期）</dt><dd>{big(f.revenueTtm, "USD")} <span className="dim">前年比 {signedPct(f.revenueTtmYoY)} · 直近四半期 {signedPct(f.revenueQYoY)}</span></dd>
              <dt>EPS（希薄化後）</dt><dd>{f.epsTtm === null ? "—" : f.epsTtm.toFixed(2)} <span className="dim">前年比 {signedPct(f.epsTtmYoY)} · 直近四半期 {signedPct(f.epsQYoY)}</span></dd>
              <dt>営業利益率</dt><dd>{pct(f.operatingMargin)} <span className="dim">1年前 {pct(f.operatingMarginPrev)}</span></dd>
              <dt>粗利率</dt><dd>{pct(f.grossMargin)} <span className="dim">1年前 {pct(f.grossMarginPrev)}</span></dd>
              <dt>PER / PSR</dt><dd>{d.valuation?.pe ? `${d.valuation.pe.toFixed(1)} 倍` : "—"} / {d.valuation?.ps ? `${d.valuation.ps.toFixed(1)} 倍` : "—"} <span className="dim">時価総額 {big(d.valuation?.marketCap, "USD")}</span></dd>
              <dt>決算サプライズ</dt><dd>{f.sue === null ? "—" : f.sue.toFixed(1)} <span className="faint">（前年同期差 ÷ 普段のばらつき · {f.sueFiled ?? "—"} 提出）</span></dd>
            </dl>
          )}
        </Pane>
        <Pane title="決算">
          <dl className="kv">
            <dt>次の決算</dt><dd>{d.earnings.next ? <>{d.earnings.next.reportDate} <span className="dim">（{d.earnings.next.daysAway} 日後{d.earnings.next.estimate !== null ? ` · EPS 予想 ${d.earnings.next.estimate}` : ""}）</span></> : <span className="faint">予定なし / 未取得</span>}</dd>
            {d.estimates.map((r) => (
              <div key={r.horizon + r.period} style={{ display: "contents" }}>
                <dt>予想の修正（{r.horizon === "year" ? "今期" : "次の四半期"}）</dt>
                <dd>{r.current.toFixed(2)} <span className="dim">30日 {signedPct(r.change30)} · 90日 {signedPct(r.change90)}{r.up !== null || r.down !== null ? ` · 上方 ${r.up ?? 0} / 下方 ${r.down ?? 0}` : ""}</span></dd>
              </div>
            ))}
          </dl>
          {d.earnings.results.length > 0 && (
            <table className="t">
              <thead><tr><th>発表</th><th className="num">EPS 実績</th><th className="num">予想</th><th className="num">差</th><th className="num">翌日</th><th className="num">5日</th><th className="num">20日</th></tr></thead>
              <tbody>
                {d.earnings.results.slice(0, 6).map((r) => {
                  const re = d.earnings.reactions.find((x) => x.reportedDate === r.reportedDate);
                  return (
                    <tr key={r.reportedDate}>
                      <td>{r.reportedDate}</td><td className="num">{r.reportedEPS ?? "—"}</td><td className="num">{r.estimatedEPS ?? "—"}</td>
                      <td className={`num ${(r.surprisePct ?? 0) >= 0 ? "up" : "down"}`}>{r.surprisePct === null ? "—" : `${r.surprisePct >= 0 ? "+" : ""}${r.surprisePct.toFixed(1)}%`}</td>
                      <td className="num">{signedPct(re?.after[1] ?? null)}</td><td className="num">{signedPct(re?.after[5] ?? null)}</td><td className="num">{signedPct(re?.after[20] ?? null)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          {d.earnings.results.length > 0 && <p className="faint">決算後の値動きは対ベンチマーク（ニュース前の終値から）。</p>}
        </Pane>
        <Pane title="インサイダー売買（180日）">
          {!d.insider ? <Empty>記録なし</Empty> : (
            <dl className="kv">
              <dt>買い</dt><dd>{d.insider.buys} 件 · {d.insider.buyers} 人 · {big(d.insider.buyValue, "USD")}{d.insider.cluster && <span className="badge">複数人の買い</span>}</dd>
              <dt>売り</dt><dd>{d.insider.sells} 件 · {d.insider.sellers} 人 · {big(d.insider.sellValue, "USD")} <span className="faint">（計画売り {d.insider.plannedSells}）</span></dd>
              {d.insider.topBuys.slice(0, 3).map((b, k) => <div key={k} style={{ display: "contents" }}><dt className="faint">{b.date}</dt><dd className="dim">{b.owner}（{b.title}）{big(b.value, "USD")}</dd></div>)}
            </dl>
          )}
        </Pane>
        <Pane title="業種">
          {!d.sectorRead ? <Empty>業種のデータなし（相場ノードが無いか、業種 ETF の対応が無い）</Empty> : (
            <p>{d.sectorRead.etf}: 60日の対市場 <span className={(d.sectorRead.rel60 ?? 0) >= 0 ? "up" : "down"}>{signedPct(d.sectorRead.rel60)}</span>、{d.sectorRead.of} 業種中 {d.sectorRead.rank ?? "—"} 位</p>
          )}
        </Pane>
      </div>
      <Pane title="AI の判断の履歴" aux={graded.length ? `採点済み ${graded.length} · 的中 ${pct(graded.filter((j) => j.hit).length / graded.length, 0)}` : undefined}>
        {d.judgments.length === 0 ? <Empty>判断の記録がありません</Empty> : (
          <table className="t">
            <thead><tr><th>日付</th><th>ワークフロー</th><th>判断</th><th className="num">確信</th><th>理由</th><th className="num">その後20日</th></tr></thead>
            <tbody>
              {[...d.judgments].reverse().slice(0, 30).map((j, k) => (
                <tr key={k}>
                  <td className="nowrap">{j.asOf}</td><td className="dim">{j.label}</td><td><Stance s={j.stance} /></td><td className="num">{num(j.conviction)}</td>
                  <td className="wrap">{j.thesis ?? <span className="faint">—</span>}{j.invalidation.length > 0 && <div className="faint">撤回: {j.invalidation.join(" / ")}</div>}</td>
                  <td className={`num ${j.hit === null ? "faint" : j.hit ? "ok" : "fail"}`}>{j.excess20 === null ? "未確定" : `${signedPct(j.excess20)} ${j.hit === null ? "" : j.hit ? "✓" : "✗"}`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Pane>
      <div className="grid cols-2">
        <Pane title="ニュース・開示のイベント（180日）" aux={`${d.events.length}`}>
          {d.events.length === 0 ? <Empty>記録なし</Empty> : (
            <ul className="sources">
              {d.events.map((e, k) => (
                <li key={k}>
                  <span className="faint">{e.learnedAt.slice(0, 10)}</span>{" "}
                  <span className={e.direction > 0 ? "up" : e.direction < 0 ? "down" : "dim"}>{EVENT_JA[e.eventType] ?? e.eventType} {e.direction > 0 ? "+" : ""}{e.direction}</span>{" "}
                  {safeUrl(e.url) ? <a href={safeUrl(e.url)} target="_blank" rel="noreferrer noopener">{e.title} ↗</a> : e.title}
                  {e.evidence[0] && <blockquote>{e.evidence[0]}</blockquote>}
                </li>
              ))}
            </ul>
          )}
        </Pane>
        <Pane title="約定" aux={`${d.fills.length}`}>
          {d.fills.length === 0 ? <Empty>記録なし</Empty> : (
            <table className="t">
              <thead><tr><th>日付</th><th>口座</th><th>売買</th><th className="num">株数</th><th className="num">価格</th><th>理由</th></tr></thead>
              <tbody>
                {[...d.fills].reverse().slice(0, 30).map((x, k) => (
                  <tr key={k}>
                    <td>{x.asOf}</td><td className="dim">{x.account}</td><td className={x.side === "buy" ? "up" : "down"}>{x.side === "buy" ? "買" : "売"}</td>
                    <td className="num">{x.shares.toLocaleString()}</td><td className="num">{price(x.price, c)}</td><td className="dim">{x.reason}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Pane>
      </div>
      <p className="faint"><a href="#/watchlist" onClick={(e) => { e.preventDefault(); history.length > 1 ? history.back() : navigate("watchlist"); }}>← 戻る</a> · {STANCE_JA["bullish"]}・{STANCE_JA["bearish"]}の採点は判断の20営業日後に、対ベンチマークで行います。</p>
    </div>
  );
}

/** A ticker that opens its stock page. */
export function TickerLink({ t, className }: { t: string; className?: string }) {
  return <a className={`ticker-link ${className ?? ""}`} href={`#/stock/${encodeURIComponent(t)}`} onClick={(e) => e.stopPropagation()}>{t}</a>;
}
