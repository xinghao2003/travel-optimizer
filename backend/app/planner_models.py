"""Versioned contracts for the persisted, schedule-aware planner."""
from __future__ import annotations

import hashlib
import json
import math
from datetime import date, datetime, time, timezone
from typing import Literal
from zoneinfo import ZoneInfo

from pydantic import BaseModel, ConfigDict, Field, model_validator

Mode = Literal["flight", "rail", "bus", "coach", "subway", "tram", "car", "taxi"]


def stable_id(*parts: object) -> str:
    return hashlib.sha256(json.dumps(parts, sort_keys=True, default=str).encode()).hexdigest()[:24]


class Contract(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)


class Place(Contract):
    id: str = Field(min_length=1, max_length=160)
    name: str = Field(min_length=1, max_length=160)
    latitude: float = Field(ge=-90, le=90)
    longitude: float = Field(ge=-180, le=180)
    timezone: str
    country_code: str = ""
    airport_codes: list[str] = Field(default_factory=list)
    flight_code: str | None = None

    @model_validator(mode="after")
    def valid_timezone(self):
        try:
            ZoneInfo(self.timezone)
        except (ValueError, KeyError) as exc:
            raise ValueError("Use a valid IANA timezone for this place.") from exc
        return self


class Visit(Contract):
    place: Place
    min_stay_hours: float = Field(default=0, ge=0, le=8760)


class Commitment(Contract):
    place_id: str
    start: datetime
    end: datetime

    @model_validator(mode="after")
    def valid_interval(self):
        if self.start.tzinfo is None or self.end.tzinfo is None or self.end <= self.start:
            raise ValueError("Commitments need timezone-aware start/end times in increasing order.")
        return self


class CarSettings(Contract):
    own_enabled: bool = False
    own_capacity: int = Field(default=4, ge=1, le=9)
    own_cost_per_km: float = Field(default=0.27, ge=0)
    rental_enabled: bool = False
    rental_capacity: int = Field(default=4, ge=1, le=9)
    rental_pickups: list[str] = Field(default_factory=list)
    rental_dropoffs: list[str] = Field(default_factory=list)
    rental_daily_myr: float | None = Field(default=None, ge=0)
    rental_pickup_myr: float = Field(default=0, ge=0)
    rental_one_way_myr: float | None = Field(default=None, ge=0)
    rental_cost_per_km: float | None = Field(default=None, ge=0)
    taxi_capacity: int = Field(default=4, ge=1, le=9)


class TimingSettings(Contract):
    connection_minutes: int = Field(default=30, ge=0, le=360)
    flight_before_minutes: int = Field(default=90, ge=0, le=360)
    flight_after_minutes: int = Field(default=30, ge=0, le=360)
    transit_before_minutes: int = Field(default=15, ge=0, le=120)
    transit_after_minutes: int = Field(default=10, ge=0, le=120)
    # Explicit, editable transfer assumption used only when a routed airport
    # connector cannot be retrieved. It never fabricates an intercity road.
    airport_transfer_fallback_minutes: int | None = Field(default=45, ge=0, le=600)


class PositioningPolicy(Contract):
    direction: Literal["outbound", "return"]
    gateway_id: str
    mode: Mode
    search_more: bool = True
    available: bool = True


class PositioningService(Contract):
    id: str = Field(min_length=1, max_length=160)
    direction: Literal["outbound", "return"]
    gateway_id: str
    mode: Mode
    departure: datetime
    arrival: datetime
    fare_amount: float | None = Field(default=None, ge=0)
    currency: str = Field(default="MYR", pattern=r"^[A-Za-z]{3}$")
    label: str = Field(default="Supplied positioning service", max_length=160)

    @model_validator(mode="after")
    def validate_service(self):
        if self.departure.tzinfo is None or self.arrival.tzinfo is None or self.arrival <= self.departure:
            raise ValueError("Positioning services need increasing timezone-aware departure and arrival times.")
        self.currency = self.currency.upper()
        return self


