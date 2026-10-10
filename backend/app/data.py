from __future__ import annotations

import logging
import re
from collections import Counter
from dataclasses import asdict, dataclass
from datetime import datetime
from html import unescape
from pathlib import Path
from typing import Literal
from urllib.parse import parse_qs, urljoin, urlparse

from bs4 import BeautifulSoup

from .geonames import CityCoordinate, GeoNamesStore, normalize_place_name

PROJECT_ROOT = Path(__file__).resolve().parents[2]
INPUT_DIR = PROJECT_ROOT / "data" / "inputs"
logger = logging.getLogger(__name__)

# Approximate fallback coordinates in [longitude, latitude] order. The GeoNames
# dataset is used first when present; this small catalog keeps known snapshots usable offline.
CITY_CATALOG: dict[str, tuple[str, float, float]] = {
    "cnng": ("Nanning", 108.3669, 22.8170),
    "hkga": ("Hong Kong", 114.1694, 22.3193),
    "cwuh": ("Wuhan", 114.3054, 30.5931),
    "ccan": ("Guangzhou", 113.2644, 23.1291),
    "cctu": ("Chengdu", 104.0665, 30.5728),
    "cszx": ("Shenzhen", 114.0579, 22.5431),
    "chgh": ("Hangzhou", 120.1551, 30.2741),
    "csha": ("Shanghai", 121.4737, 31.2304),
    "ckwe": ("Guiyang", 106.6302, 26.6470),
    "chak": ("Haikou", 110.1983, 20.0440),
    "xian": ("Xi'an", 108.9398, 34.3416),
    "ckmg": ("Kunming", 102.8329, 24.8801),
    "cswa": ("Shantou", 116.6822, 23.3535),
    "mfma": ("Macau", 113.5439, 22.1987),
    "cnkg": ("Nanjing", 118.7969, 32.0603),
    "cckg": ("Chongqing", 106.5516, 29.5630),
    "ccgo": ("Zhengzhou", 113.6254, 34.7466),
    "ccsx": ("Changsha", 112.9388, 28.2282),
    "ctao": ("Qingdao", 120.3826, 36.0671),
    "cxmn": ("Xiamen", 118.0894, 24.4798),
    "cfoc": ("Fuzhou", 119.2965, 26.0745),
    "bjsa": ("Beijing", 116.4074, 39.9042),
    "jina": ("Jinan", 117.1201, 36.6512),
    "cwux": ("Wuxi", 120.3119, 31.4912),
    "barb": ("Qionghai", 110.4668, 19.2469),
    "sela": ("Seoul", 126.9780, 37.5665),
    "pusa": ("Busan", 129.0756, 35.1796),
    "cjua": ("Jeju", 126.5312, 33.4996),
    "cjja": ("Cheongju", 127.4890, 36.6424),
    "taea": ("Daegu", 128.6014, 35.8714),
    "usna": ("Ulsan", 129.3114, 35.5384),
    "kwja": ("Gwangju", 126.9160, 35.1550),
    "kpoa": ("Pohang", 129.3820, 36.0297),
    "rsua": ("Yeosu", 127.6622, 34.7604),
    "hina": ("Jinju", 128.1076, 35.1798),
}
CITY_COUNTRY_CODES = {code: "CN" for code in CITY_CATALOG}
CITY_COUNTRY_CODES.update({"hkga": "HK", "mfma": "MO"})
CITY_COUNTRY_CODES.update(
    {code: "KR" for code in ("sela", "pusa", "cjua", "cjja", "taea", "usna", "kwja", "kpoa", "rsua", "hina")}
)

KUL = {"name": "Kuala Lumpur", "code": "KUL", "longitude": 101.6869, "latitude": 3.1390}
KUL_CODES = {"kul", "kulm"}
CITY_CATALOG["kul"] = (KUL["name"], KUL["longitude"], KUL["latitude"])
CITY_COUNTRY_CODES["kul"] = "MY"
SUPPORTED_INPUT_SUFFIXES = {".txt", ".html", ".htm"}

Direction = Literal["outbound", "return"]
JourneyType = Literal["one_way", "round_trip"]

