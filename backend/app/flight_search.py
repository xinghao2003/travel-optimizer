from __future__ import annotations

import json
import threading
from dataclasses import dataclass, field
from datetime import date
from typing import Any

from .places import AirportCity

_PARSER_LOCK = threading.Lock()
_PARSER_INSTALLED = False


@dataclass(frozen=True)
class FlightOption:
    price_myr: float
    duration_minutes: int
    airlines: tuple[str, ...]
    segment_count: int
    search_url: str


@dataclass(frozen=True)
class FlightSearchOutcome:
    options: tuple[FlightOption, ...] = ()
    unpriced_rows: int = 0
    error: str | None = None
    no_results: bool = False


def _install_price_tolerant_parser() -> None:
    """Work around fast-flights 3.1 assuming every Google result has a fare."""
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

        def parse_with_unpriced_rows_skipped(html: str):
            try:
                return upstream_parse(html)
            except IndexError:
                document = LexborHTMLParser(html)
                script = document.css_first(r"script.ds\:1")
                if script is None:
                    raise
                js = script.text()
                try:
                    prefix, encoded_data = js.split("data:", 1)
                    raw_payload, trailer = encoded_data.rsplit(",", 1)
                    payload = json.loads(raw_payload)
                    rows = payload[3][0] or []
                except (IndexError, KeyError, TypeError, ValueError, json.JSONDecodeError):
                    raise

                priced_rows = []
                skipped = 0
                for row in rows:
                    try:
                        price = row[1][0][1]
                        if price is None:
                            raise ValueError("price is missing")
                        priced_rows.append(row)
                    except (IndexError, KeyError, TypeError, ValueError):
                        skipped += 1

                payload[3][0] = priced_rows
                sanitized_js = (
                    prefix
                    + "data:"
                    + json.dumps(payload, separators=(",", ":"))
                    + ","
                    + trailer
                )
                parsed = flight_parser.parse_js(sanitized_js)
                parsed.unpriced_rows = skipped
                return parsed

        parse_with_unpriced_rows_skipped._wayfinder_resilient = True
        fetcher.parse = parse_with_unpriced_rows_skipped
        _PARSER_INSTALLED = True


def search_one_way(
    departure_date: date,
    origin: AirportCity,
    destination: AirportCity,
) -> FlightSearchOutcome:
    """Fetch one IATA city-pair/date quote through fast-flights."""
    try:
        from fast_flights import FlightQuery, Passengers, create_query, get_flights
        from fast_flights.exceptions import FlightsNotFound

        _install_price_tolerant_parser()
        query = create_query(
            flights=[
                FlightQuery(
                    date=departure_date.isoformat(),
                    from_airport=origin.flight_code,
                    to_airport=destination.flight_code,
                )
            ],
            trip="one-way",
            seat="economy",
            passengers=Passengers(adults=1),
            language="en-US",
            currency="MYR",
        )
        try:
            raw_results = get_flights(query)
        except FlightsNotFound:
            return FlightSearchOutcome(no_results=True)

        unpriced_rows = int(getattr(raw_results, "unpriced_rows", 0))
        options: list[FlightOption] = []
        for result in raw_results:
            if result.price is None:
                unpriced_rows += 1
                continue
            duration = sum(int(segment.duration or 0) for segment in result.flights)
            options.append(
                FlightOption(
                    # The default Flights model reports the selected currency's amount.
                    price_myr=float(result.price),
                    duration_minutes=duration,
                    airlines=tuple(str(airline) for airline in result.airlines),
                    segment_count=len(result.flights),
                    search_url=query.url(),
                )
            )
        options.sort(key=lambda option: (option.price_myr, option.duration_minutes))
        return FlightSearchOutcome(
            options=tuple(options),
            unpriced_rows=unpriced_rows,
            no_results=not options,
        )
    except Exception as exc:
        if type(exc).__name__ == "FlightsNotFound":
            return FlightSearchOutcome(no_results=True)
        if isinstance(exc, IndexError):
            message = "Google returned flight data the fast-flights parser could not read."
        else:
            message = f"{type(exc).__name__}: {str(exc).strip()}"[:240]
        return FlightSearchOutcome(error=message)


def flight_search_status() -> dict[str, Any]:
    try:
        import fast_flights

        return {"available": True, "version": getattr(fast_flights, "__version__", "installed")}
    except ImportError:
        return {"available": False, "version": None}
