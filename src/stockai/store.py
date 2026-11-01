"""Point-in-time record of documents and ensemble outcomes (DESIGN §8).

Everything needed to later grade each model/source against forward returns.
"""
from __future__ import annotations

import json
import sqlite3

from .harness.ensemble import EnsembleResult
from .signals.models import Document


class Store:
    def __init__(self, db_path: str = ":memory:"):
        self.db = sqlite3.connect(db_path)
        self.db.executescript("""
        CREATE TABLE IF NOT EXISTS documents (
            content_hash TEXT PRIMARY KEY, source TEXT, url TEXT, title TEXT, body TEXT,
            published_at TEXT, fetched_at TEXT, n_sources INT);
        CREATE TABLE IF NOT EXISTS extractions (
            content_hash TEXT, prompt_version TEXT, status TEXT, agreement REAL,
            result_json TEXT, votes_json TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (content_hash, prompt_version));
        """)

    def seen(self, doc: Document, prompt_version: str) -> bool:
        return self.db.execute("SELECT 1 FROM extractions WHERE content_hash=? AND prompt_version=?",
                               (doc.content_hash, prompt_version)).fetchone() is not None

    def save_document(self, doc: Document, n_sources: int = 1) -> None:
        self.db.execute("INSERT OR IGNORE INTO documents VALUES (?,?,?,?,?,?,?,?)",
                        (doc.content_hash, doc.source, doc.url, doc.title, doc.body,
                         doc.published_at.isoformat() if doc.published_at else None,
                         doc.fetched_at.isoformat(), n_sources))
        self.db.commit()

    def save_extraction(self, doc: Document, prompt_version: str, res: EnsembleResult) -> None:
        votes = [{"provider": v.provider, "rejected": v.rejected, "cached": v.cached,
                  "value": v.value.model_dump(mode="json") if v.value else None} for v in res.votes]
        self.db.execute("INSERT OR REPLACE INTO extractions (content_hash, prompt_version, status,"
                        " agreement, result_json, votes_json) VALUES (?,?,?,?,?,?)",
                        (doc.content_hash, prompt_version, res.status, res.agreement,
                         json.dumps(res.value.model_dump(mode="json"), ensure_ascii=False) if res.value else None,
                         json.dumps(votes, ensure_ascii=False)))
        self.db.commit()
