# Browser storage

The planner stores all data in the IndexedDB database `wayfinder-planner`,
schema version 1. One writable Planner tab owns the database through Web Locks.
A second tab asks you to close the first and reload; it cannot interrupt active
work. Different origins keep separate databases; use a JSON backup to move data
between them.

`PlannerRepository` stores multiple trips, global rules, shared graphs, search
and calculation records, selected-trip metadata, native checkpoints, and provider
responses. A trip update and checkpoint invalidation commit in one transaction.
Failed validation and revision conflicts leave both unchanged. Calculation
results commit only if the trip and source graph revisions still match.

Edit transforms (`frontend/src/native/edits.ts`) cover atomic Apply, shared
component estimates, reusable journey estimates, explicit CSV deletion targets,
airport connections and transfers, individual and bundle fares, and assumed
connections.

`BrowserCalculator` runs the solver in a Web Worker and persists unfinished
state through IndexedDB structured cloning. It uses small internal batches while
preserving the caller's cumulative label allowance and per-call expansion budget.
Stop finishes the current batch, saves its frontier, and stops. Resume restores
the saved state; changed inputs restart safely. Completed work removes its
checkpoint. Checkpoints store internal cents and epoch microseconds as BigInt.
Public results and portable backups keep JSON money fields. Trip records keep a
solver revision with calculated results; results from an older revision are
marked stale on read and recalculated from the saved graph.

Provider TTL controls cache freshness. Expired entries are deleted when the
repository opens, after cache writes, and through explicit batch cleanup. These
operations access only the provider-cache store. They do not remove trip graphs,
user prices, saved results, or calculation checkpoints. Expired quotes already
inside a trip remain available with the stale-quote indication.

## Portable backups

Use **More actions → Download browser backup** and **Restore browser backup**.
`exportBackup()` produces a version-1 `wayfinder-browser-backup` JSON document
with stored records. `importBackup()` validates every record before committing
the batch. Existing IDs cause a conflict unless replacement is selected.
Replacing a trip advances its revision so an older edit or worker cannot
overwrite it; extra global rules also make affected cached results stale.
Import and backup actions are disabled while settings or Missing info have
pending edits, or while the open trip is working.

Imported active jobs become interrupted and keep their queues and collected
data. No provider search starts automatically. Provider caches and optimizer
checkpoints are not included in backups; calculations restart from the
preserved graph.

## Verification

The browser tests (`frontend/tests/native-repository.spec.ts`) exercise real
IndexedDB transactions and the real worker: rollback, competing revisions,
changed-graph result rejection, checkpoint round trips, cache pruning, trip
copy and delete, backup conflicts, replacement, and restoration into a fresh
database.
