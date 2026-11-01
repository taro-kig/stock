# stockai — 安価な LLM で動く中期 AI 株トレーディングシステム

数週間〜数ヶ月保有の **中期売買** を、Gemini Flash-Lite 級などの **安いモデルの組み合わせ** で行うシステム。
**AI が「何を・いつ」売買するかを判断し、決定論的なルールが「いくら・どこまで損するか」を縛る。**
AI に渡す権限は、判断を全件記録して答え合わせした **実測の確度** に応じて段階的に広げる。

設計: **[docs/DESIGN.md](docs/DESIGN.md)** ・ プロンプトと評価: **[docs/prompts.md](docs/prompts.md)**

![overview](docs/images/overview.png)

## 特徴

- **ワークフロー**: 処理は型付きノードのグラフ (`workflows/*.yaml`)。キャッシュ・失敗時の方針・承認待ち/再開・過去日付の再生・全入出力の記録
- **ハーネス**: スキーマ検証 + 再試行 / 原文照合 / 異系統モデルの多数決 / 事実の読み取りチェック / 反対役の拒否権 / キャッシュ / 日次予算
- **確度の計測**: AI とルールのベースラインを並走させ、20営業日後に採点。重なりを除いた実効標本数と Wilson 下限で昇格を判定
- **fail-safe**: 合意なし → 棄権、予算超過・反対役の失敗 → 買わない

## 構成

```
packages/core/src/
  harness/    H1–H5: structured / grounding / ensemble / cache / budget
  llm/        Gemini, OpenAI互換 (DeepSeek/OpenRouter/Groq…), Fake, オフライン用ヒューリスティック
  signals/    RSS, 重複除去, 銘柄辞書, イベント抽出, イベントスコア, テクニカル指標
  ai/         AI 売買判断 (資料作成, 読み取りチェック, 反対役)
  strategy/   ファクター, スコア合成, リスク制限, リバランス提案
  execution/  ペーパー口座, IBKR / ウィブル証券クライアント, 発注前ガード, 注文・ポジション台帳
  eval/       判断の記録と採点 (scorecard)
  workflow/   エンジン (型付きポート, 検証, キャッシュ, 承認, 再生, イベントログ)
  nodes/      組み込みノード (stockai nodes で一覧)
  cli/        CLI
apps/web/     Web UI (React + Vite) と API サーバー (node:http, SSE, 実行キュー, スケジューラ)
workflows/    daily-ai / daily-rules (本番), webull-jp (ウィブル証券), ibkr-paper (IBKR ペーパー口座), demo-ai / demo-rules (オフラインデモ)
deploy/ibkr/  IB Gateway の Docker 構成
config/       config.example.yaml
```

## Web UI

ターミナル風の Web 画面。キーボードだけで操作できる（`?` でキー一覧、`t` で ink / paper テーマ、`u` で値動きの色を日本式 ⇄ 米国式）。

| 画面 | 内容 |
|---|---|
| 1 概要 | 承認待ち・ワークフローの状態と次回実行・口座の推移・確度・LLM コスト |
| 2 実行 | 実行履歴、判断 / 注文 / 約定 / 口座 / 採点、フローのグラフ（ノードごとの状態・計測・エラー） |
| 3 承認 | 注文の一覧と根拠（AI の判断理由・撤回条件）。`a` / `x` を2回押して承認 / 却下 |
| 4 確度 | AI とルールの的中率、95% 下限、実効標本、確信度別、昇格判定 |
| 5 フロー | ワークフローのグラフ、今日 / 過去日付での実行、**ノードエディタ**（`e` 編集 / `n` 新規） |
| 6 ノード | ノードの一覧（ポート型・パラメータ） |

| 承認 | 確度 |
|---|---|
| ![approvals](docs/images/approvals.png) | ![scorecard](docs/images/scorecard.png) |

### ノードエディタ

![editor](docs/images/editor.png)

- 左のパレットからノードをクリック / ドラッグで追加。出力ポート（右）から入力ポート（左）へドラッグして接続。**型が同じポートにしかつながらない**（ドラッグ中、つなげる先だけが光る）。循環もその場で拒否
- 右のインスペクタでノード名（変更すると参照も書き換わる）、パラメータ（ノード定義の JSON Schema からフォームを自動生成）、`onError`、キャッシュ、`after` を編集
- 編集のたびにサーバーで検証し、問題のあるノードに印。問題があっても下書きとして保存できるが、直すまで実行できない
- `Ctrl/⌘+Z` 元に戻す・`Ctrl/⌘+⇧+Z` やり直し・`Ctrl/⌘+S` 保存・`Del` 削除・`l` 自動整列・`f` 全体表示・`Ctrl/⌘+ホイール` 拡大縮小
- 保存先は `workflows/<name>.yaml`（1ノード1行の YAML）。上書き時は直前の版を `.bak` に残す。YAML のコメントは保存時に消える
- 「保存して実行」で実行し、各ノードの状態がキャンバス上でリアルタイムに変わる

```bash
npm run web                     # UI をビルドしてサーバー起動 → http://127.0.0.1:4317
npm run web -- --fake           # API キーなし (疑似モデル)
npm run web:server & npm run web:ui   # 開発: Vite (http://127.0.0.1:5173) + API サーバー
```

