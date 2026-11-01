import { useMemo, useState } from "react";
import type { CalendarView } from "../../shared/types.ts";
import { useApi } from "../api.ts";
import { Empty, ErrorLine, Kbd, Pane } from "../components/ui.tsx";
import { time } from "../format.ts";
import { useKeys } from "../keys.ts";
import { navigate } from "../router.ts";

const WEEKDAYS = ["月", "火", "水", "木", "金", "土", "日"];
const pad = (n: number) => String(n).padStart(2, "0");
const iso = (d: Date) => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
const add = (s: string, n: number) => {
  const d = new Date(`${s}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return iso(d);
};
/** Monday on or before a date. */
const mondayOf = (s: string) => add(s, -((new Date(`${s}T00:00:00Z`).getUTCDay() + 6) % 7));
const STATUS_GLYPH: Record<string, string> = { succeeded: "●", partial: "◐", failed: "✕", waiting: "◌", running: "▶", queued: "·" };
/** 前 = before the open, 後 = after the close (glyphs like ☀ are missing from many monospace fonts). */
const TIME_MARK = (t: string | null) => (t === "pre-market" ? "前" : t === "post-market" ? "後" : "");

export function Calendar() {
  const [offset, setOffset] = useState(0); // weeks
  const base = useMemo(() => {
    const now = new Date();
    return mondayOf(`${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`);
  }, []);
  const from = add(base, (offset - 1) * 7);
  const to = add(from, 41);
  const { data, error } = useApi<CalendarView>(`/api/calendar?from=${from}&to=${to}`);
  const upcoming = useApi<CalendarView>(`/api/calendar?from=${add(base, 0)}&to=${add(base, 90)}`);
  useKeys({ "[": () => setOffset((o) => o - 4), "]": () => setOffset((o) => o + 4), "0": () => setOffset(0) });

  if (error) return <ErrorLine error={error} />;
  const by = <T extends { date: string }>(xs: T[] | undefined) => {
    const m = new Map<string, T[]>();
    for (const x of xs ?? []) m.set(x.date, [...(m.get(x.date) ?? []), x]);
    return m;
  };
  const hol = by(data?.holidays);
  const earn = by(data?.earnings);
  const sched = by(data?.schedule);
  const runs = by(data?.runs);
  const weeks = Array.from({ length: 6 }, (_, w) => Array.from({ length: 7 }, (_, d) => add(from, w * 7 + d)));
  const next = (upcoming.data?.earnings ?? []).filter((e) => e.daysAway >= 0).slice(0, 30);
  const month = (d: string) => `${Number(d.slice(5, 7))}月`;

  return (
    <div className="calendar-layout">
      <Pane
        title={`カレンダー ${from.slice(0, 7).replace("-", "/")} 〜 ${to.slice(0, 7).replace("-", "/")}`}
        aux={data?.market === "us" ? "米国市場（NYSE / Nasdaq の休場・決算）" : "日本株: 休場日と決算予定は未対応（自動実行と実行履歴のみ）"}
        actions={<span><Kbd>[</Kbd> 前 <Kbd>0</Kbd> 今週 <Kbd>]</Kbd> 次</span>}
      >
        <div className="btn-row" style={{ marginBottom: 6 }}>
          <button className="btn" onClick={() => setOffset((o) => o - 4)}>← 4週前</button>
          <button className="btn" onClick={() => setOffset(0)}>今週</button>
          <button className="btn" onClick={() => setOffset((o) => o + 4)}>4週後 →</button>
          <span className="faint">
            <span className="cal-hol">休場</span> · <b className="accent">保有中</b> / 監視中の決算（前 = 寄り前・後 = 引け後）· <span className="dim">◷ 自動実行</span> · 実行結果（日付は基準日）
          </span>
        </div>
        <div className="cal-grid">
          {WEEKDAYS.map((w, i) => <div key={w} className={`cal-head ${i >= 5 ? "weekend" : ""}`}>{w}</div>)}
          {weeks.flat().map((d) => {
            const wd = (new Date(`${d}T00:00:00Z`).getUTCDay() + 6) % 7;
            const h = hol.get(d)?.[0];
            const isToday = d === data?.today;
            return (
              <div key={d} className={`cal-cell ${wd >= 5 ? "weekend" : ""} ${h ? "holiday" : ""} ${isToday ? "today" : ""} ${d < (data?.today ?? "") ? "past" : ""}`}>
                <div className="cal-date">
                  <span>{d.endsWith("-01") || d === from ? `${month(d)}${Number(d.slice(8))}日` : Number(d.slice(8))}</span>
                  {h && <span className="cal-hol" title="NYSE / Nasdaq 休場">休場 {h.name}</span>}
                </div>
                {(earn.get(d) ?? []).map((e) => (
                  <div key={e.ticker} className={`cal-earn ${e.held ? "held" : ""}`} title={`${e.name} の決算${e.estimate !== null ? ` · EPS 予想 ${e.estimate}` : ""}`}>
                    {e.ticker}{TIME_MARK(e.time) && <span className="cal-time">{TIME_MARK(e.time)}</span>}
                  </div>
                ))}
                {(sched.get(d) ?? []).map((x) => (
                  <div key={`${x.workflow}-${x.at}`} className={`cal-sched ${x.skipped ? "skipped" : ""}`} title={x.skipped ?? "自動実行"}>
                    ◷ {x.at} {x.workflow}{x.skipped ? ` (${x.skipped})` : ""}
                  </div>
                ))}
                {(runs.get(d) ?? []).slice(0, 4).map((r) => (
                  <div key={r.runId} className={`cal-run st-${r.status === "succeeded" ? "ok" : r.status === "waiting" ? "waiting" : r.status === "failed" ? "failed" : "fallback"}`} onClick={() => navigate("runs", r.runId)}>
                    {STATUS_GLYPH[r.status] ?? "·"} {r.workflow}
                  </div>
                ))}
                {(runs.get(d)?.length ?? 0) > 4 && <div className="faint">+{runs.get(d)!.length - 4}</div>}
              </div>
            );
          })}
        </div>
      </Pane>

      <Pane title="直近の決算" aux={data?.market === "us" ? "90日先まで" : "—"}>
        {data?.market !== "us" ? <Empty>米国株の設定でのみ表示します</Empty> : !data.earningsSource.configured && !data.earningsSource.lastFetch ? (
          <p className="dim">
            決算予定は Alpha Vantage の無料キーで取得します。<a className="accent" href="#/settings">7 設定</a> で <code>ALPHAVANTAGE_API_KEY</code> を入れると、次の日次実行から表示されます。
          </p>
        ) : next.length === 0 ? <Empty>予定なし（ウォッチリストの銘柄）</Empty> : (
          <table className="t">
            <tbody>
              {next.map((e) => (
                <tr key={`${e.ticker}-${e.date}`}>
                  <td className="nowrap">{e.date.slice(5).replace("-", "/")}</td>
                  <td className={`num nowrap ${e.daysAway <= 3 ? "warn" : "dim"}`}>{e.daysAway === 0 ? "今日" : `${e.daysAway}日後`}</td>
                  <td className="nowrap"><b className={e.held ? "accent" : ""}>{e.ticker}</b>{TIME_MARK(e.time) && <span className="cal-time">{TIME_MARK(e.time)}</span>}</td>
                  <td className="dim ellipsis">{e.name}{e.held ? "（保有中）" : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {data?.earningsSource.lastFetch && <p className="faint">最終取得 {time(data.earningsSource.lastFetch)} · {data.earningsSource.rows?.toLocaleString()} 件</p>}
        <p className="faint">決算の 3 日前からは新規の買いを止めます（<code>portfolio.propose</code> の <code>earningsBlackoutDays</code>）。AI の判断資料にも次の決算日が載ります。</p>
      </Pane>
    </div>
  );
}