_FLIGHT_PATH = re.compile(
    r"/transport/flights/([^/?#]+)/([^/?#]+)/(\d{6})(?:/(\d{6}))?/?",
    re.I,
)
_PRICE = re.compile(r"\bRM\s*([\d,]+(?:\.\d{1,2})?)", re.I)
_OUTBOUND_CITY = re.compile(r"(?:flights to|explore flights to)\s+(.+?)(?:\s+from\s+RM\b.*)?$", re.I)
_RETURN_CITY = re.compile(
    r"(?:flights from|from)\s+(.+?)(?:\s+from\s+RM\b|\s+flights from\b|\s+get prices\b|\s+\d+\+?\s+stops?\b|[.]|$)",
    re.I,
)
_STOPS = re.compile(r"\b(\d+)\s*(\+)?\s*stops?\b", re.I)


@dataclass
class ImportedFlight:
    source_file: str
    origin_code: str
    destination_code: str
    origin_name: str
    destination_name: str
    departure_date: str
    return_date: str | None
    journey_type: JourneyType
    price_myr: float | None
    booking_url: str
    direct: bool | None
    stop_count: int | None
    stops_label: str | None


@dataclass
class FlightListing:
    direction: Direction
    price_myr: float | None
    booking_url: str
    snapshot_date: str | None
    skyscanner_origin_code: str
    skyscanner_destination_code: str
    direct: bool | None
    stop_count: int | None = None
    stops_label: str | None = None
    source_file: str | None = None


@dataclass
class CityRecord:
    code: str
    name: str
    longitude: float
    latitude: float
    country_code: str | None = None
    geoname_id: int | None = None
    coordinate_source: str = "curated"
    outbound: FlightListing | None = None
    return_flight: FlightListing | None = None


@dataclass
class OriginRecord:
    code: str
    name: str
    longitude: float
    latitude: float
    country_code: str | None = None


def _snapshot_date(value: str | None) -> str | None:
    if not value:
        return None
    try:
        return datetime.strptime(value, "%y%m%d").date().isoformat()
    except ValueError:
        return None


def _canonical_city_code(code: str) -> str:
    code = code.lower()
    return "kul" if code in KUL_CODES else code


def _city_name(code: str, endpoint: Literal["origin", "destination"], anchor, content: str) -> str:
    if code in KUL_CODES:
        return KUL["name"]
    catalog_entry = CITY_CATALOG.get(code)
    if catalog_entry:
        return catalog_entry[0]

    heading = anchor.find("h2")
    if heading:
        return heading.get_text(" ", strip=True)

    candidates = [
        unescape(str(anchor.get("aria-label", ""))).replace("\xa0", " "),
        " ".join(anchor.stripped_strings),
        content,
    ]
    pattern = _RETURN_CITY if endpoint == "origin" else _OUTBOUND_CITY
    for candidate in candidates:
        match = pattern.search(candidate)
        if match:
            return match.group(1).strip(" .·")
    return code.upper()


