"""Stateless Google Flights search through fast-flights: one search, or one round-trip return step."""
from __future__ import annotations

import copy
import json
import threading
import time as clock
from contextlib import contextmanager
from dataclasses import asdict, replace
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

_PARSER_LOCK = threading.Lock()
_PARSER_INSTALLED = False


def _install_price_tolerant_parser() -> None:
    """Read both Google result groups and preserve schedules without fares."""
    global _PARSER_INSTALLED
    if _PARSER_INSTALLED:
        return
    with _PARSER_LOCK:
        if _PARSER_INSTALLED:
            return
        import fast_flights.fetcher as fetcher
        from fast_flights import parser as flight_parser
        from selectolax.lexbor import LexborHTMLParser

        upstream_parse = fetcher.parse

        def parse_with_missing_prices(html: str):
            document = LexborHTMLParser(html)
            script = document.css_first(r"script.ds\:1")
            if script is None:
                return upstream_parse(html)
            js = script.text()
            try:
                prefix, encoded_data = js.split("data:", 1)
                raw_payload, trailer = encoded_data.rsplit(",", 1)
                payload = json.loads(raw_payload)
                # Google supplies separate result groups. The installed parser
                # reads only section 3, so normalize both groups into that slot.
                rows = []
                for index in (2, 3):
                    section = payload[index] if len(payload) > index else None
                    if section and section[0]:
                        rows.extend(section[0])
            except (IndexError, KeyError, TypeError, ValueError):
                return upstream_parse(html)

            if not rows:
                # Empty responses can omit airline metadata too.
                # Upstream indexes that metadata before checking for results.
                parsed = flight_parser.ResultList()
                parsed.unpriced_rows = 0
                return parsed

            # Keep schedules without quotes. The upstream model needs a numeric
            # sentinel, which is restored to None before anything leaves here.
            missing = []
            for row in rows:
                try:
                    price = row[1][0][1]
                    absent = price is None or price < 0
                except (IndexError, KeyError, TypeError):
                    absent = True
                missing.append(absent)
                if absent:
                    row[1] = [[None, -1]]

            if not payload[3]:
                payload[3] = [rows]
            else:
                payload[3][0] = rows
            sanitized_js = prefix + "data:" + json.dumps(payload, separators=(",", ":")) + "," + trailer
            parsed = flight_parser.parse_js(sanitized_js)
            unique = []
            seen = set()
            for result, absent, raw_row in zip(parsed, missing, rows):
                try:
                    result.outbound_selection = tuple(
                        (f[3], "-".join(f"{n:02d}" if i else str(n) for i, n in enumerate(f[20])),
                         f[6], f[22][0], f[22][1]) for f in raw_row[0][2])
                except (IndexError, TypeError, ValueError):
                    result.outbound_selection = None
                if absent:
                    result.price = None
                # Ignore group/booking metadata when comparing identical
                # schedules, but retain different fares for the same flights.
                key = (json.dumps([asdict(f) for f in result.flights], sort_keys=True),
                       tuple(result.airlines), result.price)
                if key not in seen:
                    seen.add(key)
                    unique.append(result)
            parsed[:] = unique
            parsed.unpriced_rows = sum(r.price is None for r in parsed)
            return parsed

        parse_with_missing_prices._wayfinder_resilient = True
        fetcher.parse = parse_with_missing_prices
        _PARSER_INSTALLED = True


FLIGHT_LIMIT = threading.BoundedSemaphore(3)


@contextmanager
def flight_session(timeout=None, *, deadline=None):
    """Keep the initial query and its conditional returns on one HTTP client."""
    from fast_flights import Query, get_flights
    from fast_flights.fetcher import URL
    from fast_flights.integrations.base import FetchIntegration
    from primp import Client

    class Session(FetchIntegration):
        def fetch_html(self, query, /):
            params = query.params() if isinstance(query, Query) else {"q": query}
            options = {}
            if deadline is not None:
                remaining = deadline - clock.monotonic()
                if remaining <= 0:
                    raise TimeoutError("Flight function time limit reached.")
                options["timeout"] = min(timeout, remaining) if timeout is not None else remaining
            return client.get(URL, params=params, **options).text

    # Match the pinned fast-flights 3.1.0 transport settings.
    with Client(impersonate="chrome_145", impersonate_os="macos", referer=True, cookie_store=True, timeout=timeout) as client:
        session = Session()
        yield lambda query: get_flights(query, integration=session)


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


