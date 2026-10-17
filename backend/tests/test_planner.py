from __future__ import annotations

import asyncio
import itertools
import tempfile
import unittest
from datetime import date, datetime, time, timedelta, timezone
from pathlib import Path
from unittest.mock import patch
from types import SimpleNamespace
from zoneinfo import ZoneInfo

import httpx

from app.planner_discovery import DiscoveryManager, flight_movement, transit_fare, transit_movements
from app.planner_models import Charge, Commitment, FareOffer, Movement, Place, PricingRule, TripSpec, Visit
from app.planner_optimizer import bounds, optimize, price_path
from app.planner_store import PlannerStore

UTC = timezone.utc


def place(id, timezone="UTC"):
    return Place(id=id, name=id, latitude=3, longitude=101, timezone=timezone)


HOME, A, B = place("home"), place("a"), place("b")


def dt(day, hour=9):
    return datetime(2027, 2, day, hour, tzinfo=UTC)


def trip(visits=None, **kwargs):
    return TripSpec(home=HOME, visits=visits or [Visit(place=A)], start_date=date(2027, 2, 10), end_date=date(2027, 2, 12),
                    modes=kwargs.pop("modes", ["flight", "rail"]), **kwargs)


def movement(id, origin, dest, dep, arr, mode="flight", **kwargs):
    return Movement(id=id, from_id=origin.id, to_id=dest.id, departure=dep, arrival=arr,
                    duration_minutes=(arr-dep).total_seconds()/60, mode=mode, source="fixture", **kwargs)


def fare(id, amount, ids=None, **kwargs):
    return FareOffer(id="fare:"+id, movement_ids=ids or [id], low=amount, high=amount, **kwargs)


