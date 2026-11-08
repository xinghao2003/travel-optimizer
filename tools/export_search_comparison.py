"""Capture real Python discovery rounds and in-flight edits without provider I/O."""
import asyncio
import copy
from datetime import datetime, timezone
import json
from pathlib import Path
import sys
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT / "backend"), str(ROOT / "backend/tests")]
from app import planner_discovery as discovery, planner_api as api
from app.planner_models import Movement, Place, TripSpec, Visit
from test_planner import trip as trip_spec

NOW = datetime(2027, 2, 1, 12, tzinfo=timezone.utc)
FIELDS = ["status", "processed", "pending", "requests", "cache_hits", "manual_quote_queries", "failed_queries", "batch_budget", "batch_requests", "outcomes", "pause_reason", "optimization_pending", "phase", "updating_options"]


class FrozenDateTime(datetime):
    @classmethod
    def now(cls, tz=None): return NOW.astimezone(tz)


class Store:
    def __init__(self, trip, rules):
        self.records = {"trips": {trip["id"]: copy.deepcopy(trip)}, "rules": {r["id"]: r for r in rules}, "graphs": {}, "jobs": {}, "optimizations": {}}
        self.checkpoints = {}
    def get(self, collection, id, **_): return copy.deepcopy(self.records[collection].get(id))
    def put(self, collection, id, value): self.records[collection][id] = copy.deepcopy(value); return copy.deepcopy(value)
    def list(self, collection): return copy.deepcopy(list(self.records[collection].values()))
    def update(self, collection, id, transform): return self.put(collection, id, transform(self.get(collection, id)))
    def trip_spec(self, id): return self.get("trips", id)["spec"]
    def load_optimizer_checkpoint(self, id, version): return self.checkpoints.get((id, version))
    def save_optimizer_checkpoint(self, id, version, value): self.checkpoints[id, version] = value


def view(manager, store, id):
    job = store.get("jobs", id); public = manager.public(job); saved = store.get("trips", job["trip_id"])
    return {"public": {k: public[k] for k in FIELDS if k in public}, "queue": job["queue"], "snapshot": job["snapshot"],
            "trip": {k: saved[k] for k in ("revision", "spec", "offers", "snapshot", "result") if k in saved}, "bundle_links": job["bundle_links"]}


def payload(task, pagination=False):
    start, end = ("09:30:00", "10:30:00") if task["from_id"] == "home" else ("16:00:00", "17:00:00")
    day = task["date"]
    result = {"itineraries": [{"startTime": f"{day}T{start}+00:00", "endTime": f"{day}T{end}+00:00",
        "legs": [{"mode": "BUS", "startTime": f"{day}T{start}+00:00", "endTime": f"{day}T{end}+00:00", "from": {"name": task["from_id"]}, "to": {"name": task["to_id"]}, "agencyName": "Fixture", "displayName": "1", "source": "fixture.gtfs.zip"}],
        "fareTransfers": [{"rule": "fixture", "effectiveFareLegProducts": [[[{"amount": 10, "currency": "MYR"}]]]}]}]}
    if pagination and not task.get("cursor"): result["nextPageCursor"] = "page-two"
    return result


