# Timed rounds and optimizer checkpoints

In **Trip settings → Advanced → Search effort → Custom**, select **Minutes** under
**Limit each round by**. Timed mode starts at ten minutes; choose one to 1,440
whole minutes. The allowance covers provider waiting, local preparation and
optimization, publication, and saving. A round finishes early if no work
remains. It pauses near its deadline otherwise.

In timed mode, the provider-query batch allowance and expanded-state allowance
do not stop the round. A safety limit of 100,000 additional expanded states per
calculation applies in both modes. Reaching it pauses
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

**Keep looking for 10 minutes** starts a new allowance; the previous round's elapsed
time is not charged again. The selection is restored from the saved job when
opening the trip. A paused trip does not automatically restart calculation on
page load. Its last calculated options remain available while newer collected
schedules await calculation.

## Continuous checking

**Keep looking**, with no searches left, starts a separate background calculation on saved
schedules and becomes **Stop checking**. It checks up to 100,000
additional states per batch, saves a checkpoint and publishes options, then
starts the next batch automatically. It does not use the transport-search
request or minutes allowance, and makes no provider requests. It finishes when
all combinations have been checked.

Stop requests are cooperative. The current state expansion, result preparation
or checkpoint saving can finish before the status changes from Stopping to
stopped. Progress remains available for a later run. Closing the page stops the
calculation; its last saved checkpoint continues only when requested again.

Only one continuous checker runs at a time, and it cannot overlap a transport
search on the same trip. Applying edits or recalculating pauses the checker
before proceeding. Settings changes invalidate that run; the next explicit
check uses the changed inputs. The original transport-search queue is retained.

There is no checkpoint-size limit. Batches still bound additional expansions,
but total memory and disk use can keep growing until stopped or complete.
The details show saved checkpoint size. A complete solve removes its checkpoint.

The solver shares 16-state turns across starting journeys and departure gateways.
When **Skip flights without a price** is enabled, flights with no usable
standalone fare, user estimate, or combined-ticket coverage are removed before
exploration. A combined ticket must have a finite price in a configured currency,
match the party size, and reference components present in the saved graph.
Its flights must still occur together on a feasible itinerary. This does not
remove provider schedules or change the provider-search queue.

Variants of the same first flight share a branch, so airport-transfer choices
do not each get a separate share. Fully priced paths receive three turns,
paths with priced flights but other missing costs receive two, and paths with
unpriced flights receive one. Turns rotate among branches in each tier. A
child's tier is recalculated as its path grows; a later combined ticket can
cover previously unpriced flights. All tiers retain regular turns and the
same feasibility and ticket-cover checks. This changes partial-result order
and adds scheduling overhead; it does not make partial results exhaustive.

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

- Pending states, branch turns, and price-tier scheduling position.
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

Checkpoints are stored in the browser database (IndexedDB), one per trip, through
structured cloning. A paused checkpoint survives a page reload. Completion or trip
deletion removes it. Closing the page can lose work since the last saved checkpoint.
Stop also saves the solver's unfinished state. Checkpoints are not part of portable
backups.

When search-state semantics or the stored layout change, increment the version
number at the start of the input fingerprint in `app/src/native/solver.ts`.
Older checkpoints then restart from the saved graph. Do not change the version merely for display or allowance changes.
