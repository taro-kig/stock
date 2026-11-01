# stockai — 安価な LLM で動く中期 AI 株トレーディングシステム

数週間〜数ヶ月保有の **中期売買** を、Gemini Flash-Lite 級などの **安いモデルの組み合わせ** で行うシステム。
**AI が「何を・いつ」売買するかを判断し、決定論的なルールが「いくら・どこまで損するか」を縛る。**
AI に渡す権限は、判断を全件記録して答え合わせした **実測の確度** に応じて段階的に広げる。

設計: **[docs/DESIGN.md](docs/DESIGN.md)**

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
  execution/  ペーパー口座, IBKR クライアント, 発注前ガード, 注文・ポジション台帳
  eval/       判断の記録と採点 (scorecard)
  workflow/   エンジン (型付きポート, 検証, キャッシュ, 承認, 再生, イベントログ)
  nodes/      組み込みノード (stockai nodes で一覧)
  cli/        CLI
workflows/    daily-ai / daily-rules (本番), ibkr-paper (IBKR ペーパー口座), demo-ai / demo-rules (オフラインデモ)
deploy/ibkr/  IB Gateway の Docker 構成
config/       config.example.yaml
```

## 使い方

Node.js 22.18 以上。

```bash
npm install
npm run check                       # 型チェック + テスト

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

# IBKR ペーパー口座 (IB Gateway が必要: docs/ibkr.md)
npm run stockai -- run workflows/ibkr-paper.yaml

npm run stockai -- runs                          # 実行履歴
npm run stockai -- show <runId>                  # ノード状態・判断・注文・採点
npm run stockai -- nodes                         # ノード一覧 (--json でポート/パラメータの JSON Schema)
npm run stockai -- graph workflows/daily-ai.yaml # ノード UI 用のグラフ JSON
```

## ステータス

Phase 1.5 完了 (TypeScript 版コア + ワークフロー + AI 判断 + ペーパー執行 + 採点 + IBKR 接続)。
IBKR 接続は疑似ブローカーでテスト済みだが、実機の IB Gateway ではまだ確認していない ([docs/ibkr.md](docs/ibkr.md) のチェックリスト)。
次は Web UI (TUI 風の画面 → ノード UI)。本リポジトリは投資助言ではない。
