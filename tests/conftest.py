import json

import pytest

from stockai.signals.models import Document

SOURCE_TEXT = ("トヨタ自動車は5日、2026年3月期の連結営業利益予想を従来の4兆3000億円から"
               "4兆9000億円に上方修正すると発表した。円安と北米販売の好調が寄与する。")


def event_json(**over):
    base = {"relevant": True, "tickers": ["7203"], "event_type": "guidance_up", "direction": 2,
            "materiality": 3, "horizon": "months", "confidence": 0.8,
            "evidence": ["連結営業利益予想を従来の4兆3000億円から4兆9000億円に上方修正"],
            "rationale": "通期予想の上方修正"}
    base.update(over)
    return json.dumps(base, ensure_ascii=False)


@pytest.fixture
def doc():
    return Document(source="test", url="https://example.com/a", title="トヨタ、営業益予想を上方修正",
                    body=SOURCE_TEXT)
