"""RSS/Atom collector. Prefer official feeds/APIs over scraping (see DESIGN §3, §13)."""
from __future__ import annotations

import calendar
import datetime as dt
import html
import re

import feedparser
import httpx

from ..models import Document

_TAG = re.compile(r"<[^>]+>")


def _clean(s: str) -> str:
    return html.unescape(_TAG.sub(" ", s or "")).strip()


class RSSSource:
    def __init__(self, name: str, url: str, weight: float = 1.0, timeout: float = 20.0):
        self.name, self.url, self.weight, self.timeout = name, url, weight, timeout

    def parse(self, content: bytes | str) -> list[Document]:
        feed = feedparser.parse(content)
        docs = []
        for e in feed.entries:
            ts = e.get("published_parsed") or e.get("updated_parsed")
            published = dt.datetime.fromtimestamp(calendar.timegm(ts), dt.timezone.utc) if ts else None
            docs.append(Document(source=self.name, url=e.get("link", ""), title=_clean(e.get("title", "")),
                                 body=_clean(e.get("summary", "")), published_at=published,
                                 source_weight=self.weight))
        return docs

    def fetch(self) -> list[Document]:
        r = httpx.get(self.url, timeout=self.timeout, follow_redirects=True,
                      headers={"User-Agent": "stockai/0.1 (personal research)"})
        r.raise_for_status()
        return self.parse(r.content)
