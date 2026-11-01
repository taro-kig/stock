# 米国株で動かす

既定の設定（`config/config.example.yaml`）とワークフロー（`daily-ai` / `daily-rules` / `webull-us` / `ibkr-paper`）は米国株用。
日本株は `config/config.jp.example.yaml` と `daily-jp-ai` / `daily-jp-rules` / `webull-jp`（価格は J-Quants、記録は `data/jp` に分けて保存）。

## 使う情報源

| 種類 | ノード | 内容 | 必要なもの |
|---|---|---|---|
| 日足 | `data.pricesTwelveData` | [Twelve Data](https://twelvedata.com/) の日足（分割調整済み）。**ローカル（SQLite）に保存**し、2回目以降は直近の数本だけ取得。過去日付の再生はネット不要 | 無料の API キー（`TWELVEDATA_API_KEY`）。無料プラン: 800 回/日・8 回/分 |
| 開示 | `source.secFilings` | [SEC EDGAR](https://www.sec.gov/edgar) の 8-K（ウォッチリストの銘柄）。Item の説明と、本文・プレスリリース（EX-99.1）のテキスト | `SEC_USER_AGENT`（名前と連絡先メール。SEC の利用条件で必須）。キーは不要・無料 |
| ニュース | `source.rss` | 英語の RSS（`config.sources`。例は Yahoo Finance と Google News） | なし |

キーは Web UI の **「7 設定」** で入れる（または `npm run stockai -- settings set TWELVEDATA_API_KEY`）。

### 回数の目安

- ウォッチリスト 11 銘柄 + ベンチマーク (SPY) = 1 日 12 回程度。無料枠（800 回/日）に十分収まる
- 8 回/分の制限に合わせて自動で間隔を空ける（12 銘柄で約 1.5 分）。同じ日の 2 本目のワークフロー（`daily-ai`）はノードのキャッシュを使うので取得しない
- 初回だけ約 1000 営業日分（4 年）を取得する。分割で過去の値が変わったときは自動で全期間を取り直す

### 時点管理（未来の情報を使わない）

- 価格: その日以前の足だけを渡す。米国の取引終了（UTC 20:00〜21:00）の後に取得した場合だけ、その日の足を確定とみなす
- SEC: EDGAR が **受理した時刻** から使う（`acceptanceDateTime` をニューヨーク時間として UTC に直す。誤っていても「遅く知った」側にずれるだけで、先読みにはならない）
- 実行日（`asOf`）は UTC の日付。日本時間の朝に動かすと、直前に閉じた米国の取引日になる

## 1日の流れ

```yaml
# config.example.yaml の schedule（サーバーの現地時間 = 日本時間を想定）
schedule:
  - { workflow: workflows/daily-rules.yaml, at: "06:40", days: [2, 3, 4, 5, 6] }   # 火〜土の朝
  - { workflow: workflows/daily-ai.yaml, at: "06:45", days: [2, 3, 4, 5, 6] }
```

1. 06:40 ルールのベースライン（価格・ニュース・開示・イベント抽出をここで済ませる）
2. 06:45 AI の判断（同じノードはキャッシュを使う）→ 承認待ち
3. 朝のうちに「3 承認」で確認。承認するとペーパー口座（$100,000）で約定
4. 米国の祝日は価格が増えないだけで、判断は前営業日のデータで行われる

## 設定の要点

| 項目 | 米国株 | 日本株 |
|---|---|---|
| `market.currency` / `benchmark` | `USD` / `SPY` | `JPY` / `1306` |
| `risk.lotSize` | 1 | 100 |
| `prompts.event` | `event-us-v1`（英語の 8-K・ニュース用） | `event-v1` / `event-v2` |
| 呼値 | $0.01 | 東証の呼値刻み |
| ブローカー | `webull.market: us` / `ibkr.market: us` | `jp` |

ウォッチリストの `name` と `aliases` はニュースの本文と単語単位で照合する（"Apple" は "Pineapple" には当たらない）。
SEC の銘柄は SEC のティッカー一覧から CIK を引く。見つからない銘柄は `source.secFilings` の `ciks: { TICKER: 1234567 }` で指定する。

## まだ確認できていないこと

この開発環境からは Twelve Data・SEC・ニュースサイトに接続できなかったため、**応答の形式は公開ドキュメントとモックで確認しただけ**。最初の実行で次を確認する:

- [ ] `npm run stockai -- run workflows/daily-rules.yaml` で `prices` ノードが `full=12` になり、`show` で終値が妥当
- [ ] 2回目の実行で `update` になる（差分取得）
- [ ] `filings` ノードで直近の 8-K が取れる（決算期なら Item 2.02）。SEC が 403 を返す場合は `SEC_USER_AGENT` を見直す
- [ ] RSS の URL が生きているか（`news` ノードの `feedsFailed`）
- [ ] `npm run stockai -- eval events --models gemini-lite` で `event-us-v1` の正解率を見る
