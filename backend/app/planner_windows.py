"""Pure optimistic discovery windows shared by the server and browser worker."""
import itertools
from datetime import timedelta
from .planner_optimizer import bounds


def seed_dates(spec):
    days = (spec.end_date-spec.start_date).days
    n = len(spec.visits)+1
    return [spec.start_date+timedelta(days=round(days*i/max(1, n-1))) for i in range(n)]


def visit_return_orders(order):
    """Visit every destination, then optionally revisit each earlier city once."""
    yield order
    for count in range(1, len(order)):
        for suffix in itertools.permutations(order[:-1], count):
            yield (*order, *suffix)


def rough_date_windows(spec):
    """Optimistic pair windows using only minimum stays, with zero travel time.

    Union all gateway/visit orders so a pair remains searchable whenever any
    order might work. Exact schedules, buffers and commitments belong to the DP.
    """
    start, end = bounds(spec)
    # Own-car recovery can introduce detours outside the simple gateway paths.
    if spec.cars.own_enabled:
        return {pair: (start, end) for pair in itertools.permutations(spec.places(), 2)}
    stays = {v.place.id: v.min_stay_hours for v in spec.visits}
    windows = {}
    for order in (path for first in spec.visit_orders() for path in visit_return_orders(first)):
        for departure in spec.departures:
            for arrival in spec.arrivals:
                path = [spec.home.id, departure.id, *(id for id in order if id != departure.id), arrival.id, spec.home.id]
                path = [id for i, id in enumerate(path) if i == 0 or id != path[i-1]]
                unspent = set(stays)
                elapsed = 0
                for a, b in zip(path, path[1:]):
                    if a in unspent:
                        elapsed += stays[a]
                        unspent.remove(a)
                    earliest = start+timedelta(hours=elapsed)
                    latest = end-timedelta(hours=sum(stays[id] for id in unspent))
                    if earliest > latest:
                        continue
                    old = windows.get((a, b), (earliest, latest))
                    windows[a, b] = (min(old[0], earliest), max(old[1], latest))
    return windows
