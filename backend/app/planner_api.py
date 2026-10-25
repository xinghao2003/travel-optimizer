from __future__ import annotations

import asyncio
from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from .planner_discovery import manager, required_airport_connections, airport_transfer_rows
from .planner_models import AirportConnection, AirportTransferEstimate, FareOffer, Movement, PricingRule, TripSpec
from .planner_places import search_places
from .planner_store import store
from .planner_results import compact_trip, compact_result, fare_component_ids

router = APIRouter(prefix="/api/v2")


class UpdateTrip(BaseModel):
    spec: TripSpec
    expected_revision: int


class SearchRequest(BaseModel):
    budget: int = Field(default=100, ge=1, le=500)


class OptimizationRequest(BaseModel):
    expand: bool = False
    include_dominated: bool = False
    compact: bool = False


class UpdateAirportConnections(BaseModel):
    connections: list[AirportConnection] = Field(default_factory=list, max_length=120)


class UpdateAirportTransfers(BaseModel):
    estimates: list[AirportTransferEstimate] = Field(default_factory=list, max_length=240)
    expected_revision: int


class SharedFareValues(BaseModel):
    component_ids: list[str] = Field(min_length=1, max_length=5000)
    low: float = Field(ge=0, allow_inf_nan=False)
    high: float | None = Field(default=None, ge=0, allow_inf_nan=False)
    currency: str = Field(default="MYR", pattern=r"^[A-Za-z]{3}$")
    label: str = Field(default="Shared transfer estimate", max_length=200)


class SharedFareRequest(SharedFareValues):
    expected_revision: int


class SharedEstimatesRequest(BaseModel):
    estimates: list[SharedFareValues] = Field(min_length=1, max_length=5000)
    expected_revision: int


def get_trip(id):
    trip = store.get("trips", id)
    if trip is None:
        raise HTTPException(404, "Trip not found.")
    return trip


@router.get("/places")
async def places(search: str = Query(min_length=2, max_length=80), limit: int = Query(default=16, ge=1, le=30)):
    return {"places": await asyncio.to_thread(search_places, search, limit)}


@router.get("/trips")
async def list_trips():
    return {"trips": [{"id": t["id"], "name": t["spec"]["name"], "revision": t["revision"],
                       "start_date": t["spec"]["start_date"], "end_date": t["spec"]["end_date"]} for t in store.list("trips")]}


@router.post("/trips", status_code=201)
async def create_trip(spec: TripSpec):
    trip = store.new_trip(spec.model_dump(mode="json"))
    trip["airport_transfer_rows"] = airport_transfer_rows(spec)
    return trip


@router.post("/trips/{id}/duplicate", status_code=201)
async def duplicate_trip(id: str):
    source = get_trip(id)
    spec = TripSpec.model_validate(source["spec"])
    suffix = " (copy)"
    spec.name = spec.name[:120-len(suffix)].rstrip()+suffix
    trip = store.new_trip(spec.model_dump(mode="json"))
    trip["airport_connections"] = source.get("airport_connections", [])
    trip["airport_transfer_estimates"] = source.get("airport_transfer_estimates", [])
    trip = store.put("trips", trip["id"], trip)
    trip["airport_transfer_rows"] = airport_transfer_rows(spec)
    return trip


@router.get("/trips/{id}")
async def read_trip(id: str, include_graph: bool = False, compact: bool = False):
    def response():
        trip = store.get("trips", id, expand=not compact)
        if trip is None:
            raise HTTPException(404, "Trip not found.")
        trip["airport_transfer_rows"] = airport_transfer_rows(TripSpec.model_validate(trip["spec"]), (trip.get("snapshot") or {}).get("movements", []))
        trip["airport_connections_required"] = required_airport_connections((trip.get("snapshot") or {}).get("movements", []))
        trip["assumed_connections"] = [m for m in (trip.get("snapshot") or {}).get("movements", [])
                                       if m.get("source") == "User-defined connection"]
        movements = (trip.get("snapshot") or {}).get("movements", [])
        component_ids = {m["id"] for m in movements}
        component_ids.update(c["id"] for m in movements for c in m.get("charges", []))
        component_ids.update(fare_component_ids(trip.get("result")))
        # The compact trip response omits its movement graph. Keep enough fare
        # component metadata for clients to edit saved shared estimates in bulk.
        trip["fare_component_ids"] = sorted(component_ids)
        visits = trip["spec"]["visits"]
        pairs = {(m["from_id"], m["to_id"]) for m in movements}
        # These are direct-data gaps, not proof that an entire route is impossible.
        trip["city_connection_gaps"] = [
            {"from_id": a["place"]["id"], "to_id": b["place"]["id"]}
            for i, a in enumerate(visits) for b in visits[i+1:]
            if (a["place"]["id"], b["place"]["id"]) not in pairs
            and (b["place"]["id"], a["place"]["id"]) not in pairs
        ] if trip.get("snapshot") else []
        if not include_graph and trip.get("snapshot"):
            trip["snapshot"] = {k: v for k, v in trip["snapshot"].items() if k not in {"movements", "roads"}} | {"movements": []}
        # Stored data is already JSON-compatible. Avoid FastAPI's expensive
        # recursive encoder and keep SQLite/serialization off the event loop.
        return JSONResponse(compact_trip(trip) if compact else trip)
    return await asyncio.to_thread(response)


