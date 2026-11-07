# Search algorithm and CPU experiments

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

The November 7 follow-up adds a cached backward calculation of the latest
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

## CPU use and process experiment

The current v2 discovery job fetches, ingests, persists, and periodically
awaits optimization in sequence. Network waits are asynchronous or run in
worker threads. Provider concurrency semaphores are ceilings; they do not
make this one-job loop issue concurrent tasks automatically. Different trip
jobs can overlap.

One complete optimization is dispatched with `asyncio.to_thread`. The active
Python 3.13.17 build has its GIL enabled. It keeps the entire search in one
worker thread; it does not distribute labels across CPU cores. Recorded
solver CPU time is approximately equal to wall time, about one core's worth
of execution on this 10-core/12-logical-processor laptop. The scheduler can
move that thread between cores. Store operations also use a process-local
lock. The development server uses reload, not multiple API workers.

The algorithm can be partitioned. An offline two-process prototype searches
each departure gateway independently, then merges best routes. The current
trip's partitions expanded 44,379 and 85,500 labels. Three warm-pool trials
had median serial/parallel times of 1.981s/1.550s (21.8% less). The first
parallel solve took 2.097s versus 1.922s serial because of worker startup and
initialization. Best routes, combined-ticket query sets, and completed-history
counts matched in all four trials.

This is a prototype, not the API execution path. Production integration still
requires global allowance/cancellation handling and global missing-fare and
refinement diagnostics. Per-partition filtering alone is insufficient for
those outputs. Windows process startup, copied inputs and caches, extra memory,
and unequal partition sizes limit speedup. Adding API workers or updating
Python alone does not parallelize one solve. Provider concurrency was not
changed.

## Isolated runtime screening

Python 3.14.9 and 3.15.1 were installed only under ignored diagnostic files,
with the same 28 package versions as the active Python 3.13.17 environment.
Each cell is the median of three fresh-process solves, run sequentially in
forward/reverse/forward order with `PYTHONHASHSEED=0`. The candidate in this
screen is the initial timetable-bound prototype; the production form shares
target selection and uses an explicit unreachable-state value.

| Runtime | Current HEAD before this change | Timetable prototype |
| --- | ---: | ---: |
| Python 3.13.17 | 3.745s | 2.064s |
| Python 3.14.9 | 4.143s | 2.300s |
| Python 3.15.1 | 3.595s | 1.968s |

All runtime variants returned identical complete solver responses for the
same source. Python 3.15 gained about 4.7% on the prototype, while 3.14 was
slower. These are small samples without thermal/system-activity control.
Python 3.13 remains the configured and active runtime; provider behavior on
the newer runtimes was not tested live. No free-threaded runtime was adopted.

## Whole-workflow replay

A fresh sequential comparison of the preceding implementation (`0187bc1`)
and the production timetable bound measured **157.235s → 118.211s** of local
processing: 39.024s less, or **24.8%**. This is an additional reduction after
the earlier optimization round, not a comparison against the original solver.

| Replay stage | Preceding implementation | Timetable bound |
| --- | ---: | ---: |
| First discovery batch | 74.950s | 58.629s |
| Mid-search fare update | 2.399s | 1.535s |
| Continued discovery | 60.703s | 55.023s |
| Final fare update | 3.088s | 2.785s |
| Further allowance increases | 15.587s across four solves | None needed |
| Total solves | 43 | 39 |

Both runs consumed the same 186 recorded outcomes in the same order, ended
with 1,537 movements and 2,387 snapshot offers, and produced identical final
solutions after excluding coverage, revisions, search counters, and allowance
metadata. Both performed 37 discovery-triggered solves. The improvement is
less work per solve and avoiding four later recomputations, rather than fewer
discovery queries or a new provider policy.

Provider elapsed scopes totaling 292.81 seconds advance the cadence clock
without waiting; provider processing and user pauses are excluded from these
local timings. The replay uses the retained shared graph and recorded tasks.
Intermediate manual-fare edit history was not saved: it applies the current
first 26 fares at the recorded pause and all 60 after discovery. This is a
controlled offline replay, not a new live-search measurement. The comparison
was run once per implementation; thermal and other system activity were not
controlled. Evidence is in `baseline-result.json`, `temporal-result.json`,
`summary.json`, and `workflow.log` in the algorithm diagnostic directory.

## Validation and reproduction

The final matched six-process comparison on Python 3.13.17 measured median
solver time **3.745s → 2.075s (44.6% less)** and median peak process working
set **384.5 → 238.6 MiB (38.0% less)**. Input loading is outside solver timing;
memory includes the entire process. Full-response hashes differ because work
counters changed; the solution hash is identical in all six runs:
`6e8ae97561ffd4d8bd3ef21ff0fcb2a267041ea595f87816d8595976ad4ce002`.
Evidence is in `final-matrix.json` and `final-matrix-summary.json`.

The saved trip retains all ten best routes and 39,140 completed histories.
Expanded labels decrease from 254,075 to 129,879 (48.9%). A differential
corpus of 1,000 generated trips uses one to four cities, ordered/unordered
visits, multiple gateways, timezones, fixed/flexible dates, minimum stays,
commitments, unknown/ranged fares, bundles, aliases, roads, rental settings,
and own-car settings. All complete business outputs match the preceding
solver, including dominated-route output in the generated cases. Only work
counters and allowance metadata are excluded from comparison.

Regression tests cover rejection before pricing, connection/minimum-stay
equality, generated road departures, and own-car recovery through a different
gateway. The existing regressions cover nested return visits, bundled fares,
commitments, timezones, positioning, and persistence.
The final production suite passed **108 tests**. SQLite ResourceWarnings
remain in the existing persistence tests; there were no test failures.

Matched allowances of 5,000, 25,000, 50,000, 100,000, and 150,000 labels also
passed a route-quality check: every preceding best route was retained or
matched/dominated by a candidate best route. At 150,000 labels the preceding
solver found 23,414 completed histories but remained incomplete; the candidate
finished all 39,140 histories after 129,879 labels. Its cheapest route was
RM2,326.50 versus RM2,600.50 in the incomplete preceding run, with the same
184.7667 city hours. Complete solves still return the same optimum. These
allowance-specific observations are evidence for this saved trip, not a
guarantee for every future incomplete search. Evidence is in `capped.json`.

Diagnostic scripts, private snapshots, runtime environments, and JSON evidence
are under `data/diagnostics/2026-11-07-algorithm/`. They make no new provider
requests. The workflow replay uses copied SQLite databases and explicitly
blocks external socket connections. Saved live trips are not rewritten.

`tools/benchmark_optimizer.py` reports both a full-response hash and a solution
hash that excludes expanded/pruned/remaining label counts and label allowance.
This allows search-work changes to be compared while still checking every
route, fare diagnostic, ticket query, completeness flag, and revision field.
Use fresh processes, fixed inputs, and the same hash seed. To reproduce a
comparison, preserve the preceding optimizer source before changing it:

```powershell
$env:PYTHONHASHSEED = "0"
uv run python tools/benchmark_optimizer.py --database backend/data/planner.sqlite3 --optimizer-source path/to/baseline.py
uv run python tools/benchmark_optimizer.py --database backend/data/planner.sqlite3
```

Use `--label-limit` for a matched allowance. Compare solution hashes only for
complete solves; an incomplete run can legitimately contain a better frontier
after the same amount of search work. Timings exclude provider work, and
whole-workflow results must be measured separately from single-solve results.
