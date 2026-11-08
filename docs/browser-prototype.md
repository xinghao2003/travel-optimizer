# Browser prototype

This worktree runs provider discovery and the existing optimizer in the browser.
The server exposes only a stateless flight-search function. The original planner
remains available through its existing startup script.

A separate [native TypeScript versus Python comparison](native-solver-prototype.md)
is available at <http://127.0.0.1:5174/solver-comparison.html>.

## Run locally

From this worktree, using PowerShell 7:

```powershell
uv sync --locked
npm.cmd --prefix frontend ci
.\start-browser-poc.ps1
```

Open <http://127.0.0.1:5174/prototype.html>. The flight function is at
<http://127.0.0.1:8010/api/flights>. The script chooses nearby free ports if
these are occupied and prints the actual addresses. Ctrl+C stops both children.
These ports are separate from the existing planner's 5173/8000 defaults.

**Load example** demonstrates optimization without provider calls. **Start new
search** discards this prototype's collected graph and creates a queue from the
form. **Search more** continues it. Only uncached provider calls consume the
request allowance. **Stop** aborts the browser request and saves collected work;
an interrupted task remains at the cursor for continuation. The flight server
can finish its current request after the browser disconnects, bounded by its
20-second transport timeout.

Trip state, results, provider responses, and application-generated optimizer
checkpoints use a separate IndexedDB database, `wayfinder-browser-prototype`.
Reloading restores the trip without downloading Python until calculation or
search is requested. Clearing this site's browser data removes the prototype's
saved work. **Export graph JSON** provides a portable copy without pickle data.
Import accepts this JSON or a full saved-trip record with its `snapshot` graph;
it does not load checkpoint bytes from uploaded files.

## Execution split

| Component | Execution |
| --- | --- |
| Search queue, request budget, cancellation, cache | TypeScript in the browser |
| OSRM distance/duration matrix | Direct browser fetch to public OSRM |
| Transitous planning | Direct browser fetch to public Transitous |
| Flight retrieval | `POST /api/flights`, using the pinned fast-flights/primp adapter |
| Normalization and discovery windows | Existing pure Python functions shared with the server |
| Optimization | Existing `planner_optimizer.py`, unchanged, in a module Web Worker |
| Persistence | Browser IndexedDB; no trip database in the flight function |

The worker uses Pyodide **314.0.7**, its bundled Pydantic, and explicit `tzdata`.
`tools/prepare_browser_poc.py` copies the shared Python modules and public airport
coordinates into generated static assets. It also writes the native airport and
metro catalog under `/browser-data/`. The startup script and Vercel build command
run it automatically; run it before a standalone `build:poc` command too.
The browser downloads the Python runtime and dependencies from the
pinned jsDelivr distribution. First use therefore requires internet access.

Solving uses short cooperative slices (150 ms requested). The worker processes
messages between slices, keeping the page responsive without Python threads or
cross-origin-isolation headers. Deadline checks do not make preprocessing and
serialization hard real-time. Checkpoints stay in Python memory between slices
and are serialized when a calculation pauses. New graph inputs invalidate old
solver work through the optimizer's existing fingerprint.

The prototype starts at four requests per batch, permits up to 50, and spaces
uncached requests at least one second apart per browser session. This is not a
global multi-user rate limiter. Direct calls still consume provider resources;
coordinate automated use with [Transitous](https://transitous.org/api/) and follow
the [OSRM service policy](https://routing.openstreetmap.de/about.html).

## Scope and limits

- Live discovery supports one-way flights, transit, and taxi road connections,
  up to four required cities, a 14-day date window, and eight preset cities.
- Required-city order, detailed timings, and other solver constraints can be
  supplied by importing a full graph/specification. The prototype form does not
  expose the full editor.
- Automatic bundled-ticket discovery, station-name resolution, rail fallback,
  timetable pagination, airport-transfer editing, and fare editing are not
  migrated. The shared optimizer retains its ticket-cover logic for imported
  validated offers.
- Transit requests use coordinates, so sparse station access can return fewer
  journeys than the original planner's station-resolution workflow.
- Missing fares and unknown currency conversions stay unknown. No default zero
  price or implicit currency conversion is introduced. Example fares are marked
  as examples.
- Provider failures are visible and are not cached as successful empty results.
  Start a new search to retry failed tasks while reusing successful caches.
- Small browser tests are compatibility evidence, not a large-trip, mobile-memory,
  or hosted Linux runtime benchmark.

The separate solver comparison now includes one prepared saved-trip benchmark;
see its own measurements and limitations. The complete live-search workflow has
not been migrated to TypeScript or validated for full application parity.

## Vercel local development

Vercel supplies [`vercel dev`](https://vercel.com/docs/cli/dev) for local routing
and Python Functions. `vercel.json` describes the prototype frontend build and
file-based `api/flights.py` function. A linked Vercel project is required by the
CLI even for local development.

```powershell
npm.cmd exec --yes --package vercel@65.12.1 -- vercel dev --listen 5175
```

In this experiment, CLI 65.12.1 authenticated and created an empty isolated
project named `travel-optimizer-browser-poc`. Its automatic GitHub connection
failed, and the local builder then failed with Windows `EPERM` errors while
creating vlt dependency symlinks. No application was deployed. Further Vercel
setup stopped at the user's request. The local Vite/Uvicorn runner above does
not require Vercel and exercises the same flight function, but it is not proof
of Vercel's hosted routing or Linux dependency compatibility.

## Checks

```powershell
$env:PYTHONPATH = "backend"
uv run python -m unittest discover -s backend/tests -v
uv run python tools/prepare_browser_poc.py
npm.cmd --prefix frontend run build:poc
npm.cmd --prefix frontend run test:poc
```

Start the prototype before browser tests. On Windows, tests use installed Google
Chrome; on other systems install Playwright Chromium. Browser tests run the real
Pyodide optimizer and mock provider responses to avoid search load. They cover
computed options, JSON export/import, IndexedDB reload, batch allowances, provider
caching, direct provider URLs, flight-proxy routing, whole-party pricing, missing
fares, and stopping/resuming an in-flight query.

To reuse a previously downloaded public Pyodide distribution during tests, set
`POC_PYODIDE_CACHE` to the directory containing `pyodide.mjs`, the WASM binary,
lock file, standard library, and dependency wheels. Set `POC_BASE_URL` to test
another local port. Screenshots and test artifacts are under ignored
`data/diagnostics/browser-poc/`.

Completed checks in this experiment:

- 170 backend tests passed after syncing main `9571a88`, including the adapter/function checks. Existing
  SQLite ResourceWarnings remain in passing persistence tests.
- Ten Chrome tests passed, covering both solvers, the actual Pyodide
  worker, mocked providers, stop/reload/resume, native checkpoint continuation,
  274 provider/rail/discovery comparisons, and 11,964 input-model comparisons
  against Python, plus 51 complete saved-graph preparation scenarios. The largest
  current saved-trip preparation also matched in a separate read-only replay.
- TypeScript and the production prototype build passed.
- A single live KUL → PEN query for 2026-12-07 through the local flight function
  returned 19 validated options in about 1.3 seconds. This is one transport smoke
  test, not an accuracy, availability, hosted-runtime, or load guarantee.
