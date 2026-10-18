"""Resumable, budgeted provider discovery. Each job owns its counters/queue."""
from __future__ import annotations

import asyncio
import copy
import itertools
import logging
import math
import os
import time as clock
import uuid
from datetime import date, datetime, time, timedelta, timezone
from functools import lru_cache
from zoneinfo import ZoneInfo

import httpx

from .planner_models import AirportConnection, Charge, FareOffer, Movement, Place, PricingRule, Segment, TripSpec, stable_id
from .planner_optimizer import bounds, optimize
from .planner_providers import fetch_flights, flight_query
from .planner_store import PlannerStore, store
from .planner_positioning import search_modes
from .transitous import transitous

logger = logging.getLogger("uvicorn.error")

UTC = timezone.utc
TRANSIT_MODES = {"rail": "HIGHSPEED_RAIL,LONG_DISTANCE,NIGHT_RAIL,REGIONAL_RAIL,SUBURBAN", "bus": "BUS", "coach": "COACH", "subway": "SUBWAY", "tram": "TRAM"}
MODE_MAP = {"BUS": "bus", "COACH": "coach", "SUBWAY": "subway", "TRAM": "tram"}
RAIL_MODES = {"RAIL", "HIGHSPEED_RAIL", "LONG_DISTANCE", "NIGHT_RAIL", "REGIONAL_FAST_RAIL", "REGIONAL_RAIL", "SUBURBAN"}


def timestamp(value):
    if isinstance(value, (int, float)):
        return datetime.fromtimestamp(value, UTC)
    return datetime.fromisoformat(str(value).replace("Z", "+00:00")).astimezone(UTC)


def refresh_quote_freshness(result, now):
    """Expiry affects quote warnings, not ticket prices or route eligibility."""
    for group in ("routes", "dominated_routes", "refinement_routes"):
        for route in result.get(group, []):
            for offer in route.get("purchases", []):
                if offer.get("source") == "provider" and offer.get("expires_at") and timestamp(offer["expires_at"]) < now:
                    offer["estimated"] = True
                    if not offer.get("label", "").startswith("Stale quote: "):
                        offer["label"] = "Stale quote: "+offer.get("label", "")
                    route["estimated"] = True


@lru_cache(maxsize=1)
def iata_airports():
    import airportsdata
    return airportsdata.load("IATA")


@lru_cache(maxsize=1)
def iata_metros():
    import airportsdata
    return airportsdata.load_iata_macs()


def airport_places(spec):
    airports = iata_airports()
    metros = iata_metros()
    result = {}
    for city in spec.places().values():
        for code in set(city.airport_codes) | set(metros.get(city.flight_code, {}).get("airports", {})):
            airport = airports.get(code)
            if airport:
                result["airport:"+code] = Place(id="airport:"+code, name=airport["name"], latitude=airport["lat"], longitude=airport["lon"], timezone=airport["tz"])
    return result


def airport_transfer_rows(spec, movements=()):
    """Finite configured airport/city pairs, supplemented by retrieved charges."""
    rows = {}
    metros = iata_metros()
    airports = iata_airports()
    places = spec.places()
    for city in places.values():
        codes = set(city.airport_codes) | set(metros.get(city.flight_code, {}).get("airports", {}))
        if city.flight_code in airports:
            codes.add(city.flight_code)
        for code in sorted(codes):
            for origin, dest in ((city.id, "airport:"+code), ("airport:"+code, city.id)):
                rows[(origin, dest)] = {"from_id": origin, "to_id": dest,
                    "label": f"{city.name} → {code} airport" if origin == city.id else f"{code} airport → {city.name}"}
    for movement in movements:
        for charge in movement.get("charges", []):
            origin, dest = charge.get("from_id"), charge.get("to_id")
            if charge.get("kind") not in {"Airport access", "Airport egress"} or not origin or not dest:
                continue
            city_id = dest if origin.startswith("airport:") else origin
            airport_id = origin if origin.startswith("airport:") else dest
            if city_id not in places or not airport_id.startswith("airport:"):
                continue
            name = places[city_id].name
            code = airport_id.removeprefix("airport:")
            rows[(origin, dest)] = {"from_id": origin, "to_id": dest,
                "label": f"{code} airport → {name}" if origin == airport_id else f"{name} → {code} airport"}
    return sorted(rows.values(), key=lambda row: row["label"])


def airport_transfer_rules(trip, spec):
    rules = []
    for item in trip.get("airport_transfer_estimates", []):
        if item["adults"] != spec.adults or item.get("low") is None:
            continue
        origin, dest = item["from_id"], item["to_id"]
        rules.append(PricingRule(id="airport-transfer:"+stable_id(origin, dest, spec.adults, item.get("mode", "taxi")),
            name="Trip airport transfer estimate", from_id=origin, to_id=dest, mode=item.get("mode", "taxi"),
            service="Airport egress" if origin.startswith("airport:") else "Airport access",
            low=item["low"], high=item.get("high"), currency=item["currency"], unit="party", priority=1000000))
    return rules


def airport_transfer_variants(raw_movements, trip, spec, roads, connections):
    """Expand access/egress choices for the solver only; shared schedules stay clean."""
    choices = {}
    for item in trip.get("airport_transfer_estimates", []):
        if item["adults"] == spec.adults:
            choices.setdefault((item["from_id"], item["to_id"]), []).append(item)
    result = []
    for raw in raw_movements:
        movement = Movement.model_validate(raw)
        flights = [segment.model_dump(mode="json") for segment in movement.segments if segment.mode == "flight"]
        if movement.source != "Google Flights / fast-flights" or not flights or movement.from_id not in spec.places() or movement.to_id not in spec.places():
            result.append(movement)
            continue
        access = (movement.from_id, "airport:"+flights[0]["from_id"])
        egress = ("airport:"+flights[-1]["to_id"], movement.to_id)
        options = []
        for pair in (access, egress):
            entries = choices.get(pair, [])
            # The existing routed taxi remains available unless explicitly edited.
            options.append(entries if any(e.get("mode", "taxi") == "taxi" for e in entries) else [None, *entries])
        for selected in itertools.product(*options):
            if not any(selected):
                result.append(movement)
                continue
            local_roads = dict(roads)
            for pair, entry in zip((access, egress), selected):
                if entry and entry.get("duration_minutes") is not None:
                    local_roads[pair[0]+"->"+pair[1]] = {"duration_minutes": entry["duration_minutes"], "distance_km": None}
            variant = flight_movement(spec.places()[movement.from_id], spec.places()[movement.to_id], flights, spec, local_roads, connections)
            variant.id = movement.id+":transfer:"+stable_id(selected)
            variant.template_id = movement.id
            variant.search_url = movement.search_url
            for kind, entry in zip(("access", "egress"), selected):
                charge = next((c for c in variant.charges if c.kind == "Airport "+kind), None)
                mode = entry.get("mode", "taxi") if entry else "taxi"
                if charge:
                    charge.id = movement.id+":"+kind+(":"+mode if mode != "taxi" else "")
                    charge.mode = mode
                if entry:
                    segment = next((s for s in variant.segments if s.source == "Airport "+kind), None)
                    if segment:
                        segment.mode = mode
                        segment.source = "User-estimated airport "+kind
                        segment.assumed = True
            result.append(variant)
    return result


def seed_dates(spec):
    days = (spec.end_date-spec.start_date).days
    n = len(spec.visits)+1
    return [spec.start_date+timedelta(days=round(days*i/max(1, n-1))) for i in range(n)]


