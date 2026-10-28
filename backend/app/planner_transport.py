"""Trip-local user knowledge, kept separate from shared provider graphs."""
from __future__ import annotations

import itertools
import math
from datetime import timedelta

from .planner_models import AirportConnection, FareOffer, Movement, Segment, TransportOption, stable_id

SOURCE = "User-supplied transport"


def transport_options(trip, spec):
    """Expose existing saved inputs without a database migration or data loss."""
    snapshot = trip.get("snapshot") or {}
    roads = snapshot.get("roads", {})
    options = {}
    for service in spec.positioning_services:
        origin, dest = (spec.home.id, service.gateway_id) if service.direction == "outbound" else (service.gateway_id, spec.home.id)
        option = TransportOption(id="positioning:"+service.id, from_id=origin, to_id=dest, adults=spec.adults,
            positioning_direction=service.direction, mode=service.mode, availability="available",
            duration_minutes=(service.arrival-service.departure).total_seconds()/60, departure=service.departure,
            low=service.fare_amount, high=service.fare_amount, currency=service.currency, label=service.label)
        options[option.id] = option
    for entry in trip.get("airport_transfer_estimates", []):
        duration = entry.get("duration_minutes")
        if duration is None:
            duration = roads.get(entry["from_id"]+"->"+entry["to_id"], {}).get("duration_minutes", spec.timing.airport_transfer_fallback_minutes)
        option = TransportOption(id="legacy-access:"+stable_id(entry["from_id"], entry["to_id"], entry["adults"], entry.get("mode", "taxi")),
            **{k: v for k, v in entry.items() if k != "duration_minutes"}, duration_minutes=duration,
            fare_kind="range" if entry.get("high") is not None and entry.get("high") != entry.get("low") else "fixed",
            availability="available" if duration else "unknown")
        options[option.id] = option
    for entry in trip.get("airport_connections", []):
        option = TransportOption(id="legacy-airports:"+stable_id(entry["from_airport"], entry["to_airport"]),
            from_id="airport:"+entry["from_airport"], to_id="airport:"+entry["to_airport"], mode=entry["mode"], adults=spec.adults,
            availability="available", duration_minutes=entry["duration_minutes"], low=entry.get("fare_amount"),
            high=entry.get("fare_amount"), currency=entry.get("currency", "MYR"))
        options[option.id] = option
    offers = [*snapshot.get("offers", []), *trip.get("offers", [])]
    for movement in snapshot.get("movements", []):
        if movement.get("source") != "User-defined connection":
            continue
        offer = next((o for o in reversed(offers) if o["movement_ids"] == [movement["id"]]), {})
        option = TransportOption(id=movement["id"], from_id=movement["from_id"], to_id=movement["to_id"],
            vehicle_kind=movement.get("vehicle_kind"), distance_km=movement.get("distance_km"),
            adults=spec.adults, mode=movement["mode"], availability="available", duration_minutes=movement["duration_minutes"],
            departure=movement.get("departure"), low=offer.get("low"), high=offer.get("high"),
            fare_kind="range" if offer.get("low") != offer.get("high") else "fixed", currency=offer.get("currency", "MYR"))
        options[option.id] = option
    options.update((entry["id"], TransportOption.model_validate(entry)) for entry in trip.get("transport_options", []))
    return list(options.values())


def transport_rows(trip, spec):
    from .planner_discovery import airport_transfer_rows, required_airport_connections, rough_date_windows, iata_airports
    snapshot = trip.get("snapshot") or {}
    places = spec.places()
    airports = iata_airports()
    rows = {}

    def add(origin, destination, kind, count=0):
        def endpoint(id):
            if id in places:
                return places[id].name, places[id].timezone
            if not id.startswith("airport:"):
                return id, "UTC"
            code = id.removeprefix("airport:")
            airport = airports.get(code, {})
            return code+" airport", airport.get("tz", "UTC")
        a, az = endpoint(origin)
        b, bz = endpoint(destination)
        road = snapshot.get("roads", {}).get(origin+"->"+destination)
        duration = road["duration_minutes"] if road else spec.timing.airport_transfer_fallback_minutes if kind == "airport-city" else None
        rows[origin, destination] = dict(from_id=origin, to_id=destination, label=f"{a} → {b}", kind=kind,
            from_timezone=az, to_timezone=bz, journey_count=count, suggested_minutes=duration,
            timing_source="Road estimate" if road else "Trip fallback" if duration else None)

    for row in airport_transfer_rows(spec, snapshot.get("movements", [])):
        add(row["from_id"], row["to_id"], "airport-city")
    for pair in required_airport_connections(snapshot.get("movements", [])):
        add("airport:"+pair["from_airport"], "airport:"+pair["to_airport"], "airport-airport", pair["journey_count"])
    for a, b in rough_date_windows(spec):
        add(a, b, "city-city", sum(m["from_id"] == a and m["to_id"] == b for m in snapshot.get("movements", [])))
    for option in transport_options(trip, spec):
        pair = option.from_id, option.to_id
        if pair not in rows:
            add(*pair, "saved")
    return sorted(rows.values(), key=lambda row: (row["kind"], row["label"]))