@router.put("/trips/{id}")
async def update_trip(id: str, request: UpdateTrip):
    def update(trip):
        if request.expected_revision != trip["revision"]:
            raise HTTPException(409, "This trip changed. Reload it before saving.")
        old_key = TripSpec.model_validate(trip["spec"]).discovery_key()
        trip.update(spec=request.spec.model_dump(mode="json"), revision=trip["revision"]+1)
        if old_key != request.spec.discovery_key():
            # Preserve collected schedules and explicit connections while new
            # inputs need additional discovery. The solver filters feasibility.
            trip["snapshot"] = store.get("graphs", request.spec.discovery_key()) or trip.get("snapshot")
            if trip.get("snapshot"):
                trip["snapshot"].setdefault("coverage", {})["discovery_complete"] = False
        trip.pop("result", None)
        return trip
    get_trip(id)
    updated = store.update("trips", id, update)
    updated["airport_transfer_rows"] = airport_transfer_rows(request.spec, (updated.get("snapshot") or {}).get("movements", []))
    return updated


@router.delete("/trips/{id}")
async def delete_trip(id: str):
    get_trip(id)
    for job in store.list("jobs"):
        if job["trip_id"] == id and (job["status"] in {"running", "queued"} or job["id"] in manager.running):
            raise HTTPException(409, "Cancel discovery before deleting this trip.")
    for job in store.list("jobs"):
        if job["trip_id"] == id:
            store.delete("jobs", job["id"])
    store.delete("trips", id)
    return {"deleted": True}


@router.post("/trips/{id}/searches", status_code=202)
async def start_search(id: str, request: SearchRequest):
    get_trip(id)
    try:
        return manager.start(id, request.budget)
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from exc


@router.get("/searches/{id}")
async def search_status(id: str):
    job = manager.live_jobs.get(id) or store.get("jobs", id)
    if job is None:
        raise HTTPException(404, "Search not found.")
    return manager.public(job)


@router.post("/searches/{id}/continue", status_code=202)
async def continue_search(id: str, request: SearchRequest):
    job = store.get("jobs", id)
    if job is None:
        raise HTTPException(404, "Search not found.")
    try:
        return manager.start(job["trip_id"], request.budget, id)
    except ValueError as exc:
        raise HTTPException(409, str(exc)) from exc


@router.post("/searches/{id}/cancel")
async def cancel_search(id: str):
    if store.get("jobs", id) is None:
        raise HTTPException(404, "Search not found.")
    return manager.public(manager.cancel(id))


@router.post("/trips/{id}/optimize")
async def recalculate(id: str, request: OptimizationRequest = OptimizationRequest()):
    get_trip(id)
    result = await manager.recalculate(id, expand=request.expand, include_dominated=request.include_dominated)
    result.pop("bundle_candidates", None)
    return await asyncio.to_thread(lambda: JSONResponse(compact_result(result) if request.compact else result))