def _parse_anchor(anchor, source_file: str) -> ImportedFlight | None:
    raw_href = anchor.get("href")
    if not isinstance(raw_href, str):
        return None

    booking_url = urljoin("https://www.skyscanner.com.my", unescape(raw_href))
    parsed_url = urlparse(booking_url)
    route_match = _FLIGHT_PATH.search(parsed_url.path)
    if not route_match:
        return None

    origin_code, destination_code, departure_code, return_code = (
        part.lower() if part else None for part in route_match.groups()
    )
    if not origin_code or not destination_code:
        return None
    origin_code = _canonical_city_code(origin_code)
    destination_code = _canonical_city_code(destination_code)
    if origin_code == destination_code:
        return None

    departure_date = _snapshot_date(departure_code)
    return_date = _snapshot_date(return_code)
    if departure_date is None:
        return None

    query = parse_qs(parsed_url.query)
    is_round_trip = return_date is not None or query.get("rtn", ["0"])[0] == "1"
    content = unescape(
        " ".join(
            [
                str(anchor.get("aria-label", "")),
                " ".join(anchor.stripped_strings),
            ]
        )
    ).replace("\xa0", " ")

    price_match = _PRICE.search(content)
    price = float(price_match.group(1).replace(",", "")) if price_match else None
    stop_match = _STOPS.search(content)
    if stop_match:
        stop_count = int(stop_match.group(1))
        plus = "+" if stop_match.group(2) else ""
        unit = "stop" if stop_count == 1 and not plus else "stops"
        stops_label = f"{stop_count}{plus} {unit}"
        direct: bool | None = False
    elif re.search(r"\bnon[- ]?stop\b|\bdirect\b", content, re.I):
        stop_count = 0
        stops_label = "Direct"
        direct = True
    elif re.search(r"\bindirect\b", content, re.I):
        stop_count = None
        stops_label = "Indirect"
        direct = False
    else:
        stop_count = None
        stops_label = None
        direct = None

    origin_name = _city_name(origin_code, "origin", anchor, content)
    destination_name = _city_name(destination_code, "destination", anchor, content)
    return ImportedFlight(
        source_file=source_file,
        origin_code=origin_code,
        destination_code=destination_code,
        origin_name=origin_name,
        destination_name=destination_name,
        departure_date=departure_date,
        return_date=return_date,
        journey_type="round_trip" if is_round_trip else "one_way",
        price_myr=price,
        booking_url=booking_url,
        direct=direct,
        stop_count=stop_count,
        stops_label=stops_label,
    )


def load_input_flights() -> tuple[list[ImportedFlight], list[dict]]:
    """Import supported Skyscanner links from every text/HTML file under data/inputs."""
    flights: list[ImportedFlight] = []
    file_statuses: list[dict] = []
    if not INPUT_DIR.exists():
        logger.warning("Flight input directory does not exist: %s", INPUT_DIR)
        return flights, file_statuses

    files = sorted(path for path in INPUT_DIR.rglob("*") if path.is_file())
    if not files:
        logger.warning("No input files found under %s", INPUT_DIR)
        return flights, file_statuses

    for path in files:
        relative_name = path.relative_to(INPUT_DIR).as_posix()
        if path.suffix.lower() not in SUPPORTED_INPUT_SUFFIXES:
            reason = f"unsupported file type {path.suffix or '(no extension)'}"
            logger.info("Skipping input %s: %s", relative_name, reason)
            file_statuses.append(
                {"source_file": relative_name, "status": "skipped", "parsed_count": 0, "reason": reason}
            )
            continue

        try:
            soup = BeautifulSoup(path.read_text(encoding="utf-8", errors="replace"), "html.parser")
            anchors = soup.select('a[href*="/transport/flights/"]')
            parsed_for_file: list[ImportedFlight] = []
            seen: set[tuple[str, str, str, str | None, float | None, str]] = set()
            for anchor in anchors:
                try:
                    flight = _parse_anchor(anchor, relative_name)
                except Exception:
                    logger.exception("Could not parse a flight result in %s", relative_name)
                    continue
                if flight is None:
                    continue
                key = (
                    flight.origin_code,
                    flight.destination_code,
                    flight.departure_date,
                    flight.return_date,
                    flight.price_myr,
                    flight.booking_url,
                )
                if key in seen:
                    continue
                seen.add(key)
                parsed_for_file.append(flight)

            if not parsed_for_file:
                reason = "no supported flight-result links found"
                logger.warning("Skipping input %s: %s", relative_name, reason)
                file_statuses.append(
                    {
                        "source_file": relative_name,
                        "status": "skipped",
                        "parsed_count": 0,
                        "reason": reason,
                    }
                )
                continue

            flights.extend(parsed_for_file)
            ignored_count = max(0, len(anchors) - len(parsed_for_file))
            reason = f"{ignored_count} unsupported or duplicate link(s) ignored" if ignored_count else None
            logger.info(
                "Loaded input %s: %d flight result(s), %d ignored link(s)",
                relative_name,
                len(parsed_for_file),
                ignored_count,
            )
            for flight in parsed_for_file:
                price_label = f"RM {flight.price_myr:,.2f}" if flight.price_myr is not None else "fare unavailable"
                trip_dates = flight.departure_date
                if flight.return_date:
                    trip_dates += f" to {flight.return_date}"
                logger.info(
                    "  %s -> %s | %s | %s | %s | %s",
                    flight.origin_name,
                    flight.destination_name,
                    trip_dates,
                    flight.journey_type,
                    flight.stops_label or "stops unknown",
                    price_label,
                )
            file_statuses.append(
                {
                    "source_file": relative_name,
                    "status": "loaded",
                    "parsed_count": len(parsed_for_file),
                    "reason": reason,
                }
            )
        except Exception as exc:
            reason = f"failed to read or parse: {exc}"
            logger.exception("Skipping input %s after a parsing failure", relative_name)
            file_statuses.append(
                {"source_file": relative_name, "status": "failed", "parsed_count": 0, "reason": reason}
            )

    logger.info(
        "Input import complete: %d file(s) scanned, %d flight result(s) parsed, %d skipped/failed file(s)",
        len(file_statuses),
        len(flights),
        sum(status["status"] != "loaded" for status in file_statuses),
    )
    return flights, file_statuses


