from __future__ import annotations

import unittest
from datetime import time
from unittest.mock import patch

from fast_flights.model import Airport, CarbonEmission, Flights, SimpleDatetime, SingleFlight
from app.planner_providers import fetch_flights, flight_query, selected_outbound_query


def segment(origin, destination, day, hour=10):
    return SingleFlight(from_airport=Airport(origin, origin), to_airport=Airport(destination, destination),
                        departure=SimpleDatetime((2027, 3, day), (hour, 0)),
                        arrival=SimpleDatetime((2027, 3, day), (hour+1, 0)), duration=60, plane_type="test")


def row(flights, price, selection=None):
    result = Flights(type="test", price=price, airlines=["Example"], flights=flights,
                     carbon=CarbonEmission(1, 1))
    if selection:
        result.outbound_selection = selection
    return result


OUTBOUND = (("KUL", "2027-03-05", "SIN", "SQ", "101"),)
LEGS = [dict(date="2027-03-05", from_code="KUL", to_code="SIN", from_airports=["KUL"],
             to_airports=["SIN"], timezone="Asia/Kuala_Lumpur"),
        dict(date="2027-03-11", from_code="SIN", to_code="KUL", from_airports=["SIN"],
             to_airports=["KUL"], timezone="Asia/Singapore")]


class RoundTripSelectionTests(unittest.TestCase):
    def fetch(self, pages):
        with patch("app.planner_providers._install_price_tolerant_parser"), patch("fast_flights.get_flights", side_effect=pages) as get:
            result = fetch_flights(LEGS, 1, "round-trip", time(0), time(23, 59))
        return result, get

    def test_selects_outbound_and_uses_conditional_total(self):
        outbound = row([segment("KUL", "SIN", 5)], 100, OUTBOUND)
        inbound = row([segment("SIN", "KUL", 11)], 450)
        result, get = self.fetch([[outbound], [inbound]])
        self.assertEqual(result["status"], "success")
        self.assertEqual(result["options"][0]["price"], 450)
        self.assertEqual(len(result["options"][0]["journeys"]), 2)
        self.assertEqual(get.call_count, 2)
        self.assertNotEqual(get.call_args_list[0].args[0].to_bytes(), get.call_args_list[1].args[0].to_bytes())

    def test_wrong_date_or_wrong_direction_never_gets_a_bundle_price(self):
        outbound = row([segment("KUL", "SIN", 5)], 100, OUTBOUND)
        for inbound in [row([segment("SIN", "KUL", 12)], 450), row([segment("KUL", "SIN", 11)], 450)]:
            with self.subTest(inbound=inbound):
                result, _ = self.fetch([[outbound], [inbound]])
                self.assertEqual(result["options"], [])
                self.assertEqual(result["status"], "requires_manual_quote")

    def test_first_page_price_is_not_used_when_return_request_fails(self):
        result, _ = self.fetch([[row([segment("KUL", "SIN", 5)], 100, OUTBOUND)], RuntimeError("unavailable")])
        self.assertEqual(result["options"], [])
        self.assertEqual(result["diagnostics"]["return_requests"], 1)
        self.assertTrue(result["diagnostics"]["return_errors"])

    def test_duplicate_outbound_rows_need_only_one_followup(self):
        outbound = row([segment("KUL", "SIN", 5)], 100, OUTBOUND)
        result, get = self.fetch([[outbound, outbound], [row([segment("SIN", "KUL", 11)], 450)]])
        self.assertEqual(get.call_count, 2)
        self.assertEqual(len(result["options"]), 1)

    def test_unknown_return_price_stays_unknown(self):
        result, _ = self.fetch([[row([segment("KUL", "SIN", 5)], 100, OUTBOUND)],
                                [row([segment("SIN", "KUL", 11)], None)]])
        self.assertIsNone(result["options"][0]["price"])

    def test_selected_query_keeps_dates_filters_party_and_original_unchanged(self):
        original = flight_query(LEGS, 2, "round-trip", time(9), time(17))
        original_bytes = original.to_bytes()
        selected = selected_outbound_query(original, OUTBOUND)
        self.assertEqual(original.to_bytes(), original_bytes)
        self.assertEqual(selected.passengers, original.passengers)
        self.assertEqual(selected.flight_data[1], original.flight_data[1])
        self.assertEqual(selected.flight_data[0].earliest_departure_hour, 9)
        self.assertIn(b"SQ", selected.to_bytes())
        self.assertIn(b"101", selected.to_bytes())


if __name__ == "__main__":
    unittest.main()
