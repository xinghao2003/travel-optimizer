from __future__ import annotations

import asyncio
from datetime import date, time
from pathlib import Path
from typing import Literal

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, model_validator

from .flight_search import flight_search_status, search_one_way
from .places import AirportCity, city_to_dict, load_airport_cities, search_airport_cities
from .trip_optimizer import MAX_DESTINATIONS, Preference, TransportSettings, optimize_trip
from .transitous import RailSearchOutcome, transitous

PROJECT_ROOT = Path(__file__).resolve().parents[2]

app = FastAPI(title="Flight + Scheduled Rail Route Planner", version="2.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=False,
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type"],
)


class SettingsInput(BaseModel):
    flight_airport_buffer_minutes: float = Field(default=90.0, ge=0, le=360)


class OptimizeRequest(BaseModel):
    origin_code: str = Field(min_length=3, max_length=3)
    destination_codes: list[str] = Field(min_length=1, max_length=MAX_DESTINATIONS)
    start_date: date
    end_date: date
    transit_departure_time: time = time(9, 0)
    return_to_origin: bool = True
    settings: SettingsInput = Field(default_factory=SettingsInput)
    preference: Literal["cheapest", "shortest", "balanced"] = "cheapest"

    @model_validator(mode="after")
    def validate_trip_dates(self) -> "OptimizeRequest":
        if self.start_date < date.today():
            raise ValueError("Start date must be today or later.")
        if self.end_date < self.start_date:
            raise ValueError("End date must be on or after the start date.")
        if (self.end_date - self.start_date).days > 365:
            raise ValueError("Trip date range cannot exceed 365 days.")
        leg_count = len(self.destination_codes) + int(self.return_to_origin)
        if (self.end_date - self.start_date).days < leg_count - 1:
            raise ValueError("Add at least one calendar day for each additional travel leg.")
        codes = [code.upper() for code in self.destination_codes]
        if len(set(codes)) != len(codes):
            raise ValueError("Choose each destination city only once.")
        if self.origin_code.upper() in codes:
            raise ValueError("A destination must be different from the origin.")
        return self


@app.get("/api/health")
async def health() -> dict:
    flight_status = flight_search_status()
    return {"status": "ok", "flight_search": flight_status}


@app.get("/api/data")
async def get_data() -> dict:
    return {
        "defaults": SettingsInput().model_dump(),
        "flight_source": "fast-flights / Google Flights",
        "rail_source": "Transitous public routing API",
        "transit_routing_configured": bool(transitous.contact_url),
        "max_destinations": MAX_DESTINATIONS,
        "currency": "MYR",
        "passengers": 1,
    }


@app.get("/api/cities")
async def get_cities(
    search: str = Query(min_length=2, max_length=80),
    limit: int = Query(default=16, ge=1, le=30),
) -> dict:
    try:
        matches = search_airport_cities(search, limit)
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    return {"cities": [city_to_dict(city) for city in matches]}


@app.post("/api/routes")
async def optimize(request: OptimizeRequest) -> dict:
    try:
        cities_by_code = load_airport_cities()
    except RuntimeError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc

    origin = cities_by_code.get(request.origin_code.upper())
    destinations = [cities_by_code.get(code.upper()) for code in request.destination_codes]
    if origin is None:
        raise HTTPException(status_code=422, detail="Origin is not present in the current IATA airport catalog.")
    if any(city is None for city in destinations):
        raise HTTPException(status_code=422, detail="One or more destinations are not present in the IATA airport catalog.")
    selected_destinations = [city for city in destinations if city is not None]

    selected_cities: list[AirportCity] = [origin, *selected_destinations]
    settings = TransportSettings(**request.settings.model_dump())

    transitous.reset_counters()
    geocoding = (
        await asyncio.gather(
            *(transitous.geocode(city) for city in selected_cities),
            return_exceptions=True,
        )
        if transitous.contact_url
        else [None for _ in selected_cities]
    )
    places_by_code = {
        city.code: value
        for city, value in zip(selected_cities, geocoding)
        if not isinstance(value, Exception) and value is not None
    }
    unresolved_places = (
        len(selected_cities) - len(places_by_code)
        if transitous.contact_url
        else 0
    )

    async def search(date_value: date, from_city: AirportCity, to_city: AirportCity):
        return await asyncio.to_thread(search_one_way, date_value, from_city, to_city)

    async def search_rail(date_value: date, from_city: AirportCity, to_city: AirportCity) -> RailSearchOutcome:
        from_place = places_by_code.get(from_city.code)
        to_place = places_by_code.get(to_city.code)
        if from_place is None or to_place is None:
            return RailSearchOutcome(error="Transitous could not resolve one or both cities to a place.")
        return await transitous.search_rail(date_value, request.transit_departure_time, from_place, to_place)

    result = await optimize_trip(
        origin=origin,
        destinations=selected_destinations,
        start_date=request.start_date,
        end_date=request.end_date,
        return_to_origin=request.return_to_origin,
        preference=request.preference,
        settings=settings,
        distances_m={},
        distance_sources={},
        flight_search=search,
        rail_search=search_rail if transitous.contact_url else None,
    )

    routing_status = "ready" if result["rail_searches_with_results"] else "partial"
    if not transitous.contact_url:
        routing_message = (
            "Rail lookups are disabled. Set TRANSITOUS_CONTACT_URL and coordinate with Transitous "
            "before enabling its routing API."
        )
    elif unresolved_places:
        routing_message = (
            f"Transitous could not resolve {unresolved_places} selected city location(s); "
            "scheduled rail results may be incomplete."
        )
    elif result["rail_searches_failed"]:
        routing_message = (
            f"{result['rail_searches_failed']} Transitous rail searches failed. "
            "Flight results remain available where found."
        )
    elif not result["rail_searches_with_results"]:
        routing_message = "No scheduled rail itineraries were returned for these city pairs and dates."
    else:
        routing_message = None

    search_message = None
    if result["searches_failed"]:
        search_message = (
            f"{result['searches_failed']} of {result['searches_attempted']} flight searches failed. "
            "Routes may use scheduled rail for those legs where available."
        )
    elif result["unpriced_rows_skipped"]:
        search_message = (
            f"Skipped {result['unpriced_rows_skipped']} Google result row(s) with no fare; "
            "priced options were retained."
        )
    elif result["searches_with_priced_results"] < result["searches_attempted"]:
        search_message = (
            f"Priced fares were found for {result['searches_with_priced_results']} of "
            f"{result['searches_attempted']} searched city/date pairs."
        )

    return {
        **result,
        "origin": city_to_dict(origin),
        "routing_status": routing_status,
        "routing_message": routing_message,
        "search_message": search_message,
        "transit_api_requests": transitous.api_requests,
        "transit_cache_hits": transitous.cache_hits,
        "transit_api_failures": transitous.api_failures,
        "transit_geocoding_failures": unresolved_places,
        "flight_search": flight_search_status(),
    }


frontend_dist = PROJECT_ROOT / "frontend" / "dist"
if frontend_dist.exists():
    app.mount("/", StaticFiles(directory=frontend_dist, html=True), name="frontend")
