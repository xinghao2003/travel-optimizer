from __future__ import annotations

import asyncio
from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from .planner_discovery import manager
from .planner_models import FareOffer, Movement, PricingRule, TripSpec
from .planner_places import search_places
from .planner_store import store

router = APIRouter(prefix="/api/v2")


class UpdateTrip(BaseModel):
    spec: TripSpec
    expected_revision: int


class SearchRequest(BaseModel):
    budget: int = Field(default=100, ge=1, le=500)


class OptimizationRequest(BaseModel):
    expand: bool = False


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
    return store.new_trip(spec.model_dump(mode="json"))


@router.get("/trips/{id}")
async def read_trip(id: str, include_graph: bool = False):
    trip = get_trip(id)
    if not include_graph and trip.get("snapshot"):
        trip["snapshot"] = {k: v for k, v in trip["snapshot"].items() if k not in {"movements", "roads"}} | {"movements": []}
    return trip


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
    return store.update("trips", id, update)


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
    result = await manager.recalculate(id, expand=request.expand)
    result.pop("bundle_candidates", None)
    return result


@router.put("/trips/{id}/fares/{offer_id}")
async def edit_fare(id: str, offer_id: str, offer: FareOffer):
    trip = get_trip(id)
    if offer.id != offer_id:
        raise HTTPException(422, "Offer ID must match its URL.")
    snapshot = trip.get("snapshot") or {}
    known = {m["id"] for m in snapshot.get("movements", [])}
    known.update(m["id"] for r in trip.get("result", {}).get("routes", []) for m in r["movements"])
    known.update(c["id"] for m in snapshot.get("movements", []) for c in m.get("charges", []))
    known.update(c["id"] for r in trip.get("result", {}).get("routes", []) for c in r.get("extra_charges", []))
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


@router.delete("/trips/{id}/fares/{offer_id}")
async def delete_fare(id: str, offer_id: str):
    get_trip(id)
    store.update("trips", id, lambda t: {**t, "offers": [o for o in t["offers"] if o["id"] != offer_id], "revision": t["revision"]+1})
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
    return await recalculate(id)


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
