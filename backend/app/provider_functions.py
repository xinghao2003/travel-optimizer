"""Bounded, stateless provider operations used by function entrypoints."""
from dataclasses import replace
import time as clock

from . import planner_providers as flights


def selection_signature(row):
    selected = getattr(row, "outbound_selection", None)
    return tuple(tuple(str(value) for value in segment) for segment in selected) if selected else None


def fetch_flight_step(legs, adults, kind, departure_start, departure_end, *, operation="search", selection=None, timeout=15, max_seconds=35):
    """Search once, or replay the initial page and check one selected return.

    A return step uses the same client for its two requests. Remaining choices
    are plain schedule identifiers owned by the browser, never a server session.
    """
    if kind == "multi-city":
        return {"protocol_version": 2, **flights.fetch_flights(legs, adults, kind, departure_start, departure_end)}
    import airportsdata
    started = clock.monotonic()
    deadline = started + max_seconds
    query = flights.flight_query(legs, adults, kind, departure_start, departure_end)
    result = {"protocol_version": 2, "kind": kind, "status": "empty", "options": [], "search_url": query.url(),
              "diagnostics": {"initial_requests": 0, "return_requests": 0, "requested_journeys": len(legs), "returned_rows": 0, "complete_options": 0}}
    acquired = False
    try:
        flights._install_price_tolerant_parser()
        airports = airportsdata.load("IATA")
        acquired = flights.FLIGHT_LIMIT.acquire(timeout=max(0, deadline - clock.monotonic()))
        if not acquired:
            raise TimeoutError("Flight provider is busy. Retry this query.")
        with flights.flight_session(timeout, deadline=deadline) as get_flights:
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
                returns = get_flights(flights.selected_outbound_query(query, target))
                rows = [replace(inbound, flights=[*outbound.flights, *inbound.flights],
                                airlines=list(dict.fromkeys([*outbound.airlines, *inbound.airlines]))) for inbound in returns]
                result["diagnostics"]["conditional_return_rows"] = len(rows)
            elif kind == "round-trip":
                choices = list(dict.fromkeys(signature for row in rows if (signature := selection_signature(row))))
                if choices:
                    # First-page prices are indicative. Preserve schedules,
                    # then obtain each whole-ticket amount from its return page.
                    partial = flights.normalize_flight_rows(rows, legs[:1], departure_start, departure_end, airports)
                    result["options"] = [{**option, "price": None} for option in partial]
                    result["flight_choices"] = choices
                    result["status"] = "success"
                    result["diagnostics"]["outbound_choices"] = len(choices)
                    return result
            result["options"] = flights.normalize_flight_rows(rows, legs, departure_start, departure_end, airports)
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
            flights.FLIGHT_LIMIT.release()
        result["diagnostics"]["elapsed_seconds"] = round(clock.monotonic() - started, 3)
    return result
