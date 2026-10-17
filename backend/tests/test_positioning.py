from __future__ import annotations

import tempfile
import unittest
from datetime import date, datetime, time
from pathlib import Path
from unittest.mock import patch

from pydantic import ValidationError

from app.planner_discovery import DiscoveryManager, flight_movement, tasks_for
from app.planner_models import FareOffer, Movement, Place, PositioningPolicy, PositioningService, PricingRule, TripSpec, Visit
from app.planner_optimizer import bounds, optimize
from app.planner_positioning import search_modes, supplied_positioning
from app.planner_store import PlannerStore


def at(day, hour, zone="+08:00"):
    return datetime.fromisoformat(f"2027-02-{day:02}T{hour:02}:00:00{zone}")


def fixture():
    home = Place(id="pen", name="Penang", latitude=5.4, longitude=100.3, timezone="Asia/Kuala_Lumpur", flight_code="PEN", airport_codes=["PEN"])
    gateway = Place(id="kul", name="Kuala Lumpur", latitude=3.1, longitude=101.7, timezone="Asia/Kuala_Lumpur", flight_code="KUL", airport_codes=["KUL"])
    dest = Place(id="sel", name="Seoul", latitude=37.5, longitude=127, timezone="Asia/Seoul", flight_code="SEL", airport_codes=["ICN", "GMP"])
    spec = TripSpec(home=home, departures=[gateway], arrivals=[gateway], visits=[Visit(place=dest, min_stay_hours=72)],
        start_date=date(2027, 2, 5), end_date=date(2027, 2, 14), modes=["flight", "rail", "bus", "car"],
        home_departure_earliest=time(4), home_arrival_latest=time(23, 30),
        positioning_policies=[PositioningPolicy(direction="outbound", gateway_id="kul", mode="rail", search_more=False),
                              PositioningPolicy(direction="outbound", gateway_id="kul", mode="bus", search_more=False),
                              PositioningPolicy(direction="outbound", gateway_id="kul", mode="car", available=False),
                              PositioningPolicy(direction="return", gateway_id="kul", mode="bus", search_more=False)],
        positioning_services=[PositioningService(id="early", direction="outbound", gateway_id="kul", mode="rail", departure=at(5, 5), arrival=at(5, 9), fare_amount=30),
                              PositioningService(id="late", direction="return", gateway_id="kul", mode="bus", departure=at(14, 19), arrival=at(14, 23), fare_amount=25)])
    def flight(origin, dest, a, b, departure, arrival):
        return flight_movement(origin, dest, [dict(mode="flight", from_id=a, to_id=b, from_name=a, to_name=b,
            departure=departure.isoformat(), arrival=arrival.isoformat())], spec, {})
    out = flight(gateway, dest, "KUL", "ICN", at(5, 12), at(5, 19, "+09:00"))
    back = flight(dest, gateway, "ICN", "KUL", at(14, 12, "+09:00"), at(14, 17))
    too_early = flight(gateway, dest, "KUL", "ICN", at(5, 10), at(5, 17, "+09:00"))
    provider_train = Movement(id="cached-train", from_id="pen", to_id="kul", mode="rail", departure=at(5, 5), arrival=at(5, 8), duration_minutes=180, source="Transitous / MOTIS")
    movements = [out, back, too_early, provider_train]
    offers = [FareOffer(id="fare:"+m.id, movement_ids=[m.id], low=100, high=100) for m in movements]
    rules = [PricingRule(id="access", name="Test airport transfer", mode="taxi", low=0)]
    return spec, movements, offers, rules


