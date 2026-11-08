"""Generate native JSON-contract references using current Pydantic models."""
import copy
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT / "backend"), str(ROOT / "backend/tests")]
from app import planner_models as models


def main():
    cases = []

    def case(name, model, data):
        try:
            expected = model.model_validate(data).model_dump(mode="json")
            valid = True
        except ValueError:
            expected, valid = None, False
        cases.append(dict(name=name, model=model.__name__, input=copy.deepcopy(data), valid=valid, expected=expected))

    def variants(name, model, data, changes):
        case(name, model, data)
        for i, patch in enumerate(changes):
            case(f"{name}-{i}", model, {**copy.deepcopy(data), **patch})
        case(f"{name}-extra", model, {**copy.deepcopy(data), "extra_field": True})
        case(f"{name}-constructor", model, {**copy.deepcopy(data), "constructor": "invalid"})

    place = dict(id="home", name="Home", latitude=3, longitude=101, timezone="Asia/Kuala_Lumpur")
    city = {**place, "id": "city", "name": "City"}
    spec = dict(home=place, visits=[dict(place=city)], start_date="2027-02-10", end_date="2027-02-12")
    variants("place", models.Place, place, [dict(latitude=91), dict(longitude=-181), dict(timezone="Bad/Zone"), dict(id=""), dict(latitude="3.14")])
    variants("spec", models.TripSpec, spec, [dict(adults="3", allow_overnight="false"), dict(adults=10), dict(end_date="2026-01-01"),
        dict(end_date="2028-02-12"), dict(modes=[]), dict(visits=[dict(place=place)]), dict(visits=[dict(place=city), dict(place=city)]),
        dict(departure_start="17:00", departure_end="09:00"), dict(departures=[place, place]), dict(timing=dict(transit_after_minutes=121)),
        dict(exchange_rates=dict(USD=4.5, MYR=2)), dict(exchange_rates=dict(USD=0)), dict(commitments=[dict(place_id="elsewhere", start="2027-02-10T10:00:00Z", end="2027-02-10T12:00:00Z")]),
        dict(positioning_services=[dict(id="s", direction="outbound", gateway_id="home", mode="bus", departure="2027-02-10T10:00:00Z", arrival="2027-02-10T12:00:00Z")]),
        dict(positioning_policies=[dict(direction="outbound", gateway_id="elsewhere", mode="rail")]), dict(cars=dict(own_capacity=0)), dict(rail_fallback=dict(max_shift_days=6)),
        dict(timing=dict(airport_transfer_fallback_minutes=None)), dict(budget_myr=-1), dict(start_date="2027-02-31"),
        *[dict(adults=value) for value in ["3e0", "0x3", "3_0", "3.0", "03", "__3", "3_", " 3 "]],
        dict(start_date="2027-02-10T00:00:00Z"), dict(start_date="2027-02-10T00:00:00+08:00"), dict(start_date=1802217600)])
    segment = dict(mode="rail", from_name="A", to_name="B")
    variants("segment", models.Segment, segment, [dict(departure="2027-02-10T10:00:00+08:00"), dict(departure="2027-02-10 10:00:00.123456"),
        dict(departure=1800000000), dict(departure=1800000000000), dict(duration_minutes=-1), dict(assumed="yes"),
        dict(departure="2027-02-10"), dict(departure="1800000000")])
    charge = dict(id="c", kind="Fare")
    variants("charge", models.Charge, charge, [dict(low=-1), dict(high=1), dict(low=2, high=1), dict(currency="anything"), dict(distance_km="2.75")])
    movement = dict(id="m", from_id="home", to_id="city", mode="rail", duration_minutes=5, source="fixture")
    variants("movement", models.Movement, movement, [dict(departure="2027-02-10T10:00:00+08:00", arrival="2027-02-10T12:00:00+08:00"),
        dict(departure="2027-02-10T10:00:00Z"), dict(departure="2027-02-10T10:00:00", arrival="2027-02-10T12:00:00"),
        dict(departure="2027-02-10T12:00:00Z", arrival="2027-02-10T10:00:00Z"), dict(duration_minutes=0), dict(mode="walk"), dict(transfers=1.5)])
    offer = dict(id="o", movement_ids=["m"])
    variants("offer", models.FareOffer, offer, [dict(movement_ids=[]), dict(movement_ids=["m", "m"]), dict(low=1, high=2, currency="usd"), dict(high=2),
        dict(low=2, high=1), dict(low=-1), dict(adults=0), dict(currency="US"), dict(retrieved_at="2027-02-10T12:00:00Z"),
        *[dict(low=value) for value in ["1e2", "0x3", "3_0", "3.0", ".25", "__3", "3_", " 3 "]]])
    scope = dict(from_id="a", to_id="b", mode="rail", adults=1, group_by=["time", "stations"], values=dict(time='"10:00"', stations='["a","b"]'))
    variants("scope", models.JourneyPriceScope, scope, [dict(group_by=["stations", "stations"]), dict(values={}), dict(adults=10)])
    rule = dict(name="Fare", low=2)
    variants("rule", models.PricingRule, rule, [dict(high=1), dict(high=3), dict(currency="usd"), dict(journey_scope=scope), dict(capacity=10), dict(unit="person"), dict(priority=-1)])
    connection = dict(from_airport="kul", to_airport="sin", mode="rail", duration_minutes=30)
    variants("connection", models.AirportConnection, connection, [dict(to_airport="KUL"), dict(duration_minutes=0), dict(mode="flight"), dict(fare_amount=-1)])
    transfer = dict(from_id="home", to_id="airport:KUL", adults=1)
    variants("transfer", models.AirportTransferEstimate, transfer, [dict(mode="rail"), dict(mode="rail", duration_minutes=30), dict(high=3), dict(low=2, high=1), dict(duration_minutes=0), dict(currency="usd")])

    # Normalized solver corpus inputs also exercise every currently captured
    # positioning, timing, vehicle, journey-scope, and pricing configuration.
    corpus = json.loads((ROOT / "frontend/tests/fixtures/native-solver.json").read_text(encoding="utf-8"))
    for i, item in enumerate(corpus["cases"] + corpus["generated"]):
        case(f"solver-envelope-{i}", models.SolverInput, item["input"])
        case(f"solver-spec-{i}", models.TripSpec, item["input"]["spec"])
        for model, key in [(models.Movement, "movements"), (models.FareOffer, "offers"), (models.PricingRule, "rules")]:
            for j, data in enumerate(item["input"][key]):
                case(f"solver-{key}-{i}-{j}", model, data)
    minimal_input = dict(spec=spec, movements=[movement], offers=[offer])
    variants("envelope", models.SolverInput, minimal_input, [dict(schema_version=2), dict(expansion_budget=0), dict(label_limit=-1),
        dict(trip_revision=-1), dict(finish_at_home="false"), dict(snapshot_revision="3")])
    path = ROOT / "frontend/tests/fixtures/native-contracts.json"
    path.write_text(json.dumps(dict(cases=cases), separators=(",", ":"), allow_nan=False), encoding="utf-8")
    print(json.dumps(dict(cases=len(cases), invalid=sum(not item["valid"] for item in cases))))


if __name__ == "__main__":
    main()
