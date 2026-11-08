"""Capture current Python trip-edit transforms, including rejected changes."""
import copy
import asyncio
import importlib
import io
import json
from pathlib import Path
import sys
import unittest
from unittest.mock import AsyncMock, patch

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT / "backend"), str(ROOT / "backend/tests")]
from app import planner_api as api, planner_discovery as discovery
from app.planner_models import FareOffer, Movement
from fastapi.responses import JSONResponse


async def endpoint_cases():
    base = json.loads((ROOT / "frontend/tests/fixtures/native-preparation.json").read_text(encoding="utf-8"))["cases"][2]["trip"]

    class Store:
        def __init__(self, trip): self.trip = copy.deepcopy(trip)
        def get(self, collection, id, **kwargs): return copy.deepcopy(self.trip)
        def put(self, collection, id, value):
            if collection == "trips": self.trip = copy.deepcopy(value)
            return value
        def update(self, collection, id, transform): return self.put(collection, id, transform(self.get(collection, id)))

    class Manager:
        def __init__(self, store): self.store = store
        async def apply_changes(self, id, transform): self.store.update("trips", id, transform)

    cases = []

    async def exercise(operation, trip, **values):
        data = dict(trip=copy.deepcopy(trip), **values)
        store = Store(trip)
        with patch.object(api, "store", store), patch.object(api, "manager", Manager(store)), patch.object(api, "recalculate", AsyncMock(return_value=JSONResponse({}))):
            try:
                if operation == "edit_fare": await api.edit_fare(trip["id"], values["offer_id"], FareOffer.model_validate(values["offer"]))
                elif operation == "add_assumed": await api.add_assumed_movement(trip["id"], Movement.model_validate(values["movement"]))
                elif operation == "remove_assumed": await api.remove_assumed_movement(trip["id"], values["movement_id"], values["expected_revision"])
                elif operation == "remove_journey_rule": await api.remove_journey_rule(trip["id"], values["rule_id"], values["expected_revision"])
                elif operation == "reuse_journey": await api.reuse_existing_journey_estimate(trip["id"], api.ReuseJourneyEstimateRequest.model_validate(values["request"]))
                else: await api.save_shared_estimates(trip["id"], [api.SharedFareValues.model_validate(v) for v in values["estimates"]], values["expected_revision"])
            except Exception as error:
                cases.append(dict(name=f"endpoint-{operation}-{len(cases)}", operation=operation, input=data, valid=False, status=getattr(error, "status_code", 422)))
            else:
                cases.append(dict(name=f"endpoint-{operation}-{len(cases)}", operation=operation, input=data, valid=True, expected=store.trip))

    first, back = base["snapshot"]["movements"][:2]
    for covered, kind in [([first["id"]], "one-way"), ([first["id"], back["id"]], "round-trip"), ([first["id"], "train"], "round-trip"), (["unknown"], "one-way")]:
        offer = FareOffer(id="edit", movement_ids=covered, kind=kind, low=20, high=20, adults=9).model_dump(mode="json")
        await exercise("edit_fare", base, offer_id="edit", offer=offer)
    await exercise("edit_fare", base, offer_id="mismatch", offer=offer)
    movement = Movement(id="assumed", from_id=first["from_id"], to_id=first["to_id"], mode="rail", duration_minutes=90, source="provided").model_dump(mode="json")
    await exercise("add_assumed", base, movement=movement)
    await exercise("add_assumed", base, movement={**movement, "to_id": "unknown"})
    assumed = copy.deepcopy(base)
    assumed["snapshot"]["movements"].append({**movement, "source": "User-defined connection"})
    for identifier, revision in [("assumed", base["revision"]), ("train", base["revision"]), ("assumed", 999)]:
        await exercise("remove_assumed", assumed, movement_id=identifier, expected_revision=revision)
    for identifier, revision in [("trip-rule", base["revision"]), ("missing", base["revision"]), ("trip-rule", 999)]:
        await exercise("remove_journey_rule", base, rule_id=identifier, expected_revision=revision)
    estimate = dict(component_ids=["train"], low=20, high=20, currency="MYR", label="Shared estimate: Rail group")
    for revision in [base["revision"], 999]:
        await exercise("save_shared", base, estimates=[estimate], expected_revision=revision)
    grouped = copy.deepcopy(base)
    grouped["offers"].append(FareOffer(id="user:train", movement_ids=["train"], low=20, high=20, source="user", adults=grouped["spec"]["adults"], estimated=True, label=estimate["label"]).model_dump(mode="json"))
    for changes in [{}, dict(low=21), dict(group_by=["stations", "stations"]), dict(group_by=["unsupported"]), dict(expected_revision=999)]:
        await exercise("reuse_journey", grouped, request={**estimate, "expected_revision": base["revision"], "group_by": ["stations", "category", "connections"], **changes})
    return cases


def main():
    names = ("apply_missing_info", "shared_fare_offers", "reusable_journey_rules", "connection_payload", "transfer_payload")
    originals = {name: getattr(api, name) for name in names}
    cases = []

    def capture(name):
        def call(*args, **kwargs):
            if name == "connection_payload":
                data = dict(connections=[c.model_dump(mode="json") for c in args[0]])
            elif name == "apply_missing_info":
                data = dict(trip=copy.deepcopy(args[0]), request=args[1].model_dump(mode="json"))
            else:
                data = dict(trip=copy.deepcopy(args[0]), estimates=[e.model_dump(mode="json") for e in args[1]])
            try:
                result = originals[name](*args, **kwargs)
            except Exception as error:
                cases.append(dict(name=f"{name}-{len(cases)}", operation=name, input=data, valid=False,
                                  status=getattr(error, "status_code", 422)))
                raise
            cases.append(dict(name=f"{name}-{len(cases)}", operation=name, input=data, valid=True, expected=copy.deepcopy(result)))
            return result
        return call

    for name in names:
        setattr(api, name, capture(name))
    try:
        modules = [importlib.import_module(name) for name in ("test_apply_changes", "test_shared_fares", "test_journey_pricing", "test_airport_transfers", "test_csv_deletions")]
        suite = unittest.TestSuite(unittest.defaultTestLoader.loadTestsFromModule(module) for module in modules)
        stream = io.StringIO()
        result = unittest.TextTestRunner(stream=stream).run(suite)
        if not result.wasSuccessful():
            raise RuntimeError(stream.getvalue())
    finally:
        for name, original in originals.items():
            setattr(api, name, original)
    cases.extend(asyncio.run(endpoint_cases()))
    catalog = dict(airports={code: {key: row[key] for key in ("name", "lat", "lon", "tz")} for code, row in discovery.iata_airports().items()},
                   metros={code: list(row.get("airports", {})) for code, row in discovery.iata_metros().items()})
    path = ROOT / "frontend/tests/fixtures/native-edits.json"
    path.write_text(json.dumps(dict(cases=cases, catalog=catalog), separators=(",", ":"), allow_nan=False), encoding="utf-8")
    print(json.dumps(dict(cases=len(cases), rejected=sum(not c["valid"] for c in cases), tests=result.testsRun)))


if __name__ == "__main__":
    main()