def visit_return_orders(order):
    """Visit every destination, then optionally revisit each earlier city once."""
    yield order
    for count in range(1, len(order)):
        for suffix in itertools.permutations(order[:-1], count):
            yield (*order, *suffix)


def rough_date_windows(spec):
    """Optimistic pair windows using only minimum stays, with zero travel time.

    Union all gateway/visit orders so a pair remains searchable whenever any
    order might work. Exact schedules, buffers and commitments belong to the DP.
    """
    start, end = bounds(spec)
    # Own-car recovery can introduce detours outside the simple gateway paths.
    if spec.cars.own_enabled:
        return {pair: (start, end) for pair in itertools.permutations(spec.places(), 2)}
    stays = {v.place.id: v.min_stay_hours for v in spec.visits}
    windows = {}
    for order in (path for first in itertools.permutations(stays) for path in visit_return_orders(first)):
        for departure in spec.departures:
            for arrival in spec.arrivals:
                path = [spec.home.id, departure.id, *(id for id in order if id != departure.id), arrival.id, spec.home.id]
                path = [id for i, id in enumerate(path) if i == 0 or id != path[i-1]]
                unspent = set(stays)
                elapsed = 0
                for a, b in zip(path, path[1:]):
                    if a in unspent:
                        elapsed += stays[a]
                        unspent.remove(a)
                    earliest = start+timedelta(hours=elapsed)
                    latest = end-timedelta(hours=sum(stays[id] for id in unspent))
                    if earliest > latest:
                        continue
                    old = windows.get((a, b), (earliest, latest))
                    windows[a, b] = (min(old[0], earliest), max(old[1], latest))
    return windows


def tasks_for(spec):
    places = spec.places()
    pairs = list(itertools.permutations(places, 2))
    windows = rough_date_windows(spec)
    tasks = [{"kind": "road", "key": "road"}] if any(m in {"flight", "car", "taxi"} for m in spec.modes) else []
    seen = {"road"}
    has_transit = bool(transitous.contact_url) and any(mode in TRANSIT_MODES for mode in spec.modes)

    def task(a, b, day, kind):
        allowed_modes = search_modes(spec, a, b)
        if kind == "flight" and "flight" not in allowed_modes:
            return
        if kind == "transit" and not any(m in TRANSIT_MODES for m in allowed_modes):
            return
        window = windows.get((a, b))
        if window is None:
            return
        zone = ZoneInfo(places[a].timezone)
        if not window[0].astimezone(zone).date() <= day <= window[1].astimezone(zone).date():
            return
        key = stable_id(kind, a, b, day.isoformat())
        if key in seen:
            return
        if kind == "flight" and (not places[a].flight_code or not places[b].flight_code):
            return
        seen.add(key)
        tasks.append({"key": key, "kind": kind, "from_id": a, "to_id": b, "date": day.isoformat()})

    # Prioritize complete seeds, rather than spending the first batch on just
    # the outbound directions. Remaining calendar dates follow deterministically.
    dates = seed_dates(spec)
    for order in (path for first in itertools.permutations([v.place.id for v in spec.visits]) for path in visit_return_orders(first)):
        for departure in spec.departures:
            for arrival in spec.arrivals:
                path = [spec.home.id, departure.id, *order, arrival.id, spec.home.id]
                path = [v for i, v in enumerate(path) if i == 0 or v != path[i-1]]
                for i, (a, b) in enumerate(zip(path, path[1:])):
                    day = dates[min(len(dates)-1, max(0, i-(departure.id != spec.home.id)))]
                    if i == 0:
                        day = spec.start_date
                    if i == len(path)-2:
                        day = spec.end_date
                    if "flight" in spec.modes:
                        task(a, b, day, "flight")
                    if has_transit:
                        task(a, b, day, "transit")
    seed_count = len(tasks)
    start, end = bounds(spec)
    for a, b in pairs:
        zone = ZoneInfo(places[a].timezone)
        first, last = start.astimezone(zone).date(), end.astimezone(zone).date()
        days = [first+timedelta(days=i) for i in range((last-first).days+1)]
        for day in days:
            if "flight" in spec.modes:
                task(a, b, day, "flight")
            if has_transit:
                task(a, b, day, "transit")
    # A combined ticket can introduce schedules absent from one-way results.
    # Search gateway return tickets independently of completed DP histories.
    flight_days = {}
    for item in tasks:
        if item["kind"] == "flight":
            flight_days.setdefault((item["from_id"], item["to_id"]), []).append(date.fromisoformat(item["date"]))
    minimum = timedelta(hours=sum(v.min_stay_hours for v in spec.visits))
    bundles = []
    for gateway in spec.departures:
        if gateway.id not in {p.id for p in spec.arrivals}:
            continue
        earliest = start
        latest = end
        if gateway.id != spec.home.id:
            for direction in ("outbound", "return"):
                a, b = (spec.home.id, gateway.id) if direction == "outbound" else (gateway.id, spec.home.id)
                services = [s for s in spec.positioning_services if s.direction == direction and s.gateway_id == gateway.id
                            and s.mode in spec.modes and s.departure >= start and s.arrival <= end]
                if not search_modes(spec, a, b) and services:
                    if direction == "outbound":
                        earliest = max(earliest, min(s.arrival for s in services))
                    else:
                        latest = min(latest, max(s.departure for s in services))
        for visit in spec.visits:
            dest = visit.place
            if gateway.id == dest.id:
                continue
            for outbound in sorted(flight_days.get((gateway.id, dest.id), [])):
                if gateway.id == spec.home.id and spec.date_mode == "fixed" and outbound != spec.start_date:
                    continue
                first = max(earliest, datetime.combine(outbound, spec.departure_start, ZoneInfo(gateway.timezone)).astimezone(UTC))
                if first > datetime.combine(outbound, spec.departure_end, ZoneInfo(gateway.timezone)).astimezone(UTC):
                    continue
                for inbound in sorted(flight_days.get((dest.id, gateway.id), [])):
                    last = min(latest, datetime.combine(inbound, spec.departure_end, ZoneInfo(dest.timezone)).astimezone(UTC))
                    if last < first+minimum or last < datetime.combine(inbound, spec.departure_start, ZoneInfo(dest.timezone)).astimezone(UTC):
                        continue
                    legs = [make_leg(gateway, dest, outbound.isoformat()), make_leg(dest, gateway, inbound.isoformat())]
                    key = stable_id("round-trip", legs)
                    if key not in seen:
                        seen.add(key)
                        bundles.append({"kind": "bundle", "ticket_kind": "round-trip", "key": key, "legs": legs})
    # Try complete one-way seeds first, then round trips before bulk calendar discovery.
    tasks[seed_count:seed_count] = bundles
    return tasks


def make_leg(origin, dest, day):
    metros = iata_metros()
    origin_airports = sorted(set(origin.airport_codes) | set(metros.get(origin.flight_code, {}).get("airports", {})))
    dest_airports = sorted(set(dest.airport_codes) | set(metros.get(dest.flight_code, {}).get("airports", {})))
    return {"from_id": origin.id, "to_id": dest.id, "date": day,
            "from_code": origin.flight_code, "to_code": dest.flight_code,
            "from_airports": origin_airports, "to_airports": dest_airports, "timezone": origin.timezone}


