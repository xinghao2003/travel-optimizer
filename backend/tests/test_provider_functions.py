from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import time
import os
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, MagicMock, patch

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from api import flights as flight_api, transit as transit_api
from app import planner_providers as providers
from app.provider_functions import fetch_flight_step
from app.provider_http import provider_app


@dataclass
class Row:
    price: float | None
    flights: list
    airlines: list = field(default_factory=lambda: ["Fixture"])
    outbound_selection: tuple | None = None


def segment(origin, destination, day, first, last):
    return SimpleNamespace(from_airport=SimpleNamespace(code=origin, name=origin), to_airport=SimpleNamespace(code=destination, name=destination),
        departure=SimpleNamespace(date=(2027, 2, day), time=(first, 0)), arrival=SimpleNamespace(date=(2027, 2, day), time=(last, 0)), flight_number="123")


LEG = {"from_id": "kul", "to_id": "sin", "date": "2027-02-10", "from_code": "KUL", "to_code": "SIN", "from_airports": ["KUL"], "to_airports": ["SIN"], "timezone": "Asia/Kuala_Lumpur"}
BACK = {**LEG, "from_id": "sin", "to_id": "kul", "date": "2027-02-12", "from_code": "SIN", "to_code": "KUL", "from_airports": ["SIN"], "to_airports": ["KUL"], "timezone": "Asia/Singapore"}
SELECTION = (("KUL", "2027-02-10", "SIN", "MH", "123"),)


class FlightStepTests(unittest.TestCase):
    def setUp(self):
        self.outbound = Row(999, [segment("KUL", "SIN", 10, 9, 10)], outbound_selection=SELECTION)
        self.inbound = Row(120, [segment("SIN", "KUL", 12, 16, 17)])

    def step(self, responses, **kwargs):
        seen = []
        @contextmanager
        def session(timeout=None, *, deadline=None):
            self.assertEqual(timeout, 15); self.assertIsNotNone(deadline)
            def fetch(query):
                seen.append(query)
                value = responses[len(seen)-1]
                if isinstance(value, Exception): raise value
                return value
            yield fetch
        with patch.object(providers, "flight_session", session), patch.object(providers, "_install_price_tolerant_parser"):
            result = fetch_flight_step([LEG, BACK], 2, "round-trip", time(9), time(17), **kwargs)
        return result, seen

    def test_initial_step_preserves_unpriced_schedules_and_unique_choices(self):
        other = Row(1000, [segment("KUL", "SIN", 10, 11, 12)], outbound_selection=(("KUL", "2027-02-10", "SIN", "MH", 456),))
        result, seen = self.step([[self.outbound, self.outbound, other]])
        self.assertEqual(len(seen), 1)
        self.assertEqual(len(result["flight_choices"]), 2)
        self.assertTrue(all(option["price"] is None and len(option["journeys"]) == 1 for option in result["options"]))
        self.assertEqual(result["flight_choices"][1][0][-1], "456")
        self.assertEqual(result["diagnostics"]["return_requests"], 0)

    def test_return_step_replays_initial_query_and_prices_only_complete_ticket(self):
        result, seen = self.step([[self.outbound], [self.inbound]], operation="return", selection=SELECTION)
        self.assertEqual(len(seen), 2)
        self.assertNotEqual(seen[0].to_bytes(), seen[1].to_bytes())
        self.assertEqual(result["options"][0]["price"], 120)
        self.assertEqual(len(result["options"][0]["journeys"]), 2)
        self.assertEqual(result["diagnostics"]["initial_requests"], 1)
        self.assertEqual(result["diagnostics"]["return_requests"], 1)
        self.assertNotIn("flight_choices", result)

    def test_return_without_price_and_missing_outbound_are_not_invented_fares(self):
        result, _ = self.step([[self.outbound], [Row(None, self.inbound.flights)]], operation="return", selection=SELECTION)
        self.assertIsNone(result["options"][0]["price"])
        missing, seen = self.step([[]], operation="return", selection=SELECTION)
        self.assertEqual(missing["status"], "requires_manual_quote"); self.assertEqual(len(seen), 1)
        self.assertEqual(missing["options"], [])

    def test_mismatched_partial_return_keeps_manual_diagnostic(self):
        result, _ = self.step([[self.outbound], [Row(20, [segment("SIN", "KUL", 11, 16, 17)])]], operation="return", selection=SELECTION)
        self.assertEqual(result["status"], "requires_manual_quote"); self.assertFalse(result["options"])

    def test_already_complete_rows_and_empty_results(self):
        full = Row(150, [*self.outbound.flights, *self.inbound.flights])
        result, seen = self.step([[full]])
        self.assertEqual(result["options"][0]["price"], 150); self.assertEqual(len(seen), 1)
        empty, _ = self.step([[]]); self.assertEqual(empty["status"], "requires_manual_quote")
        with patch.object(providers, "flight_session") as session:
            manual = fetch_flight_step([LEG, BACK], 2, "multi-city", time(9), time(17))
        session.assert_not_called(); self.assertTrue(manual["automatic_query_skipped"])

    def test_failed_step_and_provider_admission_timeout_are_retryable(self):
        result, seen = self.step([[self.outbound], TimeoutError("recorded timeout")], operation="return", selection=SELECTION)
        self.assertEqual(result["status"], "failed"); self.assertEqual(len(seen), 2)
        with patch.object(providers, "FLIGHT_LIMIT") as limit, patch.object(providers, "flight_session") as session:
            limit.acquire.return_value = False
            result = fetch_flight_step([LEG], 1, "one-way", time(9), time(17), max_seconds=.01)
        self.assertEqual(result["status"], "failed"); session.assert_not_called(); limit.release.assert_not_called()

    def test_session_caps_each_http_request_by_remaining_function_time(self):
        query = providers.flight_query([LEG], 1, "one-way", time(9), time(17))
        client = MagicMock(); client.get.return_value.text = "recorded html"
        client.__enter__.return_value = client
        def fetch(query, *, integration):
            self.assertEqual(integration.fetch_html(query), "recorded html"); return []
        with patch("primp.Client", return_value=client), patch("fast_flights.get_flights", side_effect=fetch):
            with providers.flight_session(15, deadline=providers.clock.monotonic() + .5) as get_flights:
                get_flights(query)
            self.assertGreater(client.get.call_args.kwargs["timeout"], 0)
            self.assertLessEqual(client.get.call_args.kwargs["timeout"], .5)
            client.get.reset_mock()
            with providers.flight_session(15, deadline=providers.clock.monotonic() - 1) as get_flights:
                with self.assertRaises(TimeoutError): get_flights(query)
            client.get.assert_not_called()