def resolve_city_coordinates(
    flights: list[ImportedFlight],
) -> tuple[dict[str, CityCoordinate], dict[str, str], bool]:
    """Resolve every imported route endpoint to a GeoNames or curated point."""
    store = GeoNamesStore()
    names_by_code: dict[str, str] = {}
    for flight in flights:
        names_by_code.setdefault(flight.origin_code, flight.origin_name)
        names_by_code.setdefault(flight.destination_code, flight.destination_name)

    cached: dict[str, CityCoordinate] = {}
    missing: list[str] = []
    for code, name in names_by_code.items():
        coordinate = store.cached(code, name)
        if coordinate is not None:
            cached[code] = coordinate
        else:
            missing.append(name)

    geonames_points = store.resolve_many(missing)
    coordinates: dict[str, CityCoordinate] = {}
    unresolved: dict[str, str] = {}
    for code, name in names_by_code.items():
        coordinate = cached.get(code) or geonames_points.get(normalize_place_name(name))
        if coordinate is None and code in CITY_CATALOG:
            city_name, longitude, latitude = CITY_CATALOG[code]
            coordinate = CityCoordinate(
                name=city_name,
                latitude=latitude,
                longitude=longitude,
                country_code=CITY_COUNTRY_CODES.get(code),
                geoname_id=None,
                source="curated",
            )
        if coordinate is None:
            unresolved[code] = name
            logger.warning(
                "No coordinates found for %s (%s); install the GeoNames cities500 dataset to resolve global city names",
                name,
                code,
            )
            continue
        coordinates[code] = coordinate
        store.remember(code, name, coordinate)
        logger.info(
            "Resolved city %s (%s): %.5f, %.5f [%s%s]",
            name,
            code,
            coordinate.latitude,
            coordinate.longitude,
            coordinate.source,
            f", GeoNames ID {coordinate.geoname_id}" if coordinate.geoname_id else "",
        )

    logger.info(
        "City coordinates: %d resolved, %d unresolved; GeoNames dataset %s",
        len(coordinates),
        len(unresolved),
        "available" if store.dataset_available else "not installed",
    )
    return coordinates, unresolved, store.dataset_available


def optimizer_snapshot_dates(
    flights: list[ImportedFlight],
    supported_city_codes: set[str] | None = None,
    origin_code: str = "kul",
) -> dict[str, str | None]:
    """Choose dates for one-way flights to and from the selected loaded origin."""
    origin_code = _canonical_city_code(origin_code)
    supported_codes = supported_city_codes if supported_city_codes is not None else set(CITY_CATALOG)
    eligible = [
        flight
        for flight in flights
        if flight.journey_type == "one_way"
        and flight.origin_code in supported_codes
        and flight.destination_code in supported_codes
    ]
    outbound_dates = Counter(
        flight.departure_date
        for flight in eligible
        if flight.origin_code == origin_code and flight.departure_date
    )
    return_dates = Counter(
        flight.departure_date
        for flight in eligible
        if flight.destination_code == origin_code and flight.departure_date
    )
    dates = {
        "outbound": min(outbound_dates, key=lambda date: (-outbound_dates[date], date)) if outbound_dates else None,
        "return": min(return_dates, key=lambda date: (-return_dates[date], date)) if return_dates else None,
    }
    logger.info(
        "Route optimizer date selection for %s: outbound=%s, return=%s",
        origin_code.upper(),
        dates["outbound"] or "none",
        dates["return"] or "none",
    )
    return dates


