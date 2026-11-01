import { z } from "zod";
import { Ensemble, type EnsembleStatus } from "../harness/ensemble.ts";
import { checkEvidence } from "../harness/grounding.ts";
import type { StructuredCaller } from "../harness/structured.ts";
import type { LLMProvider } from "../llm/types.ts";
import type { EventRecord } from "../signals/models.ts";
import type { FactorRow } from "../strategy/factors.ts";
import type { Position } from "../strategy/portfolio.ts";
import type { IsoDate } from "../util/dates.ts";
import {
  JUDGE_PROMPT_VERSION, JUDGE_PROMPTS, RED_TEAM_PROMPT_VERSION, RED_TEAM_PROMPTS,
  type DossierVariant, type JudgePromptVersion, type RedTeamPromptVersion,
} from "./prompts.ts";

export const STANCES = ["bullish", "neutral", "bearish", "abstain"] as const;
export type Stance = (typeof STANCES)[number];
export type TrendRead = "up" | "flat" | "down" | "unknown";
export type NewsTone = "positive" | "mixed" | "negative" | "none";

export const TradeJudgment = z.object({
  stance: z.enum(STANCES),
  conviction: z.number().min(0).max(1),
  checklist: z.object({
    trend: z.enum(["up", "flat", "down", "unknown"]),
    news: z.enum(["positive", "mixed", "negative", "none"]),
  }),
  thesis: z.string().max(300).describe("判断理由を1〜2文で"),
  invalidation: z.array(z.string().max(120)).max(3).default([]),
  evidence: z.array(z.string()).max(3).default([]),
});
export type TradeJudgment = z.output<typeof TradeJudgment>;

export const RedTeamFinding = z.object({
  found: z.boolean(),
  severity: z.number().int().min(0).max(3),
  reason: z.string().max(300).default(""),
  evidence: z.array(z.string()).max(3).default([]),
});
export type RedTeamFinding = z.output<typeof RedTeamFinding>;

/** What the decision layer consumes, and what gets graded later. */
export interface Judgment {
  ticker: string;
  stance: Stance;
  conviction: number;
  status: EnsembleStatus | "vetoed" | "rules";
  agreement: number;
  thesis: string;
  invalidation: string[];
  evidence: string[];
  vetoReason: string | null;
  votes: Array<{ provider: string; stance: Stance | null; rejected: string | null }>;
}

export interface Dossier {
  ticker: string;
  text: string;
  trend: TrendRead;
  news: NewsTone;
  held: boolean;
}

const pct = (x: number | null) => (x === null ? "不明" : `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}%`);

export function buildDossier(args: {
  row: FactorRow;
  asOf: IsoDate;
  rank: number;
  universe: number;
  events: readonly EventRecord[];
  position?: Position | undefined;
}, variant: DossierVariant = "v1"): Dossier {
  const { row, events, position } = args;
  const trend: TrendRead = row.trend ?? "unknown";
  const dirs = events.map((e) => Math.sign(e.event.direction)).filter((d) => d !== 0);
  const news: NewsTone = dirs.length === 0 ? "none" : dirs.every((d) => d > 0) ? "positive" : dirs.every((d) => d < 0) ? "negative" : "mixed";
  const trendText = { up: "up (終値とSMA50がSMA200を上回る)", down: "down (終値とSMA50がSMA200を下回る)", flat: "flat (方向感なし)", unknown: "unknown (データ不足)" }[trend];
  const evLines = events.length
    ? events.map((e) => `- ${e.learnedAt.slice(0, 10)} ${e.event.eventType} 方向${e.event.direction > 0 ? "+" : ""}${e.event.direction} 重要度${e.event.materiality}: ${e.event.evidence[0] ?? e.title}`)
    : ["(なし)"];
  const posLine = position
    ? `保有中: 取得単価 ${position.entryPrice.toFixed(1)}, 保有 ${position.daysHeld} 営業日, 含み損益 ${pct(row.close / position.entryPrice - 1)}`
    : "未保有";
  const text = [
    "# 銘柄資料",
    `銘柄: ${row.ticker} ${row.name} (セクター: ${row.sector})`,
    `基準日: ${args.asOf}`,
    "## 価格・定量",
    `終値: ${row.close.toFixed(1)}`,
    `トレンド判定: ${trendText}`,
    `12-1ヶ月モメンタム: ${pct(row.momentum)}`,
    `6ヶ月相対強度(対ベンチマーク): ${pct(row.relStrength)}`,
    `60日ボラティリティ: ${pct(row.vol)}`,
    ...(variant === "v2" ? [`20日リターン: ${pct(row.ret20 ?? null)}`, `52週高値からの位置: ${pct(row.fromHigh52 ?? null)}`] : []),
    `定量スコア順位: ${args.rank}位 / ${args.universe}銘柄`,
    "## 直近のイベント (検証済み)",
    ...evLines,
    "## 保有状況",
    posLine,
  ].join("\n");
  return { ticker: row.ticker, text, trend, news, held: Boolean(position) };
}

