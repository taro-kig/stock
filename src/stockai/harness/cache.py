"""H4: content-addressed cache of *validated* LLM outputs."""
from __future__ import annotations

import datetime as dt
import hashlib
import json
import sqlite3


def cache_key(*parts: str) -> str:
    h = hashlib.sha256()
    for p in parts:
        h.update(p.encode("utf-8"))
        h.update(b"\x00")
    return h.hexdigest()


class Cache:
    def __init__(self, db_path: str = ":memory:"):
        self._db = sqlite3.connect(db_path, check_same_thread=False)
        self._db.execute("CREATE TABLE IF NOT EXISTS llm_cache (key TEXT PRIMARY KEY, value TEXT,"
                         " created_at TEXT)")
        self._db.commit()

    def get(self, key: str) -> dict | None:
        row = self._db.execute("SELECT value FROM llm_cache WHERE key = ?", (key,)).fetchone()
        return json.loads(row[0]) if row else None

    def put(self, key: str, value: dict) -> None:
        self._db.execute("INSERT OR REPLACE INTO llm_cache VALUES (?,?,?)",
                         (key, json.dumps(value, ensure_ascii=False),
                          dt.datetime.now().isoformat(timespec="seconds")))
        self._db.commit()
