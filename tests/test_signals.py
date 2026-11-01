import datetime as dt

import numpy as np
import pandas as pd

from stockai.signals import technical
from stockai.signals.aggregate import ScoredEvent, event_scores
from stockai.signals.models import Document, EventExtraction
from stockai.signals.prefilter import Watchlist, dedup
from stockai.signals.sources.rss import RSSSource

RSS = b"""<?xml version="1.0"?><rss version="2.0"><channel><title>t</title>
<item><title>Sony raises outlook - Reuters</title><link>https://r/1</link>
<description>&lt;b&gt;Sony&lt;/b&gt; Group lifted its forecast.</description>
<pubDate>Mon, 02 Nov 2026 06:00:00 GMT</pubDate></item>
</channel></rss>"""


def test_rss_parse():
    docs = RSSSource("reuters", "http://x", weight=0.9).parse(RSS)
    assert len(docs) == 1 and docs[0].body == "Sony  Group lifted its forecast."
    assert docs[0].published_at.year == 2026 and docs[0].source_weight == 0.9


def test_watchlist_matching_respects_word_boundaries():
    w = Watchlist({"6758": {"name": "ソニーグループ", "aliases": ["ソニー", "Sony"]},
                   "7203": {"name": "トヨタ自動車", "aliases": ["トヨタ"]}})
    assert w.match(Document(source="s", url="u", title="SONY lifts outlook")) == {"6758": "ソニーグループ"}
    assert w.match(Document(source="s", url="u", title="Sonya's bakery")) == {}
    assert "7203" in w.match(Document(source="s", url="u", title="トヨタが新型車"))


def test_dedup_tracks_corroborating_sources():
    a = Document(source="nikkei", url="u1", title="トヨタ、上方修正 - 日経")
    b = Document(source="yahoo", url="u2", title="トヨタ、上方修正 - Yahoo!ニュース")
    unique, carried = dedup([a, b])
    assert len(unique) == 1 and carried["u1"] == {"nikkei", "yahoo"}


def _ev(direction, horizon="months"):
    return EventExtraction(relevant=True, tickers=["7203"], event_type="guidance_up", direction=direction,
                           materiality=3, horizon=horizon, confidence=1.0, evidence=["x" * 10])


def test_event_scores_decay_corroboration_and_no_lookahead():
    now = dt.datetime(2026, 11, 1, tzinfo=dt.timezone.utc)
    fresh = event_scores([ScoredEvent(_ev(2), now, 1.0)], now)["7203"]
    old = event_scores([ScoredEvent(_ev(2), now - dt.timedelta(days=30), 1.0)], now)["7203"]
    assert abs(old - fresh / 2) < 1e-9  # one half-life
    corroborated = event_scores([ScoredEvent(_ev(2), now, 1.0, n_sources=2)], now)["7203"]
    assert corroborated > fresh
    future = event_scores([ScoredEvent(_ev(2), now + dt.timedelta(days=1), 1.0)], now)
    assert future == {}


def test_technical_indicators():
    idx = pd.bdate_range("2025-01-01", periods=300)
    close = pd.Series(np.linspace(100, 200, 300), index=idx)
    assert technical.trend_ok(close)
    assert technical.momentum_12_1(close) > 0
    assert not technical.trend_ok(close[::-1].reset_index(drop=True))
    a = technical.atr(close + 1, close - 1, close)
    assert 2.0 <= a <= 2.5
