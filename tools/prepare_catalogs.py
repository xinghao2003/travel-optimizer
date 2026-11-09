"""Build the public browser catalogs: places, airports, and provider configuration.

Places are IATA airport cities from airportsdata, plus every GeoNames town with 500 or more
people when data/geonames/cities500.zip is present. The output is written to
frontend/public/browser-data/ and contains no trip data.
"""
import json
import os
from pathlib import Path
import re
import unicodedata
import zipfile

import airportsdata

ROOT = Path(__file__).resolve().parents[1]
GEONAMES = ROOT / "data/geonames/cities500.zip"
OUTPUT = ROOT / "frontend/public/browser-data"


def normalized(value):
    # Keep in step with PlaceCatalog.normalize in frontend/src/native/places.ts.
    return "".join(c for c in unicodedata.normalize("NFKD", value.lower()) if not unicodedata.category(c).startswith("M"))


def place(id, name, latitude, longitude, timezone, country_code, airport_codes=(), flight_code=None):
    return {"id": id, "name": name, "latitude": latitude, "longitude": longitude, "timezone": timezone,
            "country_code": country_code, "airport_codes": list(airport_codes), "flight_code": flight_code}


def airport_cities(airports, metros):
    """Group IATA airports into cities. A city uses its metropolitan code for flight searches when one exists."""
    groups = {}
    for code, airport in airports.items():
        city, country = str(airport.get("city") or "").strip(), str(airport.get("country") or "").strip().upper()
        iata = str(airport.get("iata") or code).strip().upper()
        if city and re.fullmatch(r"[A-Z]{3}", iata):
            groups.setdefault((normalized(city), country), []).append((iata, airport))
    for (_, country), members in groups.items():
        codes, by_code = sorted({code for code, _ in members}), dict(members)
        name = str(members[0][1].get("city") or members[0][1].get("name") or "").strip()
        matching = sorted(((code, metro) for code, metro in metros.items()
                           if str(metro.get("country") or "").upper() == country and normalized(str(metro.get("name") or "")) == normalized(name)
                           and set(metro.get("airports", {})).issubset(codes)), key=lambda item: (-len(item[1].get("airports", {})), item[0]))
        metro_code = matching[0][0] if matching else None
        primary_code = next((code for code in (matching[0][1].get("airports", {}) if matching else []) if code in by_code), codes[0])
        primary = by_code[primary_code]
        yield {"code": primary_code, "flight_code": metro_code or primary_code, "name": str(primary.get("city") or primary.get("name") or primary_code).strip(),
               "country_code": country, "latitude": float(primary["lat"]), "longitude": float(primary["lon"]),
               "timezone": str(primary.get("tz") or "") or "UTC", "airport_codes": codes}


def geonames_places():
    if not GEONAMES.exists():
        return {}
    rows = {}
    with zipfile.ZipFile(GEONAMES) as zipped, zipped.open("cities500.txt") as stream:
        for line in stream:
            fields = line.decode("utf-8").rstrip("\n").split("\t")
            if len(fields) >= 19 and fields[17]:
                item = place("geo:" + fields[0], fields[1], float(fields[4]), float(fields[5]), fields[17], fields[8])
                rows.setdefault(item["id"], {"place": item, "search": normalized(" ".join(fields[1:4])), "population": int(fields[14] or 0)})
    return rows


def match_city(city, rows_by_country):
    """The GeoNames place for an airport city: the same name (or a name that contains it) within about 2 degrees."""
    target, candidates = normalized(city["name"]), rows_by_country.get(city["country_code"], [])
    exact = [row for row in candidates if row["place"]["name"].lower() == city["name"].lower()]
    if not exact:
        # Airport and city catalogs can use different names (New York / New York City).
        exact = [row for row in candidates if target in row["search"]][:80]
    def rank(row):
        name = normalized(row["place"]["name"])
        return (0 if name == target else 1 if name.startswith(target + " ") else 2,
                (row["place"]["latitude"] - city["latitude"]) ** 2 + (row["place"]["longitude"] - city["longitude"]) ** 2)
    best = min(exact, key=rank, default=None)
    if best and abs(best["place"]["latitude"] - city["latitude"]) + abs(best["place"]["longitude"] - city["longitude"]) <= 2:
        return best["place"]
    return None


def main():
    airports, metros = airportsdata.load("IATA"), airportsdata.load_iata_macs()
    rows = geonames_places()
    rows_by_country = {}
    for row in rows.values():
        rows_by_country.setdefault(row["place"]["country_code"], []).append(row)
    for city in airport_cities(airports, metros):
        matched = match_city(city, rows_by_country)
        base = dict(matched) if matched else place(city["code"], city["name"], city["latitude"], city["longitude"], city["timezone"], city["country_code"])
        item = {**base, "airport_codes": city["airport_codes"], "flight_code": city["flight_code"]}
        codes = " ".join([city["code"], city["flight_code"], *city["airport_codes"]])
        # Airport cities rank first in search.
        rows[item["id"]] = {"place": item, "search": normalized(f"{item['name']} {codes} {item['country_code']}"), "population": 1_000_000_000}
    places = {"schema_version": 2, "rows": list(rows.values())}
    catalog = {"schema_version": 1, "airports": {code: {key: row[key] for key in ("name", "lat", "lon", "tz")} for code, row in airports.items()},
               "metros": {code: list(row.get("airports", {})) for code, row in metros.items()}}
    config = {"schema_version": 1, "flights_url": os.environ.get("BROWSER_FLIGHTS_URL", "/api/flights"),
              "osrm_base_url": os.environ.get("OSRM_BASE_URL", "https://router.project-osrm.org"),
              "transit_url": os.environ.get("BROWSER_TRANSIT_URL", "https://api.transitous.org/api/v6/plan"),
              "transit_enabled": os.environ.get("BROWSER_TRANSIT_ENABLED", "true").lower() == "true",
              "contact_url": os.environ.get("TRANSITOUS_CONTACT_URL", "").strip() or "https://github.com/xinghao2003/travel-optimizer"}
    OUTPUT.mkdir(parents=True, exist_ok=True)
    for name, data in (("places", places), ("airports", catalog), ("config", config)):
        (OUTPUT / f"{name}.json").write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"Prepared {len(rows)} places and {len(airports)} airports.")


if __name__ == "__main__":
    main()
