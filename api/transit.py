"""Transitous routing function. The browser owns its response cache and queue."""
import asyncio
from datetime import datetime
import os
from pathlib import Path
import sys
import threading
from typing import Annotated, Literal

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

import httpx
from fastapi import HTTPException, Query
from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.provider_http import provider_app

app = provider_app("Wayfinder Transitous routing function")
_routes = threading.BoundedSemaphore(2)
MODES = {"HIGHSPEED_RAIL", "LONG_DISTANCE", "NIGHT_RAIL", "REGIONAL_RAIL", "SUBURBAN", "BUS", "COACH", "SUBWAY", "TRAM"}


class TransitQuery(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    fromPlace: str = Field(max_length=100)
    toPlace: str = Field(max_length=100)
    time: datetime
    arriveBy: Literal["false"] = "false"
    transitModes: str = Field(max_length=250)
    searchWindow: int = Field(ge=0, le=86400)
    timetableView: Literal["true"] = "true"
    numItineraries: int = Field(default=10, ge=1, le=10)
    joinInterlinedLegs: Literal["false"] = "false"
    minTransferTime: int = Field(default=30, ge=0, le=360)
    radius: float | None = Field(default=None, ge=1000, le=50000)
    directModes: Literal[""] | None = None
    pageCursor: str | None = Field(default=None, min_length=1, max_length=32768)

    @field_validator("fromPlace", "toPlace")
    @classmethod
    def coordinates(cls, value):
        try:
            first, second = value.split(",")
            latitude, longitude = float(first), float(second)
            if not -90 <= latitude <= 90 or not -180 <= longitude <= 180:
                raise ValueError()
        except (ValueError, TypeError) as error:
            raise ValueError("Use latitude,longitude coordinates.") from error
        return value

    @field_validator("time")
    @classmethod
    def aware_time(cls, value):
        if value.tzinfo is None:
            raise ValueError("Include the origin's UTC offset in the routing time.")
        return value

    @field_validator("transitModes")
    @classmethod
    def modes(cls, value):
        if not value or any(mode not in MODES for mode in value.split(",")):
            raise ValueError("Choose supported scheduled-transit modes.")
        return value


@app.get("/api/transit")
async def transit(request: Annotated[TransitQuery, Query()]):
    contact = os.environ.get("TRANSITOUS_CONTACT_URL", "").strip()
    if not contact:
        raise HTTPException(503, "Set TRANSITOUS_CONTACT_URL after coordinating routing use before enabling Transitous.")
    base = os.environ.get("TRANSITOUS_API_BASE_URL", "https://api.transitous.org/api").rstrip("/")
    params = {key: str(value) for key, value in request.model_dump(exclude_none=True).items()}
    params["time"] = request.time.isoformat(timespec="seconds")
    if not _routes.acquire(blocking=False):
        raise HTTPException(429, "Transitous routing is busy. Retry this query.", headers={"Retry-After": "1"})
    # Limit both admission and upstream work within this one invocation.
    try:
        async with asyncio.timeout(35):
            async with httpx.AsyncClient(timeout=httpx.Timeout(25, connect=10), follow_redirects=False,
                headers={"User-Agent": f"WayfinderRoutes/1.1 ({contact})", "Accept": "application/json"}) as client:
                response = await client.get(base + "/v6/plan", params=params)
                response.raise_for_status()
                payload = response.json()
                if not isinstance(payload, dict) or not isinstance(payload.get("itineraries", []), list):
                    raise ValueError("Invalid routing response.")
                return payload
    except (TimeoutError, httpx.TimeoutException) as error:
        raise HTTPException(504, "Transitous routing timed out. Saved progress is kept; retry this query.") from error
    except (httpx.HTTPError, ValueError) as error:
        raise HTTPException(502, "Transitous routing failed. Retry this query.") from error
    finally:
        _routes.release()
