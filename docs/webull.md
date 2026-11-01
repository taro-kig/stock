# ウィブル証券 (Webull Japan) 接続ガイド

IBKR の実装はそのまま残し、ウィブル証券を **2つ目のブローカー** として追加した（`portfolio.webullAccount` / `broker.webull`、`workflows/webull-us.yaml`（米国株）/ `workflows/webull-jp.yaml`（日本株））。

## できること・できないこと

| | 内容 |
|---|---|
| 日本株 | 現物のみ・通常取引時間のみ・単元未満株は不可（ウィブル証券 FAQ）。本システムの中期・現物運用には足りる |
| 米国株 | API は対応。`webull.market: us` で切替（ティッカー・為替・税の扱いは未検証） |
| ペーパー口座 | **なし**。代わりに既定の `trading: dry_run` では Webull の「注文プレビュー」API で注文を検証するだけで、発注しない |

## 実装の根拠

公式の Node.js SDK は無いので、TypeScript で直接実装した（`packages/core/src/execution/webull.ts`）。

| 項目 | 根拠 |
|---|---|
| エンドポイント `api.webull.co.jp`、パス、`x-version: v3` | 公式 Python SDK `webull-openapi-python-sdk` 3.0.4（PyPI）のソース |
| 署名（HMAC-SHA256、ヘッダとクエリを並べて厳格 URL エンコード、本文の SHA-256、鍵は `secret + "&"`） | 同 SDK の `default_signature_composer.py`。標準ライブラリだけで書いた独立の参照実装と同じ値になることをテストで確認 |
| アクセストークン（2FA）: `/openapi/config` → `/auth/tokens/create` → アプリで承認 → `/auth/tokens/check` | 同 SDK の `token_manager.py` |
| 残高・保有のフィールド（`total_cash_balance`, `total_market_value`, `symbol`, `quantity`, `cost_price` …）、日本株注文の必須項目（`account_tax_type` = `SPECIFIC` / `GENERAL`）、注文応答 `{client_order_id, order_id}` | 公式 MCP サーバー `webull-openapi-mcp` 1.2.6（PyPI）のソース |

> ウィブル証券の開発者サイト（developer.webull.co.jp）はこの開発環境から開けなかったため、実際の口座での確認が必要（下のチェックリスト）。

## 手順

1. ウィブル証券で口座を開設する
2. 開発者サイトで **API の利用申請**（個人）→ 審査後にアプリを作成し **App Key / App Secret** を発行（発行時に SMS 認証と取引パスワード）。**API キーの初期有効期間は 45 日**なので、期限前の更新を忘れないこと
3. キーを Web UI の「7 設定」画面で `WEBULL_APP_KEY` / `WEBULL_APP_SECRET` に入れる（CLI なら `npm run stockai -- settings set WEBULL_APP_KEY`）。
   証券口座のキーなので、**自宅のマシンだけ**に置き、クラウド環境には入れない

4. `config/config.yaml` の `webull:`（例は `config/config.example.yaml`）

   ```yaml
   webull:
     trading: dry_run          # まずはプレビューのみ
     accountId: "..."          # stockai webull check で表示される ID
     accountTaxType: SPECIFIC  # 特定口座 = SPECIFIC / 一般口座 = GENERAL
     market: us              # 米国株（日本株は jp）
     maxOrderValue: 20000
   ```

5. アクセスの承認（2FA が有効な場合）

   ```bash
   npm run stockai -- webull auth      # Webull アプリに届く承認リクエストを承認する
   npm run stockai -- webull check     # 読み取りのみ: 口座・現金・保有を表示
   ```

   承認済みトークンは `data/webull-token.json`（権限 600、git 管理外）に保存される。期限切れになると実行は `WebullAuthRequired` で止まる（＝注文は出ない）ので、もう一度 `webull auth` を実行する。

6. 実行（`webull-us.yaml` / `webull-jp.yaml` は承認ゲートが manual）

   ```bash
   npm run stockai -- run workflows/webull-us.yaml
   npm run stockai -- approve <runId> approve
   npm run stockai -- resume <runId>      # dry_run: Webull のプレビュー結果が注文票に入る
   ```

   Web UI の「承認」画面からも同じことができる。

