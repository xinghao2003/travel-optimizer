# Native TypeScript and Python solver comparison

Open <http://127.0.0.1:5174/solver-comparison.html> while the prototype runner is
active. Both implementations are retained in this worktree. No deployment or
provider request is involved in a solver comparison.

The next work is defined in the [complete static-client migration plan](static-migration-plan.md).
Correctness and feature parity govern migration acceptance; RAM and timing
measurements below are informational.

The worktree was fast-forwarded to main **2525466** before final comparison.
The existing Python `planner_optimizer.py` is unchanged from that commit. The
TypeScript port includes its new reusable journey-price scopes and priorities.

## Use

Use **Run both solvers** for the built-in example, or import a graph exported
from the search prototype. A full original trip record with a snapshot, or an
explicit solver input (`spec`, `movements`, `offers`, `rules`), is also accepted.
When comparing a prepared solver input, both workers get precisely those inputs.
Importing an original trip is not a replacement for all original server-side
preprocessing of airport-transfer variants and other overlays.

**Run TypeScript only** downloads no Pyodide runtime. The native code runs in its
own Web Worker, independently of the Python reference. **Run Python only** uses
the original solver in a separate Pyodide worker. Workers are reused between
button presses, but each timed solve starts a fresh search. **Stop** terminates
the comparison workers. Live search in the original prototype page still uses
its Python normalization and solver; this page isolates the native solver for
evaluation rather than claiming a fully migrated native application.

Request elapsed includes initialization on first use. Solver time includes its
graph preprocessing, search, and result construction; Python input validation
is recorded separately. The comparison checks routes, fares, generated IDs,
diagnostics, bundle opportunities, completion, and work counters. Money fields
must match exactly; non-money floating calculations permit an absolute tolerance
below `1e-8`.

## Ported behavior

The TypeScript implementation follows the Python solver's control flow and
preserves:

- Exact non-overlapping ticket cover, aliases, fare ranges, missing exchange
  rates, party/vehicle units, reusable journey-price scopes, and manual overrides.
- Pareto label dominance with flight histories and fare uncertainty, backward
  timetable feasibility bounds, and complete-route filtering.
- Gateway choice, ordered/unordered visits, return revisits, commitments,
  positioning services/policies, own-car recovery, and rental pickup/drop-off.
- Timezone-local boundaries and departure windows, overnight rules, elapsed
  stays, and generated road events.
- Partial allowances, cooperative deadlines, and resumable state. Native state
  uses structured-clone-compatible objects and Maps rather than Python pickle.
- Result details, missing-fare thresholds, budget refinement routes, optional
  weaker routes, and combined-ticket query candidates.

The port uses integer microseconds, Temporal for timezone handling, explicit
decimal rounding, and SHA-256-compatible generated IDs. It remains experimental;
passing comparisons does not establish equivalence for every possible input,
timezone database version, or future Python feature.

## Measured results

The saved-trip input contained **1,762 journeys and 2,952 fare offers**. All six
browser runs returned matching full responses: **767,388 expanded states,
435,039 pruned states, 234,524 complete candidates, and seven best options**.

| Metric, median of three fresh-browser trials | Native TypeScript | Python / Pyodide |
| --- | ---: | ---: |
| Solver time | 11.29 s | 40.98 s |
| Worker request elapsed, including first-use startup | 11.41 s | 45.53 s |
| Retained Chromium working-set increase after forced GC | 984 MiB | 746 MiB |

The TypeScript port was about **3.63 times faster** for solver time on this
input. Its current implementation used a larger retained browser working set.
This is one input on one laptop, with three sequential trials and alternating
order; CPU placement, temperature, and unrelated system activity were not
controlled. An initial separate sample was faster for both runtimes, so the
absolute times should not be treated as universal. Browser memory readings are
not unique physical memory or a peak-heap measurement. Mobile suitability is
not established for either implementation by these results.

The production native worker is **219,179 bytes minified**, or **69,484 bytes
with gzip**, including its timezone, decimal, and hashing dependencies. It
avoids the roughly 16 MB of uncompressed Pyodide runtime/package asset files.
These are solver-asset sizes, not complete application downloads; actual
network transfer depends on HTTP compression and caching.

The native solver matched **71 captured solver calls, 20 direct pricing calls,
and 200 deterministic generated cases**. Native checkpoint continuation and
changed-input invalidation passed. The full worktree passed **143 backend tests,
seven browser workflow tests**, and the TypeScript/production build. Existing
SQLite ResourceWarnings remain in passing backend persistence tests.

## Validation and reproduction

`tools/export_solver_comparison.py` executes 47 existing tests, captures 71
solver calls and 20 direct pricing calls, and adds 200 deterministic generated
trips across one to four cities, timezones including DST, visit order, budgets,
fare uncertainty, and bundles. The generated public-case JSON is ignored and
regenerated by `npm run test:poc`, so it cannot silently become the reference
for an outdated Python implementation.

Browser tests compare every captured response, test native checkpoint
structured-clone/resumption and invalidation, and verify that TypeScript runs
without loading Python before both independent workers are compared.

To export a private saved trip's exact prepared solver inputs, read its database
without modifying it:

```powershell
uv run python tools/export_solver_comparison.py --database path/to/planner.sqlite3
$env:POC_PYODIDE_CACHE = (Resolve-Path data/diagnostics/pyodide-runtime/runtime).Path
node tools/benchmark_browser_solvers.cjs 3
```

The Pyodide-cache variable is optional; it serves previously downloaded public
runtime files locally under their normal URLs. The experiment's measurements
exclude real internet transfer delay. Private inputs, expected outputs, browser
measurements, and screenshots stay below ignored
`data/diagnostics/native-comparison/`. Each trial launches fresh Chromium and
the order alternates. Benchmark memory is the sum of Chromium process working
sets with solver checkpoints retained, before and after forced garbage
collection. It is neither peak heap nor unique physical memory; shared pages
can be counted more than once.
