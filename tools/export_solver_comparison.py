"""Export Python solver calls and expected responses for native-TS comparison.

Public fixtures come from existing tests. Optional saved-trip input is read-only
and is written only below ignored data/diagnostics, never to public assets.
"""
import argparse
import asyncio
import copy
import importlib
import io
import json
import math
import random
from pathlib import Path
import sqlite3
import sys
import time
import unittest

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT / "backend"), str(ROOT / "backend/tests")]
from app import planner_optimizer as optimizer
from app.planner_results import expand_trip
from app.planner_models import SolverInput


def normalized(args, kwargs):
    spec, movements, offers, rules, *rest = args
    positional = dict(zip(("snapshot_revision", "trip_revision", "cancelled", "label_limit", "finish_at_home", "include_dominated"), rest))
    options = {**positional, **kwargs}
    data = {"spec": spec.model_dump(mode="json"), "movements": [m.model_dump(mode="json") for m in movements],
            "offers": [o.model_dump(mode="json") for o in offers], "rules": [r.model_dump(mode="json") for r in rules],
            **{key: options[key] for key in ("snapshot_revision", "trip_revision", "label_limit", "finish_at_home", "include_dominated", "expansion_budget") if key in options}}
    return SolverInput.model_validate(data).model_dump(mode="json")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--database", type=Path)
    options = parser.parse_args()
    cases, pricing = [], []
    original = optimizer.optimize
    original_price = optimizer.price_path
    depth = 0
    def capture(*args, **kwargs):
        nonlocal depth
        data = normalized(args, kwargs)
        depth += 1
        try:
            result = original(*args, **kwargs)
        finally:
            depth -= 1
        # Time-mocked interruption tests are not repeatable as fresh native runs.
        if kwargs.get("deadline") is None and not kwargs.get("cancelled"):
            checkpoint = kwargs.get("checkpoint")
            cases.append({"name": f"fixture-{len(cases)+1}", "input": data, "expected": copy.deepcopy(result),
                          "prefix_expansions": checkpoint.resumed_from if checkpoint else 0})
        return result
    def capture_price(*args, **kwargs):
        result = original_price(*args, **kwargs)
        if depth == 0:
            path, offers, spec, rules, *extra = args
            data = normalized((spec, path, offers, rules), {})
            data["extra"] = [c.model_dump(mode="json") for c in (extra[0] if extra else kwargs.get("extra") or [])]
            output = dict(result)
            output["low_cents"] = str(output["low_cents"])
            output["high_cents"] = None if output["high_cents"] == float("inf") else str(output["high_cents"])
            output["uncertainty_key"] = list(output["uncertainty_key"])
            pricing.append({"name": f"pricing-{len(pricing)+1}", "input": data, "expected": output})
        return result
    optimizer.optimize, optimizer.price_path = capture, capture_price
    try:
        planner = importlib.import_module("test_planner")
        positioning = importlib.import_module("test_positioning")
        transfers = importlib.import_module("test_airport_transfers")
        checkpoint = importlib.import_module("test_optimizer_checkpoint")
        journey_pricing = importlib.import_module("test_journey_pricing")
        fair = importlib.import_module("test_fair_exploration")
        numeric = importlib.import_module("test_numeric_boundaries")
        suite = unittest.TestSuite(unittest.defaultTestLoader.loadTestsFromTestCase(cls) for cls in
            (planner.OptimizerTests, positioning.PositioningTests, transfers.AirportTransferTests, checkpoint.CheckpointTests, journey_pricing.JourneyPricingTests, fair.FlightEligibilityTests, numeric.NumericPriceTests, numeric.NumericTimeTests))
        suite.addTest(fair.FairFrontierTests("test_priced_options_appear_before_large_unpriced_subtrees_are_exhausted"))
        stream = io.StringIO()
        result = unittest.TextTestRunner(stream=stream).run(suite)
        if not result.wasSuccessful():
            raise RuntimeError(stream.getvalue())
    finally:
        optimizer.optimize, optimizer.price_path = original, original_price
    directory = ROOT / "frontend/tests/fixtures"
    directory.mkdir(exist_ok=True)
    from datetime import date, datetime, timedelta, timezone
    from app.planner_models import FareOffer, Movement, Place, PricingRule, TripSpec, Visit
    rng = random.Random(2525466)
    generated = []
    for index in range(200):
        count = rng.randint(1, 4)
        places = [Place(id=f"city-{i}", name=f"City {i}", latitude=3+i, longitude=101+i,
                        timezone=rng.choice(["UTC", "Asia/Kuala_Lumpur", "Europe/Berlin", "America/New_York"])) for i in range(count+1)]
        base = datetime(2027, 3, 12, tzinfo=timezone.utc)
        spec = TripSpec(home=places[0], visits=[Visit(place=p, min_stay_hours=rng.choice([0, 2, 6])) for p in places[1:]],
            start_date=date(2027, 3, 12), end_date=date(2027, 3, 15), date_mode=rng.choice(["fixed", "flexible"]),
            departure_start="00:00", departure_end="23:59:59", adults=rng.randint(1, 5), modes=["flight", "rail"],
            ordered_visits=rng.choice([True, False]), budget_myr=rng.choice([None, 100, 300]), allow_overnight=rng.choice([True, False]),
            exclude_unpriced_flights=index % 2 == 0)
        movements, offers = [], []
        for a in places:
            for b in places:
                if a == b: continue
                for n in range(rng.randint(1, 3)):
                    dep = base+timedelta(hours=rng.randint(0, 84), minutes=rng.choice([0, 15, 45]))
                    movement = Movement(id=f"m-{a.id}-{b.id}-{n}", from_id=a.id, to_id=b.id, mode=rng.choice(spec.modes), departure=dep,
                        arrival=dep+timedelta(minutes=rng.choice([45, 90, 150])), duration_minutes=1, source="generated")
                    movements.append(movement)
                    low = rng.choice([None, 0, 12.35, 30, 70])
                    high = None if low is None or rng.random() < .15 else low+rng.choice([0, 0, 20])
                    offers.append(FareOffer(id="fare:"+movement.id, movement_ids=[movement.id], low=low, high=high))
        if len(movements) >= 2 and index % 3 == 0:
            pair = rng.sample(movements, 2)
            offers.append(FareOffer(id="bundle", movement_ids=[m.id for m in pair], kind="round-trip", low=20, high=20))
        solver_options = {"include_dominated": index % 5 == 0}
        if index % 4 == 0:
            solver_options["expansion_budget"] = rng.choice([0, 1, 16, 32, 100])
        data = normalized((spec, movements, offers, []), solver_options)
        expected = original(spec, movements, offers, [], **solver_options)
        generated.append({"name":f"generated-{index+1}", "input":data, "expected":expected})
    # Keep integer expectations as strings: JSON's Number parser would erase
    # the very cents this corpus is intended to check.
    numeric_rng = random.Random(912506)
    values = [1.0000000000000001e18, 90071992547409.91, .005, .015, 1e25]
    values += [math.ldexp(numeric_rng.random(), numeric_rng.randint(-40, 86)) for _ in range(2000)]
    cent_cases = [{"value": value, "expected": str(optimizer.cents(value))} for value in values]
    epoch = datetime(1970, 1, 1, tzinfo=timezone.utc)
    timestamps = [f"{year:04}-02-10T09:00:00.{fraction:06}+00:00" for year in [1, 1680, 2255, 2500, 9999] for fraction in [1, 123457, 999999]]
    timestamps += ['1969-12-31T23:59:59.9999999Z', '1900-01-01T00:00:00.1234567+08:00', '2500-01-01T00:00:00.1234567-05:00',
                   1700000000.0000015, 10000000000.000002]
    timestamp_cases = []
    for value in timestamps:
        parsed = datetime.fromtimestamp(value, timezone.utc) if isinstance(value, (int, float)) else datetime.fromisoformat(value).astimezone(timezone.utc)
        delta = parsed - epoch
        timestamp_cases.append({"value": value, "micros": str((delta.days * 86400 + delta.seconds) * 1_000_000 + delta.microseconds), "iso": parsed.isoformat()})
    timedelta_cases = []
    duration_rng = random.Random(170086)
    for unit, factor in [('minutes', 60_000_000), ('hours', 3_600_000_000)]:
        values = [1.0000000083333334, .5 / factor, 1 + .5 / factor, -1 - .5 / factor]
        values += [duration_rng.randrange(8760) + duration_rng.choice([.5, 1.5, 2.5, 3.5]) / factor for _ in range(500)]
        for value in values:
            delta = timedelta(**{unit: value})
            timedelta_cases.append({"value": value, "unit": factor, "expected": str((delta.days * 86400 + delta.seconds) * 1_000_000 + delta.microseconds)})
    for _ in range(200):
        minutes = duration_rng.randrange(1000) + duration_rng.random() * 4 / 60_000_000
        hours = duration_rng.randrange(1000) + duration_rng.random() * 4 / 3_600_000_000
        delta = timedelta(minutes=minutes, hours=hours)
        timedelta_cases.append({"value": minutes, "unit": 60_000_000, "extra": [hours, 3_600_000_000],
                                "expected": str((delta.days * 86400 + delta.seconds) * 1_000_000 + delta.microseconds)})
    (directory / "native-solver.json").write_text(json.dumps({"cases": cases, "pricing": pricing, "generated":generated, "cent_cases": cent_cases, "timestamp_cases": timestamp_cases, "timedelta_cases": timedelta_cases}, separators=(",", ":"), allow_nan=False), encoding="utf-8")
    print(json.dumps({"fixture_calls": len(cases), "pricing_calls": len(pricing), "generated_cases":len(generated), "cent_cases": len(cent_cases), "timestamp_cases": len(timestamp_cases), "timedelta_cases": len(timedelta_cases), "original_tests": result.testsRun}), flush=True)

    if options.database:
        from app import planner_discovery as discovery
        db = sqlite3.connect(options.database.resolve().as_uri()+"?mode=ro", uri=True)
        try:
            rows = db.execute("select payload from records where collection='trips'").fetchall()
            trips = [expand_trip(json.loads(row[0])) for row in rows]
            trip = max(trips, key=lambda value: len((value.get("snapshot") or {}).get("movements", [])))
            rules = [json.loads(row[0]) for row in db.execute("select payload from records where collection='rules'")]
        finally:
            db.close()
        class Inputs:
            def get(self, collection, identifier):
                assert collection == "trips" and identifier == trip["id"]
                return copy.deepcopy(trip)
            def list(self, collection):
                assert collection == "rules"
                return copy.deepcopy(rules)
            def load_optimizer_checkpoint(self, *_): return None
            def put(self, *_): raise AssertionError("Read-only benchmark tried to save")
        class Captured(Exception): pass
        saved = {}
        def intercept(*args, **kwargs):
            saved.update(args=args, kwargs=kwargs)
            raise Captured()
        discovery.optimize = intercept
        try:
            asyncio.run(discovery.DiscoveryManager(Inputs()).recalculate(trip["id"]))
        except Captured:
            pass
        finally:
            discovery.optimize = original
        data = normalized(saved["args"], saved["kwargs"])
        data["label_limit"] = None
        spec, moves, offers, rules = data["spec"], data["movements"], data["offers"], data["rules"]
        from app.planner_models import TripSpec, Movement, FareOffer, PricingRule
        start = time.perf_counter()
        result = original(TripSpec.model_validate(spec), [Movement.model_validate(m) for m in moves],
            [FareOffer.model_validate(o) for o in offers], [PricingRule.model_validate(r) for r in rules],
            snapshot_revision=data.get("snapshot_revision", 0), trip_revision=data.get("trip_revision", 0))
        artifact = {"name": "saved-trip", "input": data, "expected": result, "native_python_seconds": time.perf_counter()-start}
        output = ROOT / "data/diagnostics/native-comparison"
        output.mkdir(parents=True, exist_ok=True)
        (output / "saved-trip.json").write_text(json.dumps(artifact, separators=(",", ":"), allow_nan=False), encoding="utf-8")
        print(json.dumps({"saved_movements": len(moves), "saved_offers": len(offers), "native_python_seconds": artifact["native_python_seconds"], "expanded": result["expanded_labels"], "routes": len(result["routes"])}), flush=True)


if __name__ == "__main__":
    main()