def party_fare(option, spec):
    multiplier = spec.adults if option.unit == "person" else math.ceil(spec.adults/option.capacity) if option.unit == "vehicle" else 1
    high = option.high if option.fare_kind == "range" else option.low
    return (round(option.low*multiplier, 2) if option.low is not None else None,
            round(high*multiplier, 2) if high is not None else None)


def option_segments(option, start, origin, destination, origin_zone, destination_zone):
    segments = []
    cursor = start
    for mode, minutes, a, b, az, bz, label in (("wait", option.before_minutes, origin, origin, origin_zone, origin_zone, "Preparation"),
            (option.mode, option.duration_minutes, origin, destination, origin_zone, destination_zone, option.label),
            ("wait", option.after_minutes, destination, destination, destination_zone, destination_zone, "After arrival")):
        if not minutes:
            continue
        end = cursor+timedelta(minutes=minutes) if cursor else None
        segments.append(Segment(mode=mode, from_name=a, to_name=b, departure=cursor, arrival=end,
            duration_minutes=minutes, from_timezone=az, to_timezone=bz,
            source=label, assumed=True))
        cursor = end
    return segments


def city_options(trip, spec):
    movements, fares = [], []
    places = spec.places()
    for option in transport_options(trip, spec):
        if option.adults != spec.adults or option.availability != "available" or option.from_id not in places or option.to_id not in places:
            continue
        a, b = places[option.from_id], places[option.to_id]
        duration = option.before_minutes+option.duration_minutes+option.after_minutes
        start = option.departure-timedelta(minutes=option.before_minutes) if option.departure else None
        movement = Movement(id=option.id, from_id=a.id, to_id=b.id, mode=option.mode, departure=start,
            vehicle_kind=option.vehicle_kind, distance_km=option.distance_km,
            positioning_direction=option.positioning_direction,
            arrival=start+timedelta(minutes=duration) if start else None, duration_minutes=duration,
            source=SOURCE, segments=option_segments(option, start, a.name, b.name, a.timezone, b.timezone),
            assumptions=["User-confirmed service and timing" if start else "User assumes this service is available when needed"])
        low, high = party_fare(option, spec)
        movements.append(movement)
        fares.append(FareOffer(id="transport:"+option.id, movement_ids=[option.id], low=low, high=high,
            currency=option.currency, source="user", estimated=True, label=option.label))
    return movements, fares


