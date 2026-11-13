# Apply missing information during a search

Prices to add remains editable while a search runs. Typing creates browser
drafts; it does not change the active calculation. Drafts save on their own
1.5 s after the last change (Ctrl+Enter saves at once). Saving uses the Apply
transaction below; the bottom bar shows only while it runs, after an error, or
when a value needs fixing.

Apply sends airport-change drafts, airport-transfer drafts, and journey/shared
price drafts in one request. All categories are validated before one revision
is committed. A validation error leaves every category unchanged and keeps the
browser drafts. Only the drafts actually sent are removed after success;
drafts for another party size or unavailable components remain in the browser.

## Coordination with a running round

The planner asks the old optimizer to pause at a safe state boundary. An
in-flight provider request is allowed to finish, and its response, graph
updates, query cursor, and counters are saved. The request itself is not
cancelled just to apply a price. Apply waits for that work and the per-trip
optimizer before committing the edit.

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
A completed price-only update refreshes the options even if the schedule version
did not change; stale status updates are ignored during Apply.

This flow is for drafts in the Apply bar. Separate immediate actions, such as
global price-rule editing, retain their existing controls.
