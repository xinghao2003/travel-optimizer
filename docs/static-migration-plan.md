# Complete static-client migration

The target is the existing planner's complete behavior in a static web build,
with browser-owned trip data, discovery, and optimization. A thin function
backend handles only provider requests that require a server. Python remains
the executable reference and the fast-flights provider implementation.

**Correctness and feature parity are the acceptance criteria.** The prototype's
RAM and timing measurements are informational and are not migration gates.
No deployment is authorized as part of this checklist.

## Current checkpoint

- Synced with local and remote main `9571a88` through merge `b3705e6`, including
  staged CSV editing/deletion, continuous calculation, fair exploration, and
  early exclusion of flights without usable standalone or combined fares.
- Native TypeScript solver and independent Python/Pyodide reference worker.
- Version-1 JSON solver-input contract, enforced by both workers, with native
  model defaults and validation matching Python on 11,983 model cases (81
  invalid). Regenerated reference inputs carry the same contract version.
- Native fair scheduling, relative per-call expansion budgets, flight-price
  eligibility and new response counters match current Python.
- Native flight/transit normalization and opt-in rail sampling/projection are
  implemented as pure functions. They match 188 Python reference cases,
  including ambiguous fares, airport changes, and DST projection rejection.
  They are connected to discovery in the full native entry.
- Native discovery windows, seed order, per-direction positioning policies,
  and independent round-trip task generation match 86 further Python cases.
  The combined provider/discovery corpus now contains 372 comparisons,
  including 47 graph-ingestion transitions and 50 shared-graph cleanup cases.
- Complete native solver-input preparation now applies the full saved graph,
  current timing, airport-change connections and transfer choices, road/vehicle
  regeneration, manual offer precedence, effective rules, and quote freshness.
  Missing info metadata and persisted discovery-key compatibility are included.
- Preparation matches 51 public recalculation scenarios, 288 discovery keys,
  and a read-only replay of the largest current saved trip: 1,653 prepared
  movements, 1,649 offers, and 14 routes, with matching full results and metadata.
  The comparison page now prepares saved-trip imports through this path.
- Matching responses on 88 captured solver calls, 21 pricing calls, and 200
  deterministic generated cases. Historical performance measurements still
  predate this sync; the current saved-trip replay checks correctness only.
- Native structured-clone checkpoint continuation and changed-input/version
  invalidation tested. Old experimental native checkpoints restart; Python's
  durable version-1 migration remains available in the reference backend.
- Native multi-trip repository, atomic edit transforms, isolated provider-cache
  pruning, portable backups, and a read-only SQLite exporter are implemented.
  Native worker calculation now saves/resumes checkpoints through that repository.
  The full interface now uses these services in a separate native saved-trip entry;
  native discovery uses its queues, cache, snapshots, edits, and worker service.
- Native edits match 95 Python cases, including 37 rejected changes. Real browser
  storage tests cover rollback, concurrent revisions, stale workers, cache cleanup,
  backup replacement, and a previously weaker route becoming cheapest after Apply.
  A real SQLite export restored six records and reproduced the 14-route result.
- Stateless flight functions support one-way queries and persisted, bounded
  round-trip selection steps. A separate validated Transitous function forwards
  provider requests without planner state. See [provider boundary](provider-functions.md).
  The ten-file isolated package passed native primp and ASGI checks on Windows
  and Linux x86_64/Python 3.13.17. No application was deployed.
- Native discovery matches 13 Python lifecycle scenarios over 18 rounds and
  79 provider outcomes. It also matches 54 manual flight URLs. Full-interface
  tests cover in-flight Apply, saved-queue reload/continue, and independently
  priced round trips that cover flights without standalone fares.
- A pre-existing Python/native pricing defect is fixed in both implementations:
  with unpriced flights excluded, unrelated unknown airport costs no longer
  cause a valid priced flight bundle to be discarded. Covered flights are not
  listed as missing fares. Affected old checkpoints/results restart/recalculate.
- 184 backend tests and all 26 browser checks passed, including the native
  production-artifact interaction and optional private migration replay. Native
  and earlier prototype production builds have passed.

The native solver now also runs through the full Planner at `/native.html`.
That entry uses local places/nearest lookup and browser-owned saved trips, edits,
calculation, continuous calculation, and backups. Its static production build
excludes Python and comparison data. Its native discovery coordinator is connected;
the provider-function implementation is connected. Provider integration tests
use recorded/mocked responses, with separate isolated Linux native-runtime
checks rather than evidence from hosted provider access.
The older live-search prototype still
uses Python/Pyodide for discovery planning, result normalization, and solving.
The default development `/` entry continues to use the original Python planner
API; the native hosting configuration maps `/` to `/native.html`.
Neither preview is yet a complete native replacement for the application.

