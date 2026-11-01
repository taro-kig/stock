"""Data shapes shared by collectors, the LLM extractor and scoring."""
from __future__ import annotations

import datetime as dt
import hashlib
from enum import Enum
from typing import Literal

from pydantic import BaseModel, Field, field_validator


class Document(BaseModel):
    source: str                      # collector name, e.g. "google_news_jp"
    url: str
    title: str
    body: str = ""
    published_at: dt.datetime | None = None
    fetched_at: dt.datetime = Field(default_factory=lambda: dt.datetime.now(dt.timezone.utc))
    source_weight: float = 1.0       # prior reliability of this source (see DESIGN §3)

    @property
    def text(self) -> str:
        return f"{self.title}\n{self.body}".strip()

    @property
    def content_hash(self) -> str:
        return hashlib.sha256(self.text.encode("utf-8")).hexdigest()


class EventType(str, Enum):
    EARNINGS_BEAT = "earnings_beat"            # 決算が予想超え
    EARNINGS_MISS = "earnings_miss"            # 決算が予想未達
    GUIDANCE_UP = "guidance_up"                # 業績予想の上方修正
    GUIDANCE_DOWN = "guidance_down"            # 業績予想の下方修正
    SHAREHOLDER_RETURN = "shareholder_return"  # 自社株買い・増配
    DIVIDEND_CUT = "dividend_cut"              # 減配・無配
    DILUTION = "dilution"                      # 公募増資・MSワラント・CB
    M_AND_A = "m_and_a"                        # 買収・TOB・提携
    ANALYST_UPGRADE = "analyst_upgrade"
    ANALYST_DOWNGRADE = "analyst_downgrade"
    PRODUCT_BUSINESS = "product_business"      # 新製品・受注・事業進捗
    LEGAL_REGULATORY = "legal_regulatory"      # 訴訟・規制・行政処分
    SCANDAL = "scandal"                        # 不祥事・不正会計
    MANAGEMENT = "management"                  # 経営陣の交代
    MACRO_SECTOR = "macro_sector"              # 業界・マクロ要因
    OTHER = "other"
    NONE = "none"                              # 関連なし


class EventExtraction(BaseModel):
    relevant: bool = Field(description="候補銘柄の株価に中期的に関係する情報か")
    tickers: list[str] = Field(default_factory=list, description="影響を受ける銘柄コード (候補リストから選ぶ)")
    event_type: EventType
    direction: int = Field(ge=-2, le=2, description="株価への影響: -2 強い悪材料 … +2 強い好材料")
    materiality: int = Field(ge=0, le=3, description="重要度 0:些末 … 3:業績・株価を大きく動かす")
    horizon: Literal["days", "weeks", "months"] = Field(description="影響が続く期間の目安")
    confidence: float = Field(ge=0.0, le=1.0)
    evidence: list[str] = Field(default_factory=list, max_length=3,
                                description="判断根拠となる原文の一字一句そのままの引用 (1〜3個)")
    rationale: str = Field(default="", max_length=300, description="判断理由を1文で")

    @field_validator("tickers")
    @classmethod
    def _strip(cls, v: list[str]) -> list[str]:
        return sorted({t.strip().upper() for t in v if t.strip()})
