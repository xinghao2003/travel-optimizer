# UI/UX redesign: status and next steps

Status on 4 November 2026: steps 1–6 of spec I1 are implemented on branch `ux-redesign`. The branch is not pushed. Steps 7 (cleanup) and 8 (full verification) remain.

## Goal

The traveller chooses one complete door-to-door trip. The core decision is the total price against the hours spent in the required cities, and how certain each number is. The redesign must make this decision easy for a first-time user and keep every power-user setting within reach.

The old UI is one page of about 8,000 px. The first result is about 3,900 px down. In the common state after a search, the chart is empty because airport taxi fares are unknown.

## Files

| File | Content |
|---|---|
| [spec.md](spec.md) | Final implementation spec, sections A–J. Read A2 (decisions), I (plan) and J (checks) first. |
| [inventory.md](inventory.md) | Every user-facing capability of the old UI. Spec section H maps each id to its new place. |
| `data/diagnostics/ux-redesign/` (git-ignored) | `demo/`: scratch databases and seed scripts. `proposals/`: the 4 alternative designs and the judge scores. |

The spec uses the "decision and uncertainty first" proposal as its base and adds ideas from the others. Judge totals (3 judges, maximum 30): decision 23.5, guided 23, workspace 19, power 19.

## Fixes made during the design work

| File | Change | Reason | Validation |
|---|---|---|---|
| `backend/app/main.py` | Map `.js` to `text/javascript` before mounting `frontend/dist`. | On this Windows machine, the registry maps `.js` to `text/plain`. The browser then refuses the module bundle and the built app is blank. | The built app loads from the backend. |
| `backend/app/planner_optimizer.py` (line 421) | The departure-time window ignores user-estimated airport access segments. | A taxi estimate for home → airport relabels the access segment with mode `taxi`. The window was then checked against the taxi, not the flight, and every itinerary was removed. | New test `test_transfer_estimate_keeps_flight_departure_window` fails before the fix and passes after it. All 87 backend tests pass. |
| `frontend/tests/loadTs.mjs` (new), `chartView.test.mjs`, `missingFares.test.mjs` | Shared loader that resolves relative imports. Fixtures get `segments`. Two expectations follow the README grouping rule from commit a46e9b1. | The tests failed before: the old loader could not resolve `./sharedResults`, and two tests expected the grouping that a46e9b1 removed. | 8 of 8 tests pass. |

## Decisions (spec I6)

On 2 November 2026 the user adopted all 7 behavior changes (the "Change" column, not the fallbacks):

1. Price edits in the itinerary become drafts that one **Apply** sends.
2. Airport changes become drafts in the same Apply bar.
3. Unknown airport access/egress prices are entered per direction (trip transfer estimate), not per journey group.
4. "Lowest price" sorts by the highest possible price; options with an open-ended price go last.
5. Adding the first other start or end city keeps home as an option. (Done in step 3.)
6. Times of assumed connections are read in each city's local time.
7. Autosave skips settings that have validation errors. (Done in step 3.)

## Progress (spec I1)

| Step | Commit | Content |
|---|---|---|
| 1 Foundations | b80f2c0 | `lib/present.ts` and `lib/drafts.ts` with tests. Flight prices are saved on template ids (the variant-id bug), robust `api()`. |
| 2 Shell | 7cca420 | AppHeader with the ⋯ menu, ErrorBanner, TripBar, StatusStrip, Tabs, workspace grid. Old sections moved into the panels unchanged. |
| 3 Trip settings | 1ed3277 | TripSettings (core fields, More settings groups, sticky footer), PositioningSettings, InfoTip, Field, NumberField, PlacePicker, autosave guard, party-size notice. |
| 4 Options | 1048207 | OptionsPanel (Next steps, rows, sort, weaker, Over budget, empty states, show more, selection by signature), ModeIcon, ParetoExplorer rewrite with the pure chart logic in `lib/chartView.ts`. |
| 5 Itinerary | 6692cf3 | Header, compare, Day by day, Tickets and prices, combined ticket, map disclosure. |
| 6 Drafts and Missing info | 0f32e36 | `useTripDrafts`, the 7 sections, itinerary PriceEditor, ApplyBar. Largest step. |
| 7 Cleanup | — | CSS rewrite, legacy deletion, `index.html`, README labels. |
| 8 Full verification | — | All of spec J. |

## Next steps

Continue in spec I1 order. These items were found during steps 1–3 and belong to later steps:

- Chart polish: on the demo trip, the "×3" and "×2" stack labels at the right edge overlap.
- Step 7: delete the legacy files (App.tsx, RouteMap.tsx, lib/types.ts, ui/badge.tsx, ui/card.tsx) and the unused CSS listed by the step 4–6 agents: `.p-comparison`, `.p-route-*`, `.p-leg-*`, `.p-visit*`, `.p-main-fields`, `.p-places-grid`, `.p-search-actions`, `.p-missing-list`, `.p-purchases*`, `.p-timeline*`, `.p-segments`, `.p-inline`, `.p-airport-*`, `.p-fare-editor`, `.p-fare-components`, the `!important` rules; check whether AirportTransferTable.tsx and MissingFaresTable.tsx are still needed; README labels (spec I2); `index.html`.
- Steps 4, 5 and 6 had no agent review and no browser QA agent (skipped for speed). Step 8 must run the full spec J list.
- Step 4 had no agent review and no browser QA agent (skipped for speed). It was checked with the build, 62 tests and the browser (wide and 360 px, light and dark, both demo trips, sort, selection, Next steps actions).
- Step 7: remove the legacy CSS that is no longer used: `.p-main-fields`, `.p-visits`, `.p-search-actions`, `.p-places-grid`, `.p-details`, `.p-missing-list` and the `!important` rules. Delete App.tsx, RouteMap.tsx, lib/types.ts, ui/badge.tsx and ui/card.tsx.
- To decide: when the draft has errors, opening another trip, New trip and Copy trip still try to save first. The server refuses, so the user must fix the fields first. This was already so before the redesign.

