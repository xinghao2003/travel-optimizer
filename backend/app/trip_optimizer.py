from __future__ import annotations

import asyncio
import hashlib
import itertools
from dataclasses import dataclass
from datetime import date, timedelta
from typing import Awaitable, Callable, Literal

from .flight_search import FlightOption, FlightSearchOutcome
from .places import AirportCity
from .transitous import RailSearchOutcome

Preference = Literal["cheapest", "shortest", "balanced"]
MAX_DESTINATIONS = 4
MAX_PARALLEL_FLIGHT_SEARCHES = 3


@dataclass(frozen=True)
class TransportSettings:
    average_speed_kmh: float = 80.0
    fare_myr_per_km: float = 0.27
    ground_overhead_minutes: float = 30.0
    flight_airport_buffer_minutes: float = 90.0


@dataclass(frozen=True)
class FlightSearchSpec:
    key: tuple[int, str, str, str]
    departure_date: date
    origin: AirportCity
    destination: AirportCity


@dataclass(frozen=True)
class ModeOption:
    mode: Literal["flight", "rail", "ground"]
    cost_myr: float | None
    duration_minutes: int
    distance_km: float
    distance_source: Literal["flight", "transitous_rail", "osrm_road", "assumed_connection"]
    airlines: tuple[str, ...] = ()
    segment_count: int = 0
    search_url: str | None = None
    departure_time: str | None = None
    arrival_time: str | None = None
    departure_timezone: str | None = None
    arrival_timezone: str | None = None
    from_stop: str | None = None
    to_stop: str | None = None
    service_names: tuple[str, ...] = ()
    operators: tuple[str, ...] = ()


def evenly_spaced_leg_dates(start_date: date, end_date: date, leg_count: int) -> list[date]:
    if leg_count < 1:
        raise ValueError("A trip must have at least one travel leg.")
    span_days = (end_date - start_date).days
    if span_days < leg_count - 1:
        raise ValueError("Add at least one calendar day for each additional travel leg.")
    if leg_count == 1:
        return [start_date]
    return [
        start_date + timedelta(days=round(index * span_days / (leg_count - 1)))
        for index in range(leg_count)
    ]


def build_search_specs(
    origin: AirportCity,
    destinations: list[AirportCity],
    start_date: date,
    end_date: date,
    return_to_origin: bool,
) -> list[FlightSearchSpec]:
    if not 1 <= len(destinations) <= MAX_DESTINATIONS:
        raise ValueError(f"Choose between 1 and {MAX_DESTINATIONS} destinations.")
    if origin.code in {city.code for city in destinations}:
        raise ValueError("A destination must be different from the origin.")
    if len({city.code for city in destinations}) != len(destinations):
        raise ValueError("Choose each destination city only once.")

    leg_count = len(destinations) + int(return_to_origin)
    dates = evenly_spaced_leg_dates(start_date, end_date, leg_count)
    specs: list[FlightSearchSpec] = []
    for position, departure_date in enumerate(dates):
        if position == 0:
            pairs = [(origin, city) for city in destinations]
        elif return_to_origin and position == leg_count - 1:
            pairs = [(city, origin) for city in destinations]
        else:
            pairs = [
                (from_city, to_city)
                for from_city in destinations
                for to_city in destinations
                if from_city.code != to_city.code
            ]
        for from_city, to_city in pairs:
            key = (position, departure_date.isoformat(), from_city.code, to_city.code)
            specs.append(FlightSearchSpec(key, departure_date, from_city, to_city))
    return specs


def maximum_search_count(destination_count: int, return_to_origin: bool = True) -> int:
    if destination_count < 1:
        return 0
    if destination_count == 1:
        return destination_count + int(return_to_origin)
    internal_leg_count = destination_count - 1 if return_to_origin else destination_count - 1
    boundary_searches = destination_count * (2 if return_to_origin else 1)
    return boundary_searches + internal_leg_count * destination_count * (destination_count - 1)