@router.put("/trips/{id}/fares/{offer_id}")
async def edit_fare(id: str, offer_id: str, offer: FareOffer):
    trip = get_trip(id)
    if offer.id != offer_id:
        raise HTTPException(422, "Offer ID must match its URL.")
    snapshot = trip.get("snapshot") or {}
    known = {m["id"] for m in snapshot.get("movements", [])}
    known.update(m["id"] for r in [*trip.get("result", {}).get("routes", []), *trip.get("result", {}).get("dominated_routes", [])] for m in r["movements"])
    known.update(c["id"] for m in snapshot.get("movements", []) for c in m.get("charges", []))
    known.update(c["id"] for r in [*trip.get("result", {}).get("routes", []), *trip.get("result", {}).get("dominated_routes", [])] for c in r.get("extra_charges", []))
    if not set(offer.movement_ids).issubset(known):
        raise HTTPException(422, "Every fare component must belong to this trip's retrieved movements or current rental charges.")
    if offer.kind in {"round-trip", "multi-city"}:
        by_id = {m["id"]: m for m in snapshot.get("movements", [])}
        covered = [by_id.get(key) for key in offer.movement_ids]
        if len(covered) < 2 or any(m is None or m["mode"] != "flight" for m in covered):
            raise HTTPException(422, "Flight bundles must cover at least two retrieved flight journeys.")
        if offer.kind == "round-trip" and (len(covered) != 2 or covered[0]["from_id"] != covered[1]["to_id"] or covered[0]["to_id"] != covered[1]["from_id"]):
            raise HTTPException(422, "A round-trip ticket must cover two opposite-direction journeys.")
    offer = offer.model_copy(update={"source": "user", "validated": True, "adults": TripSpec.model_validate(trip["spec"]).adults})

    def update(record):
        record["offers"] = [o for o in record["offers"] if o["id"] != offer.id]+[offer.model_dump(mode="json")]
        record["revision"] += 1
        return record
    store.update("trips", id, update)
    return await recalculate(id)


async def save_shared_estimates(id: str, estimates: list[SharedFareValues], expected_revision: int):
    trip = get_trip(id)
    if trip["revision"] != expected_revision:
        raise HTTPException(409, "This trip changed. Reload it before saving.")
    component_ids = [key for estimate in estimates for key in estimate.component_ids]
    ids = set(component_ids)
    if len(ids) != len(component_ids):
        raise HTTPException(422, "Fare components must be unique across saved estimates.")
    if any(e.high is not None and e.high < e.low for e in estimates):
        raise HTTPException(422, "Maximum fare must be at least the minimum.")
    result = trip.get("result") or {}
    movements = [*(trip.get("snapshot") or {}).get("movements", []),
                 *(m for route in [*result.get("routes", []), *result.get("dominated_routes", []), *result.get("refinement_routes", [])] for m in route["movements"])]
    charges = {c["id"] for m in movements for c in m.get("charges", [])}
    charges.update(c["id"] for route in [*result.get("routes", []), *result.get("dominated_routes", []), *result.get("refinement_routes", [])] for c in route.get("extra_charges", []))
    known = {m["id"] for m in movements} | charges
    if not ids.issubset(known):
        raise HTTPException(422, "Every fare component must belong to this trip.")
    # Each amount is per component, never a bundle price for their union.
    adults = TripSpec.model_validate(trip["spec"]).adults
    offers = [FareOffer(id="user:"+key, movement_ids=[key], kind="charge" if key in charges else "one-way",
                        low=e.low, high=e.high, currency=e.currency, source="user",
                        adults=adults, estimated=True, label=e.label).model_dump(mode="json")
              for e in estimates for key in e.component_ids]
    def update(record):
        if record["revision"] != expected_revision:
            raise HTTPException(409, "This trip changed. Reload it before saving.")
        replaced = {o["id"] for o in offers}
        record["offers"] = [o for o in record["offers"] if o["id"] not in replaced] + offers
        record["revision"] += 1
        return record
    store.update("trips", id, update)
    return await recalculate(id)


@router.post("/trips/{id}/fares/batch")
async def apply_shared_fare(id: str, request: SharedFareRequest):
    return await save_shared_estimates(id, [request], request.expected_revision)


@router.post("/trips/{id}/fares/estimates")
async def apply_shared_estimates(id: str, request: SharedEstimatesRequest):
    return await save_shared_estimates(id, request.estimates, request.expected_revision)


@router.delete("/trips/{id}/fares/{offer_id}")
async def delete_fare(id: str, offer_id: str):
    get_trip(id)
    store.update("trips", id, lambda t: {**t, "offers": [o for o in t["offers"] if o["id"] != offer_id], "revision": t["revision"]+1})
    return await recalculate(id)


