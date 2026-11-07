# Planner optimization experiments, November 7, 2026

Follow-up algorithm, CPU partitioning, and Python runtime experiments are in
[Search algorithm and CPU experiments](optimizer-algorithm.md). The timings
below describe the preceding optimization round.

The experiments use a consistent backup of the latest saved trip, **My trip (copy)** (`909b34008f0a415192cba454c9195fdc`). It has 1,537 saved scheduled movements, 2,447 solver offers, and a complete solve of 254,075 labels. The result has ten best routes and 39,140 completed histories. Original source baseline: `926c99a`.

The database, logs, scratch variants, function profiles, and per-run JSON are local artifacts under the Git-ignored `data/diagnostics/` directory. User trip data is not committed. No new provider search is needed for solver experiments. Each accepted solver change must reproduce the complete optimizer response on fixed inputs, plus the relevant regressions and generated pricing comparisons.

## Accepted changes

| Experiment | Matched fresh-process median wall time | Peak working set | Validation |
| --- | --- | --- | --- |
| Direct two-journey ticket index | 4.911s → 4.208s (14.3% less) | 415.4 → 415.8 MiB | Identical complete response; 97 backend tests; 4,000 differential pricing comparisons |
| Single-choice pricing, compact labels, deferred stay formatting | 4.089s → 3.442s (15.8% less) | 415.8 → 371.6 MiB (10.6% less) | Identical complete response; 98 backend tests; 4,000 differential pricing comparisons |

Each row is a separate comparison against the preceding implementation, rather than a comparison across machine sessions. Run order was baseline/candidate/candidate/baseline/baseline/candidate, with fresh Python processes, Python 3.13.17, and `PYTHONHASHSEED=0`. Input normalization and module loading were outside the timed solver call. Process CPU and peak process working set were also recorded. The Windows laptop has a Core 7 150U; thermals and other system activity were not controlled. These results describe this case, not a universal speed guarantee.

The pair index retrieves tickets for the journey pairs actually present in a path, preserving original offer ordering, aliases, and non-overlapping cover. It reduced function calls from 21.25 million to 12.17 million. A fast branch for components with one fare choice avoids reconstructing the chosen-offer set. Slotted labels reduce retained object memory. Stay timestamps remain datetime references during search and become ISO strings only when returning routes, including open-ended itineraries.

Local evidence: `2026-11-07-path-pricing/` and `2026-11-07-solver-state/`, each under `data/diagnostics/`. The state experiment verifies that the production AST matches the benchmarked candidate; source formatting/comments differ. Test logs contain SQLite ResourceWarnings but no failures.

## Recalculation cadence

The fixed five-second threshold could stop batching after the solver became faster, causing more frequent complete recalculation. The accepted policy batches solves taking at least one second until elapsed work outside the last solve matches that solve's cost, with a maximum of sixteen queries between solves. Coverage is still published every four queries. Final publication, manual trip/rule edits, and changed solver allowances bypass batching; sub-second solves retain the four-query interval.

A controlled publication replay used the real complete solver and SQLite copies, with eight changes to a fare and a simulated 1.2 seconds of provider work per publication. The old policy performed eight solves in 36.92 seconds of actual replay work; the new policy performed four solves in 20.74 seconds. The final solver response was identical. This is evidence for the scheduling policy on a controlled workload, not a new live-search speed measurement. Evidence is in `data/diagnostics/2026-11-07-publication/`. The final suite passed 99 tests, including the sub-five-second case, elapsed-time trigger, sixteen-query cap, final flushing, and user-edit bypass.

## Rejected experiments and larger design options

- **Whole-path and movement-component caches:** screened and rejected. They preserved results but were slower; the accepted implementation does not retain an additional path-price cache.
- **Repeated recalculation:** cost-based batching is accepted above. Persistent solver-state continuation across changing graphs remains a larger design option; the implemented change retains complete recalculation semantics.
- **Persistence:** settings-only reads and shared-graph normalization reuse are accepted below. Compact JSON was rejected as a latency optimization: it reduced JSON characters about 6.4%, but a three-record write/read round trip did not become faster. Per-query durable job checkpoints are retained.
- **Provider throughput:** speculative concurrency was screened and not applied because it changes the amount of provider work under the same time window. Connection reuse is accepted below.
- **State cardinality:** compact storage is measured above. Stronger pruning was not applied: merging histories requires proof of equal future bundle eligibility and fare uncertainty. With 99.4% singleton buckets and less than 1% profile time in dominance comparisons, changing the comparison data structure has little measured headroom. The accepted memory change preserves all state distinctions.

## Storage and publication processing

