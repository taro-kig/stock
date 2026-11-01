# 調査: 発注 API を持つ証券会社 (2026-11 時点)

> **決定 (2026-11):** IBKR（TWS API + IB Gateway、[../ibkr.md](../ibkr.md)）を実装済み。口座開設が投資経験の条件で保留になったため、**ウィブル証券（Webull Japan OpenAPI、[../webull.md](../webull.md)）を2つ目のブローカーとして追加**。どちらもワークフローのノードとして差し替えられる。

本システムは「中期・日次バッチ・寄付/引けの指値や成行」で足りるため、速度より
**(1) 公式 API があるか (2) クラウド/Linux から動かせるか (3) 検証環境 (4) 対象市場** を重視して比較した。

> 注: この調査環境からは各社公式サイトを直接開けなかった (ネットワーク制限)。検索結果経由で確認した内容であり、
> 「未確認」の項目は実装前に公式ドキュメントで確認すること。

## 比較

| 証券会社 | API | 日本株 | 米国株 | 動かし方 | 費用・条件 | 検証環境 |
|---|---|---|---|---|---|---|
| 三菱UFJ eスマート証券 (旧 auカブコム) | kabuステーションAPI (REST + PUSH) | 現物・信用 (+先物OP) | ✕ | **Windows 専用アプリ kabuステーションを起動した PC 上の localhost** | 無料。Professional プラン以上が必要 = 信用 or 先物OP口座 + 直近約3ヶ月で約定1回以上 (初回利用時は翌々月第1営業日まで自動適用) | 検証用エンドポイントあり (要確認) |
| 立花証券 e支店 | e支店API (HTTP, JSON) | 現物・信用 | ✕ | **サーバーから直接 HTTP** (クラウド可) | 無料。口座開設が前提 | **デモ環境あり** |
| ウィブル証券 (Webull Japan) | Webull OpenAPI (REST/SDK, CLI, MCP Server) | **現物のみ** (2025-08〜、通常取引時間のみ、単元未満不可) | 現物・信用・オプション買い | **サーバーから直接** (クラウド可) | 利用申請・審査あり。API キーの初期有効期間 45 日 | 未確認 |
| インタラクティブ・ブローカーズ証券 | TWS API / Web(REST) API | 対応 (東証。1株単位発注との報告あり・未確認) | 対応 (+世界各国) | TWS または IB Gateway を常駐 (Linux 可) | API 利用は無料とされる (要確認)。日本株手数料 0.08%・最低80円との記載あり (要確認) | ペーパー口座の提供が一般的 (要確認) |
| moomoo証券 | moomoo OpenAPI (OpenD ゲートウェイ経由) | 未確認 | 対応 | OpenD を PC/クラウドで常駐 | SDK 無料、通常手数料のみ | 模擬取引あり |
| SBI証券 | 先物・オプションのみ (2018〜) | **✕ (個人向けの株式発注 API なし)** | ✕ | — | — | — |
| 楽天証券 | なし (公式 API は確認できず) | ✕ | ✕ | — | — | — |

## 本システムへの当てはまり

- **クラウドで動かす前提なら**: 立花証券 / Webull / IBKR(Gateway 常駐) が素直。kabuステーションは Windows PC (または Windows VPS) の常時起動が必要で、実行環境の選択 (未決事項 4) を縛る。
- **日本株だけなら**: 立花証券 (無料・デモ環境・現物/信用) が第一候補。信用取引を使い、Windows 機を用意できるなら kabuステーションAPI (利用者・情報が最も多い)。
- **日本株 + 米国株を 1 本の API で**: Webull Japan (日本株は現物のみ) か IBKR (対象市場が最も広い)。
- 中期・現物中心の本設計では信用取引は必須ではないため、Webull の「日本株は現物のみ」は大きな制約にならない。
- エンジン側はブローカーを `broker.*` ノードとして差し替える設計なので、まず 1 社で始めて後から追加できる。ペーパー段階 (Phase 2〜4) ではブローカー API は不要。

## 実装前に確認すること

- 立花: v4r10 の認証方式 (二段階認証・電話認証の有無と自動化の可否)、版の廃止サイクル (v4r9 は 2026-09-27 廃止予定と告知)
- kabu: 検証環境の仕様、アプリのログイン自動化の可否、レート制限
- Webull: 日本株の注文種別 (指値/成行/逆指値)、API キー更新手順、デモ環境の有無
- IBKR: 日本居住者口座での API 利用条件、東証の発注単位、ペーパー口座
- 共通: API 利用規約で「自作プログラムによる自動発注」が明示的に許可されていること

