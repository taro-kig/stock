"""Tier 0: decide *without an LLM* which documents are worth paying for."""
from __future__ import annotations

import re
import unicodedata

from .models import Document


def _norm(s: str) -> str:
    return unicodedata.normalize("NFKC", s).casefold()


class Watchlist:
    """ticker -> display name + aliases (company names, brand names, English names)."""

    def __init__(self, entries: dict[str, dict]):
        self.names = {t: e.get("name", t) for t, e in entries.items()}
        self._patterns: dict[str, list[re.Pattern]] = {}
        for ticker, e in entries.items():
            aliases = {e.get("name", ""), *e.get("aliases", [])} - {""}
            pats = []
            for a in aliases:
                a = _norm(a)
                # ASCII aliases need word boundaries ("SONY" must not match "SONYA");
                # Japanese has no spaces, so plain substring matching is used there.
                pats.append(re.compile(rf"(?<![a-z0-9]){re.escape(a)}(?![a-z0-9])") if a.isascii()
                            else re.compile(re.escape(a)))
            self._patterns[ticker] = pats

    def match(self, doc: Document) -> dict[str, str]:
        text = _norm(doc.text)
        return {t: self.names[t] for t, pats in self._patterns.items() if any(p.search(text) for p in pats)}


def title_key(title: str) -> str:
    """Near-duplicate key: the same story syndicated by several sites usually has the same headline."""
    t = _norm(title)
    t = re.sub(r"\s[-|｜]\s[^-|｜]+$", "", t)  # drop trailing " - Publisher"
    return re.sub(r"[\W_]+", "", t)


def dedup(docs: list[Document]) -> tuple[list[Document], dict[str, set[str]]]:
    """Returns unique docs and, for each kept doc's url, the set of sources that carried the story
    (used for the corroboration bonus)."""
    kept: dict[str, Document] = {}
    sources: dict[str, set[str]] = {}
    for d in docs:
        k = title_key(d.title) or d.content_hash
        if k not in kept:
            kept[k] = d
            sources[d.url] = set()
        sources[kept[k].url].add(d.source)
    return list(kept.values()), sources
