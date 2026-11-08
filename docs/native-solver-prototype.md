# Native TypeScript and Python solver comparison

Open <http://127.0.0.1:5174/solver-comparison.html> while the prototype runner is
active. Both implementations are retained in this worktree. No deployment or
provider request is involved in a solver comparison.

The next work is defined in the [complete static-client migration plan](static-migration-plan.md).
Correctness and feature parity govern migration acceptance; RAM and timing
measurements below are informational.

The worktree includes local and remote main **9571a88** through merge
**b3705e6**. Both implementations now also correct the priced-bundle/unknown-access
case described in [the native preview](native-planner.md); Python remains an
independent reference implementation with its own regression test.
The native port includes reusable journey-price scopes, fair branch scheduling,
early flight-price eligibility, and relative per-call expansion budgets.

## Use

Use **Run both solvers** for the built-in example, or import a graph exported
from the search prototype. A full original trip record with a snapshot, or an
explicit solver input (`spec`, `movements`, `offers`, `rules`), is also accepted.
When comparing a prepared solver input, both workers get precisely those inputs.
Saved-trip imports now run native input preparation first: current timing,
airport-change connections, airport-transfer alternatives, road/vehicle inputs,
manual fare precedence, trip rules, and stale quotes. Supply separately stored
global pricing rules in the record's `rules` field too; a trip record alone
does not contain those rules. Both solver workers receive the prepared result.

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
diagnostics, bundle opportunities, completion, and work counters. Both workers
validate the version-1 solver-input contract, and record validation separately
from solver time. Money fields
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
- Weighted fair scheduling across first-journey branches and price tiers,
  complete-ticket-aware flight filtering, and per-call safety budgets.
- Result details, missing-fare thresholds, budget refinement routes, optional
  weaker routes, and combined-ticket query candidates.

The port uses integer microseconds, Temporal for timezone handling, explicit
decimal rounding, and SHA-256-compatible generated IDs. It remains experimental;
passing comparisons does not establish equivalence for every possible input,
timezone database version, or future Python feature.

## Historical measurements at 2525466

These measurements predate the fair scheduler. They have not been repeated
against 9571a88 and do not describe current solver work counts or performance.

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

The earlier native worker snapshot was **219,179 bytes minified**, or **69,484 bytes
with gzip**, including its timezone, decimal, and hashing dependencies. It
avoids the roughly 16 MB of uncompressed Pyodide runtime/package asset files.
These are solver-asset sizes, not complete application downloads; actual
network transfer depends on HTTP compression and caching.

## Current validation at 9571a88

The native solver matched **88 captured solver calls, 21 direct pricing calls,
and 200 deterministic generated cases**. Native structured-clone checkpoint
continuation, relative budgets, and changed-input/version invalidation passed.
Old experimental native checkpoints restart under version 2; they are not
migrated from the old stack representation. The flight-price correction also
invalidates older filtered checkpoints using a pricing-revision signature tag.
The full worktree passed **173 backend tests** and the native/static checks
recorded in [the migration plan](static-migration-plan.md). Existing SQLite
ResourceWarnings remain in passing persistence tests.

## Validation and reproduction

`tools/export_solver_comparison.py` executes 57 existing tests, captures 88
solver calls and 21 direct pricing calls, and adds 200 deterministic generated
trips across one to four cities, timezones including DST, visit order, budgets,
fare uncertainty, bundles, unpriced-flight exclusions, and partial budgets.
Resumed calls replay the same prefix before comparing the next call, preserving
the meaning of per-call budgets. The generated public-case JSON is ignored and
regenerated by `npm run test:poc`, so it cannot silently become the reference
for an outdated Python implementation.

Browser tests compare every captured response, test native checkpoint
structured-clone/resumption and invalidation, and verify that TypeScript runs
without loading Python before both independent workers are compared.

`tools/export_provider_comparison.py` runs 98 existing Python tests and captures
the provider normalization and rail sampling/projection boundaries. It also
adds explicit incomplete/ambiguous GTFS fare cases. The native provider test
compares 372 responses, including all schedule segments, generated IDs, airport
charges, usable flags, assumptions, fare products, date windows, seed order,
and independent return-ticket tasks. Generated discovery inputs include four
visits, DST boundaries, flexible/fixed dates, own-car recovery, and home time
limits. These pure native functions are not yet connected to live search;
orchestration and application storage remain in the static migration plan.
The corpus includes 47 graph-ingestion transitions (standalone/combined party
fares, missing prices, partial tickets, rail projection replacement) and 50
shared-graph cleanup cases that remove trip-specific airport overlays. Retrieval
times are explicit in references; provider requests are mocked or absent.

`tools/export_contract_comparison.py` validates model inputs through current
Python/Pydantic and regenerates 11,983 native comparisons, including 81 rejected
inputs. It covers all captured solver inputs, complete default values, unknown
fields, model constraints, numeric coercions, offset-aware timestamps, Unix
seconds/milliseconds, journey scopes, and contract-version rejection. The native
worker enforces this boundary before solving; Python remains independently
validated by `planner_models.SolverInput`. This corpus is regression evidence,
not proof for every possible coercion or timezone database version.

`tools/export_edit_comparison.py` runs 31 existing Python tests and captures
95 edit cases, including 37 rejected changes, plus direct endpoint replays.
Native repository tests cover atomic writes and checkpoint invalidation, stale
results, cache pruning, portable backups, and read-only SQLite migration. The
real native calculation service persists and resumes worker batches, honors
per-call expansion budgets, stops without dropping its current frontier, and
can promote a previously weaker route after a fare correction. These services
are described in [browser storage](browser-storage.md). The full Planner's native
adapter and discovery coordinator are connected at `/native.html`.

`tools/export_preparation_comparison.py` replays 51 public saved graphs through
the real Python recalculation path. The browser compares prepared inputs,
snapshots, complete/partial results, airport catalog metadata, Missing info
metadata, and discovery keys. It covers transfer alternatives and airport
changes, manual overrides, stale quotes, timetable buffers, disabled fallback,
intercity road regeneration, own/rental cars, empty trips, and saved-trip imports.
Another 288 discovery keys and explicit float-hash edge cases must match.

The largest current saved trip was also replayed without provider calls using
read-only SQLite. Its 1,653 prepared movements, 1,649 effective offers, 14 routes,
full result, snapshot, and editing metadata matched native preparation. These
are current correctness checks, separate from historical performance trials.

To repeat that private check (output remains under ignored diagnostics):

```powershell
uv run python tools/export_saved_preparation.py --database path/to/planner.sqlite3
$env:POC_PREPARATION_SAVED = (Resolve-Path data/diagnostics/native-comparison/saved-preparation.json).Path
cd frontend
npx.cmd playwright test --config playwright.poc.config.ts native-preparation.spec.ts
Remove-Item Env:POC_PREPARATION_SAVED
```

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
