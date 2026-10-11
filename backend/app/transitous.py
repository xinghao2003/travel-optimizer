from __future__ import annotations

import asyncio
import hashlib
import json
import os
import sqlite3
import threading
import time as clock
from dataclasses import dataclass
from datetime import date, datetime, time, timezone
from pathlib import Path
from typing import Any
from urllib.parse import urlencode

import httpx

DEFAULT_API_BASE_URL = "https://api.transitous.org/api"
DEFAULT_ROUTE_TTL_SECONDS = 6 * 60 * 60
DEFAULT_EMPTY_ROUTE_TTL_SECONDS = 15 * 60
DEFAULT_GEOCODE_TTL_SECONDS = 30 * 24 * 60 * 60
DEFAULT_EMPTY_GEOCODE_TTL_SECONDS = 7 * 24 * 60 * 60


@dataclass(frozen=True)
class TransitPlace:
    latitude: float
    longitude: float
    timezone_name: str | None


@dataclass(frozen=True)
class RailOption:
    duration_minutes: int
    departure_time: str
    arrival_time: str
    departure_timezone: str | None
    arrival_timezone: str | None
    from_stop: str
    to_stop: str
    service_names: tuple[str, ...]
    operators: tuple[str, ...]


@dataclass(frozen=True)
class RailSearchOutcome:
    options: tuple[RailOption, ...] = ()
    error: str | None = None
    no_results: bool = False


def _cache_path() -> Path:
    if os.name == "nt":
        root = Path(os.environ.get("LOCALAPPDATA") or (Path.home() / "AppData" / "Local"))
    else:
        root = Path(os.environ.get("XDG_CACHE_HOME") or (Path.home() / ".cache"))
    return root / "Wayfinder Routes" / "transitous-cache.sqlite3"


class _SQLiteTTLCache:
    def __init__(self, path: Path):
        self.path = path
        self._lock = threading.Lock()

    def get(self, key: str) -> Any | None:
        try:
            with self._lock:
                self.path.parent.mkdir(parents=True, exist_ok=True)
                with sqlite3.connect(self.path, timeout=5) as connection:
                    connection.execute(
                        "CREATE TABLE IF NOT EXISTS cache (key TEXT PRIMARY KEY, payload TEXT NOT NULL, expires_at REAL NOT NULL)"
                    )
                    row = connection.execute(
                        "SELECT payload, expires_at FROM cache WHERE key = ?", (key,)
                    ).fetchone()
                    if row is None:
                        return None
                    if float(row[1]) <= clock.time():
                        connection.execute("DELETE FROM cache WHERE key = ?", (key,))
                        return None
                    return json.loads(row[0])
        except (OSError, sqlite3.Error, json.JSONDecodeError, TypeError, ValueError):
            return None

    def set(self, key: str, payload: Any, ttl_seconds: int) -> None:
        if ttl_seconds <= 0:
            return
        try:
            serialized = json.dumps(payload, separators=(",", ":"), ensure_ascii=False)
            with self._lock:
                self.path.parent.mkdir(parents=True, exist_ok=True)
                with sqlite3.connect(self.path, timeout=5) as connection:
                    connection.execute(
                        "CREATE TABLE IF NOT EXISTS cache (key TEXT PRIMARY KEY, payload TEXT NOT NULL, expires_at REAL NOT NULL)"
                    )
                    connection.execute("DELETE FROM cache WHERE expires_at <= ?", (clock.time(),))
                    connection.execute(
                        "INSERT INTO cache(key, payload, expires_at) VALUES(?, ?, ?) "
                        "ON CONFLICT(key) DO UPDATE SET payload = excluded.payload, expires_at = excluded.expires_at",
                        (key, serialized, clock.time() + ttl_seconds),
                    )
        except (OSError, sqlite3.Error, TypeError, ValueError):
            # Cache failures should never make trip planning unavailable.
            return


def _positive_env(name: str, default: int) -> int:
    try:
        return max(0, int(os.environ.get(name, default)))
    except (TypeError, ValueError):
        return default


def _match_list(payload: Any) -> list[dict[str, Any]]:
    if isinstance(payload, list):
        return [item for item in payload if isinstance(item, dict)]
    if isinstance(payload, dict):
        for key in ("matches", "results", "places"):
            value = payload.get(key)
            if isinstance(value, list):
                return [item for item in value if isinstance(item, dict)]
    return []


def _number(value: Any) -> float | None:
    try:
        parsed = float(value)
        return parsed if parsed == parsed else None
    except (TypeError, ValueError):
        return None


def _nested_name(value: Any) -> str | None:
    if isinstance(value, str):
        return value.strip() or None
    if isinstance(value, dict):
        for key in ("name", "shortName", "longName"):
            name = value.get(key)
            if isinstance(name, str) and name.strip():
                return name.strip()
    return None


