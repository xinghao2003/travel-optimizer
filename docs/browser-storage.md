# Native browser storage and migration

The native services use IndexedDB database `wayfinder-planner`, schema version
1. The older search prototype keeps its separate `wayfinder-browser-prototype`
database. The full Planner interface uses these services through the separate
[`/native.html` preview](native-planner.md); the original entry remains available.

`PlannerRepository` stores multiple trips, global rules, shared graphs, search
and calculation records, selected-trip metadata, native checkpoints, and provider
responses. A trip update and checkpoint invalidation commit in one transaction.
Failed validation and revision conflicts leave both unchanged. Calculation
results commit only if the trip and source graph revisions still match.

Native edit transforms cover atomic Apply, shared component estimates, reusable
journey estimates, explicit CSV deletion targets, airport connections/transfers,
individual/bundle fares, and assumed connections. References from current Python
include 95 edits and 37 rejected requests. The interface adapter is connected
for saved-trip workflows. Live search/apply coordination remains migration work.

`BrowserCalculator` runs the native solver in a Web Worker and persists unfinished
state through IndexedDB structured cloning. It uses small internal batches while
preserving the caller's cumulative label allowance and per-call expansion budget.
Stop finishes the current batch, saves its frontier, and stops. Resume restores
the saved state; changed inputs restart safely. Completed work removes its
checkpoint. Tests also verify that changing a previously weaker route's fare can
make it the cheapest option, using all collected schedules.

Provider TTL controls cache freshness. Expired entries are deleted when the
repository opens, after cache writes, and through explicit batch cleanup. These
operations access only the provider-cache store. They do not remove trip graphs,
user prices, saved results, or calculation checkpoints. Expired quotes already
inside a trip remain available with the existing stale-quote indication.

## Portable backups

`exportBackup()` produces a version-1 `wayfinder-browser-backup` JSON document
with stored records. `importBackup()` validates every record before committing
the batch. It normalizes legacy model defaults and expands compact Python
results. Existing IDs cause a conflict unless replacement is explicit. Replacing
a trip advances its revision so an older edit or worker cannot overwrite it;
extra global rules also make affected cached results stale.

Imported active jobs become interrupted and retain their queues and collected
data. No provider search starts automatically. Provider caches and Python/native
optimizer checkpoints are excluded from portable backups. Calculations restart
from the preserved graph; native checkpoints continue to survive ordinary
reloads in the same browser database.

To export existing SQLite data without modifying the database:

```powershell
uv run python tools/export_planner_backup.py --database backend/data/planner.sqlite3 --output data/diagnostics/planner-backup.json
```

The output must be a new file; the exporter will not replace its database or an
existing backup. It uses only Python's standard library and exports trips, rules,
graphs, searches, and calculation records. The native preview provides download
and restore controls in More actions. JSON backups also move data between
local development and hosted browser origins.

## Verification

The browser tests exercise actual IndexedDB transactions and the real native
worker: rollback, competing revisions, changed-graph result rejection, checkpoint
round trips, cache pruning, trip copy/delete, backup conflicts, replacement, and
restoration into a fresh database. A separate private read-only SQLite export
restored all six records and reproduced the saved trip's 14 routes and editing
metadata against Python.

To repeat that private migration check after generating its Python preparation
reference:

```powershell
$env:POC_SQLITE_BACKUP = (Resolve-Path data/diagnostics/planner-backup.json).Path
$env:POC_SQLITE_EXPECTED = (Resolve-Path data/diagnostics/native-comparison/saved-preparation.json).Path
cd frontend
npx.cmd playwright test --config playwright.poc.config.ts native-repository.spec.ts
```

All private inputs remain under ignored diagnostics. The default browser suite
skips the private SQLite check unless both paths are supplied.
