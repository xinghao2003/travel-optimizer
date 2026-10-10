from __future__ import annotations

from pathlib import Path
from typing import Literal

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from .data import (
    PROJECT_ROOT,
    CityRecord,
    city_to_dict,
    imported_flight_to_dict,
    load_city_records,
    load_input_flights,
    load_origin_records,
    optimizer_snapshot_dates,
    origin_to_dict,
    resolve_city_coordinates,
)
from .distances import great_circle_distance_m, road_distances
from .optimizer import RouteFilters, TransportSettings, build_routes

app = FastAPI(title="Flight + Ground Route Optimizer", version="1.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=False,
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type"],
)

IMPORTED_FLIGHTS, INPUT_FILE_STATUSES = load_input_flights()
CITY_COORDINATES, UNRESOLVED_CITIES, GEONAMES_DATASET_AVAILABLE = resolve_city_coordinates(IMPORTED_FLIGHTS)
ORIGIN_OPTIONS = load_origin_records(IMPORTED_FLIGHTS, CITY_COORDINATES)
DEFAULT_ORIGIN_CODE = next(
    (origin.code for origin in ORIGIN_OPTIONS if origin.code == "kul"),
    ORIGIN_OPTIONS[0].code if ORIGIN_OPTIONS else None,
)


class SettingsInput(BaseModel):
    average_speed_kmh: float = Field(default=200.0, gt=0, le=500)
    distance_factor: float = Field(default=1.0, gt=0, le=5)
    fare_myr_per_km: float = Field(default=0.27, ge=0, le=100)
    connection_overhead_minutes: float = Field(default=30.0, ge=0, le=360)


class FiltersInput(BaseModel):
    max_transport_hours: float | None = Field(default=None, gt=0, le=100)
    max_budget_myr: float | None = Field(default=None, gt=0, le=100000)
    arrival_cities: list[str] = Field(default_factory=list)
    departure_cities: list[str] = Field(default_factory=list)


class OptimizeRequest(BaseModel):
    origin_code: str | None = None
    settings: SettingsInput = Field(default_factory=SettingsInput)
    filters: FiltersInput = Field(default_factory=FiltersInput)
    preference: Literal["cheapest", "shortest", "balanced"] = "cheapest"


class RouteCity(BaseModel):
    code: str
    name: str


class RouteResult(BaseModel):
    id: str
    rank: int
    arrival_city: RouteCity
    departure_city: RouteCity
    outbound_flight_myr: float
    outbound_booking_url: str
    return_flight_myr: float
    return_booking_url: str
    flight_cost_myr: float
    base_distance_km: float
    distance_source: Literal["same_city", "osrm_road", "assumed_connection"]
    estimated_transport_distance_km: float
    estimated_transport_time_hours: float
    estimated_transport_cost_myr: float
    total_cost_myr: float
    same_city_baseline_myr: float | None
    savings_myr: float | None
    is_same_city: bool
    balanced_score: float | None


class OptimizeResponse(BaseModel):
    routes: list[RouteResult]
    preference: Literal["cheapest", "shortest", "balanced"]
    candidate_count: int
    unavailable_pair_count: int
    routing_status: Literal["ready", "partial", "assumed", "unavailable", "not_needed"]
    routing_message: str | None = None


@app.get("/api/health")
async def health() -> dict:
    return {"status": "ok", "city_count": len(CITY_COORDINATES)}


@app.get("/api/data")
async def get_data(origin_code: str | None = None) -> dict:
    selected_origin = next(
        (origin for origin in ORIGIN_OPTIONS if origin.code == origin_code),
        next((origin for origin in ORIGIN_OPTIONS if origin.code == DEFAULT_ORIGIN_CODE), None),
    )
    dates = (
        optimizer_snapshot_dates(IMPORTED_FLIGHTS, set(CITY_COORDINATES), selected_origin.code)
        if selected_origin
        else {"outbound": None, "return": None}
    )
    cities: list[CityRecord] = (
        load_city_records(IMPORTED_FLIGHTS, dates, CITY_COORDINATES, selected_origin.code)
        if selected_origin
        else []
    )
    outbound_prices = sum(1 for city in cities if city.outbound and city.outbound.price_myr is not None)
    return_prices = sum(1 for city in cities if city.return_flight and city.return_flight.price_myr is not None)
    return {
        "origin": origin_to_dict(selected_origin) if selected_origin else None,
        "origins": [origin_to_dict(origin) for origin in ORIGIN_OPTIONS],
        "cities": [city_to_dict(city) for city in cities],
        "snapshot_dates": dates,
        "imported_flights": [imported_flight_to_dict(flight) for flight in IMPORTED_FLIGHTS],
        "input_files": INPUT_FILE_STATUSES,
        "summary": {
            "city_count": len(cities),
            "outbound_listings": sum(1 for city in cities if city.outbound),
            "return_listings": sum(1 for city in cities if city.return_flight),
            "priced_outbound_listings": outbound_prices,
            "priced_return_listings": return_prices,
            "input_file_count": len(INPUT_FILE_STATUSES),
            "imported_flight_count": len(IMPORTED_FLIGHTS),
            "skipped_input_count": sum(status["status"] != "loaded" for status in INPUT_FILE_STATUSES),
            "resolved_coordinate_count": len(CITY_COORDINATES),
            "unresolved_coordinate_count": len(UNRESOLVED_CITIES),
        },
        "coordinate_resolution": {
            "dataset": "GeoNames cities500",
            "dataset_available": GEONAMES_DATASET_AVAILABLE,
            "unresolved_cities": [
                {"code": code, "name": name} for code, name in sorted(UNRESOLVED_CITIES.items())
            ],
        },
        "defaults": SettingsInput().model_dump(),
    }


