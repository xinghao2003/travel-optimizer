"""Event-based multi-objective DP and exact, non-overlapping ticket cover.

No cost pruning is performed between histories with different bundle eligibility
or uncertain fare components. Discovery can add offers and rerun this DP from the
persisted graph; a previous frontier is never used as the next search space.
"""
from __future__ import annotations

import math
import logging
import time as clock
from collections import defaultdict, deque
from bisect import bisect_right
from dataclasses import dataclass, replace
from datetime import datetime, time, timedelta, timezone
from decimal import Decimal, ROUND_HALF_UP
from functools import lru_cache
from zoneinfo import ZoneInfo

from .planner_models import Charge, FareOffer, Movement, PricingRule, TripSpec, stable_id

logger = logging.getLogger("uvicorn.error")

UTC = timezone.utc
INF = float("inf")


def cents(value: float) -> int:
    return int((Decimal(str(value))*100).quantize(Decimal("1"), rounding=ROUND_HALF_UP))


def bounds(spec: TripSpec):
    zone = ZoneInfo(spec.home.timezone)
    start = datetime.combine(spec.start_date, time.min, zone).astimezone(UTC)
    end = datetime.combine(spec.end_date+timedelta(days=1), time.min, zone).astimezone(UTC)-timedelta(microseconds=1)
    return start, end


def _amount(offer: FareOffer, spec: TripSpec):
    rate = spec.exchange_rates.get(offer.currency)
    if offer.low is None or rate is None:
        return 0, INF
    return cents(offer.low*rate), cents(offer.high*rate) if offer.high is not None else INF


def _rule_offer(component: str, movement: Movement, distance, mode, spec, rules, charge=None):
    places = spec.places()
    names = {s.service for s in movement.segments} | {s.operator for s in movement.segments}
    origin = charge.from_id if charge and charge.from_id else movement.from_id
    destination = charge.to_id if charge and charge.to_id else movement.to_id
    country = charge.country_code if charge and charge.country_code else places[movement.from_id].country_code
    if charge:
        names.add(charge.kind)
    matches = [r for r in rules if (r.mode in {"*", mode})
               and (r.from_id is None or r.from_id == origin)
               and (r.to_id is None or r.to_id == destination)
               and (r.service is None or r.service in names)
               and (r.country_code is None or r.country_code == country)
               and (r.kind != "per-km" or distance is not None)]
    if not matches:
        return None
    rule = max(matches, key=lambda r: (r.priority, sum(x is not None for x in (r.from_id, r.to_id, r.service, r.country_code)), r.mode != "*", r.id))
    multiplier = spec.adults if rule.unit == "person" else math.ceil(spec.adults/rule.capacity) if rule.unit == "vehicle" else 1
    multiplier *= distance if rule.kind == "per-km" else 1
    return FareOffer(id="rule:"+rule.id+":"+component, movement_ids=[component],
                     low=round(rule.low*multiplier, 2), high=round((rule.high if rule.high is not None else rule.low)*multiplier, 2),
                     currency=rule.currency, source="rule", estimated=True, label=rule.name)


