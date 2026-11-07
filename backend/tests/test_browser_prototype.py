from datetime import time
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

import httpx

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from api.flights import app
from app import browser_runtime as browser
from app.planner_models import Visit
from app.planner_optimizer import optimize
from test_planner import HOME, A, B, dt, fare, movement, trip


class BrowserAdapterTests(unittest.TestCase):
    def test_prepare_has_actual_date_transit_and_one_way_flights(self):
        origin = HOME.model_copy(update={"flight_code": "BER", "airport_codes": ["BER"], "timezone": "Europe/Berlin"})
        dest = A.model_copy(update={"flight_code": "PRG", "airport_codes": ["PRG"], "timezone": "Europe/Prague"})
        spec = trip(visits=[Visit(place=dest)], departure_start=time(8), departure_end=time(17)).model_copy(update={"home": origin, "departures": [origin], "arrivals": [origin]})
        result = json.loads(browser.prepare(spec.model_dump_json()))
        tasks = result["tasks"]
        self.assertEqual(tasks[0]["kind"], "road")
        self.assertEqual(len({task["key"] for task in tasks}), len(tasks))
        outbound = next(task for task in tasks if task["kind"] == "transit" and task["from_id"] == origin.id)
        self.assertEqual(outbound["params"]["time"], "2027-02-10T08:00:00+01:00")
        self.assertTrue(all(len(task["request"]["legs"]) == 1 for task in tasks if task["kind"] == "flight"))

    def test_import_and_solve_match_native_and_do_not_accept_uploaded_checkpoint(self):
        spec = trip(visits=[Visit(place=A, min_stay_hours=12), Visit(place=B, min_stay_hours=12)])
        moves = [movement("out", HOME, A, dt(10), dt(10, 10)), movement("ab", A, B, dt(11), dt(11, 10)), movement("back", B, HOME, dt(12), dt(12, 10))]
        offers = [fare(item.id, 30) for item in moves]
        state = {"spec": spec.model_dump(mode="json"), "graph": {"revision": 3, "movements": [m.model_dump(mode="json") for m in moves], "offers": [o.model_dump(mode="json") for o in offers]}, "checkpoint": "not valid pickle"}
        browser.restore(json.dumps(state))
        result = json.loads(browser.solve('{"seconds":0.5}'))
        self.assertEqual(result, optimize(spec, moves, offers, [], snapshot_revision=3))
        self.assertEqual(json.loads(browser.snapshot())["graph"]["movements"], state["graph"]["movements"])

    def test_failed_flights_are_not_ingested_as_empty_success(self):
        browser.prepare(trip().model_dump_json())
        with self.assertRaisesRegex(ValueError, "provider unavailable"):
            browser.ingest('{"kind":"flight"}', '{"status":"failed","message":"provider unavailable"}')

    def test_unknown_flight_fare_remains_unknown_and_whole_party_fare_is_not_multiplied(self):
        spec = trip(adults=3, departure_start=time(0), departure_end=time(23, 59))
        browser.prepare(spec.model_dump_json())
        segment = {"from_id": "BER", "to_id": "PRG", "from_name": "Berlin", "to_name": "Prague", "mode": "flight", "departure": dt(10, 12).isoformat(), "arrival": dt(10, 13).isoformat(), "from_timezone": "UTC", "to_timezone": "UTC"}
        for price in (None, 120):
            browser.ingest(json.dumps({"kind": "flight", "from_id": HOME.id, "to_id": A.id}), json.dumps({"status": "success", "options": [{"price": price, "journeys": [[segment]]}]}))
        offers = json.loads(browser.snapshot())["graph"]["offers"]
        self.assertEqual([offer["low"] for offer in offers], [None, 120])
        self.assertTrue(all(offer["adults"] == 3 for offer in offers))


class FlightFunctionTests(unittest.IsolatedAsyncioTestCase):
    async def test_health_and_validated_stateless_request(self):
        payload = {"legs": [{"from_id": "berlin", "to_id": "prague", "date": "2027-02-10", "from_code": "BER", "to_code": "PRG", "from_airports": ["BER"], "to_airports": ["PRG"], "timezone": "Europe/Berlin"}], "adults": 2}
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://local") as client:
            self.assertTrue((await client.get("/api/flights")).json()["stateless"])
            with patch("api.flights.fetch_flights", return_value={"status": "success", "options": []}) as provider:
                response = await client.post("/api/flights", json=payload)
            self.assertEqual(response.status_code, 200)
            self.assertEqual(provider.call_args.kwargs, {"timeout": 20})
            self.assertEqual(provider.call_args.args[1], 2)
            self.assertEqual((await client.post("/api/flights", json={**payload, "url": "https://example.com"})).status_code, 422)
            self.assertEqual((await client.post("/api/flights", json={**payload, "kind": "round-trip"})).status_code, 422)


if __name__ == "__main__":
    unittest.main()
