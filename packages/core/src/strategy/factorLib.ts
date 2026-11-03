import type { EstimatesMap } from "../data/estimates.ts";
import { revisionScore } from "../data/estimates.ts";
import type { FundamentalsMap } from "../data/fundamentals.ts";
import { insiderScore, type InsiderMap } from "../data/insider.ts";
import type { MarketContext } from "../data/market.ts";
import type { IsoDate } from "../util/dates.ts";
import type { FactorRow } from "./factors.ts";

/**
 * Every factor the composite score can use, computed the same way for the daily score and for
 * the factor research (eval.factors), so what is measured is what is traded.
 * Higher = better for every column.
 */
export const FACTOR_INFO: Record<string, { label: string; note: string }> = {
  momentum: { label: "モメンタム 12-1", note: "直近1か月を除く12か月リターン（Jegadeesh–Titman）" },
  relStrength: { label: "相対強度", note: "6か月リターンの対ベンチマーク差" },
  event: { label: "イベント", note: "AI が抽出したニュース・開示（ウォッチリストのみ）" },
  insider: { label: "インサイダー買い", note: "Form 4 の市場での買い" },
  quality: { label: "品質", note: "営業利益率（直近4四半期）" },
  growth: { label: "成長", note: "売上の前年比（直近4四半期）" },
  revision: { label: "予想修正", note: "EPS 予想の30日変化" },
  sector: { label: "業種の強さ", note: "業種 ETF の60日リターンの対市場差（Moskowitz–Grinblatt）" },
  high52: { label: "52週高値への近さ", note: "終値 ÷ 52週高値（George–Hwang）" },
  sue: { label: "決算サプライズ（SUE）", note: "EPS の前年同期差 ÷ 過去のばらつき。提出から90日以内（Bernard–Thomas の PEAD）" },
  lowvol: { label: "低ボラティリティ", note: "60日ボラティリティの符号反転（Ang ほか）" },
  reversal: { label: "短期リバーサル", note: "20日リターンの符号反転（Jegadeesh 1990）" },
};

export interface FactorInputs {
  asOf: IsoDate;
  rows: readonly FactorRow[];
  events?: Record<string, number> | undefined;
  insider?: InsiderMap | undefined;
  fundamentals?: FundamentalsMap | undefined;
  estimates?: EstimatesMap | undefined;
  market?: MarketContext | undefined;
  /** SUE counts this many days after its filing (default 90). */
  sueDays?: number;
}

const daysBetween = (a: IsoDate, b: IsoDate) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

/**
 * factor → ticker → value. Factors whose input is not connected (or empty: "not available")
 * are left out, so the composite renormalizes over what is there.
 */
export function factorColumns(i: FactorInputs): Record<string, Record<string, number | null>> {
  const col = (f: (r: FactorRow) => number | null) => Object.fromEntries(i.rows.map((r) => [r.ticker, f(r)]));
  const out: Record<string, Record<string, number | null>> = {
    momentum: col((r) => r.momentum),
    relStrength: col((r) => r.relStrength),
    high52: col((r) => (r.fromHigh52 === null ? null : 1 + r.fromHigh52)),
    lowvol: col((r) => (r.vol === null ? null : -r.vol)),
    reversal: col((r) => (r.ret20 === null ? null : -r.ret20)),
  };
  if (i.events) out["event"] = col((r) => i.events?.[r.ticker] ?? 0);
  if (i.insider && Object.keys(i.insider).length) out["insider"] = col((r) => insiderScore(i.insider?.[r.ticker]));
  const f = i.fundamentals;
  if (f && Object.keys(f).length) {
    out["quality"] = col((r) => f[r.ticker]?.operatingMargin ?? null);
    out["growth"] = col((r) => f[r.ticker]?.revenueTtmYoY ?? null);
    const sueDays = i.sueDays ?? 90;
    out["sue"] = col((r) => {
      const x = f[r.ticker];
      return x?.sue != null && x.sueFiled && daysBetween(x.sueFiled, i.asOf) <= sueDays ? x.sue : null;
    });
  }
  if (i.estimates && Object.values(i.estimates).some((rs) => revisionScore(rs) !== null)) out["revision"] = col((r) => revisionScore(i.estimates?.[r.ticker]));
  if (i.market && Object.keys(i.market.sectors).length) out["sector"] = col((r) => i.market?.sectors[r.sector]?.rel60 ?? null);
  return out;
}
