"""Compatibility projection for the original single-origin routes endpoint."""
from __future__ import annotations

import asyncio
from fastapi import HTTPException

from .places import city_to_dict, load_airport_cities
from .planner_discovery import manager
from .planner_models import FareOffer, Movement, Place, TripSpec, Visit
from .planner_optimizer import optimize
from .trip_optimizer import build_search_specs
from .transitous import transitous
from .flight_search import flight_search_status


async def legacy_routes(request):
    catalog = load_airport_cities()
    selected = [catalog.get(code.upper()) for code in [request.origin_code, *request.destination_codes]]
    if any(c is None for c in selected):
        raise HTTPException(422, "One or more cities are not in the IATA catalog.")
    origin, *destinations = selected
    places = {c.code: Place(id=c.code, name=c.name, latitude=c.latitude, longitude=c.longitude,
                           timezone=c.timezone_name or "UTC", country_code=c.country_code,
                           airport_codes=list(c.airport_codes), flight_code=c.flight_code) for c in selected}
    spec = TripSpec(home=places[origin.code], visits=[Visit(place=places[c.code], min_stay_hours=request.min_city_stay_nights*24) for c in destinations],
                    start_date=request.start_date, end_date=request.end_date, date_mode="fixed",
                    modes=["flight", "rail"] if transitous.contact_url else ["flight"],
                    departure_start=request.preferred_departure_start, departure_end=request.preferred_departure_end,
                    timing={"flight_before_minutes": request.settings.flight_airport_buffer_minutes})
    snapshot = {"revision": 0, "movements": [], "offers": [], "roads": {}}
    statuses = []
    road_task = {"kind": "road", "key": "road"}
    try:
        outcome, _ = await manager.fetch(road_task, spec, snapshot)
        manager.ingest(road_task, outcome, spec, snapshot)
    except Exception:
        pass  # Airport transfer assumptions remain explicitly marked.
    specs = build_search_specs(origin, destinations, request.start_date, request.end_date, request.return_to_origin, request.min_city_stay_nights)
    tasks = []
    for item in specs:
        for kind in (["flight", "transit"] if transitous.contact_url else ["flight"]):
            tasks.append({"kind": kind, "key": str(item.key), "from_id": item.origin.code, "to_id": item.destination.code, "date": item.departure_date.isoformat()})
    semaphore = asyncio.Semaphore(3)

    async def run(task):
        async with semaphore:
            try:
                outcome, _ = await manager.fetch(task, spec, snapshot)
            except Exception as exc:
                outcome = {"status": "failed", "message": type(exc).__name__}
            return task, outcome
    for task, outcome in await asyncio.gather(*(run(t) for t in tasks)):
        manager.ingest(task, outcome, spec, snapshot)
        statuses.append((task["kind"], outcome["status"]))
    result = await asyncio.to_thread(optimize, spec, [Movement.model_validate(m) for m in snapshot["movements"]],
                                     [FareOffer.model_validate(o) for o in snapshot["offers"]], [], 0, 0, None, 25000, request.return_to_origin)
    provider_fares = {o["movement_ids"][0]: o["low"] for o in snapshot["offers"] if len(o["movement_ids"]) == 1 and o["currency"] == "MYR"}
    cities = {c.code: city_to_dict(c) for c in selected}
    routes = []
    for route in result["routes"]:
        legs = []
        for m in route["movements"]:
            main_segments = [s for s in m["segments"] if s["mode"] not in {"transfer", "walk", "foot"}]
            legs.append({"from_city": cities[m["from_id"]], "to_city": cities[m["to_id"]], "departure_date": m["departure"][:10],
                         "mode": "flight" if m["mode"] == "flight" else "rail", "cost_myr": provider_fares.get(m["id"]),
                         "duration_minutes": round(m["duration_minutes"]), "distance_km": m.get("distance_km") or 0,
                         "distance_source": "flight" if m["mode"] == "flight" else "transitous_rail", "airlines": list({s["operator"] for s in main_segments if s.get("operator")}),
                         "segment_count": len(main_segments), "search_url": m.get("search_url"), "departure_time": main_segments[0]["departure"] if main_segments else m["departure"],
                         "arrival_time": main_segments[-1]["arrival"] if main_segments else m["arrival"], "departure_timezone": places[m["from_id"]].timezone,
                         "arrival_timezone": places[m["to_id"]].timezone, "from_stop": main_segments[0]["from_name"] if main_segments else None,
                         "to_stop": main_segments[-1]["to_name"] if main_segments else None, "service_names": [s["service"] for s in main_segments if s.get("service")],
                         "operators": list({s["operator"] for s in main_segments if s.get("operator")})})
        stops = [cities[origin.code], *(leg["to_city"] for leg in legs)]
        routes.append({"id": route["id"], "variant": "rail" if any(l["mode"] == "rail" for l in legs) else "preferred", "stops": stops, "legs": legs,
                       "total_cost_myr": route["total_cost_myr"], "flight_cost_myr": sum(l["cost_myr"] or 0 for l in legs if l["mode"] == "flight"),
                       "rail_cost_myr": sum(l["cost_myr"] for l in legs if l["mode"] == "rail") if all(l["cost_myr"] is not None for l in legs if l["mode"] == "rail") else None,
                       "ground_cost_myr": 0, "ground_distance_km": 0, "total_time_hours": route["travel_hours"], "stay_hours": route["stay_hours"],
                       "cost_per_stay_hour_myr": route["cost_per_stay_hour_myr"], "balanced_score": None})
    routes.sort(key=lambda r: (-r["stay_hours"], r["total_cost_myr"] if r["total_cost_myr"] is not None else float("inf")) if request.preference == "shortest" else
                (r["total_cost_myr"] if r["total_cost_myr"] is not None else float("inf"), -r["stay_hours"]))
    for rank, route in enumerate(routes, 1):
        route["rank"] = rank
    count = lambda kind, status: sum(k == kind and s == status for k, s in statuses)
    return {"routes": routes, "preference": request.preference, "candidate_count": len({tuple(s["code"] for s in r["stops"]) for r in routes}),
            "searches_attempted": len(specs), "searches_with_priced_results": count("flight", "success"), "searches_failed": count("flight", "failed"), "searches_without_results": count("flight", "empty"),
            "rail_searches_attempted": len(specs) if transitous.contact_url else 0, "rail_searches_with_results": count("transit", "success"), "rail_searches_failed": count("transit", "failed"), "rail_searches_without_results": count("transit", "empty"),
            "unpriced_rows_skipped": 0, "maximum_searches": len(specs), "date_schedule": sorted({s.departure_date.isoformat() for s in specs}),
            "limitations": ["Compatibility endpoint: assigned travel dates. Use /api/v2 for flexible dates and persistent discovery.", "Airport transfers with unknown fares keep complete totals provisional."],
            "origin": cities[origin.code], "routing_status": "partial", "routing_message": "Results use the schedule-aware v2 engine; transit coverage depends on configured feeds.",
            "search_message": None, "transit_api_requests": 0, "transit_cache_hits": 0, "transit_api_failures": count("transit", "failed"), "transit_location_failures": 0,
            "transit_stop_resolutions": [], "transit_unresolved_stops": [], "preferred_departure_start": request.preferred_departure_start.strftime("%H:%M"),
            "preferred_departure_end": request.preferred_departure_end.strftime("%H:%M"), "min_city_stay_nights": request.min_city_stay_nights, "flight_search": flight_search_status()}
