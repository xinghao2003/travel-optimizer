from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass
from functools import lru_cache


@dataclass(frozen=True)
class AirportCity:
    """A searchable city backed by one or more IATA airports."""

    code: str
    flight_code: str
    name: str
    country_code: str
    longitude: float
    latitude: float
    airport_codes: tuple[str, ...]
    timezone_name: str | None = None

    @property
    def label(self) -> str:
        return f"{self.name}, {self.country_code}"


def city_to_dict(city: AirportCity) -> dict:
    return {
        "code": city.code,
        "flight_code": city.flight_code,
        "name": city.name,
        "label": city.label,
        "country_code": city.country_code,
        "longitude": city.longitude,
        "latitude": city.latitude,
        "coordinates": [city.longitude, city.latitude],
        "airport_codes": list(city.airport_codes),
    }


def _normalize(value: str) -> str:
    decomposed = unicodedata.normalize("NFKD", value.casefold())
    return "".join(char for char in decomposed if not unicodedata.combining(char))


@lru_cache(maxsize=1)
def load_airport_cities() -> dict[str, AirportCity]:
    """Load the bundled IATA airport catalog and collapse airports into cities."""
    try:
        import airportsdata
    except ImportError as exc:
        raise RuntimeError("Airport catalog is missing; install backend requirements.") from exc

    airports = airportsdata.load("IATA")
    mac_data = airportsdata.load_iata_macs()
    groups: dict[tuple[str, str], list[tuple[str, dict]]] = {}
    for code, airport in airports.items():
        city = str(airport.get("city") or "").strip()
        country = str(airport.get("country") or "").strip().upper()
        iata = str(airport.get("iata") or code).strip().upper()
        if not city or len(iata) != 3 or not re.fullmatch(r"[A-Z]{3}", iata):
            continue
        groups.setdefault((_normalize(city), country), []).append((iata, airport))

    cities: dict[str, AirportCity] = {}
    for (_, country), members in groups.items():
        codes = tuple(sorted({code for code, _ in members}))
        if not codes:
            continue
        member_by_code = {code: airport for code, airport in members}
        city_name = str(members[0][1].get("city") or members[0][1].get("name") or "").strip()
        matching_macs = [
            (code, details)
            for code, details in mac_data.items()
            if str(details.get("country") or "").upper() == country
            and _normalize(str(details.get("name") or "")) == _normalize(city_name)
            and set(details.get("airports", {})).issubset(codes)
        ]
        matching_macs.sort(key=lambda item: (-len(item[1].get("airports", {})), item[0]))
        mac_code = matching_macs[0][0] if matching_macs else None
        mac_airports = list(matching_macs[0][1].get("airports", {})) if matching_macs else []
        primary_code = next((code for code in mac_airports if code in member_by_code), codes[0])
        primary = member_by_code[primary_code]
        city_name = str(primary.get("city") or primary.get("name") or primary_code).strip()
        city = AirportCity(
            code=primary_code,
            flight_code=mac_code or primary_code,
            name=city_name,
            country_code=country,
            longitude=float(primary["lon"]),
            latitude=float(primary["lat"]),
            airport_codes=codes,
            timezone_name=str(primary.get("tz") or "") or None,
        )
        cities[city.code] = city

    return cities


def search_airport_cities(query: str, limit: int = 16) -> list[AirportCity]:
    needle = _normalize(query.strip())
    if len(needle) < 2:
        return []
    cities = list(load_airport_cities().values())
    def codes(city: AirportCity) -> tuple[str, ...]:
        return tuple(_normalize(code) for code in (city.code, city.flight_code, *city.airport_codes))

    matches = [
        city
        for city in cities
        if needle in _normalize(f"{city.name} {city.country_code}")
        or any(needle in code for code in codes(city))
    ]
    matches.sort(
        key=lambda city: (
            _normalize(city.name) != needle,
            needle not in codes(city),
            not _normalize(city.name).startswith(needle),
            not any(code.startswith(needle) for code in codes(city)),
            city.name.casefold(),
            city.country_code,
        )
    )
    return matches[: max(1, min(limit, 30))]