## 1. Establish the permanent reference boundary

Keep a single normalized solver-input contract and version it. Include trip
settings, prepared movements, effective offers and pricing rules, solver
options, and relevant revisions. Make input validation/defaults agree with the
Python contracts, including money, party/vehicle units, timestamps, timezones,
and missing values. Both workers now validate the versioned JSON boundary;
the native solver core receives its normalized output. The contract corpus
checks current solver inputs, default values, common numeric coercions,
timestamp offsets/Unix units, model constraints, unknown fields, and unsupported
contract versions. It does not establish equivalence for every possible JSON
coercion or timezone-database difference.

Generate references from current Python code in tests, rather than maintaining
outdated expected results by hand. Expand the differential corpus to cover all
solver-facing behaviors: supplied positioning, gateways, return revisits,
vehicle recovery and rentals, fare overrides, bundle aliases/overlap, reusable
journey scopes, uncertain currency conversions, commitments/DST/boundary times,
unpriced-flight filtering, weaker options, and interrupted/resumed searches.

**Done when:** every supported normalized input produces equivalent completed
business outputs. Any floating tolerance is explicit and excludes money. Changes
to the Python reference require corresponding native parity checks. Work-counter
or partial-result differences must be explained, not silently accepted.

The final parity audit must include numeric boundaries for cents and epoch
microseconds. Native helpers currently use JavaScript numbers for these values;
the existing ordinary-trip corpus does not prove exact integer behavior beyond
`Number.MAX_SAFE_INTEGER`. Resolve any supported-domain precision gap before
claiming complete input equivalence.

## 2. Port complete input preparation and provider normalization

The pure preparation path is implemented and checked against the real Python
`DiscoveryManager.recalculate` path. Saved-trip imports in the comparison page
use it; it is also connected to native discovery and the complete Planner interface.
The exported global rules must accompany an imported trip to reproduce server
pricing. A trip record alone cannot recover rules stored separately in SQLite.

Port the operations surrounding `DiscoveryManager.recalculate`, not only the
solver call. They include:

- Flight/transit normalization, access/egress and readiness buffers, interlined
  connections, and unknown fares.
- Airport-change validation and unresolved connection diagnostics.
- Airport-transfer variants and associated pricing rules.
- Manual assumed connections, supplied positioning, road/own-car/rental inputs.
- Provider versus manual fare precedence, effective rule merging (global,
  airport-transfer, and per-trip journey estimates), and stale-quote metadata.
- Estimated-timetable filtering and regeneration when settings change.
- Result-derived metadata needed by Missing info and editing: component IDs,
  airport-transfer rows, direct connection gaps, and quote freshness.

**Done when:** raw provider outcomes plus trip edits produce the same prepared
solver input and diagnostics as Python. Importing a raw saved snapshot must no
longer skip these transformations.

## 3. Port discovery and continuation semantics

Native ingestion is implemented for roads, standalone and combined flights,
and transit, including party-specific fares, quote TTL, partial-ticket handling,
and replacement of estimated rail with actual-date service. Shared-graph cleanup
also removes trip-specific airport overlays. Native fetching, job/round coordination,
pagination, publication, and persistence are now connected. Python lifecycle
replay covers 18 rounds, including in-flight edits, cancellation, cache accounting,
failed-query retries, deadline expiry and discovery-derived ticket queries.
Provider-only functions are implemented in stage 6; live hosted compatibility
is not established by these recorded/mocked browser checks.

Bring the complete `tasks_for`, `fetch`, `ingest`, `publish`, and `run` behavior
into browser-owned services. Preserve optimistic date windows, seed ordering,
gateway choices, positioning policies, per-mode coverage, and cache identity.

Restore the missing search capabilities:

- Independent round-trip seeds and conditional return selections.
- Combined-ticket queries derived from completed flight histories; preserve
  manual multi-city quotes where the existing provider cannot retrieve them.
- Transit pagination, station resolution/radius probes, minimum transfer time,
  and opt-in reference-date rail fallback with its estimate labels.
- Count-based and timed rounds, request accounting, cache hits, query failures,
  retry queues, cancellation, and solver-pending continuation.
- Graph invalidation after settings changes, and publication/cadence semantics.
- Coverage that distinguishes an exhausted queue from complete provider/ticket
  coverage. Failures and unsupported/manual quotes must remain visible.

**Done when:** replaying the same recorded provider outcomes and user actions
produces equivalent queues, graph, fares, coverage, manual-quote opportunities,
and final solver outputs. Include pause/reload/continue and edits during search.

## 4. Replace server-side trip storage and edit transactions

