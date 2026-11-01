import { z } from "zod";
import { sha256 } from "../util/hash.ts";

export const DocumentSchema = z.object({
  source: z.string(),
  url: z.string(),
  title: z.string(),
  body: z.string().default(""),
  publishedAt: z.iso.datetime({ offset: true }).nullable().default(null),
  /** When *we* learned about it (point-in-time key for backtests and grading). */
  fetchedAt: z.iso.datetime({ offset: true }),
  /** Prior reliability of the source (DESIGN §3). */
  sourceWeight: z.number().min(0).default(1),
  /** Other sources that carried the same story (filled by dedup; used for corroboration). */
  alsoSeenIn: z.array(z.string()).default([]),
});
export type Document = z.output<typeof DocumentSchema>;

export const docText = (d: Pick<Document, "title" | "body">): string => `${d.title}\n${d.body}`.trim();
export const docHash = (d: Pick<Document, "title" | "body">): string => sha256(docText(d));

export const EVENT_TYPES = [
  "earnings_beat", // 決算が予想超え
  "earnings_miss", // 決算が予想未達
  "guidance_up", // 業績予想の上方修正
  "guidance_down", // 業績予想の下方修正
  "shareholder_return", // 自社株買い・増配
  "dividend_cut", // 減配・無配
  "dilution", // 公募増資・MSワラント・CB
  "m_and_a", // 買収・TOB・提携
  "analyst_upgrade",
  "analyst_downgrade",
  "product_business", // 新製品・受注・事業進捗
  "legal_regulatory", // 訴訟・規制・行政処分
  "scandal", // 不祥事・不正会計
  "management", // 経営陣の交代
  "macro_sector", // 業界・マクロ要因
  "other",
  "none", // 関連なし
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export const EventExtraction = z.object({
  relevant: z.boolean().describe("候補銘柄の株価に中期的に関係する情報か"),
  tickers: z
    .array(z.string())
    .default([])
    .describe("影響を受ける銘柄コード (候補銘柄から選ぶ)")
    .transform((ts) => [...new Set(ts.map((t) => t.trim().toUpperCase()).filter(Boolean))].sort()),
  eventType: z.enum(EVENT_TYPES),
  direction: z.number().int().min(-2).max(2).describe("株価への影響: -2 強い悪材料 … +2 強い好材料"),
  materiality: z.number().int().min(0).max(3).describe("重要度 0:些末 … 3:業績・株価を大きく動かす"),
  horizon: z.enum(["days", "weeks", "months"]).describe("影響が続く期間の目安"),
  confidence: z.number().min(0).max(1),
  evidence: z.array(z.string()).max(3).default([]).describe("判断根拠となる原文の一字一句そのままの引用 (1〜3個)"),
  rationale: z.string().max(300).default("").describe("判断理由を1文で"),
});
export type EventExtraction = z.output<typeof EventExtraction>;

/** An accepted (consensus + grounded) event, as stored and consumed downstream. */
export interface EventRecord {
  docHash: string;
  title: string;
  url: string;
  source: string;
  /** ISO datetime we learned it (never use it before this instant). */
  learnedAt: string;
  agreement: number;
  sourceWeight: number;
  nSources: number;
  event: EventExtraction;
}