## 出典

- [kabuステーション®API (三菱UFJ eスマート証券)](https://kabu.com/item/kabustation_api/default.html)
- [kabuステーション®APIの利用条件 (FAQ)](https://faq.kabu.com/s/article/k002519) / [料金 (FAQ)](https://faq.kabu.com/s/article/k002520)
- [kabuステーション 利用料金無料化・適用条件緩和 (2024-04-30)](https://kabu.com/company/pressrelease/20240430_4.html)
- [Professionalプラン (マニュアル)](https://kabu.com/kabustation/manual/fintechplan01.html)
- [立花証券ｅ支店 APIサービス](https://www.e-shiten.jp/api/) / [API最新バージョンのお知らせ](https://www.e-shiten.jp/api/20260728.html)
- [Webull Open APIの範囲 (FAQ)](https://www.webull.co.jp/help/faq/1728) / [日本株現物取引API提供開始 (PR TIMES)](https://prtimes.jp/main/html/rd/p/000000035.000131836.html) / [Webull Japan Open API](https://www.webull.co.jp/open-api)
- [IBKR Trading API Solutions (日本)](https://www.interactivebrokers.co.jp/jp/index.php?f=50761) / [IB API](https://www.interactivebrokers.co.jp/jp/trading/ib-api.php)
- [moomoo OpenAPI ガイド](https://www.moomoo.com/jp/learn/python-openapi-guide-for-us-stocks)
- [SBI証券 先物・オプションAPI提供開始 (2018)](https://www.sbigroup.co.jp/news/pr/2018/0502_11078.html)
- [証券会社のAPI比較 (証券会社比較なび)](https://crexgroup.com/ja/sec/knowledge-license/securities-company-api-guide/)

## 追記: 海外の証券会社を直接使う場合

| 候補 | 日本居住者 | API | 備考 |
|---|---|---|---|
| Interactive Brokers (海外法人 IB LLC) | **新規は日本法人 IBSJ に振り分け** (IB LLC は日本居住者不可とされる) | — | 実質「IBKR = IBSJ」。IBSJ は国内登録業者なので税・保護は国内扱い |
| Alpaca | 国際口座を開ける可能性あり (公式の国別一覧なし・要問合せ) | ◎ 開発者向け REST、無料のペーパー口座 | 米国株のみ。米国法・ドル建て・W-8BEN。日本法人 AlpacaJapan は事業者向けインフラ |
| Firstrade | 開設できるとの情報が多い | ✕ 公開の発注 API なし | 英語/中国語サポートのみ |
| Charles Schwab | 日本居住者は原則不可とされる | — | |

海外の未登録業者を使う場合の注意:
- 日本居住者を相手に取引業を行うには原則として金融商品取引法の登録が必要。未登録業者は日本の投資者保護の対象外で、トラブル時は外国法で争うことになる
- 税金は自分で確定申告。国内の特定口座・NISA は使えない。損失の繰越控除などの扱いが国内業者経由と異なる場合がある (要税理士確認)
- 年末の国外財産が 5,000 万円超なら国外財産調書が必要。CRS により海外口座情報は国税庁に共有される
- 送金・為替の手数料、米国源泉税 (配当)、相続時の手続きの煩雑さ

### 追加出典
- [Alpaca: 非米国居住者のライブ口座開設](https://alpaca.markets/learn/live-trading-account-non-us) / [Is Alpaca Trading Available in Japan? (BrokerChooser)](https://brokerchooser.com/broker-reviews/alpaca-trading-review/alpaca-trading-japan)
- [IBKR Japan](https://www.interactivebrokers.co.jp/en/index.php?f=50707) / [IB LLC から IBSJ への移管 FAQ](https://ibkb.interactivebrokers.com/ja/node/4739)
- [海外証券会社の選び方 (soico)](https://www.soico.jp/no1/news/securities/6787) / [Firstrade 口座開設 (ブログ)](https://www.nomadkazoku.com/firstrade-account-opening/)
- [無登録で金融商品取引業等を行う者について (関東財務局)](https://lfb.mof.go.jp/kantou/rizai/pagekthp032000222.html)
