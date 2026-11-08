"""Read one saved trip without changing SQLite or issuing provider requests."""
import argparse
import asyncio
from datetime import datetime, timezone
import json
from pathlib import Path
import sqlite3
import time
from unittest.mock import patch

import export_preparation_comparison as reference
from app.planner_models import TripSpec
from app.planner_results import expand_trip
from export_solver_comparison import normalized


async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--database", type=Path, required=True)
    args = parser.parse_args()
    with sqlite3.connect(args.database.resolve().as_uri()+"?mode=ro", uri=True) as db:
        trips = [expand_trip(json.loads(row[0])) for row in db.execute("select payload from records where collection='trips'")]
        rules = [json.loads(row[0]) for row in db.execute("select payload from records where collection='rules'")]
    trip = max(trips, key=lambda value: len((value.get("snapshot") or {}).get("movements", [])))
    reference.NOW = datetime.now(timezone.utc)
    store = reference.Inputs(trip, rules)
    original = reference.discovery.optimize
    captured = {}

    def capture(*args, **kwargs):
        kwargs["expansion_budget"] = None
        captured.update(normalized(args, kwargs))
        return original(*args, **kwargs)

    began = time.perf_counter()
    with patch.object(reference.discovery, "optimize", capture), patch.object(reference.discovery, "datetime", reference.FrozenDateTime):
        result = await reference.discovery.DiscoveryManager(store).recalculate(trip["id"], continuous=True)
    item = dict(name="saved-preparation", trip=trip, rules=rules, options=dict(now=int(reference.NOW.timestamp()*1e6), unlimited=True, expansion_budget=None),
                expected_input=captured, expected_snapshot=store.trip["snapshot"], expected_result=result,
                expected_metadata=reference.metadata(store.trip), expected_discovery_key=TripSpec.model_validate(trip["spec"]).discovery_key(),
                expected_airport_places={key: value.model_dump(mode="json") for key, value in reference.discovery.airport_places(TripSpec.model_validate(trip["spec"])).items()})
    catalog = json.loads((reference.ROOT / "frontend/public/browser-data/airports.json").read_text(encoding="utf-8"))
    output = reference.ROOT / "data/diagnostics/native-comparison/saved-preparation.json"
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(dict(cases=[item], catalog=catalog, discovery_keys=[], hash_cases=[]), separators=(",", ":"), allow_nan=False), encoding="utf-8")
    print(json.dumps(dict(raw_movements=len(trip["snapshot"]["movements"]), prepared_movements=len(captured["movements"]), offers=len(captured["offers"]),
                          expanded=result["expanded_labels"], complete=result["optimization_complete"], routes=len(result["routes"]), python_seconds=time.perf_counter()-began)))


if __name__ == "__main__":
    asyncio.run(main())
