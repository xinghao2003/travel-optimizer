"""Stateless flight function. No trip database, background job, or optimizer."""
from datetime import date, time
from pathlib import Path
import sys
from typing import Literal

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

from fastapi import FastAPI
from pydantic import BaseModel, ConfigDict, Field, model_validator
from starlette.concurrency import run_in_threadpool

from app.planner_providers import fetch_flights


class Leg(BaseModel):
    model_config = ConfigDict(extra="forbid")
    from_id: str = Field(min_length=1, max_length=160)
    to_id: str = Field(min_length=1, max_length=160)
    date: date
    from_code: str = Field(pattern=r"^[A-Z]{3}$")
    to_code: str = Field(pattern=r"^[A-Z]{3}$")
    from_airports: list[str] = Field(min_length=1, max_length=20)
    to_airports: list[str] = Field(min_length=1, max_length=20)
    timezone: str


class FlightRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    legs: list[Leg] = Field(min_length=1, max_length=1)
    adults: int = Field(default=1, ge=1, le=9)
    kind: Literal["one-way"] = "one-way"
    departure_start: time = time(0)
    departure_end: time = time(23, 59)

    @model_validator(mode="after")
    def complete_request(self):
        if self.departure_end <= self.departure_start:
            raise ValueError("The departure window must have increasing times.")
        # Reuse the existing contract for IANA timezone validation.
        from zoneinfo import ZoneInfo
        for leg in self.legs:
            try:
                ZoneInfo(leg.timezone)
            except (ValueError, KeyError) as exc:
                raise ValueError("Use an IANA timezone for each origin.") from exc
        return self


app = FastAPI(title="Browser prototype flight proxy")


@app.get("/api/flights")
def health():
    return {"status": "ok", "service": "flight-proxy", "stateless": True}


@app.post("/api/flights")
async def flights(request: FlightRequest):
    # Await this bounded provider operation; do not spawn a post-response task.
    return await run_in_threadpool(
        fetch_flights, [leg.model_dump(mode="json") for leg in request.legs],
        request.adults, request.kind, request.departure_start, request.departure_end, timeout=20,
    )
