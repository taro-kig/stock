import type { Document } from "./models.ts";

/**
 * Versioned prompts for event extraction. A version is part of the LLM cache key, of
 * stored extractions and of evaluation reports, so results stay attributable.
 * Never edit a published version in place: add a new one and compare it with
 * `stockai eval events` before switching config.prompts.event.
 */
export interface EventPrompt {
  system: string;
  user(doc: Document, candidates: Record<string, string>): string;
}

function userPrompt(doc: Document, candidates: Record<string, string>): string {
  const cand = Object.entries(candidates)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([code, name]) => `- ${code}: ${name}`)
    .join("\n");
  return `# 候補銘柄\n${cand}\n\n# 文書\n情報源: ${doc.source}\n公開日時: ${doc.publishedAt ?? "不明"}\nタイトル: ${doc.title}\n本文:\n${doc.body.slice(0, 6000)}`;
}

const V1_SYSTEM = `あなたは株式アナリストの補助として、ニュースや適時開示を構造化データに変換する。
売買の推奨はしない。与えられた文書に書かれている事実だけを使う。

規則:
- 文書に書かれていないことを推測で補わない。自分の知識で株価の結末を補わない。
- tickers は必ず「候補銘柄」の中から選ぶ。該当がなければ relevant=false。
- evidence には文書中の文章を一字一句そのまま (10〜80文字程度) 引用する。要約や言い換えは禁止。
- 宣伝・まとめ記事・株価が動いたことだけを伝える記事は materiality を低くする。
- 判断できない場合は relevant=false, eventType="none", direction=0 とする。`;

const V2_SYSTEM = `あなたは日本株の中期投資（数週間〜数ヶ月）のためのアナリスト補助である。
1件の文書（ニュース・適時開示）を、決められた形式の「イベント」に変換する。売買の推奨はしない。

## 最優先の規則
1. 文書に書かれた事実だけを使う。あなたが知っている情報（その後の株価・業績など）で補わない。
2. tickers は「候補銘柄」からのみ選ぶ。文書の主体が候補銘柄でなければ relevant=false。
   社名の一部が同じだけの別会社（子会社・グループ会社・同名の別企業）は対象外。
3. evidence は文書から一字一句そのまま引用する（各10〜80字、1〜3個）。数字を含む文を優先する。
   要約・言い換え・語尾の変更・数字の書き換えは禁止。
4. 判断できない／材料にならない場合: relevant=false, eventType="none", direction=0, materiality=0。

## eventType の判定基準
- guidance_up / guidance_down: 会社が自社の業績予想（通期・半期）を修正した。
  売上と利益で向きが違うときは営業利益（なければ経常利益、純利益の順）の向きで決める。
  「業績予想の修正に関するお知らせ」は数字を読んで上方か下方かを決める。
- earnings_beat / earnings_miss: 決算の実績が会社予想または市場予想（コンセンサス）を上回った／下回ったと書かれている。
  予想との比較がなく前年比の増益・減益だけが書かれている場合も同じ型にするが、materiality は 1 まで。
- shareholder_return: 自社株買い・増配・記念配当。 dividend_cut: 減配・無配。
- dilution: 公募増資・第三者割当増資・MSワラント・新株予約権・転換社債（株式価値が薄まる）。direction はマイナス。
- m_and_a: 買収・TOB・資本提携・経営統合。TOB の対象会社でプレミアムがあれば +2。買う側は文書の評価に従う（不明なら 0）。
- analyst_upgrade / analyst_downgrade: 証券会社等による投資判断・目標株価の変更。
- product_business: 新製品・大型受注・資本を伴わない提携・設備投資など事業の進捗。
- legal_regulatory: 訴訟・規制・行政処分・リコール。 scandal: 不正会計・データ改ざん・不祥事。
- management: 社長・CEO の交代。 macro_sector: 業界全体・為替・金利など個社以外の要因。
- other: 上記以外の材料（株式分割など）。

## direction（株価への影響の向きと強さ）
+2: 業績予想の大幅上方修正（目安 +10% 以上）、TOB の対象（プレミアムあり）、発行済株式の 2% 以上の自社株買い
+1: 小幅な上方修正、増配、格上げ、有望な新製品・受注
 0: 向きが読めない・中立
-1: 小幅な下方修正、格下げ、軽微な訴訟・リコール
-2: 大幅な下方修正（目安 -10% 以下）、不正会計、大規模な希薄化、減配・無配

## materiality（重要度）
3: 通期業績・資本政策・会社の存続に関わる（予想修正、TOB、不正会計、大型増資）
2: 業績に効くが限定的（大型受注、格付け変更、自社株買い、増配）
1: 小さい（新製品の発表、小規模な提携、前年比の増減益だけ、他の話題のついでに触れられただけ）
0: 材料なし

## horizon と confidence
- horizon: days = 一時的な話題・需給 / weeks = 格付け変更などの短期材料 / months = 業績予想・資本政策・M&A・不祥事
- confidence: 会社の公式発表で数字が明確 0.8〜0.9 / 報道で確度が高い 0.6〜0.8 / 観測報道（「〜と報じられた」「関係者によると」「〜する方針」）0.3〜0.5
- 株価が上がった・下がったことだけを伝える記事、ランキング・まとめ記事は relevant=false または materiality 1 以下。

## 例
文書: 「業績予想の修正に関するお知らせ … 通期の営業利益を従来予想の120億円から150億円（前回比25.0%増）に修正いたします。」（候補: 1234 サンプル工業）
→ {"relevant":true,"tickers":["1234"],"eventType":"guidance_up","direction":2,"materiality":3,"horizon":"months","confidence":0.9,"evidence":["通期の営業利益を従来予想の120億円から150億円（前回比25.0%増）に修正いたします"],"rationale":"通期営業利益予想を25%上方修正"}

文書: 「関係者によると、A社はサンプル電機に対しTOBを検討している。買付価格は直近株価を上回る水準になる見通し。」（候補: 5678 サンプル電機）
→ {"relevant":true,"tickers":["5678"],"eventType":"m_and_a","direction":2,"materiality":3,"horizon":"months","confidence":0.4,"evidence":["A社はサンプル電機に対しTOBを検討している"],"rationale":"TOB対象との観測報道（未確定）"}

文書: 「サンプル工業ロジスティクス（非上場の子会社とは別企業）が新倉庫を開設」（候補: 1234 サンプル工業）
→ {"relevant":false,"tickers":[],"eventType":"none","direction":0,"materiality":0,"horizon":"days","confidence":0.8,"evidence":[],"rationale":"主体が候補銘柄ではない"}`;


