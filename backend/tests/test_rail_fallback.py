from __future__ import annotations

import asyncio
import copy
import tempfile
import unittest
from datetime import date, datetime, time, timedelta, timezone
from pathlib import Path
from unittest.mock import patch
from zoneinfo import ZoneInfo

from app.planner_discovery import DiscoveryManager, transit_movements
from app.planner_models import FareOffer, Place, TripSpec, Visit
from app.planner_optimizer import optimize
from app.planner_rail import RAIL_FALLBACK_SOURCE, fallback_task, prepare_rail_payload
from app.planner_store import PlannerStore

UTC = timezone.utc
HOME = Place(id="home", name="Home", latitude=30, longitude=104, timezone="Asia/Shanghai")
CITY = Place(id="city", name="City", latitude=29, longitude=106, timezone="Asia/Shanghai")


def spec(**overrides):
    return TripSpec(home=HOME, visits=[Visit(place=CITY)], start_date=date(2027, 3, 10),
                    end_date=date(2027, 3, 11), modes=["rail"], departure_start=time(0), departure_end=time(23, 59),
                    rail_fallback={"enabled": True, "reference_date": "2026-10-19"}, **overrides)


def task(**overrides):
    return {"kind": "transit", "key": "exact", "from_id": "home", "to_id": "city", "date": "2027-03-10", **overrides}


def payload(day="2026-10-21", hour=10, zone="Asia/Shanghai"):
    start = datetime.fromisoformat(day).replace(hour=hour, tzinfo=ZoneInfo(zone))
    def stamp(minutes):
        return (start+timedelta(minutes=minutes)).isoformat()
    legs = []
    for mode, a, b, first, last in [("WALK", "Home", "Origin station", -20, 0),
                                    ("HIGHSPEED_RAIL", "Origin station", "Destination station", 0, 120),
                                    ("WALK", "Destination station", "City", 120, 150)]:
        legs.append({"mode": mode, "from": {"name": a}, "to": {"name": b},
                     "startTime": stamp(first), "endTime": stamp(last),
                     "scheduledStartTime": stamp(first), "scheduledEndTime": stamp(last), "displayName": "G123"})
    return {"itineraries": [{"startTime": stamp(-20), "endTime": stamp(150), "legs": legs,
                              "fareTransfers": [{"transferProducts": [{"amount": 99}]}]}]}


