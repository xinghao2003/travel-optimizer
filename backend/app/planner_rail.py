"""Bounded, opt-in rail timetable sampling; no country-specific feed logic."""
from __future__ import annotations

import copy
import math
from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from .planner_models import stable_id

UTC = timezone.utc
PASSIVE_MODES = {"WALK", "FOOT", "WAIT", "TRANSFER"}
RAIL_FALLBACK_SOURCE = "Transitous / MOTIS rail fallback"


def fallback_task(task, spec, today):
    """Schedule one request at a time so pause/cancel/budgets apply to probes too.

    The public API has no per-route coverage interval. Sampling is explicitly
    opted into, never presented as proof that the requested date is uncovered.
    """
    from .planner_positioning import search_modes
    settings = spec.rail_fallback
    if (not settings.enabled or task.get("cursor")
            or "rail" not in search_modes(spec, task["from_id"], task["to_id"])):
        return None
    target = date.fromisoformat(task["date"])
    if not task.get("rail_radius"):
        # Station access can be missing even when the actual-date trains exist.
        dates = []
        if target > today + timedelta(days=14):
            anchor = settings.reference_date or today
            first = anchor + timedelta(days=(target.weekday() - anchor.weekday()) % 7)
            dates = sorted((first + timedelta(weeks=i) for i in range(3)),
                           key=lambda d: (abs((target-d).days), d))
            dates = [d.isoformat() for d in dates
                     if d != target and abs((target-d).days) <= settings.max_shift_days]
        next_task = {"kind": "transit", "from_id": task["from_id"], "to_id": task["to_id"],
                     "date": task["date"], "rail_radius": True, "rail_reference_dates": dates}
    else:
        dates = task.get("rail_reference_dates", [])
        index = task.get("rail_sample_index", -1) + 1
        if index >= len(dates):
            return None
        next_task = {k: v for k, v in task.items() if k not in {"key", "outcome"}}
        next_task.update(rail_sample_index=index, rail_reference_date=dates[index])
    next_task["key"] = stable_id("rail-fallback-v1", next_task)
    return next_task


def parse_time(value):
    if isinstance(value, (int, float)):
        return datetime.fromtimestamp(value, UTC)
    parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError("Timetable timestamps must include a timezone")
    return parsed.astimezone(UTC)


def _distance(a, b):
    try:
        lat1, lat2 = math.radians(float(a["lat"])), math.radians(float(b["lat"]))
        dlon = math.radians(float(b["lon"])-float(a["lon"]))
        h = math.sin((lat2-lat1)/2)**2 + math.cos(lat1)*math.cos(lat2)*math.sin(dlon/2)**2
        return 6371000*2*math.asin(min(1, math.sqrt(h)))
    except (KeyError, ValueError, TypeError):
        return None


def prepare_rail_payload(payload, task, origin):
    """Use scheduled times and preserve elapsed durations across timezone changes.

    Never carry historical realtime delays or fare products to a different date.
    Radius routing must include nonzero access time for nontrivial distances.
    """
    reference = task.get("rail_reference_date")
    if not task.get("rail_radius"):
        return payload
    result = {"itineraries": []}
    for original in payload.get("itineraries", []):
        try:
            item = copy.deepcopy(original)
            legs = item["legs"]
            riding = [leg for leg in legs if leg["mode"] not in PASSIVE_MODES]
            if not riding:
                continue
            for leg in legs:
                for actual, scheduled in (("startTime", "scheduledStartTime"), ("endTime", "scheduledEndTime")):
                    leg[actual] = leg.get(scheduled) or leg[actual]
                start, end = parse_time(leg["startTime"]), parse_time(leg["endTime"])
                if end < start:
                    raise ValueError("Invalid timetable interval")
                if leg["mode"] in {"WALK", "FOOT"} and end == start:
                    distance = _distance(leg.get("from", {}), leg.get("to", {}))
                    if distance is None or distance > 100:
                        raise ValueError("Station access time was not supplied")
            delta = timedelta()
            if reference:
                local = parse_time(riding[0]["startTime"]).astimezone(ZoneInfo(origin.timezone))
                if local.date().isoformat() != reference:
                    continue
                target = date.fromisoformat(task["date"])
                shifted = local.replace(year=target.year, month=target.month, day=target.day)
                # Skip ambiguous/nonexistent wall times rather than inventing a DST policy.
                if (shifted.replace(fold=0).utcoffset() != shifted.replace(fold=1).utcoffset()
                        or shifted.astimezone(UTC).astimezone(shifted.tzinfo).replace(tzinfo=None) != shifted.replace(tzinfo=None)):
                    continue
                delta = shifted.astimezone(UTC)-local.astimezone(UTC)
            previous_end = None
            for leg in legs:
                start = parse_time(leg["startTime"])+delta
                end = parse_time(leg["endTime"])+delta
                if previous_end is not None and start < previous_end:
                    raise ValueError("Overlapping timetable legs")
                previous_end = end
                leg.update(startTime=start.isoformat(), endTime=end.isoformat(),
                           scheduledStartTime=start.isoformat(), scheduledEndTime=end.isoformat())
                if reference:
                    leg.pop("loopedCalendarSince", None)
            item.update(startTime=legs[0]["startTime"], endTime=legs[-1]["endTime"])
            if reference:
                item.pop("fareTransfers", None)
            result["itineraries"].append(item)
        except (KeyError, TypeError, ValueError, OverflowError):
            continue
    return result
