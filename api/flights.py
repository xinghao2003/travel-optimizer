"""Stateless flight function. No trip database, background job, or optimizer."""
from datetime import date, time
from pathlib import Path
import sys
import threading
from typing import Annotated, Literal

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

from pydantic import BaseModel, ConfigDict, Field, model_validator
from fastapi import HTTPException
from starlette.concurrency import run_in_threadpool

from app.provider_functions import fetch_flight_step
from app.provider_http import provider_app


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


SelectionValue = Annotated[str, Field(min_length=1, max_length=120)]


class FlightRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    legs: list[Leg] = Field(min_length=1, max_length=32)
    adults: int = Field(default=1, ge=1, le=9)
    kind: Literal["one-way", "round-trip", "multi-city"] = "one-way"
    operation: Literal["search", "return"] = "search"
    selection: list[tuple[SelectionValue, SelectionValue, SelectionValue, SelectionValue, SelectionValue]] | None = Field(default=None, min_length=1, max_length=64)
    departure_start: time = time(0)
    departure_end: time = time(23, 59)

    @model_validator(mode="after")
    def complete_request(self):
        if self.departure_start.tzinfo is not None or self.departure_end.tzinfo is not None:
            raise ValueError("Use local origin-clock departure times without a UTC offset.")
        if len(self.legs) != (1 if self.kind == "one-way" else 2) and self.kind != "multi-city":
            raise ValueError("Use one leg for one-way and two legs for round-trip searches.")
        if self.kind == "multi-city" and len(self.legs) < 2:
            raise ValueError("Multi-city quotes need at least two legs.")
        if self.operation == "return" and (self.kind != "round-trip" or not self.selection):
            raise ValueError("A return step needs a round trip and its selected outbound.")
        if self.operation == "search" and self.selection is not None:
            raise ValueError("Only return steps accept a selected outbound.")
        if self.kind == "round-trip" and (self.legs[0].from_id != self.legs[1].to_id or self.legs[0].to_id != self.legs[1].from_id or self.legs[1].date < self.legs[0].date):
            raise ValueError("Round-trip legs must travel in opposite directions in date order.")
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


app = provider_app("Wayfinder flight search function")
_requests = threading.BoundedSemaphore(3)


@app.get("/api/flights")
def health():
    return {"status": "ok", "service": "flight-proxy", "stateless": True, "protocol_version": 2, "operations": ["one-way", "round-trip-steps", "manual-multi-city"]}


@app.post("/api/flights")
async def flights(request: FlightRequest):
    # Await this bounded provider operation; do not spawn a post-response task.
    if not _requests.acquire(blocking=False):
        raise HTTPException(429, "Flight provider is busy. Retry this query.", headers={"Retry-After": "1"})
    try:
        return await run_in_threadpool(
            fetch_flight_step, [leg.model_dump(mode="json") for leg in request.legs],
            request.adults, request.kind, request.departure_start, request.departure_end,
            operation=request.operation, selection=request.selection, timeout=15, max_seconds=35,
        )
    finally:
        _requests.release()
