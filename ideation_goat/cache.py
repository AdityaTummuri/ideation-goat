"""A small SQLite TTL cache for HTTP responses.

Free API quotas are the main constraint, so repo metadata is kept for about a day
and vulnerability data for six hours. Entries keep their original fetch time, so a
cached value still reports when it was actually fetched.
"""

from __future__ import annotations

import sqlite3
import threading
import time
from dataclasses import dataclass
from pathlib import Path

HOUR = 3600
DAY = 24 * HOUR


@dataclass(frozen=True)
class CachedEntry:
    status: int
    body: str
    link: str | None
    fetched_at: float


class Cache:
    """SQLite-backed cache. Pass ``path=None`` to disable it."""

    def __init__(self, path: Path | None) -> None:
        self._lock = threading.Lock()
        self._conn: sqlite3.Connection | None = None
        if path is None:
            return
        path.parent.mkdir(parents=True, exist_ok=True)
        conn = sqlite3.connect(path, check_same_thread=False, timeout=5)
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute(
            "CREATE TABLE IF NOT EXISTS http_cache ("
            " key TEXT PRIMARY KEY, status INTEGER, body TEXT, link TEXT,"
            " fetched_at REAL, expires_at REAL)"
        )
        conn.commit()
        self._conn = conn

    def get(self, key: str) -> CachedEntry | None:
        if self._conn is None:
            return None
        with self._lock:
            row = self._conn.execute(
                "SELECT status, body, link, fetched_at, expires_at FROM http_cache WHERE key = ?", (key,)
            ).fetchone()
        if row is None or row[4] < time.time():
            return None
        return CachedEntry(status=row[0], body=row[1], link=row[2], fetched_at=row[3])

    def set(self, key: str, entry: CachedEntry, ttl: float) -> None:
        if self._conn is None or ttl <= 0:
            return
        with self._lock:
            self._conn.execute(
                "INSERT OR REPLACE INTO http_cache VALUES (?, ?, ?, ?, ?, ?)",
                (key, entry.status, entry.body, entry.link, entry.fetched_at, time.time() + ttl),
            )
            self._conn.commit()

    def clear(self) -> None:
        if self._conn is None:
            return
        with self._lock:
            self._conn.execute("DELETE FROM http_cache")
            self._conn.commit()

    def close(self) -> None:
        if self._conn is not None:
            self._conn.close()
            self._conn = None