@app.post("/api/routes", response_model=OptimizeResponse)
async def optimize(request: OptimizeRequest) -> OptimizeResponse:
    selected_origin = next(
        (origin for origin in ORIGIN_OPTIONS if origin.code == request.origin_code),
        next((origin for origin in ORIGIN_OPTIONS if origin.code == DEFAULT_ORIGIN_CODE), None),
    )
    if selected_origin:
        dates = optimizer_snapshot_dates(IMPORTED_FLIGHTS, set(CITY_COORDINATES), selected_origin.code)
        cities = load_city_records(IMPORTED_FLIGHTS, dates, CITY_COORDINATES, selected_origin.code)
    else:
        cities = []
    arrivals = [city for city in cities if city.outbound and city.outbound.price_myr is not None]
    departures = [city for city in cities if city.return_flight and city.return_flight.price_myr is not None]
    candidate_count = len(arrivals) * len(departures)
    settings = TransportSettings(**request.settings.model_dump())
    filters = RouteFilters(
        max_transport_hours=request.filters.max_transport_hours,
        max_budget_myr=request.filters.max_budget_myr,
        arrival_cities=tuple(request.filters.arrival_cities),
        departure_cities=tuple(request.filters.departure_cities),
    )

    # Same-city journeys need no road lookup; only request the directed pairs required here.
    selected_arrivals = [city for city in arrivals if not filters.arrival_cities or city.code in filters.arrival_cities]
    selected_departures = [city for city in departures if not filters.departure_cities or city.code in filters.departure_cities]
    origin_codes = [city.code for city in selected_arrivals]
    destination_codes = [city.code for city in selected_departures]

    distance_map: dict[str, float] = {}
    unavailable_count = 0
    routing_message = None
    assumed_connection_pairs: set[str] = set()
    if any(origin != destination for origin in origin_codes for destination in destination_codes):
        distance_map, unavailable_count, routing_message = await road_distances.ensure(cities, origin_codes, destination_codes)

        city_by_code = {city.code: city for city in cities}
        for origin in origin_codes:
            for destination in destination_codes:
                if origin == destination:
                    continue
                key = f"{origin}->{destination}"
                if key in distance_map:
                    continue
                distance_map[key] = great_circle_distance_m(city_by_code[origin], city_by_code[destination])
                assumed_connection_pairs.add(key)

    routes, unavailable_count = build_routes(
        cities,
        distance_map,
        settings,
        filters,
        request.preference,
        assumed_connection_pairs,
    )
    if assumed_connection_pairs:
        osrm_pair_count = len(distance_map) - len(assumed_connection_pairs)
        routing_status = "partial" if osrm_pair_count else "assumed"
        routing_message = (
            f"Used direct-distance proxies for {len(assumed_connection_pairs)} pair(s) where OSRM had no road route. "
            "Those options assume a connection and do not represent road distances or confirmed services."
        )
    elif unavailable_count == 0:
        routing_status = "ready" if distance_map else "not_needed"
        routing_message = None
    elif distance_map:
        routing_status = "partial"
        routing_message = routing_message or f"Road-distance estimates are unavailable for {unavailable_count} city pair(s); those combinations are omitted."
    else:
        routing_status = "unavailable"
        routing_message = routing_message or "Road routing is unavailable. Showing same-city flight options only; no fallback distances are invented."

    return OptimizeResponse(
        routes=routes,
        preference=request.preference,
        candidate_count=candidate_count,
        unavailable_pair_count=unavailable_count,
        routing_status=routing_status,
        routing_message=routing_message,
    )


frontend_dist = PROJECT_ROOT / "frontend" / "dist"
if frontend_dist.exists():
    app.mount("/", StaticFiles(directory=frontend_dist, html=True), name="frontend")