async def scenario(name, *, mode="empty", budget=2, continues=(), enabled=True, edit=None, cancel=False, timed=False, expire=False, fallback=False, flight=False, cached_manual=False):
    if flight:
        sample = json.loads((ROOT / "frontend/tests/fixtures/native-preparation.json").read_text(encoding="utf-8"))["cases"][5]
        initial, rules = copy.deepcopy(sample["trip"]), sample["rules"]
    else:
        spec = trip_spec(modes=["rail" if fallback else "bus"])
        spec.visits = [Visit(place=Place(id="a", name="a", latitude=3, longitude=101, timezone="UTC"), min_stay_hours=1)]
        spec.rail_fallback.enabled = fallback
        initial = {"id": "discovery-reference", "revision": 1, "spec": spec.model_dump(mode="json"), "offers": [], "snapshot": None, "latest_job_id": None}
        rules = []
    initial["id"] = "discovery-reference"; initial["latest_job_id"] = None; initial.pop("result", None)
    store = Store(initial, rules)
    if cached_manual:
        spec = TripSpec.model_validate(initial["spec"])
        assumed = Movement(id="cached-assumption", from_id="home", to_id="a", mode="bus", duration_minutes=60, source="User-defined connection")
        store.put("graphs", spec.discovery_key(), {"revision": 1, "discovery_key": spec.discovery_key(), "movements": [assumed.model_dump(mode="json")], "offers": [], "roads": {}, "coverage": {}})
    initial_graphs = copy.deepcopy(store.records["graphs"])
    manager = discovery.DiscoveryManager(store)
    requests, steps = [], []
    entered, release = asyncio.Event(), asyncio.Event()
    gated = edit is not None or cancel
    count = 0

    async def fetch(task, spec, snapshot):
        nonlocal count
        index = count; count += 1
        if gated and index == 0:
            entered.set(); await release.wait()
        status = "failed" if mode == "retry" and index == 0 else "success" if mode in {"bus", "pagination"} and task["kind"] == "transit" else "empty"
        outcome = {"status": status, "retrieved_at": NOW.isoformat()}
        if status == "success": outcome["payload"] = payload(task, mode == "pagination")
        used = not (mode == "cache" and index < 2)
        requests.append({"task": copy.deepcopy(task), "outcome": copy.deepcopy(outcome), "usedRequest": used})
        return outcome, used
    manager.fetch = fetch
    if expire and not gated: manager.time_expired = lambda job: count >= 2
    with patch.object(discovery, "datetime", FrozenDateTime), patch.object(discovery.transitous, "contact_url", "https://example.test" if enabled else ""):
        job = manager.start(initial["id"], budget, minutes=1 if timed else None); id = job["id"]
        commands = [{"operation": "start", "budget": budget, "minutes": 1 if timed else None, "enabled": enabled}]
        if gated:
            await entered.wait()
            if expire:
                manager.round_deadlines[id] = discovery.clock.monotonic() - 1
            if cancel:
                manager.cancel(id); commands.append({"operation": "cancel_inflight"})
                release.set()
                await manager.running[id]
            else:
                request = {"expected_revision": initial["revision"], "exchange_rates": {"USD": 4}}
                if edit == "invalid": request["expected_revision"] = 999
                request_model = api.ApplyChangesRequest.model_validate(request)
                operation = asyncio.create_task(manager.apply_changes(initial["id"], lambda t: api.apply_missing_info(t, request_model)))
                await asyncio.sleep(0); await asyncio.sleep(0)
                release.set()
                try: await operation
                except Exception as error:
                    if edit != "invalid": raise
                    assert error.status_code == 409
                commands.append({"operation": "apply_inflight", "request": request, "valid": edit != "invalid", "expire": expire})
                if id in manager.running: await manager.running[id]
        else: await manager.running[id]
        steps.append(view(manager, store, id))
        for next_budget in continues:
            # Configuration may be enabled after importing/continuing an older job.
            discovery.transitous.contact_url = "https://example.test"
            manager.start(initial["id"], next_budget, id)
            await manager.running[id]
            commands.append({"operation": "continue", "budget": next_budget, "enabled": True})
            steps.append(view(manager, store, id))
    return {"name": name, "initial": initial, "graphs": initial_graphs, "rules": rules, "requests": requests, "commands": commands, "steps": steps, "time_pause_after": 2 if expire and not gated else None}


async def main():
    cases = []
    cases.append(await scenario("budget-resume", continues=(1, 100)))
    cases.append(await scenario("cache-does-not-spend", mode="cache", budget=1, continues=(100,)))
    cases.append(await scenario("failed-latest-query-retries", mode="retry", budget=100, continues=(100,)))
    cases.append(await scenario("transit-setup-on-continue", enabled=False, budget=1, continues=(100,)))
    cases.append(await scenario("paginated-priced-transit", mode="pagination", budget=100))
    cases.append(await scenario("rail-probes", fallback=True, budget=100))
    cases.append(await scenario("cancel-keeps-response", mode="bus", budget=100, cancel=True))
    cases.append(await scenario("apply-keeps-round", mode="bus", budget=2, edit="valid"))
    cases.append(await scenario("invalid-apply-resumes-round", mode="bus", budget=2, edit="invalid"))
    cases.append(await scenario("time-pause-stores-graph", mode="bus", budget=100, timed=True, expire=True))
    cases.append(await scenario("apply-after-time-expired", mode="bus", budget=100, timed=True, expire=True, edit="valid"))
    cases.append(await scenario("bundles-from-complete-histories", flight=True, budget=100))
    cases.append(await scenario("reuse-shared-assumptions", cached_manual=True, budget=100))
    urls = []
    from datetime import time
    from app.planner_providers import flight_query
    legs = [{"from_id": "home", "to_id": "a", "date": "2027-02-10", "from_code": "KUL", "to_code": "SIN", "from_airports": ["KUL"], "to_airports": ["SIN"], "timezone": "Asia/Kuala_Lumpur"}]
    for count in (1, 2, 6):
        for adults in (1, 2, 9):
            for kind in ("one-way", "round-trip", "multi-city"):
                for start, end in (("00:00:00", "23:59:00"), ("09:15:00", "17:30:00")):
                    spec = copy.deepcopy(cases[0]["initial"]["spec"]); spec.update(adults=adults, departure_start=start, departure_end=end)
                    selected = legs * count
                    urls.append({"legs": selected, "spec": spec, "kind": kind, "expected": flight_query(selected, adults, kind, time.fromisoformat(start), time.fromisoformat(end)).url()})
    catalog = json.loads((ROOT / "frontend/public/browser-data/airports.json").read_text(encoding="utf-8"))
    output = ROOT / "frontend/tests/fixtures/native-search.json"
    output.write_text(json.dumps({"cases": cases, "urls": urls, "catalog": catalog, "now": int(NOW.timestamp() * 1000)}, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(json.dumps({"search_scenarios": len(cases), "rounds": sum(len(c["steps"]) for c in cases), "provider_outcomes": sum(len(c["requests"]) for c in cases), "flight_urls": len(urls)}))


if __name__ == "__main__": asyncio.run(main())
