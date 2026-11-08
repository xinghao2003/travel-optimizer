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
- Native fair scheduling, relative per-call expansion budgets, flight-price
  eligibility and new response counters match current Python.
- Native flight/transit normalization and opt-in rail sampling/projection are
  implemented as pure functions. They match 188 Python reference cases,
  including ambiguous fares, airport changes, and DST projection rejection.
  Their connection to the live-search prototype is still pending.
- Matching responses on 84 captured solver calls, 20 pricing calls, and 200
  deterministic generated cases. The previous large saved-trip comparison
  predates this sync and has not been repeated against the new scheduler.
- Native structured-clone checkpoint continuation and changed-input/version
  invalidation tested. Old experimental native checkpoints restart; Python's
  durable version-1 migration remains available in the reference backend.
- Local prototype with browser batching, provider-response caching, one active
  saved session, and a bounded stateless one-way flight function.
- 170 backend tests, eight browser tests, and the prototype production build passed.

The native solver currently runs through the comparison page. The live-search
prototype still uses Python/Pyodide for discovery planning, result normalization,
and solving. The full existing `Planner.tsx` still calls the Python planner API.
Neither page is yet a complete native replacement for the application.
The new CSV workflows and continuous-search controls are merged into the
existing interface; their browser service implementations belong to stages 3-5.

## 1. Establish the permanent reference boundary

Keep a single normalized solver-input contract and version it. Include trip
settings, prepared movements, effective offers and pricing rules, solver
options, and relevant revisions. Make input validation/defaults agree with the
Python contracts, including money, party/vehicle units, timestamps, timezones,
and missing values. Native TypeScript currently assumes normalized input.

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

## 2. Port complete input preparation and provider normalization

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
