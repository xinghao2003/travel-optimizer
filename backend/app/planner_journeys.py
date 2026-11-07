"""Pure provider-result normalization shared by the server and browser worker."""
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo
from .planner_models import Charge, FareOffer, Movement, Segment, stable_id

UTC = timezone.utc
MODE_MAP = {"BUS": "bus", "COACH": "coach", "SUBWAY": "subway", "TRAM": "tram"}
RAIL_MODES = {"RAIL", "HIGHSPEED_RAIL", "LONG_DISTANCE", "NIGHT_RAIL", "REGIONAL_FAST_RAIL", "REGIONAL_RAIL", "SUBURBAN"}


def timestamp(value):
    if isinstance(value, (int, float)):
        return datetime.fromtimestamp(value, UTC)
    return datetime.fromisoformat(str(value).replace("Z", "+00:00")).astimezone(UTC)


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
                                        from_timezone=leg.get("from", {}).get("tz") or origin.timezone,
                                        to_timezone=leg.get("to", {}).get("tz") or dest.timezone,
                                        assumed=bool(leg.get("loopedCalendarSince")),
                                        interline_with_previous=bool(leg.get("interlineWithPreviousLeg"))))
            id = "transit:"+stable_id(origin.id, dest.id, [s.model_dump(mode="json") for s in segments])
            dep -= timedelta(minutes=spec.timing.transit_before_minutes)
            arr += timedelta(minutes=spec.timing.transit_after_minutes)
            mode = "rail" if "rail" in modes else modes[0]
            movement = Movement(id=id, from_id=origin.id, to_id=dest.id, mode=mode, departure=dep, arrival=arr,
                                duration_minutes=(arr-dep).total_seconds()/60, transfers=sum(not l.get("interlineWithPreviousLeg") for l in riding[1:]), segments=segments, source="Transitous / MOTIS")
            looped = sorted({str(l["loopedCalendarSince"]) for l in riding if l.get("loopedCalendarSince")})
            if looped:
                movement.schedule_estimated = True
                movement.assumptions.append("Estimated timetable: provider repeated service beyond feed validity (since " + ", ".join(looped) + "). Verify the travel date; holidays and timetable changes may differ.")
            movements.append(movement)
            fare = None if looped else transit_fare(itinerary, spec.adults)
            if fare:
                offers.append(FareOffer(id="provider:"+id, movement_ids=[id], low=fare[0], high=fare[0], currency=fare[1], label="GTFS fare products for party"))
        except (KeyError, TypeError, ValueError):
            continue
    return movements, offers