def normalize_flight_rows(rows, legs, departure_start, departure_end, airports):
    """Assign prices only to complete, validated requested journeys."""
    options = []
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
        options.append({"price": value, "journeys": groups})
    return options


def selection_signature(row):
    selected = getattr(row, "outbound_selection", None)
    return tuple(tuple(str(value) for value in segment) for segment in selected) if selected else None


def fetch_flight_step(legs, adults, kind, departure_start, departure_end, *, operation="search", selection=None, timeout=15, max_seconds=35):
    """Search once, or replay the initial page and check one selected return.

    A return step uses the same client for its two requests. Remaining choices
    are plain schedule identifiers owned by the browser, never a server session.
    """
    import airportsdata
    started = clock.monotonic()
    deadline = started + max_seconds
    query = flight_query(legs, adults, kind, departure_start, departure_end)
    result = {"protocol_version": 2, "kind": kind, "status": "empty", "options": [], "search_url": query.url(),
              "diagnostics": {"initial_requests": 0, "return_requests": 0, "requested_journeys": len(legs), "returned_rows": 0, "complete_options": 0}}
    acquired = False
    try:
        _install_price_tolerant_parser()
        airports = airportsdata.load("IATA")
        acquired = FLIGHT_LIMIT.acquire(timeout=max(0, deadline - clock.monotonic()))
        if not acquired:
            raise TimeoutError("Flight provider is busy. Retry this query.")
        with flight_session(timeout, deadline=deadline) as get_flights:
            result["diagnostics"]["initial_requests"] = 1
            rows = get_flights(query)
            result["diagnostics"]["returned_rows"] = len(rows)
            if operation == "return":
                target = tuple(tuple(segment) for segment in selection)
                outbound = next((row for row in rows if selection_signature(row) == target), None)
                if outbound is None:
                    result.update(status="requires_manual_quote", message="The selected outbound is no longer available. Search again or verify a whole-ticket quote manually.")
                    return result
                if clock.monotonic() >= deadline:
                    raise TimeoutError("Flight function time limit reached before return retrieval.")
                result["diagnostics"]["return_requests"] = 1
                returns = get_flights(selected_outbound_query(query, target))
                rows = [replace(inbound, flights=[*outbound.flights, *inbound.flights],
                                airlines=list(dict.fromkeys([*outbound.airlines, *inbound.airlines]))) for inbound in returns]
                result["diagnostics"]["conditional_return_rows"] = len(rows)
            elif kind == "round-trip":
                choices = list(dict.fromkeys(signature for row in rows if (signature := selection_signature(row))))
                if choices:
                    # First-page prices are indicative. Preserve schedules,
                    # then obtain each whole-ticket amount from its return page.
                    partial = normalize_flight_rows(rows, legs[:1], departure_start, departure_end, airports)
                    result["options"] = [{**option, "price": None} for option in partial]
                    result["flight_choices"] = choices
                    result["status"] = "success"
                    result["diagnostics"]["outbound_choices"] = len(choices)
                    return result
            result["options"] = normalize_flight_rows(rows, legs, departure_start, departure_end, airports)
            result["diagnostics"]["complete_options"] = len(result["options"])
            if result["options"]:
                result["status"] = "success"
            elif kind == "round-trip":
                result.update(status="requires_manual_quote", message="No complete matching return fare was retrieved. This does not establish that no combined ticket exists; verify a whole-ticket quote manually.")
    except Exception as error:
        status = "empty" if type(error).__name__ == "FlightsNotFound" and operation == "search" else "failed"
        result.update(status=status, message=f"{type(error).__name__}: {str(error)[:180]}")
    finally:
        if acquired:
            FLIGHT_LIMIT.release()
        result["diagnostics"]["elapsed_seconds"] = round(clock.monotonic() - started, 3)
    return result