class TripSpec(Contract):
    name: str = Field(default="My trip", min_length=1, max_length=120)
    home: Place
    departures: list[Place] = Field(default_factory=list, max_length=3)
    arrivals: list[Place] = Field(default_factory=list, max_length=3)
    visits: list[Visit] = Field(min_length=1, max_length=4)
    start_date: date
    end_date: date
    date_mode: Literal["fixed", "flexible"] = "fixed"
    adults: int = Field(default=1, ge=1, le=9)
    budget_myr: float | None = Field(default=None, ge=0)
    modes: list[Mode] = Field(default_factory=lambda: ["flight", "rail", "bus", "coach"])
    max_transfers: int | None = Field(default=None, ge=0, le=10)
    allow_overnight: bool = True
    exclude_unpriced_flights: bool = False
    home_departure_earliest: time | None = None
    home_arrival_latest: time | None = None
    positioning_policies: list[PositioningPolicy] = Field(default_factory=list, max_length=48)
    positioning_services: list[PositioningService] = Field(default_factory=list, max_length=120)
    departure_start: time = time(9)
    departure_end: time = time(17)
    commitments: list[Commitment] = Field(default_factory=list)
    timing: TimingSettings = Field(default_factory=TimingSettings)
    cars: CarSettings = Field(default_factory=CarSettings)
    exchange_rates: dict[str, float] = Field(default_factory=lambda: {"MYR": 1})

    @model_validator(mode="after")
    def validate_trip(self):
        if self.end_date < self.start_date or (self.end_date - self.start_date).days > 365:
            raise ValueError("Choose an increasing date range of at most 365 days.")
        if self.departure_end <= self.departure_start:
            raise ValueError("The local departure window must end after it starts.")
        if not self.modes:
            raise ValueError("Select at least one transport mode.")
        ids = [v.place.id for v in self.visits]
        if len(ids) != len(set(ids)) or self.home.id in ids:
            raise ValueError("Required destinations must be unique and different from home.")
        self.departures = self.departures or [self.home]
        self.arrivals = self.arrivals or [self.home]
        for group in (self.departures, self.arrivals):
            if len({p.id for p in group}) != len(group):
                raise ValueError("Candidate endpoints must be unique.")
        for currency, rate in self.exchange_rates.items():
            if len(currency) != 3 or not currency.isalpha() or not math.isfinite(rate) or rate <= 0:
                raise ValueError("Exchange rates must be positive MYR per unit of currency.")
        self.exchange_rates["MYR"] = 1
        if any(c.place_id not in ids for c in self.commitments):
            raise ValueError("Fixed commitments must belong to required destinations.")
        if self.start_date == self.end_date and self.home_departure_earliest and self.home_arrival_latest and self.home_departure_earliest >= self.home_arrival_latest:
            raise ValueError("Latest home arrival must follow earliest home departure.")
        policy_keys = [(p.direction, p.gateway_id, p.mode) for p in self.positioning_policies]
        if len(policy_keys) != len(set(policy_keys)):
            raise ValueError("Positioning policies must be unique per direction, gateway, and mode.")
        if len({s.id for s in self.positioning_services}) != len(self.positioning_services):
            raise ValueError("Positioning service IDs must be unique.")
        for item in [*self.positioning_policies, *self.positioning_services]:
            gateways = self.departures if item.direction == "outbound" else self.arrivals
            if item.gateway_id == self.home.id or item.gateway_id not in {p.id for p in gateways}:
                raise ValueError("Positioning must reference a non-home gateway in the selected direction.")
        return self

    def places(self) -> dict[str, Place]:
        return {p.id: p for p in [self.home, *self.departures, *self.arrivals, *(v.place for v in self.visits)]}

    def discovery_key(self) -> str:
        # Constraints/prices can change without throwing away provider data.
        # Destination returns widen schedule dates; old completed jobs must not
        # claim coverage of the expanded search. Individual provider caches stay reusable.
        parts = ("independent-round-trips-v2", self.home, self.departures, self.arrivals,
                 [v.place for v in self.visits], self.start_date, self.end_date,
                 self.adults, sorted(self.modes), self.departure_start, self.departure_end)
        if self.home_departure_earliest is None and self.home_arrival_latest is None and not self.positioning_policies:
            return stable_id(*parts)
        return stable_id(*parts, self.home_departure_earliest, self.home_arrival_latest, self.positioning_policies)


class Segment(Contract):
    mode: str
    from_name: str
    to_name: str
    departure: datetime | None = None
    arrival: datetime | None = None
    from_id: str | None = None
    to_id: str | None = None
    from_timezone: str | None = None
    to_timezone: str | None = None
    operator: str | None = None
    service: str | None = None
    source: str | None = None
    duration_minutes: float | None = None
    assumed: bool = False
    interline_with_previous: bool = False


class Charge(Contract):
    id: str
    kind: str
    mode: str = "taxi"
    distance_km: float | None = Field(default=None, ge=0)
    low: float | None = Field(default=None, ge=0)
    high: float | None = Field(default=None, ge=0)
    currency: str = "MYR"
    source: str = "unknown"
    from_id: str | None = None
    to_id: str | None = None
    country_code: str | None = None


AirportTransferMode = Literal["rail", "bus", "coach", "subway", "tram", "car", "taxi"]