class ProviderHttpTests(unittest.IsolatedAsyncioTestCase):
    async def test_validated_round_trip_step_and_busy_admission(self):
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=flight_api.app), base_url="http://test") as client:
            data = {"legs": [LEG, BACK], "kind": "round-trip", "operation": "return", "selection": SELECTION, "adults": 2}
            with patch.object(flight_api, "fetch_flight_step", return_value={"status": "success", "options": []}) as provider:
                self.assertEqual((await client.post("/api/flights", json=data)).status_code, 200)
                self.assertEqual(provider.call_args.kwargs["operation"], "return")
            for invalid in ({"kind": "one-way"}, {"operation": "search"}, {"selection": []}, {"departure_start": "09:00:00+08:00"}, {"url": "https://example.com"}):
                self.assertEqual((await client.post("/api/flights", json={**data, **invalid})).status_code, 422)
            with patch.object(flight_api, "_requests") as limit, patch.object(flight_api, "fetch_flight_step") as provider:
                limit.acquire.return_value = False
                self.assertEqual((await client.post("/api/flights", json=data)).status_code, 429)
                provider.assert_not_called(); limit.release.assert_not_called()

    async def test_transit_contact_validation_and_exact_provider_parameters(self):
        params = {"fromPlace": "3,101", "toPlace": "4,102", "time": "2027-02-10T09:00:00+08:00", "transitModes": "REGIONAL_RAIL,BUS", "searchWindow": "28800", "pageCursor": "opaque-cursor", "radius": "25000.0", "directModes": ""}
        # Capture the outbound client without replacing the ASGI caller.
        outbound = MagicMock(); outbound.__aenter__ = AsyncMock(return_value=outbound); outbound.__aexit__ = AsyncMock(return_value=False)
        response = httpx.Response(200, json={"itineraries": []}, request=httpx.Request("GET", "https://transit.test/api/v6/plan")); outbound.get = AsyncMock(return_value=response)
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=transit_api.app), base_url="http://test") as client:
            with patch.dict(os.environ, {"TRANSITOUS_CONTACT_URL": ""}):
                self.assertEqual((await client.get("/api/transit", params=params)).status_code, 503)
            with patch.dict(os.environ, {"TRANSITOUS_CONTACT_URL": "https://app.example/contact", "TRANSITOUS_API_BASE_URL": "https://transit.test/api"}), patch.object(transit_api.httpx, "AsyncClient", return_value=outbound) as factory:
                result = await client.get("/api/transit", params=params)
                self.assertEqual(result.status_code, 200)
                self.assertEqual(factory.call_args.kwargs["headers"]["User-Agent"], "WayfinderRoutes/1.1 (https://app.example/contact)")
                url = outbound.get.call_args.args[0]; sent = outbound.get.call_args.kwargs["params"]
                self.assertEqual(url, "https://transit.test/api/v6/plan"); self.assertEqual(sent["time"], params["time"])
                self.assertEqual(sent["pageCursor"], params["pageCursor"]); self.assertEqual(sent["radius"], "25000.0")
                self.assertEqual(sent["joinInterlinedLegs"], "false")
            for invalid in ({"url": "https://example.com"}, {"fromPlace": "91,0"}, {"time": "2027-02-10T09:00:00"}, {"transitModes": "CAR"}, {"radius": "nan"}):
                self.assertEqual((await client.get("/api/transit", params={**params, **invalid})).status_code, 422)

    async def test_transit_empty_success_failure_timeout_and_busy_are_distinct(self):
        params = {"fromPlace": "3,101", "toPlace": "4,102", "time": "2027-02-10T09:00:00Z", "transitModes": "BUS", "searchWindow": "3600"}
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=transit_api.app), base_url="http://test") as client:
            for payload, status in [({"itineraries": [{"legs": []}]}, 200), ({"itineraries": []}, 200), (["invalid"], 502), (httpx.ReadTimeout("recorded"), 504)]:
                outbound = MagicMock(); outbound.__aenter__ = AsyncMock(return_value=outbound); outbound.__aexit__ = AsyncMock(return_value=False)
                outbound.get = AsyncMock(side_effect=payload) if isinstance(payload, Exception) else AsyncMock(return_value=httpx.Response(200, json=payload, request=httpx.Request("GET", "https://transit.test/v6/plan")))
                with patch.dict(os.environ, {"TRANSITOUS_CONTACT_URL": "https://app.example/contact"}), patch.object(transit_api.httpx, "AsyncClient", return_value=outbound):
                    self.assertEqual((await client.get("/api/transit", params=params)).status_code, status)
            with patch.dict(os.environ, {"TRANSITOUS_CONTACT_URL": "https://app.example/contact"}), patch.object(transit_api, "_routes") as limit:
                limit.acquire.return_value = False
                self.assertEqual((await client.get("/api/transit", params=params)).status_code, 429)
                limit.release.assert_not_called()

    async def test_cors_explicit_origin_and_json_preflight(self):
        with patch.dict(os.environ, {"BROWSER_ALLOWED_ORIGINS": "https://app.example"}): app = provider_app("cors test")
        @app.get("/probe")
        async def probe(): return {"ok": True}
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
            headers = {"Origin": "https://app.example", "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "Content-Type"}
            allowed = await client.options("/api/flights", headers=headers)
            self.assertEqual(allowed.status_code, 200); self.assertEqual(allowed.headers["access-control-allow-origin"], "https://app.example")
            denied = await client.options("/api/flights", headers={**headers, "Origin": "https://unlisted.example"})
            self.assertEqual(denied.status_code, 400); self.assertNotIn("access-control-allow-origin", denied.headers)