def price_path(path: list[Movement], offers: list[FareOffer], spec: TripSpec,
               rules: list[PricingRule], extra: list[Charge] | None = None) -> dict:
    offers = [o for o in offers if o.adults is None or o.adults == spec.adults]
    components: dict[str, tuple[Movement, Charge | None]] = {}
    for m in path:
        components[m.id] = (m, None)
        components.update({c.id: (m, c) for c in m.charges})
    if path:
        components.update({c.id: (path[-1], c) for c in extra or []})
    keys = list(components)
    indexes = {id: i for i, id in enumerate(keys)}
    choices: list[tuple[int, FareOffer, int, float]] = []
    diagnostics = []
    for id, (movement, charge) in components.items():
        direct = [o for o in offers if o.validated and o.movement_ids == [id]]
        if charge is None and movement.template_id:
            direct += [o.model_copy(update={"id": o.id+":"+id, "movement_ids": [id]}) for o in offers if o.validated and o.movement_ids == [movement.template_id]]
        overrides = [o for o in direct if o.source == "user"]
        if overrides:
            direct = overrides[-1:]
        elif not any(o.low is not None for o in direct):
            rule = _rule_offer(id, movement, charge.distance_km if charge else movement.distance_km,
                               charge.mode if charge else movement.mode, spec, rules, charge)
            if charge and charge.source == "user" and charge.low is not None:
                direct = [FareOffer(id="charge:"+id, movement_ids=[id], kind="charge", low=charge.low,
                                    high=charge.high, currency=charge.currency, source="user", estimated=True, label=charge.kind)]
            elif rule:
                direct = [rule]
            elif charge and charge.low is not None:
                direct = [FareOffer(id="charge:"+id, movement_ids=[id], kind="charge", low=charge.low,
                                    high=charge.high, currency=charge.currency, source="rule", estimated=True, label=charge.kind)]
            elif movement.mode == "car" and charge is None:
                car = spec.cars
                rate = car.own_cost_per_km if movement.vehicle_kind == "own" else car.rental_cost_per_km
                count = 1 if movement.vehicle_kind == "own" else math.ceil(spec.adults/car.rental_capacity)
                if rate is not None and movement.distance_km is not None:
                    value = round(rate*movement.distance_km*count, 2)
                    direct = [FareOffer(id="driving:"+id, movement_ids=[id], low=value, high=value,
                                        source="rule", estimated=True, label="Configured driving cost")]
        if not direct:
            direct = [FareOffer(id="unknown:"+id, movement_ids=[id], source="unknown", label=charge.kind if charge else movement.mode)]
        for offer in direct:
            lo, hi = _amount(offer, spec)
            choices.append((1 << indexes[id], offer, lo, hi))
        if all(_amount(o, spec)[1] == INF for o in direct):
            diagnostics.append({"component_id": id, "movement_id": movement.id,
                                "label": charge.kind if charge else movement.mode,
                                "from_id": movement.from_id, "to_id": movement.to_id,
                                "currency": direct[0].currency,
                                "reason": "exchange_rate" if direct[0].low is not None and direct[0].currency not in spec.exchange_rates else "missing_fare"})
    for offer in offers:
        if not offer.validated or len(offer.movement_ids) < 2 or not set(offer.movement_ids).issubset(indexes):
            continue
        mask = sum(1 << indexes[id] for id in offer.movement_ids)
        lo, hi = _amount(offer, spec)
        choices.append((mask, offer, lo, hi))
    by_bit = defaultdict(list)
    for option in choices:
        for i in range(len(keys)):
            if option[0] & (1 << i):
                by_bit[i].append(option)

    @lru_cache(None)
    def cover(mask):
        if mask == (1 << len(keys))-1:
            return 0, 0, ()
        bit = next(i for i in range(len(keys)) if not mask & (1 << i))
        candidates = []
        for covered, offer, lo, hi in by_bit[bit]:
            if mask & covered:
                continue
            lower, upper, selected = cover(mask | covered)
            candidates.append((lo+lower, hi+upper, (offer.id, *selected)))
        best = min(candidates, key=lambda x: (x[1], x[0], x[2]))
        return min(x[0] for x in candidates), best[1], best[2]

    lower, upper, selected = cover(0)
    chosen = [o for _, o, _, _ in choices if o.id in selected]
    unknown = tuple(sorted({id for id in keys if any(d["component_id"] == id for d in diagnostics)} |
                           {o.id for _, o, lo, hi in choices if lo != hi}))
    return {"low_cents": lower, "high_cents": upper, "total_cost_myr": lower/100 if lower == upper else None,
            "cost_low_myr": lower/100, "cost_high_myr": upper/100 if upper != INF else None,
            "estimated": any(o.estimated or o.source == "rule" or o.currency != "MYR" for o in chosen),
            "purchases": [o.model_dump(mode="json") for o in chosen],
            "missing": diagnostics if upper == INF else [], "uncertainty_key": unknown}


def _window(value, place, spec, backwards=False):
    local = value.astimezone(ZoneInfo(place.timezone))
    start = datetime.combine(local.date(), spec.departure_start, local.tzinfo)
    end = datetime.combine(local.date(), spec.departure_end, local.tzinfo)
    if backwards:
        if local > end:
            local = end
        elif local < start:
            local = datetime.combine(local.date()-timedelta(days=1), spec.departure_end, local.tzinfo)
    else:
        if local < start:
            local = start
        elif local > end:
            local = datetime.combine(local.date()+timedelta(days=1), spec.departure_start, local.tzinfo)
    return local.astimezone(UTC)


def _overnight(movement, spec):
    if spec.allow_overnight:
        return False
    zone = ZoneInfo(spec.places()[movement.from_id].timezone)
    start = movement.departure.astimezone(zone)
    end = movement.arrival.astimezone(zone)
    # Overnight is explicitly defined as crossing midnight in the departure zone.
    return start.date() != end.date()