class PositioningTests(unittest.TestCase):
    def test_supplied_services_join_flights_with_airport_buffers_and_party_fares(self):
        spec, movements, offers, rules = fixture()
        result = optimize(spec, movements, offers, rules)
        self.assertGreater(len(result["routes"]), 0)
        for route in result["routes"]:
            self.assertEqual(route["movements"][0]["id"], "positioning:early")
            self.assertEqual(route["movements"][-1]["id"], "positioning:late")
            self.assertEqual(route["total_cost_myr"], 255)
            self.assertNotIn(movements[2].id, [m["id"] for m in route["movements"]])
            self.assertNotIn("cached-train", [m["id"] for m in route["movements"]])

    def test_home_limits_reject_too_early_departure_and_late_return(self):
        spec, movements, offers, rules = fixture()
        for update in ({"home_departure_earliest": time(6)}, {"home_arrival_latest": time(22)}):
            constrained = spec.model_copy(update=update)
            self.assertEqual(optimize(constrained, movements, offers, rules)["routes"], [])
        start, end = bounds(spec)
        self.assertEqual(start, at(5, 4))
        self.assertEqual(end, at(14, 23).replace(minute=30))

    def test_unavailable_mode_blocks_supplied_services_too(self):
        spec, movements, offers, rules = fixture()
        spec.positioning_policies[0].available = False
        self.assertEqual(optimize(spec, movements, offers, rules)["routes"], [])

    def test_search_modes_are_separate_by_pair_direction_and_mode(self):
        spec, _, _, _ = fixture()
        self.assertEqual(search_modes(spec, "pen", "kul"), ["flight"])
        self.assertIn("rail", search_modes(spec, "kul", "pen"))
        self.assertNotIn("bus", search_modes(spec, "kul", "pen"))
        self.assertEqual(search_modes(spec, "kul", "sel"), spec.modes)
        with patch("app.planner_discovery.transitous.contact_url", "https://example.test"):
            queue = tasks_for(spec)
        outbound = [q for q in queue if q.get("from_id") == "pen" and q.get("to_id") == "kul"]
        self.assertTrue(outbound)
        self.assertTrue(all(q["kind"] == "flight" for q in outbound))
        self.assertTrue(any(q["kind"] == "transit" and q["from_id"] == "kul" and q["to_id"] == "pen" for q in queue))

    def test_restart_preserves_services_policies_and_feasible_route(self):
        spec, movements, offers, rules = fixture()
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder)/"planner.sqlite3"
            trip = PlannerStore(path).new_trip(spec.model_dump(mode="json"))
            restored = TripSpec.model_validate(PlannerStore(path).get("trips", trip["id"])["spec"])
            self.assertEqual(restored, spec)
            self.assertTrue(optimize(restored, movements, offers, rules)["routes"])

    def test_unknown_supplied_fare_is_not_free_and_service_edit_replaces_old(self):
        spec, movements, offers, rules = fixture()
        spec.positioning_services[0].fare_amount = None
        result = optimize(spec, movements, offers, rules)
        self.assertTrue(result["routes"])
        self.assertIsNone(result["routes"][0]["total_cost_myr"])
        supplied, _ = supplied_positioning(spec)
        spec.positioning_services = []
        self.assertEqual(optimize(spec, movements+supplied, offers, rules)["routes"], [])

    def test_invalid_schedules_gateways_and_duplicate_services_are_rejected(self):
        spec, _, _, _ = fixture()
        data = spec.model_dump(mode="json")
        data["positioning_services"][0]["arrival"] = data["positioning_services"][0]["departure"]
        with self.assertRaises(ValidationError): TripSpec.model_validate(data)
        data = spec.model_dump(mode="json")
        data["positioning_services"][0]["gateway_id"] = "sel"
        with self.assertRaises(ValidationError): TripSpec.model_validate(data)
        data = spec.model_dump(mode="json")
        data["positioning_services"].append(data["positioning_services"][0])
        with self.assertRaises(ValidationError): TripSpec.model_validate(data)
        changed = spec.model_copy(update={"positioning_policies": []})
        self.assertNotEqual(spec.discovery_key(), changed.discovery_key())

    def test_default_settings_preserve_legacy_discovery_identity(self):
        from app.planner_models import stable_id
        spec, _, _, _ = fixture()
        spec.positioning_policies = []
        spec.home_departure_earliest = None
        spec.home_arrival_latest = None
        expected = stable_id(spec.home, spec.departures, spec.arrivals, [v.place for v in spec.visits],
                             spec.start_date, spec.end_date, spec.adults, sorted(spec.modes),
                             spec.departure_start, spec.departure_end)
        self.assertEqual(spec.discovery_key(), expected)


class PositioningProviderTests(unittest.IsolatedAsyncioTestCase):
    async def test_transit_request_omits_skipped_modes(self):
        from unittest.mock import AsyncMock
        spec, _, _, _ = fixture()
        with tempfile.TemporaryDirectory() as folder:
            manager = DiscoveryManager(PlannerStore(Path(folder)/"planner.sqlite3"))
            task = {"kind": "transit", "key": "return", "from_id": "kul", "to_id": "pen", "date": "2027-02-14"}
            with patch("app.planner_discovery.transitous.contact_url", "https://example.test"), patch("app.planner_discovery.transitous._get_json", new_callable=AsyncMock, return_value={"itineraries": []}) as fetch:
                await manager.fetch(task, spec, {})
                modes = fetch.call_args.args[1]["transitModes"]
                self.assertNotIn("BUS", modes)
                self.assertIn("REGIONAL_RAIL", modes)