def flight_movement(origin, dest, segments, spec, roads, airport_connections=None):
    raw_departure, raw_arrival = timestamp(segments[0]["departure"]), timestamp(segments[-1]["arrival"])
    id = "flight:"+stable_id(origin.id, dest.id, segments, spec.adults)
    normalized = [Segment.model_validate(s) for s in segments]
    assumptions = []
    charges = []
    airport_connections = airport_connections or {}
    access_minutes = []
    usable = True
    for kind, city, airport, reverse in (("access", origin, segments[0]["from_id"], False), ("egress", dest, segments[-1]["to_id"], True)):
        left, right = ("airport:"+airport, city.id) if reverse else (city.id, "airport:"+airport)
        road = roads.get(left+"->"+right)
        duration = road["duration_minutes"] if road else spec.timing.airport_transfer_fallback_minutes
        if duration is None:
            usable = False
            duration = 0
            assumptions.append(f"{city.name}: airport access time is unresolved; this movement is not usable until routing or a transfer assumption is provided")
        distance = road["distance_km"] if road else None
        access_minutes.append(duration)
        if not road:
            assumptions.append(f"{city.name}: {duration} minute airport transfer assumption; road routing unavailable")
        if duration > 0 or (distance or 0) > 0:
            charges.append(Charge(id=id+":"+kind, kind=f"Airport {kind}", distance_km=distance, from_id=left, to_id=right, country_code=city.country_code))
            normalized.append(Segment(mode="transfer", from_name=city.name if not reverse else airport,
                                      to_name=airport if not reverse else city.name, duration_minutes=duration, assumed=road is None, source="OSRM" if road else "User-editable transfer assumption"))
    dep = raw_departure-timedelta(minutes=access_minutes[0]+spec.timing.flight_before_minutes)
    arr = raw_arrival+timedelta(minutes=access_minutes[1]+spec.timing.flight_after_minutes)
    # Lay out the full door-to-door timeline in chronological order. Connection
    # waits already belong to elapsed time; they are not added again to duration.
    flights = [s for s in normalized if s.mode == "flight"]
    chronology = []
    if access_minutes[0]:
        chronology.append(Segment(mode="transfer", from_name=origin.name, to_name=flights[0].from_name,
                                  departure=dep, arrival=raw_departure-timedelta(minutes=spec.timing.flight_before_minutes),
                                  duration_minutes=access_minutes[0], source="Airport access", assumed=any(origin.name in a for a in assumptions),
                                  from_timezone=origin.timezone, to_timezone=flights[0].from_timezone))
    if spec.timing.flight_before_minutes:
        chronology.append(Segment(mode="wait", from_name=flights[0].from_name, to_name=flights[0].from_name,
                                  departure=raw_departure-timedelta(minutes=spec.timing.flight_before_minutes), arrival=raw_departure,
                                  duration_minutes=spec.timing.flight_before_minutes, source="Flight readiness buffer", assumed=True,
                                  from_timezone=flights[0].from_timezone, to_timezone=flights[0].from_timezone))
    for i, flight in enumerate(flights):
        if i:
            previous = flights[i-1]
            airport_change = previous.to_id != flight.from_id
            if airport_change:
                gap_minutes = (flight.departure-previous.arrival).total_seconds()/60
                connection = airport_connections.get((previous.to_id, flight.from_id))
                if connection and connection.duration_minutes <= gap_minutes:
                    transfer_arrival = previous.arrival+timedelta(minutes=connection.duration_minutes)
                    chronology.append(Segment(mode=connection.mode, from_name=previous.to_name, to_name=flight.from_name,
                                              departure=previous.arrival, arrival=transfer_arrival,
                                              duration_minutes=connection.duration_minutes, from_id=previous.to_id,
                                              to_id=flight.from_id, from_timezone=previous.to_timezone,
                                              to_timezone=flight.from_timezone, source="User-verified airport transfer", assumed=True))
                    remaining_minutes = gap_minutes-connection.duration_minutes
                    if remaining_minutes > 0:
                        chronology.append(Segment(mode="wait", from_name=flight.from_name, to_name=flight.from_name,
                                                  departure=transfer_arrival, arrival=flight.departure,
                                                  duration_minutes=remaining_minutes, from_id=flight.from_id,
                                                  to_id=flight.from_id, from_timezone=flight.from_timezone,
                                                  to_timezone=flight.from_timezone, source="Layover after airport transfer", assumed=True))
                    charges.append(Charge(id=f"{id}:airport-transfer:{i}", kind=f"Airport transfer {previous.to_id} → {flight.from_id}",
                                          mode=connection.mode, low=connection.fare_amount, high=connection.fare_amount,
                                          currency=connection.currency, source="user", from_id=f"airport:{previous.to_id}",
                                          to_id=f"airport:{flight.from_id}"))
                else:
                    if gap_minutes > 0:
                        chronology.append(Segment(mode="transfer", from_name=previous.to_name, to_name=flight.from_name,
                                                  departure=previous.arrival, arrival=flight.departure, duration_minutes=gap_minutes,
                                                  from_timezone=previous.to_timezone, to_timezone=flight.from_timezone,
                                                  source="Airport change needs confirmation" if not connection else "Airport transfer exceeds available layover",
                                                  assumed=True))
                    usable = False
                    if connection:
                        assumptions.append(f"Airport connection {previous.to_id} → {flight.from_id} needs {connection.duration_minutes:g} minutes but only {max(0, gap_minutes):g} are available")
                    else:
                        assumptions.append(f"Airport change {previous.to_id} → {flight.from_id}: add a verified connection before using this journey")
            else:
                gap_minutes = (flight.departure-previous.arrival).total_seconds()/60
                if gap_minutes > 0:
                    chronology.append(Segment(mode="wait", from_name=previous.to_name, to_name=flight.from_name,
                                              departure=previous.arrival, arrival=flight.departure, duration_minutes=gap_minutes,
                                              from_timezone=previous.to_timezone, to_timezone=flight.from_timezone,
                                              source="Scheduled connection"))
        chronology.append(flight)
    if spec.timing.flight_after_minutes:
        chronology.append(Segment(mode="wait", from_name=flights[-1].to_name, to_name=flights[-1].to_name, departure=raw_arrival,
                                  arrival=raw_arrival+timedelta(minutes=spec.timing.flight_after_minutes), duration_minutes=spec.timing.flight_after_minutes,
                                  source="Arrival buffer", assumed=True, from_timezone=flights[-1].to_timezone, to_timezone=flights[-1].to_timezone))
    if access_minutes[1]:
        chronology.append(Segment(mode="transfer", from_name=flights[-1].to_name, to_name=dest.name,
                                  departure=raw_arrival+timedelta(minutes=spec.timing.flight_after_minutes), arrival=arr,
                                  duration_minutes=access_minutes[1], source="Airport egress", assumed=any(dest.name in a for a in assumptions),
                                  from_timezone=flights[-1].to_timezone, to_timezone=dest.timezone))
    return Movement(id=id, from_id=origin.id, to_id=dest.id, mode="flight", departure=dep, arrival=arr, usable=usable,
                    duration_minutes=(arr-dep).total_seconds()/60, transfers=len(segments)-1,
                    segments=chronology, charges=charges, source="Google Flights / fast-flights", assumptions=assumptions)


def shareable_snapshot(snapshot, spec):
    """Remove trip-scoped airport-transfer overlays before caching a graph by discovery key."""
    shared = copy.deepcopy(snapshot)
    places = spec.places()
    for raw in shared.get("movements", []):
        movement = Movement.model_validate(raw)
        if movement.source != "Google Flights / fast-flights" or movement.from_id not in places or movement.to_id not in places:
            continue
        flights = [segment.model_dump(mode="json") for segment in movement.segments if segment.mode == "flight"]
        rebuilt = flight_movement(places[movement.from_id], places[movement.to_id], flights, spec, shared.get("roads", {}))
        if rebuilt is None:
            continue
        rebuilt.id = movement.id
        rebuilt.search_url = movement.search_url
        for charge in rebuilt.charges:
            if charge.kind == "Airport access":
                charge.id = movement.id+":access"
            elif charge.kind == "Airport egress":
                charge.id = movement.id+":egress"
        raw.clear()
        raw.update(rebuilt.model_dump(mode="json"))
    shared.setdefault("coverage", {})["unresolved_movements"] = [
        {"id": movement["id"], "from_id": movement["from_id"], "to_id": movement["to_id"], "assumptions": movement["assumptions"]}
        for movement in shared.get("movements", []) if not movement.get("usable", True)
    ]
    return shared


