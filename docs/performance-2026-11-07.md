# Planner optimization experiments, November 7, 2026

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

## Rejected or unfinished directions

- **Whole-path and movement-component caches:** screened and rejected. They preserved results but were slower; the accepted implementation does not retain an additional path-price cache.
- **Repeated recalculation:** cost-based batching is accepted above. Persistent solver-state continuation across changing graphs remains a larger design option; the implemented change retains complete recalculation semantics.
- **Persistence:** under investigation. Jobs are about 5 MB and rewritten per processed task. One final publication performed two graph and three trip writes. Measure serialization/checkpoint work and remove redundant writes while retaining durable collected work and current revision checks.
- **Provider throughput:** under investigation. Query operations historically took 293 seconds; 17 round-trip tasks made 178 conditional-return calls. Explore bounded overlap with existing provider limits and stable ordering. Preserve request budgets, coverage, cancellation, and deadline behavior.
- **State cardinality:** compact storage is measured above. Stronger pruning remains an experiment requiring evidence that merged states have the same future bundle eligibility and fare uncertainty. Most existing dominance buckets are singleton; faster dominance comparisons alone have little measured headroom.

## Scope of the measurements

These are solver measurements, not a new live-search comparison. Query waiting, network caching, repeated solves, publication, and persistence have separate costs. The historical 701.9-second job span includes a 181.3-second gap between batches, including one standalone recalculation; it is not all active processing time. Individual historical write durations and peak memory cannot be recovered from those logs. Keep measured results separate from replay estimates or simulations.
