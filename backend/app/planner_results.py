"""Lossless sharing of repeated route objects for storage and optional wire responses."""
from __future__ import annotations

GROUPS = ("routes", "dominated_routes", "refinement_routes")
FIELDS = ("movements", "purchases", "extra_charges")
MARKER = "_shared_route_data"


def compact_result(result):
    if not isinstance(result, dict) or MARKER in result:
        return result
    packed = dict(result)
    pools = {field: [] for field in FIELDS}
    variants = {field: {} for field in FIELDS}
    identities = {field: {} for field in FIELDS}

    def intern(field, value):
        identity = id(value)
        if identity in identities[field]:
            return identities[field][identity]
        # IDs normally identify the same object. Preserve distinct versions too,
        # such as the same fare appearing with a different stale-quote label.
        choices = variants[field].setdefault(value.get("id"), [])
        for index in choices:
            if pools[field][index] == value:
                identities[field][identity] = index
                return index
        index = len(pools[field])
        pools[field].append(value)
        choices.append(index)
        identities[field][identity] = index
        return index

    for group in GROUPS:
        if group not in result:
            continue
        packed[group] = []
        for route in result[group]:
            row = dict(route)
            for field in FIELDS:
                if field in row:
                    row[field] = [intern(field, value) for value in row[field]]
            packed[group].append(row)
    packed[MARKER] = {"version": 1, **pools}
    return packed


def expand_result(result):
    if not isinstance(result, dict) or MARKER not in result:
        return result
    expanded = {k: v for k, v in result.items() if k != MARKER}
    pools = result[MARKER]
    if pools.get("version") != 1:
        raise ValueError("Unsupported shared route format")
    for group in GROUPS:
        if group in result:
            expanded[group] = [{**route, **{field: [pools[field][index] for index in route[field]]
                                         for field in FIELDS if field in route}} for route in result[group]]
    return expanded


def compact_trip(trip):
    return {**trip, "result": compact_result(trip["result"])} if trip.get("result") is not None else trip


def expand_trip(trip):
    return {**trip, "result": expand_result(trip["result"])} if trip.get("result") is not None else trip