class OptimizerTests(unittest.TestCase):
    def test_stays_use_arrival_and_departure_including_outward_and_return(self):
        spec = trip()
        movements = [movement("slow", HOME, A, dt(10), dt(10, 15)), movement("fast", HOME, A, dt(10), dt(10, 10)), movement("back", A, HOME, dt(12, 17), dt(12, 18))]
        result = optimize(spec, movements, [fare("slow", 100), fare("fast", 200), fare("back", 100)], [])
        self.assertEqual({(r["total_cost_myr"], r["stay_hours"]) for r in result["routes"]}, {(200, 50), (300, 55)})

    def test_overlapping_legs_and_minimum_stays_are_rejected(self):
        outward = movement("out", HOME, A, dt(10), dt(12, 18))
        back = movement("back", A, HOME, dt(12, 17), dt(12, 19))
        self.assertEqual(optimize(trip(), [outward, back], [fare("out", 1), fare("back", 1)], [])["routes"], [])
        outward = movement("out", HOME, A, dt(10), dt(10, 10))
        self.assertEqual(optimize(trip(visits=[Visit(place=A, min_stay_hours=60)]), [outward, back], [], [])["routes"], [])

    def test_bundle_can_make_expensive_legs_optimal_and_fit_budget(self):
        spec = trip(budget_myr=100)
        movements = [movement("out", HOME, A, dt(10), dt(10, 10)), movement("back", A, HOME, dt(12, 17), dt(12, 18))]
        offers = [fare("out", 500), fare("back", 500), fare("bundle", 90, ["out", "back"], kind="round-trip")]
        result = optimize(spec, movements, offers, [])
        self.assertEqual(result["routes"][0]["total_cost_myr"], 90)
        self.assertEqual(len(result["routes"][0]["purchases"]), 1)
        # Discovery must still request the bundle when separate tickets exceed
        # the budget, before the combined quote is known.
        preliminary = optimize(spec, movements, offers[:2], [])
        self.assertFalse(preliminary["routes"])
        self.assertTrue(preliminary["bundle_candidates"])
        self.assertTrue(preliminary["refinement_routes"])

    def test_exact_cover_does_not_overlap_tickets(self):
        ms = [movement("one", HOME, A, dt(10), dt(10, 10)), movement("two", A, B, dt(11), dt(11, 10)), movement("three", B, HOME, dt(12), dt(12, 10))]
        offers = [fare(m.id, 100) for m in ms]+[fare("ab", 50, ["one", "two"], kind="multi-city"), fare("bc", 40, ["two", "three"], kind="multi-city")]
        price = price_path(ms, offers, trip([Visit(place=A), Visit(place=B)]), [])
        self.assertEqual(price["total_cost_myr"], 140)
        covered = [id for o in price["purchases"] for id in o["movement_ids"]]
        self.assertEqual(len(covered), len(set(covered)))

    def test_unknown_and_ranges_not_free_and_budget_uncertainty(self):
        spec = trip(budget_myr=150)
        ms = [movement("out", HOME, A, dt(10), dt(10, 10)), movement("back", A, HOME, dt(12, 17), dt(12, 18))]
        result = optimize(spec, ms, [fare("out", 50)], [])
        route = result["routes"][0]
        self.assertIsNone(route["total_cost_myr"])
        self.assertIsNone(route["cost_high_myr"])
        self.assertEqual(route["cost_low_myr"], 50)
        self.assertEqual(route["budget_status"], "uncertain")
        self.assertTrue(result["missing_fares"])
        result = optimize(spec, ms, [fare("out", 50), FareOffer(id="range", movement_ids=["back"], low=20, high=120, source="user")], [])
        self.assertEqual((result["routes"][0]["cost_low_myr"], result["routes"][0]["cost_high_myr"]), (70, 170))

    def test_rules_units_overrides_exchange_and_zero_fares(self):
        spec = trip(adults=3, exchange_rates={"SGD": 3.3})
        m = movement("out", HOME, A, dt(10), dt(10, 10), distance_km=100)
        rule = PricingRule(id="bus", name="Vehicle rate", kind="per-km", mode="flight", low=1, unit="vehicle", capacity=2, currency="SGD")
        self.assertEqual(price_path([m], [], spec, [rule])["total_cost_myr"], 660)
        self.assertEqual(price_path([m], [fare("out", 50)], spec, [rule])["total_cost_myr"], 50)  # Party quote, not 3x.
        self.assertEqual(price_path([m], [fare("out", 50), FareOffer(id="override", movement_ids=["out"], low=0, high=0, source="user")], spec, [rule])["total_cost_myr"], 0)

    def test_fixed_and_flexible_whole_trip_dates(self):
        ms = [movement("out", HOME, A, dt(11), dt(11, 10)), movement("back", A, HOME, dt(12, 17), dt(12, 18))]
        offers = [fare(m.id, 1) for m in ms]
        self.assertFalse(optimize(trip(), ms, offers, [])["routes"])
        self.assertTrue(optimize(trip(date_mode="flexible"), ms, offers, [])["routes"])

    def test_commitment_presence_and_transfer_limits(self):
        ms = [movement("out", HOME, A, dt(10), dt(10, 12), transfers=2), movement("back", A, HOME, dt(12, 17), dt(12, 18))]
        self.assertFalse(optimize(trip(max_transfers=1), ms, [], [])["routes"])
        self.assertFalse(optimize(trip(commitments=[Commitment(place_id=A.id, start=dt(10, 11), end=dt(10, 13))]), ms, [], [])["routes"])
        self.assertTrue(optimize(trip(commitments=[Commitment(place_id=A.id, start=dt(11, 11), end=dt(11, 13))]), ms, [], [])["routes"])

    def test_overnight_and_dst_elapsed_time(self):
        zone = ZoneInfo("America/New_York")
        m = Movement(id="dst", from_id="home", to_id="a", mode="flight", departure=datetime(2027, 3, 14, 1, 30, tzinfo=zone), arrival=datetime(2027, 3, 14, 3, 30, tzinfo=zone), duration_minutes=120, source="fixture")
        self.assertEqual(m.duration_minutes, 60)
        ms = [movement("out", HOME, A, dt(10, 22), dt(11, 2)), movement("back", A, HOME, dt(12, 17), dt(12, 18))]
        self.assertFalse(optimize(trip(allow_overnight=False), ms, [], [])["routes"])
        start, end = bounds(trip())
        self.assertLess(start, end)

    def test_positioning_is_counted_and_gateway_choice_is_real(self):
        gateway = place("gateway")
        spec = trip(departures=[gateway], arrivals=[gateway], departure_start=time(0))
        ms = [movement("position", HOME, gateway, dt(10, 6), dt(10, 8), "rail"),
              movement("out", gateway, A, dt(10), dt(10, 10)), movement("back", A, gateway, dt(12, 14), dt(12, 15)),
              movement("home", gateway, HOME, dt(12, 16), dt(12, 18), "rail")]
        result = optimize(spec, ms, [fare(m.id, 10) for m in ms], [])
        self.assertEqual(result["routes"][0]["total_cost_myr"], 40)
        self.assertEqual(result["routes"][0]["stay_hours"], 52)
        self.assertEqual(result["routes"][0]["travel_hours"], 6)

    def test_departure_and_arrival_candidates_are_selected_independently(self):
        gateway, arrival = place("outward-gateway"), place("return-gateway")
        spec = trip(departures=[HOME, gateway], arrivals=[HOME, arrival], departure_start=time(0), departure_end=time(23, 59))
        data = [("direct-out", HOME, A, dt(10), dt(10, 10), 100), ("direct-back", A, HOME, dt(12, 17), dt(12, 18), 100),
                ("position-out", HOME, gateway, dt(10, 6), dt(10, 8), 10), ("gateway-out", gateway, A, dt(10), dt(10, 10), 50),
                ("gateway-back", A, arrival, dt(12, 17), dt(12, 18), 20), ("position-back", arrival, HOME, dt(12, 19), dt(12, 20), 5)]
        ms = [movement(id, a, b, dep, arr) for id, a, b, dep, arr, _ in data]
        result = optimize(spec, ms, [fare(id, cost) for id, _, _, _, _, cost in data], [])
        best = result["routes"][0]
        self.assertEqual(best["total_cost_myr"], 85)
        self.assertEqual(best["departure_gateway"], gateway.id)
        self.assertEqual(best["arrival_gateway"], arrival.id)

    def test_own_car_cannot_appear_after_flight_or_be_abandoned(self):
        spec = trip(modes=["flight", "car"], cars={"own_enabled": True})
        outbound = movement("out", HOME, A, dt(10), dt(10, 10))
        car = movement("car", A, HOME, dt(12, 17), dt(12, 18), "car", vehicle_kind="own", distance_km=100)
        self.assertFalse(optimize(spec, [outbound, car], [], [])["routes"])
        outbound = movement("drive", HOME, A, dt(10), dt(10, 10), "car", vehicle_kind="own", distance_km=100)
        flight = movement("back", A, HOME, dt(12, 17), dt(12, 18))
        self.assertFalse(optimize(spec, [outbound, flight], [], [])["routes"])
        self.assertTrue(optimize(spec, [outbound, car], [], [])["routes"])

    def test_rental_fees_capacity_and_explicit_dropoff(self):
        spec = trip(adults=5, modes=["car", "flight"], cars={"rental_enabled": True, "rental_capacity": 4, "rental_pickups": [HOME.id], "rental_dropoffs": [A.id], "rental_daily_myr": 100, "rental_one_way_myr": 30, "rental_pickup_myr": 10, "rental_cost_per_km": 1})
        ms = [movement("drive", HOME, A, dt(10), dt(10, 10), "car", vehicle_kind="rental", distance_km=100), movement("back", A, HOME, dt(12, 17), dt(12, 18))]
        route = optimize(spec, ms, [fare("back", 50)], [])["routes"][0]
        # Return the rental before flying, with three billable days and two cars.
        self.assertEqual(route["total_cost_myr"], 930)

    def test_dp_matches_brute_force_and_keeps_mixed_modes(self):
        spec = trip(visits=[Visit(place=A), Visit(place=B)])
        ms, offers = [], []
        for left, right in itertools.permutations([HOME, A, B], 2):
            for day in (10, 11, 12):
                for mode, duration, cost in (("flight", 1, 30), ("rail", 3, 10)):
                    id = f"{left.id}:{right.id}:{day}:{mode}"
                    ms.append(movement(id, left, right, dt(day), dt(day, 9)+timedelta(hours=duration), mode))
                    offers.append(fare(id, cost))
        expected = []
        for order in ((A, B), (B, A)):
            path = [HOME, *order, HOME]
            alternatives = [[m for m in ms if m.from_id == a.id and m.to_id == b.id] for a, b in zip(path, path[1:])]
            for selected in itertools.product(*alternatives):
                if selected[0].departure.date() != spec.start_date or selected[-1].arrival.date() != spec.end_date:
                    continue
                if any(a.arrival > b.departure for a, b in zip(selected, selected[1:])):
                    continue
                cost = sum(30 if m.mode == "flight" else 10 for m in selected)
                stay = sum((b.departure-a.arrival).total_seconds()/3600 for a, b in zip(selected, selected[1:]))
                expected.append((cost, stay))
        oracle = {x for x in expected if not any(y[0] <= x[0] and y[1] >= x[1] and y != x for y in expected)}
        result = optimize(spec, ms, offers, [])
        self.assertEqual({(r["total_cost_myr"], r["stay_hours"]) for r in result["routes"]}, oracle)
        self.assertTrue(any(len({m["mode"] for m in r["movements"]}) > 1 for r in result["routes"]))


