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

Edit transforms (`app/src/native/edits.ts`) cover atomic Apply, shared
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

## Debug bundles and replay

The planner keeps an event log for each trip in the `events` collection:

- `search`: each round start and end, with status, pause reason, request and
  cache counts, and recent messages.
- `provider`: each provider task with its status, duration, cache or request,
  clock, number of new journeys, and the complete provider outcome (raw
  Transitous payload, flight-function options, or road matrix).
- `calculation`: each calculation run with its clock, label limit, input size,
  batches, solve and wall time, expanded/pruned/remaining labels, option counts,
  and errors.

A new search of a trip clears that trip's log, so the log covers the latest
search and the calculations after it. Deleting a trip deletes its log. Raw
transit responses can be large: expect several megabytes for a search of 100
requests.

**More actions → Download debug bundle** downloads a normal backup with an
extra `debug` object: the event log, the deployed commit (`VERCEL_GIT_COMMIT_SHA`,
or `local`), solver, checkpoint and database versions, the browser user agent,
and the provider settings. Regular backups leave out the log. A debug bundle
restores like a backup; restore ignores `debug`.

`app/scripts/replay.mjs` runs the current solver on a backup or debug bundle in
Node and compares the result with the saved result:

```
cd app
node scripts/replay.mjs wayfinder-debug.json --list           # trips in the file
node scripts/replay.mjs wayfinder-debug.json --trip <id>      # replay and compare
node scripts/replay.mjs wayfinder-debug.json --label-limit none   # calculate to completion
node scripts/replay.mjs wayfinder-debug.json --events         # search and calculation log
node scripts/replay.mjs wayfinder-debug.json --event 12       # repeat ingestion of one response
```

By default, the replay expands the same number of labels as the saved result
(or all labels if the saved result was complete). It uses the clock of the last
logged calculation, else the export time, so quote freshness matches. Exit code
1 means the options differ. `--out` writes the result and `--case` writes a
solver fixture case for `tests/fixtures/solver.json`. `--event` shows the
journeys and fares a logged response produces, and whether each one is in the
saved graph and in a saved option.

Bundles do not include provider caches or checkpoints. The solver is
deterministic, so a replay with the same label limit rebuilds the checkpoint
state. Ingestion needs the generated airport catalog for metro airports; without
`app/public/browser-data/airports.json`, flight legs use only the cities'
own airports.

## Verification

The browser tests (`app/tests/repository.spec.ts`) exercise real
IndexedDB transactions and the real worker: rollback, competing revisions,
changed-graph result rejection, checkpoint round trips, cache pruning, trip
copy and delete, backup conflicts, replacement, restoration into a fresh
database, and debug bundle export, restore and replay.
