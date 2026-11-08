# Native Planner preview

The existing React Planner now has a native browser entry at `/native.html`.
It uses IndexedDB for trips and prices, static airport/place catalogs, and a
TypeScript Web Worker for calculation. The original `/` Python-backed entry,
the older Pyodide search prototype, and the dual-solver comparison remain available.

This stage connects saved-trip workflows: opening and copying trips, settings
and price edits, Missing info Apply, reusable estimates, assumed connections,
continuous calculation of the saved graph, reports, and JSON backup controls.
Imported active jobs are interrupted; reopening the page never starts provider
requests automatically. Closing the page stops computation; its last saved
native checkpoint can be resumed by a later calculation.
One writable Planner tab owns the browser database through Web Locks. A second
tab asks you to close the first and reload; it cannot interrupt active work.
Use a current browser over HTTPS or localhost. Different origins retain separate
databases and require JSON backup import to transfer saved work.

**Live provider search is not connected to this entry yet.** Its search action
returns an explicit preview error. The existing Pyodide prototype still provides
the earlier live-search experiment. Native discovery coordination, timed rounds,
Apply during an in-flight request, and the complete thin-function boundary remain
required before migration is complete.

## Run locally

From this worktree:

```powershell
uv run python tools/prepare_static_planner.py
cd frontend
npm.cmd run dev:native -- --port 5175
```

Open `http://127.0.0.1:5175/native.html`. This development entry needs no planner
server. Alternatively, generate the catalogs and open `/native.html` on the
existing prototype development server.

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

`frontend/dist-native/native.html` is the current preview entry. The separate
public directory includes only airport and place data. Python sources/runtime,
comparison fixtures, private snapshots, and provider caches are excluded.
The build still needs the provider-search stage before it is a complete app.
No deployment is part of these commands.

The full regression command is `npm.cmd run test:poc`. It regenerates public
Python reference cases and runs both the existing prototypes and native checks.
To run the production-artifact interaction after starting the preview above:

```powershell
$env:POC_STATIC_URL = 'http://127.0.0.1:5175'
npx.cmd playwright test --config playwright.poc.config.ts native-planner.spec.ts --grep 'production static'
```

The production check restores a saved trip through the UI, calculates with the
bundled worker, edits and reloads it, and verifies the downloaded backup. It rejects
planner API, Python/runtime CDN, and source-module requests. Dev checks additionally
cover Missing info Apply, stale revisions, continuous calculation, and 90 Python
place-search comparisons. Browser checkpoint bytes report the serialized native
representation, rather than Python pickle size.
