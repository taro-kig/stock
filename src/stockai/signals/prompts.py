"""Versioned prompts. Bump the version whenever wording changes: it is part of
the cache key and of evaluation records, so results stay attributable."""
from __future__ import annotations

from .models import Document

EVENT_PROMPT_VERSION = "event-v1"

EVENT_SYSTEM = """あなたは株式アナリストの補助として、ニュースや適時開示を構造化データに変換する。
売買の推奨はしない。与えられた文書に書かれている事実だけを使う。

規則:
- 文書に書かれていないことを推測で補わない。自分の知識で株価の結末を補わない。
- tickers は必ず「候補銘柄」の中から選ぶ。該当がなければ relevant=false。
- evidence には文書中の文章を一字一句そのまま (10〜80文字程度) 引用する。要約や言い換えは禁止。
- 宣伝・まとめ記事・株価が動いたことだけを伝える記事は materiality を低くする。
- 判断できない場合は relevant=false, event_type="none", direction=0 とする。"""


def event_user_prompt(doc: Document, candidates: dict[str, str]) -> str:
    cand = "\n".join(f"- {code}: {name}" for code, name in sorted(candidates.items()))
    published = doc.published_at.isoformat() if doc.published_at else "不明"
    return (f"# 候補銘柄\n{cand}\n\n# 文書\n情報源: {doc.source}\n公開日時: {published}\n"
            f"タイトル: {doc.title}\n本文:\n{doc.body[:6000]}")