def required_airport_connections(movements):
    airport_pairs = {}
    for movement in movements:
        if movement.get("source") != "Google Flights / fast-flights":
            continue
        flights = [segment for segment in movement.get("segments", []) if segment.get("mode") == "flight"]
        for previous, following in zip(flights, flights[1:]):
            from_airport, to_airport = previous.get("to_id"), following.get("from_id")
            if from_airport and to_airport and from_airport != to_airport:
                key = (from_airport, to_airport)
                pair = airport_pairs.setdefault(key, {"from_airport": from_airport, "to_airport": to_airport,
                                                      "from_name": previous.get("to_name", from_airport),
                                                      "to_name": following.get("from_name", to_airport),
                                                      "journey_count": 0, "unresolved_journey_count": 0})
                pair["journey_count"] += 1
                unresolved_prefixes = (f"Airport change {from_airport} → {to_airport}:",
                                       f"Airport connection {from_airport} → {to_airport} ")
                if any(assumption.startswith(unresolved_prefixes) for assumption in movement.get("assumptions", [])):
                    pair["unresolved_journey_count"] += 1
    return sorted(airport_pairs.values(), key=lambda item: (item["from_airport"], item["to_airport"]))


def transit_fare(itinerary, adults):
    """Evaluate complete GTFS fare products; ambiguous currencies/categories stay unknown."""
    transfers = itinerary.get("fareTransfers")
    if not transfers:
        return None
    currency = None
    total = 0

    def product_value(products):
        nonlocal currency
        if not isinstance(products, list) or not products:
            return None
        value = 0
        for p in products:
            if not isinstance(p, dict) or not isinstance(p.get("amount"), (int, float)) or not p.get("currency"):
                return None
            category = p.get("riderCategory")
            if category and not (category.get("isDefaultFareCategory") or "adult" in str(category.get("name", "")).lower()):
                return None
            if currency and currency != p["currency"]:
                return None
            currency = p["currency"]
            value += p["amount"]
        return value

    for transfer in transfers:
        rule = transfer.get("rule", "A_AB_B")
        effective = transfer.get("effectiveFareLegProducts")
        if not isinstance(effective, list):
            return None
        needed = [] if rule == "AB" else effective[:1] if rule == "A_AB" else effective
        for alternatives in needed:
            values = [product_value(option) for option in alternatives]
            valid = [v for v in values if v is not None]
            if not valid:
                return None
            total += min(valid)
        products = transfer.get("transferProducts", [])
        if products:
            value = product_value(products)
            if value is None:
                return None
            total += value
    if currency is None or total < 0:
        return None
    return round(total*adults, 2), currency


def transit_movements(payload, origin, dest, spec, day):
    movements, offers = [], []
    for itinerary in payload.get("itineraries", []):
        try:
            legs = itinerary.get("legs", [])
            riding = [l for l in legs if l.get("mode") not in {"WALK", "FOOT", "WAIT", "TRANSFER"}]
            if not riding:
                continue
            if any(l.get("mode") not in MODE_MAP and l.get("mode") not in RAIL_MODES for l in riding):
                continue
            modes = [MODE_MAP.get(l.get("mode"), "rail") for l in riding]
            if any(m not in spec.modes for m in modes):
                continue
            dep, arr = timestamp(itinerary["startTime"]), timestamp(itinerary["endTime"])
            ride_dep = timestamp(riding[0].get("startTime") or riding[0]["scheduledStartTime"]).astimezone(ZoneInfo(origin.timezone))
            if ride_dep.date().isoformat() != day or not spec.departure_start <= ride_dep.time().replace(tzinfo=None) <= spec.departure_end:
                continue
            segments = []
            for leg in legs:
                segments.append(Segment(mode=leg.get("mode", "transfer").lower(), from_name=leg.get("from", {}).get("name", origin.name),
                                        to_name=leg.get("to", {}).get("name", dest.name), from_id=leg.get("from", {}).get("stopId"), to_id=leg.get("to", {}).get("stopId"),
                                        departure=timestamp(leg.get("startTime") or leg["scheduledStartTime"]),
                                        arrival=timestamp(leg.get("endTime") or leg["scheduledEndTime"]),
                                        operator=leg.get("agencyName"), service=leg.get("displayName") or leg.get("routeShortName"), source=leg.get("source"),
                                        interline_with_previous=bool(leg.get("interlineWithPreviousLeg"))))
            id = "transit:"+stable_id(origin.id, dest.id, [s.model_dump(mode="json") for s in segments])
            dep -= timedelta(minutes=spec.timing.transit_before_minutes)
            arr += timedelta(minutes=spec.timing.transit_after_minutes)
            mode = "rail" if "rail" in modes else modes[0]
            movement = Movement(id=id, from_id=origin.id, to_id=dest.id, mode=mode, departure=dep, arrival=arr,
                                duration_minutes=(arr-dep).total_seconds()/60, transfers=sum(not l.get("interlineWithPreviousLeg") for l in riding[1:]), segments=segments, source="Transitous / MOTIS")
            movements.append(movement)
            fare = transit_fare(itinerary, spec.adults)
            if fare:
                offers.append(FareOffer(id="provider:"+id, movement_ids=[id], low=fare[0], high=fare[0], currency=fare[1], label="GTFS fare products for party"))
        except (KeyError, TypeError, ValueError):
            continue
    return movements, offers


