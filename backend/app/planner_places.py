"""Local city search, including places without an airport."""
from __future__ import annotations

import json
import importlib.metadata
import os
import sqlite3
import threading
import unicodedata
import zipfile
from functools import lru_cache
from pathlib import Path

from .places import load_airport_cities
from .planner_models import Place

ROOT = Path(__file__).resolve().parents[2]
LOCK = threading.Lock()


def normalized(value):
    return "".join(c for c in unicodedata.normalize("NFKD", value.casefold()) if not unicodedata.combining(c))


@lru_cache(1)
def catalog_path():
    path = Path(os.environ.get("PLANNER_PLACES_PATH", ROOT / "backend/data/places.sqlite3"))
    with LOCK:
        path.parent.mkdir(parents=True, exist_ok=True)
        with sqlite3.connect(path) as db:
            db.execute("CREATE TABLE IF NOT EXISTS places(id TEXT PRIMARY KEY,name TEXT,country TEXT,search TEXT,population INTEGER,payload TEXT)")
            db.execute("CREATE TABLE IF NOT EXISTS catalog_meta(key TEXT PRIMARY KEY,value TEXT)")
            archive = ROOT / "data/geonames/cities500.zip"
            stamp = f"{archive.stat().st_mtime_ns}:{archive.stat().st_size}" if archive.exists() else "airports-only"
            stamp += ":"+importlib.metadata.version("airportsdata")
            previous = db.execute("SELECT value FROM catalog_meta WHERE key='source'").fetchone()
            if db.execute("PRAGMA user_version").fetchone()[0] == 3 and previous and previous[0] == stamp and db.execute("SELECT count(*) FROM places").fetchone()[0]:
                return path
            db.execute("DELETE FROM places")
            rows = []
            if archive.exists():
                with zipfile.ZipFile(archive) as zipped:
                    with zipped.open("cities500.txt") as stream:
                        for line in stream:
                            fields = line.decode("utf-8").rstrip("\n").split("\t")
                            if len(fields) < 19 or not fields[17]:
                                continue
                            place = Place(id="geo:"+fields[0], name=fields[1], latitude=float(fields[4]), longitude=float(fields[5]), timezone=fields[17], country_code=fields[8])
                            rows.append((place.id, place.name, fields[8], normalized(" ".join(fields[1:4])), int(fields[14] or 0), place.model_dump_json()))
                            if len(rows) >= 5000:
                                db.executemany("INSERT OR IGNORE INTO places VALUES(?,?,?,?,?,?)", rows)
                                rows.clear()
                db.executemany("INSERT OR IGNORE INTO places VALUES(?,?,?,?,?,?)", rows)
            db.execute("CREATE INDEX IF NOT EXISTS places_name ON places(name COLLATE NOCASE,country)")
            db.execute("CREATE INDEX IF NOT EXISTS places_country ON places(country)")
            for city in load_airport_cities().values():
                candidates = db.execute("SELECT id,payload FROM places WHERE name=? COLLATE NOCASE AND country=?", (city.name, city.country_code)).fetchall()
                if not candidates:
                    # Airport catalogs and city catalogs can use different
                    # canonical names (e.g. New York / New York City).
                    candidates = db.execute("SELECT id,payload FROM places WHERE country=? AND search LIKE ? LIMIT 80", (city.country_code, "%"+normalized(city.name)+"%" )).fetchall()
                def match_rank(row):
                    candidate = json.loads(row[1])
                    name = normalized(candidate["name"])
                    target = normalized(city.name)
                    rank = 0 if name == target else 1 if name.startswith(target+" ") else 2
                    return rank, (candidate["latitude"]-city.latitude)**2+(candidate["longitude"]-city.longitude)**2
                match = min(candidates, key=match_rank) if candidates else None
                if match:
                    place = Place.model_validate_json(match[1])
                    if abs(place.latitude-city.latitude)+abs(place.longitude-city.longitude) > 2:
                        match = None
                if not match:
                    place = Place(id=city.code, name=city.name, latitude=city.latitude, longitude=city.longitude,
                                  timezone=city.timezone_name or "UTC", country_code=city.country_code)
                place = place.model_copy(update={"airport_codes": list(city.airport_codes), "flight_code": city.flight_code})
                codes = " ".join([city.code, city.flight_code, *city.airport_codes])
                db.execute("INSERT OR REPLACE INTO places VALUES(?,?,?,?,?,?)", (place.id, place.name, place.country_code,
                           normalized(place.name+" "+codes+" "+place.country_code), 1000000000, place.model_dump_json()))
            db.execute("PRAGMA user_version=3")
            db.execute("INSERT OR REPLACE INTO catalog_meta VALUES('source',?)", (stamp,))
    return path


def search_places(query: str, limit: int = 16):
    needle = normalized(query.strip())
    # LIKE metacharacters are literal user input, not wildcards.
    escaped = needle.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    with sqlite3.connect(catalog_path()) as db:
        rows = db.execute("SELECT payload FROM places WHERE search LIKE ? ESCAPE '\\' ORDER BY (lower(name)=?) DESC,(instr(' '||search||' ',?)>0) DESC,population DESC,name LIMIT ?",
                          ("%"+escaped+"%", needle, " "+needle+" ", limit)).fetchall()
    return [json.loads(row[0]) for row in rows]