The repository, pure edit semantics, portable backup boundary, SQLite exporter,
and persisted native calculation service are implemented and tested; see
[browser storage](browser-storage.md). The complete interface and active-search
Apply/continuation coordination are connected to them. Reload preserves paused
queues, and the user chooses when to continue provider requests.

Expand IndexedDB from one active prototype session to the application's trip
repository: multiple trips, create/copy/delete, graph snapshots, offers, airport
connections/transfers, global rules, reusable journey estimates, results, search
queues, selected-trip state, and native checkpoints.

Port the behavior currently implemented by `planner_api.py`, including revision
checks, atomic Apply of pending changes, shared-fare targeting, rule reuse/update/
removal, assumed-journey editing, and recalculation after changes. Retain the
existing frontend's draft/applied distinction and stale-result rejection.

Persist graph/specification/checkpoint versions consistently. Save unfinished
native state through IndexedDB's structured cloning. TTL must control freshness;
also explicitly prune expired provider entries on startup/after batches. Cache
cleanup must not delete user edits, saved graphs, or unfinished calculations.

Provide export/import for existing SQLite user data, including rules, transfers,
and saved schedules. Import Python graphs/queues and recalculate natively rather
than trying to reinterpret Python pickle checkpoints. Keep a portable JSON
backup/export path for browser-owned data.

**Done when:** multiple saved trips and every supported edit survive reload with
the same behavior as the original app, and existing user work can be migrated
without losing prices, rules, connections, or trip settings.

## 5. Connect the complete existing interface

Saved-trip integration is implemented at `/native.html`; see
[local usage and production checks](native-planner.md). Missing info Apply and
backup restore/download run through the full interface without planner API calls.
Local catalog lookup matches 90 Python searches and nearest-place queries.
Native live-search coordination is connected and verified against recorded
outcomes, including an interaction through the full interface. Completion still
requires broader final acceptance below.

Retain the current React settings, options/chart, itinerary/map, Missing info,
pricing forms, and report/export features. Replace their planner API calls with
browser services and worker messages. Wire the native solver into the actual
search/recalculation flow, not only the comparison page.

Replace `/api/data`, `/places`, and `/places/nearest` with static catalog assets
and local lookup behavior, retaining airport/metro mappings, timezone metadata,
city search, map selection, and custom-coordinate places. Remove the prototype's
eight-city and 14-day restrictions after supported application behavior is ported.

**Done when:** the full interface works with the original FastAPI planner stopped;
network assertions permit only static assets, existing map resources, approved
direct providers, and the thin provider-function endpoint(s).

## 6. Complete the provider-function boundary

Implemented: [stateless protocol and validation evidence](provider-functions.md).
The native request budget counts bounded function invocations, including each
conditional return, instead of Python's potentially multi-request round-trip
task. This intentional accounting difference is explicit and tested. The
isolated package works with the locked native dependencies on Linux; Vercel's
generated bundle and live hosted provider access have not been exercised.

Keep trip state, queues, pricing edits, and optimization out of the backend.
Extend the one-way flight endpoint to the existing provider capabilities while
preserving whole-party prices, missing-fare rows, and diagnostics. Round-trip
selection/session handling needs an explicit bounded request protocol; the
current adapter reuses one HTTP client across the initial and return requests.

OSRM/Transitous can remain direct browser calls where supported. Route them
through provider-only functions when required by CORS or coordinated provider
usage. Use explicit provider operations rather than an arbitrary-URL proxy.
Preserve attribution, application contact, and provider request policies.

**Done when:** provider contract tests cover success, empty, partial, timeout, and
failure outcomes; each invocation is bounded and independent of a long-running
job. Validate the packaged function and native dependencies on the intended
Linux/function runtime without deploying an application unless separately
authorized. Windows Vite/Uvicorn checks alone do not prove hosted compatibility.

## 7. Validate the static application as a whole

Build a separate production artifact for the full native client. Keep Python
fixtures, the comparison harness, private snapshots, and developer tooling out
of the shipped artifact. Configure the provider base URL independently of the
static host. Development/reference tooling may continue to use Python.

Run full recorded-workflow differential tests, the existing browser interactions
against local services, and native checkpoint reload tests. Cover settings edits,
Apply during searches, price refinement, weaker options, trip copy/delete,
provider failures/retries, estimated rail, vehicle constraints, and report export.
Verify the production static build, not only the development server.

Closing the page stops browser-owned work. Persist and resume collected progress
when it is reopened; do not claim the previous server's continue-after-tab-close
behavior for a static application.

**Migration complete:** the full UI and all supported planning behavior work from
static files plus provider-only functions; user data persists/migrates correctly;
recorded workflows agree with Python; and no planner CRUD, background-job, SQLite,
or optimizer server is required at runtime.
