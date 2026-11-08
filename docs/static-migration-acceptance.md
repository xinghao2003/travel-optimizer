# Static-client migration acceptance

The implementation runs the complete existing Planner from static files, with
native TypeScript discovery, optimization and IndexedDB persistence. Only flight
retrieval and optional Transitous routing need the stateless Python functions.
The independent Python/Pyodide solver and original application remain available.
No application was deployed, pushed or merged into main as part of this work.

Local and remote main `9571a88` are incorporated through merge `b3705e6`.
Implementation stages are separate commits on `codex/browser-poc` in the
`travel-optimizer-browser-poc` worktree. The original checkout is preserved.

## Acceptance evidence

| Migration requirement | Current implementation and evidence |
| --- | --- |
| Independent reference and complete optimizer | Both workers enforce solver-input contract version 1. Regenerated comparisons cover 107 captured Python solver calls, 31 pricing calls and 200 generated graphs. Source tests include gateway/positioning policies, ordered visits and return revisits, commitments, own-car recovery, rental charges, exact non-overlapping bundle cover, aliases, fare/rule precedence, currencies, weaker routes, fair exploration, safety budgets and resumed work. See `tools/export_solver_comparison.py` and `frontend/tests/native-solver.spec.ts`. |
| Exact money and timestamps | BigInt cents and epoch microseconds remain exact internally; public JSON currency values retain the original contract. Another 2,005 cents conversions, 20 timestamp conversions and 1,208 duration cases match Python, including years 1–9998 in full solves, one-microsecond connection/commitment differences, end-of-day bounds and generated road IDs. Contract validation matches 12,120 Python model cases, including 81 rejections. |
| Full graph preparation and provider normalization | Native preparation matches 51 Python recalculation cases and 307 discovery keys. The 372 provider/discovery comparisons include flights, GTFS fares, readiness/access buffers, airport changes, rail projections and DST rejection, task/date generation, 47 ingestion transitions and 50 shared-graph cleanups. The private read-only SQLite replay reproduces all 14 routes from 1,653 prepared movements and 1,649 offers, with matching input, result and metadata. |
| Discovery and continuation | Thirteen Python lifecycle scenarios cover 18 rounds and 79 provider outcomes, including failures/retries, cache accounting, deadlines, cancellation, in-flight Apply, publication and bundle discovery. Native links match 54 manual flight URLs. Browser checks additionally cover saved queue reload, explicit assumed-connection deletion, priced bundles covering unpriced standalone flights and protocol-2 round-trip choices across pause/reload/Stop/Continue. |
| Persistence, edits and migration | IndexedDB stores trips, rules, shared graphs, jobs, results, native checkpoints and an isolated TTL cache. Native edits match 95 Python cases, including 37 rejected changes. Real browser tests verify atomic rollback, revision conflicts, stale worker rejection, cache pruning without losing user data, copies, deletion guards, JSON backup replacement and SQLite migration. A formerly weaker route becomes cheapest after Apply. Old checkpoints restart; old completed native result caches are marked stale and recalculated. |
| Complete interface and static catalogs | The existing settings, Options/chart, itinerary/map, Missing info, staged CSV and pricing forms use the native API adapter. Static place lookup matches 90 Python searches/nearest queries, preserving custom coordinates and the original application limits. Production interactions restore, calculate, edit, reload, search through mocked provider responses, export backups and display results without planner API/source/Python requests. |
| Static artifact and reports | `build:native` emits `index.html`, its identical `native.html` alias, application JS/CSS and three public catalog/config JSON files. An explicit shipped-file allowlist excludes Python, fixtures, private snapshots and development tooling. A plain files-only HTTP server exercises the root, multiple trips, weaker options, map canvas, copied settings, standalone selected/all-trip HTML reports and the print-ready report page. Its network allowlist permits static files and the mocked map style only. |
| Thin backend | Flight protocol 2 has bounded one-way/conditional-return operations with whole-party fares; multi-city quotes remain manual. Transitous forwarding has validated parameters and explicit provider contact. Tests cover successful, empty, partial, failed, timed-out and busy operations, CORS and input validation. The ten-file provider package passes native primp loopback HTTP and ASGI checks on Linux x86_64/Python 3.13.17. All ten current source hashes still match that checked package. Neither entry imports the planner API, discovery manager or store. |

The full Python suite passed **194 tests**. The regenerated reference suite,
native production build and browser suite passed **29 checks**, including the
optional private migration replay and both production-artifact workflows.
Existing SQLite ResourceWarnings occur in passing reference tests. Build chunk
size warnings remain informational; resource measurements are not acceptance
gates for this migration.

## Reproduce locally

Start the local provider/reference preview with `start-browser-poc.ps1`. Build
the native artifact and serve it separately, with no planner server or API proxy:

```powershell
npm.cmd --prefix frontend run build:native
uv run python tools/serve_static_planner.py
```

In another terminal, run the full public suite:

```powershell
cd frontend
$env:POC_STATIC_URL = 'http://127.0.0.1:5176'
npm.cmd run test:poc
```

The private replay is optional. Set `POC_SQLITE_BACKUP` to the read-only SQLite
export and `POC_SQLITE_EXPECTED` to its saved-preparation comparison file to
include it. These files remain under ignored diagnostics, never public assets.
See [storage migration](browser-storage.md) and [provider checks](provider-functions.md).

## Runtime differences and verification limits

- Closing the page stops browser-owned work. Saved queues and native checkpoints
  resume only when requested; this replaces the server's continue-after-close
  behavior. One writable Planner tab owns each origin's database.
- Each uncached round-trip function step counts as one request. Conditional
  returns replay their initial page, so this can use more upstream requests
  than Python's single logical round-trip task. The difference is documented
  and tested; missing/manual quote opportunities remain visible.
- Native checkpoints are structured-clone data, not Python pickle. Python
  graphs, edits and queues migrate through portable JSON; computation restarts
  safely when versions or solver inputs change. TTL pruning touches only the
  provider cache. Origin changes require backup export/import.
- Transitous is disabled until routing use/contact is configured. OSRM remains
  direct browser HTTP; provider function URLs can be configured independently
  of the static host. No secret belongs in the public configuration.
- Linux package validation is native-runtime and ASGI evidence, not a Vercel
  deployment or verification of its generated bundle. Live providers' behavior
  from a hosting IP, bot handling and hosted routing remain unverified.
- The corpus and source-port audit establish the implemented planning behavior;
  they do not prove every possible JSON coercion, timezone database version,
  provider response or future Python feature. Money has no comparison tolerance;
  non-money float comparisons use an explicit absolute tolerance below `1e-8`.
