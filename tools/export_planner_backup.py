"""One-time, read-only SQLite migration to a portable browser planner backup.

Python pickle checkpoints and disposable provider responses are intentionally
excluded. The browser retains schedules/edits/queues and restarts native solving.
This exporter needs only the Python standard library.
"""
import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import sqlite3


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--database", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if args.database.resolve() == args.output.resolve():
        parser.error("The backup output cannot replace its source database.")
    allowed = {"trips", "rules", "graphs", "jobs", "optimizations"}
    with sqlite3.connect(args.database.resolve().as_uri()+"?mode=ro", uri=True) as db:
        rows = db.execute("SELECT collection,id,payload,updated FROM records ORDER BY updated").fetchall()
    records = []
    for collection, identifier, payload, updated in rows:
        if collection not in allowed:
            raise ValueError(f"Unsupported record collection: {collection}")
        records.append(dict(schema_version=1, collection=collection, id=identifier, updated=updated*1000, payload=json.loads(payload)))
    backup = dict(format="wayfinder-browser-backup", schema_version=1, exported_at=datetime.now(timezone.utc).isoformat(), records=records)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    with args.output.open("x", encoding="utf-8") as stream:
        json.dump(backup, stream, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
    print(json.dumps(dict(records=len(records), trips=sum(r["collection"] == "trips" for r in records), output=str(args.output))))


if __name__ == "__main__":
    main()
