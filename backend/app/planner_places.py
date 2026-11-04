"""Local city search, including places without an airport."""
from __future__ import annotations

import json
import importlib.metadata
import math
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
            if db.execute("PRAGMA user_version").fetchone()[0] != 4:
                # Version 4 added the latitude and longitude columns.
                db.execute("DROP TABLE IF EXISTS places")
            db.execute("CREATE TABLE IF NOT EXISTS places(id TEXT PRIMARY KEY,name TEXT,country TEXT,search TEXT,population INTEGER,payload TEXT,latitude REAL,longitude REAL)")
            db.execute("CREATE TABLE IF NOT EXISTS catalog_meta(key TEXT PRIMARY KEY,value TEXT)")
            archive = ROOT / "data/geonames/cities500.zip"
            stamp = f"{archive.stat().st_mtime_ns}:{archive.stat().st_size}" if archive.exists() else "airports-only"
            stamp += ":"+importlib.metadata.version("airportsdata")
            previous = db.execute("SELECT value FROM catalog_meta WHERE key='source'").fetchone()
            if previous and previous[0] == stamp and db.execute("SELECT count(*) FROM places").fetchone()[0]:
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
                            rows.append((place.id, place.name, fields[8], normalized(" ".join(fields[1:4])), int(fields[14] or 0), place.model_dump_json(), place.latitude, place.longitude))
                            if len(rows) >= 5000:
                                db.executemany("INSERT OR IGNORE INTO places VALUES(?,?,?,?,?,?,?,?)", rows)
                                rows.clear()
                db.executemany("INSERT OR IGNORE INTO places VALUES(?,?,?,?,?,?,?,?)", rows)
            db.execute("CREATE INDEX IF NOT EXISTS places_name ON places(name COLLATE NOCASE,country)")
            db.execute("CREATE INDEX IF NOT EXISTS places_country ON places(country)")
            db.execute("CREATE INDEX IF NOT EXISTS places_position ON places(latitude,longitude)")
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
                db.execute("INSERT OR REPLACE INTO places VALUES(?,?,?,?,?,?,?,?)", (place.id, place.name, place.country_code,
                           normalized(place.name+" "+codes+" "+place.country_code), 1000000000, place.model_dump_json(), place.latitude, place.longitude))
            db.execute("PRAGMA user_version=4")
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


def distance_km(lat1, lon1, lat2, lon2):
    """Great-circle distance."""
    a = math.sin(math.radians(lat2-lat1)/2)**2+math.cos(math.radians(lat1))*math.cos(math.radians(lat2))*math.sin(math.radians(lon2-lon1)/2)**2
    return 12742*math.asin(math.sqrt(a))


def nearest_places(latitude: float, longitude: float, limit: int = 5):
    """The catalog places nearest to a point, nearest first, each with `distance_km`."""
    with sqlite3.connect(catalog_path()) as db:
        # Search a box that grows until it holds enough places. The box holds the nearest places only when it is
        # also wider than the distance to the farthest result, so the last box is the whole world.
        for degrees in (0.5, 2, 8, 30, 180):
            lon_span = min(180, degrees/max(math.cos(math.radians(min(abs(latitude)+degrees, 89.9))), 0.01))
            west, east = longitude-lon_span, longitude+lon_span
            # A box over the antimeridian is two ranges of longitude.
            lon_filter, lon_args = ("1", ()) if lon_span >= 180 else                 ("(longitude BETWEEN ? AND 180 OR longitude BETWEEN -180 AND ?)", (west+360, east)) if west < -180 else                 ("(longitude BETWEEN -180 AND ? OR longitude BETWEEN ? AND 180)", (east-360, west)) if east > 180 else                 ("longitude BETWEEN ? AND ?", (west, east))
            rows = db.execute(f"SELECT payload,latitude,longitude FROM places WHERE latitude BETWEEN ? AND ? AND {lon_filter}",
                              (latitude-degrees, latitude+degrees, *lon_args)).fetchall()
            found = sorted((distance_km(latitude, longitude, row[1], row[2]), row[0]) for row in rows)[:limit]
            # Every place within `degrees` of latitude (about 111 km per degree) is in the box.
            if len(found) == limit and found[-1][0] <= degrees*111 or degrees == 180:
                return [{**json.loads(payload), "distance_km": round(km, 1)} for km, payload in found]
