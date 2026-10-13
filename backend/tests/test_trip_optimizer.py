from __future__ import annotations

import asyncio
import unittest
from datetime import date

from fast_flights import FlightQuery, Passengers, create_query

from app.flight_search import FlightOption, FlightSearchOutcome
from app.places import AirportCity, search_airport_cities
from app.trip_optimizer import (
    MAX_DESTINATIONS,
    TransportSettings,
    build_search_specs,
    evenly_spaced_leg_dates,
    maximum_search_count,
    optimize_trip,
)


def city(code: str) -> AirportCity:
    return AirportCity(
        code=code,
        flight_code=code,
        name=code,
        country_code="MY",
        longitude=100.0 + ord(code[-1]) / 100,
        latitude=3.0 + ord(code[-1]) / 100,
        airport_codes=(code,),
    )


class TripOptimizerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.origin = city("ORG")
        self.a = city("AAA")
        self.b = city("BBB")

    def test_dates_are_spread_across_the_trip_window(self) -> None:
        self.assertEqual(
            evenly_spaced_leg_dates(date(2026, 11, 1), date(2026, 11, 9), 3),
            [date(2026, 11, 1), date(2026, 11, 5), date(2026, 11, 9)],
        )

    def test_dates_require_a_day_for_each_additional_leg(self) -> None:
        with self.assertRaisesRegex(ValueError, "at least one calendar day"):
            evenly_spaced_leg_dates(date(2026, 11, 1), date(2026, 11, 2), 4)

    def test_search_budget_boundaries(self) -> None:
        self.assertEqual([maximum_search_count(n) for n in range(1, 5)], [2, 6, 18, 44])
        self.assertEqual(maximum_search_count(4, return_to_origin=False), 40)
        self.assertEqual(MAX_DESTINATIONS, 4)
        with self.assertRaisesRegex(ValueError, "between 1 and 4"):
            build_search_specs(
                self.origin,
                [city("A01"), city("A02"), city("A03"), city("A04"), city("A05")],
                date(2026, 11, 1),
                date(2026, 11, 15),
                True,
            )

    def test_city_search_accepts_multi_airport_city_and_airport_codes(self) -> None:
        by_city_code = search_airport_cities("NYC", 5)
        by_airport_code = search_airport_cities("LGA", 5)
        self.assertTrue(any(city.flight_code == "NYC" for city in by_city_code))
        self.assertTrue(any("LGA" in city.airport_codes for city in by_airport_code))

    def test_three_leg_multi_city_query_serializes(self) -> None:
        query = create_query(
            flights=[
                FlightQuery(date="2026-11-01", from_airport="KUL", to_airport="PEN"),
                FlightQuery(date="2026-11-04", from_airport="PEN", to_airport="SIN"),
                FlightQuery(date="2026-11-08", from_airport="SIN", to_airport="KUL"),
            ],
            trip="multi-city",
            passengers=Passengers(adults=1),
            currency="MYR",
        )
        self.assertEqual(query.get_trip_type(), "multi-city")
        self.assertEqual(len(query.flight_data), 3)
        self.assertIn("tfs=", query.url())

    def test_order_and_hybrid_flight_ground_modes_are_optimized(self) -> None:
        prices = {
            ("ORG", "AAA"): 5,
            ("AAA", "BBB"): 50,
            ("BBB", "ORG"): 50,
            ("ORG", "BBB"): 5,
            ("BBB", "AAA"): None,
            ("AAA", "ORG"): 5,
        }
        calls: list[tuple[int, str, str]] = []

        async def fake_search(departure_date, from_city, to_city):
            calls.append((departure_date.day, from_city.code, to_city.code))
            price = prices.get((from_city.code, to_city.code))
            if price is None:
                return FlightSearchOutcome(no_results=True)
            return FlightSearchOutcome(
                options=(FlightOption(float(price), 60, ("Test Air",), 1, "https://example.test/flights"),)
            )

        distances = {
            f"{left}->{right}": 100_000.0
            for left in ("ORG", "AAA", "BBB")
            for right in ("ORG", "AAA", "BBB")
            if left != right
        }
        result = asyncio.run(
            optimize_trip(
                origin=self.origin,
                destinations=[self.a, self.b],
                start_date=date(2026, 11, 1),
                end_date=date(2026, 11, 3),
                return_to_origin=True,
                preference="cheapest",
                settings=TransportSettings(average_speed_kmh=80, fare_myr_per_km=0.27),
                distances_m=distances,
                distance_sources={key: "osrm_road" for key in distances},
                flight_search=fake_search,
            )
        )

        best = result["routes"][0]
        self.assertEqual([stop["code"] for stop in best["stops"]], ["ORG", "BBB", "AAA", "ORG"])
        self.assertAlmostEqual(best["total_cost_myr"], 37.0)
        self.assertAlmostEqual(best["flight_cost_myr"], 10.0)
        self.assertAlmostEqual(best["ground_cost_myr"], 27.0)
        self.assertEqual([leg["mode"] for leg in best["legs"]], ["flight", "ground", "flight"])
        self.assertEqual(result["searches_attempted"], 6)
        self.assertEqual(result["candidate_count"], 2)
        self.assertEqual(len(calls), 6)

    def test_balanced_ranking_includes_fare_per_destination_stay_hour(self) -> None:
        prices_and_durations = {
            ("ORG", "AAA"): (10, 60),
            ("AAA", "BBB"): (80, 23 * 60),
            ("BBB", "ORG"): (10, 60),
            ("ORG", "BBB"): (10, 60),
            ("BBB", "AAA"): (100, 2 * 60),
            ("AAA", "ORG"): (10, 60),
        }

        async def fake_search(_departure_date, from_city, to_city):
            price, duration = prices_and_durations[(from_city.code, to_city.code)]
            return FlightSearchOutcome(
                options=(FlightOption(float(price), duration, ("Test Air",), 1, "https://example.test/flights"),)
            )

        result = asyncio.run(
            optimize_trip(
                origin=self.origin,
                destinations=[self.a, self.b],
                start_date=date(2026, 11, 1),
                end_date=date(2026, 11, 3),
                return_to_origin=True,
                preference="balanced",
                settings=TransportSettings(flight_airport_buffer_minutes=0),
                distances_m={},
                distance_sources={},
                flight_search=fake_search,
            )
        )

        long_transfer_route, = [
            route for route in result["routes"] if [stop["code"] for stop in route["stops"]] == ["ORG", "AAA", "BBB", "ORG"]
        ]
        short_transfer_route, = [
            route for route in result["routes"] if [stop["code"] for stop in route["stops"]] == ["ORG", "BBB", "AAA", "ORG"]
        ]
        self.assertAlmostEqual(long_transfer_route["stay_hours"], 25.0)
        self.assertAlmostEqual(long_transfer_route["cost_per_stay_hour_myr"], 4.0)
        self.assertAlmostEqual(short_transfer_route["stay_hours"], 46.0)
        self.assertAlmostEqual(short_transfer_route["cost_per_stay_hour_myr"], round(120 / 46, 2))
        self.assertEqual(short_transfer_route["rank"], 1)
        self.assertGreater(short_transfer_route["total_cost_myr"], long_transfer_route["total_cost_myr"])

    def test_all_orders_remain_available_when_flights_fail(self) -> None:
        destinations = [city(code) for code in ("A01", "A02", "A03", "A04")]
        all_cities = [self.origin, *destinations]
        distances = {
            f"{left.code}->{right.code}": 50_000.0
            for left in all_cities
            for right in all_cities
            if left.code != right.code
        }

        async def failed_search(_departure_date, _from_city, _to_city):
            return FlightSearchOutcome(error="simulated Google parser failure")

        result = asyncio.run(
            optimize_trip(
                origin=self.origin,
                destinations=destinations,
                start_date=date(2026, 11, 1),
                end_date=date(2026, 11, 10),
                return_to_origin=True,
                preference="balanced",
                settings=TransportSettings(),
                distances_m=distances,
                distance_sources={key: "osrm_road" for key in distances},
                flight_search=failed_search,
            )
        )
        self.assertEqual(result["candidate_count"], 24)
        self.assertEqual(result["searches_attempted"], 44)
        self.assertEqual(result["searches_failed"], 44)
        self.assertEqual(len(result["routes"]), 24)
        self.assertTrue(all(all(leg["mode"] == "ground" for leg in route["legs"]) for route in result["routes"]))


if __name__ == "__main__":
    unittest.main()