## Deviations from the spec in steps 2–3

- After a refused save, the header shows "Not saved", the banner gives the reason, and the strip shows the search state. C3.1 row 2 ("Updating options…") applies only while a save runs.
- The footer is the last element of `<main>` (C10), so it is not a footer landmark (I8).
- The light `--ring` token is #71717a, for 3:1 focus contrast.
- The brand text is hidden below 1100 px, so the save status fits at 768 px.
- Missing info shows "Nothing to check yet", not "Nothing missing", until a search has stored data.
- "Recalculate options" shows "Save the trip first." for an unsaved trip (I8: disabled actions show a reason).
- `#setting-departure-start` is the earliest-time input (C4, G). Change opens its group and focuses it.
- Changing home replaces the old home in the start and end lists (I6 item 5).
- On a new trip, "Add your home city." and "Add at least one city to visit." show only in the footer. A new trip keeps "Not saved yet" in the header; "Fix the marked fields to save" is for saved trips.
- Below 600 px, tip bubbles inside More settings groups are at most `calc(100vw - 80px)` wide, because the groups indent their content.

Step 4 deviations (details in the step 4 commit and the agents' notes):
- The C12 empty state comes before the Over budget group (wireframe W7); "Only over budget" is chosen before "Searching" when over-budget options exist.
- "Show {k} more" when fewer than 40 rows are left.
- "Includes estimates" is a chip only on exact totals; when every option includes estimates, only the say-once line shows (spec J for `5b72e2…` expects the chip).
- Hours round half up (218.25 → "218.3"); spec examples show 218.2.
- Hollow chart marks are circles with a `--card` fill (themeable), not `emptyCircle`. The budget line shows only when the budget is within 1.25 × the largest price.
- "Add prices" focuses the first missing transfer in the current table order (Busan → PUS on the demo), not Kuala Lumpur → KUL.

Step 5–6 deviations (details in the commits and agent notes):
- Itinerary header chips leave out the not-priced, may-exceed and over-budget chips (the lines below say it).
- The price editor keeps a Range checkbox so open-ended prices stay possible; an "All transfers" price cannot be open-ended.
- `--apply-h` is the measured bar height. After Apply, focus goes to the heading of the panel in view.
- Transfer and airport-change fields stage on every change (so "Fix {k} values" can find invalid text); Esc restores the value from when the field got focus.
- Connections between cities shows after a search even without gaps, so a connection can always be added.
- Focus ids are now built by `airportChangeFieldId()` and `transferFieldId()` in `lib/drafts.ts`.

## Spec inconsistencies found

- `PUT /trips/{id}` already returns `airport_transfer_rows` (`planner_api.py:148`). The airport transfer table does not disappear after autosave. Spec I10-5 is right about the other GET-only fields.
- Spec J "Add prices focuses KL → KUL" does not match the F3 tie-break.
- The failed part of C3.1 row 12 cannot occur.
- In `searchState`, "not searched" must come before "stale": the backend marks the result of a never-searched trip as `discovery_required`.
- Spec I10 lists 9 more. They were not checked one by one.

## How steps were run

Each step ran as one workflow: implementers per part, then reviewers, a skeptic for each critical or major finding, and one fix pass. After step 2 the user chose speed: all agents at high effort, 2 review lenses, a browser QA stage only on steps 4, 6 and 8, and no browser use by implementers. Step 3 skipped the agent review. It was checked with the build, the tests, a code read and the browser. The orchestrator checked every step in Chrome.

The Chrome window could not be resized. Narrow widths were tested in a same-origin iframe: open `/api/v2/trips`, replace the page body with an `<iframe src="/">` of the needed width, and inspect `iframe.contentDocument`.

## Run and validate

```bash
# Backend on a scratch copy of the demo data (Git Bash, repository root). The app writes to the database.
RUN=/path/to/scratch; cp data/diagnostics/ux-redesign/demo/*.sqlite3 "$RUN"/
PLANNER_DB_PATH="$RUN/planner.sqlite3" PLANNER_PLACES_PATH="$RUN/places.sqlite3" \
  uv run uvicorn app.main:app --host 127.0.0.1 --port 8765 --app-dir backend

npm --prefix frontend run build                                   # the backend serves frontend/dist
(cd frontend && node --test tests/*.test.mjs)                     # no npm test script; `node --test tests/` fails
PYTHONPATH=backend uv run python -m unittest discover -s backend/tests
```

- Demo trips: `6e2258656d2a4819ac0b11e4993e3ee5` (unknown prices, paused search with 41 searches left, an airport change) and `5b72e2a023b945ffa7e3e4b3c1699ce6` (taxi prices entered; 2 best options).
- The seed scripts make no provider requests. They need `PYTHONPATH=backend`, `PLANNER_DB_PATH` and `PLANNER_PLACES_PATH`. A new seed run gives new trip ids.
- After a rebuild, reload the page without cache (Ctrl+F5).
- Never press a button that starts a transport search during checks. It sends live requests to Google Flights and other providers.

## Risks and limits

- The main regression risk is in the revision checks, stale-result rejection, autosave, polling and drafts. Spec I4 and I5 list what must not change. Steps 2 and 3 kept the request order of every I4 function.
- Not tested: a running or queued search (no live searches were run), screen readers, reduced motion in a browser, and touch devices.
- The numbers in spec J come from the demo database as of 31 October 2026.