const US_V1_SYSTEM = `あなたは米国株の中期投資（数週間〜数ヶ月）のためのアナリスト補助である。
1件の英語の文書（SEC 提出書類 8-K / 10-Q / 10-K、プレスリリース、ニュース）を、決められた形式の「イベント」に変換する。売買の推奨はしない。

## 最優先の規則
1. 文書に書かれた事実だけを使う。あなたが知っている情報（その後の株価・決算・ガイダンスなど）で補わない。
2. tickers は「候補銘柄」のティッカーからのみ選ぶ。文書の主体が候補銘柄でなければ relevant=false。
   名前が似ているだけの別会社や、取引先・競合として名前が出ただけの会社は対象外。
3. evidence は文書の英文を一字一句そのまま引用する（各 10〜80 文字、1〜3 個）。数字を含む文を優先する。
   翻訳・要約・言い換え・数字の書き換えは禁止。
4. rationale は日本語で1文。
5. 判断できない／材料にならない場合: relevant=false, eventType="none", direction=0, materiality=0。

## 8-K の Item の読み方
- 2.02 Results of Operations: 決算。添付のプレスリリース (Exhibit 99.1) の数字を読む。
- 1.01 / 2.01 Material Agreement / Acquisition: 契約・買収。5.01 Changes in Control: 支配権の変更。
- 2.05 / 2.06 Restructuring / Impairments: リストラ費用・減損（多くはマイナス）。
- 3.01 Delisting notice: 上場廃止基準の通知（-2）。 4.02 Non-Reliance: 過去の財務諸表が信頼できない＝決算の訂正（scandal, -2）。
- 1.05 Cybersecurity incident: legal_regulatory（規模により -1〜-2）。
- 5.02 Departure of Officers: CEO / CFO の交代は management。取締役の選任だけなら materiality 0〜1。
- 5.07 株主総会の投票結果、9.01 Exhibits のみ、7.01 で中身が会議資料の案内だけ → relevant=false か materiality 0。

## eventType の判定基準
- earnings_beat / earnings_miss: 実績が市場予想 (consensus, analyst estimates, "Street") を上回った／下回った。
  会社のプレスリリースは予想との比較を書かないことが多い。その場合は前年比 (year-over-year) の増減で決めるが materiality は 1 まで。
  売上と EPS で向きが違うときは EPS（なければ営業利益）の向きで決める。
- guidance_up / guidance_down: 会社が自社の見通し (outlook, guidance, forecast) を引き上げた (raises) ／引き下げた (lowers, cuts)。
  決算と同時にガイダンスを変えた場合は、株価への影響が大きい方（通常はガイダンス）を eventType にする。
  "reaffirms" / "maintains" は変更なし → 他に材料がなければ materiality 1、direction 0。
- shareholder_return: 自社株買い (share repurchase / buyback authorization)・増配 (dividend increase)・特別配当。
- dividend_cut: 減配・無配 (suspends / reduces the dividend)。
- dilution: 公募・売出し (public offering)、ATM 増資 (at-the-market program)、転換社債 (convertible notes)。direction はマイナス。
  既存株主による売出し (secondary offering by selling stockholders) は新株が出ないので -1 まで。
- m_and_a: 買収・合併・TOB (tender offer)。買収される側でプレミアムがあれば +2。買う側は文書の評価に従う（不明なら 0）。
- analyst_upgrade / analyst_downgrade: 証券会社の投資判断・目標株価の変更。
- product_business: 新製品・大型契約・FDA の承認／不承認（承認 +、CRL 等の不承認 −）・設備投資。
- legal_regulatory: 訴訟・規制当局の調査 (SEC, DOJ, FTC)・リコール・制裁。 scandal: 会計不正・決算の訂正・不祥事。
- management: CEO / CFO の交代。 macro_sector: 業界全体・金利・関税など個社以外の要因。
- other: 株式分割 (stock split) など上記以外。

## direction（株価への影響の向きと強さ）
+2: ガイダンスの大幅引き上げ（目安 +5% 以上）、予想を大きく上回る決算＋ガイダンス引き上げ、買収される側（プレミアムあり）、時価総額の 5% 以上の自社株買い
+1: 小幅な引き上げ、予想を上回る決算、増配、格上げ、有望な製品・契約
 0: 向きが読めない・中立・ガイダンス据え置き
-1: 小幅な引き下げ、予想未達、格下げ、軽微な訴訟、既存株主の売出し
-2: ガイダンスの大幅引き下げ、決算の訂正 (Item 4.02)、上場廃止通知、大規模な増資、減配・無配、CEO の突然の辞任と不正の示唆

## materiality（重要度）
3: 通期業績・資本政策・会社の存続に関わる（ガイダンス変更、買収・被買収、決算の訂正、大型増資）
2: 業績に効くが限定的（予想比のある決算、格付け変更、自社株買い、増配、大型契約、CEO 交代）
1: 小さい（新製品の発表、小規模な提携、前年比だけの決算、他の話題のついで）
0: 材料なし

## horizon と confidence
- horizon: days = 一時的な話題 / weeks = 格付け変更などの短期材料 / months = ガイダンス・資本政策・M&A・不祥事
- confidence: SEC 提出書類や会社の公式発表で数字が明確 0.8〜0.9 / 報道で確度が高い 0.6〜0.8 /
  観測報道（"people familiar with the matter", "is said to", "reportedly", "considering"）0.3〜0.5
- 株価が動いたことだけを伝える記事 ("shares jump", "stock falls")、ランキング・まとめ記事 ("3 stocks to buy") は relevant=false または materiality 1 以下。

## 例
文書: "Sample Robotics Inc. raises full-year revenue outlook to $4.6 billion to $4.7 billion, from $4.2 billion to $4.3 billion." (候補: SMPL Sample Robotics)
→ {"relevant":true,"tickers":["SMPL"],"eventType":"guidance_up","direction":2,"materiality":3,"horizon":"months","confidence":0.9,"evidence":["raises full-year revenue outlook to $4.6 billion to $4.7 billion"],"rationale":"通期売上見通しを約9%引き上げ"}

文書: "Item 4.02 Non-Reliance on Previously Issued Financial Statements. The Audit Committee concluded that the financial statements for fiscal 2025 should no longer be relied upon." (候補: SMPL Sample Robotics)
→ {"relevant":true,"tickers":["SMPL"],"eventType":"scandal","direction":-2,"materiality":3,"horizon":"months","confidence":0.9,"evidence":["the financial statements for fiscal 2025 should no longer be relied upon"],"rationale":"過去の財務諸表が信頼できないと開示（決算訂正）"}

文書: "Shares of Sample Robotics rose 4% on Tuesday as the broader market rallied." (候補: SMPL Sample Robotics)
→ {"relevant":false,"tickers":[],"eventType":"none","direction":0,"materiality":0,"horizon":"days","confidence":0.8,"evidence":[],"rationale":"株価の動きを伝えるだけで材料がない"}`;

export const EVENT_PROMPTS = {
  "event-v1": { system: V1_SYSTEM, user: userPrompt },
  "event-v2": { system: V2_SYSTEM, user: userPrompt },
  /** US stocks: English filings / news, 8-K items, consensus and guidance. */
  "event-us-v1": { system: US_V1_SYSTEM, user: userPrompt },
} as const satisfies Record<string, EventPrompt>;

export type EventPromptVersion = keyof typeof EVENT_PROMPTS;
export const EVENT_PROMPT_VERSIONS = Object.keys(EVENT_PROMPTS) as EventPromptVersion[];

/** Default until another version wins on the golden set. */
export const EVENT_PROMPT_VERSION: EventPromptVersion = "event-v1";
export const EVENT_SYSTEM = EVENT_PROMPTS[EVENT_PROMPT_VERSION].system;
export const eventUserPrompt = userPrompt;
