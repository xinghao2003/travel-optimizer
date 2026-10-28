"""Trip-scoped supplied services and provider search policies for positioning."""
from .planner_models import FareOffer, Movement, Segment, TripSpec

SUPPLIED_SOURCE = "User-supplied positioning"


def pair_policies(spec: TripSpec, a: str, b: str, direction: str | None = None):
    return [p for p in spec.positioning_policies if
            (direction is None or p.direction == direction) and
            ((p.direction == "outbound" and a == spec.home.id and b == p.gateway_id) or
             (p.direction == "return" and a == p.gateway_id and b == spec.home.id))]


def search_modes(spec: TripSpec, a: str, b: str):
    blocked = {p.mode for p in pair_policies(spec, a, b) if not p.available or not p.search_more}
    return [m for m in spec.modes if m not in blocked]


def positioning_allowed(spec: TripSpec, movement: Movement, phase: int):
    # Supplied positioning services cannot be reused as destination travel.
    direction = "outbound" if phase == 0 else "return" if phase == 3 else None
    if movement.positioning_direction and movement.positioning_direction != direction:
        return False
    if movement.source == SUPPLIED_SOURCE:
        service = next((s for s in spec.positioning_services if movement.id == "positioning:"+s.id), None)
        if service is None or service.direction != direction:
            return False
    if direction is None:
        return True
    used_modes = {movement.mode} | {s.mode for s in movement.segments if s.mode not in {"walk", "foot", "wait", "transfer"}}
    for p in pair_policies(spec, movement.from_id, movement.to_id, direction):
        if p.mode in used_modes and (not p.available or
                (not p.search_more and movement.source not in {SUPPLIED_SOURCE, "User-defined connection", "User-supplied transport"})):
            return False
    return True


def supplied_positioning(spec: TripSpec):
    places = spec.places()
    movements, offers = [], []
    for service in spec.positioning_services:
        a, b = (spec.home.id, service.gateway_id) if service.direction == "outbound" else (service.gateway_id, spec.home.id)
        id = "positioning:"+service.id
        movements.append(Movement(id=id, from_id=a, to_id=b, mode=service.mode,
            departure=service.departure, arrival=service.arrival,
            duration_minutes=(service.arrival-service.departure).total_seconds()/60,
            source=SUPPLIED_SOURCE, segments=[Segment(mode=service.mode, from_id=a, to_id=b,
                from_name=places[a].name, to_name=places[b].name,
                from_timezone=places[a].timezone, to_timezone=places[b].timezone,
                departure=service.departure, arrival=service.arrival, service=service.label,
                source=SUPPLIED_SOURCE)], assumptions=["User supplied city-to-city schedule; onward airport access and flight buffers are separate."]))
        if service.fare_amount is not None:
            offers.append(FareOffer(id="positioning-fare:"+service.id, movement_ids=[id],
                low=service.fare_amount, high=service.fare_amount, currency=service.currency,
                source="user", adults=spec.adults, label=service.label+" · whole party"))
    return movements, offers
