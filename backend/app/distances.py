from __future__ import annotations

import asyncio
import json
import math
import os
import time
from pathlib import Path
from typing import Any

import httpx

from .data import CityRecord, PROJECT_ROOT

CACHE_PATH = PROJECT_ROOT / "backend" / "data" / "road_distance_cache.json"
OSRM_BASE_URL = os.getenv("OSRM_BASE_URL", "https://router.project-osrm.org").rstrip("/")
NEGATIVE_CACHE_SECONDS = 60 * 60
FAILURE_COOLDOWN_SECONDS = 5 * 60


class RoadDistanceCache:
    def __init__(self) -> None:
        self._lock = asyncio.Lock()
        self._distances: dict[str, float] = {}
        self._unavailable: dict[str, float] = {}
        self._failure_until = 0.0
        self._failure_message: str | None = None
        self._load()

    def _load(self) -> None:
        if not CACHE_PATH.exists():
            return
        try:
            payload = json.loads(CACHE_PATH.read_text(encoding="utf-8"))
            self._distances = {str(key): float(value) for key, value in payload.get("distances_m", {}).items()}
            self._unavailable = {str(key): float(value) for key, value in payload.get("unavailable_at", {}).items()}
        except (OSError, ValueError, TypeError):
            self._distances = {}
            self._unavailable = {}

    def _save(self) -> None:
        CACHE_PATH.parent.mkdir(parents=True, exist_ok=True)
        temporary = CACHE_PATH.with_suffix(".tmp")
        temporary.write_text(
            json.dumps({"distances_m": self._distances, "unavailable_at": self._unavailable}, indent=2),
            encoding="utf-8",
        )
        temporary.replace(CACHE_PATH)

    async def ensure(
        self,
        cities: list[CityRecord],
        origin_codes: list[str],
        destination_codes: list[str],
    ) -> tuple[dict[str, float], int, str | None]:
        city_by_code = {city.code: city for city in cities}
        origin_codes = list(dict.fromkeys(origin_codes))
        destination_codes = list(dict.fromkeys(destination_codes))
        required = [
            f"{origin}->{destination}"
            for origin in origin_codes
            for destination in destination_codes
            if origin != destination
        ]
        if not required:
            return {}, 0, None

        async with self._lock:
            now = time.time()
            for key, checked_at in list(self._unavailable.items()):
                if now - checked_at >= NEGATIVE_CACHE_SECONDS:
                    del self._unavailable[key]

            missing = [key for key in required if key not in self._distances and key not in self._unavailable]
            error: str | None = None
            if missing and now < self._failure_until:
                error = self._failure_message or "OSRM is temporarily unavailable."
            elif missing:
                try:
                    await self._fetch_matrix(city_by_code, origin_codes, destination_codes)
                    self._failure_message = None
                    self._failure_until = 0.0
                except (httpx.HTTPError, ValueError, KeyError, TypeError) as exc:
                    error = f"OSRM could not provide road distances: {exc}"
                    self._failure_message = error
                    self._failure_until = time.time() + FAILURE_COOLDOWN_SECONDS

            available = {key: self._distances[key] for key in required if key in self._distances}
            unavailable_count = sum(1 for key in required if key not in self._distances)
            if unavailable_count and error is None:
                error = f"OSRM returned no road route for {unavailable_count} city pair(s)."
            return available, unavailable_count, error

    async def _fetch_matrix(
        self,
        city_by_code: dict[str, CityRecord],
        origin_codes: list[str],
        destination_codes: list[str],
    ) -> None:
        coordinate_codes = list(dict.fromkeys(origin_codes + destination_codes))
        indices = {code: index for index, code in enumerate(coordinate_codes)}
        coordinate_path = ";".join(
            f"{city_by_code[code].longitude},{city_by_code[code].latitude}" for code in coordinate_codes
        )
        params = {
            "sources": ";".join(str(indices[code]) for code in origin_codes),
            "destinations": ";".join(str(indices[code]) for code in destination_codes),
            "annotations": "distance",
        }
        url = f"{OSRM_BASE_URL}/table/v1/driving/{coordinate_path}"
        async with httpx.AsyncClient(timeout=httpx.Timeout(30.0, connect=10.0)) as client:
            response = await client.get(url, params=params)
        response.raise_for_status()
        payload: dict[str, Any] = response.json()
        if payload.get("code") != "Ok":
            raise ValueError(payload.get("message") or payload.get("code") or "invalid OSRM response")

        matrix = payload["distances"]
        now = time.time()
        for row_index, origin in enumerate(origin_codes):
            for column_index, destination in enumerate(destination_codes):
                if origin == destination:
                    continue
                key = f"{origin}->{destination}"
                distance = matrix[row_index][column_index]
                if distance is None:
                    self._unavailable[key] = now
                    self._distances.pop(key, None)
                else:
                    self._distances[key] = float(distance)
                    self._unavailable.pop(key, None)
        self._save()


road_distances = RoadDistanceCache()


def great_circle_distance_m(origin: CityRecord, destination: CityRecord) -> float:
    """Return the direct distance used as an explicitly hypothetical connection proxy."""
    latitude1 = math.radians(origin.latitude)
    latitude2 = math.radians(destination.latitude)
    latitude_delta = latitude2 - latitude1
    longitude_delta = math.radians(destination.longitude - origin.longitude)
    haversine = (
        math.sin(latitude_delta / 2) ** 2
        + math.cos(latitude1) * math.cos(latitude2) * math.sin(longitude_delta / 2) ** 2
    )
    return 2 * 6_371_000 * math.asin(math.sqrt(min(1.0, haversine)))

