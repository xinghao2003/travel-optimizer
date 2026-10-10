from __future__ import annotations

import argparse
import json
import logging
import re
import unicodedata
import urllib.request
import zipfile
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import TextIO

PROJECT_ROOT = Path(__file__).resolve().parents[2]
GEONAMES_DIR = PROJECT_ROOT / "data" / "geonames"
DATASET_PATH = GEONAMES_DIR / "cities500.zip"
CACHE_PATH = PROJECT_ROOT / "backend" / "data" / "city_coordinate_cache.json"
DATASET_URL = "https://download.geonames.org/export/dump/cities500.zip"
logger = logging.getLogger(__name__)


def normalize_place_name(value: str) -> str:
    folded = unicodedata.normalize("NFKD", value).casefold()
    ascii_text = "".join(char for char in folded if not unicodedata.combining(char))
    return re.sub(r"[^\w]+", " ", ascii_text, flags=re.UNICODE).strip()


def coordinate_cache_key(code: str, name: str) -> str:
    return f"{code.casefold()}|{normalize_place_name(name)}"


@dataclass(frozen=True)
class CityCoordinate:
    name: str
    latitude: float
    longitude: float
    country_code: str | None
    geoname_id: int | None
    source: str
    population: int | None = None


class GeoNamesStore:
    """Resolve city labels from the local GeoNames cities500 extract and cache points."""

    def __init__(self, dataset_path: Path = DATASET_PATH, cache_path: Path = CACHE_PATH) -> None:
        self.dataset_path = dataset_path
        self.cache_path = cache_path
        self._cache: dict[str, dict] = {}
        self._load_cache()

    @property
    def dataset_available(self) -> bool:
        return self.dataset_path.is_file()

    def _load_cache(self) -> None:
        try:
            payload = json.loads(self.cache_path.read_text(encoding="utf-8"))
            entries = payload.get("coordinates", {})
            if isinstance(entries, dict):
                self._cache = {str(key): value for key, value in entries.items() if isinstance(value, dict)}
        except FileNotFoundError:
            self._cache = {}
        except (OSError, ValueError, TypeError) as exc:
            logger.warning("Could not read city coordinate cache %s: %s", self.cache_path, exc)
            self._cache = {}

    def cached(self, code: str, name: str) -> CityCoordinate | None:
        entry = self._cache.get(coordinate_cache_key(code, name))
        if entry is None:
            return None
        try:
            return CityCoordinate(
                name=str(entry.get("name") or name),
                latitude=float(entry["latitude"]),
                longitude=float(entry["longitude"]),
                country_code=str(entry["country_code"]).upper() if entry.get("country_code") else None,
                geoname_id=int(entry["geoname_id"]) if entry.get("geoname_id") is not None else None,
                source=str(entry.get("source") or "cache"),
                population=int(entry["population"]) if entry.get("population") is not None else None,
            )
        except (KeyError, TypeError, ValueError):
            return None

    def remember(self, code: str, query_name: str, coordinate: CityCoordinate) -> None:
        self._cache[coordinate_cache_key(code, query_name)] = asdict(coordinate)
        self._save_cache()

    def resolve_many(self, names: list[str]) -> dict[str, CityCoordinate]:
        wanted = {normalize_place_name(name) for name in names if normalize_place_name(name)}
        if not wanted or not self.dataset_available:
            if wanted and not self.dataset_available:
                logger.info(
                    "GeoNames dataset is not installed; unknown city names will be skipped. "
                    "Run `python backend/app/geonames.py --download` to install it."
                )
            return {}

        matches: dict[str, tuple[tuple[int, int, str], CityCoordinate]] = {}
        try:
            with self._open_places_file() as stream:
                for line in stream:
                    fields = line.rstrip("\r\n").split("\t")
                    if len(fields) < 15 or fields[6] != "P":
                        continue
                    try:
                        point = CityCoordinate(
                            name=fields[1],
                            latitude=float(fields[4]),
                            longitude=float(fields[5]),
                            country_code=fields[8].upper() or None,
                            geoname_id=int(fields[0]),
                            source="geonames",
                            population=int(fields[14] or 0),
                        )
                    except (ValueError, IndexError):
                        continue

                    primary = {normalize_place_name(fields[1]), normalize_place_name(fields[2])}
                    aliases = {normalize_place_name(alias) for alias in fields[3].split(",") if alias}
                    for key in wanted.intersection(primary | aliases):
                        is_primary_match = int(key in primary)
                        rank = (is_primary_match, point.population or 0, point.name.casefold())
                        previous = matches.get(key)
                        if previous is None or rank > previous[0]:
                            matches[key] = (rank, point)
        except (OSError, zipfile.BadZipFile, KeyError) as exc:
            logger.warning("Could not search GeoNames dataset %s: %s", self.dataset_path, exc)
            return {}

        return {key: value[1] for key, value in matches.items()}

    def _open_places_file(self) -> TextIO:
        if self.dataset_path.suffix.lower() == ".zip":
            archive = zipfile.ZipFile(self.dataset_path)
            member = next(
                (name for name in archive.namelist() if Path(name).name in {"cities500.txt", "allCountries.txt"}),
                None,
            )
            if member is None:
                archive.close()
                raise KeyError("no cities500.txt or allCountries.txt member found")
            import io

            raw = archive.open(member)
            return _ArchiveTextStream(archive, io.TextIOWrapper(raw, encoding="utf-8", errors="replace"))
        return self.dataset_path.open("r", encoding="utf-8", errors="replace")

    def _save_cache(self) -> None:
        self.cache_path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.cache_path.with_suffix(".tmp")
        temporary.write_text(json.dumps({"coordinates": self._cache}, ensure_ascii=False, indent=2), encoding="utf-8")
        temporary.replace(self.cache_path)


class _ArchiveTextStream:
    def __init__(self, archive: zipfile.ZipFile, stream: TextIO) -> None:
        self.archive = archive
        self.stream = stream

    def __enter__(self) -> TextIO:
        return self.stream

    def __exit__(self, exc_type, exc, traceback) -> None:
        self.stream.close()
        self.archive.close()


def download_dataset() -> Path:
    GEONAMES_DIR.mkdir(parents=True, exist_ok=True)
    temporary = DATASET_PATH.with_suffix(".download")
    request = urllib.request.Request(
        DATASET_URL,
        headers={"User-Agent": "WayfinderRouteOptimizer/1.0 (local GeoNames dataset setup)"},
    )
    try:
        with urllib.request.urlopen(request, timeout=60) as response, temporary.open("wb") as output:
            while chunk := response.read(1024 * 256):
                output.write(chunk)
        with zipfile.ZipFile(temporary) as archive:
            if not any(Path(name).name == "cities500.txt" for name in archive.namelist()):
                raise zipfile.BadZipFile("archive does not contain cities500.txt")
        temporary.replace(DATASET_PATH)
    finally:
        temporary.unlink(missing_ok=True)
    return DATASET_PATH


def main() -> None:
    parser = argparse.ArgumentParser(description="Download the free GeoNames cities500 coordinate dataset.")
    parser.add_argument("--download", action="store_true", help="download cities500.zip into data/geonames")
    args = parser.parse_args()
    if not args.download:
        parser.print_help()
        return
    path = download_dataset()
    print(f"Downloaded GeoNames city data to {path}")
    print("Data source: GeoNames, Creative Commons Attribution 4.0 (CC BY 4.0).")


if __name__ == "__main__":
    main()