def transport_movements(raw_movements, trip, spec, roads, connections):
    """Materialize confirmed options only; schedules and buffers are never shared."""
    from .planner_discovery import airport_transfer_variants, flight_movement
    if not trip.get("transport_options"):
        return airport_transfer_variants(raw_movements, trip, spec, roads, connections)
    options = transport_options(trip, spec)
    current = [o for o in options if o.adults == spec.adults]
    overrides = {o.id for o in current}
    by_pair = {}
    for option in current:
        by_pair.setdefault((option.from_id, option.to_id), []).append(option)
    result = []
    for raw in raw_movements:
        movement = Movement.model_validate(raw)
        if movement.source == "User-defined connection" and movement.id in overrides:
            continue
        flights = [s for s in movement.segments if s.mode == "flight"]
        if movement.source != "Google Flights / fast-flights" or not flights:
            result.append(movement)
            continue
        slots = [(movement.from_id, "airport:"+flights[0].from_id, "access")]
        slots += [("airport:"+a.to_id, "airport:"+b.from_id, f"change:{i}")
                  for i, (a, b) in enumerate(zip(flights, flights[1:]), 1) if a.to_id != b.from_id]
        slots += [("airport:"+flights[-1].to_id, movement.to_id, "egress")]
        choices = []
        for a, b, kind in slots:
            entries = by_pair.get((a, b), [])
            available = [o for o in entries if o.availability == "available"]
            if kind in {"access", "egress"} and not any(o.mode == "taxi" and o.availability != "unknown" for o in entries):
                available = [None, *available]
            elif not entries:
                available = [None]
            # Unknown or unavailable airport changes must not become a usable service.
            choices.append(available)
        for selected in itertools.product(*choices):
            local_roads, local_connections, replacements, prices = dict(roads), dict(connections), {}, {}
            valid = True
            for (a, b, kind), option in zip(slots, selected):
                if option is None:
                    continue
                if kind == "access":
                    latest = flights[0].departure-timedelta(minutes=spec.timing.flight_before_minutes)
                    total = option.before_minutes+option.duration_minutes+option.after_minutes
                    start = option.departure-timedelta(minutes=option.before_minutes) if option.departure else latest-timedelta(minutes=total)
                    end = start+timedelta(minutes=total)
                    if end > latest:
                        valid = False
                        break
                    minutes = (latest-start).total_seconds()/60
                    origin, dest = spec.places()[a].name, flights[0].from_name
                    az, bz = spec.places()[a].timezone, flights[0].from_timezone
                    segments = option_segments(option, start, origin, dest, az, bz)
                    if end < latest:
                        segments.append(Segment(mode="wait", from_name=dest, to_name=dest, departure=end, arrival=latest,
                            duration_minutes=(latest-end).total_seconds()/60, source="Wait before flight readiness", assumed=True))
                else:
                    if kind == "egress":
                        earliest = flights[-1].arrival+timedelta(minutes=spec.timing.flight_after_minutes)
                        origin, dest = flights[-1].to_name, spec.places()[b].name
                        az, bz = flights[-1].to_timezone, spec.places()[b].timezone
                        latest = None
                    else:
                        index = int(kind.split(":")[1])
                        earliest, latest = flights[index-1].arrival, flights[index].departure
                        origin, dest = flights[index-1].to_name, flights[index].from_name
                        az, bz = flights[index-1].to_timezone, flights[index].from_timezone
                    start = option.departure-timedelta(minutes=option.before_minutes) if option.departure else earliest
                    end = start+timedelta(minutes=option.before_minutes+option.duration_minutes+option.after_minutes)
                    if start < earliest or (latest and end > latest):
                        valid = False
                        break
                    minutes = (end-earliest).total_seconds()/60
                    segments = []
                    if start > earliest:
                        segments.append(Segment(mode="wait", from_name=origin, to_name=origin, departure=earliest, arrival=start,
                            duration_minutes=(start-earliest).total_seconds()/60, source="Wait for supplied service", assumed=True))
                    segments += option_segments(option, start, origin, dest, az, bz)
                if kind in {"access", "egress"}:
                    local_roads[a+"->"+b] = {"duration_minutes": minutes, "distance_km": None}
                else:
                    local_connections[a.removeprefix("airport:"), b.removeprefix("airport:")] = AirportConnection(
                        from_airport=a.removeprefix("airport:"), to_airport=b.removeprefix("airport:"),
                        mode=option.mode, duration_minutes=minutes)
                replacements[kind] = segments
                prices[kind] = option
            if not valid:
                continue
            variant = flight_movement(spec.places()[movement.from_id], spec.places()[movement.to_id],
                [s.model_dump(mode="json") for s in flights], spec, local_roads, local_connections)
            variant.id = movement.id if not any(selected) else movement.id+":supplied:"+stable_id([o.id if o else None for o in selected])
            variant.template_id = movement.id if any(selected) else movement.template_id
            variant.search_url = movement.search_url
            chronology = []
            for segment in variant.segments:
                kind = "access" if segment.source == "Airport access" else "egress" if segment.source == "Airport egress" else ""
                if segment.source == "User-verified airport transfer":
                    kind = next((k for a, b, k in slots if a == "airport:"+segment.from_id and b == "airport:"+segment.to_id), "")
                chronology.extend(replacements.get(kind, [segment]))
            variant.segments = chronology
            for charge in variant.charges:
                kind = "access" if charge.kind == "Airport access" else "egress" if charge.kind == "Airport egress" else next((k for a, b, k in slots if charge.from_id == a and charge.to_id == b), "")
                option = prices.get(kind)
                if option:
                    if option.id.startswith("legacy-access:"):
                        charge.id = movement.id+":"+kind+(":"+option.mode if option.mode != "taxi" else "")
                    elif option.id.startswith("legacy-airports:"):
                        charge.id = movement.id+":airport-transfer:"+kind.split(":")[1]
                    else:
                        charge.id = movement.id+":"+kind+":"+option.id
                    charge.mode, charge.source = option.mode, "user"
                    charge.low, charge.high = party_fare(option, spec)
                    charge.currency = option.currency
                elif kind in {"access", "egress"}:
                    charge.id = movement.id+":"+kind
            result.append(variant)
    supplied, _ = city_options(trip, spec)
    return [*result, *supplied]
