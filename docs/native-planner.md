# Native browser Planner

The existing React Planner runs natively in the browser. Its production static
entry is `/`; `/native.html` remains available for development and comparison.
It uses IndexedDB for trips and prices, static airport/place catalogs, and a
TypeScript Web Worker for calculation. The original `/` Python-backed entry,
the older Pyodide search prototype, and the dual-solver comparison remain available.

Connected workflows include opening and copying trips, settings
and price edits, Missing info Apply, reusable estimates, assumed connections,
continuous calculation of the saved graph, reports, and JSON backup controls.
Imported active jobs are interrupted; reopening the page never starts provider
requests automatically. Closing the page stops computation; its last saved
native checkpoint can be resumed by a later calculation.
One writable Planner tab owns the browser database through Web Locks. A second
tab asks you to close the first and reload; it cannot interrupt active work.
Use a current browser over HTTPS or localhost. Different origins retain separate
databases and require JSON backup import to transfer saved work.

Native discovery is connected to Search transport, Stop, Search more and timed
rounds. It persists the queue after each outcome, counts only new provider
requests, retries failed queries, and retains an in-flight response on Stop.
Apply waits for the response, invalidates the optimizer checkpoint, and resumes
the same round with its original counters and deadline. Expired timed rounds
save the edits and wait for the user to continue. Rail fallback and transit
pagination use the existing Python behavior; multi-city quotes remain manual.

The [provider functions](provider-functions.md) now support one-way flights,
bounded round-trip selection steps and optional Transitous forwarding. Each uncached
round-trip step counts as one request; remaining choices persist for Continue.
Multi-city quotes remain manual. OSRM and Transitous use direct browser HTTP
by default; only flight searches require the provider backend. The isolated
provider package passed Linux native-dependency and ASGI checks. Live hosted
provider access remains unverified. Local migration acceptance is recorded in
[the acceptance report](static-migration-acceptance.md).

## Run locally

From this worktree:

```powershell
uv run python tools/prepare_static_planner.py
cd frontend
npm.cmd run dev:native -- --port 5175
```

Open `http://127.0.0.1:5175/native.html`. This entry needs no planner server.
For local provider functions, use the existing prototype runner or separately
run `uv run uvicorn backend.app.provider_dev:app --host 127.0.0.1 --port 8010`. Native Vite
forwards only the flight/transit function paths there; `POC_API_URL` can change
that target. Alternatively, run `start-browser-poc.ps1` and open `/native.html`
on its printed frontend port.

The catalog builder uses the existing place-catalog preparation, including a
local GeoNames archive when available, with the existing airports-only fallback.
It preserves all catalog rows; it does not restrict the native entry to the older
prototype's eight cities or 14-day range. To reuse an existing public catalog
without changing it, pass `--places-database <path-to-places.sqlite3>`.
Trip settings also retain the existing custom-coordinate controls.

Use **More actions → Restore browser backup** to import the JSON produced by
[the SQLite exporter](browser-storage.md). Matching record IDs require selecting
replacement explicitly. Import and backup actions are disabled while settings
or Missing info have pending edits, or the open trip is working.

## Production artifact

```powershell
cd frontend
npm.cmd run build:native
npx.cmd vite preview --config vite.native.config.ts --configLoader runner --host 127.0.0.1 --port 5175 --strictPort
```

`frontend/dist-native/index.html` is the static root entry; `native.html` is an
identical alias. The separate public directory includes airport/place data and
public provider configuration. Python sources/runtime,
comparison fixtures, private snapshots, and provider caches are excluded.
`vercel.json` selects this directory and includes both provider functions. A
static host needs no application rewrite to open the root page.
No deployment is part of these commands.

For a files-only preview without any API proxy, run this from the worktree root:

```powershell
uv run python tools/serve_static_planner.py
```

Open `http://127.0.0.1:5176/`. This helper only serves files and supplies correct
JavaScript MIME types on Windows. Provider searches need separately configured
function URLs; opening and editing saved trips does not need a backend.

The full regression command is `npm.cmd run test:poc`. It regenerates public
Python reference cases, rebuilds the native artifact, and runs both the existing
prototypes and native checks.
To run the production-artifact interaction after starting the preview above:

```powershell
$env:POC_STATIC_URL = 'http://127.0.0.1:5175'
npx.cmd playwright test --config playwright.poc.config.ts native-planner.spec.ts --grep 'production static'
```

To include the files-only acceptance flow, point `POC_STATIC_URL` at port 5176
and also run `static-acceptance.spec.ts`. It checks the root entry, shipped file
allowlist, multiple trips, copying, weaker options, map canvas, standalone HTML
reports and the print-ready report page. It permits only static files and a
mocked map style; every other network request fails the test.

The production check restores a saved trip through the UI, calculates with the
bundled worker, edits and reloads it, and verifies the downloaded backup. It rejects
planner API, Python/runtime CDN, and source-module requests. Dev checks additionally
cover Missing info Apply, stale revisions, continuous calculation, 90 Python
place-search comparisons, and 13 Python discovery scenarios over 18 rounds.
They also verify 54 manual flight links, native HTTP caching/TTL, in-flight Apply
through the full interface, and priced round trips covering unpriced standalone
flights. Browser checkpoint bytes report the serialized native
representation, rather than Python pickle size.
Shared assumed connections are retained when starting from a cached graph;
deleting one during a search also removes it from the active graph so a later
publication cannot restore it.
Saved results also carry a native solver revision on their trip record. Results
from earlier numeric implementations are marked stale and recalculated from
the complete saved graph, even when their trip and graph revisions still match.

Public provider settings are generated in `browser-data/config.json`.
`BROWSER_FLIGHTS_URL`, `OSRM_BASE_URL` and `BROWSER_TRANSIT_URL` configure targets
independently of the static host. Transit is enabled by default and calls
`https://api.transitous.org/api/v6/plan` directly. The footer's Contact link
defaults to this repository. Export `TRANSITOUS_CONTACT_URL` before building to
change that public link. Set `BROWSER_TRANSIT_ENABLED=false` to disable transit,
or `BROWSER_TRANSIT_URL=/api/transit` to use the optional proxy. Browser requests
identify the site through their origin referrer. No secret belongs in this public file.

The independent Python and TypeScript solvers also fix an existing fare-selection
defect discovered by the live search test: with Skip flights without a price,
a valid whole-ticket fare must remain selected even when unrelated airport costs
are unknown. Missing info lists the unknown charges, rather than already-covered
flights. Filtered results carry `flight_price_revision=2`; older filtered results
are recalculated on open, and affected old optimizer checkpoints restart.
