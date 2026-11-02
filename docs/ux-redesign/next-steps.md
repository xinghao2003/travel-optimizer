# UI/UX redesign: status and next steps

Status on 2 November 2026: steps 1–3 of spec I1 are implemented on branch `ux-redesign`. The branch is not pushed. Steps 4–8 remain.

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
| 4 Options | — | Next steps, option rows, sort, Over budget group, empty states, show more, ParetoExplorer changes. |
| 5 Itinerary | — | Header, compare, Day by day, Tickets and prices, combined ticket, map disclosure. |
| 6 Drafts and Missing info | — | `useTripDrafts`, the 7 sections, itinerary PriceEditor, ApplyBar. Largest step. |
| 7 Cleanup | — | CSS rewrite, legacy deletion, `index.html`, README labels. |
| 8 Full verification | — | All of spec J. |

## Next steps

Continue in spec I1 order. These items were found during steps 1–3 and belong to later steps:

- Step 4: the Next steps action "Set default time" must open More settings › Time buffers before it focuses `#setting-airport-fallback`. The Planner `focusTarget` effect only calls `focus()`, and a closed `<details>` blocks it. `changeDepartureTimes` in `TripSettings.tsx` shows how: open every `<details>` around the field, then focus it.
- Step 4: after a chart click on a narrow screen, scroll the selected row into view (E8).
- Step 5: `FareEditor` still uses the old `p-error` style.
- Step 6: the Apply bar sets `--apply-h` (the settings footer already uses it). Restore the full C8 tip on Missing info ("…a draft in this browser until you select Apply…"); step 3 shortened it because Apply does not exist yet. Rewrite the quote-links text "enter a complete ticket price above", which now points to another tab. The moved sections still use h2 and the "03"/"05" badges; I8 wants h3.
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
