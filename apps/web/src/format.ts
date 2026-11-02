export const GLYPH: Record<string, string> = {
  ok: "●", succeeded: "●", cached: "◆", fallback: "◐", partial: "◐", waiting: "◌",
  pending: "○", skipped: "○", queued: "○", failed: "✕", running: "▶",
};

export const STATUS_JA: Record<string, string> = {
  ok: "ok", succeeded: "完了", cached: "cache", fallback: "代替", partial: "一部", waiting: "承認待ち",
  pending: "待機", skipped: "skip", queued: "待機", failed: "失敗", running: "実行中",
};

export const STANCE_JA: Record<string, string> = { bullish: "強気", bearish: "弱気", neutral: "中立", abstain: "棄権" };

const isNum = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);

export function money(x: number | null | undefined, currency?: string | null): string {
  if (!isNum(x)) return "—";
  if (currency === "USD") return `$${x.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return `¥${Math.round(x).toLocaleString("ja-JP")}`;
}

/** A share price: cents for USD; yen with a decimal only when there is one. */
export function price(x: number | null | undefined, currency?: string | null): string {
  if (!isNum(x)) return "—";
  if (currency === "USD") return `$${x.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  return `¥${x.toLocaleString("ja-JP", { maximumFractionDigits: 1 })}`;
}

/** Amount, or a dash when there is nothing (keeps tables quiet). */
export const moneyOrDash = (x: number, currency?: string | null): string => (x ? money(x, currency) : "—");

export const MODE_JA: Record<string, string> = { normal: "通常", no_new_entries: "新規停止", reduce: "縮小" };

export const num = (x: number | null | undefined, d = 2): string => (isNum(x) ? x.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d }) : "—");
export const int = (x: number | null | undefined): string => (isNum(x) ? Math.round(x).toLocaleString("en-US") : "—");
export const pct = (x: number | null | undefined, d = 1): string => (isNum(x) ? `${(x * 100).toFixed(d)}%` : "—");
export const signedPct = (x: number | null | undefined, d = 1): string => (isNum(x) ? `${x >= 0 ? "+" : ""}${(x * 100).toFixed(d)}%` : "—");
export const usd = (x: number | null | undefined, d = 4): string => (isNum(x) ? `$${x.toFixed(d)}` : "—");

export function time(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" });
}

export function dateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return `${d.toLocaleDateString("sv-SE")} ${d.toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit" })}`;
}

export function ago(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "—";
  const s = Math.max(0, (now - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${Math.floor(s)}秒前`;
  if (s < 3600) return `${Math.floor(s / 60)}分前`;
  if (s < 86400) return `${Math.floor(s / 3600)}時間前`;
  return `${Math.floor(s / 86400)}日前`;
}

export function until(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "—";
  const s = Math.max(0, (new Date(iso).getTime() - now) / 1000);
  if (s < 3600) return `${Math.ceil(s / 60)}分後`;
  if (s < 86400) return `${Math.floor(s / 3600)}時間${Math.floor((s % 3600) / 60)}分後`;
  return `${Math.floor(s / 86400)}日後`;
}

export function duration(ms: number | null | undefined): string {
  if (!isNum(ms)) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`;
}

export const runDuration = (r: { createdAt: string; finishedAt: string | null }): string =>
  r.finishedAt ? duration(new Date(r.finishedAt).getTime() - new Date(r.createdAt).getTime()) : "—";

/** Port output summary like "docs:12". */
export function outputSummary(summary: Record<string, unknown>): string {
  return Object.entries(summary)
    .map(([k, v]) => {
      const s = v as { length?: number; keys?: number; value?: unknown };
      return `${k}:${s.length ?? s.keys ?? String(s.value)}`;
    })
    .join(" ");
}

export function metricsText(m: Record<string, number>): string {
  return Object.entries(m)
    .map(([k, v]) => `${k}=${Number.isInteger(v) ? v.toLocaleString("en-US") : v < 1 ? v.toFixed(4) : v.toFixed(1)}`)
    .join("  ");
}
