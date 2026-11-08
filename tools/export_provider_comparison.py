"""Capture public provider normalization cases from the executable Python tests."""
import copy
from datetime import datetime, timezone
import importlib
import io
import json
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT / "backend"), str(ROOT / "backend/tests")]
from app import planner_discovery as discovery, planner_journeys as journeys, planner_rail as rail, planner_windows as windows


def main():
    cases = []
    owners = {"flight_movement": journeys, "transit_movements": journeys, "transit_fare": journeys,
              "prepare_rail_payload": rail, "fallback_task": rail, "tasks_for": discovery,
              "rough_date_windows": windows, "seed_dates": windows, "shareable_snapshot": discovery}
    originals = {name: getattr(discovery, name) for name in owners}
    depth = 0
    original_ingest = discovery.DiscoveryManager.ingest

    def capture_ingest(manager, task, outcome, spec, snapshot):
        # Make the reference clock explicit without modifying the caller's
        # outcome; provider data already carrying a retrieval time keeps it.
        now = datetime.now(timezone.utc)
        fixed = {**copy.deepcopy(outcome), "retrieved_at": outcome.get("retrieved_at", now.isoformat())}
        data = dict(task=copy.deepcopy(task), outcome=copy.deepcopy(fixed), spec=spec.model_dump(mode="json"),
                    snapshot=copy.deepcopy(snapshot), now=int(now.timestamp()*1e6), transit_ttl=discovery.transitous.route_ttl)
        result = original_ingest(manager, task, fixed, spec, snapshot)
        cases.append(dict(name=f"ingest-{len(cases)+1}", operation="ingest", input=data,
                          expected=dict(snapshot=copy.deepcopy(snapshot), collected=[m.model_dump(mode="json") for m in result])))
        return result

    def capture(name):
        def call(*args, **kwargs):
            nonlocal depth
            outer = depth == 0
            depth += 1
            try:
                result = originals[name](*args, **kwargs)
            finally:
                depth -= 1
            if not outer and name != "transit_fare":
                return result
            if name == "flight_movement":
                origin, dest, segments, spec, roads, *tail = args
                connections = tail[0] if tail else kwargs.get("airport_connections") or {}
                data = dict(origin=origin.model_dump(mode="json"), dest=dest.model_dump(mode="json"), segments=segments,
                            spec=spec.model_dump(mode="json"), roads=roads, connections=[c.model_dump(mode="json") for c in connections.values()])
                expected = result.model_dump(mode="json")
            elif name == "transit_movements":
                payload, origin, dest, spec, day = args
                data = dict(payload=payload, origin=origin.model_dump(mode="json"), dest=dest.model_dump(mode="json"), spec=spec.model_dump(mode="json"), day=day)
                expected = dict(movements=[m.model_dump(mode="json") for m in result[0]], offers=[o.model_dump(mode="json") for o in result[1]])
            elif name == "transit_fare":
                data = dict(itinerary=args[0], adults=args[1])
                expected = result
            elif name == "prepare_rail_payload":
                data = dict(payload=args[0], task=args[1], origin=args[2].model_dump(mode="json"))
                expected = result
            elif name == "fallback_task":
                data = dict(task=args[0], spec=args[1].model_dump(mode="json"), today=args[2].isoformat())
                expected = result
            elif name == "tasks_for":
                data = dict(spec=args[0].model_dump(mode="json"), transit_enabled=bool(discovery.transitous.contact_url),
                            metros={code: list(row.get("airports", {})) for code, row in discovery.iata_metros().items()})
                expected = result
            elif name == "rough_date_windows":
                data = dict(spec=args[0].model_dump(mode="json"))
                expected = [[list(key), [a.isoformat(), b.isoformat()]] for key, (a, b) in result.items()]
            elif name == "shareable_snapshot":
                data = dict(snapshot=args[0], spec=args[1].model_dump(mode="json"))
                expected = result
            else:
                data = dict(spec=args[0].model_dump(mode="json"))
                expected = [day.isoformat() for day in result]
            cases.append(copy.deepcopy(dict(name=f"{name}-{len(cases)+1}", operation=name, input=data, expected=expected)))
            return result
        return call

    for name in originals:
        setattr(discovery, name, capture(name))
        setattr(owners[name], name, getattr(discovery, name))
    discovery.DiscoveryManager.ingest = capture_ingest
    try:
        modules = [importlib.import_module(name) for name in ("test_planner", "test_positioning", "test_airport_transfers", "test_rail_fallback", "test_apply_changes")]
        suite = unittest.TestSuite(unittest.defaultTestLoader.loadTestsFromModule(module) for module in modules)
        output = io.StringIO()
        result = unittest.TextTestRunner(stream=output).run(suite)
        if not result.wasSuccessful():
            raise RuntimeError(output.getvalue())
    finally:
        discovery.DiscoveryManager.ingest = original_ingest
        for name, original in originals.items():
            setattr(discovery, name, original)
            setattr(owners[name], name, original)
    # Explicit ticket and rail replacement transitions supplement the cases
    # reached by the existing workflow tests. No provider requests are made.
    from test_airport_transfers import AirportTransferTests
    from app.planner_models import Segment
    sample = AirportTransferTests()
    sample.setUp()
    back = Segment(mode="flight", from_id="ICN", to_id="KUL", from_name="ICN", to_name="KUL",
                   departure="2027-02-12T10:00:00Z", arrival="2027-02-12T16:00:00Z")
    for kind in ("one-way", "round-trip", "multi-city"):
        for value in (None, 0, 100):
            for adults in (1, 3):
                spec = sample.spec.model_copy(deep=True)
                spec.adults = adults
                legs = [discovery.make_leg(sample.home, sample.city, "2027-02-10")]
                ticket_journeys = [[sample.segment.model_dump(mode="json")]]
                if kind != "one-way":
                    legs.append(discovery.make_leg(sample.city, sample.home, "2027-02-12"))
                    ticket_journeys.append([back.model_dump(mode="json")])
                if kind == "multi-city":
                    legs[1] = discovery.make_leg(sample.city, sample.home, "2027-02-11")
                    ticket_journeys[1] = [Segment.model_validate({**back.model_dump(mode="json"), "departure": "2027-02-11T10:00:00Z", "arrival": "2027-02-11T16:00:00Z"}).model_dump(mode="json")]
                    legs.append(discovery.make_leg(sample.home, sample.city, "2027-02-12"))
                    ticket_journeys.append([Segment.model_validate({**sample.segment.model_dump(mode="json"), "departure": "2027-02-12T10:00:00Z", "arrival": "2027-02-12T16:00:00Z"}).model_dump(mode="json")])
                task = dict(key="ticket", kind="flight", from_id=sample.home.id, to_id=sample.city.id, date="2027-02-10") if kind == "one-way" else dict(key="ticket", kind="bundle", ticket_kind=kind, legs=legs)
                capture_ingest(discovery.DiscoveryManager(None), task, dict(status="success", options=[dict(price=value, journeys=ticket_journeys)], search_url="https://example.test/flights"), spec,
                               dict(revision=1, movements=[], offers=[], coverage={}, roads=sample.roads))
    from test_rail_fallback import spec as rail_spec, task as rail_task, payload as rail_payload
    rail_settings = rail_spec()
    rail_settings.rail_fallback.station_radius_km = 25.53125
    graph = dict(revision=0, movements=[], offers=[], coverage={})
    for task, payload in [(rail_task(rail_radius=True, rail_reference_date="2026-10-21"), rail_payload()),
                          (rail_task(), rail_payload("2027-03-10", hour=11)),
                          (rail_task(rail_radius=True, rail_reference_date="2026-10-21"), rail_payload())]:
        capture_ingest(discovery.DiscoveryManager(None), task, dict(status="success", payload=payload), rail_settings, graph)
    # A short response may contribute schedules but never a partial whole-ticket fare.
    task = dict(kind="bundle", key="partial", ticket_kind="round-trip", legs=[discovery.make_leg(sample.home, sample.city, "2027-02-10"), discovery.make_leg(sample.city, sample.home, "2027-02-12")])
    capture_ingest(discovery.DiscoveryManager(None), task, dict(status="success", options=[dict(price=100, journeys=[[sample.segment.model_dump(mode="json")]])]), sample.spec,
                   dict(revision=0, movements=[], offers=[], coverage={}))
    # Additional public GTFS cases exercise incomplete/ambiguous fares and
    # rule selection independently of the small set of recorded itineraries.
    fare_cases = [None, [], [{"amount": 0, "currency": "MYR"}], [{"amount": 2.675, "currency": "MYR"}],
                  [{"amount": 1.005, "currency": "MYR"}], [{"amount": "2", "currency": "MYR"}],
                  [{"amount": 3}], [{"currency": "MYR"}], [{"amount": 2, "currency": "MYR", "riderCategory": {"name": "Child"}}],
                  [{"amount": 2, "currency": "MYR", "riderCategory": {"name": "Adult"}}],
                  [{"amount": 2, "currency": "MYR", "riderCategory": {"isDefaultFareCategory": True}}],
                  [{"amount": 2, "currency": "MYR"}, {"amount": 3, "currency": "SGD"}]]
    for rule in ("A_AB_B", "A_AB", "AB"):
        for products in fare_cases:
            for adults in (1, 3):
                itinerary = {"fareTransfers": [{"rule": rule, "effectiveFareLegProducts": [[products]],
                                                "transferProducts": [{"amount": .5, "currency": "MYR"}]}]}
                cases.append(dict(name=f"gtfs-{len(cases)+1}", operation="transit_fare", input=dict(itinerary=itinerary, adults=adults),
                                  expected=originals["transit_fare"](itinerary, adults)))
    from datetime import date, timedelta
    from app.planner_models import Place, TripSpec, Visit
    from unittest.mock import patch
    home = Place(id="home", name="Home", latitude=3, longitude=101, timezone="Asia/Kuala_Lumpur", airport_codes=["KUL"], flight_code="KUL")
    cities = [Place(id=f"city-{i}", name=f"City {i}", latitude=10+i, longitude=100+i, timezone=zone, airport_codes=[airport], flight_code=airport)
              for i, (zone, airport) in enumerate(zip(["Asia/Bangkok", "Europe/London", "America/New_York", "Asia/Seoul"], ["BKK", "LHR", "JFK", "ICN"]))]
    for index in range(24):
        spec = TripSpec(home=home, visits=[Visit(place=p, min_stay_hours=2.25*(j+1)) for j, p in enumerate(cities[:1+index%4])],
                        start_date=date(2027, 3, 26), end_date=date(2027, 3, 26)+timedelta(days=2+index%4),
                        ordered_visits=index%2 == 0, date_mode="flexible" if index%3 == 0 else "fixed",
                        home_departure_earliest="13:00" if index%2 else None,
                        home_arrival_latest="18:00" if index%3 else None,
                        cars={"own_enabled": index%5 == 0})
        for name in ("seed_dates", "rough_date_windows", "tasks_for"):
            data = dict(spec=spec.model_dump(mode="json"))
            if name == "tasks_for":
                enabled = index%2 == 0
                data["transit_enabled"] = enabled
                with patch.object(discovery.transitous, "contact_url", "https://example.test" if enabled else ""):
                    expected = originals[name](spec)
            else:
                expected = originals[name](spec)
                expected = [d.isoformat() for d in expected] if name == "seed_dates" else [[list(key), [a.isoformat(), b.isoformat()]] for key, (a, b) in expected.items()]
            cases.append(dict(name=f"discovery-{name}-{index}", operation=name, input=data, expected=expected))
    path = ROOT / "frontend/tests/fixtures/native-providers.json"
    path.parent.mkdir(exist_ok=True)
    metros = {code: list(row.get("airports", {})) for code, row in discovery.iata_metros().items()}
    path.write_text(json.dumps(dict(cases=cases, metros=metros), separators=(",", ":"), allow_nan=False), encoding="utf-8")
    counts = {name: sum(c["operation"] == name for c in cases) for name in [*originals, "ingest"]}
    print(json.dumps(dict(cases=len(cases), operations=counts, tests=result.testsRun)))


if __name__ == "__main__":
    main()
