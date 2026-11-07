# Timed rounds and optimizer checkpoints

In **Trip settings → More settings → Search size**, select **Minutes** under
**Limit each round by**. Timed mode starts at ten minutes; choose one to 1,440
whole minutes. The allowance covers provider waiting, local preparation and
optimization, publication, and saving. A round finishes early if no work
remains. It pauses near its deadline otherwise.

In timed mode, the provider-query batch allowance and expanded-state allowance
do not stop the round. A safety limit of 100,000 additional expanded states per
calculation applies in both modes (`PLANNER_SOLVE_BATCH`). Reaching it pauses
the search round with partial options and a checkpoint; Continue resumes that work.
Each continuation can grow the saved checkpoint further. The limit bounds work
per calculation, not total memory across repeated continuations.
Provider concurrency limits, request timeouts, supported
query types, and serial follow-up policies remain unchanged. Selecting
**Requests** uses the existing count-based behavior: 100 uncached query tasks
per batch by default, and a 25,000-state initial optimizer allowance. One query
task may make more than one HTTP request; cache hits do not consume that count.

The deadline is cooperative, not a hard process termination. An operation that
has already started is allowed to finish. The solver checks time between
expanded states, then serializes its results and checkpoint. An in-flight
provider task, preparation, a large state expansion, or final saving can extend
the round past the selected duration. Active status shows the time remaining
and then that the current operation is finishing. Details show elapsed time.

**Continue for 10 minutes** starts a new allowance; the previous round's elapsed
time is not charged again. The selection is restored from the saved job when
opening the trip. A paused trip does not automatically restart calculation on
page load. Its last calculated options remain available while newer collected
schedules await calculation.

## Continuous checking

**Check more combinations** starts a separate background calculation on saved
schedules and becomes **Stop checking**. It checks up to `PLANNER_SOLVE_BATCH`
additional states per batch, saves a checkpoint and publishes options, then
starts the next batch automatically. It does not use the transport-search
request or minutes allowance, and makes no provider requests. It finishes when
all combinations have been checked.

Stop requests are cooperative. The current state expansion, result preparation
or checkpoint saving can finish before the status changes from Stopping to
stopped. Progress remains available for a later run. Navigation or closing the
browser does not stop the backend job. Server shutdown stops it; after restart,
its status is interrupted and it continues only when requested again.

Only one continuous checker runs at a time, and it cannot overlap a transport
search on the same trip. Applying edits or recalculating pauses the checker
before proceeding. Settings changes invalidate that run; the next explicit
check uses the changed inputs. The original transport-search queue is retained.

Continuous checking pauses automatically when the saved checkpoint reaches
`PLANNER_CHECKPOINT_MAX_MB` (256 MiB by default). Size is checked before loading
the checkpoint and after every batch. A batch can exceed the threshold before
the pause. This is a limit on serialized checkpoint size, not a hard cap on
process RAM. Change the inputs to reduce the calculation or deliberately raise
the configured limit before continuing past a resource pause. A complete solve
removes its checkpoint.

Results report how many completed itineraries were hidden because their flight
prices were not applicable or complete. An empty Options panel distinguishes
that price filter from finding no complete itinerary. Round-trip quotes cover
their exact matching flight pair and do not price an unmatched single flight.

## What is saved

The Apply bar can now coordinate edits with an active round. It pauses safely,
saves all draft categories together, restarts from the full saved graph, and
continues within the original remaining allowance. It does not reset the timer
or provider counters. Expired rounds save edits and wait for explicit
continuation. See [Apply during a search](apply-during-search.md) for the flow
and weaker-route recovery experiments.

Provider discovery retains its query queue, cursor, collected schedules and
fares, and counters. The optimizer additionally checkpoints:

- Pending states in their original expansion order.
- Partial-state dominance records.
- All completed histories, including currently dominated histories needed for
  combined-ticket discovery.
- Selected label prices, vehicle state, stays, and accumulated work counters.