class RailFallbackTests(unittest.TestCase):
    def test_probes_are_bounded_same_weekday_and_opt_in(self):
        config = spec()
        original = task()
        probe = fallback_task(original, config, date(2026, 10, 19))
        self.assertNotIn("rail_reference_date", probe)
        dates = []
        for _ in range(4):
            probe = fallback_task(probe, config, date(2026, 10, 19))
            if probe is None:
                break
            dates.append(date.fromisoformat(probe["rail_reference_date"]))
        self.assertEqual(len(dates), 3)
        self.assertTrue(all(d.weekday() == config.start_date.weekday() for d in dates))
        self.assertEqual(dates, sorted(dates, reverse=True))
        config.rail_fallback.enabled = False
        self.assertIsNone(fallback_task(original, config, date(2026, 10, 19)))
        config.rail_fallback.enabled = True
        self.assertIsNone(fallback_task(task(cursor="page"), config, date(2026, 10, 19)))
        config.modes = ["bus"]
        self.assertIsNone(fallback_task(original, config, date(2026, 10, 19)))

    def test_near_dates_and_excessive_shifts_do_not_copy_timetables(self):
        config = spec()
        for today in [date(2027, 3, 1), date(2027, 3, 12)]:
            radius = fallback_task(task(), config, today)
            self.assertEqual(radius["rail_reference_dates"], [])
            self.assertIsNone(fallback_task(radius, config, today))
        config.rail_fallback.max_shift_days = 7
        self.assertEqual(fallback_task(task(), config, date(2026, 10, 19))["rail_reference_dates"], [])

    def test_shift_keeps_access_overnight_duration_and_drops_historical_fares(self):
        original = payload(hour=23)
        untouched = copy.deepcopy(original)
        probe = task(rail_radius=True, rail_reference_date="2026-10-21")
        prepared = prepare_rail_payload(original, probe, HOME)
        moves, offers = transit_movements(prepared, HOME, CITY, spec(), probe["date"])
        self.assertEqual(original, untouched)
        self.assertEqual(len(moves), 1)
        self.assertEqual(offers, [])
        self.assertEqual(moves[0].departure.astimezone(ZoneInfo(HOME.timezone)).isoformat(), "2027-03-10T22:25:00+08:00")
        self.assertEqual(moves[0].arrival.astimezone(ZoneInfo(CITY.timezone)).date(), date(2027, 3, 11))
        self.assertEqual(moves[0].duration_minutes, 195)
        self.assertNotIn("fareTransfers", prepared["itineraries"][0])

    def test_scheduled_times_replace_realtime_delays(self):
        original = payload()
        for leg in original["itineraries"][0]["legs"]:
            leg["startTime"] = (datetime.fromisoformat(leg["startTime"])+timedelta(hours=1)).isoformat()
            leg["endTime"] = (datetime.fromisoformat(leg["endTime"])+timedelta(hours=1)).isoformat()
        prepared = prepare_rail_payload(original, task(rail_radius=True, rail_reference_date="2026-10-21"), HOME)
        self.assertEqual(datetime.fromisoformat(prepared["itineraries"][0]["legs"][1]["startTime"]).hour, 2)

    def test_dst_shift_preserves_origin_wall_time_and_elapsed_duration(self):
        london = HOME.model_copy(update={"timezone": "Europe/London"})
        probe = task(date="2027-03-31", rail_radius=True, rail_reference_date="2026-10-21")
        prepared = prepare_rail_payload(payload(zone="Europe/London"), probe, london)
        ride = prepared["itineraries"][0]["legs"][1]
        dep, arr = datetime.fromisoformat(ride["startTime"]), datetime.fromisoformat(ride["endTime"])
        self.assertEqual(dep.astimezone(ZoneInfo("Europe/London")).hour, 10)
        self.assertEqual((arr-dep).total_seconds(), 7200)
        # A source Sunday shifted to the DST gap must not fabricate a wall time.
        gap = task(date="2027-03-28", rail_radius=True, rail_reference_date="2026-10-18")
        self.assertEqual(prepare_rail_payload(payload("2026-10-18", 1, "Europe/London"), gap, london)["itineraries"], [])

    def test_invalid_or_free_station_access_is_rejected(self):
        original = payload()
        access = original["itineraries"][0]["legs"][0]
        access["scheduledStartTime"] = access["scheduledEndTime"]
        access["from"].update(lat=30, lon=104)
        access["to"].update(lat=31, lon=104)
        probe = task(rail_radius=True, rail_reference_date="2026-10-21")
        self.assertEqual(prepare_rail_payload(original, probe, HOME)["itineraries"], [])
        self.assertEqual(prepare_rail_payload({"itineraries": [{"legs": []}]}, probe, HOME)["itineraries"], [])

    def test_provider_calendar_extension_is_marked_without_local_opt_in(self):
        original = payload("2027-03-10")
        original["itineraries"][0]["legs"][1]["loopedCalendarSince"] = "2027-01-06T00:00:00Z"
        moves, offers = transit_movements(original, HOME, CITY, spec(), "2027-03-10")
        self.assertTrue(moves[0].schedule_estimated)
        self.assertTrue(moves[0].segments[1].assumed)
        self.assertIn("provider repeated", moves[0].assumptions[0])
        self.assertEqual(offers, [])

    def test_discovery_key_separates_settings_but_preserves_disabled_defaults(self):
        enabled = spec()
        disabled = spec()
        disabled.rail_fallback.enabled = False
        self.assertNotEqual(enabled.discovery_key(), disabled.discovery_key())
        before = disabled.discovery_key()
        disabled.rail_fallback.station_radius_km = 10
        self.assertEqual(before, disabled.discovery_key())
        before = enabled.discovery_key()
        enabled.rail_fallback.reference_date = date(2026, 11, 1)
        self.assertNotEqual(before, enabled.discovery_key())


class RailDiscoveryTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db = PlannerStore(Path(self.tmp.name)/"planner.sqlite3")
        self.manager = DiscoveryManager(self.db)

    async def asyncTearDown(self):
        self.tmp.cleanup()

    def snapshot(self):
        return {"revision": 0, "movements": [], "offers": [], "coverage": {}}

    async def test_ingestion_labels_and_actual_date_replaces_estimates(self):
        graph = self.snapshot()
        probe = task(rail_radius=True, rail_reference_date="2026-10-21")
        moves = self.manager.ingest(probe, {"payload": payload()}, spec(), graph)
        self.assertTrue(moves[0].schedule_estimated)
        self.assertEqual(moves[0].schedule_reference_date, date(2026, 10, 21))
        self.assertTrue(all(s.assumed for s in moves[0].segments))
        self.assertEqual(moves[0].source, RAIL_FALLBACK_SOURCE)
        self.assertFalse(graph["offers"])
        self.manager.ingest(task(), {"payload": payload("2027-03-10", hour=11)}, spec(), graph)
        self.assertEqual(len(graph["movements"]), 1)
        self.assertFalse(graph["movements"][0]["schedule_estimated"])
        # Late fallback pages cannot reintroduce estimates once actual service exists.
        self.assertEqual(self.manager.ingest(probe, {"payload": payload()}, spec(), graph), [])

    async def test_reference_cache_is_shared_between_target_weeks_and_isolated_from_exact(self):
        calls = []
        async def fake(path, params, **kwargs):
            calls.append(params)
            kwargs["on_request"]()
            return payload()
        probe = task(rail_radius=True, rail_reference_date="2026-10-21", rail_reference_dates=["2026-10-21"])
        with patch("app.planner_discovery.transitous.contact_url", "https://example.test"), patch("app.planner_discovery.transitous._get_json", side_effect=fake):
            _, requested = await self.manager.fetch(probe, spec(), {})
            self.assertTrue(requested)
            _, requested = await self.manager.fetch({**probe, "date": "2027-03-17", "key": "next-week"}, spec(), {})
            self.assertFalse(requested)
            await self.manager.fetch(task(), spec(), {})
        self.assertEqual(len(calls), 2)
        self.assertEqual(calls[0]["time"][:10], "2026-10-21")
        self.assertEqual(float(calls[0]["radius"]), 25000)
        self.assertNotIn("radius", calls[1])

    async def test_each_probe_uses_budget_and_survives_resume(self):
        class Fake(DiscoveryManager):
            async def fetch(self, query, config, graph):
                return {"status": "empty", "payload": {"itineraries": []}}, True
        manager = Fake(self.db)
        record = self.db.new_trip(spec().model_dump(mode="json"))
        with patch("app.planner_discovery.tasks_for", return_value=[task()]), patch("app.planner_discovery.transitous.contact_url", "https://example.test"):
            job = manager.start(record["id"], 1)
            await manager.running[job["id"]]
        saved = self.db.get("jobs", job["id"])
        self.assertEqual(saved["status"], "paused")
        self.assertEqual(saved["requests"], 1)
        self.assertTrue(saved["queue"][1]["rail_radius"])
        manager.start(record["id"], 1, job["id"])
        await manager.running[job["id"]]
        saved = self.db.get("jobs", job["id"])
        self.assertEqual(saved["requests"], 2)
        self.assertIn("rail_reference_date", saved["queue"][2])
        manager.start(record["id"], 10, job["id"])
        await manager.running[job["id"]]
        saved = self.db.get("jobs", job["id"])
        self.assertEqual(saved["status"], "complete")
        self.assertEqual(saved["requests"], 5)
        self.assertEqual(len(saved["queue"]), 5)

    async def test_successful_actual_date_does_not_probe_and_settings_survive_restart(self):
        class Fake(DiscoveryManager):
            async def fetch(self, query, config, graph):
                return {"status": "success", "payload": payload(query["date"])}, True
        manager = Fake(self.db)
        record = self.db.new_trip(spec().model_dump(mode="json"))
        with patch("app.planner_discovery.tasks_for", return_value=[task()]), patch("app.planner_discovery.transitous.contact_url", "https://example.test"):
            job = manager.start(record["id"], 10)
            await manager.running[job["id"]]
        saved = self.db.get("jobs", job["id"])
        self.assertEqual(saved["requests"], 1)
        self.assertEqual(len(saved["queue"]), 1)
        reopened = PlannerStore(self.db.path).get("trips", record["id"])
        self.assertEqual(TripSpec.model_validate(reopened["spec"]).rail_fallback, spec().rail_fallback)

    async def test_cancellation_preserves_pending_fallback_without_extra_requests(self):
        class Fake(DiscoveryManager):
            async def fetch(self, query, config, graph):
                return {"status": "empty", "payload": {"itineraries": []}}, True
        manager = Fake(self.db)
        record = self.db.new_trip(spec().model_dump(mode="json"))
        with patch("app.planner_discovery.tasks_for", return_value=[task()]), patch("app.planner_discovery.transitous.contact_url", "https://example.test"):
            job = manager.start(record["id"], 1)
            await manager.running[job["id"]]
        manager.start(record["id"], 10, job["id"])
        manager.cancel(job["id"])
        await manager.running[job["id"]]
        saved = self.db.get("jobs", job["id"])
        self.assertEqual(saved["status"], "cancelled")
        self.assertEqual(saved["requests"], 1)
        self.assertTrue(saved["queue"][saved["cursor"]]["rail_radius"])

    async def test_reference_pagination_uses_reference_day_and_keeps_target_day(self):
        class Fake(DiscoveryManager):
            async def fetch(self, query, config, graph):
                if query.get("cursor"):
                    return {"status": "empty", "payload": {"itineraries": []}}, True
                data = payload()
                data["nextPageCursor"] = "next-reference-page"
                return {"status": "success", "payload": data}, True
        manager = Fake(self.db)
        record = self.db.new_trip(spec().model_dump(mode="json"))
        probe = task(rail_radius=True, rail_reference_date="2026-10-21")
        with patch("app.planner_discovery.tasks_for", return_value=[probe]), patch("app.planner_discovery.transitous.contact_url", "https://example.test"):
            job = manager.start(record["id"], 1)
            await manager.running[job["id"]]
        saved = self.db.get("jobs", job["id"])
        self.assertEqual(len(saved["queue"]), 2)
        page = saved["queue"][1]
        self.assertEqual(page["date"], "2027-03-10")
        self.assertEqual(page["rail_reference_date"], "2026-10-21")
        self.assertEqual(page["cursor"], "next-reference-page")
        self.assertTrue(saved["snapshot"]["movements"][0]["schedule_estimated"])

    async def test_failed_provider_does_not_trigger_sampling(self):
        class Fake(DiscoveryManager):
            async def fetch(self, query, config, graph):
                return {"status": "failed", "message": "network error"}, True
        manager = Fake(self.db)
        record = self.db.new_trip(spec().model_dump(mode="json"))
        with patch("app.planner_discovery.tasks_for", return_value=[task()]), patch("app.planner_discovery.transitous.contact_url", "https://example.test"):
            job = manager.start(record["id"], 10)
            await manager.running[job["id"]]
        self.assertEqual(self.db.get("jobs", job["id"])["requests"], 1)

    async def test_priced_estimated_timetable_remains_flagged_and_can_be_disabled(self):
        graph = self.snapshot()
        config = spec()
        for query, data in [(task(rail_radius=True, rail_reference_date="2026-10-21"), payload()),
                            (task(from_id="city", to_id="home", date="2027-03-11", rail_radius=True, rail_reference_date="2026-10-22"), payload("2026-10-22"))]:
            self.manager.ingest(query, {"payload": data}, config, graph)
        from app.planner_models import Movement
        moves = [Movement.model_validate(m) for m in graph["movements"]]
        offers = [FareOffer(id="fare:"+m.id, movement_ids=[m.id], low=10, high=10, source="user") for m in moves]
        result = optimize(config, moves, offers, [])
        self.assertTrue(result["routes"])
        self.assertTrue(all(r["estimated"] and r["schedule_estimated"] for r in result["routes"]))
        self.assertTrue(all(r["total_cost_myr"] == 20 for r in result["routes"]))
        record = self.db.new_trip(config.model_dump(mode="json"))
        config.rail_fallback.enabled = False
        self.db.update("trips", record["id"], lambda r: {**r, "spec": config.model_dump(mode="json"), "snapshot": graph})
        result = await self.manager.recalculate(record["id"])
        self.assertEqual(result["routes"], [])
        self.assertEqual(self.db.get("trips", record["id"])["snapshot"]["movements"], [])


if __name__ == "__main__":
    unittest.main()
