import { verdictOf, type EarningsResult, type EarningsVerdict } from "../data/earningsResults.ts";
import type { Prediction } from "../eval/predictions.ts";
import type { Bar } from "../signals/technical.ts";
import type { IsoDate } from "../util/dates.ts";

/**
 * Past data read back into the judgment sheet. Everything here is computed by the program
 * from what was stored before the run date, so the models get facts, not something to recall.
 */

function indexAtOrBefore(bars: readonly Bar[], date: IsoDate): number {
  let lo = 0;
  let hi = bars.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid]!.date <= date) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

/** Close-to-close return between two dates (null when either is missing). */
export function returnBetween(bars: readonly Bar[] | undefined, from: IsoDate, to: IsoDate): number | null {
  if (!bars?.length) return null;
  const i0 = indexAtOrBefore(bars, from);
  const i1 = indexAtOrBefore(bars, to);
  if (i0 < 0 || i1 <= i0) return null;
  return bars[i1]!.close / bars[i0]!.close - 1;
}

export interface PreviousJudgment {
  asOf: IsoDate;
  stance: string;
  conviction: number;
  thesis: string | null;
  invalidation: string[];
  /** Own and benchmark return from that day's close to the run date. */
  move: number | null;
  benchMove: number | null;
}

export function previousJudgment(p: Prediction | null, asOf: IsoDate, bars: readonly Bar[] | undefined, benchBars: readonly Bar[] | undefined): PreviousJudgment | null {
  if (!p) return null;
  return {
    asOf: p.asOf, stance: p.stance, conviction: p.conviction, thesis: p.thesis ?? null, invalidation: p.invalidation ?? [],
    move: returnBetween(bars, p.asOf, asOf), benchMove: returnBetween(benchBars, p.asOf, asOf),
  };
}

const pct = (x: number | null) => (x === null ? "不明" : `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}%`);
const STANCE_JA: Record<string, string> = { bullish: "強気", bearish: "弱気", neutral: "中立", abstain: "見送り" };

export function previousLines(p: PreviousJudgment | null): string[] {
  if (!p) return ["## 前回の判断", "(なし)"];
  const diff = p.move !== null && p.benchMove !== null ? `、差 ${pct(p.move - p.benchMove)}` : "";
  return [
    "## 前回の判断（参考。今日の資料で判断し直すこと）",
    `${p.asOf}: ${STANCE_JA[p.stance] ?? p.stance}（確信 ${p.conviction.toFixed(2)}）${p.thesis ? `「${p.thesis}」` : ""}`,
    ...(p.invalidation.length ? [`そのとき書いた撤回条件: ${p.invalidation.join(" / ")}`] : []),
    `その後の値動き: ${pct(p.move)}（ベンチマーク ${pct(p.benchMove)}${diff}）`,
  ];
}

export interface EarningsReaction {
  reportedDate: IsoDate;
  verdict: EarningsVerdict | null;
  surprisePct: number | null;
  /** Excess return vs the benchmark (own return when there is none) after 1, 5 and 20 trading days. */
  after: Record<1 | 5 | 20, number | null>;
}

/**
 * How the stock moved after each past report. The base is the last close before the news:
 * the report day's close for a post-market release, the previous close otherwise.
 */
export function earningsReactions(results: readonly EarningsResult[] | undefined, bars: readonly Bar[] | undefined, benchBars: readonly Bar[] | undefined, asOf: IsoDate): EarningsReaction[] {
  if (!results?.length || !bars?.length) return [];
  const out: EarningsReaction[] = [];
  for (const r of results) {
    if (r.reportedDate > asOf) continue;
    const i = indexAtOrBefore(bars, r.reportedDate);
    const onDay = i >= 0 && bars[i]!.date === r.reportedDate;
    const base = r.reportTime === "post-market" ? i : onDay ? i - 1 : i;
    if (base < 0) continue;
    const after = { 1: null, 5: null, 20: null } as EarningsReaction["after"];
    for (const k of [1, 5, 20] as const) {
      const end = bars[base + k];
      if (!end || end.date > asOf) continue;
      const own = end.close / bars[base]!.close - 1;
      const bench = benchBars ? returnBetween(benchBars, bars[base]!.date, end.date) : null;
      after[k] = benchBars ? (bench === null ? null : own - bench) : own;
    }
    if (after[1] === null) continue;
    out.push({ reportedDate: r.reportedDate, verdict: verdictOf(r), surprisePct: r.surprisePct, after });
  }
  return out;
}

const VERDICT_JA: Record<EarningsVerdict, string> = { beat: "上振れ", miss: "下振れ", inline: "予想どおり" };

export function reactionLines(rs: readonly EarningsReaction[]): string[] {
  if (!rs.length) return [];
  return [
    "## 過去の決算後の値動き（対ベンチマーク。プログラムで計算）",
    ...rs.map((r) => {
      const v = r.verdict ? `${VERDICT_JA[r.verdict]}${r.surprisePct === null ? "" : ` ${r.surprisePct >= 0 ? "+" : ""}${r.surprisePct.toFixed(1)}%`}` : "結果不明";
      return `${r.reportedDate}（${v}）: 翌日 ${pct(r.after[1])} / 5日 ${pct(r.after[5])} / 20日 ${pct(r.after[20])}`;
    }),
  ];
}