On matching inputs, the next solve expands the pending states instead of
replaying the explored prefix. This also improves count-based continuation.
Lookup caches are rebuilt; they are not the search state. Changing between
best-only and weaker-option serialization does not invalidate a checkpoint.

The input fingerprint covers the complete trip specification, ordered solver
movements, fare offers, pricing rules, open-ended/home-return mode, and a
checkpoint version. Changes to those inputs start a fresh calculation.
Coverage-only revision changes and larger allowances do not invalidate it.
Expired provider quotes can change their warning metadata and therefore also
invalidate the fingerprint. Correct pricing takes precedence over resumption.

Timed continuation finishes the paused optimizer before retrieving more data
that could invalidate its checkpoint. After that, discovery can add schedules
and trigger a new solve. Queries added by final publication run in the same
timed round if time remains.

Checkpoints are versioned binary records in a separate `optimizer_checkpoints`
SQLite table, one per trip. Only application-generated local data is decoded;
no HTTP endpoint accepts checkpoint bytes. Pickle preserves shared references
between labels and movements. A paused checkpoint survives a server restart.
Completion or trip deletion removes it. An abrupt termination can lose work
since the last saved checkpoint; completed round checkpoints remain durable.
Stop also saves the cooperative solver's unfinished state.

When search-state semantics or the stored layout change, increment
`CHECKPOINT_VERSION` in `planner_optimizer.py`. Older versions are ignored.
Do not change its version merely for display or allowance changes.

## API

Start or continue a whole timed round:

```json
{"minutes": 10}
```

Send this to `POST /api/v2/trips/{id}/searches` or
`POST /api/v2/searches/{id}/continue`. An optional `budget` still validates as
1–500 but does not cap work when `minutes` is supplied. Omitting `minutes`, or
setting it to null, selects count mode. The API accepts positive finite
fractional minutes up to 1,440; the UI uses whole minutes.

`POST /api/v2/trips/{id}/optimize` also accepts `minutes` for local calculation
without provider queries. Its deadline includes waiting for another solve's
per-trip lock. It returns the result after calculation and checkpoint saving.

Job status includes `time_budget_seconds`, `round_elapsed_seconds`,
`pause_reason`, `phase`, and `optimization_pending`. A job can be paused with
zero pending provider queries while local optimization remains unfinished.
Such a job must offer continuation, including after a server restart or Stop.

## Validation

Regression coverage checks serialized continuation against fresh prefixes and
complete solves, input changes, server restart, checkpoint cleanup, shared time
deadlines, ignored count limits, in-flight query completion, no solve launched
after expiry, pending-optimizer priority, final-publication queries, API
validation, and Stop with no provider queries left.

An additional 1,000 generated-trip differential run resumed a five-state
checkpoint after pickling. Every complete response matched an uninterrupted
solve; 887 cases performed additional expansions after resume. Saved-trip
benchmarking retained the complete solution hash from the preceding algorithm
round. Diagnostic inputs and artifacts are under the ignored
`data/diagnostics/2026-11-07-timed/` directory; no provider load test is needed.

One saved-trip experiment completed six serialized rounds at increasing
25,000-state allowances with exactly 129,879 total expansions and the same
complete response as a fresh solve. Partial checkpoints grew from 8.4 to
44.1 MB; serialization took about 0.11–0.92s and restoration up to 0.83s in
this sample. The rounds took 7.37s in total including serialization, compared
with 1.85s for a single uninterrupted solve. This measures durable round
overhead, not a speedup claim. Very short rounds can spend a substantial share
of time loading and saving state; a minutes-based allowance amortizes this
cost. Timings exclude SQLite I/O in this experiment and are not universal.

The frontend presentation tests, TypeScript/production build, and static React
rendering cover both round controls and status output. Interactive browser
verification was unavailable because the browser automation host was not
running in this session.

After the coordinated Apply integration, checks passed 131 backend tests and
82 frontend tests. The production
build passed with the existing large-chunk warning. SQLite ResourceWarnings
remain in passing persistence tests. No new provider calls were used for these
checks, and interactive browser clicks remain an unverified gate.