7. 本番発注に切り替えるのは、プレビューで問題がないことを確認してから:

   ```yaml
   webull:
     trading: live
     accountId: "..."     # 必須
   ```

   ```bash
   export STOCKAI_LIVE_TRADING=yes-i-understand   # これが無いと止まる
   ```

## 安全装置

| 装置 | 内容 |
|---|---|
| 既定はプレビューのみ | `trading: dry_run` では `/trading/orders/preview` だけを呼ぶ。発注 API は呼ばない |
| 本番の三重ロック | `trading: live` + `accountId` が接続先と一致 + `STOCKAI_LIVE_TRADING=yes-i-understand`。どれか欠ければ口座ノードで停止 |
| 承認ゲート | `webull-jp.yaml` は manual。承認なしでは何も送らない |
| 二重発注防止 | `client_order_id` を「日付・口座・銘柄・売買」から決定的に生成（同じ注文は必ず同じ ID）。送信済みの台帳、Webull の未約定注文、Webull 側の重複 ID 拒否の三重で防ぐ。発注 API は自動リトライしない |
| 指値のみ・呼値に丸め | 成行は使わない。前日終値 ± `limitOffsetBps` を東証の呼値刻みに丸める |
| 上限 | 1注文の金額 (`maxOrderValue`)、1回の注文数 (`maxOrdersPerRun`)、単元の倍数のみ、空売り禁止 |
| 過去日付では送らない | 再生時・承認が翌日にずれた場合は発注しない（古い価格で出さない） |
| 想定外の応答で止まる | 数値でない残高・数量などは推測せずエラーにする |
| 注文 ID は文字列で保持 | Webull の注文 ID は JavaScript の数値で表せる範囲を超えるため |

## 実際の口座で最初に確認すること

- [ ] `stockai webull check` が通る（署名・`x-version`・アクセストークンが受け付けられる）
- [ ] 残高のフィールド名（`total_cash_balance` / `total_market_value`）と通貨（`total_asset_currency=JPY`）
- [ ] 保有の `symbol` が銘柄コード（例 `7203`）で返るか
- [ ] 米国株（`market: us`）: シンボルが `AAPL` 形式で通るか、残高の通貨が USD で返るか、ドル建ての指値（$0.01 刻み）が受け付けられるか
- [ ] 日本株で `order_type: LIMIT` / `time_in_force: DAY` / `support_trading_session: CORE` / `entrust_type: QTY` が受け付けられるか（プレビューで確認）
- [ ] 指値が呼値刻みでないときの扱い、100 株単位の扱い
- [ ] 未約定注文一覧に `client_order_id` が入っているか（二重発注防止に使う）
- [ ] 同じ `client_order_id` の再送が拒否されるか
- [ ] アクセストークンの有効期間と、2FA の承認がどのくらいの頻度で必要か
- [ ] API キー（45 日）の更新手順
- [ ] レート制限

## 出典

- 公式 Python SDK: [webull-openapi-python-sdk (PyPI)](https://pypi.org/project/webull-openapi-python-sdk/)
- 公式 MCP サーバー: [webull-openapi-mcp (PyPI)](https://pypi.org/project/webull-openapi-mcp/) / [GitHub](https://github.com/webull-inc/webull-openapi-mcp)
- [Webull Open API の範囲 (FAQ)](https://www.webull.co.jp/help/faq/1728) / [日本株現物取引 API 提供開始](https://prtimes.jp/main/html/rd/p/000000035.000131836.html)
- [個人の利用申請 (開発者サイト)](https://developer.webull.co.jp/apis/docs/authentication/individual-application/) / [Webull CLI](https://developer.webull.co.jp/apis/docs/ai-friendly-resources/cli/)
- [Account balance (開発者サイト)](https://developer.webull.co.jp/api-doc/trade/account/account-balance-v2/) / [Account positions](https://developer.webull.co.jp/api-doc/trade/account/account-positions-v2/)
