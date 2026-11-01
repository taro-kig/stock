"""H2: verify that quoted evidence actually appears in the source text.

This is the cheapest and most effective anti-hallucination check: it is a
string comparison, costs nothing, and cheap models cannot talk their way
around it.
"""
from __future__ import annotations

import re
import unicodedata
from difflib import SequenceMatcher

_WS = re.compile(r"\s+")
_QUOTES = str.maketrans({"「": "", "」": "", "『": "", "』": "", '"': "", "'": "",
                         "“": "", "”": "", "‘": "", "’": ""})


def normalize(text: str) -> str:
    # NFKC folds full-width digits/letters (４．９兆円 -> 4.9兆円); whitespace is
    # dropped because models often insert/remove spaces in Japanese text.
    text = unicodedata.normalize("NFKC", text).casefold().translate(_QUOTES)
    return _WS.sub("", text)


def quote_in_source(quote: str, source: str, *, min_ratio: float = 0.9,
                    min_len: int = 6) -> bool:
    q, s = normalize(quote), normalize(source)
    if len(q) < min_len:  # a trivially short "quote" (e.g. a company name) proves nothing
        return False
    if q in s:
        return True
    # tolerate small edits (an ellipsis, a dropped particle) via the longest common block
    m = SequenceMatcher(None, s, q, autojunk=False).find_longest_match(0, len(s), 0, len(q))
    return m.size / len(q) >= min_ratio


def check_evidence(quotes: list[str], source: str, *, min_quotes: int = 1,
                   min_ratio: float = 0.9) -> tuple[bool, list[str]]:
    """Returns (ok, failed_quotes). All quotes must be grounded, and at least `min_quotes`."""
    failed = [q for q in quotes if not quote_in_source(q, source, min_ratio=min_ratio)]
    ok = not failed and len(quotes) >= min_quotes
    return ok, failed
