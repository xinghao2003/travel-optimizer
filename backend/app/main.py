from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from datetime import date, time
from pathlib import Path
from typing import Literal

from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, model_validator

from .flight_search import flight_search_status
from .places import city_to_dict, search_airport_cities
from .trip_optimizer import MAX_DESTINATIONS
from .transitous import transitous
from .planner_api import router as planner_router
from .planner_discovery import manager
from .planner_store import store

PROJECT_ROOT = Path(__file__).resolve().parents[2]
logger = logging.getLogger("uvicorn.error")

@asynccontextmanager
async def lifespan(app):
    store.recover()
    yield
    await manager.close()
    await transitous.close()


app = FastAPI(title="Wayfinder Multimodal Trip Optimizer", version="3.0.0", lifespan=lifespan)
app.include_router(planner_router)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
    allow_credentials=False,
    allow_methods=["GET", "POST", "PUT", "DELETE"],
    allow_headers=["Content-Type"],
)


class SettingsInput(BaseModel):
    flight_airport_buffer_minutes: float = Field(default=90.0, ge=0, le=360)


class OptimizeRequest(BaseModel):
    origin_code: str = Field(min_length=3, max_length=3)
    destination_codes: list[str] = Field(min_length=1, max_length=MAX_DESTINATIONS)
    start_date: date
    end_date: date
    preferred_departure_start: time = time(9, 0)
    preferred_departure_end: time = time(17, 0)
    min_city_stay_nights: int = Field(default=0, ge=0, le=30)
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
        if self.preferred_departure_end <= self.preferred_departure_start:
            raise ValueError("Preferred departure window must end after it starts on the same local day.")
        destination_count = len(self.destination_codes)
        minimum_span = (
            destination_count * (self.min_city_stay_nights + 1)
            if self.return_to_origin
            else max(0, destination_count - 1) * (self.min_city_stay_nights + 1)
            + self.min_city_stay_nights
        )
        if (self.end_date - self.start_date).days < minimum_span:
            raise ValueError(
                f"Choose a date range spanning at least {minimum_span} days to fit the travel legs and "
                f"{self.min_city_stay_nights} nights in each destination."
            )
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
async def legacy_optimize(request: OptimizeRequest) -> dict:
    from .planner_legacy import legacy_routes
    return await legacy_routes(request)


frontend_dist = PROJECT_ROOT / "frontend" / "dist"
if frontend_dist.exists():
    app.mount("/", StaticFiles(directory=frontend_dist, html=True), name="frontend")
