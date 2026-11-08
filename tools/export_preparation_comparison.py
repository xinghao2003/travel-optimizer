"""Replay public saved graphs through the real Python recalculation path."""
import asyncio
import copy
from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import sys
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT / "backend"), str(ROOT / "backend/tests"), str(ROOT / "tools")]
from app import planner_discovery as discovery
from app.planner_models import AirportConnection, AirportTransferEstimate, FareOffer, Movement, Place, PricingRule, Segment, TripSpec, Visit, stable_id
from app.planner_results import fare_component_ids
from export_solver_comparison import normalized
from test_airport_transfers import AirportTransferTests

NOW = datetime(2027, 2, 11, 12, tzinfo=timezone.utc)


class FrozenDateTime(datetime):
    @classmethod
    def now(cls, tz=None):
        return NOW.astimezone(tz)


class Inputs:
    def __init__(self, trip, rules):
        self.trip, self.rules = copy.deepcopy(trip), copy.deepcopy(rules)

    def get(self, collection, id):
        assert collection == "trips" and id == self.trip["id"]
        return copy.deepcopy(self.trip)

    def put(self, collection, id, value):
        assert collection == "trips" and id == self.trip["id"]
        self.trip = copy.deepcopy(value)

    def list(self, collection):
        assert collection == "rules"
        return copy.deepcopy(self.rules)

    def load_optimizer_checkpoint(self, *_): return None
    def save_optimizer_checkpoint(self, *_): pass


def metadata(trip):
    spec = TripSpec.model_validate(trip["spec"])
    movements = (trip.get("snapshot") or {}).get("movements", [])
    connections = {(c.from_airport, c.to_airport): c for c in map(AirportConnection.model_validate, trip.get("airport_connections", []))}
    components = {m["id"] for m in movements} | {c["id"] for m in movements for c in m.get("charges", [])} | fare_component_ids(trip.get("result"))
    pairs = {(m["from_id"], m["to_id"]) for m in movements}
    return dict(airport_transfer_rows=discovery.airport_transfer_rows(spec, movements),
                airport_connections_required=discovery.required_airport_connections(movements, connections),
                assumed_connections=[m for m in movements if m["source"] == "User-defined connection"], fare_component_ids=sorted(components),
                city_connection_gaps=[dict(from_id=a.place.id, to_id=b.place.id) for i, a in enumerate(spec.visits) for b in spec.visits[i+1:]
                                      if (a.place.id, b.place.id) not in pairs and (b.place.id, a.place.id) not in pairs] if trip.get("snapshot") else [])