Discovery's per-query superseding check now reads only `spec` from SQLite rather than decoding a roughly 5.7-million-character trip record. On a private copy, twelve reads per method had median times of 28.9 ms for the full record and 12.2 ms for the spec projection. SQLite still parses the stored JSON; the improvement avoids materializing the graph/results in Python. `json_extract` returns a nested object as JSON text, as documented by [SQLite](https://www.sqlite.org/json1.html). No schema migration is needed.

A publication now builds the trip-independent shared graph once, then updates its coverage metadata before the final cache write. Both existing graph writes and all job checkpoints remain, preserving collected work before a potentially long solve. The shared graph's separately normalized unresolved-movement list is retained. A controlled replay with a fixed real solver response produced identical payloads for every database record, reducing shared normalization calls from two to one (0.326s to 0.162s in the sample). Total publication work in that sample was 1.14s versus 0.96s; this is a stage sample, not a general latency claim. Evidence is in `data/diagnostics/2026-11-07-publication/`. The full suite passed 101 tests.

## Provider transport

The initial flight query and its conditional-return pages now share one scoped HTTP client through the documented [fast-flights FetchIntegration](https://github.com/aweirddev/flights/blob/dev/_autodocs/api-reference/fetcher.md). Browser settings match pinned fast-flights 3.1.0; primp 2.0.1 is now declared directly and no installed package versions changed. Client cleanup is scoped to each query. Calls remain serial within a round-trip task, retain the existing global request semaphore and 25-second follow-up window, and preserve conditional whole-ticket fare validation. Diagnostics now distinguish initial and return request counts/times; cache hits do not count those historical calls as new requests in the query log.

A local HTTP/1.1 experiment made six requests with six fresh clients versus one reused client, observing six connections versus one and identical responses. Its synthetic 40 ms per-connection setup cost is not Internet latency. A scaled-deadline concurrency experiment checked three choices serially versus nine with three workers in the same window, demonstrating the change in provider work. The conservative implementation keeps serial requests.

A bounded read-only live pilot made three calls with fresh clients and three with a reused client: one initial page and the same two conditional-return selections in each case. Both returned 21 initial rows and 19 return rows per selection, with identical compared schedule/price fingerprints. This sample verifies integration behavior; it is too small and order-sensitive for a general live speed claim. No live trip or provider-cache records were written. The full backend suite passed 104 tests, including client sharing, cleanup after failure, selected-query parameters, conditional fares, and the serial deadline. Local evidence is in `data/diagnostics/2026-11-07-provider/`.

## Final solver comparison and reproduction

The final matched six-process comparison against original `926c99a` measured a median **4.528s → 3.334s** (26.4% less solver wall time) and approximately **416.0 → 371.5 MiB** peak working set. All complete responses had SHA-256 `bc818a6130a729ff2bd0191c1dc4b3ff717c75d0627e4fa1acbc1c8fca01b812`, expanded 254,075 labels, completed the graph, and returned the same ten routes. This comparison measures the combined solver changes directly; percentages from separate experiments are not multiplied. The optional weaker-route response was also compared at a matched 25,000-label allowance.

`tools/benchmark_optimizer.py` reads a selected or latest trip and its rules from a consistent read-only transaction, prepares solver inputs without provider calls or database writes, and reports full-response hashes, wall/process CPU time, and peak process memory. Use separate processes with a fixed hash seed for comparisons; repeated runs in one process share allocator and cache state. Peak memory includes the entire process. The tool itself was exercised with the original and final optimizer and produced the same full-response hash.

```powershell
$env:PYTHONHASHSEED = "0"
uv run python tools/benchmark_optimizer.py --database backend/data/planner.sqlite3 --output data/diagnostics/optimizer-current.json
# --trip-id selects another saved trip; --optimizer-source loads a preserved optimizer module.
# --label-limit and --include-dominated support matched alternative workloads.
# --profile writes cProfile data; do not compare profiled latency with ordinary runs.
```

The five explored workstreams have recorded outcomes: path-pricing indexes/choice handling, recalculation cadence, storage/publication processing, provider transport/concurrency, and intermediate-label memory. Accepted changes have regression coverage and focused commits; slower or policy-changing variants are retained only as diagnostic evidence.

## Scope of the measurements

These are solver measurements, not a new live-search comparison. Query waiting, network caching, repeated solves, publication, and persistence have separate costs. The historical 701.9-second job span includes a 181.3-second gap between batches, including one standalone recalculation; it is not all active processing time. Individual historical write durations and peak memory cannot be recovered from those logs. Keep measured results separate from replay estimates or simulations.
