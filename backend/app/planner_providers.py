"""Provider boundaries: validate complete schedules before assigning prices."""
from __future__ import annotations

import threading
import copy
import time as clock
from dataclasses import replace
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

from .flight_search import _install_price_tolerant_parser

FLIGHT_LIMIT = threading.BoundedSemaphore(3)


def flight_query(legs, adults, kind, departure_start, departure_end):
    from fast_flights import FlightQuery, Passengers, create_query
    return create_query(flights=[FlightQuery(date=leg["date"], from_airport=leg["from_code"], to_airport=leg["to_code"],
                                            earliest_departure_hour=departure_start.hour, latest_departure_hour=departure_end.hour)
                                 for leg in legs], trip=kind, passengers=Passengers(adults=adults), currency="MYR", language="en-US")


def _varint(value):
    encoded = bytearray()
    while value > 127:
        encoded.append((value & 127) | 128)
        value >>= 7
    encoded.append(value)
    return bytes(encoded)


def _wire_string(field, value):
    encoded = str(value).encode("utf-8")
    return _varint(field * 8 + 2) + _varint(len(encoded)) + encoded


def selected_outbound_query(query, selection):
    """Extend the query with Google's selected-flight fields missing upstream.

    FlightData field 4 repeats selected segments: origin, date, destination,
    operating airline, flight number. Info field 2 selects the return stage.
    Keep these wire details here rather than modifying the installed package.
    """
    selected = copy.deepcopy(query)
    for origin, day, destination, airline, number in selection:
        segment = b"".join(_wire_string(field, value) for field, value in
                           ((1, origin), (2, day), (3, destination), (5, airline), (6, number)))
        selected.flight_data[0].MergeFromString(b"\x22" + _varint(len(segment)) + segment)
    info = selected.pb()
    info.MergeFromString(b"\x10\x02")
    selected.pb = lambda: info
    return selected


def complete_round_trip_rows(query, rows, get_flights):
    """Return conditional return fares paired with their selected outbound."""
    completed, seen, errors = [], set(), []
    requests = 0
    started = clock.monotonic()
    eligible = [row for row in rows if getattr(row, "outbound_selection", None)]
    for outbound in eligible:
        selection = outbound.outbound_selection
        if selection in seen:
            continue
        if clock.monotonic() - started > 25:
            errors.append("Return-choice retrieval time limit reached; some outbound choices remain unchecked.")
            break
        seen.add(selection)
        try:
            requests += 1
            with FLIGHT_LIMIT:
                returns = get_flights(selected_outbound_query(query, selection))
            for inbound in returns:
                # Return-page fares are conditional whole-ticket amounts. Never
                # reuse the first page's indicative price or sum unrelated fares.
                completed.append(replace(inbound, flights=[*outbound.flights, *inbound.flights],
                                         airlines=list(dict.fromkeys([*outbound.airlines, *inbound.airlines]))))
        except Exception as exc:
            errors.append(f"Return choices: {type(exc).__name__}: {str(exc)[:120]}")
    return completed, {"return_requests": requests, "outbound_choices_checked": len(seen),
                       "return_errors": errors}


def fetch_flights(legs: list[dict], adults, kind, departure_start, departure_end):
    from fast_flights import get_flights
    import airportsdata
    query = flight_query(legs, adults, kind, departure_start, departure_end)
    result = {"status": "empty", "options": [], "search_url": query.url(), "kind": kind}
    if kind == "multi-city":
        result.update(status="requires_manual_quote", automatic_query_skipped=True,
                      diagnostics={"returned_rows": 0, "requested_journeys": len(legs), "complete_options": 0},
                      message="Automatic multi-city search skipped: fast-flights does not support reliable multi-city retrieval. This does not establish that no combined ticket exists. Open the search link and enter a whole-ticket quote manually.")
        return result
    airports = airportsdata.load("IATA")
    try:
        _install_price_tolerant_parser()
        with FLIGHT_LIMIT:
            rows = get_flights(query)
        result["diagnostics"] = {"returned_rows": len(rows), "requested_journeys": len(legs), "complete_options": 0}
        if kind == "round-trip" and len(legs) == 2 and any(getattr(row, "outbound_selection", None) for row in rows):
            rows, details = complete_round_trip_rows(query, rows, get_flights)
            result["diagnostics"].update(details)
            result["diagnostics"]["conditional_return_rows"] = len(rows)
        for row in rows:
            segments = []
            for segment in row.flights:
                origin, dest = airports.get(segment.from_airport.code), airports.get(segment.to_airport.code)
                if not origin or not dest:
                    segments = []
                    break
                dep = datetime(*segment.departure.date, *segment.departure.time, tzinfo=ZoneInfo(origin["tz"])).astimezone(timezone.utc)
                arr = datetime(*segment.arrival.date, *segment.arrival.time, tzinfo=ZoneInfo(dest["tz"])).astimezone(timezone.utc)
                if arr <= dep or (segments and dep < datetime.fromisoformat(segments[-1]["arrival"])):
                    segments = []
                    break
                segments.append({"mode": "flight", "from_id": segment.from_airport.code, "to_id": segment.to_airport.code,
                                 "from_name": segment.from_airport.name, "to_name": segment.to_airport.name,
                                 "departure": dep.isoformat(), "arrival": arr.isoformat(),
                                 "from_timezone": origin["tz"], "to_timezone": dest["tz"],
                                 "operator": ", ".join(row.airlines), "service": getattr(segment, "flight_number", None), "source": "Google Flights / fast-flights"})
            if not segments:
                continue
            groups = []
            cursor = 0
            for leg in legs:
                origin_codes = set(leg["from_airports"])
                dest_codes = set(leg["to_airports"])
                if cursor >= len(segments) or segments[cursor]["from_id"] not in origin_codes:
                    break
                first = cursor
                while cursor < len(segments):
                    cursor += 1
                    if segments[cursor-1]["to_id"] in dest_codes:
                        break
                group = segments[first:cursor]
                if not group or group[-1]["to_id"] not in dest_codes:
                    break
                local = datetime.fromisoformat(group[0]["departure"]).astimezone(ZoneInfo(leg["timezone"]))
                if local.date().isoformat() != leg["date"] or not departure_start <= local.time().replace(tzinfo=None) <= departure_end:
                    break
                groups.append(group)
            if len(groups) != len(legs) or cursor != len(segments):
                continue
            value = float(row.price) if row.price is not None and row.price >= 0 else None
            result["options"].append({"price": value, "journeys": groups})
        if result["options"]:
            result["status"] = "success"
            if result["diagnostics"].get("return_errors"):
                result["message"] = "Some return choices could not be checked: " + "; ".join(result["diagnostics"]["return_errors"])
        elif kind != "one-way":
            detail = ("No flight rows were returned." if not result["diagnostics"]["returned_rows"] else
                      "Returned rows did not contain all requested journeys with matching dates and times.")
            limitation = " The current fast-flights integration does not support reliable multi-city retrieval." if kind == "multi-city" else ""
            result.update(status="requires_manual_quote", message=detail+limitation+" This does not establish that no combined ticket exists; verify a whole-ticket quote manually.")
        result["diagnostics"]["complete_options"] = len(result["options"])
    except Exception as exc:
        result.update(status="empty" if type(exc).__name__ == "FlightsNotFound" else "requires_manual_quote" if kind != "one-way" else "failed", message=f"{type(exc).__name__}: {str(exc)[:180]}")
    return result
