import type { LLMRequest } from "./types.ts";

/**
 * Offline stand-in for an LLM, used by `--fake`. It reads the prompts the way a
 * careful model would (keywords, dossier lines) so the whole pipeline can be
 * exercised end-to-end for free. It is NOT a strategy and has no predictive value.
 */
export function heuristicResponder(req: LLMRequest): string {
  if (req.user.includes("# 反証の依頼")) return JSON.stringify({ found: false, severity: 0, reason: "", evidence: [] });
  if (req.user.includes("# 銘柄資料")) return judge(req.user);
  if (req.user.includes("# 候補銘柄")) return extract(req.user);
  if (req.user.includes("# 銘柄探し")) return suggest(req.user);
  return "{}";
}

const POSITIVE = ["上方修正", "増配", "自社株買い", "最高益", "raises", "raised", "beats", "exceeded", "repurchase", "record revenue"];
const NEGATIVE = ["下方修正", "減配", "不正", "赤字", "cuts", "lowers", "lowered", "misses", "below expectations", "no longer be relied upon"];

function extract(user: string): string {
  const cands = [...user.matchAll(/^- (\S+): /gm)].map((m) => m[1]!);
  const doc = user.split("# 文書")[1] ?? "";
  const title = doc.match(/^タイトル: (.*)$/m)?.[1] ?? "";
  const body = `${title}\n${doc.split("本文:\n")[1] ?? ""}`;
  const sentences = body.split(/[。\n]|(?<=\.)\s+/).map((s) => s.trim()).filter((s) => s.length >= 10);
  const find = (words: string[]) => sentences.find((s) => words.some((w) => s.includes(w)));
  const pos = find(POSITIVE);
  const neg = find(NEGATIVE);
  const hit = pos ?? neg;
  if (!hit || cands.length === 0) {
    return JSON.stringify({ relevant: false, tickers: [], eventType: "none", direction: 0, materiality: 0, horizon: "days", confidence: 0.5, evidence: [] });
  }
  const up = hit === pos;
  return JSON.stringify({
    relevant: true, tickers: [cands[0]], eventType: up ? "guidance_up" : "guidance_down", direction: up ? 2 : -2,
    materiality: 2, horizon: "months", confidence: 0.6, evidence: [hit.slice(0, 80)], rationale: "keyword heuristic",
  });
}

function judge(user: string): string {
  const line = (prefix: string) => user.split("\n").find((l) => l.startsWith(prefix)) ?? "";
  const trendLine = line("トレンド判定: ");
  const momLine = line("12-1ヶ月モメンタム: ");
  const trend = (trendLine.match(/トレンド判定: (\w+)/)?.[1] ?? "unknown") as "up" | "flat" | "down" | "unknown";
  const events = user.split("## 直近のイベント")[1]?.split("## 保有状況")[0] ?? "";
  const dirs = [...events.matchAll(/方向([+-]?\d)/g)].map((m) => Math.sign(Number(m[1])));
  const news = dirs.length === 0 ? "none" : dirs.every((d) => d > 0) ? "positive" : dirs.every((d) => d < 0) ? "negative" : "mixed";
  const mom = Number(momLine.match(/([+-]?\d+(\.\d+)?)%/)?.[1] ?? Number.NaN);
  if (trend === "unknown" || Number.isNaN(mom)) {
    return JSON.stringify({ stance: "abstain", conviction: 0, checklist: { trend, news }, thesis: "データ不足", invalidation: [], evidence: [] });
  }
  const stance = trend === "up" && mom > 0 && news !== "negative" ? "bullish" : trend === "down" || news === "negative" ? "bearish" : "neutral";
  return JSON.stringify({
    stance, conviction: Math.min(0.9, 0.4 + Math.abs(mom) / 100), checklist: { trend, news },
    thesis: `trend ${trend}, momentum ${mom}%`,
    invalidation: stance === "neutral" ? [] : ["トレンド判定が反転したら撤回"],
    evidence: [trendLine, momLine],
  });
}

/** Fixed sample for offline demos of "find stocks for a theme" (not a recommendation). */
const SAMPLE_UNIVERSE = [
  ["AVGO", "Broadcom", "semis"], ["AMD", "Advanced Micro Devices", "semis"], ["CRWD", "CrowdStrike", "tech"],
  ["PANW", "Palo Alto Networks", "tech"], ["NOW", "ServiceNow", "tech"], ["ISRG", "Intuitive Surgical", "healthcare"],
  ["CAT", "Caterpillar", "industrials"], ["NEE", "NextEra Energy", "utilities"], ["PLD", "Prologis", "real_estate"],
  ["LIN", "Linde", "materials"], ["HD", "Home Depot", "consumer"], ["PG", "Procter & Gamble", "staples"],
] as const;

function suggest(user: string): string {
  const exclude = new Set((user.match(/^除外: (.*)$/m)?.[1] ?? "").split(",").map((t) => t.trim()));
  const n = Number(user.match(/^候補数: (\d+)$/m)?.[1] ?? 10);
  const theme = user.match(/^テーマ: (.*)$/m)?.[1] ?? "";
  const candidates = SAMPLE_UNIVERSE.filter(([t]) => !exclude.has(t))
    .slice(0, n)
    .map(([ticker, name, sector]) => ({ ticker, name, aliases: [], sector, reason: `（疑似モデルの固定サンプル）${theme}` }));
  return JSON.stringify({ candidates });
}