class DiscoveryManager:
    def __init__(self, database: PlannerStore):
        self.store = database
        self.running = {}
        self.live_jobs = {}
        self.cancelled_jobs = set()
        self.query_locks = {}
        self.optimization_locks = {}
        self.published_inputs = {}
        self.optimization_cadence = {}
        self.http_limit = asyncio.Semaphore(2)

    def rules(self):
        return [PricingRule.model_validate(r) for r in self.store.list("rules")]

    def register_manual_quote(self, job, legs, spec):
        key = stable_id("multi-city", legs)
        links = job.setdefault("bundle_links", [])
        if any(link["kind"] == "multi-city" and stable_id("multi-city", link["legs"]) == key for link in links):
            return False
        query = flight_query(legs, spec.adults, "multi-city", spec.departure_start, spec.departure_end)
        links.append({"kind": "multi-city", "status": "requires_manual_quote", "url": query.url(),
                      "legs": legs, "manual_only": True})
        job["manual_quote_queries"] = sum(link["kind"] == "multi-city" for link in links)
        return True

    def separate_manual_quotes(self, job, spec):
        """Keep historical counters intact; migrate only unprocessed legacy tasks."""
        future = []
        for task in job["queue"][job["cursor"]:]:
            if task.get("ticket_kind") == "multi-city":
                self.register_manual_quote(job, task["legs"], spec)
            else:
                future.append(task)
        job["queue"] = job["queue"][:job["cursor"]]+future
        job["manual_quote_queries"] = sum(link["kind"] == "multi-city" for link in job.get("bundle_links", []))

    async def recalculate(self, trip_id, snapshot=None, expand=False, job_id=None, include_dominated=False):
        started = clock.monotonic()
        logger.debug("planner recalculate.wait trip=%s job=%s", trip_id, job_id)
        lock = self.optimization_locks.setdefault(trip_id, asyncio.Lock())
        waited_for_solver = lock.locked()
        async with lock:
            trip = self.store.get("trips", trip_id)
            cached = trip.get("result")
            if (waited_for_solver and snapshot is None and job_id is None and not expand and cached
                    and cached.get("optimization_complete")
                    and cached.get("trip_revision") == trip["revision"]
                    and cached.get("snapshot_revision") == (trip.get("snapshot") or {}).get("revision")
                    and (not include_dominated or "dominated_routes" in cached)):
                refresh_quote_freshness(cached, datetime.now(UTC))
                logger.debug("planner optimize.coalesced trip=%s reason=matching_completed_snapshot", trip_id)
                return cached
            spec = TripSpec.model_validate(trip["spec"])
            snapshot = copy.deepcopy(snapshot or trip.get("snapshot") or {"revision": 0, "movements": [], "offers": [], "coverage": {}})
            airport_connections = {
                (connection.from_airport, connection.to_airport): connection
                for connection in (AirportConnection.model_validate(item) for item in trip.get("airport_connections", []))
            }
            old_movements = snapshot["movements"]
            logger.debug("planner normalize.start trip=%s movements=%d", trip_id, len(old_movements))
            normalized = []
            for raw in old_movements:
                movement = Movement.model_validate(raw)
                if movement.from_id not in spec.places() or movement.to_id not in spec.places():
                    normalized.append(raw)
                    continue
                if movement.source == "Google Flights / fast-flights":
                    segments = [s.model_dump(mode="json") for s in movement.segments if s.mode == "flight"]
                    updated = flight_movement(spec.places()[movement.from_id], spec.places()[movement.to_id], segments, spec,
                                              snapshot.get("roads", {}), airport_connections)
                    if updated is None:
                        continue
                    updated.id = movement.id
                    updated.search_url = movement.search_url
                    for charge in updated.charges:
                        if charge.kind == "Airport access":
                            charge.id = movement.id+":access"
                        elif charge.kind == "Airport egress":
                            charge.id = movement.id+":egress"
                    movement = updated
                elif movement.source == "Transitous / MOTIS" and movement.segments:
                    movement = movement.model_copy(update={"departure": movement.segments[0].departure-timedelta(minutes=spec.timing.transit_before_minutes),
                                                           "arrival": movement.segments[-1].arrival+timedelta(minutes=spec.timing.transit_after_minutes)})
                    movement.duration_minutes = (movement.arrival-movement.departure).total_seconds()/60
                normalized.append(movement.model_dump(mode="json"))
            if normalized != old_movements:
                snapshot["movements"] = normalized
                snapshot["revision"] += 1
            if snapshot.get("roads"):
                old_revision = snapshot["revision"]
                old_ids = {m["id"] for m in snapshot["movements"]}
                self.ingest({"kind": "road"}, {"roads": snapshot["roads"]}, spec, snapshot)
                if old_ids == {m["id"] for m in snapshot["movements"]}:
                    snapshot["revision"] = old_revision
            base_limit = max(1000, int(os.environ.get("PLANNER_LABEL_BATCH", "25000")))
            snapshot["label_limit"] = snapshot.get("label_limit", base_limit)+(base_limit if expand else 0)
            offers = [FareOffer.model_validate(o) for o in [*snapshot.get("offers", []), *trip.get("offers", [])]]
            # Last write of an offer ID wins (manual replacement of a provider offer).
            offers = list({o.id: o for o in offers}.values())
            now = datetime.now(UTC)
            offers = [o.model_copy(update={"estimated": True, "label": "Stale quote: "+o.label}) if o.source == "provider" and o.expires_at and o.expires_at.astimezone(UTC) < now else o for o in offers]
            def check_cancelled():
                return job_id in self.cancelled_jobs

            cancelled = check_cancelled if job_id else None
            logger.debug("planner optimize.dispatch trip=%s elapsed=%.2fs movements=%d offers=%d label_limit=%d", trip_id, clock.monotonic()-started, len(snapshot["movements"]), len(offers), snapshot["label_limit"])
            result = await asyncio.to_thread(optimize, spec, airport_transfer_variants(snapshot["movements"], trip, spec, snapshot.get("roads", {}), airport_connections), offers,
                                             [*self.rules(), *airport_transfer_rules(trip, spec)], snapshot["revision"], trip["revision"], cancelled, snapshot["label_limit"], include_dominated=include_dominated)
            logger.debug("planner optimize.return trip=%s elapsed=%.2fs expanded=%d completed=%d routes=%d bundles=%d", trip_id, clock.monotonic()-started, result["expanded_labels"], result["feasible_count"], len(result["routes"]), len(result.get("bundle_candidates", [])))
            result["coverage"] = snapshot.get("coverage", {})
            result["coverage"]["unresolved_movements"] = [{"id": m["id"], "from_id": m["from_id"], "to_id": m["to_id"], "assumptions": m["assumptions"]} for m in snapshot["movements"] if not m.get("usable", True)]
            result["coverage"]["airport_connections_required"] = required_airport_connections(snapshot["movements"])
            result["discovery_required"] = snapshot.get("discovery_key") != spec.discovery_key()
            latest = self.store.get("trips", trip_id)
            if latest["revision"] == trip["revision"] and (not latest.get("snapshot") or latest["snapshot"]["revision"] <= snapshot["revision"]):
                latest["result"] = {k: v for k, v in result.items() if k != "bundle_candidates"}
                if latest.get("snapshot"):
                    latest["snapshot"] = snapshot
                self.store.put("trips", trip_id, latest)
            logger.debug("planner recalculate.done trip=%s elapsed=%.2fs", trip_id, clock.monotonic()-started)
            return result

    def start(self, trip_id, budget=100, job_id=None):
        trip = self.store.get("trips", trip_id)
        if trip is None:
            raise KeyError(trip_id)
        spec = TripSpec.model_validate(trip["spec"])
        if any(j["trip_id"] == trip_id and j["status"] in {"queued", "running"} for j in self.store.list("jobs")):
            raise ValueError("This trip already has an active discovery job.")
        if any(not task.done() and (self.store.get("jobs", id) or {}).get("trip_id") == trip_id for id, task in self.running.items()):
            raise ValueError("An in-flight request is finishing. Continue after it stops.")
        if job_id:
            job = self.store.get("jobs", job_id)
            if job is None or job["trip_id"] != trip_id or job["discovery_key"] != spec.discovery_key():
                raise ValueError("Start a new search after changing discovery inputs.")
            job["snapshot"]["label_limit"] = job["snapshot"].get("label_limit", 25000)+max(1000, int(os.environ.get("PLANNER_LABEL_BATCH", "25000")))
            if job["cursor"] == len(job["queue"]):
                latest = {t["key"]: t for t in job["queue"][:job["cursor"]]}
                retries = [{k: v for k, v in t.items() if k != "outcome"} for t in latest.values() if t.get("outcome") == "failed"]
                job["queue"].extend(retries)
            if transitous.contact_url and not job.get("transit_configured"):
                known = {t["key"] for t in job["queue"]}
                job["queue"].extend(t for t in tasks_for(spec) if t["kind"] == "transit" and t["key"] not in known)
        else:
            snapshot = self.store.get("graphs", spec.discovery_key()) or trip.get("snapshot") or {"revision": 0, "movements": [], "offers": [], "roads": {}, "coverage": {}}
            snapshot["discovery_key"] = spec.discovery_key()
            job = {"id": uuid.uuid4().hex, "trip_id": trip_id, "discovery_key": spec.discovery_key(), "status": "queued", "queue": tasks_for(spec),
                   "cursor": 0, "snapshot": snapshot, "requests": 0, "cache_hits": 0, "outcomes": {}, "messages": [], "bundle_links": [], "created": clock.time()}
        self.separate_manual_quotes(job, spec)
        job.update(status="queued", batch_budget=budget, batch_requests=0)
        job["transit_configured"] = bool(transitous.contact_url)
        if any(m in TRANSIT_MODES for m in spec.modes) and not transitous.contact_url:
            message = "Transitous is disabled until its contact URL is configured and routing use coordinated. No transit requests were sent."
            if message not in job["messages"]:
                job["messages"].append(message)
        self.cancelled_jobs.discard(job["id"])
        self.live_jobs[job["id"]] = job
        self.store.put("jobs", job["id"], job)
        trip["latest_job_id"] = job["id"]
        self.store.put("trips", trip_id, trip)
        self.running[job["id"]] = asyncio.create_task(self.run(job, spec))
        return self.public(job)

    def public(self, job):
        latest = {t["key"]: t for t in job["queue"][:job["cursor"]]}
        return {k: v for k, v in job.items() if k not in {"queue", "snapshot"}} | {"processed": job["cursor"], "pending": len(job["queue"])-job["cursor"], "failed_queries": sum(t.get("outcome") == "failed" for t in latest.values()), "graph_revision": job["snapshot"]["revision"]}

    def cancel(self, job_id):
        self.cancelled_jobs.add(job_id)
        job = self.live_jobs.get(job_id) or self.store.get("jobs", job_id)
        job["status"] = "cancelled"
        return self.store.put("jobs", job_id, job)

    async def fetch(self, task, spec, snapshot):
        if task.get("ticket_kind") == "multi-city":
            return fetch_flights(task["legs"], spec.adults, "multi-city", spec.departure_start, spec.departure_end), False
        places = spec.places()
        if task["kind"] == "road":
            points = {**places, **airport_places(spec)}
            ordered = sorted(points)
            coords = ";".join(f"{points[id].longitude},{points[id].latitude}" for id in ordered)
            key = "road:"+stable_id(coords)
        else:
            key = stable_id({k: v for k, v in task.items() if k not in {"key", "outcome"}}, spec.adults, spec.departure_start, spec.departure_end,
                            [(p.id, p.latitude, p.longitude, p.flight_code, p.airport_codes) for p in places.values()], sorted(spec.modes),
                            spec.timing.connection_minutes if task["kind"] == "transit" else None,
                            search_modes(spec, task.get("from_id"), task.get("to_id")))
        if task["kind"] in {"flight", "bundle"}:
            # Older cached results omitted Google's first flight result group.
            key = ("round-trip-selection-v3:" if task.get("ticket_kind") == "round-trip" else "flight-groups-v2:") + key
        lock = self.query_locks.setdefault(key, asyncio.Lock())
        async with lock:
            cached = self.store.cached(key)
            if cached is not None:
                return cached, False
            if task["kind"] == "road":
                base = os.environ.get("OSRM_BASE_URL", "https://router.project-osrm.org").rstrip("/")
                async with self.http_limit, httpx.AsyncClient(timeout=30) as http:
                    response = await http.get(f"{base}/table/v1/driving/{coords}", params={"annotations": "distance,duration"})
                    response.raise_for_status()
                    payload = response.json()
                if payload.get("code") != "Ok":
                    raise ValueError("OSRM did not return a road matrix.")
                routes = {}
                for i, a in enumerate(ordered):
                    for j, b in enumerate(ordered):
                        distance, duration = payload["distances"][i][j], payload["durations"][i][j]
                        if a != b and distance is not None and duration is not None:
                            routes[a+"->"+b] = {"distance_km": distance/1000, "duration_minutes": duration/60}
                result = {"status": "success", "roads": routes}
            elif task["kind"] in {"flight", "bundle"}:
                legs = task["legs"] if task["kind"] == "bundle" else [make_leg(places[task["from_id"]], places[task["to_id"]], task["date"])]
                result = await asyncio.wait_for(asyncio.to_thread(fetch_flights, legs, spec.adults, task.get("ticket_kind", "one-way"), spec.departure_start, spec.departure_end), 40)
            else:
                if not transitous.contact_url:
                    return {"status": "unsupported", "message": "Transitous is disabled until its contact URL is configured and routing use coordinated."}, False
                origin, dest = places[task["from_id"]], places[task["to_id"]]
                zone = ZoneInfo(origin.timezone)
                start = datetime.combine(date.fromisoformat(task["date"]), spec.departure_start, zone)
                params = {"fromPlace": f"{origin.latitude},{origin.longitude}", "toPlace": f"{dest.latitude},{dest.longitude}",
                          "time": start.isoformat(timespec="seconds"), "arriveBy": "false", "transitModes": ",".join(TRANSIT_MODES[m] for m in search_modes(spec, task["from_id"], task["to_id"]) if m in TRANSIT_MODES),
                          "searchWindow": str(int((datetime.combine(start.date(), spec.departure_end)-datetime.combine(start.date(), spec.departure_start)).total_seconds())),
                          "timetableView": "true", "numItineraries": "10", "joinInterlinedLegs": "false"}
                params["minTransferTime"] = str(spec.timing.connection_minutes)
                if task.get("cursor"):
                    params["pageCursor"] = task["cursor"]
                async with transitous._route_semaphore:
                    requested = []
                    payload = await transitous._get_json("/v6/plan", params, ttl_seconds=transitous.route_ttl,
                                                        empty_ttl_seconds=transitous.empty_route_ttl, is_empty=lambda x: not x.get("itineraries"), on_request=lambda: requested.append(True))
                result = {"status": "success" if payload.get("itineraries") else "empty", "payload": payload}
            ttl = 7*86400 if task["kind"] == "road" else 900 if task["kind"] in {"flight", "bundle"} else transitous.route_ttl
            if task["kind"] == "transit" and result["status"] == "empty":
                ttl = transitous.empty_route_ttl
            if result["status"] not in {"failed"}:
                result["retrieved_at"] = datetime.now(UTC).isoformat()
                self.store.cache(key, result, ttl)
            return result, bool(requested) if task["kind"] == "transit" else True

    def ingest(self, task, outcome, spec, snapshot):
        movements = {m["id"]: m for m in snapshot["movements"]}
        offers = {o["id"]: o for o in snapshot["offers"]}
        places = spec.places()
        new_movements, new_offers = [], []
        if task["kind"] == "road" and "roads" in outcome:
            snapshot["roads"] = outcome["roads"]
            for a, b in itertools.permutations(places, 2):
                road = outcome["roads"].get(a+"->"+b)
                if not road or road["duration_minutes"] <= 0:
                    continue
                variants = []
                if "taxi" in spec.modes:
                    variants.append(("taxi", None))
                if "car" in spec.modes:
                    variants.extend([("car", "own"), ("car", "rental")])
                for mode, vehicle in variants:
                    new_movements.append(Movement(id="road:"+stable_id(a, b, mode, vehicle), from_id=a, to_id=b, mode=mode, vehicle_kind=vehicle,
                                                  duration_minutes=road["duration_minutes"], distance_km=road["distance_km"], source="OSRM",
                                                  assumptions=["Driving time estimate; traffic and rental availability are not live inventory."]))
        elif task["kind"] in {"flight", "bundle"}:
            legs = task["legs"] if task["kind"] == "bundle" else [make_leg(places[task["from_id"]], places[task["to_id"]], task["date"])]
            for option in outcome.get("options", []):
                covered = []
                for leg, segments in zip(legs, option["journeys"]):
                    m = flight_movement(places[leg["from_id"]], places[leg["to_id"]], segments, spec, snapshot.get("roads", {}))
                    if m is None:
                        covered = []
                        break
                    m.search_url = outcome.get("search_url")
                    new_movements.append(m)
                    covered.append(m.id)
                if len(covered) != len(legs):
                    continue
                value = option["price"]
                if value is not None:
                    new_offers.append(FareOffer(id="provider:"+stable_id(covered, task.get("ticket_kind", "one-way")), movement_ids=covered,
                                               kind=task.get("ticket_kind", "one-way"), low=value, high=value,
                                               label="Google Flights party fare", search_url=outcome.get("search_url")))
        elif task["kind"] == "transit" and outcome.get("payload"):
            pair_spec = spec.model_copy(update={"modes": search_modes(spec, task["from_id"], task["to_id"])})
            new_movements, new_offers = transit_movements(outcome["payload"], places[task["from_id"]], places[task["to_id"]], pair_spec, task["date"])
        for m in new_movements:
            movements[m.id] = m.model_dump(mode="json")
        for o in new_offers:
            o.adults = spec.adults
            o.retrieved_at = timestamp(outcome.get("retrieved_at", datetime.now(UTC).isoformat()))
            o.expires_at = o.retrieved_at+timedelta(seconds=900 if task["kind"] in {"flight", "bundle"} else transitous.route_ttl)
            offers[o.id] = o.model_dump(mode="json")
        snapshot.update(movements=list(movements.values()), offers=list(offers.values()), revision=snapshot["revision"]+1)

    async def publish(self, job, spec):
        started = clock.monotonic()
        self.separate_manual_quotes(job, spec)
        logger.debug("planner publish.start job=%s cursor=%d queue=%d", job["id"], job["cursor"], len(job["queue"]))
        snapshot = job["snapshot"]
        trip = self.store.get("trips", job["trip_id"])
        if trip is None:
            job["status"] = "cancelled"
            return
        manual = [m for m in (trip.get("snapshot") or {}).get("movements", []) if m["source"] == "User-defined connection"]
        merged = {m["id"]: m for m in snapshot["movements"]}
        merged.update({m["id"]: m for m in manual})
        if len(merged) != len(snapshot["movements"]):
            snapshot["revision"] += 1
        snapshot["movements"] = list(merged.values())
        latest_outcomes = [t.get("outcome") for t in {t["key"]: t for t in job["queue"][:job["cursor"]]}.values()]
        source_gaps = ["Transitous disabled"] if any(m in TRANSIT_MODES for m in spec.modes) and not transitous.contact_url else []
        discovery_complete = (not source_gaps and job["cursor"] == len(job["queue"])
                              and not any(s in {"failed", "unsupported", "requires_manual_quote"} for s in latest_outcomes)
                              and not any(link["status"] == "requires_manual_quote" for link in job["bundle_links"]))
        snapshot["coverage"] = {"processed": job["cursor"], "pending": len(job["queue"])-job["cursor"], "requests": job["requests"],
                                "cache_hits": job["cache_hits"], "outcomes": job["outcomes"], "discovery_complete": discovery_complete,
                                "messages": job["messages"][-12:], "bundle_links": job["bundle_links"],
                                "manual_quote_queries": job.get("manual_quote_queries", 0)}
        snapshot["coverage"]["source_gaps"] = source_gaps
        snapshot["coverage"]["unresolved_movements"] = [{"id": m["id"], "from_id": m["from_id"], "to_id": m["to_id"], "assumptions": m["assumptions"]} for m in snapshot["movements"] if not m.get("usable", True)]
        logger.debug("planner graph.persist job=%s elapsed=%.2fs movements=%d", job["id"], clock.monotonic()-started, len(snapshot["movements"]))
        self.store.put("graphs", job["discovery_key"], shareable_snapshot(snapshot, spec))
        if TripSpec.model_validate(trip["spec"]).discovery_key() != job["discovery_key"]:
            job["status"] = "superseded"
            return
        trip["snapshot"] = snapshot
        self.store.put("trips", trip["id"], trip)
        if job["id"] in self.cancelled_jobs:
            return
        # Empty/unsupported provider responses still update coverage, but do not
        # change the optimization problem. Avoid solving the same graph again.
        pricing_rules = self.store.list("rules")
        now = datetime.now(UTC)
        inputs = stable_id(trip["revision"], trip["spec"], trip.get("offers", []),
                           trip.get("airport_connections", []), pricing_rules,
                           snapshot["movements"], snapshot.get("offers", []),
                           snapshot.get("roads", {}), snapshot.get("label_limit"))
        cadence = self.optimization_cadence.get(job["id"])
        controls = (trip["revision"], pricing_rules, snapshot.get("label_limit"))
        if (job.get("status") == "running" and cadence and cadence["seconds"] >= 5
                and cadence["controls"] == controls and trip.get("result")
                and self.published_inputs.get(job["id"]) != inputs
                and job["cursor"]-cadence["cursor"] < 16):
            # Keep coverage/current graph available every four queries. Larger
            # solves wait for a batch; final/paused publishes always solve, and
            # manual edits or a changed allowance bypass this batching.
            logger.debug("planner optimize.deferred job=%s cursor=%d next_cursor=%d reason=batch_changed_graph", job["id"], job["cursor"], cadence["cursor"]+16)
            return
        if self.published_inputs.get(job["id"]) == inputs and trip.get("result"):
            logger.debug("planner optimize.reuse job=%s reason=unchanged_inputs", job["id"])
            result = copy.deepcopy(trip["result"])
            refresh_quote_freshness(result, now)
            result.update(snapshot_revision=snapshot["revision"], coverage=snapshot.get("coverage", {}))
            trip["result"] = result
            self.store.put("trips", trip["id"], trip)
        else:
            solve_started = clock.monotonic()
            result = await self.recalculate(trip["id"], snapshot, job_id=job["id"])
            self.optimization_cadence[job["id"]] = {"cursor": job["cursor"], "seconds": clock.monotonic()-solve_started,
                                                     "controls": controls}
        known = {t["key"] for t in job["queue"]} | {stable_id(link["kind"], link["legs"]) for link in job["bundle_links"]}
        # Include dominated complete histories too: an undiscovered bundle can
        # make them cheaper than the current one-way frontier.
        logger.debug("planner bundles.enqueue.start job=%s candidates=%d elapsed=%.2fs", job["id"], len(result.get("bundle_candidates", [])), clock.monotonic()-started)
        bundle_started = clock.monotonic()
        places = spec.places()
        leg_cache = {}
        seen_tickets = set()
        added = 0
        manual_added = 0
        for candidate_index, flights in enumerate(result.pop("bundle_candidates", [])):
            if candidate_index % 32 == 0:
                await asyncio.sleep(0)
            candidates = [("multi-city", flights)]
            for i, first in enumerate(flights):
                for last in flights[i+1:]:
                    if first["from_id"] == last["to_id"] and first["to_id"] == last["from_id"]:
                        candidates.append(("round-trip", [first, last]))
            for kind, selected in candidates:
                if any("flight" not in search_modes(spec, m["from_id"], m["to_id"]) for m in selected):
                    continue
                signature = []
                for m in selected:
                    origin = places[m["from_id"]]
                    actual = next(s for s in m["segments"] if s["mode"] == "flight")
                    day = timestamp(actual["departure"]).astimezone(ZoneInfo(origin.timezone)).date().isoformat()
                    signature.append((m["from_id"], m["to_id"], day))
                ticket = (kind, tuple(signature))
                if ticket in seen_tickets:
                    continue
                seen_tickets.add(ticket)
                legs = []
                for a, b, day in signature:
                    if (a, b, day) not in leg_cache:
                        leg_cache[a, b, day] = make_leg(places[a], places[b], day)
                    legs.append(leg_cache[a, b, day])
                key = stable_id(kind, legs)
                if key not in known:
                    known.add(key)
                    if kind == "multi-city":
                        manual_added += int(self.register_manual_quote(job, legs, spec))
                        continue
                    # Put a discovered ticket opportunity next, keeping progress
                    # deterministic and the provider request budget authoritative.
                    job["queue"].insert(job["cursor"], {"kind": "bundle", "ticket_kind": kind, "key": key, "legs": legs})
                    added += 1
        logger.debug("planner bundles.enqueue.done job=%s unique_tickets=%d unique_legs=%d added=%d manual_added=%d elapsed=%.3fs", job["id"], len(seen_tickets), len(leg_cache), added, manual_added, clock.monotonic()-bundle_started)
        snapshot["coverage"]["pending"] = len(job["queue"])-job["cursor"]
        snapshot["coverage"]["manual_quote_queries"] = job.get("manual_quote_queries", 0)
        snapshot["coverage"]["discovery_complete"] = (discovery_complete and job["cursor"] == len(job["queue"])
                                                        and not any(link["status"] == "requires_manual_quote" for link in job["bundle_links"]))
        logger.debug("planner graph.persist job=%s elapsed=%.2fs movements=%d", job["id"], clock.monotonic()-started, len(snapshot["movements"]))
        self.store.put("graphs", job["discovery_key"], shareable_snapshot(snapshot, spec))
        latest = self.store.get("trips", trip["id"])
        if TripSpec.model_validate(latest["spec"]).discovery_key() == job["discovery_key"]:
            trip_snapshot = latest.get("snapshot") or copy.deepcopy(snapshot)
            for key in ("processed", "pending", "requests", "cache_hits", "manual_quote_queries", "outcomes", "discovery_complete", "messages", "bundle_links", "source_gaps"):
                if key in snapshot.get("coverage", {}):
                    trip_snapshot.setdefault("coverage", {})[key] = snapshot["coverage"][key]
            latest["snapshot"] = trip_snapshot
            if latest.get("result"):
                latest["result"]["coverage"] = trip_snapshot.get("coverage", {})
            self.store.put("trips", trip["id"], latest)

        self.published_inputs[job["id"]] = inputs
        logger.debug("planner publish.done job=%s queue=%d elapsed=%.2fs", job["id"], len(job["queue"]), clock.monotonic()-started)

    async def run(self, job, spec):
        if job["id"] in self.cancelled_jobs:
            self.running.pop(job["id"], None)
            self.live_jobs.pop(job["id"], None)
            return
        self.separate_manual_quotes(job, spec)
        job["status"] = "running"
        self.store.put("jobs", job["id"], job)
        try:
            while job["cursor"] < len(job["queue"]) and job["batch_requests"] < job["batch_budget"]:
                if job["id"] in self.cancelled_jobs:
                    job["status"] = "cancelled"
                    break
                current = self.store.get("trips", job["trip_id"])
                if TripSpec.model_validate(current["spec"]).discovery_key() != job["discovery_key"]:
                    job["status"] = "superseded"
                    break
                task = job["queue"][job["cursor"]]
                task_started = clock.monotonic()
                logger.debug("planner query.start job=%s cursor=%d/%d kind=%s key=%s", job["id"], job["cursor"], len(job["queue"]), task["kind"], task["key"])
                try:
                    outcome, used_request = await self.fetch(task, spec, job["snapshot"])
                except Exception as exc:
                    outcome, used_request = {"status": "failed", "message": f"{type(exc).__name__}: {str(exc)[:180]}"}, True
                logger.debug("planner query.done job=%s kind=%s status=%s elapsed=%.2fs request=%s manual_only=%s", job["id"], task["kind"], outcome["status"], clock.monotonic()-task_started, used_request, outcome.get("automatic_query_skipped", False))
                job["cursor"] += 1
                job["batch_requests"] += int(used_request)
                job["requests"] += int(used_request)
                skipped = outcome.get("automatic_query_skipped", False)
                job["manual_quote_queries"] = job.get("manual_quote_queries", 0)+int(skipped)
                job["cache_hits"] += int(not used_request and not skipped and outcome["status"] != "unsupported")
                status = outcome["status"]
                task["outcome"] = status
                job["outcomes"][status] = job["outcomes"].get(status, 0)+1
                if outcome.get("message"):
                    message = f"{task['kind']}: {outcome['message']}"
                    if message not in job["messages"]:
                        job["messages"].append(message)
                if task["kind"] == "bundle" and outcome.get("search_url"):
                    link = {"kind": task["ticket_kind"], "status": status, "url": outcome["search_url"], "legs": task["legs"]}
                    if link not in job["bundle_links"]:
                        job["bundle_links"].append(link)
                self.ingest(task, outcome, spec, job["snapshot"])
                if task["kind"] == "transit":
                    cursor = outcome.get("payload", {}).get("nextPageCursor")
                    itineraries = outcome.get("payload", {}).get("itineraries", [])
                    origin = spec.places().get(task.get("from_id"))
                    latest = max((timestamp(i["startTime"]) for i in itineraries if i.get("startTime")), default=None)
                    limit = datetime.combine(date.fromisoformat(task["date"]), spec.departure_end, ZoneInfo(origin.timezone)) if origin else None
                    if cursor and latest and limit and latest <= limit:
                        more = {**task, "cursor": cursor, "key": stable_id(task["from_id"], task["to_id"], task["date"], cursor)}
                        if more["key"] not in {t["key"] for t in job["queue"]}:
                            job["queue"].insert(job["cursor"], more)
                if job["id"] in self.cancelled_jobs:
                    job["status"] = "cancelled"
                self.store.put("jobs", job["id"], job)
                if job["cursor"] % 4 == 0 or task["kind"] == "road":
                    await self.publish(job, spec)
                    self.store.put("jobs", job["id"], job)
                if job["status"] in {"cancelled", "superseded"}:
                    break
                await asyncio.sleep(0)
            if job["status"] == "running":
                job["status"] = "complete" if job["cursor"] == len(job["queue"]) else "paused"
            await self.publish(job, spec)
            if job["status"] == "complete" and job["cursor"] < len(job["queue"]):
                job["status"] = "paused"
            self.store.put("jobs", job["id"], job)
        except asyncio.CancelledError:
            job["status"] = "interrupted"
            self.store.put("jobs", job["id"], job)
            raise
        except Exception as exc:
            logger.exception("planner job.failed job=%s cursor=%d", job["id"], job["cursor"])
            job["status"] = "failed"
            job["messages"].append(f"Planner: {type(exc).__name__}: {str(exc)[:180]}")
            self.store.put("jobs", job["id"], job)
        finally:
            self.running.pop(job["id"], None)
            self.live_jobs.pop(job["id"], None)
            self.published_inputs.pop(job["id"], None)
            self.optimization_cadence.pop(job["id"], None)

    async def close(self):
        pending = list(self.running.values())
        self.cancelled_jobs.update(self.running)
        for task in pending:
            task.cancel()
        await asyncio.gather(*pending, return_exceptions=True)


manager = DiscoveryManager(store)
