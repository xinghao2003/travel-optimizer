# Search algorithm

## How a trip is solved

The optimizer searches a finite graph of retrieved journeys. It knows the
required cities, their order when specified, minimum stays, gateways, dates,
commitments, vehicle settings, and budget. It does not know the winning route
in advance. Its two objectives are lower whole-party transport cost and more
hours in the required cities. The result is a Pareto frontier: routes for which
no other route is definitely cheaper with at least as much city time, or gives
more city time at no greater cost.

A label represents a partial itinerary. The search has four phases:

1. Travel from home to an outward gateway.
2. Visit the required cities, in the specified order or any allowed order.
3. Reach a return gateway, optionally revisiting destinations as connections.
4. Travel home, including recovery of an own car when necessary.

Labels carry arrival time, visited-city masks, credited city time, vehicle
state, flight history, and fare information. The solver extends a label only
to a permitted next city and compatible journeys. New labels are pushed to
the front of a deque, so traversal is depth first rather than cheapest first.
It does not first materialize all complete combinations.

Scheduled departures are discrete events. Unscheduled road connections are
instantiated at readiness, connection, and return-boundary events. This is
not an exhaustive search over every possible road departure minute.

The solver rejects infeasible extensions and compares compatible partial
states for dominance. It preserves history distinctions needed for future
bundled tickets and fare uncertainty. An expensive partial itinerary can
later become cheap through a round-trip or multi-city fare. Prices therefore
use exact non-overlapping ticket cover rather than independently selecting
the cheapest fare for each journey. Completed routes receive a final Pareto
filter. All completed flight histories remain eligible to generate combined
ticket queries, including histories whose current prices are dominated.

A label allowance limits work in request mode. Reaching it explicitly returns
an incomplete search; checking more combinations resumes a matching checkpoint
with a larger allowance. [Timed mode](timed-search.md) replaces count allowances
with a round deadline and also checkpoints unfinished work. Changed solver
inputs start a fresh search over the graph. A complete
result applies to the retrieved graph and modeled assumptions, not every
service or ticket available worldwide.

## Backward timetable bound

The solver uses a cached backward calculation of the latest
arrival at an abstract state that could still finish. The abstract state has
the same city, phase, visit/return masks, gateways, and first-visit/revisit
status as the forward search, but excludes prices and individual histories.
Its transition targets are shared with the forward search.

For each possible next state, a scheduled journey qualifies when its arrival
is no later than the next state's deadline. An unscheduled road can leave at
the next deadline minus its duration. The largest qualifying departure,
minus the current minimum stay, is the state's latest possible arrival.
Phase transitions propagate these bounds through the remaining visits and
homeward travel. The bounded state graph is acyclic: visit and return masks
grow, and phase transitions move forward.

This calculation deliberately relaxes commitments, vehicle restrictions,
the exact fixed home date, and road departure windows. Continuous road
departures are a superset of the generated road events. These relaxations
can retain an impossible branch; they cannot make a feasible continuation
look too late. Own-car trips bypass the bound because car recovery can add
an extra stop during phase four. Existing feasibility checks still apply.

The safety argument is backward induction: every actual continuation is
included in the relaxed next-state alternatives. Its departure cannot be
later than the calculated maximum, and the current arrival plus its minimum
stay cannot exceed that departure. Therefore a label later than the bound
cannot finish. Such labels are rejected before ticket pricing. No heuristic
fare estimate or approximate beam cutoff is added.