class AirportConnection(Contract):
    from_airport: str = Field(pattern=r"^[A-Za-z]{3}$")
    to_airport: str = Field(pattern=r"^[A-Za-z]{3}$")
    mode: AirportTransferMode
    duration_minutes: float = Field(gt=0)
    fare_amount: float | None = Field(default=None, ge=0)
    currency: str = Field(default="MYR", pattern=r"^[A-Za-z]{3}$")

    @model_validator(mode="after")
    def normalize_connection(self):
        self.from_airport = self.from_airport.upper()
        self.to_airport = self.to_airport.upper()
        self.currency = self.currency.upper()
        if self.from_airport == self.to_airport:
            raise ValueError("An airport connection must join two different airports.")
        return self


class Movement(Contract):
    id: str
    template_id: str | None = None
    usable: bool = True
    from_id: str
    to_id: str
    mode: Mode
    departure: datetime | None = None
    arrival: datetime | None = None
    duration_minutes: float = Field(gt=0)
    distance_km: float | None = Field(default=None, ge=0)
    transfers: int = Field(default=0, ge=0)
    vehicle_kind: Literal["own", "rental"] | None = None
    segments: list[Segment] = Field(default_factory=list)
    charges: list[Charge] = Field(default_factory=list)
    source: str
    search_url: str | None = None
    assumptions: list[str] = Field(default_factory=list)

    @model_validator(mode="after")
    def schedule(self):
        if (self.departure is None) != (self.arrival is None):
            raise ValueError("Both schedule timestamps are required together.")
        if self.departure is not None:
            if self.departure.tzinfo is None or self.arrival.tzinfo is None:
                raise ValueError("Movements need increasing timezone-aware timestamps.")
            self.departure = self.departure.astimezone(timezone.utc)
            self.arrival = self.arrival.astimezone(timezone.utc)
            if self.arrival <= self.departure:
                raise ValueError("Movements need increasing timezone-aware timestamps.")
            self.duration_minutes = (self.arrival - self.departure).total_seconds() / 60
        return self


class FareOffer(Contract):
    id: str
    movement_ids: list[str] = Field(min_length=1)
    kind: Literal["one-way", "round-trip", "multi-city", "charge"] = "one-way"
    low: float | None = Field(default=None, ge=0)
    high: float | None = Field(default=None, ge=0)
    currency: str = Field(default="MYR", pattern=r"^[A-Za-z]{3}$")
    source: Literal["provider", "user", "rule", "unknown"] = "provider"
    estimated: bool = False
    label: str = ""
    search_url: str | None = None
    validated: bool = True
    adults: int | None = Field(default=None, ge=1, le=9)
    retrieved_at: datetime | None = None
    expires_at: datetime | None = None

    @model_validator(mode="after")
    def interval(self):
        self.currency = self.currency.upper()
        if len(self.movement_ids) != len(set(self.movement_ids)):
            raise ValueError("Ticket coverage must not contain duplicate movements.")
        if self.low is None and self.high is not None:
            raise ValueError("A maximum fare also requires a minimum fare.")
        if self.high is not None and self.high < self.low:
            raise ValueError("The maximum fare cannot be below the minimum.")
        return self


class PricingRule(Contract):
    id: str = ""
    name: str = Field(min_length=1, max_length=120)
    mode: str = "*"
    from_id: str | None = None
    to_id: str | None = None
    service: str | None = None
    country_code: str | None = None
    kind: Literal["fixed", "per-km"] = "fixed"
    low: float = Field(ge=0)
    high: float | None = Field(default=None, ge=0)
    unit: Literal["party", "person", "vehicle"] = "person"
    capacity: int = Field(default=4, ge=1, le=9)
    currency: str = Field(default="MYR", pattern=r"^[A-Za-z]{3}$")
    priority: int = 0

    @model_validator(mode="after")
    def interval(self):
        if self.high is not None and self.high < self.low:
            raise ValueError("Rule maximum must not be below its minimum.")
        self.currency = self.currency.upper()
        return self


class AirportTransferEstimate(Contract):
    mode: AirportTransferMode = "taxi"
    duration_minutes: float | None = Field(default=None, gt=0)
    from_id: str
    to_id: str
    adults: int = Field(ge=1, le=9)
    low: float | None = Field(default=None, ge=0)
    high: float | None = Field(default=None, ge=0)
    currency: str = Field(default="MYR", pattern=r"^[A-Za-z]{3}$")

    @model_validator(mode="after")
    def interval(self):
        if self.mode != "taxi" and self.duration_minutes is None:
            raise ValueError("Enter a travel time for each alternative transfer method.")
        if self.low is None and self.high is not None:
            raise ValueError("A maximum also needs a minimum.")
        if self.high is not None and self.high < self.low:
            raise ValueError("Maximum must not be below minimum.")
        self.currency = self.currency.upper()
        return self