def _choose_mode(options: list[ModeOption], preference: Preference) -> ModeOption:
    priced_options = [option for option in options if option.cost_myr is not None]
    if preference == "cheapest":
        if priced_options:
            return min(priced_options, key=lambda option: (option.cost_myr, option.duration_minutes))
        return min(options, key=lambda option: option.duration_minutes)
    if preference == "shortest":
        return min(options, key=lambda option: (option.duration_minutes, option.cost_myr or 0))
    if not priced_options:
        return min(options, key=lambda option: option.duration_minutes)
    options = priced_options
    min_cost = min(option.cost_myr for option in options if option.cost_myr is not None)
    max_cost = max(option.cost_myr for option in options if option.cost_myr is not None)
    min_time = min(option.duration_minutes for option in options)
    max_time = max(option.duration_minutes for option in options)
    return min(
        options,
        key=lambda option: (
            ((option.cost_myr - min_cost) / (max_cost - min_cost) if max_cost > min_cost else 0.0)
            + ((option.duration_minutes - min_time) / (max_time - min_time) if max_time > min_time else 0.0),
            option.cost_myr,
        ),
    )


async def optimize_trip(
    *,
    origin: AirportCity,
    destinations: list[AirportCity],
    start_date: date,
    end_date: date,
    return_to_origin: bool,
    preference: Preference,
    settings: TransportSettings,
    distances_m: dict[str, float],
    distance_sources: dict[str, Literal["osrm_road", "assumed_connection"]],
    flight_search: Callable[[date, AirportCity, AirportCity], Awaitable[FlightSearchOutcome]],
    rail_search: Callable[[date, AirportCity, AirportCity], Awaitable[RailSearchOutcome]] | None = None,
) -> dict:
    specs = build_search_specs(origin, destinations, start_date, end_date, return_to_origin)
    semaphore = asyncio.Semaphore(MAX_PARALLEL_FLIGHT_SEARCHES)

    async def run_search(spec: FlightSearchSpec) -> tuple[FlightSearchSpec, FlightSearchOutcome]:
        async with semaphore:
            try:
                return spec, await flight_search(spec.departure_date, spec.origin, spec.destination)
            except Exception as exc:
                return spec, FlightSearchOutcome(error=f"{type(exc).__name__}: {str(exc)[:160]}")

    search_results = await asyncio.gather(*(run_search(spec) for spec in specs))
    quotes = {spec.key: outcome for spec, outcome in search_results}
    rail_results: dict[tuple[int, str, str, str], RailSearchOutcome] = {}
    if rail_search is not None:
        rail_semaphore = asyncio.Semaphore(2)

        async def run_rail_search(spec: FlightSearchSpec) -> tuple[FlightSearchSpec, RailSearchOutcome]:
            async with rail_semaphore:
                try:
                    return spec, await rail_search(spec.departure_date, spec.origin, spec.destination)
                except Exception as exc:
                    return spec, RailSearchOutcome(error=f"{type(exc).__name__}: {str(exc)[:160]}")

        rail_results = {
            spec.key: outcome
            for spec, outcome in await asyncio.gather(*(run_rail_search(spec) for spec in specs))
        }
    unpriced_rows = sum(outcome.unpriced_rows for outcome in quotes.values())
    failed_searches = sum(outcome.error is not None for outcome in quotes.values())
    empty_searches = sum(outcome.no_results for outcome in quotes.values())
    priced_searches = sum(bool(outcome.options) for outcome in quotes.values())

    city_by_code = {city.code: city for city in [origin, *destinations]}
    route_candidates: list[dict] = []
    candidate_order_count = 0
    for order in itertools.permutations(destinations):
        path = [origin, *order]
        if return_to_origin:
            path.append(origin)
        leg_dates = evenly_spaced_leg_dates(start_date, end_date, len(path) - 1)
        leg_selections: list[tuple[AirportCity, AirportCity, date, ModeOption, ModeOption]] = []
        complete = True
        for position, (from_city, to_city) in enumerate(zip(path, path[1:])):
            key = (position, leg_dates[position].isoformat(), from_city.code, to_city.code)
            outcome = quotes.get(key, FlightSearchOutcome())
            edge_key = f"{from_city.code}->{to_city.code}"
            distance_m = distances_m.get(edge_key)
            mode_options: list[ModeOption] = []
            if distance_m is not None:
                distance_km = distance_m / 1000.0
                mode_options.append(
                    ModeOption(
                        mode="ground",
                        cost_myr=distance_km * settings.fare_myr_per_km,
                        duration_minutes=round(
                            (distance_km / settings.average_speed_kmh) * 60
                            + settings.ground_overhead_minutes
                        ),
                        distance_km=distance_km,
                        distance_source=distance_sources.get(edge_key, "assumed_connection"),
                    )
                )
            for flight in outcome.options:
                mode_options.append(
                    ModeOption(
                        mode="flight",
                        cost_myr=flight.price_myr,
                        duration_minutes=flight.duration_minutes + round(settings.flight_airport_buffer_minutes),
                        distance_km=0.0,
                        distance_source="flight",
                        airlines=flight.airlines,
                        segment_count=flight.segment_count,
                        search_url=flight.search_url,
                    )
                )
            rail_outcome = rail_results.get(key, RailSearchOutcome())
            for rail in rail_outcome.options:
                mode_options.append(
                    ModeOption(
                        mode="rail",
                        cost_myr=None,
                        duration_minutes=rail.duration_minutes,
                        distance_km=0.0,
                        distance_source="transitous_rail",
                        segment_count=1,
                        departure_time=rail.departure_time,
                        arrival_time=rail.arrival_time,
                        departure_timezone=rail.departure_timezone,
                        arrival_timezone=rail.arrival_timezone,
                        from_stop=rail.from_stop,
                        to_stop=rail.to_stop,
                        service_names=rail.service_names,
                        operators=rail.operators,
                    )
                )
            if not mode_options:
                complete = False
                break
            selected = _choose_mode(mode_options, preference)
            rail_options = [option for option in mode_options if option.mode == "rail"]
            rail_selected = min(rail_options, key=lambda option: option.duration_minutes) if rail_options else selected
            leg_selections.append((from_city, to_city, leg_dates[position], selected, rail_selected))
        if not complete or len(leg_selections) != len(path) - 1:
            continue
        candidate_order_count += 1

        variants = [("preferred", [selection[3] for selection in leg_selections])]
        rail_selections = [selection[4] for selection in leg_selections]
        if any(option.mode == "rail" for option in rail_selections) and rail_selections != variants[0][1]:
            variants.append(("rail", rail_selections))

        path_codes = [city.code for city in path]
        for variant, selections in variants:
            legs: list[dict] = []
            for (from_city, to_city, leg_date, _, _), selected in zip(leg_selections, selections):
                legs.append(
                    {
                        "from_city": city_by_code[from_city.code],
                        "to_city": city_by_code[to_city.code],
                        "departure_date": leg_date.isoformat(),
                        "mode": selected.mode,
                        "cost_myr": round(selected.cost_myr, 2) if selected.cost_myr is not None else None,
                        "duration_minutes": selected.duration_minutes,
                        "distance_km": round(selected.distance_km, 1),
                        "distance_source": selected.distance_source,
                        "airlines": list(selected.airlines),
                        "segment_count": selected.segment_count,
                        "search_url": selected.search_url,
                        "departure_time": selected.departure_time,
                        "arrival_time": selected.arrival_time,
                        "departure_timezone": selected.departure_timezone,
                        "arrival_timezone": selected.arrival_timezone,
                        "from_stop": selected.from_stop,
                        "to_stop": selected.to_stop,
                        "service_names": list(selected.service_names),
                        "operators": list(selected.operators),
                    }
                )
            cost_is_known = all(leg["cost_myr"] is not None for leg in legs)
            total_cost = sum(leg["cost_myr"] for leg in legs if leg["cost_myr"] is not None) if cost_is_known else None
            flight_cost = sum(leg["cost_myr"] for leg in legs if leg["mode"] == "flight")
            ground_cost = sum(leg["cost_myr"] for leg in legs if leg["mode"] == "ground")
            rail_cost = None if any(leg["mode"] == "rail" for leg in legs) else 0.0
            ground_distance = sum(leg["distance_km"] for leg in legs if leg["mode"] == "ground")
            total_minutes = sum(leg["duration_minutes"] for leg in legs)
            route_id = hashlib.sha1(
                ("/".join(path_codes) + ":" + preference + ":" + variant).encode()
            ).hexdigest()[:12]
            route_candidates.append(
                {
                    "id": route_id,
                    "variant": variant,
                    "rank": 0,
                    "stops": [city for city in path],
                    "legs": legs,
                    "flight_cost_myr": round(flight_cost, 2),
                    "ground_cost_myr": round(ground_cost, 2),
                    "ground_distance_km": round(ground_distance, 1),
                    "total_cost_myr": round(total_cost, 2) if total_cost is not None else None,
                    "total_time_hours": round(total_minutes / 60.0, 1),
                    "balanced_score": None,
                    "rail_cost_myr": rail_cost,
                }
            )

    if preference == "balanced" and route_candidates:
        priced_routes = [route for route in route_candidates if route["total_cost_myr"] is not None]
        min_cost = min((route["total_cost_myr"] for route in priced_routes), default=0)
        max_cost = max((route["total_cost_myr"] for route in priced_routes), default=0)
        min_time = min(route["total_time_hours"] for route in route_candidates)
        max_time = max(route["total_time_hours"] for route in route_candidates)
        for route in route_candidates:
            cost = route["total_cost_myr"]
            cost_score = (
                (cost - min_cost) / (max_cost - min_cost)
                if cost is not None and max_cost > min_cost
                else (0.0 if cost is not None else 1.0)
            )
            time_score = (route["total_time_hours"] - min_time) / (max_time - min_time) if max_time > min_time else 0.0
            route["balanced_score"] = (cost_score + time_score) / 2.0
        route_candidates.sort(key=lambda route: (
            route["balanced_score"],
            route["total_cost_myr"] if route["total_cost_myr"] is not None else float("inf"),
            route["total_time_hours"],
        ))
    elif preference == "shortest":
        route_candidates.sort(key=lambda route: (
            route["total_time_hours"],
            route["total_cost_myr"] if route["total_cost_myr"] is not None else float("inf"),
        ))
    else:
        route_candidates.sort(key=lambda route: (
            route["total_cost_myr"] if route["total_cost_myr"] is not None else float("inf"),
            route["total_time_hours"],
        ))

    for rank, route in enumerate(route_candidates, 1):
        route["rank"] = rank
        route["stops"] = [
            {
                "code": city.code,
                "flight_code": city.flight_code,
                "name": city.name,
                "country_code": city.country_code,
                "longitude": city.longitude,
                "latitude": city.latitude,
                "coordinates": [city.longitude, city.latitude],
            }
            for city in route["stops"]
        ]
        for leg in route["legs"]:
            for field in ("from_city", "to_city"):
                city = leg[field]
                leg[field] = {
                    "code": city.code,
                    "flight_code": city.flight_code,
                    "name": city.name,
                    "country_code": city.country_code,
                    "longitude": city.longitude,
                    "latitude": city.latitude,
                    "coordinates": [city.longitude, city.latitude],
                }

    return {
        "routes": route_candidates,
        "preference": preference,
        "candidate_count": candidate_order_count,
        "searches_attempted": len(specs),
        "searches_with_priced_results": priced_searches,
        "rail_searches_attempted": len(specs) if rail_search is not None else 0,
        "rail_searches_with_results": sum(bool(outcome.options) for outcome in rail_results.values()),
        "rail_searches_without_results": sum(outcome.no_results for outcome in rail_results.values()),
        "rail_searches_failed": sum(outcome.error is not None for outcome in rail_results.values()),
        "searches_without_results": empty_searches,
        "searches_failed": failed_searches,
        "unpriced_rows_skipped": unpriced_rows,
        "maximum_searches": maximum_search_count(len(destinations), return_to_origin),
        "date_schedule": [day.isoformat() for day in evenly_spaced_leg_dates(start_date, end_date, len(destinations) + int(return_to_origin))],
        "limitations": [
            "One flight search is made per possible city pair and scheduled travel day; no flexible-date fare calendar is available.",
            "Travel days are spaced evenly through the selected date range, so nights per city are not optimized.",
            "Each listed destination is visited once; all possible destination orders are compared.",
            "Transitous rail fares are not currently used in totals; routes containing a rail leg have an incomplete fare total.",
        ],
    }
