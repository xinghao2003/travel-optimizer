"""Browser worker adapter around the unchanged optimizer and shared normalizers.

The JavaScript host owns network requests and IndexedDB. This module owns only
the in-memory graph and cooperative optimizer state. No HTTP clients or SQLite.
"""
import base64
from datetime import date, datetime, time, timedelta, timezone
import itertools
import json
import pickle
import time as clock
from zoneinfo import ZoneInfo

from .planner_journeys import flight_movement, transit_movements
from .planner_models import FareOffer, Movement, PricingRule, TripSpec, stable_id
from .planner_optimizer import SearchCheckpoint, optimize
from .planner_windows import rough_date_windows, seed_dates

_spec = None
_graph = {"movements": [], "offers": [], "roads": {}, "revision": 0}
_checkpoint = SearchCheckpoint()
_catalog = {}
TRANSIT_MODES = {"rail": "HIGHSPEED_RAIL,LONG_DISTANCE,NIGHT_RAIL,REGIONAL_RAIL,SUBURBAN", "bus": "BUS", "coach": "COACH", "subway": "SUBWAY", "tram": "TRAM"}


def configure(catalog_json):
    global _catalog
    _catalog = json.loads(catalog_json)


def _leg(origin, dest, day):
    return {"from_id": origin.id, "to_id": dest.id, "date": day,
            "from_code": origin.flight_code, "to_code": dest.flight_code,
            "from_airports": origin.airport_codes, "to_airports": dest.airport_codes,
            "timezone": origin.timezone}


def prepare(spec_json):
    global _spec, _graph, _checkpoint
    _spec = TripSpec.model_validate_json(spec_json)
    if (_spec.end_date - _spec.start_date).days > 14:
        raise ValueError("The browser prototype supports date windows of up to 14 days.")
    if _spec.cars.own_enabled or _spec.cars.rental_enabled or _spec.positioning_services:
        raise ValueError("Live discovery in this prototype supports flights, transit, and taxis. Import a graph to test other solver inputs.")
    _graph = {"movements": [], "offers": [], "roads": {}, "revision": 0}
    _checkpoint = SearchCheckpoint()
    places = _spec.places()
    tasks, keys = [], set()

    def add(task):
        key = stable_id(task)
        if key not in keys:
            tasks.append({**task, "key": key})
            keys.add(key)

    if any(mode in _spec.modes for mode in ("flight", "taxi")):
        nodes = {p.id: {"id": p.id, "latitude": p.latitude, "longitude": p.longitude} for p in places.values()}
        if "flight" in _spec.modes:
            for place in places.values():
                for code in place.airport_codes:
                    airport = _catalog.get(code)
                    if airport:
                        nodes["airport:" + code] = {"id": "airport:" + code, "latitude": airport["lat"], "longitude": airport["lon"]}
        add({"kind": "road", "nodes": list(nodes.values())})

    windows = rough_date_windows(_spec)
    transit_modes = ",".join(TRANSIT_MODES[m] for m in _spec.modes if m in TRANSIT_MODES)

    def pair_day(a, b, day):
        window = windows.get((a, b))
        if window is None:
            return
        origin, dest = places[a], places[b]
        first, last = (value.astimezone(ZoneInfo(origin.timezone)).date() for value in window)
        if not first <= day <= last:
            return
        common = {"from_id": a, "to_id": b, "date": day.isoformat()}
        if "flight" in _spec.modes and origin.flight_code and dest.flight_code and origin.airport_codes and dest.airport_codes:
            add({**common, "kind": "flight", "request": {"legs": [_leg(origin, dest, day.isoformat())], "adults": _spec.adults,
                 "departure_start": _spec.departure_start.isoformat(), "departure_end": _spec.departure_end.isoformat()}})
        if transit_modes:
            instant = datetime.combine(day, _spec.departure_start, ZoneInfo(origin.timezone))
            end = datetime.combine(day, _spec.departure_end, ZoneInfo(origin.timezone))
            add({**common, "kind": "transit", "params": {"fromPlace": f"{origin.latitude},{origin.longitude}",
                 "toPlace": f"{dest.latitude},{dest.longitude}", "time": instant.isoformat(timespec="seconds"), "arriveBy": "false",
                 "transitModes": transit_modes, "timetableView": "true", "searchWindow": str(int((end-instant).total_seconds())),
                 "numItineraries": "10", "joinInterlinedLegs": "false"}})

    # Seed complete paths before filling the remaining pair/date windows.
    days = seed_dates(_spec)
    for order in _spec.visit_orders():
        for departure in _spec.departures:
            for arrival in _spec.arrivals:
                path = [departure.id, *order, arrival.id]
                for index, (a, b) in enumerate(zip(path, path[1:])):
                    if a != b:
                        pair_day(a, b, days[min(index, len(days)-1)])
    for a, b in itertools.permutations(places, 2):
        for offset in range((_spec.end_date-_spec.start_date).days+1):
            pair_day(a, b, _spec.start_date+timedelta(days=offset))
    return json.dumps({"spec": _spec.model_dump(mode="json"), "tasks": tasks})