def _parse_datetime(value: Any) -> datetime | None:
    if isinstance(value, (int, float)):
        try:
            return datetime.fromtimestamp(value, timezone.utc)
        except (OverflowError, OSError, ValueError):
            return None
    if isinstance(value, str):
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
            return parsed
        except ValueError:
            return None
    return None


def _iso(value: datetime) -> str:
    return value.isoformat(timespec="minutes")


def _itinerary_to_option(itinerary: dict[str, Any]) -> RailOption | None:
    legs = itinerary.get("legs")
    if not isinstance(legs, list):
        return None
    rail_legs: list[dict[str, Any]] = []
    for leg in legs:
        if not isinstance(leg, dict):
            continue
        mode = str(leg.get("mode") or "").upper()
        if mode not in {"WALK", "FOOT", "BIKE", "BICYCLE", "CAR", "WAIT", "TRANSFER"}:
            rail_legs.append(leg)
    if not rail_legs:
        return None

    all_legs = [leg for leg in legs if isinstance(leg, dict)]
    start = _parse_datetime(itinerary.get("startTime")) or next(
        (_parse_datetime(leg.get("startTime") or leg.get("scheduledStartTime")) for leg in all_legs
         if _parse_datetime(leg.get("startTime") or leg.get("scheduledStartTime")) is not None),
        None,
    )
    end = _parse_datetime(itinerary.get("endTime")) or next(
        (_parse_datetime(leg.get("endTime") or leg.get("scheduledEndTime")) for leg in reversed(all_legs)
         if _parse_datetime(leg.get("endTime") or leg.get("scheduledEndTime")) is not None),
        None,
    )
    raw_duration = _number(itinerary.get("duration"))
    if raw_duration is None or raw_duration <= 0:
        raw_duration = sum((_number(leg.get("duration")) or 0) for leg in all_legs)
    if start is None or end is None:
        return None
    if raw_duration is not None and raw_duration > 0:
        duration_minutes = max(1, round(raw_duration / 60))
    elif end > start:
        duration_minutes = max(1, round((end - start).total_seconds() / 60))
    else:
        return None

    train_departure = _parse_datetime(
        rail_legs[0].get("scheduledStartTime") or rail_legs[0].get("startTime")
    ) or start
    train_arrival = _parse_datetime(
        rail_legs[-1].get("scheduledEndTime") or rail_legs[-1].get("endTime")
    ) or end
    from_stop = _nested_name(rail_legs[0].get("from")) or "Station"
    to_stop = _nested_name(rail_legs[-1].get("to")) or "Station"
    services: list[str] = []
    operators: list[str] = []
    for leg in rail_legs:
        name = next((
            str(leg.get(key)).strip()
            for key in ("displayName", "routeShortName", "routeLongName", "tripShortName", "headsign")
            if isinstance(leg.get(key), str) and str(leg.get(key)).strip()
        ), None)
        if not name:
            category = leg.get("category")
            name = _nested_name(category)
        if name and name not in services:
            services.append(name)
        operator = _nested_name(leg.get("agencyName"))
        if operator and operator not in operators:
            operators.append(operator)

    return RailOption(
        duration_minutes=duration_minutes,
        departure_time=_iso(train_departure),
        arrival_time=_iso(train_arrival),
        departure_timezone=None,
        arrival_timezone=None,
        from_stop=from_stop,
        to_stop=to_stop,
        service_names=tuple(services),
        operators=tuple(operators),
    )


