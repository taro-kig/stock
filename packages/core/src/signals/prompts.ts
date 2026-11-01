import type { Document } from "./models.ts";

/** Bump whenever wording changes: it is part of the cache key and of evaluation records. */
export const EVENT_PROMPT_VERSION = "event-v1";

export const EVENT_SYSTEM = `あなたは株式アナリストの補助として、ニュースや適時開示を構造化データに変換する。
売買の推奨はしない。与えられた文書に書かれている事実だけを使う。

規則:
- 文書に書かれていないことを推測で補わない。自分の知識で株価の結末を補わない。
- tickers は必ず「候補銘柄」の中から選ぶ。該当がなければ relevant=false。
- evidence には文書中の文章を一字一句そのまま (10〜80文字程度) 引用する。要約や言い換えは禁止。
- 宣伝・まとめ記事・株価が動いたことだけを伝える記事は materiality を低くする。
- 判断できない場合は relevant=false, eventType="none", direction=0 とする。`;

export function eventUserPrompt(doc: Document, candidates: Record<string, string>): string {
  const cand = Object.entries(candidates)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([code, name]) => `- ${code}: ${name}`)
    .join("\n");
  return `# 候補銘柄\n${cand}\n\n# 文書\n情報源: ${doc.source}\n公開日時: ${doc.publishedAt ?? "不明"}\nタイトル: ${doc.title}\n本文:\n${doc.body.slice(0, 6000)}`;
}
