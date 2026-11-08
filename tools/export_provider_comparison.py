"""Capture public provider normalization cases from the executable Python tests."""
import copy
import importlib
import io
import json
from pathlib import Path
import sys
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT / "backend"), str(ROOT / "backend/tests")]
from app import planner_discovery as discovery, planner_journeys as journeys, planner_rail as rail


def main():
    cases = []
    originals = {name: getattr(discovery, name) for name in ("flight_movement", "transit_movements", "transit_fare", "prepare_rail_payload", "fallback_task")}
    depth = 0

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
            else:
                data = dict(task=args[0], spec=args[1].model_dump(mode="json"), today=args[2].isoformat())
                expected = result
            cases.append(copy.deepcopy(dict(name=f"{name}-{len(cases)+1}", operation=name, input=data, expected=expected)))
            return result
        return call

    for name in originals:
        setattr(discovery, name, capture(name))
        setattr(journeys if name in {"flight_movement", "transit_movements", "transit_fare"} else rail, name, getattr(discovery, name))
    try:
        modules = [importlib.import_module(name) for name in ("test_planner", "test_positioning", "test_airport_transfers", "test_rail_fallback", "test_apply_changes")]
        suite = unittest.TestSuite(unittest.defaultTestLoader.loadTestsFromModule(module) for module in modules)
        output = io.StringIO()
        result = unittest.TextTestRunner(stream=output).run(suite)
        if not result.wasSuccessful():
            raise RuntimeError(output.getvalue())
    finally:
        for name, original in originals.items():
            setattr(discovery, name, original)
            setattr(journeys if name in {"flight_movement", "transit_movements", "transit_fare"} else rail, name, original)
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
    path = ROOT / "frontend/tests/fixtures/native-providers.json"
    path.parent.mkdir(exist_ok=True)
    path.write_text(json.dumps(dict(cases=cases), separators=(",", ":"), allow_nan=False), encoding="utf-8")
    counts = {name: sum(c["operation"] == name for c in cases) for name in originals}
    print(json.dumps(dict(cases=len(cases), operations=counts, tests=result.testsRun)))


if __name__ == "__main__":
    main()