- 既定で `127.0.0.1` のみで待ち受ける。他の端末から使う場合は `STOCKAI_WEB_TOKEN` を設定して `--host 0.0.0.0`（トークンなしでは起動を拒否）。初回は `http://host:4317/?token=...` で開く
- 実行はキューで1つずつ処理。進行状況はサーバーからリアルタイムに反映される

## 日次運用（確度の記録）

`config/config.yaml` の `schedule` に書いたワークフローが、Web サーバーの起動中に毎日自動で実行される。

```yaml
schedule:
  - { workflow: workflows/daily-rules.yaml, at: "16:30" }   # 比較用ベースライン（先に実行し、共通ノードをキャッシュ）
  - { workflow: workflows/daily-ai.yaml, at: "16:35" }      # AI 判断（承認ゲートで停止）
```

1. 常時起動のマシンで `npm run web` を動かしておく（API キーは環境変数）
2. 毎日の判断は承認しなくても記録・採点される（`record` / `grade` は承認ゲートの手前で動く）
3. 注文を承認するとペーパー口座で約定する。承認しなければ 12 時間で自動的に却下扱い
4. 「4 確度」で AI とルールの差を見る。実効標本が 100 を超え、下限が 50% を上回り、ルールに勝ったら次の段階を検討する

## セットアップ

Node.js（npm 同梱）は [aqua](https://aquaproj.github.io/) でバージョンを固定して入れる（`aqua.yaml`: Node.js v22.23.4、チェックサム検証あり）。

```bash
# 1) aqua をインストール（初回のみ）
#    macOS:  brew install aquaproj/aqua/aqua
#    Linux:  インストーラのチェックサムを確かめてから実行
curl -sSfL -O https://raw.githubusercontent.com/aquaproj/aqua-installer/v4.1.1/aqua-installer
echo "c0acde4802a1edd8b8201fd4cc1f0e52700cd4feb875f9c9793381b5b0ca2065  aqua-installer" | sha256sum -c -
chmod +x aqua-installer && ./aqua-installer && rm aqua-installer

#    PATH に aqua のディレクトリを追加（~/.bashrc や ~/.zshrc に）
export PATH="${AQUA_ROOT_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/aquaproj-aqua}/bin:$PATH"

# 2) リポジトリで Node.js / npm を入れて依存を入れる
aqua i -l          # aqua.yaml のバージョンの node / npm / npx
node --version     # v22.23.4
npm ci             # .npmrc の engine-strict で、合わない Node では止まる
npm run check      # 型チェック + テスト + UI ビルド
```

- バージョンを上げるときは `aqua.yaml` を書き換えて `aqua update-checksum` を実行し、`aqua-checksums.json` も一緒にコミットする
- Alpine など musl 環境の Node はチェックサム未登録（開発環境から取得できなかったため）。必要なら musl の環境で `aqua update-checksum` を実行する

## 使い方 (CLI)

```bash

# オフラインデモ (API キー不要・無料。疑似モデル + 合成価格なので成績に意味はない)
npm run stockai -- run workflows/demo-rules.yaml --from 2026-05-04 --to 2026-10-30 --step 5 --fake
npm run stockai -- run workflows/demo-ai.yaml    --from 2026-05-04 --to 2026-10-30 --step 5 --fake

# 本番 (要 API キー)。daily-ai は承認ゲートで止まる
cp config/config.example.yaml config/config.yaml
export GEMINI_API_KEY=... DEEPSEEK_API_KEY=...
npm run stockai -- run workflows/daily-rules.yaml
npm run stockai -- run workflows/daily-ai.yaml
npm run stockai -- approve <runId> approve      # または --reject
npm run stockai -- resume <runId>

# ウィブル証券 (docs/webull.md)。既定はプレビューのみで発注しない
npm run stockai -- webull auth                   # Webull アプリでアクセスを承認 (2FA)
npm run stockai -- webull check                  # 読み取りのみ: 口座・現金・保有
npm run stockai -- run workflows/webull-jp.yaml

# IBKR ペーパー口座 (IB Gateway が必要: docs/ibkr.md)
npm run stockai -- run workflows/ibkr-paper.yaml

# プロンプト・モデルの評価 (docs/prompts.md)
npm run stockai -- eval events --versions event-v1,event-v2 --ensemble
npm run stockai -- eval judge  --versions judge-v1,judge-v2

npm run stockai -- runs                          # 実行履歴
npm run stockai -- show <runId>                  # ノード状態・判断・注文・採点
npm run stockai -- nodes                         # ノード一覧 (--json でポート/パラメータの JSON Schema)
npm run stockai -- graph workflows/daily-ai.yaml # ノード UI 用のグラフ JSON
```

## ステータス

Phase 2 + ノードエディタ完了 (コア + ワークフロー + AI 判断 + ペーパー執行 + 採点 + IBKR 接続 + Web UI + 自動実行 + ノードエディタ)。
ブローカーは IBKR とウィブル証券の2社に対応。どちらも疑似ブローカーでテスト済みだが実際の口座では未確認 ([docs/ibkr.md](docs/ibkr.md), [docs/webull.md](docs/webull.md))。当面はシステム内のペーパー口座で確度を記録する。
次は実データでの日次記録。本リポジトリは投資助言ではない。