class TransitousClient:
    """Small Transitous/MOTIS client with a persistent local response cache."""

    def __init__(self) -> None:
        self.base_url = os.environ.get("TRANSITOUS_API_BASE_URL", DEFAULT_API_BASE_URL).rstrip("/")
        self.contact_url = os.environ.get("TRANSITOUS_CONTACT_URL", "").strip()
        user_agent = "WayfinderRoutes/1.1" + (f" ({self.contact_url})" if self.contact_url else "")
        self._http = httpx.AsyncClient(
            timeout=httpx.Timeout(25.0, connect=10.0),
            headers={"User-Agent": user_agent, "Accept": "application/json"},
            limits=httpx.Limits(max_connections=2, max_keepalive_connections=2),
        )
        self._cache = _SQLiteTTLCache(_cache_path())
        self.route_ttl = _positive_env("TRANSITOUS_ROUTE_TTL_SECONDS", DEFAULT_ROUTE_TTL_SECONDS)
        self.empty_route_ttl = _positive_env(
            "TRANSITOUS_EMPTY_ROUTE_TTL_SECONDS", DEFAULT_EMPTY_ROUTE_TTL_SECONDS
        )
        self.geocode_ttl = _positive_env("TRANSITOUS_GEOCODE_TTL_SECONDS", DEFAULT_GEOCODE_TTL_SECONDS)
        self.empty_geocode_ttl = _positive_env(
            "TRANSITOUS_EMPTY_GEOCODE_TTL_SECONDS", DEFAULT_EMPTY_GEOCODE_TTL_SECONDS
        )
        self._request_locks: dict[str, asyncio.Lock] = {}
        self._lock_guard = asyncio.Lock()
        self._route_semaphore = asyncio.Semaphore(2)
        self._geocode_semaphore = asyncio.Semaphore(2)
        self.reset_counters()

    def reset_counters(self) -> None:
        self.cache_hits = 0
        self.api_requests = 0
        self.api_failures = 0

    async def close(self) -> None:
        await self._http.aclose()

    async def _lock_for(self, key: str) -> asyncio.Lock:
        async with self._lock_guard:
            return self._request_locks.setdefault(key, asyncio.Lock())

    async def _get_json(
        self,
        path: str,
        params: dict[str, str],
        *,
        ttl_seconds: int,
        empty_ttl_seconds: int,
        is_empty,
    ) -> Any:
        key_material = self.base_url + path + "?" + urlencode(sorted(params.items()))
        key = hashlib.sha256(key_material.encode("utf-8")).hexdigest()
        if not self.contact_url:
            raise RuntimeError("Set TRANSITOUS_CONTACT_URL before enabling Transitous routing.")
        cached = self._cache.get(key)
        if cached is not None:
            self.cache_hits += 1
            return cached

        request_lock = await self._lock_for(key)
        async with request_lock:
            cached = self._cache.get(key)
            if cached is not None:
                self.cache_hits += 1
                return cached
            self.api_requests += 1
            try:
                response = await self._http.get(f"{self.base_url}{path}", params=params)
                response.raise_for_status()
                payload = response.json()
            except (httpx.HTTPError, ValueError) as exc:
                self.api_failures += 1
                raise RuntimeError(f"Transitous request failed: {type(exc).__name__}.") from exc
            self._cache.set(key, payload, empty_ttl_seconds if is_empty(payload) else ttl_seconds)
            return payload

    async def geocode(self, city) -> TransitPlace | None:
        query = f"{city.name}, {city.country_code}"
        params = {
            "text": query,
            "type": "PLACE",
            "place": f"{city.latitude:.6f},{city.longitude:.6f}",
        }
        async with self._geocode_semaphore:
            payload = await self._get_json(
                "/v1/geocode",
                params,
                ttl_seconds=self.geocode_ttl,
                empty_ttl_seconds=self.empty_geocode_ttl,
                is_empty=lambda response: not _match_list(response),
            )
        for match in _match_list(payload):
            lat = _number(match.get("lat") or match.get("latitude"))
            lon = _number(match.get("lon") or match.get("lng") or match.get("longitude"))
            if lat is None or lon is None:
                continue
            tz_name = match.get("tz") or match.get("timezone") or match.get("timeZone")
            return TransitPlace(lat, lon, str(tz_name) if tz_name else None)
        return None

    async def search_rail(
        self,
        day: date,
        local_time: time,
        from_place: TransitPlace,
        to_place: TransitPlace,
    ) -> RailSearchOutcome:
        params = {
            "fromPlace": f"{from_place.latitude:.6f},{from_place.longitude:.6f}",
            "toPlace": f"{to_place.latitude:.6f},{to_place.longitude:.6f}",
            # MOTIS interprets its routing time in the departure place's local
            # timezone; the stable Transitous client uses YYYY-MM-DDTHH:mm.
            "time": f"{day.isoformat()}T{local_time.strftime('%H:%M')}",
            "arriveBy": "false",
            "transitModes": "RAIL",
            "timetableView": "true",
            "searchWindow": "900",
            "numItineraries": "3",
            "joinInterlinedLegs": "false",
        }
        try:
            async with self._route_semaphore:
                payload = await self._get_json(
                    "/v6/plan",
                    params,
                    ttl_seconds=self.route_ttl,
                    empty_ttl_seconds=self.empty_route_ttl,
                    is_empty=lambda response: not (
                        isinstance(response, dict) and isinstance(response.get("itineraries"), list)
                        and response.get("itineraries")
                    ),
                )
        except RuntimeError as exc:
            return RailSearchOutcome(error=str(exc))

        itineraries = payload.get("itineraries", []) if isinstance(payload, dict) else []
        options = [
            option
            for option in (_itinerary_to_option(item) for item in itineraries if isinstance(item, dict))
            if option is not None
        ]
        options.sort(key=lambda option: (option.duration_minutes, option.departure_time))
        if not options:
            return RailSearchOutcome(no_results=True)
        return RailSearchOutcome(options=tuple(
            RailOption(
                duration_minutes=option.duration_minutes,
                departure_time=option.departure_time,
                arrival_time=option.arrival_time,
                departure_timezone=from_place.timezone_name,
                arrival_timezone=to_place.timezone_name,
                from_stop=option.from_stop,
                to_stop=option.to_stop,
                service_names=option.service_names,
                operators=option.operators,
            )
            for option in options
        ))


transitous = TransitousClient()
