from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

from .data import CityRecord

Preference = Literal["cheapest", "shortest", "balanced"]


@dataclass(frozen=True)
class TransportSettings:
    average_speed_kmh: float = 200.0
    distance_factor: float = 1.0
    fare_myr_per_km: float = 0.27
    connection_overhead_minutes: float = 30.0


@dataclass(frozen=True)
class RouteFilters:
    max_transport_hours: float | None = None
    max_budget_myr: float | None = None
    arrival_cities: tuple[str, ...] = ()
    departure_cities: tuple[str, ...] = ()


def build_routes(
    cities: list[CityRecord],
    distances_m: dict[str, float],
    settings: TransportSettings,
    filters: RouteFilters,
    preference: Preference,
    assumed_connection_pairs: set[str] | None = None,
) -> tuple[list[dict], int]:
    assumed_connection_pairs = assumed_connection_pairs or set()
    arrivals = [city for city in cities if city.outbound and city.outbound.price_myr is not None]
    departures = [city for city in cities if city.return_flight and city.return_flight.price_myr is not None]
    arrival_filter = set(filters.arrival_cities)
    departure_filter = set(filters.departure_cities)

    candidates: list[dict] = []
    unavailable_pairs = 0
    for arrival in arrivals:
        if arrival_filter and arrival.code not in arrival_filter:
            continue
        for departure in departures:
            if departure_filter and departure.code not in departure_filter:
                continue

            same_city = arrival.code == departure.code
            if same_city:
                base_distance_km = 0.0
                transport_distance_km = 0.0
                transport_hours = 0.0
                transport_cost_myr = 0.0
                distance_source = "same_city"
            else:
                pair_key = f"{arrival.code}->{departure.code}"
                connection_distance_m = distances_m.get(pair_key)
                if connection_distance_m is None:
                    unavailable_pairs += 1
                    continue
                base_distance_km = connection_distance_m / 1000.0
                transport_distance_km = base_distance_km * settings.distance_factor
                transport_hours = (
                    transport_distance_km / settings.average_speed_kmh
                    + settings.connection_overhead_minutes / 60.0
                )
                transport_cost_myr = transport_distance_km * settings.fare_myr_per_km
                distance_source = "assumed_connection" if pair_key in assumed_connection_pairs else "osrm_road"

            flight_cost_myr = arrival.outbound.price_myr + departure.return_flight.price_myr
            total_cost_myr = flight_cost_myr + transport_cost_myr
            if filters.max_transport_hours is not None and transport_hours > filters.max_transport_hours:
                continue
            if filters.max_budget_myr is not None and total_cost_myr > filters.max_budget_myr:
                continue

            baseline = None
            if arrival.return_flight and arrival.return_flight.price_myr is not None:
                baseline = arrival.outbound.price_myr + arrival.return_flight.price_myr
            candidates.append(
                {
                    "id": f"{arrival.code}-{departure.code}",
                    "arrival_city": {"code": arrival.code, "name": arrival.name},
                    "departure_city": {"code": departure.code, "name": departure.name},
                    "outbound_flight_myr": arrival.outbound.price_myr,
                    "outbound_booking_url": arrival.outbound.booking_url,
                    "return_flight_myr": departure.return_flight.price_myr,
                    "return_booking_url": departure.return_flight.booking_url,
                    "flight_cost_myr": flight_cost_myr,
                    "base_distance_km": base_distance_km,
                    "distance_source": distance_source,
                    "estimated_transport_distance_km": transport_distance_km,
                    "estimated_transport_time_hours": transport_hours,
                    "estimated_transport_cost_myr": transport_cost_myr,
                    "total_cost_myr": total_cost_myr,
                    "same_city_baseline_myr": baseline,
                    "savings_myr": baseline - total_cost_myr if baseline is not None else None,
                    "is_same_city": same_city,
                    "balanced_score": None,
                }
            )

    if preference == "balanced" and candidates:
        min_cost = min(item["total_cost_myr"] for item in candidates)
        max_cost = max(item["total_cost_myr"] for item in candidates)
        min_time = min(item["estimated_transport_time_hours"] for item in candidates)
        max_time = max(item["estimated_transport_time_hours"] for item in candidates)
        for item in candidates:
            cost_score = (item["total_cost_myr"] - min_cost) / (max_cost - min_cost) if max_cost > min_cost else 0.0
            time_score = (
                (item["estimated_transport_time_hours"] - min_time) / (max_time - min_time)
                if max_time > min_time
                else 0.0
            )
            item["balanced_score"] = (cost_score + time_score) / 2.0

    if preference == "cheapest":
        candidates.sort(
            key=lambda item: (
                item["total_cost_myr"],
                item["estimated_transport_time_hours"],
                item["arrival_city"]["name"],
                item["departure_city"]["name"],
            )
        )
    elif preference == "shortest":
        candidates.sort(
            key=lambda item: (
                item["estimated_transport_time_hours"],
                item["total_cost_myr"],
                item["arrival_city"]["name"],
                item["departure_city"]["name"],
            )
        )
    else:
        candidates.sort(
            key=lambda item: (
                item["balanced_score"],
                item["total_cost_myr"],
                item["estimated_transport_time_hours"],
                item["arrival_city"]["name"],
                item["departure_city"]["name"],
            )
        )

    for rank, item in enumerate(candidates, start=1):
        item["rank"] = rank
    return candidates, unavailable_pairs