def ingest(task_json, payload_json):
    task, payload = json.loads(task_json), json.loads(payload_json)
    places = _spec.places()
    movements, offers = [], []
    if task["kind"] == "road":
        if payload.get("code") != "Ok" or "durations" not in payload or "distances" not in payload:
            raise ValueError("OSRM did not return a distance and duration matrix.")
        nodes = task["nodes"]
        for i, origin in enumerate(nodes):
            for j, dest in enumerate(nodes):
                duration, distance = payload["durations"][i][j], payload["distances"][i][j]
                if origin["id"] == dest["id"] or duration is None or distance is None or duration <= 0:
                    continue
                _graph["roads"][origin["id"]+"->"+dest["id"]] = {"duration_minutes": duration/60, "distance_km": distance/1000}
                if "taxi" in _spec.modes and origin["id"] in places and dest["id"] in places:
                    movements.append(Movement(id="road:"+stable_id(origin["id"], dest["id"]), from_id=origin["id"], to_id=dest["id"],
                        mode="taxi", duration_minutes=duration/60, distance_km=distance/1000, source="OSRM"))
    elif task["kind"] == "transit":
        movements, offers = transit_movements(payload, places[task["from_id"]], places[task["to_id"]], _spec, task["date"])
    else:
        if payload.get("status") == "failed":
            raise ValueError(payload.get("message", "Flight retrieval failed."))
        now = datetime.now(timezone.utc)
        for option in payload.get("options", []):
            if len(option.get("journeys", [])) != 1:
                continue
            movement = flight_movement(places[task["from_id"]], places[task["to_id"]], option["journeys"][0], _spec, _graph["roads"])
            movement.search_url = payload.get("search_url")
            movements.append(movement)
            value = option.get("price")
            offers.append(FareOffer(id="flight-fare:"+stable_id(movement.id, value), movement_ids=[movement.id],
                low=value, high=value, currency="MYR", adults=_spec.adults, label="Whole-party flight quote",
                search_url=payload.get("search_url"), retrieved_at=now, expires_at=now+timedelta(minutes=15)))
    for collection, additions in (("movements", movements), ("offers", offers)):
        indexed = {item["id"]: item for item in _graph[collection]}
        indexed.update((item.id, item.model_dump(mode="json")) for item in additions)
        _graph[collection] = list(indexed.values())
    _graph["revision"] += 1
    return json.dumps({"movements": len(_graph["movements"]), "offers": len(_graph["offers"])})


def solve(options_json):
    options = json.loads(options_json)
    result = optimize(_spec, [Movement.model_validate(m) for m in _graph["movements"]],
        [FareOffer.model_validate(o) for o in _graph["offers"]], [PricingRule.model_validate(r) for r in options.get("rules", [])],
        snapshot_revision=_graph["revision"], checkpoint=_checkpoint,
        deadline=clock.monotonic()+max(.01, min(float(options.get("seconds", .2)), .5)))
    return json.dumps(result, allow_nan=False)


def snapshot():
    return json.dumps({"spec": _spec.model_dump(mode="json"), "graph": _graph})


def restore(state_json):
    global _spec, _graph, _checkpoint
    state = json.loads(state_json)
    _spec = TripSpec.model_validate(state["spec"])
    graph = state.get("graph") or state.get("snapshot")
    if graph is None:
        raise ValueError("The file needs a collected movement graph.")
    _graph = {"movements": [Movement.model_validate(m).model_dump(mode="json") for m in graph["movements"]],
              "offers": [FareOffer.model_validate(o).model_dump(mode="json") for o in [*graph.get("offers", []), *state.get("offers", [])]],
              "roads": graph.get("roads", {}), "revision": graph.get("revision", 0)}
    _checkpoint = SearchCheckpoint()
    return json.dumps({"spec": _spec.model_dump(mode="json"), "movements": len(_graph["movements"]), "offers": len(_graph["offers"])})


def checkpoint():
    return base64.b64encode(pickle.dumps(_checkpoint, protocol=5)).decode("ascii")


def resume_checkpoint(payload):
    global _checkpoint
    # Only read records created by this worker in this origin's IndexedDB.
    # The file-import path intentionally never calls this function.
    _checkpoint = pickle.loads(base64.b64decode(payload))


def reference_solve(input_json):
    """Run the same explicit solver input as TypeScript, without provider work."""
    global _reference_checkpoint
    started = clock.perf_counter()
    data = json.loads(input_json)
    spec = TripSpec.model_validate(data["spec"])
    moves = [Movement.model_validate(m) for m in data["movements"]]
    offers = [FareOffer.model_validate(o) for o in data["offers"]]
    rules = [PricingRule.model_validate(r) for r in data.get("rules", [])]
    validated = clock.perf_counter()
    _reference_checkpoint = SearchCheckpoint()
    result = optimize(spec, moves, offers, rules, snapshot_revision=data.get("snapshot_revision", 0),
        trip_revision=data.get("trip_revision", 0), finish_at_home=data.get("finish_at_home", True),
        include_dominated=data.get("include_dominated", False), label_limit=data.get("label_limit"),
        expansion_budget=data.get("expansion_budget"), checkpoint=_reference_checkpoint)
    solved = clock.perf_counter()
    return json.dumps({"result": result, "validation_ms": (validated-started)*1000, "solve_ms": (solved-validated)*1000}, allow_nan=False)
