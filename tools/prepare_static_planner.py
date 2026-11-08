"""Build public catalogs for the native planner, without bundling Python runtime assets."""
import argparse
import json
from pathlib import Path
import sqlite3
import sys
import unicodedata

import airportsdata

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--places-database", type=Path, help="Read an existing public place catalog without changing it.")
    args = parser.parse_args()
    if args.places_database:
        source = args.places_database.resolve(strict=True)
    else:
        from backend.app.planner_places import catalog_path
        source = catalog_path().resolve()
    with sqlite3.connect(source.as_uri() + "?mode=ro", uri=True) as db:
        if db.execute("PRAGMA user_version").fetchone()[0] != 4:
            raise ValueError("Use a version-4 place catalog.")
        rows = [{"place": json.loads(payload), "search": search, "population": population, "payload": payload}
                for payload, search, population in db.execute("SELECT payload,search,population FROM places ORDER BY rowid")]
    # Match Python's casefold -> NFKD -> combining-class filter, including ß.
    casefold = {chr(i): chr(i).casefold() for i in range(sys.maxunicode + 1) if chr(i).casefold() != chr(i)}
    combining = [i for i in range(sys.maxunicode + 1) if unicodedata.combining(chr(i))]
    places = {"schema_version": 1, "rows": rows, "casefold": casefold, "combining": combining}
    airports = airportsdata.load("IATA")
    catalog = {"schema_version": 1, "airports": {code: {key: row[key] for key in ("name", "lat", "lon", "tz")} for code, row in airports.items()},
               "metros": {code: list(row.get("airports", {})) for code, row in airportsdata.load_iata_macs().items()}}
    for public in ("public-native", "public"):
        output = ROOT / "frontend" / public / "browser-data"
        output.mkdir(parents=True, exist_ok=True)
        for name, data in (("places", places), ("airports", catalog)):
            (output / f"{name}.json").write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"Prepared {len(rows)} public places and {len(airports)} airports; no trip data or Python runtime included.")


if __name__ == "__main__":
    main()