interface JudgeCtx {
  dossier: Dossier;
  priority: boolean;
}

/** Deterministic checks: did the model read the facts correctly, and are its quotes real? */
export function validateJudgment(j: TradeJudgment, ctx: JudgeCtx): string | null {
  const d = ctx.dossier;
  if (j.stance === "abstain") return null;
  if (j.checklist.trend !== d.trend) return `misread trend: said ${j.checklist.trend}, dossier says ${d.trend}`;
  if (j.checklist.news !== d.news) return `misread news: said ${j.checklist.news}, dossier says ${d.news}`;
  const { ok, failed } = checkEvidence(j.evidence, d.text);
  if (!ok) return `ungrounded evidence: ${failed.length ? failed.join(" | ") : "none given"}`;
  if ((j.stance === "bullish" || j.stance === "bearish") && j.invalidation.length === 0) return "no invalidation condition";
  return null;
}

export function mergeJudgments(group: TradeJudgment[]): TradeJudgment {
  const first = group[0]!;
  return {
    ...first,
    conviction: Math.min(...group.map((g) => g.conviction)),
    invalidation: [...new Set(group.flatMap((g) => g.invalidation))].slice(0, 3),
    evidence: [...new Set(group.flatMap((g) => g.evidence))].slice(0, 3),
  };
}

export interface JudgeOptions {
  quorum?: number;
  escalation?: LLMProvider | undefined;
  /** Single model that may veto a bullish consensus (blocking is easier than buying). */
  redTeam?: LLMProvider | undefined;
  vetoSeverity?: number;
  promptVersion?: JudgePromptVersion;
  redTeamVersion?: RedTeamPromptVersion;
}

export class Judge {
  readonly #ensemble: Ensemble<typeof TradeJudgment, JudgeCtx>;
  readonly #caller: StructuredCaller;
  readonly #redTeam: LLMProvider | undefined;
  readonly #vetoSeverity: number;
  readonly version: JudgePromptVersion;
  readonly redTeamVersion: RedTeamPromptVersion;

  constructor(caller: StructuredCaller, members: readonly LLMProvider[], opts: JudgeOptions = {}) {
    this.#caller = caller;
    this.version = opts.promptVersion ?? JUDGE_PROMPT_VERSION;
    this.redTeamVersion = opts.redTeamVersion ?? RED_TEAM_PROMPT_VERSION;
    this.#redTeam = opts.redTeam;
    this.#vetoSeverity = opts.vetoSeverity ?? 2;
    this.#ensemble = new Ensemble({
      caller, members, schema: TradeJudgment,
      key: (j) => j.stance,
      merge: mergeJudgments,
      validate: validateJudgment,
      quorum: opts.quorum ?? 2,
      escalation: opts.escalation,
      shouldEscalate: (vals, ctx) => ctx.priority || vals.some((v) => v.stance === "bullish"),
    });
  }

  async judge(dossier: Dossier, priority: boolean): Promise<Judgment> {
    const res = await this.#ensemble.run(
      { schemaName: "TradeJudgment", system: JUDGE_PROMPTS[this.version].system, user: dossier.text, promptVersion: this.version },
      { dossier, priority },
    );
    const votes = res.votes.map((v) => ({ provider: v.provider, stance: v.value?.stance ?? null, rejected: v.rejected }));
    const v = res.value;
    const out: Judgment = {
      ticker: dossier.ticker,
      // no consensus => abstain: "迷ったら何もしない"
      stance: v?.stance ?? "abstain",
      conviction: v?.conviction ?? 0,
      status: res.status,
      agreement: res.agreement,
      thesis: v?.thesis ?? "",
      invalidation: v?.invalidation ?? [],
      evidence: v?.evidence ?? [],
      vetoReason: null,
      votes,
    };
    if (out.stance === "bullish" && this.#redTeam) {
      const veto = await this.#redTeamCheck(dossier);
      if (veto) return { ...out, stance: "neutral", status: "vetoed", vetoReason: veto };
    }
    return out;
  }

  /** Returns a veto reason, or null. Fail-safe: if the check itself fails, veto. */
  async #redTeamCheck(d: Dossier): Promise<string | null> {
    const r = await this.#caller.call(this.#redTeam!, RedTeamFinding, {
      schemaName: "RedTeamFinding", system: RED_TEAM_PROMPTS[this.redTeamVersion].system, user: `# 反証の依頼\n${d.text}`, promptVersion: this.redTeamVersion,
    });
    if (!r.value) return `red team unavailable (${r.error ?? "no value"})`;
    const f = r.value;
    if (!f.found || f.severity < this.#vetoSeverity) return null;
    // a veto must be grounded too — fabricated objections are ignored
    return checkEvidence(f.evidence, d.text).ok ? `red team (severity ${f.severity}): ${f.reason}` : null;
  }
}