class ProviderNormalizationTests(unittest.TestCase):
    def test_flight_provider_keeps_unknown_schedules_and_checks_complete_bundles(self):
        from app.planner_providers import fetch_flights
        leg = {"from_id": "KUL", "to_id": "SIN", "date": "2027-02-10", "from_code": "KUL", "to_code": "SIN", "from_airports": ["KUL"], "to_airports": ["SIN"], "timezone": "Asia/Kuala_Lumpur"}
        def segment(a, b, day, first, last):
            return SimpleNamespace(from_airport=SimpleNamespace(code=a, name=a), to_airport=SimpleNamespace(code=b, name=b),
                                   departure=SimpleNamespace(date=(2027, 2, day), time=(first, 0)), arrival=SimpleNamespace(date=(2027, 2, day), time=(last, 0)))
        outbound = segment("KUL", "SIN", 10, 9, 10)
        row = SimpleNamespace(price=None, flights=[outbound], airlines=["Example"])
        back = {**leg, "from_code": "SIN", "to_code": "KUL", "from_airports": ["SIN"], "to_airports": ["KUL"], "date": "2027-02-12"}
        with patch("app.planner_providers._install_price_tolerant_parser"), patch("fast_flights.get_flights", return_value=[row]):
            parsed = fetch_flights([leg], 1, "one-way", time(9), time(17))
            self.assertEqual(parsed["status"], "success")
            self.assertIsNone(parsed["options"][0]["price"])
            incomplete = fetch_flights([leg, back], 1, "round-trip", time(9), time(17))
            self.assertEqual(incomplete["status"], "requires_manual_quote")
            self.assertEqual(incomplete["options"], [])
        row = SimpleNamespace(price=900, flights=[outbound, segment("SIN", "KUL", 12, 16, 17)], airlines=["Example"])
        with patch("app.planner_providers._install_price_tolerant_parser"), patch("fast_flights.get_flights", return_value=[row]):
            parsed = fetch_flights([leg, back], 2, "round-trip", time(9), time(17))
            self.assertEqual(parsed["options"][0]["price"], 900)
            self.assertEqual(len(parsed["options"][0]["journeys"]), 2)

    def test_party_specific_quote_and_connector_country_rule(self):
        spec = trip(adults=2)
        m = movement("out", HOME, A, dt(10), dt(10, 10))
        self.assertIsNone(price_path([m], [fare("out", 100, adults=1)], spec, [])["total_cost_myr"])
        m.charges = [Charge(id="egress", kind="Airport egress", from_id="airport:SIN", to_id=A.id, country_code="SG", distance_km=10)]
        rule = PricingRule(id="taxi", name="Singapore airport taxi", mode="taxi", country_code="SG", low=3, kind="per-km", unit="vehicle")
        price = price_path([m], [fare("out", 100, adults=2)], spec, [rule])
        self.assertEqual(price["total_cost_myr"], 130)

    def test_flight_elapsed_includes_connection_and_airport_overhead(self):
        spec = trip()
        segments = [dict(mode="flight", from_id="KUL", to_id="BKK", from_name="KUL", to_name="BKK", departure=dt(10).isoformat(), arrival=dt(10, 11).isoformat()),
                    dict(mode="flight", from_id="BKK", to_id="SIN", from_name="BKK", to_name="SIN", departure=dt(10, 16).isoformat(), arrival=dt(10, 18).isoformat())]
        normalized = flight_movement(HOME, A, segments, spec, {})
        self.assertEqual(normalized.duration_minutes, 540+90+30+45+45)
        self.assertEqual(normalized.transfers, 1)
        self.assertEqual(len(normalized.charges), 2)

    def test_bus_mode_operator_source_and_fare_are_preserved(self):
        spec = trip(modes=["bus"])
        payload = {"itineraries": [{"startTime": dt(10).isoformat(), "endTime": dt(10, 11).isoformat(), "legs": [{"mode": "BUS", "startTime": dt(10).isoformat(), "endTime": dt(10, 11).isoformat(), "from": {"name": "A"}, "to": {"name": "B"}, "agencyName": "Rapid KL", "source": "my_bus-kl.gtfs.zip", "displayName": "770"}], "fareTransfers": [{"rule": "A_AB_B", "effectiveFareLegProducts": [[[{'amount': 2, 'currency': 'MYR'}]]]}]}]}
        movements, offers = transit_movements(payload, HOME, A, spec, "2027-02-10")
        self.assertEqual(movements[0].mode, "bus")
        self.assertEqual(movements[0].segments[0].operator, "Rapid KL")
        self.assertEqual(movements[0].segments[0].source, "my_bus-kl.gtfs.zip")
        self.assertEqual(offers[0].low, 2)


class PersistenceAndJobsTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.db = PlannerStore(Path(self.temp.name)/"planner.sqlite3")

    async def test_restart_preserves_rules_edits_and_recovers_jobs(self):
        record = self.db.new_trip(trip().model_dump(mode="json"))
        self.db.put("rules", "rule", {"id": "rule", "name": "Persistent"})
        self.db.put("jobs", "job", {"id": "job", "trip_id": record["id"], "status": "running", "cursor": 7})
        other = PlannerStore(self.db.path)
        other.recover()
        self.assertEqual(other.get("trips", record["id"])["spec"]["name"], "My trip")
        self.assertEqual(other.get("rules", "rule")["name"], "Persistent")
        self.assertEqual(other.get("jobs", "job")["status"], "interrupted")
        self.assertEqual(other.get("jobs", "job")["cursor"], 7)

    async def test_timing_and_driving_prices_reuse_discovered_graph(self):
        spec = trip(modes=["car"], cars={"own_enabled": True})
        record = self.db.new_trip(spec.model_dump(mode="json"))
        road = {"home->a": {"distance_km": 100, "duration_minutes": 60}, "a->home": {"distance_km": 100, "duration_minutes": 60}}
        snapshot = {"revision": 1, "discovery_key": spec.discovery_key(), "movements": [], "offers": [], "roads": road, "coverage": {}}
        record["snapshot"] = snapshot
        self.db.put("trips", record["id"], record)
        manager = DiscoveryManager(self.db)
        first = await manager.recalculate(record["id"])
        self.assertFalse(first["discovery_required"])
        self.assertEqual(first["routes"][0]["total_cost_myr"], 54)
        spec.cars.own_cost_per_km = .5
        self.assertEqual(spec.discovery_key(), snapshot["discovery_key"])
        self.db.update("trips", record["id"], lambda r: {**r, "spec": spec.model_dump(mode="json"), "revision": r["revision"]+1})
        second = await manager.recalculate(record["id"])
        self.assertEqual(second["routes"][0]["total_cost_myr"], 100)

    async def test_cached_queries_do_not_spend_request_budget(self):
        manager = DiscoveryManager(self.db)
        spec = trip(modes=["rail"])
        task = {"kind": "transit", "key": "test", "from_id": HOME.id, "to_id": A.id, "date": "2027-02-10"}
        async def fake(path, params, **kwargs):
            kwargs["on_request"]()
            return {"itineraries": []}
        with patch("app.planner_discovery.transitous.contact_url", "https://example.test"), patch("app.planner_discovery.transitous._get_json", side_effect=fake):
            _, requested = await manager.fetch(task, spec, {})
            self.assertTrue(requested)
            _, requested = await manager.fetch(task, spec, {})
            self.assertFalse(requested)

    async def test_budget_resume_cache_and_cancellation(self):
        class Fake(DiscoveryManager):
            async def fetch(self, task, spec, snapshot):
                await asyncio.sleep(.001)
                return {"status": "empty"}, True
        manager = Fake(self.db)
        record = self.db.new_trip(trip(modes=["rail"]).model_dump(mode="json"))
        with patch("app.planner_discovery.transitous.contact_url", "https://example.test"):
            job = manager.start(record["id"], 2)
        await manager.running[job["id"]]
        paused = self.db.get("jobs", job["id"])
        self.assertEqual(paused["status"], "paused")
        self.assertEqual(paused["requests"], 2)
        manager.start(record["id"], 1, job["id"])
        await manager.running[job["id"]]
        self.assertEqual(self.db.get("jobs", job["id"])["requests"], 3)
        manager.start(record["id"], 100, job["id"])
        manager.cancel(job["id"])
        await manager.running[job["id"]]
        self.assertEqual(self.db.get("jobs", job["id"])["status"], "cancelled")

    async def test_v2_api_revision_and_fare_reoptimization(self):
        import app.planner_api as endpoints
        from app.main import app
        manager = DiscoveryManager(self.db)
        with patch.object(endpoints, "store", self.db), patch.object(endpoints, "manager", manager):
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
                response = await client.post("/api/v2/trips", json=trip().model_dump(mode="json"))
                self.assertEqual(response.status_code, 201, response.text)
                record = response.json()
                id = record["id"]
                stale = await client.put(f"/api/v2/trips/{id}", json={"spec": record["spec"], "expected_revision": 0})
                self.assertEqual(stale.status_code, 409)
                for m in [movement("out", HOME, A, dt(10), dt(10, 10)), movement("back", A, HOME, dt(12, 17), dt(12, 18))]:
                    response = await client.post(f"/api/v2/trips/{id}/movements", json=m.model_dump(mode="json"))
                    self.assertEqual(response.status_code, 201, response.text)
                for key in ("out", "back"):
                    offer = FareOffer(id="user:"+key, movement_ids=[key], low=10, high=10, source="user")
                    response = await client.put(f"/api/v2/trips/{id}/fares/{offer.id}", json=offer.model_dump(mode="json"))
                    self.assertEqual(response.status_code, 200, response.text)
                self.assertEqual(response.json()["routes"][0]["total_cost_myr"], 20)
                reopened = (await client.get(f"/api/v2/trips/{id}")).json()
                self.assertEqual(len(reopened["offers"]), 2)
                self.assertEqual(reopened["result"]["trip_revision"], reopened["revision"])


if __name__ == "__main__":
    unittest.main()
