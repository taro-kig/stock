# stockai — 安価な LLM で動く中期 AI 株トレーディングシステム

数週間〜数ヶ月保有の **中期売買** を、Gemini Flash-Lite 級などの **安いモデルの組み合わせ** で行うためのシステム。
安いモデルの弱点 (幻覚・ブレ・形式崩れ) を **ハーネス** (機械的な検証と多数決) で補い、低コストと高い信頼性を両立させる。

設計の全体像は **[docs/DESIGN.md](docs/DESIGN.md)** を参照。

## 基本方針

- **LLM は「文章 → 構造化データ」の変換だけ。** 売買判断・サイズ・損切りは決定論的ルール
- **中期なので日次バッチ。** リアルタイム不要で LLM 代は月数ドル規模
- **安いモデルは「数」と「検証」で補う:** 異系統モデルの多数決 + 引用の原文照合 + スキーマ検証
- **迷ったら何もしない:** 合意なし・予算超過・データ異常 → シグナル無し / 新規エントリー停止

## 構成

```
src/stockai/
  llm/          プロバイダ (Gemini, OpenAI互換=DeepSeek/OpenRouter/Groq等, テスト用Fake)
  harness/      信頼性ハーネス
    structured.py  H1 JSON + スキーマ検証 + エラー内容を添えた再試行
    grounding.py   H2 引用が原文に実在するかの文字列照合 (幻覚対策)
    ensemble.py    H3 異系統モデルの多数決・早期打ち切り・重要案件のみ上位モデルへ昇格
    cache.py       H4 コンテンツハッシュキャッシュ (同じ記事に二度課金しない)
    budget.py      H5 日次予算の上限
  signals/      収集(RSS)・重複除去・銘柄辞書フィルタ・イベント抽出・スコア集約・テクニカル指標
  strategy/     スコア合成・ポジションサイズ・損切り・キルスイッチ・リバランス提案
  pipeline.py   日次パイプライン (Phase 0: 収集 → 抽出 → イベントスコア)
```

## 使い方

```bash
pip install -e '.[dev]'
pytest                                    # テスト

cp config/config.example.yaml config/config.yaml   # 編集する
export GEMINI_API_KEY=... DEEPSEEK_API_KEY=...
python -m stockai.pipeline --config config/config.yaml

# API キーなしで配線だけ確認 (LLM は常に「無関係」と答えるダミー)
python -m stockai.pipeline --config config/config.example.yaml --fake
```

## ステータス

Phase 0 (設計 + ハーネス中核)。実際の発注機能はまだ無い。ロードマップは DESIGN.md §10。
本リポジトリは投資助言ではない。