def load_origin_records(
    flights: list[ImportedFlight],
    coordinates: dict[str, CityCoordinate],
) -> list[OriginRecord]:
    """Build origin choices from the route origins present in parsed links."""
    codes = {flight.origin_code for flight in flights}
    records = []
    for code in codes:
        coordinate = coordinates.get(code)
        if coordinate is None:
            continue
        name = CITY_CATALOG.get(code, (coordinate.name, 0.0, 0.0))[0]
        records.append(
            OriginRecord(
                code=code,
                name=name,
                longitude=coordinate.longitude,
                latitude=coordinate.latitude,
                country_code=coordinate.country_code,
            )
        )
    return sorted(records, key=lambda item: item.name.casefold())


def _to_city_listing(flight: ImportedFlight, direction: Direction) -> FlightListing:
    return FlightListing(
        direction=direction,
        price_myr=flight.price_myr,
        booking_url=flight.booking_url,
        snapshot_date=flight.departure_date,
        skyscanner_origin_code=flight.origin_code,
        skyscanner_destination_code=flight.destination_code,
        direct=flight.direct,
        stop_count=flight.stop_count,
        stops_label=flight.stops_label,
        source_file=flight.source_file,
    )


def load_city_records(
    flights: list[ImportedFlight],
    selected_dates: dict[str, str | None],
    coordinates: dict[str, CityCoordinate] | None = None,
    origin_code: str = "kul",
) -> list[CityRecord]:
    """Build map points and one-way fares relative to one selected loaded origin."""
    origin_code = _canonical_city_code(origin_code)
    coordinates = coordinates or {
        code: CityCoordinate(
            name=name,
            longitude=longitude,
            latitude=latitude,
            country_code=CITY_COUNTRY_CODES.get(code),
            geoname_id=None,
            source="curated",
        )
        for code, (name, longitude, latitude) in CITY_CATALOG.items()
    }
    records: dict[str, CityRecord] = {}
    for flight in flights:
        if flight.journey_type != "one_way":
            continue
        if flight.origin_code == origin_code:
            direction: Direction = "outbound"
            city_code = flight.destination_code
        elif flight.destination_code == origin_code:
            direction = "return"
            city_code = flight.origin_code
        else:
            continue
        if city_code == origin_code:
            continue
        coordinate = coordinates.get(city_code)
        if coordinate is None:
            continue
        city = records.setdefault(
            city_code,
            CityRecord(
                code=city_code,
                name=CITY_CATALOG.get(city_code, (coordinate.name, 0.0, 0.0))[0],
                longitude=coordinate.longitude,
                latitude=coordinate.latitude,
                country_code=coordinate.country_code,
                geoname_id=coordinate.geoname_id,
                coordinate_source=coordinate.source,
            ),
        )
        if selected_dates.get(direction) and flight.departure_date != selected_dates[direction]:
            continue
        field_name = "outbound" if direction == "outbound" else "return_flight"
        previous = getattr(city, field_name)
        if previous is None or (
            flight.price_myr is not None
            and (previous.price_myr is None or flight.price_myr < previous.price_myr)
        ):
            setattr(city, field_name, _to_city_listing(flight, direction))

    return sorted(records.values(), key=lambda city: city.name.casefold())


def city_to_dict(city: CityRecord) -> dict:
    result = asdict(city)
    result["coordinates"] = [city.longitude, city.latitude]
    return result


def origin_to_dict(origin: OriginRecord) -> dict:
    return asdict(origin)


def imported_flight_to_dict(flight: ImportedFlight) -> dict:
    return asdict(flight)