@dataclass
class Label:
    city: str
    phase: int
    mask: int
    arrival: datetime
    path: list[Movement]
    stays: list[dict]
    reward: bool = False
    own_location: str = ""
    own_used: bool = False
    rental_pickup: str | None = None
    rental_start: datetime | None = None
    charges: tuple[Charge, ...] = ()
    departure_gateway: str = ""
    arrival_gateway: str = ""
    price: dict | None = None


def optimize(spec: TripSpec, movements: list[Movement], offers: list[FareOffer], rules: list[PricingRule],
             snapshot_revision: int = 0, trip_revision: int = 0, cancelled=None, label_limit: int | None = None,
             finish_at_home: bool = True) -> dict:
    started = clock.monotonic()
    next_progress = started + 5
    logger.debug("planner dp.start movements=%d offers=%d limit=%s", len(movements), len(offers), label_limit)
    start, end = bounds(spec)
    places = spec.places()
    required = {v.place.id: (i, v.min_stay_hours) for i, v in enumerate(spec.visits)}
    full_mask = (1 << len(required))-1
    edges = defaultdict(list)
    for m in movements:
        if m.usable and m.from_id in places and m.to_id in places and m.mode in spec.modes:
            if spec.max_transfers is None or m.transfers <= spec.max_transfers:
                flights = [s for s in m.segments if s.mode == "flight"]
                if any((b.departure.astimezone(UTC)-a.arrival.astimezone(UTC)).total_seconds() < spec.timing.connection_minutes*60 for a, b in zip(flights, flights[1:]) if a.arrival and b.departure):
                    continue
                riding = [s for s in m.segments if s.mode not in {"walk", "foot", "wait", "transfer"}]
                if m.source == "Transitous / MOTIS" and any(not b.interline_with_previous and (b.departure.astimezone(UTC)-a.arrival.astimezone(UTC)).total_seconds() < spec.timing.connection_minutes*60 for a, b in zip(riding, riding[1:]) if a.arrival and b.departure):
                    continue
                edges[m.from_id, m.to_id].append(m)
    events = defaultdict(set)
    for m in movements:
        if m.departure:
            events[m.from_id].add(m.departure.astimezone(UTC))
    for c in spec.commitments:
        events[c.place_id].update((c.start.astimezone(UTC), c.end.astimezone(UTC)))
    events[spec.home.id].add(end)
    # Propagate event deadlines through the two positioning connectors. Required
    # road visits can wait at the city; their waiting time is credited on exit.
    for _ in range(2):
        additions = defaultdict(set)
        for m in movements:
            if m.departure is None:
                minimum = required.get(m.to_id, (0, 0))[1]
                for value in events[m.to_id]:
                    additions[m.from_id].add(value-timedelta(minutes=m.duration_minutes, hours=minimum))
        for id, values in additions.items():
            events[id].update(values)
    bundle_ids = {id for o in offers if o.validated and len(o.movement_ids) > 1 for id in o.movement_ids}
    queue = deque()
    for gateway in spec.departures:
        mask = (1 << required[gateway.id][0]) if gateway.id in required and gateway.id == spec.home.id else 0
        queue.append(Label(spec.home.id, 0, mask, start, [], [], own_location=spec.home.id,
                           departure_gateway=gateway.id))
    labels = defaultdict(list)
    completed = []
    expanded = 0
    pruned = 0

    def rental_close(label, at):
        if label.rental_pickup is None:
            return label
        if label.city not in spec.cars.rental_dropoffs:
            return None
        days = max(1, math.ceil((at-label.rental_start).total_seconds()/86400))
        cars = math.ceil(spec.adults/spec.cars.rental_capacity)
        daily = spec.cars.rental_daily_myr
        drop = 0 if label.city == label.rental_pickup else spec.cars.rental_one_way_myr
        value = None if daily is None or drop is None else round((daily*days+spec.cars.rental_pickup_myr+drop)*cars, 2)
        charge = Charge(id="rental:"+stable_id(label.rental_pickup, label.rental_start, label.city, at),
                        kind=f"Rental: {days} day(s), pickup and drop-off", mode="rental", low=value, high=value, source="rule",
                        from_id=label.rental_pickup, to_id=label.city, country_code=places[label.rental_pickup].country_code)
        return replace(label, rental_pickup=None, rental_start=None, charges=(*label.charges, charge))

    def add(label):
        nonlocal pruned
        label.price = price_path(label.path, offers, spec, rules, list(label.charges))
        if "flight" not in spec.modes and not bundle_ids and spec.budget_myr is not None and label.price["low_cents"] > cents(spec.budget_myr):
            return
        bundle_history = tuple((m.from_id, m.to_id, next((s.departure for s in m.segments if s.mode == "flight" and s.departure), m.departure).astimezone(ZoneInfo(places[m.from_id].timezone)).date().isoformat(), m.id if m.id in bundle_ids else None)
                               for m in label.path if m.mode == "flight")
        # Rental timing is part of future eligibility, not just a display field.
        key = (label.city, label.phase, label.mask, label.reward, label.own_location, label.own_used,
               label.rental_pickup, label.rental_start, label.departure_gateway, label.arrival_gateway,
               bundle_history, label.price["uncertainty_key"])
        bucket = labels[key]

        def dominates(a, b):
            if a.arrival > b.arrival:
                return False
            # An earlier arrival can wait to imitate a later one. City time
            # is credited on exit, so compare both at b's arrival instant.
            sa = sum(s["hours"] for s in a.stays)+(b.arrival-a.arrival).total_seconds()/3600*int(a.reward)
            sb = sum(s["hours"] for s in b.stays)
            same_uncertain = a.price["uncertainty_key"] == b.price["uncertainty_key"] and bool(a.price["uncertainty_key"])
            cost_ok = (a.price["low_cents"] <= b.price["low_cents"] and a.price["high_cents"] <= b.price["high_cents"]) if same_uncertain else a.price["high_cents"] <= b.price["low_cents"]
            # Finite ranges on different offers are not interchangeable.
            if not same_uncertain and (a.price["low_cents"] != a.price["high_cents"] or b.price["low_cents"] != b.price["high_cents"]):
                cost_ok = a.price["high_cents"] <= b.price["low_cents"]
            return cost_ok and sa >= sb-1e-8

        if any(dominates(old, label) for old in bucket):
            pruned += 1
            return
        bucket[:] = [old for old in bucket if not dominates(label, old)]
        bucket.append(label)
        queue.appendleft(label)

    while queue:
        if (cancelled and cancelled()) or (label_limit is not None and expanded >= label_limit):
            break
        label = queue.popleft()
        expanded += 1
        if clock.monotonic() >= next_progress:
            logger.debug("planner dp.progress expanded=%d pending=%d completed=%d pruned=%d elapsed=%.2fs", expanded, len(queue), len(completed), pruned, clock.monotonic()-started)
            next_progress = clock.monotonic()+5
        if label.phase == 0 and label.city == label.departure_gateway:
            mask = label.mask | ((1 << required[label.city][0]) if label.city in required else 0)
            add(replace(label, phase=1, mask=mask, reward=label.city in required))
            continue
        if label.phase == 1 and label.mask == full_mask:
            if not finish_at_home:
                minimum = required[label.city][1] if label.reward else 0
                commitments = [c for c in spec.commitments if c.place_id == label.city]
                if label.arrival+timedelta(hours=minimum) > end or any(label.arrival > c.start.astimezone(UTC) or end < c.end.astimezone(UTC) for c in commitments):
                    continue
                stays = [*label.stays, {"place_id": label.city, "arrival": label.arrival.isoformat(), "departure": end.isoformat(), "hours": (end-label.arrival).total_seconds()/3600}]
                closed = rental_close(replace(label, stays=stays, reward=False, arrival=end), end)
                if closed is not None and (not closed.own_used or closed.own_location == spec.home.id):
                    closed.price = price_path(closed.path, offers, spec, rules, list(closed.charges))
                    completed.append(closed)
                continue
            for gateway in spec.arrivals:
                add(replace(label, phase=2, arrival_gateway=gateway.id))
            continue
        if label.phase == 2 and label.city == label.arrival_gateway:
            add(replace(label, phase=3))
            continue
        if label.phase == 3 and label.city == spec.home.id and (not label.own_used or label.own_location == spec.home.id):
            if not label.path:
                continue
            closed = rental_close(label, label.arrival)
            if closed is None:
                continue
            home_date = closed.arrival.astimezone(ZoneInfo(spec.home.timezone)).date()
            if spec.date_mode == "fixed" and home_date != spec.end_date:
                continue
            closed.price = price_path(closed.path, offers, spec, rules, list(closed.charges))
            completed.append(closed)
            continue
        targets = ([label.departure_gateway] if label.phase == 0 else
                   [id for id, (i, _) in required.items() if not label.mask & (1 << i)] if label.phase == 1 else
                   [label.arrival_gateway] if label.phase == 2 else
                   [id for id in dict.fromkeys([spec.home.id, *([label.own_location] if label.own_used and label.own_location != spec.home.id else [])]) if id != label.city])
        minimum = required[label.city][1] if label.reward else 0
        ready = label.arrival+timedelta(hours=minimum)
        commitments = [c for c in spec.commitments if c.place_id == label.city] if label.reward else []
        if any(label.arrival > c.start.astimezone(UTC) for c in commitments):
            continue
        ready = max([ready, *(c.end.astimezone(UTC) for c in commitments)])
        for target in targets:
            for template in edges[label.city, target]:
                if label.phase == 3 and label.own_used and label.own_location == label.city != spec.home.id and target == spec.home.id and template.vehicle_kind != "own":
                    continue
                if template.vehicle_kind == "own" and (not spec.cars.own_enabled or label.own_location != label.city or spec.adults > spec.cars.own_capacity):
                    continue
                if template.vehicle_kind == "rental" and not spec.cars.rental_enabled:
                    continue
                if template.departure:
                    candidates = [template]
                else:
                    duration = timedelta(minutes=template.duration_minutes)
                    times = {_window(ready, places[label.city], spec), _window(end-duration, places[label.city], spec, True)}
                    for event in events[target]:
                        times.add(_window(event-duration-timedelta(hours=required.get(target, (0, 0))[1]), places[label.city], spec, True))
                    candidates = [template.model_copy(update={"id": template.id+"@"+stable_id(t), "template_id": template.id, "departure": t, "arrival": t+duration}) for t in sorted(times) if t >= ready]
                for movement in candidates:
                    dep, arr = movement.departure.astimezone(UTC), movement.arrival.astimezone(UTC)
                    if dep < ready or arr > end or dep < start or _overnight(movement, spec):
                        continue
                    service = next((s.departure for s in movement.segments if s.mode not in {"transfer", "walk", "foot", "wait"} and s.departure), dep)
                    local = service.astimezone(ZoneInfo(places[movement.from_id].timezone)).time().replace(tzinfo=None)
                    if not spec.departure_start <= local <= spec.departure_end:
                        continue
                    if not label.path and spec.date_mode == "fixed" and dep.astimezone(ZoneInfo(spec.home.timezone)).date() != spec.start_date:
                        continue
                    current = label
                    if current.rental_pickup is not None and movement.vehicle_kind != "rental":
                        current = rental_close(current, dep)
                        if current is None:
                            continue
                    rental_pickup, rental_start = current.rental_pickup, current.rental_start
                    if movement.vehicle_kind == "rental" and rental_pickup is None:
                        if current.city not in spec.cars.rental_pickups:
                            continue
                        rental_pickup, rental_start = current.city, dep
                    stays = current.stays
                    if current.reward:
                        stays = [*stays, {"place_id": current.city, "arrival": current.arrival.isoformat(),
                                         "departure": dep.isoformat(), "hours": (dep-current.arrival).total_seconds()/3600}]
                    reward = current.phase == 1 and target in required
                    mask = current.mask | ((1 << required[target][0]) if reward else 0)
                    add(Label(target, current.phase, mask, arr, [*current.path, movement], stays,
                              reward=reward, own_location=target if movement.vehicle_kind == "own" else current.own_location,
                              own_used=current.own_used or movement.vehicle_kind == "own", rental_pickup=rental_pickup,
                              rental_start=rental_start, charges=current.charges,
                              departure_gateway=current.departure_gateway, arrival_gateway=current.arrival_gateway))

    logger.debug("planner dp.search.done expanded=%d pending=%d completed=%d elapsed=%.2fs", expanded, len(queue), len(completed), clock.monotonic()-started)

    def stay(label):
        return sum(s["hours"] for s in label.stays)

    # A sorted prefix maximum answers robust two-objective dominance in
    # O(log n) per label, including fare intervals. Avoid an O(n^2) final pass.
    # Apply after whole-ticket pricing: a bundle or manual fare can price a
    # flight that has no standalone provider quote. Keep discovery data intact.
    selectable = completed
    if spec.exclude_unpriced_flights:
        selectable = [x for x in completed if
            {m.id for m in x.path if m.mode == "flight"}.issubset({
                id for offer in x.price["purchases"]
                if offer["low"] is not None and offer["high"] is not None
                and offer["currency"] in spec.exchange_rates
                for id in offer["movement_ids"]
            })]
    eligible = [x for x in selectable if spec.budget_myr is None or x.price["low_cents"] <= cents(spec.budget_myr)]
    over_budget = sorted((x for x in selectable if spec.budget_myr is not None and x.price["low_cents"] > cents(spec.budget_myr)), key=lambda x: (x.price["low_cents"], -stay(x)))[:10]
    finite = sorted((x for x in eligible if x.price["high_cents"] != INF), key=lambda x: x.price["high_cents"])
    highs, best_stays, best_prices = [], [], []
    best_stay, best_price = -INF, INF
    for x in finite:
        if stay(x) > best_stay:
            best_stay, best_price = stay(x), x.price["high_cents"]
        highs.append(x.price["high_cents"])
        best_stays.append(best_stay)
        best_prices.append(best_price)
    frontier = []
    for x in eligible:
        i = bisect_right(highs, x.price["low_cents"])-1
        dominated = i >= 0 and (best_stays[i] > stay(x)+1e-8 or (best_stays[i] >= stay(x)-1e-8 and best_prices[i] < x.price["low_cents"]))
        if not dominated:
            frontier.append(x)
    # Preserve different transport choices with tied objectives, deduplicate exact
    # histories that can arise when the same place serves as both gateways.
    unique = {}
    for label in [*frontier, *over_budget]:
        id = stable_id([(m.id, m.departure) for m in label.path], label.departure_gateway, label.arrival_gateway)
        unique[id] = label
    logger.debug("planner dp.serialize.start frontier=%d elapsed=%.2fs", len(unique), clock.monotonic()-started)
    results = []
    missing = {}
    for id, label in unique.items():
        price = label.price
        total_stay = stay(label)
        for item in price["missing"]:
            entry = missing.setdefault(item["component_id"], {**item, "affected_itineraries": 0, "break_even_myr": None})
            entry["affected_itineraries"] += 1
            thresholds = [y.price["high_cents"]/100-price["cost_low_myr"] for y in frontier
                          if y.price["high_cents"] != INF and stay(y) <= total_stay+1e-8]
            if thresholds:
                entry["break_even_myr"] = round(max(thresholds), 2)
        results.append({"id": id, "departure_gateway": label.departure_gateway, "arrival_gateway": label.arrival_gateway,
                        "movements": [m.model_dump(mode="json") for m in label.path], "stays": label.stays,
                        "stay_hours": round(total_stay, 4), "travel_hours": round(sum(m.duration_minutes for m in label.path)/60, 4),
                        "total_cost_myr": price["total_cost_myr"], "cost_low_myr": price["cost_low_myr"],
                        "cost_high_myr": price["cost_high_myr"], "estimated": price["estimated"],
                        "purchases": price["purchases"], "extra_charges": [c.model_dump(mode="json") for c in label.charges],
                        "budget_status": "over" if spec.budget_myr is not None and price["low_cents"] > cents(spec.budget_myr) else "uncertain" if spec.budget_myr is not None and (price["high_cents"] == INF or price["high_cents"] > cents(spec.budget_myr)) else "within",
                        "provisional": price["total_cost_myr"] is None,
                        "cost_per_stay_hour_myr": round(price["total_cost_myr"]/total_stay, 2) if price["total_cost_myr"] is not None and total_stay > 0 else None})
    results.sort(key=lambda r: (r["provisional"], r["cost_low_myr"], -r["stay_hours"], r["id"]))
    bundle_candidates = {}
    for label in completed:
        flights = [m for m in label.path if m.mode == "flight"]
        if len(flights) >= 2:
            ids = tuple(m.id for m in flights)
            bundle_candidates[ids] = [m.model_dump(mode="json") for m in flights]
    logger.debug("planner dp.done routes=%d bundles=%d elapsed=%.2fs", len(results), len(bundle_candidates), clock.monotonic()-started)
    return {"routes": [r for r in results if r["budget_status"] != "over"], "refinement_routes": [r for r in results if r["budget_status"] == "over"], "bundle_candidates": list(bundle_candidates.values()), "missing_fares": sorted(missing.values(), key=lambda x: (-x["affected_itineraries"], -(x["break_even_myr"] or 0), x["component_id"])),
            "expanded_labels": expanded, "pruned_labels": pruned, "feasible_count": len(completed),
            "optimization_complete": not bool(queue), "remaining_labels": len(queue), "label_limit": label_limit, "snapshot_revision": snapshot_revision, "trip_revision": trip_revision,
            "optimality_scope": "Retrieved schedules, fare offers, and road departures at readiness / connection / return-boundary events"}
