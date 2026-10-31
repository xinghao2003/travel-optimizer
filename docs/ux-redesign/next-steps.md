# UI/UX redesign: status and next steps

Status on 31 October 2026: the design is complete. Implementation has not started.

## Goal

The traveller chooses one complete door-to-door trip. The core decision is the total price against the hours spent in the required cities, and how certain each number is. The redesign must make this decision easy for a first-time user and keep every power-user setting within reach.

The current UI is one page of about 8,000 px. The first result is about 3,900 px down. In the common state after a search, the chart is empty because airport taxi fares are unknown.

## Files

| File | Content |
|---|---|
| [spec.md](spec.md) | Final implementation spec, sections A–J. Read A2 (decisions), I (plan) and J (checks) first. |
| [inventory.md](inventory.md) | Every user-facing capability of the current UI. Spec section H maps each id to its new place. |
| `data/diagnostics/ux-redesign/` (git-ignored) | `demo/`: scratch databases and seed scripts. `proposals/`: the 4 alternative designs and the judge scores. |

The spec uses the "decision and uncertainty first" proposal as its base and adds ideas from the others. Judge totals (3 judges, maximum 30): decision 23.5, guided 23, workspace 19, power 19.

## Fixes made during the design work

| File | Change | Reason | Validation |
|---|---|---|---|
| `backend/app/main.py` | Map `.js` to `text/javascript` before mounting `frontend/dist`. | On this Windows machine, the registry maps `.js` to `text/plain`. The browser then refuses the module bundle and the built app is blank. | The built app loads from the backend. |
| `backend/app/planner_optimizer.py` (line 421) | The departure-time window ignores user-estimated airport access segments. | A taxi estimate for home → airport relabels the access segment with mode `taxi`. The window was then checked against the taxi, not the flight, and every itinerary was removed. | New test `test_transfer_estimate_keeps_flight_departure_window` fails before the fix and passes after it. All 87 backend tests pass. The demo trip with 14 taxi estimates gives 9 feasible histories again. |
| `frontend/tests/loadTs.mjs` (new), `chartView.test.mjs`, `missingFares.test.mjs` | Shared loader that resolves relative imports. Fixtures get `segments`. Two expectations follow the README grouping rule from commit a46e9b1. | The tests failed before this session: the old loader could not resolve `./sharedResults`, and two tests expected the grouping that a46e9b1 removed. | 8 of 8 tests pass. |

## Decisions needed before implementation (spec I6)

The spec adopts each item by default. Each item has a fallback.

1. Price edits in the itinerary become drafts that one **Apply** sends.
2. Airport changes become drafts in the same Apply bar.
3. Unknown airport access/egress prices are entered per direction (trip transfer estimate), not per journey group.
4. "Lowest price" sorts by the highest possible price; options with an open-ended price go last.
5. Adding the first other start or end city keeps home as an option.
6. Times of assumed connections are read in each city's local time.
7. Autosave skips settings that have validation errors.

## Bug found in the current app (fix in spec step 1)

When airport transfer estimates exist, flight movements get the id `{flight}:transfer:{hash of the estimate values}`. The itinerary fare editor and the missing-fare table save flight prices on that variant id. A later change to a transfer estimate that the flight uses (its airport access or egress direction) changes the hash, so those flight prices stop applying. The UI does not tell the user.

Checked in the code: `planner_discovery.py:148` (variant id), `planner_optimizer.py:100-102` (offers match by id; only `template_id` offers carry over to variants), `Planner.tsx:507` (`componentId={m.id}`), and `planner_api.py:360-378` (saving transfer estimates does not move offers). Not reproduced in the browser.

Spec section I10 lists 9 more inconsistencies. I did not check them one by one.

## Next steps

1. Decide the 7 items above.
2. Implement in the order of spec I1. Commit after each step. Step 1 (foundations and bug fixes) is useful alone and has low risk; it can ship first.
3. After each step, run the build and the spec J checks for that area. At the end, run all of spec J.
4. Update the README labels that the redesign renames (spec I2).

## Run and validate

```bash
# Backend with the demo data (Git Bash, repository root). Port 8000 had stale sockets on 31 October, so 8765 was used.
D=data/diagnostics/ux-redesign/demo
PLANNER_DB_PATH="$D/planner.sqlite3" PLANNER_PLACES_PATH="$D/places.sqlite3" \
  uv run uvicorn app.main:app --host 127.0.0.1 --port 8765 --app-dir backend --reload --reload-dir backend/app

npm --prefix frontend run build                                   # the backend serves frontend/dist
(cd frontend && node --test tests/*.test.mjs)                     # no npm test script; `node --test tests/` fails
PYTHONPATH=backend uv run python -m unittest discover -s backend/tests
```

- Demo trips: `6e2258656d2a4819ac0b11e4993e3ee5` (unknown prices, paused search with 41 searches left, an airport change) and `5b72e2a023b945ffa7e3e4b3c1699ce6` (taxi prices entered; 2 best options).
- The app writes to the demo database. Keep an untouched copy if you need the exact states that spec J describes.
- The seed scripts make no provider requests. They need `PYTHONPATH=backend`, `PLANNER_DB_PATH` and `PLANNER_PLACES_PATH`. A new seed run gives new trip ids.
- After a rebuild, reload the page without cache (Ctrl+F5).

## Risks and limits

- The scope is large: about 10 new components, a draft hook and one new localStorage key. The main regression risk is in the revision checks, stale-result rejection, autosave, polling and drafts. Spec I4 and I5 list what must not change.
- Design agents wrote the spec from the code and read-only API calls. No part of it has been built yet.
- The numbers in spec J come from the demo database as of 31 October 2026.
- No live provider searches were run in this session.