@router.put("/trips/{id}/airport-connections")
async def update_airport_connections(id: str, request: UpdateAirportConnections):
    get_trip(id)
    connections = request.connections
    keys = [(item.from_airport, item.to_airport) for item in connections]
    if len(keys) != len(set(keys)):
        raise HTTPException(422, "Enter each directed airport pair only once.")
    payload = [item.model_dump(mode="json") for item in connections]
    store.update("trips", id, lambda trip: {**trip, "airport_connections": payload,
                                             "revision": trip["revision"]+1})
    return await recalculate(id)


@router.delete("/trips/{id}/movements/{movement_id}")
async def remove_assumed_movement(id: str, movement_id: str, expected_revision: int):
    trip = get_trip(id)
    if trip["revision"] != expected_revision:
        raise HTTPException(409, "Trip changed. Reload before removing a connection.")
    snapshot = trip.get("snapshot") or {}
    movement = next((m for m in snapshot.get("movements", []) if m["id"] == movement_id), None)
    if movement is None or movement.get("source") != "User-defined connection":
        raise HTTPException(404, "Assumed connection not found.")
    snapshot["movements"] = [m for m in snapshot["movements"] if m["id"] != movement_id]
    snapshot["revision"] += 1
    trip["revision"] += 1
    store.put("trips", id, trip)
    store.put("graphs", TripSpec.model_validate(trip["spec"]).discovery_key(), snapshot)
    return await recalculate(id)


@router.post("/trips/{id}/movements", status_code=201)
async def add_assumed_movement(id: str, movement: Movement):
    trip = get_trip(id)
    spec = TripSpec.model_validate(trip["spec"])
    if movement.from_id not in spec.places() or movement.to_id not in spec.places():
        raise HTTPException(422, "An assumed connection must join places in this trip.")
    movement = movement.model_copy(update={"source": "User-defined connection", "assumptions": [*movement.assumptions, "User-defined travel time and connectivity"]})
    snapshot = trip.get("snapshot") or {"revision": 0, "discovery_key": spec.discovery_key(), "movements": [], "offers": [], "roads": {}, "coverage": {"discovery_complete": False}}
    snapshot["movements"] = [m for m in snapshot["movements"] if m["id"] != movement.id]+[movement.model_dump(mode="json")]
    snapshot["revision"] += 1
    trip["snapshot"] = snapshot
    trip["revision"] += 1
    store.put("trips", id, trip)
    store.put("graphs", spec.discovery_key(), snapshot)
    response = await recalculate(id)
    response.status_code = 201
    return response


@router.get("/pricing-rules")
async def list_rules():
    return {"rules": store.list("rules")}


@router.put("/pricing-rules/{id}")
async def edit_rule(id: str, rule: PricingRule):
    rule.id = id
    store.put("rules", id, rule.model_dump(mode="json"))
    for trip in store.list("trips"):
        store.update("trips", trip["id"], lambda t: {**t, "revision": t["revision"]+1})
    return rule


@router.delete("/pricing-rules/{id}")
async def delete_rule(id: str):
    store.delete("rules", id)
    for trip in store.list("trips"):
        store.update("trips", trip["id"], lambda t: {**t, "revision": t["revision"]+1})
    return {"deleted": True}


@router.put("/trips/{id}/airport-transfer-estimates")
async def update_airport_transfer_estimates(id: str, request: UpdateAirportTransfers):
    get_trip(id)
    def update(trip):
        if request.expected_revision != trip["revision"]:
            raise HTTPException(409, "This trip changed. Reload it before saving.")
        spec = TripSpec.model_validate(trip["spec"])
        allowed = {(row["from_id"], row["to_id"]) for row in airport_transfer_rows(spec, (trip.get("snapshot") or {}).get("movements", []))}
        keys = [(item.from_id, item.to_id, item.adults, item.mode) for item in request.estimates]
        if len(keys) != len(set(keys)) or any((a, b) not in allowed for a, b, _, _ in keys):
            raise HTTPException(422, "Enter each method once per airport/city direction and party size, using airports in this trip.")
        trip["airport_transfer_estimates"] = [item.model_dump(mode="json") for item in request.estimates]
        trip["revision"] += 1
        trip.pop("result", None)
        return trip
    updated = store.update("trips", id, update)
    if updated.get("snapshot"):
        await manager.recalculate(id)
    return await read_trip(id, compact=True)