async def main():
    fixture = AirportTransferTests()
    fixture.setUp()
    cases = []
    original = discovery.optimize
    for index in range(51):
        spec = fixture.spec.model_copy(deep=True)
        spec.visits[0].min_stay_hours = 1
        if index % 8 == 0:
            spec.visits.extend([Visit(place=Place(id="extra-1", name="Extra One", latitude=35, longitude=139, timezone="Asia/Tokyo", airport_codes=["HND"], flight_code="TYO"), min_stay_hours=2),
                                Visit(place=Place(id="extra-2", name="Extra Two", latitude=51, longitude=-.12, timezone="Europe/London"), min_stay_hours=3)])
        spec.modes = ["flight", "rail", "car", "taxi"] if index % 3 == 0 else ["flight", "rail"]
        if index % 6 == 0:
            spec.cars.own_enabled = True
        elif index % 6 == 3:
            spec.cars.rental_enabled = True
            spec.cars.rental_pickups = [spec.home.id]
            spec.cars.rental_dropoffs = [spec.home.id]
            spec.cars.rental_daily_myr = 20
            spec.cars.rental_cost_per_km = .2
        spec.exclude_unpriced_flights = index % 2 == 0
        spec.rail_fallback.enabled = index % 4 == 0
        if index % 6 == 0:
            spec.home.name = "George's Town \"中心\""
            spec.ordered_visits = True
            spec.home_departure_earliest = datetime.strptime("05:30", "%H:%M").time()
            spec.rail_fallback.reference_date = NOW.date()
        moves = [fixture.flight.model_copy(deep=True)]
        last = Segment(mode="flight", from_id="ICN", to_id="KUL", from_name="ICN", to_name="KUL", departure=datetime(2027, 2, 12, 10, tzinfo=timezone.utc), arrival=datetime(2027, 2, 12, 16, tzinfo=timezone.utc))
        moves.append(discovery.flight_movement(fixture.city, fixture.home, [last.model_dump(mode="json")], fixture.spec, fixture.roads))
        if index % 5 == 0:
            legs = [Segment(mode="flight", from_id="KUL", to_id="GMP", from_name="KUL", to_name="GMP", departure=datetime(2027, 2, 10, 10, tzinfo=timezone.utc), arrival=datetime(2027, 2, 10, 12, tzinfo=timezone.utc), duration_minutes=120),
                    Segment(mode="flight", from_id="ICN", to_id="ICN", from_name="ICN", to_name="ICN", departure=datetime(2027, 2, 10, 14, tzinfo=timezone.utc), arrival=datetime(2027, 2, 10, 16, tzinfo=timezone.utc))]
            moves[0] = discovery.flight_movement(fixture.home, fixture.city, [s.model_dump(mode="json") for s in legs], fixture.spec, {})
        rail = Movement(id="train", from_id=fixture.home.id, to_id=fixture.city.id, mode="rail", departure=datetime(2027, 2, 10, 8, tzinfo=timezone.utc), arrival=datetime(2027, 2, 10, 12, tzinfo=timezone.utc), duration_minutes=240,
                        source="Transitous / MOTIS rail fallback" if index % 3 == 1 else "Transitous / MOTIS",
                        segments=[Segment(mode="rail", from_name="Home", to_name="City", departure=datetime(2027, 2, 10, 9, tzinfo=timezone.utc), arrival=datetime(2027, 2, 10, 11, tzinfo=timezone.utc))])
        moves.append(rail)
        if index % 4 == 0:
            moves.append(rail.model_copy(update={"id": "manual", "source": "User-defined connection"}))
        offers = [FareOffer(id="ticket", movement_ids=[moves[0].id, moves[1].id], low=100, high=100, kind="round-trip", adults=1,
                           retrieved_at=NOW-timedelta(days=1), expires_at=NOW-timedelta(hours=1)).model_dump(mode="json")]
        if index % 2:
            offers[0]["expires_at"] = (NOW+timedelta(hours=1)).isoformat()
        trip = dict(id="public-preparation", revision=3, spec=spec.model_dump(mode="json"), offers=[], latest_job_id=None, snapshot=dict(revision=1, movements=[m.model_dump(mode="json") for m in moves], offers=offers,
                    roads=fixture.roads if index % 2 else {}, coverage={}, discovery_key=spec.discovery_key()))
        if index % 3 == 0:
            trip["snapshot"]["roads"] = {**fixture.roads, "kul->seoul": dict(duration_minutes=120, distance_km=100), "seoul->kul": dict(duration_minutes=150, distance_km=110)}
            if index % 2 == 0:
                discovery.DiscoveryManager(Inputs(trip, [])).ingest({"kind": "road"}, {"roads": trip["snapshot"]["roads"]}, spec, trip["snapshot"])
                trip["snapshot"]["roads"]["kul->seoul"]["duration_minutes"] = 180
        if index % 3:
            trip["airport_transfer_estimates"] = [AirportTransferEstimate.model_validate(item).model_dump(mode="json") for item in fixture.estimates]
            if index % 3 == 2:
                trip["airport_transfer_estimates"].append(AirportTransferEstimate(from_id="kul", to_id="airport:KUL", adults=1, duration_minutes=None, low=25).model_dump(mode="json"))
        if index % 5 == 0:
            trip["airport_connections"] = [AirportConnection(from_airport="GMP", to_airport="ICN", mode="rail", duration_minutes=45 if index % 2 else 150, fare_amount=5).model_dump(mode="json")]
        if index % 4 == 0:
            trip["offers"] = [FareOffer(id="ticket", movement_ids=offers[0]["movement_ids"], kind="round-trip", low=75, high=75, source="user").model_dump(mode="json")]
        if index % 7 == 0:
            trip["snapshot"]["label_limit"] = 1000
            trip["result"] = dict(expanded_labels=30000, routes=[])
        global_rules = [PricingRule(name="Rail estimate", mode="rail", low=2, unit="party").model_dump(mode="json")]
        trip["journey_pricing_rules"] = [PricingRule(id="trip-rule", name="Trip rail", mode="rail", low=3, unit="party", priority=2).model_dump(mode="json")]
        if index % 6 == 1:
            trip["snapshot"]["discovery_key"] = "old-discovery"
        if index >= 48:
            trip["snapshot"] = None
            trip["offers"] = []
            trip.pop("result", None)
        expand, unlimited = index % 3 == 0, index % 4 == 0
        store = Inputs(trip, global_rules)
        captured = {}

        def capture(*args, **kwargs):
            captured.update(normalized(args, kwargs))
            return original(*args, **kwargs)

        with patch.object(discovery, "optimize", capture), patch.object(discovery, "datetime", FrozenDateTime), patch.dict(os.environ, {"PLANNER_LABEL_BATCH": "1000", "PLANNER_SOLVE_BATCH": "1000"}):
            result = await discovery.DiscoveryManager(store).recalculate(trip["id"], expand=expand, include_dominated=index % 2 == 0, continuous=unlimited)
        expected_snapshot = store.trip["snapshot"]
        cases.append(dict(name=f"preparation-{index}", trip=trip, rules=global_rules,
                          options=dict(expand=expand, unlimited=unlimited, include_dominated=index % 2 == 0, now=int(NOW.timestamp()*1e6), label_batch=1000, expansion_budget=1000),
                          expected_input=captured, expected_snapshot=expected_snapshot, expected_result=result, expected_metadata=metadata(store.trip),
                          expected_airport_places={key: value.model_dump(mode="json") for key, value in discovery.airport_places(spec).items()},
                          expected_discovery_key=TripSpec.model_validate(trip["spec"]).discovery_key()))
    corpus = json.loads((ROOT / "frontend/tests/fixtures/native-solver.json").read_text(encoding="utf-8"))
    keys = [dict(spec=item["input"]["spec"], expected=TripSpec.model_validate(item["input"]["spec"]).discovery_key()) for item in corpus["cases"]+corpus["generated"]]
    hash_cases = []
    for value in [0., -0., .000001, .0001, 1e16, 2.675, 999.99]:
        estimate = AirportTransferEstimate(from_id="home", to_id="airport:KUL", adults=1, low=value).model_dump(mode="json")
        hash_cases.append(dict(value=[estimate], expected=stable_id([estimate])))
    airports = {code: {key: row[key] for key in ("name", "lat", "lon", "tz")} for code, row in discovery.iata_airports().items()}
    catalog = dict(airports=airports, metros={code: list(row.get("airports", {})) for code, row in discovery.iata_metros().items()})
    path = ROOT / "frontend/tests/fixtures/native-preparation.json"
    path.write_text(json.dumps(dict(cases=cases, discovery_keys=keys, hash_cases=hash_cases, catalog=catalog), separators=(",", ":"), allow_nan=False), encoding="utf-8")
    print(json.dumps(dict(preparation_cases=len(cases), discovery_keys=len(keys))))


if __name__ == "__main__":
    asyncio.run(main())
