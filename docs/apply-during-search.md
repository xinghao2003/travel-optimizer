# Apply missing information during a search

Missing info remains editable while a search runs. Typing creates browser
drafts; it does not change the active calculation. The Apply bar shows
**Apply and continue** during an active round and **Apply** otherwise.

Apply sends airport-change drafts, airport-transfer drafts, and journey/shared
price drafts in one request. All categories are validated before one revision
is committed. A validation error leaves every category unchanged and keeps the
browser drafts. Only the drafts actually sent are removed after success;
drafts for another party size or unavailable components remain in the browser.

## Coordination with a running round

The server asks the old optimizer to pause at a safe state boundary. An
in-flight provider request is allowed to finish, and its response, graph
updates, query cursor, and counters are saved. The request itself is not
cancelled just to apply a price. Apply waits for that work and the per-trip
optimizer lock before committing the edit.

After saving, the old optimizer checkpoint is removed. The next calculation
starts from the **entire saved movement graph**, using the new prices and
transfer assumptions. It does not seed its search from only the previous best
routes. This is essential because a previously dominated state can become
useful when a component price, bundled-ticket comparison, or feasible airport
connection changes.

The same round resumes after the edit. Its original monotonic deadline,
provider-query cursor, total counters, and batch counters are retained. The
deadline is not reset to another ten minutes. Count-mode request allowances
are not replenished. Updated optimization runs before additional discovery,
so subsequent options and combined-ticket opportunities use the new inputs.
All existing provider request/concurrency policies remain unchanged.

If the original time allowance expires while waiting or applying, the edits
are saved and the round remains paused. No extra calculation is launched
outside that allowance. Applying to an already paused or completed timed job
also waits for **Continue for … minutes** instead of silently granting another
round. An explicit Stop is respected; Apply does not restart a cancelled job.
If an edit is rejected, an otherwise active round resumes its original work.

For an inactive count-mode trip, Apply performs one local recalculation using
the saved graph and existing state allowance. A state-limited result remains
marked incomplete. A corrected price does not imply the search is complete.

The UI distinguishes **Applying changes**, **Updating options with your
changes**, and **Changes saved; continue the round to update options**. Older
options are labeled as previous calculation results until the update arrives.
Polling refreshes a completed price-only update even if the schedule version
did not change, and does not accept stale poll responses during Apply.

This flow is for drafts in the Apply bar. Separate immediate actions, such as
global price-rule editing, retain their existing controls and API contracts.

## API

`POST /api/v2/trips/{id}/apply` accepts:

```json
{
  "expected_revision": 7,
  "connections": [],
  "transfers": [],
  "estimates": [
    {"component_ids": ["journey-id"], "low": 25, "high": 25, "currency": "MYR"}
  ]
}
```

Omit `connections` or `transfers` to leave that category unchanged. An empty
list clears that category. Estimates replace each specified component's user
price; each amount is per component, not a bundled total. The server returns
the compact trip, current job, and whether options are still updating. An
active round returns 202; an inactive or paused result returns 200.

## Experiments and validation

Regression scenarios include:

- A saved train route originally priced at RM110 is dominated by an RM20
  route. Correcting its outward fare to RM1 makes it the RM11 best route.
- A correction to a journey already visible in the old best itinerary changes
  which ticket cover wins. The old route still costs RM50 with its bundle,
  while a formerly hidden RM101 itinerary becomes RM2 and becomes best.
- Reducing an airport change from 90 to 15 minutes makes a previously unusable
  saved flight usable; the recovered route appears after recalculation.
- Active optimizer edits retain exactly the same deadline before and after
  applying. Expiry during the handshake saves the edit without starting a new
  allowance. In-flight discovery responses are ingested once, and provider
  counters are not reset. Rejected edits leave stored values unchanged and
  resume the original search.

An offline generated-trip experiment applied 1,000 fare changes with an old
five-state checkpoint present. Every resulting full solver response matched a
fresh complete solve with the new inputs, every obsolete checkpoint restarted,
and every saved movement graph was preserved. This checks correctness within
the modeled retrieved graph; it cannot establish coverage of tickets never
retrieved or completeness of a round that reaches its allowance.

Final validation passed 131 backend tests, 82 frontend tests, the TypeScript /
production build, and static React rendering of idle/running/applying controls.
Existing SQLite ResourceWarnings and the frontend large-chunk build warning
remain. Interactive browser validation was unavailable because both the
browser host and native computer-use pipe were unavailable. No provider load
test was performed. Private scripts, logs, and generated evidence are under
`data/diagnostics/2026-11-07-apply/`.
