"""Transactional local storage. Provider caches are distinct from user edits."""
from __future__ import annotations

import json
import os
import sqlite3
import threading
import time
import uuid
from contextlib import contextmanager
from pathlib import Path

DEFAULT_PATH = Path(__file__).resolve().parents[1] / "data" / "planner.sqlite3"


class PlannerStore:
    def __init__(self, path: Path | str | None = None):
        self.path = Path(path or os.environ.get("PLANNER_DB_PATH", DEFAULT_PATH))
        self._lock = threading.RLock()
        self._ready = False

    @contextmanager
    def _connect(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        connection = sqlite3.connect(self.path, timeout=15)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute("PRAGMA foreign_keys=ON")
        if not self._ready:
            connection.executescript("""
                CREATE TABLE IF NOT EXISTS records (
                    collection TEXT NOT NULL, id TEXT NOT NULL,
                    payload TEXT NOT NULL, updated REAL NOT NULL,
                    PRIMARY KEY(collection,id));
                CREATE TABLE IF NOT EXISTS provider_cache (
                    key TEXT PRIMARY KEY, payload TEXT NOT NULL, expires REAL NOT NULL);
                PRAGMA user_version=1;
            """)
            self._ready = True
        try:
            with connection:
                yield connection
        finally:
            connection.close()

    def get(self, collection: str, id: str):
        with self._lock, self._connect() as db:
            row = db.execute("SELECT payload FROM records WHERE collection=? AND id=?", (collection, id)).fetchone()
            return json.loads(row[0]) if row else None

    def put(self, collection: str, id: str, payload: dict):
        with self._lock, self._connect() as db:
            db.execute("INSERT INTO records VALUES(?,?,?,?) ON CONFLICT(collection,id) DO UPDATE SET payload=excluded.payload,updated=excluded.updated",
                       (collection, id, json.dumps(payload, default=str, allow_nan=False), time.time()))
        return payload

    def list(self, collection: str):
        with self._lock, self._connect() as db:
            rows = db.execute("SELECT payload FROM records WHERE collection=? ORDER BY updated DESC", (collection,)).fetchall()
            return [json.loads(row[0]) for row in rows]

    def delete(self, collection: str, id: str):
        with self._lock, self._connect() as db:
            db.execute("DELETE FROM records WHERE collection=? AND id=?", (collection, id))

    def update(self, collection: str, id: str, transform):
        with self._lock:
            current = self.get(collection, id)
            if current is None:
                raise KeyError(id)
            return self.put(collection, id, transform(current))

    def cached(self, key: str):
        with self._lock, self._connect() as db:
            row = db.execute("SELECT payload,expires FROM provider_cache WHERE key=?", (key,)).fetchone()
            if row and row[1] > time.time():
                return json.loads(row[0])
        return None

    def cache(self, key: str, payload: dict, ttl: int):
        with self._lock, self._connect() as db:
            db.execute("DELETE FROM provider_cache WHERE expires<?", (time.time(),))
            db.execute("INSERT OR REPLACE INTO provider_cache VALUES(?,?,?)", (key, json.dumps(payload, default=str, allow_nan=False), time.time()+ttl))

    def new_trip(self, spec: dict):
        id = uuid.uuid4().hex
        return self.put("trips", id, {"id": id, "revision": 1, "spec": spec, "snapshot": None, "latest_job_id": None, "offers": []})

    def recover(self):
        for job in self.list("jobs"):
            if job["status"] in {"running", "queued"}:
                job["status"] = "interrupted"
                self.put("jobs", job["id"], job)


store = PlannerStore()
