# Wayfinder Routes: final UX specification

> Design output of 31 October 2026 (inventory → 4 proposals → 3 judges → this synthesis). Not implemented yet. Read [next-steps.md](next-steps.md) first.

**Basis.** I read every live frontend file and the backend contract files (`planner_api.py`, `planner_models.py`, `planner_optimizer.py`, `planner_discovery.py`, `planner_positioning.py`, `planner_results.py`, `planner_store.py`). I sent read-only GET requests for the demo trip `6e2258…`, the "priced taxis" trip `5b72e2…` and the demo search. I checked three ECharts options in the docs (`step`, `markLine.data.xAxis`, `symbolRotate`). I ran the two existing frontend test files: both pass on Node 24 with the untracked `tests/loadTs.mjs`, so baseline note 8 is out of date. I changed no project files and did not use a browser.

**Facts from the code and data that shape this spec**

- **Demo results.** There are 9 best options. All are unbounded (they have unpriced items):
  - known parts: RM 2,480 to RM 5,710;
  - time in cities: 218.2 to 221.1 h;
  - the 9 options sit on only **5 distinct chart points**.
- **Demo unknowns.** 32 items have no price, in 12 groups:
  - 10 groups are airport-transfer directions, and each maps 1:1 to an `airport_transfer_rows` entry through the charge's `from_id`/`to_id`;
  - 2 groups are flights (KUL→PUS in 3 options, PUS→HND in 1).
  - Options 04–09 miss only airport-transfer prices.
  - `break_even_myr` is `null` for all 32.
- **Variant ids.** When airport-transfer estimates exist, flight movements in results get the id `{rawId}:transfer:{hash of the estimate values}`, with `template_id = rawId` (`airport_transfer_variants`). Any later transfer edit therefore changes the variant id.
  - Today the UI keys user flight prices on the variant id, so they become orphaned.
  - `price_path` copies offers keyed on `template_id` to every variant.
  - Combined tickets on variant ids fail with 422, because `edit_fare` checks bundles against snapshot ids.
- **Party size.** Offers and transfer estimates are keyed by `adults`, and offers for another party size are ignored (`_fare_index`, `airport_transfer_rules`).
- **`PUT /trips/{id}` response.** It returns the full stored record, including `snapshot.movements`, but none of the GET-only fields.
- **Searches.** `POST /searches/{id}/continue` spends provider requests whenever searches are pending. `POST /optimize {expand:true}` never does.

---

## A. Product framing

The traveller wants to choose one complete door-to-door trip. It starts at home, visits 1–4 cities (each for at least a minimum stay), may start or end through another city, and returns home inside the chosen dates. The core decision is a trade-off: **the total price for the whole group against the hours spent in the cities**. The traveller also needs to know how certain each number is before they book.

Each part of the app serves this decision:

- **Trip settings** state the question.
- **Search** collects transport.
- **Options** (chart and list) show the trade-off honestly. An unknown price stays unknown. A partial total is always labelled "From" (at least).
- **Next steps** and **Missing info** say which missing prices or journeys block the decision, and fix them with the fewest inputs.
- **Itinerary** shows exactly what the trip is, what to buy and what to check.

The novice path is: describe the trip → **Search transport** → read Next steps → **Add prices** → **Apply** → pick an option. Every power-user setting, rule and diagnostic stays reachable in one disclosure, and a summary line always shows its current values.

## A2. Decisions that resolve the proposals and the judges' findings

| # | Topic | Decision |
|---|---|---|
| 1 | Base | Results-first workspace (the "decision" proposal). Trip settings collapse to a 2-line summary once options exist. "Edit trip" opens them above the workspace. |
| 2 | Navigation | ≥1100 px: the Options column is always visible, and the side panel has tabs **Itinerary · Missing info**. <1100 px: one tab bar **Options · Itinerary · Missing info**. Selecting an option opens Itinerary (list → detail). No 4th tab, so nothing overflows at 360 px. |
| 3 | Save model | Only two models. (a) Trip settings autosave (unchanged). (b) Typed prices, airport transfers and airport changes are **drafts**, kept per trip in this browser, until one **Apply**. Create and delete actions save at once. Verbs: **Save / Add / Remove / Delete** = server now; **Set price** = draft; **Apply** = send drafts; **Undo** = remove one draft; **Discard** = remove all drafts. |
| 4 | Id churn | Flight prices and combined tickets use `template_id ?? id`. Removing a price uses the stored offer id. |
| 5 | Unknown totals | Plotted as a hollow marker at the known part with a short fixed-length arrow. Always labelled "From RM x" / "at least". Never sorted as cheap. |
| 6 | Sort | "Lowest price" ranks by the highest possible price, with unbounded options last (sign-off item I6-4). |
| 7 | Chart build | Scatter plus null-separated line series, a staircase frontier, "×N" stacks, and a budget markLine. No custom series and no click cycling. |
| 8 | "Check more combinations" | Never spends provider requests (routing in C3.1). |
| 9 | 409 | **Reload trip** discards the dirty draft after a confirm, then reopens the trip. |
| 10 | GET-only fields after autosave | Derived from the PUT response's snapshot (`assumedConnections()`, `cityGaps()`). Airport-change requirements come from `result.coverage` first. `accept()` stays unchanged, so no carry-over guard is needed. |
| 11 | Start and end cities | Explicit "{home} (home)" checkbox per list. |
| 12 | Party size | A notice next to Adults when entered prices belong to another adult count. |
| 13 | Disclosures | Native `<details>` for tips, the ⋯ menu and settings groups. No Popover API. |
| 14 | Labels | "Adults" (the backend prices adults only). "Missing info" names the refinement area. "Not priced" is the single word for an unknown price. |

---

## B. Layout and navigation

### B1. Regions (DOM order)

1. Skip link, the first focusable element: "Skip to options" when a workspace exists, otherwise "Skip to trip settings".
2. **App header**: sticky; brand, Trip select, New trip, save status, ⋯ menu.
3. **Error banner**: app-level errors only.
4. `<main id="main">`:
   - **Trip bar**: trip name, summary, Edit trip, status strip.
   - **Trip settings**: collapsible.
   - **Workspace**: Options column, plus the side panel (≥1100) or one tab bar (<1100).
5. **Footer**: attribution, text unchanged.
6. **Apply bar**: fixed at the bottom; shown only when drafts exist.

### B2. Breakpoints

| Width | Layout |
|---|---|
| ≥1100 px | Container max 1440 px with 32 px gutters. Header 56 px, sticky. Workspace grid `minmax(0,1fr) minmax(400px,.75fr)`, gap 24 px (about 773 / 579 px at 1440). Side panel: `position: sticky; top: 68px; max-height: calc(100vh - 80px - var(--apply-h,0px)); overflow: auto`, with its tab bar sticky inside. Chart 320 px. Map open by default. |
| 600–1099 px | 24 px gutters. Settings fields in 2 columns. One tab bar (Options · Itinerary · Missing info), sticky under the header. Chart 300 px. Map closed by default. |
| <600 px | 16 px gutters. Header 48 px with icon buttons; brand text hidden; save status shows as an icon with sr-only text. One-column fields. Inputs use 16 px text (no iOS zoom). Targets at least 44 px. The chart sits in a closed "Show chart" disclosure (260 px). Every editor stacks. No horizontal page scroll at 360 px. |

### B3. Default visibility by state

| State | Trip settings | Workspace | Side tab / narrow tab |
|---|---|---|---|
| New, not saved | Open, with intro sentence | Not rendered | — |
| Saved, never searched (`!saved.snapshot && !job`) | Open | Options: "No options yet". Missing info: airport transfers (collapsed) and price rules | Itinerary (empty) |
| "Search transport" succeeds | Closes; focus moves to the Options heading | Live | Narrow: Options |
| Trip opened with a snapshot or result | Closed (summary) | Full | Itinerary (option 01) / narrow: Options |
| Edit trip | Opens above the workspace | Unchanged | Unchanged |

### B4. Wireframes

Legend:
- `[x]` checked, `(o)` selected, `>` / `v` closed / open disclosure;
- `(i)` info tip, `[!]` warning icon, `[plane]` / `[train]` mode icons (lucide, with sr-only text);
- chart marks: `o>` = "from" marker with arrow, `*` = selected, `x3` = stack label.

**W1. Desktop: new trip (empty)**
```
+--------------------------------------------------------------------------------------------------+
| [compass] Wayfinder Routes  Trip [New trip (not saved)            v] [+ New trip]  Not saved yet [...] |
+--------------------------------------------------------------------------------------------------+
| [My trip                              ]                                                          |
| Plan a trip to up to 4 cities. Wayfinder finds door-to-door options and compares the total     |
| price with the time you get in each city.                                                        |
| +-- Trip settings ----------------------------------------------------------------------------+ |
| | Home city                                   Cities to visit (any order)              0 of 4    | |
| | [City name or airport code          ]       [Add a city: name or airport code             ]   | |
| | Dates [30 Nov 2026] to [08 Dec 2026]   (o) Exact dates  ( ) Any days in this period            | |
| | Leave home on 30 Nov. Be back home on 8 Dec.                                                  | |
| | Leave between 09:00 and 17:00 (local time). Change                                            | |
| | Adults [ 1 ]        Budget for 1 adult (MYR) (i) [No limit             ]                       | |
| | Transport (i)  [x Flight] [x Train] [x Bus] [x Coach] [ Subway] [ Tram] [ Car] [ Taxi]         | |
| | > More settings                                                       All default             | |
| | --------------------------------------------------------------------------------------------- | |
| | Add your home city.                            [Save without searching] [> Search transport]  | |
| +----------------------------------------------------------------------------------------------+ |
| Wayfinder Routes · Flights via fast-flights · Scheduled transit via Transitous sources · ...     |
+--------------------------------------------------------------------------------------------------+
```

**W2. Desktop: saved, never searched (settings open, workspace below)**
```
| | ... settings filled in ...                                                                     | |
| | Ready. The search can take a few minutes.                                [> Search transport]  | |
| +------------------------------------------------------------------------------------------------+ |
| Options                                        | [Itinerary] [Missing info]                       |
| No options yet. Search transport to find       | Options appear here after a search.              |
| options. They appear while the search runs.    |                                                  |
```

**W3. Desktop: search running (settings closed automatically)**
```
| [Korea and Japan in December        ]                                           [Edit trip v]    |
| Kuala Lumpur or Singapore -> Seoul 48 h+, Busan 24 h+, Tokyo 48 h+ (any order) -> Kuala Lumpur   |
| 4-14 Dec 2026 (exact dates) · leave 09:00-17:00 · 2 adults · budget RM 12,000 · Flight, Train,  |
| Bus, Coach                                                                                       |
| (spin) Searching · 52 done · 85 left. Options update as results arrive.  [=====-----] [Stop search] Details v |
| Options   Searching. The first options appear after a few searches.     (then as W4)            |
```

**W4. Desktop: results with unknown prices (demo data, the most common state)**
```
+--------------------------------------------------------------------------------------------------+
| [compass] Wayfinder Routes  Trip [Korea and Japan in December · 4-14 Dec 2026 v] [+ New trip] Saved [...] |
+--------------------------------------------------------------------------------------------------+
| [Korea and Japan in December        ]                                           [Edit trip v]    |
| Kuala Lumpur or Singapore -> Seoul 48 h+, Busan 24 h+, Tokyo 48 h+ (any order) -> Kuala Lumpur   |
| 4-14 Dec 2026 (exact dates) · leave 09:00-17:00 · 2 adults · budget RM 12,000 · Flight, Train,  |
| Bus, Coach                                                                                       |
| || Search paused · 41 searches left. (i)                              [Search more]  Details v   |
+-------------------------------------------------+------------------------------------------------+
| Next steps                                      | [Itinerary] [Missing info 13]                  |
| [!] 1 flight journey can't be used until you    | Option 01 of 9          Compare with [None   v]|
|     add the transfer from GMP to ICN airport.   | From RM 2,480                                  |
|                         [Add airport transfer]  | [!] 10 not priced: 2 flights, 8 airport        |
| [!] No option has a complete price yet: 10      |     transfers · may exceed your budget  See    |
|     airport transfer prices and 2 flight prices | 218.2 h in cities · 31.6 h travel (i)          |
|     are missing. 6 options need only airport    | v Map (i)                                      |
|     transfer prices. Until then, options may    | +--------------------------------------------+ |
|     exceed your RM 12,000 budget.  [Add prices] | |  . Seoul        . Tokyo                    | |
| (i) Trains, buses, coaches, subways and trams   | |        . Busan                             | |
|     were not searched: transit search is not    | | . Kuala Lumpur                             | |
|     set up on this server.                      | +--------------------------------------------+ |
| Options (i)                                     | Day by day (i)                                 |
| Price vs. time in cities (i)   > Chart options  | v Fri 4 Dec · 08:00 -> 18:54 · 9 h 54 min      |
| 221 |                       o>                  |   Kuala Lumpur -> Busan · [plane] AirAsia X    |
| 220 |                          o>x3  o>x2       |   D7530 · [!] 3 not priced                     |
| 219 |                                           |   08:00 Taxi to Kuala Lumpur International     |
| 218 | *>       o>x2                             |         Airport · 45 min (estimate)            |
|     +---+---------+---------+---------+------   |   08:45 At the airport before the flight 1 h 30|
|      2,500     3,500     4,500     5,500        |   10:15 AirAsia X D7530 · Kuala Lumpur Intl    |
|      Total price for 2 adults (MYR)             |         10:15 -> Gimhae Intl 17:39             |
| o> At least this price  * Selected              |   17:39 After landing · 30 min                 |
| 9 best options  Sort [Lowest price v] (i)       |   18:09 Taxi to Busan · 45 min (estimate)      |
| [ ] Show weaker options (i)                     |   Google Flights · Search fare (new tab)       |
| +---------------------------------------------+ | . Busan · 88.3 h (at least 24 h)               |
| |#01 From RM 2,480           218.2 h in cities| |   Fri 4 Dec 18:54 -> Tue 8 Dec 11:15  [####  ] |
| |  Kuala Lumpur [plane] Busan 88.3 h [plane]   | | > Tue 8 Dec · Busan -> Tokyo · [plane] 5 h 42 |
| |  Tokyo 63.8 h [plane] Seoul 66.1 h [plane]   | | . Tokyo · 63.8 h ...                          |
| |  Kuala Lumpur                31.6 h travel  | | Tickets and prices (i)   Total from RM 2,480   |
| |  [!] 10 not priced                          | | Flight Kuala Lumpur -> Busan · 4 Dec           |
| +---------------------------------------------+ |   Not priced         [Set price] Search fare   |
| | 02 From RM 3,460           218.2 h in cities| | Taxi Kuala Lumpur -> KUL airport               |
| |  ...                       [!] 9 not priced | |   Not priced                     [Set price]   |
| +---------------------------------------------+ | Flight Tokyo -> Seoul · 11 Dec · OZ1011        |
| | 04 From RM 5,400           221.1 h in cities| |   Google Flights          RM 860 [Set price]   |
| |  Kuala Lumpur [plane] Seoul 62.4 h [train]   | | ...                                           |
| |  Busan 47.4 h [plane] Tokyo 111.3 h [plane]  | | > Add a combined ticket price                  |
| |  Kuala Lumpur  29.7 h travel [!] 6 not priced| | Check before booking                           |
| +---------------------------------------------+ | - Airport transfer times are estimates (45 min |
| > Over budget (0) is hidden when empty          |   each, no road data): Kuala Lumpur, Busan ... |
+-------------------------------------------------+------------------------------------------------+
```

**W5. Desktop side panel: Itinerary with a price being set and a comparison (option 04 compared with 01)**
```
| Option 04 of 9                                     Compare with [Option 01 · From RM 2,480 v] |
| From RM 5,400     [!] 6 not priced: 6 airport transfers · may exceed your budget              |
| 221.1 h in cities · 29.7 h travel                                                              |
| vs Option 01: 2.9 h more time in cities. Price difference unknown: both options have items     |
| that are not priced.                                                                           |
| Tickets and prices (i)                                                 Total from RM 5,400     |
| Flight Kuala Lumpur -> Seoul · 4 Dec · AirAsia X D7506   Google Flights   RM 2,180 [Set price] |
| Taxi Kuala Lumpur -> KUL airport                          Not priced                           |
|  +-----------------------------------------------------------------------------------------+   |
|  | Price for 2 adults [ 130        ]  [ ] Range   Currency [MYR]                           |   |
|  | Applies to (o) All Kuala Lumpur -> KUL airport transfers in this trip                   |   |
|  |            ( ) Only this journey (Fri 4 Dec)                                            |   |
|  | [Set price] [Cancel]                                                                    |   |
|  +-----------------------------------------------------------------------------------------+   |
| Train Seoul -> Busan · 7 Dec · Korail KTX 179             Transit fare      RM 210 [Set price] |
| ...                                                                                            |
| After "Set price":  Taxi Kuala Lumpur -> KUL airport   RM 130 · Not applied · Undo             |
+------------------------------------------------------------------------------------------------+
| 1 change not applied: 1 airport transfer                               [Discard] [Apply]       |  fixed
```

**W6. Desktop side panel: Missing info, with drafts**
```
| [Itinerary] [Missing info 13]                                                                  |
| Missing info (i)                                                         13 items need input   |
| Airport changes (i)                                                               1 to confirm |
| GMP -> ICN · Gimpo International -> Incheon International    1 journey · 1 can't be used [!]   |
| [Choose way v] [Time    ] min  [Price for 2 adults (optional)] [MYR]                [Clear]   |
| Airport transfers (i)                                                       10 without a price |
| Kuala Lumpur -> KUL airport                                  Price missing · in 9 options      |
| [Taxi  v] [Road time ] min  [Not priced ] [Highest (optional)] [MYR]  [x]                      |
| + Add another way · Show journeys (2)                                                          |
| Busan -> PUS airport                                         Price missing · in 9 options      |
| [Taxi  v] [Road time ] min  [ 95        ] [                  ] [MYR]  [x]  Not applied · Undo  |
| ... 8 more directions, ordered by options affected ...                                         |
| > Other airports (4)                                                                           |
| Journey prices (i)                                                           2 without a price |
| Flight · Kuala Lumpur -> Busan                                               in 3 options      |
| 1 journey · Fri 4 Dec 10:15 · AirAsia X D7530 · Search fare (new tab)                          |
| [Not priced  ] [ ] Range  [MYR]                                                                |
| Flight · Busan -> Tokyo                                                      in 1 option       |
| [ 640        ] [ ] Range  [MYR]   Not applied · Undo                                           |
| Connections between cities (i)  > Add a connection                                             |
| > Combined tickets to check (2)                                                                |
| > Price rules · all trips (0)                                                                  |
+------------------------------------------------------------------------------------------------+
| 2 changes not applied: 1 airport transfer, 1 price                     [Discard] [Apply]       |  fixed
```

**W7. Desktop: no option found (the search finished)**
```
| Options                                                                                        |
| No itinerary fits these settings                                                               |
| - Minimum stays add up to 240 h, but these dates allow at most 216 h.          [Edit trip]     |
| - No direct journey found between Busan and Tokyo.                             [Add a connection] |
| - 1 flight journey can't be used until you add the transfer from GMP to ICN.   [Add airport transfer] |
| - Or change the trip: fewer minimum hours, more days, more transport or wider departure times. [Edit trip] |
| > Over budget (3) · from RM 13,200      (only when over-budget options exist)                    |
```

**T1. Tablet (768 px): Options tab**
```
+------------------------------------------------------------------------------+
| [compass] Trip [Korea and Japan in Dec... v] [+ New trip]   Saved     [...]  |
| [Korea and Japan in December   ]                             [Edit trip v]   |
| Kuala Lumpur or Singapore -> Seoul 48 h+, Busan 24 h+, Tokyo 48 h+ ...       |
| || Search paused · 41 searches left.                       [Search more]     |
| [ Options 9 ] [ Itinerary ] [ Missing info 13 ]               (sticky)       |
| Next steps (as W4) · chart 300 px · list (full width rows)                   |
| Tap a row: the Itinerary tab opens with "<- Options" at its top.             |
+------------------------------------------------------------------------------+
```

**M1–M4. Mobile (360 px)**
```
M1 New trip                     M2 Options tab                  M3 Itinerary tab                M4 Missing info tab
+----------------------------+  +----------------------------+  +----------------------------+  +----------------------------+
|[c][New trip (not sa..v][+][..]| |[c][Korea and Japan.v][ok][+][..]| |[Options 9][Itinerary][Miss 13]| |[Options 9][Itinerary][Miss 13]|
|[My trip                   ]|  |[Korea and Japan in Decem..]|  |[<- Options]       01 of 9  |  |Missing info (i)  13 to fix |
|Plan a trip to up to 4      |  |KL or Singapore -> Seoul    |  |From RM 2,480               |  |Airport changes       1 [!] |
|cities. ...                 |  |48 h+, Busan 24 h+, Tokyo   |  |[!] 10 not priced: 2 flights|  |GMP -> ICN  1 can't be used |
|Trip settings               |  |48 h+ -> KL · 4-14 Dec ...  |  |  8 airport transfers       |  |Way [Choose      v]         |
|Home city                   |  |[Edit trip v]               |  |218.2 h in cities           |  |Time [    ] min             |
|[City name or airport code ]|  ||| Paused · 41 left          |  |31.6 h travel               |  |Price [         ] [MYR]     |
|Cities to visit (any order) |  |           [Search more]    |  |Compare with [None       v] |  |[Clear]                     |
|[Add a city                ]|  |[Options 9][Itinerary][Mi..]|  |> Map                       |  |Airport transfers    10     |
|Dates                       |  |Next steps                  |  |Day by day                  |  |Kuala Lumpur -> KUL airport |
|[30 Nov 2026][08 Dec 2026]  |  |[!] 1 flight journey can't  |  |> Fri 4 Dec · KL -> Busan   |  |Price missing · in 9 options|
|(o) Exact dates             |  | be used ... [Add airport   |  |  [plane] 9 h 54 min        |  |Way [Taxi v] Time [Road t.] |
|( ) Any days in this period |  | transfer]                  |  |. Busan · 88.3 h            |  |Price [        ] [MYR]      |
|Leave between 09:00 and     |  |[!] No option has a complete|  |...                         |  |Highest [optional]  [x]     |
|17:00 (local time). Change  |  | price yet ... [Add prices] |  |Tickets and prices          |  |+ Add another way           |
|Adults [ 1 ]                |  |Show 1 more                 |  |Flight KL -> Busan · 4 Dec  |  |...                         |
|Budget for 1 adult (MYR)    |  |> Show chart                |  | Not priced                 |  |                            |
|[No limit                 ] |  |9 best options              |  | [Set price] [Search fare]  |  |                            |
|Transport                   |  |Sort [Lowest price      v]  |  |...                         |  |                            |
|[x Flight][x Train][x Bus]  |  |[ ] Show weaker options     |  |                            |  |                            |
|[x Coach][ Subway][ Tram]   |  |+--------------------------+|  |                            |  |                            |
|[ Car][ Taxi]               |  ||01 From RM 2,480          ||  |                            |  |                            |
|> More settings  All default|  ||218.2 h in cities · 31.6 h||  |                            |  |                            |
|+-sticky-------------------+|  ||KL [plane] Busan 88.3 h   ||  |                            |  |+-fixed--------------------+|
||Add your home city.       ||  ||[plane] Tokyo 63.8 h ...  ||  |                            |  ||2 not applied             ||
||[Save without searching]  ||  ||[!] 10 not priced         ||  |                            |  ||[Discard]       [Apply]   ||
||[> Search transport]      ||  |+--------------------------+|  |                            |  |+--------------------------+|
+----------------------------+  +----------------------------+  +----------------------------+  +----------------------------+
```

---

## C. Region-by-region specification

### C1. App header (sticky)

| Element | Specification |
|---|---|
| Skip link | First focusable element. "Skip to options" (target `#options-title`) when a workspace exists, otherwise "Skip to trip settings" (`#settings-title`). Visible on focus. |
| Brand | Compass icon and "Wayfinder Routes". The text is hidden <600 px; the icon then has `aria-label="Wayfinder Routes"`. A visually hidden `<h1>Wayfinder Routes</h1>`. The caption "Trip planning workspace" is removed. |
| Trip select | Native `<select>`; visible label "Trip" (sr-only <600 px). Options read "{name} · {4–14 Dec 2026}" from `start_date`/`end_date`. Same month: "4–14 Dec 2026". Different months: "28 Nov – 4 Dec 2026". Different years: "28 Dec 2026 – 3 Jan 2027". An unsaved trip shows a first option "New trip (not saved)". Disabled while a trip opens. Change → `act(() => openTrip(id), "open")`. |
| New trip | Button with Plus icon, "New trip" (icon only <600, `aria-label="New trip"`). Same handler as today. Opens settings and focuses Home city. |
| Save status | `aria-live="polite"`. Values in C13. Icon plus text; icon only <600 with sr-only text. |
| ⋯ menu | `<details class="p-menu">`, with `<summary aria-label="More actions">` (Ellipsis icon). It closes on item click, on Esc (focus returns to the summary) and on an outside click. Items: **Copy trip**, with small text "Copies settings, airport transfers and airport changes. Prices and search results are not copied." When disabled (unsaved trip) the small text reads "Save the trip first." **Recalculate options**, with small text "Uses saved data. No new search." It is disabled when the trip is unsaved or busy; handler = today's "Save & recalculate". Fieldset **Theme**: radios "System", "Light", "Dark" (`ThemeChoice`; provider, storage key and pre-paint script unchanged). |

### C2. Error banner

`role="alert"`, under the header, with a × button (`aria-label="Dismiss error"`). The clearing rules stay the same: every `edit()`, the start of every `act()`, and Dismiss. Section errors render inline next to their control (Apply bar, combined ticket, connection form, rule form, your-journey form, appointment form, exchange-rate form, custom place). They never use the banner.

| Cause | Text | Action |
|---|---|---|
| `fetch` throws `TypeError` | "Can't reach the planner server. Check that it is running, then try again." | — |
| Autosave failed | "Changes not saved: {server message}" | **Retry save** (runs `saveSpec`) |
| 409 from any `/trips/{id}…` write | "This trip changed elsewhere, for example in another tab or after a price rule change. Reload it to continue." | **Reload trip**. When the draft is dirty, it first confirms: "Reload the trip? Your unsaved changes will be lost." Then `openTrip(id, { discard: true })`. |
| 409 "Start a new search after changing discovery inputs." | Server text | **Search again** (`search()`) |
| 409 "This trip already has an active discovery job." / "An in-flight request is finishing…" | Server text | — |
| Poll failure | "Can't get the search status. Retrying…" (cleared by the next successful poll) | — |
| Other | Server `detail`, or the fallback "Something went wrong. Try again." | — |

### C3. Trip bar and status strip

| Element | Specification |
|---|---|
| Trip name | Text input, `aria-label="Trip name"`, maxLength 120, styled 18 px/600, edits `draft.name` (autosave). Blank shows inline "Enter a trip name." and the value is not committed. |
| Intro (unsaved trips only) | "Plan a trip to up to 4 cities. Wayfinder finds door-to-door options and compares the total price with the time you get in each city." |
| Summary (settings closed) | Line 1: "{starts} → {Seoul 48 h+, Busan 24 h+, Tokyo 48 h+} (any order) → {ends}". `starts`/`ends` = names joined with " or "; an empty list means home. A city with a 0 h minimum shows only its name. Line 2: "{4–14 Dec 2026} ({exact dates / any days}) · leave {09:00–17:00} · {2} adults · budget {RM 12,000 / no budget} · {Flight, Train, Bus, Coach}". |
| Edit toggle (saved trips only) | "Edit trip" / "Done editing" (`aria-expanded`, `aria-controls="trip-settings"`). |
| Status strip | C3.1. |

#### C3.1. Status strip

One row: icon, a state sentence, an optional `<progress>`, one primary action, and "Details". An sr-only `aria-live="polite"` span contains only the sentence, keyed by state id, so it announces state changes and not counter ticks. The strip is hidden for an unsaved trip. Variables:

- `searched = !!saved.snapshot || !!job`
- `active` = job `queued`/`running`
- `stale = result.discovery_required || job.status === "superseded"`
- `pending`, `failed = job.failed_queries`
- `incomplete = result.optimization_complete === false`

The first matching row wins:

| # | Condition | Sentence | Primary action |
|---|---|---|---|
| 1 | Draft has validation errors | "Fix the marked fields. Options show the last saved trip." | — |
| 2 | `dirty && result` | "Updating options…" (spinner). The workspace dims to 60% opacity with `aria-busy`. | — |
| 3 | `queued` | "Starting the search…" | **Stop search** |
| 4 | `running` | "Searching · {processed} done · {pending} left. Options update as results arrive." `<progress value={processed} max={processed+pending}>` with `aria-valuetext="{processed} of {total} searches"`. Tip on the bar: "The total can grow while the search adds follow-up searches." | **Stop search**. Tip: "Found options and your prices are kept." |
| 5 | `stale` | "Your trip changed. Search again to include the changes. Options shown use the earlier search." | **Search again** (`search()`) |
| 6 | `!searched` | "Not searched yet." | **Search transport** (only when settings are closed) |
| 7 | `paused` && pending>0 | "Search paused · {pending} searches left." Tip: "The search pauses after each batch of {batch} new requests to data providers. Search more runs the next batch. Saved results are reused." | **Search more** (`search(true)`) |
| 8 | `cancelled` && pending>0 | "Search stopped · {pending} searches left. Found options are kept." | **Search more** |
| 9 | `interrupted` | "The search stopped because the server stopped · {pending} searches left. Found options are kept." | **Search more** if pending>0, else **Retry failed searches** if failed>0 |
| 10 | `failed` | "The search failed: {last "Planner:" message without the prefix}. Found options are kept." | **Search more** if pending>0, else **Search again** |
| 11 | Idle, pending=0, failed>0 | "Search finished · {failed} searches failed." | **Retry failed searches** (`search(true)`) |
| 12 | `complete` && `coverage.discovery_complete === false` | "Search finished with gaps: {parts}." Only the true parts: "{f} failed searches", "{m} combined tickets to check", "trains and buses not searched". | — |
| 13 | `complete` | "Search complete." | — |
| 14 | No job, snapshot only | (no sentence) | — |

**Second line**, for rows 3–14 when `incomplete && !active`: "Not all combinations were checked. Better options may exist." with **Check more combinations** and the tip "Recalculates from saved data with a higher limit. No new searches."

- Routing: if `job && !active && job.status !== "superseded" && pending === 0 && failed === 0`, call `search(true)`.
- Otherwise call `POST /trips/{id}/optimize {expand:true}` → `acceptResult`, with status "Options updated".
- So "Search more" (spends requests) and "Check more combinations" (no requests) can show side by side.

**Details** (`<details>`, for power users):

- "Searches: {processed} done · {pending} left · {failed} failed"
- "This batch: {batch_requests} of {batch_budget} requests" (only when both fields exist)
- "Requests to data providers: {requests} · answered from saved results: {cache_hits}"
- "Results: {success} found · {empty} no results · {failed} failed · {unsupported} not supported" (from `job.outcomes`, non-zero only)
- "Combined tickets to check: {manual_quote_queries}"
- "Data version {snapshot_revision} · {feasible_count} complete itineraries checked · {expanded_labels} combinations explored"
- "Scope: best among the schedules and prices collected, not every ticket on sale."
- "Messages from data providers ({n})": `job.messages` ∪ `coverage.messages`, de-duplicated. The source gap "Transitous disabled" shows as "Transit search is not set up on this server."

### C4. Trip settings (`<section id="trip-settings">`, h2 `#settings-title` "Trip settings")

**Search-running notice** (shown when a job is active): "A search is running. Changing places, dates, adults, transport, departure times, start and end cities or estimated train timetables stops it."

**Core fields.** Two columns ≥1100 px. Validation is inline (`aria-invalid` + `aria-describedby`). Invalid values are never committed.

| Field | Control and copy | Default | Validation | Tip (secondary only) |
|---|---|---|---|---|
| Home city | `PlacePicker` "Home city". When set, a chip shows "Kuala Lumpur · MY · KUL" with a **Change** text button (reopens the picker). There is no × to clear home. If home has your journeys to start or end cities, changing it first confirms: "Changing home removes your {n} journeys to start and end cities." If the chosen city was a city to visit, it is removed from that list and the status reads "Seoul removed from cities to visit." | — | — | "The trip starts and ends here. Time at home does not count as time in cities." |
| Cities to visit | `PlacePicker` "Add a city", with the right-aligned label "{n} of 4" and the title suffix "(any order)". Rows: "{City} · {CC}" · "At least [48] h" plus helper "{2} days" ("no minimum" at 0) · × (`aria-label="Remove {city}"`). Text button "Use {48} h for all cities" (first city's value) when there are ≥2 cities and the values differ. Removing a city with appointments shows "Also removed {n} appointments in {city}." | min stay 0 (unchanged) | At 4 cities the picker is disabled with "Up to 4 cities. Remove one to add another." Stay: "Enter 0 to 8,760 hours." | "The search picks the best order. Each city gets at least its minimum stay." |
| Stay sum warning | Non-blocking notice when Σ minimum stays > (end − start + 1 days) × 24: "Minimum stays add up to {Σ} h, but these dates allow at most {n} h." | — | — | — |
| Dates | "Start date" "to" "End date" (date inputs; `min` = start) | today+30 / +38 | "The end date must be on or after the start date." · "Choose up to 365 days." | "Dates use your home city's time." |
| Date mode | Radio group: "Exact dates" / "Any days in this period". Helper line: "Leave home on {4 Dec}. Be back home on {14 Dec}." or "Leave and come back on any days from {4} to {14 Dec}." | Exact | — | — |
| Departure window | Visible sentence "Leave between {09:00} and {17:00} (local time)." with a **Change** link that opens More settings › Departure times and changes and focuses `#setting-departure-start`. | — | — | — |
| Adults | `NumberField`, 1–9, integer | 1 | "Enter 1 to 9 adults." | — |
| Party-size notice | Shown when `saved.offers` (source user) or `airport_transfer_estimates` hold `adults ≠ draft.adults`: "{k} prices you entered are for {m} adults. They are not used for {n} adults." | — | — | — |
| Budget | `NumberField` (optional) "Budget for {n} adults (MYR)", placeholder "No limit" | blank | "Enter 0 or more, or leave it blank." | "Total for all adults. Options that cost more than this, even at their lowest price, move to Over budget." |
| Transport | Fieldset "Transport" with checkbox chips Flight, Train, Bus, Coach, Subway, Tram, Car, Taxi (display labels; stored values unchanged) | flight, rail, bus, coach | "Choose at least one type of transport." | "Used between all places in the trip. Car needs More settings › Cars." |
| Transit notice | Warning (same condition as today): "Trains, buses, coaches, subways and trams are not searched: transit search is not set up on this server." | — | — | "To turn it on, set TRANSITOUS_CONTACT_URL in .env after you agree the routing use with Transitous. Then restart the server." |
| More settings | One `<details>`: "More settings", with a summary of non-default groups ("All default", or for example "Start: Kuala Lumpur or Singapore · Max 1 change"). Contents in G. | closed | — | — |

**Footer.** Sticky at the bottom of the viewport while settings are open, at offset `--apply-h`. The reason text has an id and the buttons point to it with `aria-describedby`. The spinner shows only for `busyAction === "search"`.

| State | Left text | Buttons |
|---|---|---|
| Invalid | First error, in this order: "Add your home city." / "Add at least one city to visit." / "Choose at least one type of transport." / date / departure window / home times | Disabled |
| New, valid | "Ready. The search can take a few minutes." | **Save without searching** (ghost; `saveSpec()`) · **Search transport** (primary) |
| Saved, never searched | Same text | **Search transport** |
| `stale` | "Your changes need a new search." | **Search again** |
| Job exists for the current inputs, idle | — | **Start a new search** (secondary). Tip: "Starts the search again from the beginning. Saved provider responses are reused." |
| Job active | "Searching…" | Disabled |

When a search starts successfully: close settings, then on narrow screens select the Options tab, then focus `#options-title`.

### C5. Workspace and tabs

- **Same DOM at every width.** The Options column and the side panel render once. `useMediaQuery("(min-width: 1100px)")` (`isWide`) only switches ARIA attributes and the visible tab set, so nothing remounts and drafts are safe.
- **Tabs.** WAI-ARIA tabs with roving tabindex, ←/→/Home/End and automatic activation. Panels mount on first visit, then stay mounted with `hidden`.
  - Wide: tablist "Itinerary · Missing info"; the Options column is a plain `<section aria-labelledby="options-title">`.
  - Narrow: tablist "Options · Itinerary · Missing info", and the Options column gets `role="tabpanel"`.
- **Badges** are part of the accessible name:
  - Options: "{n}" ("Options, 9 best options").
  - Missing info: "{needs}" ("Missing info, 13 items need input"), or a check icon after a search with nothing missing ("Missing info, nothing missing"), or nothing before any search.
- **Activation.**
  - Selecting an option from a row (or from the chart on wide screens) activates Itinerary.
  - On narrow screens the Itinerary panel starts with **"← Options"**, which returns to the Options tab and focuses the selected row.
  - Next steps and deep links activate Missing info and focus the target.
- **Scroll padding.** `html { scroll-padding-top: calc(var(--header-h) + var(--tabs-h,0px) + 8px); scroll-padding-bottom: calc(var(--apply-h,0px) + 8px) }`, so sticky bars never hide a focused field.

### C6. Options panel

Order: **Next steps** (F1; hidden when empty) → h2 `#options-title` "Options" with tip → chart block (E2) → list toolbar → list → "Show 40 more" → Over budget group → empty states.

- **Options tip**: "Each option is a complete trip from home and back. An option is shown when no other option found is both cheaper and gives more time in your cities. Best means best among the transport found and your settings, not every ticket on sale."
- **List toolbar**:
  - "{9} best options" (+ " · {14} weaker" when shown);
  - **Sort** select ("Lowest price", "Most time in cities", "Best balance") with tip (E3);
  - checkbox **Show weaker options** with tip (E4); while loading: "Loading weaker options…";
  - "say once" line when every row includes estimated prices: "All options include estimated prices."
- **Row.** `<ol class="p-options">` › `<li>` › `<button aria-pressed>`. The selected row has a 3 px left bar in `--primary` and a `--muted-surface` background.
  1. "{01}" (position in the current order, muted) · price (E1 text, 16 px/650, tabular numbers) · right side "{218.2} h in cities".
  2. Route chain from movements: start place, then for each movement `ModeIcon` + destination + " {88.3} h" when a stay starts there. Example: "Kuala Lumpur [plane] Busan 88.3 h [plane] Tokyo 63.8 h [plane] Seoul 66.1 h [plane] Kuala Lumpur". Start and end cities show naturally. Right side: "{31.6} h travel".
  3. "{RM 24.72} per city hour" (bounded options only) and chips (exceptions only):
     - "[!] {n} not priced" (or "open-ended price");
     - "Includes estimates" (unless it is said once);
     - "May exceed budget" (bounded, `high > budget`);
     - "Estimated timetable" (warning);
     - "Weaker";
     - "Over budget";
     - "Compared".
- **Show more.** "Show 40 more ({k} left)" (`visibleCount`, reset to 40 when the sort changes, clamped when the list gets shorter). When the chart selects an option beyond `visibleCount`, the count grows and the row scrolls into view (`block: "nearest"`; focus does not move).
- **Over budget group.** `<details>` "Over budget ({k}) · from RM {x}", shown whenever `refinement_routes` is not empty. Tip: "These cost more than your budget even at their lowest price. Up to 10 are shown. A combined ticket price can make one cheaper." Rows use the same format with the "Over budget" chip. These options are not plotted.
- **Empty states**: see C12.

### C7. Itinerary panel

Specified in E9. Empty states:
- "Options appear here after a search." (never searched)
- "No option to show." (searched, none found)

### C8. Missing info panel

Specified in F2. h2 `#missing-title` "Missing info" with right-aligned status: "{13} items need input" / "Nothing missing" (check icon) / "Nothing to check yet" (before any search). Tip: "Information the search could not find. What you enter here is a draft in this browser until you select Apply. Apply updates your options once."

### C9. Apply bar (fixed at the bottom, full content width; only when drafts exist, in every tab)

- `role="region"` with `aria-label="Changes not applied"`. The shell gets `data-drafts` and `--apply-h: 64px`.
- **Text** (`aria-live="polite"` on the count): "{n} changes not applied: {1 airport change, 10 airport transfers, 2 prices}". Only non-zero parts are listed.
- **Buttons**:
  - **Discard** (ghost) asks `window.confirm("Discard {n} changes that are not applied?")`.
  - **Apply** (primary). Hint text "Ctrl+Enter" at ≥1100 px. Ctrl/Cmd+Enter runs Apply when focus is inside the Missing info panel, an itinerary price editor or the bar.
- **Invalid drafts**: Apply is disabled and the text reads "Fix {k} values" as a button that focuses the first invalid field.
- **While applying**: "Applying… ({step} of {steps})". The Missing info panel and open price editors are `inert`.
- **Success**: the bar disappears; header status "Applied · {before} → {after} best options"; focus moves to `#missing-title` (or stays in the itinerary heading if Apply started there).
- **Failure** (inline, `role="alert"`): "{Airport changes applied.} {Airport transfers} not applied: {message}. {Prices not applied.}" Unsent drafts are kept. On 409, a **Reload trip** button is added.

### C10. Footer
Text unchanged; it sits at the end of `<main>`.

### C11. Shared components

| Component | Specification |
|---|---|
| `Field` | Adds `info?: ReactNode` (an InfoTip rendered **after** the `<label>`, never inside it), `error?: string`, `hint?: string`. The id behavior is unchanged. |
| `NumberField` | Props `label, value, onChange, min, max, integer, optional, placeholder, info, id`. Keeps raw text in local state. On change: `""` → `optional ? onChange(null) : error "Required."`; NaN or out of range → error "Enter {min} to {max}." (or "Enter {min} or more."); `integer` with a decimal → "Enter a whole number."; valid → `onChange(n)`. On blur with an error, the text returns to the last committed value and the error clears. External value changes sync when the field is not focused. Rail-fallback fields use it too. |
| `PlacePicker` | Adds `disabled`, `limitText`, `placeholder`. Status text "Searching…". No match: "No matching places. Check the spelling, or add the place by coordinates." The text button is "Add a place by coordinates" / "Close". Fields: "Name", "Latitude", "Longitude", "Time zone (for example Asia/Seoul)", "Airport codes (optional, comma-separated)" → **Use this place**. Validation and messages are as today, shown inline. Option sub-line "{CC} · {codes}" or "{CC} · No airport". |
| `InfoTip` | `<details class="p-tip"><summary aria-label="About {topic}"><Info size={14}/></summary><div class="p-tip-body" role="note">…</div></details>`. Opens with click, tap, Enter or Space; closes with Esc (focus returns to the summary) or an outside click. Bubble `max-width: min(300px, calc(100vw - 32px))`; prop `align="end"` near the right edge. It never holds the only copy of a warning, value or instruction, and it is never placed inside `<label>` or `<summary>`. |
| `PriceFields` (inline, staged) | For journey prices and itinerary editors: "Price for {n} adults" (placeholder "Not priced") · checkbox "Range" → "to" (placeholder "No limit"; when blank, helper "No upper limit: the total stays incomplete.") · "Currency" (3 letters, uppercase). Commits on blur or Enter. Enter moves focus to the next `[data-price-input]` in the same section; Shift+Enter moves to the previous one; Esc restores the last staged or saved value. Errors: "Enter a price of 0 or more." · "The highest price must be at least the lowest." · "Enter a 3-letter currency code." A staged row shows "Not applied · **Undo**" in `--chart` with a dot. |
| `PriceEditor` (itinerary) | `PriceFields` plus an optional scope radio for airport access and egress (E9), plus **Set price** / **Cancel**. |
| `FixedPriceFields` | For airport transfers, combined tickets and rules: "Price" + "Highest price (optional)". A blank highest means a fixed price, as the backend does today. |
| `Tabs` | `role=tablist/tab/tabpanel`, roving tabindex, badges in the accessible name. |
| `ModeIcon` | Plane, TrainFront (rail), Bus, BusFront (coach), TrainFrontTunnel (subway), TramFront, Car, CarTaxiFront, Footprints (walk), each with sr-only text "by {mode}". All are in lucide-react 0.468 (checked). |
| `ThemeChoice` | Radio fieldset "Theme" (System / Light / Dark). Replaces the 3 header buttons; same `useTheme`. |

### C12. Loading, empty and error states

| State | Where | Copy / behavior |
|---|---|---|
| First load | Whole page | "Opening your trips…" (`role="status"`, `aria-busy`) |
| Open or copy a trip | `<main>` only; the header stays (select disabled) | "Opening {trip name}…" |
| Lazy chart / map | At the final height | "Loading chart…" / "Loading map…". On a MapLibre `error` event: "Map unavailable. Check your connection." |
| Never searched | Options | "No options yet. Search transport to find options. They appear while the search runs." |
| Searching, no options yet | Options | "Searching. The first options appear after a few searches." |
| None yet, searches left | Options | "No complete itinerary yet. {pending} searches are left." (The strip has Search more.) |
| None, nothing left | Options | h3 "No itinerary fits these settings", then only the reasons that apply, each with its action. Stay sum > date span → Edit trip. City gaps "No direct journey found between {A} and {B}." → Add a connection. Unresolved airport changes → Add airport transfer. Unresolved access time → Set default time. "Flights without a price are skipped." → Show them. Always last: "Or change the trip: fewer minimum hours, more days, more transport or wider departure times." → Edit trip. |
| Only over budget | Options | "No option fits your RM {budget} budget. {k} options cost more, from RM {x}." → **Show over-budget options** (opens the group) |
| Weaker loading | List toolbar | "Loading weaker options…" (checkbox disabled) |
| Missing info, before search | Missing info | "Unknown prices and gaps appear here after a search. You can enter airport transfers now." Then Airport transfers (all directions, collapsed) and Price rules. |
| Nothing missing | Missing info | Check icon + "Nothing missing. Every option has a complete price and every journey can be used." Saved items stay editable. |

### C13. Save status values (header)

| Event | Text |
|---|---|
| Unsaved new trip | "Not saved yet" |
| `edit()` | "Unsaved changes" |
| Invalid draft | "Fix the marked fields to save" |
| Save in flight | "Saving…" |
| Save done | "Saved" |
| Autosave failed | "Not saved" (the banner gives the reason and Retry save) |
| Copy | "Copied. Change it, then search." |
| Apply | "Applied · {a} → {b} best options" |
| Combined ticket | "Combined ticket saved · options updated" |
| Remove my price | "Price removed · options updated" |
| Connection add / remove | "Connection added · options updated" / "Connection removed · options updated" |
| Rule save / delete | "Rule saved · options updated" / "Rule deleted · options updated" |
| Weaker loaded | "Weaker options loaded" |
| Check more (optimize) / Recalculate | "Options updated" |
| Selected option disappeared after a recalculation | Appends " · Option {n} is no longer shown" |

---

## D. Terminology map (old → new, used everywhere)

| Old | New |
|---|---|
| Pareto / cost–time frontier, frontier alternatives | **best options** (list header "{n} best options"; defined in the Options tip) |
| Dominated alternatives | **weaker options** (chip "Weaker") |
| Provisional | **From RM x** (unbounded) / **RM a – b** (range); chip "{n} not priced" |
| RM x + unknown | **From RM x** (tooltip: "At least RM x") |
| Unknown fare, missing fare | **not priced** |
| Budget compliance uncertain | **May exceed budget** |
| Outside budget · fare refinement only; refinement routes | **Over budget** |
| City-stay hours, city hours | **time in cities**; compact "{h} h in cities" |
| Cost/city h; average fare per stay hour | **per city hour** |
| Total party cost, party fare | **total price for {n} adults**; input "Price for {n} adults" |
| Fare | **price** |
| Components | **journeys** (rows) / **items** (counts) |
| Shared estimate; applied shared estimates | **group price**; "Group prices you set" |
| Save estimate / Saved for apply / Changes not saved | Commit on Enter or blur → **Not applied** |
| Apply saved estimates / Discard saved estimates | **Apply** / **Discard** |
| Save fare (FareEditor) | **Set price** (draft) |
| Reset | **Undo** (draft) / **Remove my price** (saved, immediate) |
| Discovery; Discover transport; Transport discovery | **search**; **Search transport**; Search |
| Cancel discovery | **Stop search** |
| Continue searching / Retry failed searches / Continue optimizing (×2) | **Search more** / **Retry failed searches** / **Check more combinations** |
| Queries processed / pending | **searches done / left** |
| Provider requests; cache hits; manual quotes (no request) | **requests to data providers; answered from saved results; combined tickets to check** |
| Provider status and coverage | **Details › Messages from data providers** |
| Discovery queue exhausted / Preliminary discovery | **Search complete / Search finished with gaps** |
| Optimization complete / incomplete | **all combinations checked / Not all combinations were checked** |
| Snapshot {n}; completed histories; labels | **data version {n}; complete itineraries checked; combinations explored** |
| Provider requests per batch | **Requests per search batch** |
| Save & recalculate | **Save without searching** (new trip) / **Recalculate options** (⋯ menu) |
| New from existing; New; Saved trips | **Copy trip; New trip; Trip** |
| Saved locally | **Saved** |
| Home / base city; Required cities; visit order is flexible; minimum stay | **Home city; Cities to visit; any order; At least {n} h** |
| Possible departure / arrival cities; positioning; gateway | **Start the trip from / End the trip at; travel to start and end cities; start / end city** |
| Home time limits and positioning services | **Start and end cities** |
| Outbound / Return | **before the trip / after the trip** |
| Search + supplied services / Supplied services only / Unavailable | **Search / Your journeys only / Don't use** |
| Supplied (positioning) service | **your journey** |
| Earliest departure from home / Latest arrival home | **Leave home after / Be home by** |
| Fixed outward and return dates / Optimize within this date window | **Exact dates / Any days in this period** |
| Adult travelers; Total party budget · MYR | **Adults; Budget for {n} adults (MYR)** |
| Maximum transfers per intercity journey | **Max changes per journey** |
| Local departure window | **Leave between … and … (local time)** |
| Allowed intercity transportation; lowercase mode values | **Transport;** Flight, Train, Bus, Coach, Subway, Tram, Car, Taxi, Rental car, Any |
| Allow overnight travel | **Allow overnight journeys** |
| Estimated rail timetable(s) | **Estimated timetable(s)**; settings group "Estimated train timetables" |
| Ignore flights with unknown fares | **Skip flights without a price** |
| Fixed commitments | **Fixed appointments** |
| Minimum connection; before/after flight; before/after train/bus | **Minimum change time; At the airport before a flight; After landing; At the station before a train or bus; After a train or bus** |
| Fallback airport transfer per side | **Default airport transfer time** |
| Car availability and rental assumptions; Saved exchange rates | **Cars; Exchange rates (MYR for 1 unit)** |
| Airport ↔ city transfers; Airport access / egress | **Airport transfers**; "{Taxi} {city} → {KUL} airport" / "{Taxi} {PUS} airport → {city}" |
| Airport connections; unresolved | **Airport changes; can't be used** |
| Missing city connections; assumed connection | **No direct journey found; connection you add / Connections you added** |
| Reusable pricing rules; per person / whole party / per vehicle | **Price rules · all trips; Per person / Per group / Per vehicle** |
| Bundle; Enter a combined flight ticket price; quote searches | **combined ticket; Add a combined ticket price; Combined tickets to check** |
| `requires_manual_quote` / `success` / `empty` / `failed` / `unsupported` | **Check the price yourself / Quote found / No results / Search failed / Not supported** (other values shown as they are) |
| Itinerary details; Time in each required city; Ticket purchases and cost breakdown | **Itinerary (Option {n}); Day by day; Tickets and prices** |
| Standalone {mode} fare; Open flight search | **{Mode} price; Search fare** (opens a new tab) |
| Order frontier alternatives; Lowest known total / Most city-stay hours / Balanced | **Sort; Lowest price / Most time in cities / Best balance** |
| Log cost / Log city hours / Fit axes to data | **Log scale for price / Log scale for time in cities / Fit axes to data** |
| Compare selected itinerary with | **Compare with** |

---

## E. Results, chart, comparison and itinerary rules

### E1. Price states (honesty rules)

| State | Condition | Text | Chart | Per city hour | Chips |
|---|---|---|---|---|---|
| Exact | `total_cost_myr !== null` | "RM 5,395" | Filled circle; diamond when `priceEstimated` | "RM 24.72 per city hour" | "Includes estimates" if `priceEstimated` |
| Range | `total === null && high !== null` | "RM 6,187 – 6,227" | Band from low to high + hollow marker at the middle | "RM 28.0 – 28.2 per city hour" | — |
| Unbounded | `cost_high_myr === null` | "From RM 2,480" + "{n} not priced" (or "open-ended price") | Hollow circle at low + short dashed arrow | Not shown | "[!] {n} not priced" |

Rules:
1. A lower bound always reads "From" or "at least".
2. No single total, per-hour value or exact price difference is ever computed for an unbounded option.
3. `priceEstimated(route) = route.purchases.some(o => o.estimated || o.source === "rule" || o.currency !== "MYR")`. This mirrors the backend; timetable estimates have their own chip.
4. `unpricedSummary(route, rates)` counts purchases with `low === null` or a currency without a rate as **not priced**, and purchases with `low !== null && high === null` as **open-ended**. It maps `movement_ids[0]` to movement or charge, and groups them as flights / trains / buses (bus and coach) / airport transfers (charges "Airport access/egress") / airport changes ("Airport transfer …") / other. Text: "10 not priced: 2 flights, 8 airport transfers".
5. Money: `moneyShort(v, cur)` prints whole amounts without decimals ("RM 5,395") and other amounts with 2 decimals. Foreign currencies use `currencyDisplay: "code"` ("JPY 12,000"). `money()`, `routeCost()` and `cityHourCost()` stay unchanged (the tests assert them).

### E2. Chart (`ParetoExplorer`, lazy)

Heading "Price vs. time in cities" with tip: "Each mark is an option. Further right costs more; higher gives more time in your cities. The dashed steps join fully priced best options."

- x axis: "Total price for {n} adults (MYR)".
- y axis: "Time in cities (h)". Each adds " (log)" in log mode.

| Series | Data | Mark | Style (tokens) | Click |
|---|---|---|---|---|
| `weaker` | `dominated_routes` (when shown), every price state | Same shape vocabulary, size 7, no arrow tail | `--chart-muted`, opacity .7 | Selects |
| `frontier` | Exact best options sorted by total | line, `step: "end"`, dashed 1.5 | `--chart` | Silent |
| `budget` | `markLine.data: [{ xAxis: budget }]` on `frontier`, `symbol: "none"`, label "Budget" | Vertical dashed | `--muted-foreground` | Silent |
| `exact` | Exact best options | circle 11 / diamond 11 | `--chart`, border `--card` 2 | Selects |
| `range-band` | Ranges | line, segments `[low,y],[high,y],[null,null]`, `connectNulls:false`, width 6 | `--chart-range`, opacity .35 | Silent |
| `range-mid` | Ranges | `emptyCircle` 11 at the midpoint | `--chart-range` | Selects |
| `lower-tail` | Unbounded | line, segments `[low,y],[tailEnd,y],[null,null]`, dashed 1.5 | `--chart-range` | Silent |
| `lower-head` | Unbounded | `triangle`, `symbolRotate: -90` (points right), size 7, at `tailEnd` | `--chart-range` | Silent |
| `lower-point` | Unbounded | `emptyCircle` 11 at low | `--chart-range`, border 2 | Selects |

Details:

- **Selected**: size ×1.5, fill `--chart-selected`.
- **Compared**: `borderType: "dashed"`, `borderColor: --chart-selected`, width 2.
- **Tail length**:
  - linear axis: `0.06 × (xMax − xMin)`, where `[xMin, xMax] = axisBounds(values,false,fit)`; when fit is off, use `[0, max(values) × 1.08]`;
  - log axis: `low × (xMax/xMin)^0.06`;
  - the end is clamped to `xMax`.
- **Axis values** include every plotted low, every range high, every exact total, and the budget when it is ≤ 1.25 × the largest of the other values. "Log scale for price" stays disabled unless every plotted value is > 0 (unchanged rule).
- **Stacks**: one data item per key `class|round(x)|round(y*10)` (ranges also key on the high). Label "×{n}" (`position: "right"`, 11 px, `--muted-foreground`). `routeId` = the first option in list order. There is no click cycling; the list is the precise selector.
- **Tooltip** (each line separate):
  - "Option {04}" (stacked: "Options {05, 06, 07}");
  - "From RM 5,400 (at least)" / "RM 6,187 – 6,227" / "RM 5,395";
  - "{221.1} h in cities · {29.7} h travel";
  - "{6} not priced" or the per-hour value;
  - "Includes estimates".
- **Legend**: visible HTML below the chart, listing only the items present: "Priced (filled circle)", "Includes estimates (diamond)", "Price range (band; the marker is the middle, not an expected price)", "At least this price: some items not priced (hollow circle with arrow)", "Weaker option (grey)", "Your budget (dashed line)", "Selected", "Compared (dashed ring)".
- **Chart options** (`<details>` "Chart options"): "Log scale for price", "Log scale for time in cities", "Fit axes to data" (on by default). Disabled reason as visible text: "Needs all values above 0". Tip: "Fitted axes show small differences and may not start at 0. Log scales compare proportional changes." **Reset zoom** appears only after a `datazoom` event. Zoom works as today (inside the chart and with the slider); the view signature is kept when only the selection changes.
- **Accessibility**: `role="img"` with an `aria-label` such as "Price versus time in cities for 9 options: 0 fully priced, 0 price ranges, 9 not fully priced. Known prices RM 2,480 to RM 5,710. Time in cities 218 to 221 hours. The option list has every option." Animation is off under `prefers-reduced-motion`.
- **Colours**: all from tokens, re-read on a theme change. The hex values `#e28b3c`, `#9ba9ae` and `#b58a46` are removed.

### E3. Ordering (`sortRoutes(routes, key)`)

| Sort | Rule |
|---|---|
| **Lowest price** (default) | Bounded options first, by highest possible price (`total ?? high`) ascending, then low ascending, then time descending, then id. Then unbounded options, by low ascending, then time descending, then id. |
| **Most time in cities** | Time descending, then highest possible price ascending (unbounded after bounded at equal time), then id. |
| **Best balance** | Normalized highest possible price + normalized time (equal weights) over bounded options; unbounded last, by low. |

Sort tip: "Lowest price ranks options by their highest possible price. Options without a complete price come last, by their known part. Sorting does not change which options are best." Numbers ("01") are positions in this order and are used by the list, chart, compare and itinerary.

### E4. Weaker options
- The load logic is unchanged: the first time, `saveSpec` → `optimize {include_dominated:true}` → GET trip → accept. The toggle turns off on failure and turns itself off when a newer result has no `dominated_routes`.
- Tip: "Other complete itineraries from this search. Another option costs the same or less, even at its highest price, and gives at least as much time in cities. Loading them recalculates saved data; no new search. Some were removed earlier in the search."

### E5. Over-budget candidates
`refinement_routes` appear in the "Over budget" group, always reachable. They are selectable and not plotted. Itinerary header: "Over budget: costs more than your RM {budget} budget even at its lowest price. A lower combined ticket price can bring it within budget."

### E6. Budget uncertainty
- Bounded with `high > budget`: chip "May exceed budget"; itinerary line "May exceed your budget (up to RM {high})".
- Unbounded with a budget set: stated once, in the Next steps price row ("Until then, options may exceed your RM {budget} budget.") and in the itinerary not-priced line ("· may exceed your budget"). It is never a chip on every row.
- With no budget, nothing is shown.

### E7. Comparison (`compareText(sel, oth, nSel, nOth)`)

Select "Compare with" in the itinerary header: "None" plus "Option {02} · {price text} · {h} h". It resets on open and copy. The compared option gets a dashed ring in the chart and the "Compared" chip.

| Case | Text |
|---|---|
| Both exact | "vs Option {k}: {2.9} h {more/less} time in cities and RM {d} {more/less}." When Δh > 0 and Δprice ≥ 0, add " That is RM {r} per extra hour." |
| Both bounded, at least one range | Interval `[sel.low − oth.high, sel.high − oth.low]`: "… and RM {a} – {b} {more/less}" (when the interval crosses 0: "… between RM {a} less and RM {b} more"); per-hour as a range when Δh > 0 and the interval is ≥ 0. |
| Any unbounded | "vs Option {k}: {2.9} h {more/less} time in cities. Price difference unknown: {this option / Option k / both options} {has/have} items that are not priced." |
| Dominant | "This option has more time in cities and costs less." |

Zero values read "the same time in cities" and "the same price".

### E8. Selection sync and persistence
- The fallback is unchanged: selected id → displayed routes → refinement routes → first displayed route.
- A chart click selects and scrolls the row into view. A row click selects, highlights the mark and, on narrow screens, opens Itinerary and focuses `#itinerary-title`.
- Route ids change when transfer prices change. Keep `lastSignature = routeSignature(selected)`, where `routeSignature = JSON.stringify([departure_gateway, arrival_gateway, movements.map(m => [m.template_id ?? m.id, firstServiceDeparture(m)])])`. `firstServiceDeparture` is the first segment departure whose mode is not transfer/walk/foot/wait, otherwise `m.departure`.
- When `selectedId` disappears after a new result, select the route with the same signature. Otherwise fall back and append " · Option {n} is no longer shown" to the status. The comparison uses the same rule.

### E9. Itinerary panel (selected option)

1. **Header**
   - On narrow screens, "← Options" first.
   - h2 `#itinerary-title` "Option {01} of {9}" (over budget: "Over-budget option {n} of {k}").
   - Price (20 px/650) and chips.
   - Line "[!] {10} not priced: {2 flights, 8 airport transfers}{ · may exceed your budget}" with the link **See prices** (scrolls to the first not-priced row).
   - Metrics "{218.2} h in cities · {31.6} h travel{ · RM 24.72 per city hour}". The "in cities" tip: "Hours in your cities from arrival to departure, nights included. Travel, airport and station time do not count. Time at home and in start or end cities does not count."
   - Budget line (E6) and Compare (E7).
2. **Map**: `<details>` "Map", open ≥1100 px, closed below. The lazy chunk loads only when the disclosure is open. Tip: "City points with straight lines between them. Lines do not show the real road or track. Blue: flight; brown: car or taxi; green: other transport."
3. **Day by day** (tip: "Times are local to each place. Journey times are door to door.") is one chronological list:
   - **Journey row** (`<details>`; the first one is open at ≥1100 px).
     - Summary: "{Fri 4 Dec} · {08:00} → {18:54}" (the arrival date is added when it differs) · "{Kuala Lumpur} → {Busan}" · ModeIcon + "{AirAsia X D7530}" (single main service) · "{9 h 54 min}".
     - Chips: "Estimated timetable", "Your connection", "Your journey", "{n} not priced".
     - Body: steps (table below), the timetable notice "Estimated timetable · copied from {date} (or: from an extended provider calendar). Check the real timetable before you book.", then the source line "{Google Flights / Transitous / Road estimate / Your connection / Your journey} · {n} changes · {km} km" and the link **Search fare** (`movement.search_url`, new tab, with "(opens in a new tab)" in sr-only text).
   - **Stay row**: "{Busan} · {88.3} h{ (at least 24 h)}" (the minimum shows only on the first visit) · "{Fri 4 Dec 18:54} → {Tue 8 Dec 11:15}" · `<progress>` (share of all time in cities).
   - **Not-counted row**: when the gap between consecutive movements at a place with no stay is ≥ 30 min: "Time in {Singapore} · {5 h} · not counted in time in cities".

   **Step text** (`stepLabel(segment, movement)`). Each step starts with its local start time (`segment.from_timezone`, else the movement's origin). Durations read "45 min" / "1 h 30 min".

   | Segment | Text |
   |---|---|
   | transfer · "Airport access" / "User-estimated airport access" | "{Taxi / mode} to {to_name} · {dur}" + " (estimate)" when `assumed` |
   | wait · "Flight readiness buffer" | "At the airport before the flight · {dur}" |
   | flight | "{operator} {service} · {from_name} {dep} → {to_name} {arr}" |
   | wait · "Scheduled connection" | "Connection at {from_name} · {dur}" |
   | {mode} · "User-verified airport transfer" | "{Mode} from {from_name} to {to_name} · {dur} (your airport change)" |
   | wait · "Layover after airport transfer" | "Wait at {to_name} · {dur}" |
   | transfer · "Airport change needs confirmation" / "Airport transfer exceeds available layover" | "[!] Airport change {from} → {to} is not confirmed" / "[!] Your airport change takes longer than the layover" |
   | wait · "Arrival buffer" | "After landing · {dur}" |
   | transfer · "Airport egress" / "User-estimated airport egress" | "{Mode} to {to_name} · {dur}" (+ " (estimate)") |
   | walk / foot | "Walk to {to_name} · {dur}" |
   | Transit leg (rail-like MOTIS modes → Train; bus, coach, subway, tram) | "{Mode} {service} · {operator} · {from_name} {dep} → {to_name} {arr}" |
   | source "User-supplied positioning" | "{Mode} {service} · {from} {dep} → {to} {arr} (your journey)" |
   | Any other | "{Mode}: {from_name} → {to_name}" (+ times) |

4. **Tickets and prices** (tip: "Each ticket is counted once. A combined flight ticket does not include airport transfers. Prices are quotes or estimates, not booking guarantees."). The header right side shows "Total {price text}", plus " · Totals update after you apply." when drafts touch this option. Rows come from `route.purchases` in itinerary order: each movement's ticket, then its access, egress and airport-change charges, then extra charges. A combined ticket appears at its first covered flight.

   | Row | Label | Actions |
   |---|---|---|
   | Movement | "{Flight} {Kuala Lumpur} → {Busan} · {4 Dec}{ · AirAsia X D7530}" | **Set price** (PriceEditor, draft key `component:{template_id ?? id}`) · **Search fare** (flights) · **Remove my price** (user prices only; immediate DELETE of `storedOfferId(purchase)`) |
   | Access / egress charge | "{Taxi} {Kuala Lumpur} → {KUL} airport" / "{Taxi} {PUS} airport → {Busan}" | **Set price** with a scope radio: "Applies to (o) All {Kuala Lumpur → KUL airport} transfers in this trip / ( ) Only this journey ({Fri 4 Dec})". "All" sets the transfer draft for the row of that direction whose method = `charge.mode`; if no such row exists, it appends `{mode, duration:"", …}`. "Only this journey" sets the component draft. The default is "All", except "Only this journey" when the charge already has a user offer. |
   | Airport-change charge "Airport transfer A → B" | "Airport change {GMP} → {ICN} · {Train}" | **Edit in Missing info** (activates the tab and focuses that row) |
   | Extra charge (rental) | "Rental car · {3 days}, pickup and drop-off" | **Set price** (component draft) |
   | Combined ticket | "Combined ticket · {Round trip / Multi-city} · {2} flights" + the covered flights in small text | User ticket: **Remove** (immediate). Disclosure "Separate prices" with one PriceEditor per covered flight. |

   Amount: "RM 2,180", "RM 210 – 250", "RM 900 or more" (open-ended), "JPY 12,000 · needs an exchange rate", or "Not priced". When a draft exists, the draft amount shows with "Not applied · Undo".

   **Source labels** (`sourceLabel(offer)`):

   | Offer | Text |
   |---|---|
   | provider, label "Stale quote: …" | "{mapped label} · older quote" |
   | provider "Google Flights …" | "Google Flights" |
   | provider "GTFS fare products for party" | "Transit fare" |
   | other provider | Label as it is |
   | user "Shared estimate: …" | "Your group price" |
   | user "Manually entered whole-ticket party fare" | "Your combined ticket price" |
   | user, id `positioning-fare:` | "Your journey price" |
   | other user | "Your price" |
   | rule "Trip airport transfer estimate" | "Your airport transfer price" |
   | rule "Configured driving cost" | "Driving cost (Cars settings)" |
   | rule, id `charge:` with label "Rental…" | "Rental settings" |
   | other rule | "Rule: {name}" |
   | unknown | "Not priced" |

5. **Add a combined ticket price** (`<details>`; only when the option has ≥2 flights).
   - Visible line: "Choose the flights your ticket covers and enter the total for all adults. Airport transfers stay separate."
   - Checkboxes "{Kuala Lumpur} → {Busan} · {4 Dec}", all checked by default and reset per option. Their values are `template_id ?? id`.
   - Fields: "Ticket type" (Multi-city / Round trip) · "Price for {n} adults" · "Highest price (optional)" · "Currency".
   - **Save combined ticket**, immediate: `updatePrice({id:"bundle:"+uuid, movement_ids, kind, low, high: high || low, currency, source:"user", estimated:true, label:"Manually entered whole-ticket party fare", validated:true})`.
   - Inline errors: "Choose at least 2 flights." · "A round trip covers 2 flights in opposite directions." · "Enter a price of 0 or more." · "The highest price must be at least the lowest." · "Enter a 3-letter currency code."
   - Below the form: the matching quote searches (`matchingQuoteLinks`: every leg's `from_id`, `to_id` and date equals one of this option's flights, using the first flight segment's local departure date). Example: "Round trip: Kuala Lumpur → Seoul (4 Dec) · Seoul → Kuala Lumpur (14 Dec) · Check the price yourself · Open search".
6. **Check before booking** (visible list; `assumptionNotes(route)` de-duplicates):

   | Pattern | Note | Action |
   |---|---|---|
   | `/^(.+): (\d+) minute airport transfer assumption; road routing unavailable$/` | "Airport transfer times are estimates ({45} min each, no road data): {cities}." | **Set transfer times** → Missing info › Airport transfers |
   | "User supplied connectivity and timing" / "User-defined travel time and connectivity" | "Your connection {A → B} is assumed to exist." | — |
   | starts with "Estimated timetable based on" | "{A → B} uses an estimated timetable copied from {date}. Check the real timetable." | — |
   | starts with "Estimated timetable: provider repeated service" | "{A → B} uses an estimated timetable (extended provider calendar). Check the real timetable." | — |
   | starts with "Station search within" | "{A → B} uses stations up to {25} km away. Check how you get to them." | — |
   | "Driving time estimate; …" | "Driving times are estimates without traffic. Rental cars are not checked for availability." | — |
   | "User supplied city-to-city schedule; …" | "Your journey {A → B} uses the times you entered." | — |
   | `priceEstimated` | "{k} prices are estimates (your prices, rules or older quotes)." | — |
   | Anything else | Raw text | — |

---

## F. Refinement: Next steps and Missing info

### F1. Next steps (top of the Options column; at most 3 rows visible, then "Show {k} more")

Each row: an icon, one sentence and at most one button. Rows appear in this priority order:

| # | Shown when | Copy | Action → target |
|---|---|---|---|
| 1 | Σ `unresolved_journey_count` > 0 | "{1} flight journey can't be used until you add the transfer from {GMP} to {ICN} airport." (several pairs: "…until you add {k} airport transfers ({GMP → ICN}, …).") | **Add airport transfer** → Missing info › Airport changes; focus the first unresolved row's "Way" select |
| 2 | Movements whose assumption contains "airport access time is unresolved" | "{j} journeys can't be used: the airport transfer time is unknown in {Busan, Seoul}." | **Set default time** → open settings › Time buffers; focus `#setting-airport-fallback` |
| 3 | A best option has `cost_high_myr === null` | "{No option has a complete price yet / {k} of {N} options are not fully priced}: {10} airport transfer prices and {2} flight prices are missing." + "{m} options need only airport transfer prices." (when m>0) + "Until then, options may exceed your RM {budget} budget." (when a budget is set) | **Add prices** → Missing info; focus the first missing price input (airport transfers first) |
| 4 | Groups with reason `exchange_rate` | "Prices in {JPY} need an exchange rate." | **Add rate** → focus the inline rate field of the first such row |
| 5 | `exclude_unpriced_flights` | (info) "Options that need a flight without a price are hidden." | **Show them** → `edit({...draft, exclude_unpriced_flights:false})` (autosave) |
| 6 | Transit not configured and a transit mode is on | (info) "Trains, buses, coaches, subways and trams were not searched: transit search is not set up on this server." | — |

Counting rules:
- Row 3 counts rows the user fills, not components: airport-transfer directions with a missing price, plus journey-price groups by mode ("flight prices", "train prices", or "other prices").
- `m` = best options whose not-priced purchases are all Airport access or egress charges.
- Demo: rows 1, 3 and 6, with "10 airport transfer prices and 2 flight prices", "6 options need only airport transfer prices".

### F2. Missing info sections (order = priority)

Each section is a `<section>` with an h3, a right-aligned status, a tip, and a body. A section is hidden when it has no content, except Airport transfers (for saved trips) and Price rules.

| # | Section | Rows and controls | Status | Tip |
|---|---|---|---|---|
| 1 | **Airport changes** | One row per directed pair (`airportChangeRows`: requirements from `result.coverage` else `saved`, plus saved connections). Title "{GMP} → {ICN} · {Gimpo International} → {Incheon International}". Status "{1} journey · {1} can't be used" (warning when >0). Saved-only pairs go in `<details>` "Other saved airport changes ({k})" with "Saved · not used now". Inputs: "Way" (Choose / Taxi / Train / Bus / Coach / Subway / Tram / Car) · "Time (min)" · "Price for {n} adults (optional)" (one amount) · "Currency". **Clear** on required rows, **Remove** on saved-only rows; both are drafts. | "{1} to confirm" / "Done" | "Some flights land at one airport and continue from another. Enter a transfer you checked. Its time must include your own buffer and fit the layover. One entry applies to every journey with this change. The other direction is a separate entry. A blank price stays not priced." |
| 2 | **Airport transfers** | Callout when F1 row 2 applies: "[!] {j} journeys can't be used: the airport transfer time is unknown in {cities}. Enter a time below, or **set a default airport transfer time**." Then one block per direction from `transferDirections()`. Header: the server row label ("Kuala Lumpur → KUL airport"); status "Price missing · in {9} options" (warning), "RM {130} for {2} adults", or "Not used now". Method rows: "Way" select · "Time (min)" (placeholder "Road time" for taxi, "Required" otherwise) · "Price for {n} adults" (placeholder "Not priced") · "Highest price (optional)" · "Currency" · × (`aria-label="Remove {label} {way}"`). Links: "+ Add another way" (the next unused mode; disabled at 7 with "All ways added."), "Show journeys ({k})" (the charges of this direction in current results: "{Fri 4 Dec 07:20} · {flight to Busan}" with a per-journey `PriceFields` (component draft) and **Remove my price** when a user offer exists), and "{k} journeys use their own price" when user offers exist on those charges. Order: missing (by options, descending) → used and priced → `<details>` "Other airports ({4})". Before any search, every direction is inside `<details>` "Airport transfers ({14} directions)". | "{10} without a price" / "Done" | "Travel between each city and its airports, for {n} adults. A price or time here applies to every matching journey in this trip, also after new searches. A price you set for one journey overrides it. A blank taxi time uses the road time, or the default airport transfer time. Times are your estimates, without timetables." |
| 3 | **Journey prices** | Groups from `groupMissingFares` without "Airport transfer …" labels and without access/egress groups that match a transfer row. Row: "{Flight} · {Kuala Lumpur} → {Busan}" · "in {3} options" · "{1} journey · {Fri 4 Dec 10:15} · {AirAsia X D7530}" (or "{3} journeys · {4–9 Dec}"), with times in the origin city, not UTC · **Search fare** (the first component's `search_url`) · `PriceFields` (group draft, key `group.key`; ids = `canonicalIds(...)`). "Show journeys ({k})": per-journey `PriceFields` (key `component:{canonical}`) + **Remove my price** when saved. When per-journey drafts exist in the group: "{k} journeys have their own draft price. A group price replaces them." `exchange_rate` reason: "Price is in {JPY}. 1 {JPY} = [ ] MYR **Add rate** (writes `exchange_rates` through `edit()`, which autosaves) or enter the price in MYR." Show 25, then "Show 25 more ({k} left)". `<details>` "Other drafts ({k})": staged entries whose key matches no visible row, shown by their label, with **Undo**. | "{2} without a price" / "Done" | "Journeys with the same route, type, transport, currency and reason share one row, also on different dates. A row price applies to each journey in the row. New searches can add journeys without a price." |
| 4 | **Connections between cities** | Gaps (`cityGaps(saved)`): "{Busan} and {Tokyo}: no direct journey found." **Add {Busan → Tokyo}** / **Add {Tokyo → Busan}** (prefills the form, opens it, focuses Transport). "Connections you added" (`assumedConnections(saved)`): "{Busan} → {Tokyo} · {Bus} · {4 h 30 min} · {any time / Mon 7 Dec 09:00 → 13:30}" **Remove** (immediate; unchanged API). `<details>` "Add a connection": "From", "To" (trip places), "Transport", radio "Any time" / "Fixed times", "Travel time (hours)" (Any time only), "Distance in km (optional)", "Departs ({From} time)" and "Arrives ({To} time)" (Fixed times only, via `localInputToISO`), **Add connection** (immediate; the form resets on success). Errors inline: "Choose two different places." · "Enter a travel time above 0." · "Enter both times, or choose Any time." · "Arrival must be after departure." · DST message. | "{k} gaps" | "No direct journey was found in either direction. Routes through other places can still connect these cities. A connection you add is assumed to exist." |
| 5 | **Combined tickets to check** (`<details>`) | Job links first, else coverage links: "{Round trip / Multi-city}: {Kuala Lumpur → Seoul (4 Dec)} · … · {status label} · **Open search**" | "{2}" | "The search can't read these prices. Open the search, then enter the total on an option: Tickets and prices › Add a combined ticket price." |
| 6 | **Group prices you set** (`<details>`) | `appliedSharedGroups` rows: label without "Shared estimate: " · "{k} journeys" · `PriceFields` (placeholder "Mixed" when values differ; note "Values differ. A new price sets one value for all.") | "{k}" | "Prices you set for a group of journeys." |
| 7 | **Price rules · all trips** (`<details>`) | List rows: "{name}" / "{Taxi} · {RM 80 – 120}{/km} · {per vehicle (4 seats)} · {from KR} · priority {0}" with **Edit** (loads the form) and **Delete** (`window.confirm('Delete the rule "{name}"? It applies to all trips.')`). Form (FixedPriceFields): "Rule name" · "Transport" (Any, Flight … Taxi, Rental car) · "From" / "To" (Any place, trip places, "{CODE} airport") · "Service or operator (optional)" (tip: "Matches an operator or service name. Use 'Airport access' or 'Airport egress' for airport transfers.") · "Country of departure (optional, 2 letters)" · "Pricing" (Fixed or range / Per km) · "Price" · "Highest price (optional)" · "Currency" · "Charged" (Per person / Per group / Per vehicle) · "Seats per vehicle" (Per vehicle only, 1–9) · "Priority" (tip "A higher priority wins. Default 0."). **Save rule** (immediate) / **New rule** (clears the form). Inline errors: "Enter a rule name." · "The highest price must be at least the lowest." · "Enter a 3-letter currency code." · "Enter 1 to 9 seats." | "{n} rules" | "Rules give prices to items that have no price, in all your trips. At equal priority the most specific rule wins. Per-vehicle prices use the seats per vehicle." |

**Needs-input count** (tab badge, header status):

- unresolved airport-change pairs
- \+ airport-transfer directions with a missing price
- \+ journey-price groups (including exchange-rate groups)
- \+ distinct cities with unresolved access time
- \+ city gaps (**only** when no best option exists)

Demo: 1 + 10 + 2 = **13**.

### F3. Prioritisation
1. Blocking items first: airport changes, then unresolved access time. They remove options entirely.
2. Then prices, ranked by the number of options affected (the existing `groupMissingFares` count across best, weaker and over-budget routes). Airport transfers come before journeys because one row prices every matching journey, now and in later searches. In the demo, 10 transfer rows fully price 6 of 9 options.
3. Ties break by `break_even_myr` (when non-null), then by label. `break_even_myr` is never the primary rank: it is null whenever no option is fully priced, and the last route written wins.
4. Then gaps, combined tickets, group prices, rules.

### F4. Draft model and Apply

| Store | Key | Persistence |
|---|---|---|
| Fare drafts (`SharedFare`, shape unchanged) | `group.key` / applied label / `component:{canonicalId}` | `wayfinder:pending-estimates:{tripId}` (key and format **unchanged**; `stage()` overlap rule unchanged) |
| Transfer drafts (`TransferRowDraft[]` per direction, same shape as today's `Draft`) | `JSON.stringify([from_id, to_id, adults])` (unchanged) | `wayfinder:pending-inputs:{tripId}`.transfers (**new key**) |
| Airport-change drafts (`AirportChangeDraft \| null`; null = clear or remove) | `"{FROM}>{TO}"` | `wayfinder:pending-inputs:{tripId}`.airportChanges |

- `useTripDrafts(tripId)` loads on a `tripId` change, writes only when `state.tripId === tripId`, and wraps every storage access in try/catch.
- A staged value equal to the saved value deletes the key.
- Drafts are deltas and merge into the latest server lists when Apply runs, so directions or pairs the user did not edit are never overwritten.
- **Canonical ids**: `templateOf = Map(route movement id → template_id ?? id)` over best, weaker and over-budget routes; `canonical(id) = templateOf.get(id) ?? id` (charges map to themselves). Apply this before `stage()`. Then de-duplicate.
- **Active fare drafts**: component ids are filtered by `knownComponentIds` = `saved.fare_component_ids` if present, else snapshot movement and charge ids plus result route component ids (today's fallback, extracted). Drafts that become empty are listed under "Other drafts".
- **Apply sequence** (`applyDrafts()`, `busyAction = "apply"`; the session token is checked after every `await`; the first failure stops the run and keeps the remaining drafts):
  1. Airport changes (if any): `saveSpec()` → `PUT /trips/{id}/airport-connections {connections: buildAirportConnections(rows, drafts)}` → `GET /trips/{id}` → `accept` + `acceptResult` → clear those drafts.
  2. Transfers (if any): `saveSpec()` → `PUT /trips/{id}/airport-transfer-estimates {estimates: buildTransferEstimates(rows, saved estimates, drafts, adults), expected_revision}` → `accept(updated)`; `acceptResult(updated.result)` when present → clear.
  3. Fares (if any active): `applySharedFares(active)` (unchanged) → clear the fare drafts and remove the storage key.
  4. Status "Applied · {before} → {after} best options" (from the returned result).
- **Builders keep today's validation**, with messages prefixed by the row label: "{Kuala Lumpur → KUL airport}: use each way once." · "…: enter a price of 0 or more, and a highest price at least as large." · "…: enter a travel time above 0 for {Train}." · "…: enter a 3-letter currency code." · "{GMP → ICN}: choose a way and a time above 0, or clear the row." `buildTransferEstimates` iterates **all** rows, keeps estimates for other party sizes, and leaves out a fully blank taxi row (unchanged).
- **Keyboard**: Enter / Shift+Enter move between price inputs of a section; Esc reverts a field; Ctrl/Cmd+Enter applies. No single-key shortcuts.

### F5. Precedence (explained once, in the Airport transfers tip and the "own price" line)
For each item the price used is, in order:
1. your price for that journey (any user offer; the last write wins);
2. else your airport transfer price (trip rule at priority 1,000,000);
3. else other rules by priority;
4. else the provider price.

An unknown price stays not priced. Offers on a flight's template apply to all its transfer variants.

### F6. Immediate actions (never drafts)
- Remove my price
- Save combined ticket / Remove combined ticket
- Add connection / Remove connection
- Save rule / Delete rule
- Exchange rates and "Skip flights without a price" (trip settings, autosave)

---

## G. Settings organisation (Trip settings › More settings)

The "More settings" `<details>` summary lists non-default groups ("All default" otherwise). Inside, each group is a `<details>` with a title and a summary line. A changed group shows a dot with sr-only "(changed)". Defaults are unchanged.

| Group | Summary example | Fields, validation and tips |
|---|---|---|
| **Start and end cities** | "Start: Kuala Lumpur or Singapore · End: Kuala Lumpur · leave home after 07:00 · 1 journey" / "Home only" | **Start the trip from**: checkbox "{Kuala Lumpur} (home)", chips for other cities (×), `PlacePicker` "Add a start city" (max 3 including home; when full: "Up to 3 start cities, including home."). Home is shown checked when the list is empty or includes home. Unchecking home is allowed only while another city is listed (otherwise disabled, with the hint "Add another start city first."). Adding a city keeps home's state (sign-off I6-5). Removing the last other city while home is unchecked stores `[]` (home). **End the trip at**: the same rules for arrivals. **Home times ({Asia/Kuala_Lumpur})**: "Leave home after [--:--] on {4 Dec}", "Be home by [--:--] on {14 Dec}"; same-day error "Be home after you leave home."; tip "Blank means any time on that day. Also applies with flexible dates." **One `<details>` per non-home city and direction**: "Travel from {Kuala Lumpur} to {Singapore} (before the trip)" / "Travel from {Singapore} to {Kuala Lumpur} (after the trip)", summary "{Search} · {1} journey". It contains: (1) "How to travel": one select per mode **turned on for the trip** (Search / Your journeys only / Don't use), with the note "Only transport types turned on for this trip are listed." (policies for hidden modes are kept); (2) the warning "{Train}: only your journeys are allowed here, but you have not added one. It gives no options."; (3) "Your journeys": "{label} · {Train} · {Fri 4 Dec 07:00} → {12:30} · {RM 120 / Not priced} for {n} adults" (+ " · not used: {Train} is off for this trip" / "set to Don't use") with **Remove**; (4) `<details>` "Add your journey": "Transport", "Name (optional)" (160), "Departs ({origin} time)", "Arrives ({destination} time)", "Price for {n} adults (optional)", "Currency", **Add journey**. Errors are inline with today's messages; the form clears on success. Tip: "Enter city-to-city times, including station access. Airport time before onward flights is added separately. Your journeys are used even outside the departure times. To change a journey, remove it and add it again." `edit()` pruning is unchanged. |
| **Departure times and changes** | "Leave 09:00–17:00 · any number of changes · overnight allowed" | "Leave between [09:00] (`#setting-departure-start`) and [17:00]"; error "The latest departure must be after the earliest."; tip "Local time at each departure city. Applies to the scheduled departure of flights, trains and buses. Your journeys to start and end cities can be outside these times." · "Max changes per journey" (optional, 0–10, placeholder "Any") · checkbox "Allow overnight journeys"; tip "A journey is overnight when it crosses midnight in the departure city's time." |
| **Time buffers** | "Flights 90 + 30 min · trains and buses 15 + 10 min · changes 30 min · airport transfer 45 min" | "Minimum change time (min)" 30 (0–360) · "At the airport before a flight (min)" 90 (0–360) · "After landing (min)" 30 (0–360) · "At the station before a train or bus (min)" 15 (0–120) · "After a train or bus (min)" 10 (0–120) · "Default airport transfer time (min)" 45 (optional, 0–600, placeholder "None", `#setting-airport-fallback`); tip "Used when no road time is available. Blank: those flights can't be used until you enter a transfer time." Group tip: "These times are part of each journey and reduce time in cities." |
| **Fixed appointments** | "None" / "2: Seoul Sat 5 Dec 14:00–16:00, …" | Rows "{Seoul} · {Sat 5 Dec 14:00} – {16:00} ({Seoul} time)" **Remove** · "City" (cities to visit) · "Starts ({city} time)" · "Ends" · **Add appointment**. Inline errors: "Choose a city and both times." · "The end must be after the start." · DST message. |
| **Cars** | "Not used" / "Own car" / "Rental car" / "Own car, rental car" | Checkbox "Use my car (it starts and ends at home)" → "Seats" (1–9), "Cost per km (MYR)". Checkbox "Allow rental cars" → "Seats per car", "Price per day (MYR, optional)", "Pickup fee per car (MYR)", "One-way fee per car (MYR, optional)", "Driving cost per km per car (MYR, optional)", fieldsets "Pick up at" and "Drop off at". Fields show only while their toggle is on; values are kept. Warning when a toggle is on and Car is off: "Turn on Car in Transport to use cars." `taxi_capacity` stays hidden and kept. |
| **Prices and currencies** | "MYR only" / "MYR, JPY, KRW · flights without a price skipped" | Checkbox "Skip flights without a price"; tip "Removes options that need a flight without a price after your prices, combined tickets and rules apply. Saved schedules are kept. Other prices can still be not priced." · "Exchange rates (MYR for 1 unit)": tags "{JPY} {0.031}" with × (MYR has no ×); "Currency" (3 letters) + "MYR for 1 unit" + **Add rate** ("Rate updated." for an existing code). Inline errors "Enter a 3-letter currency code." / "Enter a rate above 0." |
| **Estimated train timetables** | "Off" / "On · stations within 25 km · up to 180 days" | Checkbox "Use estimated train timetables when no train is found for the date" (turning it on sets `null` / 180 / 25, as today) → "Copy from the week starting" (blank = today) · "Maximum date shift (days)" 7–365 · "Station search radius (km)" 1–50. Visible note: "Estimated timetables are not confirmed. Check holidays, prices and seats before you book. Start a new search after you change these settings." Tip: "When the search finds no train for the date, it tries stations within the radius. For trips more than 2 weeks away it copies up to 3 matching weekdays from the reference period. Station access uses walking times." |
| **Search size** | "100 requests per batch" | "Requests per search batch" (1–500, integer); tip "The search pauses after this many new requests to data providers. Search more runs the next batch. Saved results are reused." Memory only, as today (state renamed `batchSize`; API body `{budget}` unchanged). |

---

## H. Inventory mapping (every id)

| ID | Final location / behavior |
|---|---|
| hdr-brand | Header icon + "Wayfinder Routes"; caption removed (decoration); sr-only h1 |
| hdr-theme | ⋯ › Theme radios; storage, pre-paint script, OS listener and meta update unchanged |
| hdr-trip-select | Header "Trip" select; dates "{start}–{end}"; "New trip (not saved)"; same `openTrip` |
| hdr-duplicate | ⋯ › Copy trip; same guards and API; status "Copied. Change it, then search."; settings open |
| hdr-new | Header "New trip"; same reset; settings open, focus Home city; status "Not saved yet" |
| nav-skip | First focusable element; "Skip to options" / "Skip to trip settings" |
| nav-workspace | **Removed**: the layout plus tabs replace the anchors (fixes the link to a missing target) |
| intro | **Removed** as a block; one sentence for unsaved trips; empty states orient |
| error-alert | C2 banner with Reload trip, Retry save and the network message; section errors inline |
| save-status | Header status, C13 values |
| loading-app | First load only, full page; open and copy load inside `<main>` |
| loading-lazy | "Loading chart…" / "Loading map…" at the final height; map tile error message |
| setup-name | Trip bar inline input; blank is not committed |
| setup-start / setup-end | Core Dates, with client checks mirroring the server |
| setup-date-mode | Radio "Exact dates / Any days in this period" + helper line |
| place-home | Core Home city with **Change**; no clearing to null; confirm when home change removes journeys |
| place-departures / place-arrivals | G › Start and end cities, home checkbox, limit text (fixes the [home] bounce) |
| place-search | Same combobox and keys; "Searching…"; no-match text; limit and disabled state |
| place-custom | "Add a place by coordinates" with new labels; same validation, inline |
| visit-add | "Add a city", "{n} of 4", full-state text |
| visit-card | City row "At least [n] h" + days helper + ×; appointment removal message |
| visit-apply-first | "Use {n} h for all cities" (when values differ) |
| setup-adults | Core Adults `NumberField` (no blank → 0) + party-size notice |
| setup-budget | Core "Budget for {n} adults (MYR)" |
| setup-max-transfers | G › Departure times and changes › Max changes per journey |
| setup-window | Core sentence + G › Leave between |
| setup-modes | Core Transport chips with display labels |
| setup-overnight | G › Allow overnight journeys |
| setup-rail-fallback / -ref / -shift / -radius | G › Estimated train timetables (`NumberField`; no blank → 0) |
| setup-exclude-unpriced | G › Prices and currencies + Next steps row 5 |
| setup-transit-off | Core notice + Next steps row 6 + Details source gap |
| pos-home-earliest / pos-home-latest | G › Start and end cities › Home times |
| pos-gateway | G › one disclosure per city and direction |
| pos-policy | 3-way select per allowed mode; hidden modes keep their policies |
| pos-supplied-empty | Inline warning on that mode |
| pos-service-list | "Your journeys" rows with "not used" reasons |
| pos-service-add | "Add your journey" form; inline errors; clears on success |
| pos-auto-prune | Unchanged in `edit()`; confirm before a home change that removes journeys |
| adv-connection / -flight-before / -flight-after / -transit-before / -transit-after | G › Time buffers |
| adv-airport-fallback | G › Time buffers › Default airport transfer time; target of Next steps row 2 |
| adv-commitments | G › Fixed appointments |
| adv-own-car / adv-rental / adv-rental-locations | G › Cars (fields only while on; Car-off warning) |
| adv-fx | G › Prices and currencies (inline errors) + inline Add rate in exchange-rate rows |
| act-batch-budget | G › Search size (`batchSize`, memory) |
| act-save-recalc | "Save without searching" (new trip) / ⋯ › "Recalculate options" (same handler) |
| act-discover | Settings footer (Search transport / Search again / Start a new search) and strip actions; spinner only on its own button |
| xfer-panel / xfer-row / xfer-add-method | Missing info › Airport transfers (stacked direction blocks, usage, overrides) |
| xfer-save | Apply step 2 (same PUT, `expected_revision`, validation + currency check) |
| job-panel / job-counters | Status strip / Details |
| job-cancel | Strip **Stop search** |
| job-continue | Strip **Search more** / **Retry failed searches** / **Check more combinations** (routing in C3.1) |
| job-hint | Tip on Stop search; "Found options are kept." in the stopped, interrupted and failed sentences |
| job-messages | Details › Messages from data providers |
| conn-saved-list | Missing info › Connections you added (derived from PUT or GET data) |
| rules-editor / rules-list / rules-form | Missing info › Price rules · all trips (confirm on delete; inline errors; seats only for Per vehicle) |
| conn-gaps | Missing info › Connections (derived `cityGaps`) + empty-state reason |
| conn-add | "Add a connection" in city time; both or neither; success status; form resets |
| res-stale | Strip rows 2 and 5 + workspace dimming |
| aconn-panel / aconn-row | Missing info › Airport changes |
| aconn-save | Apply step 1 (after `saveSpec`; drafts survive polling) |
| unresolved-access | Exact filter "airport access time is unresolved"; Next steps row 2 + transfers callout (fixes the false positive) |
| fares-panel / fares-grouping | Missing info › Journey prices; `groupMissingFares` unchanged; access/egress groups shown as Airport transfers |
| fares-row / fares-components | `PriceFields` commit on blur/Enter; per-journey inputs; Search fare; Remove my price |
| fares-apply / fares-discard | Apply bar Apply (step 3) / Discard (confirm) |
| fares-applied | Missing info › Group prices you set (single heading) |
| fares-pagination | "Show 25 more" |
| front-header | "{n} best options" (+ weaker count); Options tab badge |
| front-status | Strip + Details (data version, combinations) |
| front-dominated | "Show weaker options" (same logic) |
| chart | E2 (lower bounds, stacks, staircase, budget, legend) |
| chart-empty-notice | **Removed**: every option is plotted; empty states cover "no options" |
| chart-log-cost / chart-log-hours / chart-fit | Chart options disclosure |
| chart-zoom | Unchanged; Reset zoom only after zooming |
| front-continue-opt | Strip second line "Check more combinations" |
| front-order | Sort (E3) |
| front-empty | C12 reasons with actions |
| front-refinement | "Over budget ({k})" group, always available |
| card / card-pagination | Option row (C6) / "Show 40 more" |
| compare | Itinerary header "Compare with" + E7 text + chart ring |
| det-header | E9.1 |
| det-map | E9.2 (mounted when open; refit on first visible size) |
| det-stays | Day by day stay rows |
| leg / leg-segments | Journey rows + `stepLabel` |
| leg-assumptions | Inline step notes + Check before booking |
| leg-estimated-timetable | Summary chip + body notice + Check before booking |
| leg-fare / leg-charge-fare / det-extra-fares | Tickets and prices **Set price** (drafts; scope radio for transfers) |
| leg-search-link | "Search fare" in the journey body, ticket rows and journey price rows |
| det-purchases | Tickets and prices (source labels; Remove my price via `storedOfferId`) |
| det-cost-note | Tickets tip; per-hour value in the header |
| bundle-entry | "Add a combined ticket price" (template ids; inline errors; matching searches) |
| FareEditor behaviour | `PriceEditor`/`PriceFields`; same range and open-ended rules; pre-fill from draft → user → provider offer by canonical id |
| quote-links | Missing info › Combined tickets to check + itinerary matching searches; plain statuses |
| footer | Unchanged |

**§18 behaviours.**
- Unchanged: 1 `edit()`, 3 `saveSpec()`, 4 `accept()`, 5 `acceptResult()`, 6 session/version, 7 first load, 9 duplicate/New, 10 polling (plus an optional "set the job only if it changed" guard), 12 `stage()` and its storage key, 13 derived values, 15 theme.
- Extended:
  - 2 autosave also skips while `validateDraft` has errors;
  - 8 `openTrip(id, {discard})`;
  - 11 `act(fn, actionName)`;
  - 14 transfer and airport-change drafts are lifted to the hook and persisted;
  - 16 accessibility kept and extended (I8);
  - 17 responsive layout replaced (B2).

**§19 statuses**: replaced by C13. **§21 issues 1–17**: all fixed. See I10 for the list and new findings.

**§20 API calls**: all are kept with the same payloads, with these changes:
- `PUT /fares/{id}` is now used only for combined tickets, with template ids.
- Itinerary price edits go through `POST /fares/estimates`.
- `PUT /airport-connections` runs after `saveSpec`.
- `/continue` is used only for Search more and Retry failed searches, and for Check more combinations only when nothing is pending and nothing failed.
- `/optimize {expand}` is used for every other Check more combinations.
- Endpoints with no UI stay unused: `DELETE /trips`, `/fares/batch`, `include_graph`, `/api/health`.

---

## I. Implementation plan

### I1. Order of work (each step ends with `npm --prefix frontend run build` and the J checks for that area)

1. **Foundations** (no layout change):
   - types in `planner.ts`; robust `api()`;
   - canonical ids in the current FareEditor, MissingFaresTable and BundleEntry, plus `storedOfferId` for the purchase ×;
   - exact `unresolvedAccess` filter;
   - derived `assumedConnections` / `cityGaps`;
   - airport-connection effect dependencies on signatures only;
   - `present.ts` and `drafts.ts` with tests.
2. **Shell**: AppHeader (menu, ThemeChoice), ErrorBanner, TripBar + StatusStrip, Tabs + workspace grid. **Move the existing sections into the panels unchanged.** Main-only loader. Remove the nav and intro.
3. **Trip settings**: core fields, More settings groups (split `AdvancedSettings`), PositioningSettings changes, `NumberField`/`Field`/`PlacePicker`, `validateDraft` + autosave guard, party-size notice, footer states, search-running notice.
4. **Options**: Next steps, rows, sort, say-once note, Over budget group, empty states, show more, selection by signature; ParetoExplorer encoding, legend, options and aria label.
5. **Itinerary**: header, compare, Day by day, Tickets and prices, combined ticket, check before booking, map disclosure + refit.
6. **Drafts and Missing info**: `useTripDrafts`, the 7 sections, itinerary `PriceEditor` staging + scope, ApplyBar + `applyDrafts` + keyboard.
7. **Cleanup**: CSS rewrite, legacy deletion, `index.html`, README labels.
8. **Full verification** (J).

### I2. Files

**Create**
- `frontend/src/lib/present.ts`: pure helpers (no React):
  - display: `modeLabel`, `moneyShort`, `formatDuration`, `formatLocal`, `dateRange`, `priceText`, `priceEstimated`, `unpricedSummary`, `perCityHourText`;
  - routes: `routeChain`, `routeSignature`, `sortRoutes`, `compareText`;
  - status: `searchState` (C3.1 table → `{id, tone, text, actions, secondary}`), `bundleStatusLabel`, `sourceLabel`, `stepLabel`, `assumptionNotes`;
  - trip: `tripSummary`, `settingsSummaries`, `validateDraft`;
  - refinement: `transferDirections`, `splitGroups`, `airportChangeRows` (moved from Planner), `unresolvedAccessJourneys`, `assumedConnections`, `cityGaps`, `matchingQuoteLinks`, `buildNextSteps`, `needsInputCount`.
- `frontend/src/lib/drafts.ts`: pure draft types and builders: `SharedFare` (moved from MissingFaresTable), `TransferRowDraft`, `AirportChangeDraft`, `transferKey`, `stageFare` (today's overlap rule), `activeFares`, `buildTransferEstimates`, `buildAirportConnections`, `canonicalIds`, `storedOfferId`, `countDrafts`.
- `frontend/src/lib/useTripDrafts.ts`: the hook (React; separate from `drafts.ts` so tests can load the pure file).
- `frontend/src/lib/useMediaQuery.ts`.
- `frontend/src/components/InfoTip.tsx`, `Tabs.tsx`, `AppHeader.tsx`, `TripBar.tsx`, `StatusStrip.tsx`, `TripSettings.tsx`, `OptionsPanel.tsx`, `ItineraryPanel.tsx`, `MissingInfoPanel.tsx`, `ApplyBar.tsx` (all under `frontend/src/components\`).
- `frontend/tests/present.test.mjs` and `frontend/tests/drafts.test.mjs`. They use `loadTs.mjs`, double-quoted relative imports only, and no React.

**Modify**
- `frontend/src/Planner.tsx`: shell and state (I4).
- `frontend/src/components/PlannerForms.tsx`:
  - `Field` gets `info`/`error`/`hint`; `NumberField`, `PlacePicker` changes (C11);
  - `PriceFields`, `PriceEditor`, `FixedPriceFields` replace `FareEditor`;
  - `RulesEditor` (F2 #7);
  - `AdvancedSettings` moves into `TripSettings.tsx`.
- `frontend/src/components/PositioningSettings.tsx`: home checkbox lists, labels, allowed modes only, inline errors.
- `frontend/src/components/AirportTransferTable.tsx`: becomes the controlled Airport transfers section (drafts from the hook; usage, override lines, show journeys). The validation moves to `buildTransferEstimates`.
- `frontend/src/components/MissingFaresTable.tsx`: becomes the controlled Journey prices and Group prices sections (drafts from the hook; commit on blur/Enter; no per-row Save; no local storage code).
- `frontend/src/components/ParetoExplorer.tsx`: E2.
- `frontend/src/components/PlannerMap.tsx`: refit when the container size goes from 0 to non-zero (ResizeObserver); `error` listener for the offline message.
- `frontend/src/components/theme-provider.tsx`: `ThemeToggle` → `ThemeChoice` radios (provider unchanged).
- `frontend/src/lib/planner.ts`:
  - types: `Movement.template_id?: string|null` and `usable?: boolean`; `Charge.from_id/to_id/country_code?`; `Offer.adults?/retrieved_at?/expires_at?`; `Job.batch_budget?/batch_requests?/outcomes?/graph_revision?`; `Result.label_limit?/remaining_labels?`;
  - `api()`: read the text and then parse JSON in try/catch (a non-JSON error body no longer throws `SyntaxError`); attach `status` and `path` to the thrown `Error`; map a fetch `TypeError` to the network message. Compact flags, `detail` joining and shared-result expansion stay unchanged;
  - `localTime(value, zone, fallback = "Any time")`.
- `frontend/src/lib/missingFares.ts`: the component context also carries `search_url` and `template_id` (additive; the existing tests still pass).
- `frontend/src/planner.css`: rewrite (I7).
- `frontend/src/styles.css`: keep the `@tailwind` directives and the token blocks; add the chart tokens; move `.app-shell`, `.brand-*`, `.spin` + `@keyframes spin` and `.maplibregl-ctrl-*` into `planner.css`; delete legacy lines 5–258.
- `frontend/index.html`: `theme-color` → `#fafafa`.
- `README.md`: renamed UI labels ("New from existing", "Home time limits and positioning services", "Search + supplied services / Supplied services only / Unavailable", "Save estimate", "Apply saved estimates", "Show dominated alternatives", "Discover").

**Delete** (only `App.tsx` imports the last four; checked with grep):
- `frontend/src/App.tsx`
- `frontend/src/components/RouteMap.tsx`
- `frontend/src/lib/types.ts`
- `frontend/src/components/ui/badge.tsx`
- `frontend/src/components/ui/card.tsx`
- In `frontend/src/lib/utils.ts`, remove `money`/`shortMoney`/`dateLabel` and keep `cn` (Button uses it).

### I3. Component boundaries and props

```ts
AppHeader({ trips: SavedSummary[]; currentId: string | null; unsaved: boolean; status: string; statusTone: "ok"|"busy"|"warn";
  disabled: boolean; onOpen(id): void; onNew(): void; onCopy(): void; onRecalculate(): void; canCopy: boolean; canRecalculate: boolean })
ErrorBanner({ error: AppError | null; onDismiss(): void; onReload(): void; onRetrySave(): void; onSearchAgain(): void })
TripBar({ draft; edit; saved; settingsOpen; onToggleSettings(): void; nameError?: string; children /* StatusStrip */ })
StatusStrip({ state: SearchState /* from searchState() */; job: Job | null; result: Result | null; busyAction: string | null;
  settingsOpen: boolean; onStop; onSearch(continuation: boolean); onCheckMore })
TripSettings({ draft; edit; places; errors: Record<string,string>; transitConfigured; searchActive; partyNotice?: string;
  isNew: boolean; footer: FooterState; busyAction; onSearch(); onSaveOnly(); report(field, msg) })
OptionsPanel({ isWide; result; displayRoutes: Route[]; numbers: Map<string,number>; refinement: Route[]; selectedId; comparedId;
  ranking; onRanking; showDominated; onToggleDominated; visibleCount; onShowMore; onSelect(id, source: "row"|"chart");
  nextSteps: NextStep[]; emptyState: EmptyState | null; budget: number|null; adults; rates; placeName; searched; active })
ItineraryPanel({ isWide; route: Route | null; number; total; isOverBudget; displayRoutes; numbers; comparedId; onCompare;
  places; byId; placeName; budget; adults; rates; offerFor /* draft-aware, canonical */; draftFor(componentKey);
  stageComponent(componentId, fare); stageDirection(charge, fare); unstage(key); removePrice(storedId);
  saveBundle(offer); bundleLinks; onGoToMissing(target); onBack(): void; anyDraftsForRoute: boolean })
MissingInfoPanel({ saved; result; draft; edit; adults; directions: TransferDirection[]; journeyGroups; appliedGroups;
  airportChanges: AirportChangeRow[]; unresolvedAccess; gaps; assumed; bundleLinks; rules; drafts: TripDraftsApi;
  needs: number; searched; addConnection(m): Promise<void>; removeConnection(id): Promise<void>; rulesChanged(): Promise<void>;
  focusTarget: string | null; onApplyShortcut(): void })
ApplyBar({ counts: { airportChanges: number; transfers: number; prices: number }; invalid: number; applying: { step: number; steps: number } | null;
  error: { text: string; reload: boolean } | null; onApply(); onDiscard(); onReload(); onFocusInvalid() })
```

### I4. Planner.tsx state and functions

**Unchanged** (logic and order of requests):
- state: `draft`, `saved`, `summaries`, `rules`, `result`, `job`, `selectedId`, `comparisonId`, `ranking`, `showDominated`, `loadingTrip`, `dirty`, `error`, `saveStatus`, `transitConfigured`;
- refs: `draftRef`, `savedRef`, `version`, `dirtyRef`, `pendingSave`, `session`;
- functions: `edit`, `accept`, `acceptResult`, `refreshList`, `duplicateTrip`, `saveSpec`, the polling effect, `search`, `updatePrice` (now combined tickets only), `applySharedFares`, `removePrice`, `rulesChanged`, `removeAssumedConnection`, the weaker-options toggle handler and auto-off effect, `places`, `byId`, `placeName`, `missingFareGroups`, `appliedSharedGroups`, the selection fallback.

**Small extensions:**
- `openTrip(id, { discard = false } = {})`: when discarding, skip `saveSpec`, then set `dirtyRef.current = false`.
- `act(fn, actionName?)` records `busyAction`, with `busy = busyAction !== null`.
- The autosave effect returns early while `validateDraft(draft)` has errors.
- `offerFor(id)` looks up the canonical id first, then the raw id.
- `budget` state is renamed `batchSize` (body `{budget: batchSize}` unchanged).
- `routePage` is replaced by `visibleCount`.
- `initialLoad` is split from `loadingTrip`.
- Optional: the polling effect calls `setJob` only when the JSON changed (it avoids a re-render every second).

**New:**
- state: `settingsOpen`, `panel` (`"options"|"itinerary"|"missing"`), `busyAction`, `focusTarget`, `applyState`;
- the hook `useTripDrafts(saved?.id ?? null)`;
- memos: `templateOf`, `knownComponentIds`, `displayRoutes`, `numbers`, `splitGroups`, `transferDirections`, `airportChanges`, `unresolvedAccess`, `assumed`, `gaps`, `nextSteps`, `needs`, `lastSignature`;
- handlers: `newTrip` (extracted inline code), `recalculate` (extracted), `checkMore`, `reloadTrip`, `stageComponent`, `stageDirection`, `applyDrafts`, `discardDrafts`.

### I5. Contracts that must not change
- `api()` compact handling (`?compact=true`, `compact: true`), the `detail` → message mapping, and `expandSharedResult`.
- Every endpoint, method and payload shape. Offer ids `user:{id}` (kind `one-way` / `charge` as the server sets it) and `bundle:{uuid}` with the label "Manually entered whole-ticket party fare". Assumed connections use id `assumed:{uuid}` with car → `vehicle_kind: "rental"`. Shared labels keep the prefix "Shared estimate: " (stripped for display only).
- The `expected_revision` usage, the `accept`/`acceptResult` rejection rules, the `pendingSave` chain, session tokens and version stamps.
- The 650 ms autosave debounce (saved trips only), 1 s polling with skip-while-fetching and the same reload conditions, and the first-load `Promise.all`.
- localStorage keys `wayfinder:theme`, `wayfinder:last-trip`, `wayfinder:pending-estimates:{tripId}` (same format). The only new key is `wayfinder:pending-inputs:{tripId}`.
- Lazy ECharts and MapLibre chunks, the dark map filter, and the attribution text.

### I6. Behavior changes that need sign-off (AGENTS.md; default = adopt)

| # | Change | Fallback if not approved |
|---|---|---|
| 1 | Itinerary price edits become drafts applied through `POST /fares/estimates`. This also removes today's 422s from `PUT /fares` for non-taxi transfer charges and over-budget routes. | "Set price" saves at once with `updatePrice` (canonical id); the 422 for non-taxi transfer charges remains. |
| 2 | Airport changes become drafts in the Apply bar, and `saveSpec` runs first. | A section button "Save airport changes" (immediate). |
| 3 | Airport access/egress unknowns are priced per direction (trip transfer estimate, which also prices later searches) instead of per-component group estimates. Per-journey overrides remain. | Keep those groups as rows in Journey prices; Airport transfers stays the per-direction editor. |
| 4 | "Lowest price" ranks by the highest possible price, with unbounded options last; Best balance uses the same rule. | Today's order (exact first, then by known part). |
| 5 | Adding the first start or end city keeps home included (checkbox stays checked). | Home becomes unchecked on the first add (today's meaning). |
| 6 | Assumed connection times are read in each city's time, both or neither. | Browser time, with the label "(your browser's time)". |
| 7 | Autosave skips drafts with validation errors. | Autosave sends them and the server rejects them (today). |

Bug fixes that need no sign-off: template ids for flight prices and combined tickets; the unresolved-access filter; derived connections and gaps after autosave; airport-change drafts surviving polling; `api()` parsing; the `theme-color` meta.

### I7. CSS plan
- `planner.css` sections: base and tokens use, shell, header, menu, banner, trip bar, strip, settings, workspace grid, tabs, next steps, chart and legend, option list, itinerary, missing info, apply bar, fields and controls, tips, utilities, responsive (1100, 600), reduced motion, dark map.
- Keep the `p-` prefix. No Tailwind in new markup (`Button` keeps its cva classes; `sr-only` stays a Tailwind utility). Remove every `!important`: the unlayered CSS already beats the forms plugin's base layer.
- **Tokens** (styles.css `:root` / `:root.dark`): `--chart-selected: #c2410c / #fb923c`, `--chart-range: #b45309 / #fbbf24`, `--chart-muted: #8a8a93 / #71717a`. Each has ≥3:1 contrast against `--card`.
- Existing tokens for everything else:
  - `--warning` / `--warning-bg`: not-priced chips and notices;
  - `--chart`: the "Not applied" marker;
  - `--primary`: the selected-row bar;
  - `--destructive`: errors;
  - `--ring`: `:focus-visible { outline: 2px solid var(--ring); outline-offset: 2px }`.
- Shell variables `--header-h` (56/48), `--tabs-h` (44 on narrow), `--apply-h` (64 when drafts exist).
- Type scale 12/13/16/20; tabular numbers for prices and hours. Inputs 36 px high (44 px with 16 px text <600). Spacing 4/8/12/16/24.

### I8. Accessibility checklist
- [ ] The skip link is the first focusable element. Landmarks: `header`, `main`, `footer`. sr-only h1; one h2 per region (Trip settings, Next steps, Options, Option {n}, Missing info); h3 for subsections.
- [ ] Tabs: roving tabindex, arrow keys, Home/End, `aria-controls`, badges in the names. Panels stay mounted with `hidden`.
- [ ] Live regions: header status (polite), strip sentence only (polite), Apply bar count (polite), errors `role="alert"`. No counter announcements every second.
- [ ] Focus moves: search start → `#options-title`; row activation on narrow → `#itinerary-title`; "← Options" → the selected row; Next steps and deep links → the exact field; Apply success → `#missing-title`; menu Esc → its summary; tip Esc → its summary.
- [ ] InfoTips are `<details>`, never inside `<label>`/`<summary>`, with role note, and never the only carrier of essential information.
- [ ] Every input has a label (`Field`) or a contextual `aria-label` ("{direction} {way} price for 2 adults"). Errors use `aria-invalid` + `aria-describedby`. Disabled actions show a visible reason.
- [ ] Colour is never the only signal: shapes and arrows on the chart, text on every chip, "Not applied" text with the dot.
- [ ] The chart is `role="img"` with a summary; the list is the full equivalent.
- [ ] Targets ≥44 px and inputs at 16 px <600 px. `prefers-reduced-motion` honored (CSS and the ECharts animation).

### I9. Responsive breakpoints
- ≥1100 px: two columns plus the sticky side panel.
- 600–1099 px: one tab bar, 2-column settings fields.
- <600 px: compact header, chart disclosure, stacked editors, 16 px inputs.
- Container queries are not needed.

### I10. Inconsistencies found (code vs data vs docs)
1. Flight user prices and shared estimates keyed on transfer-variant ids are silently orphaned by any later transfer-estimate edit (the hash includes the values).
2. A combined ticket on a variant route fails with 422 (bundle check uses snapshot ids).
3. The `PUT /fares` known set excludes route-movement charges (non-taxi transfer charges such as `{id}:access:rail`) and over-budget variant flights → 422 from today's FareEditor.
4. The "airport access timing" panel lists PUS→KUL, which is blocked by the GMP→ICN airport change and not by access time.
5. The `PUT /trips` response omits the GET-only fields but contains `snapshot.movements`. Deriving from it is exact.
6. Changing Adults hides every entered price (offers and estimates are keyed by `adults`), and the UI never says so.
7. `api()` parses JSON before checking `ok`, so a non-JSON error body throws `SyntaxError`.
8. The README cites labels this redesign renames.
9. Baseline note 8 is out of date: both test files pass with the untracked `tests/loadTs.mjs`. `node --test tests/` (directory) fails on Node 24; run the files by name.
10. `index.html` `theme-color` (#f5f7f8) differs from the runtime value (#fafafa).

---

## J. Verification checklist

**Build and tests**
- [ ] `npm --prefix frontend run build` passes (strict `tsc`, Vite).
- [ ] `cd frontend; node --test tests/chartView.test.mjs tests/missingFares.test.mjs tests/present.test.mjs tests/drafts.test.mjs` passes. The new tests cover:
  - `priceText`, `unpricedSummary` (open-ended, exchange rate), `sortRoutes`;
  - `compareText` (exact, interval crossing 0, unknown);
  - `searchState` (every row, including the Check more routing with pending>0 → optimize);
  - `stepLabel`, `assumptionNotes` dedupe, `validateDraft`;
  - `canonicalIds`, `storedOfferId` (`user:T:V` → `user:T`), `cityGaps` from the PUT shape;
  - `transferDirections`, `buildTransferEstimates` (keeps other party sizes; skips a blank taxi row; messages), `buildAirportConnections`, `stageFare` overlap.
- [ ] First load of an unsaved trip requests no ECharts or MapLibre chunk (DevTools Network).

**Demo trip `6e2258…` (unknown prices, paused search, airport change)**
- [ ] Open the trip:
  - settings are closed; summary lines are correct; strip "Search paused · 41 searches left." with **Search more**;
  - Next steps shows 3 rows (GMP→ICN; "No option has a complete price yet: 10 airport transfer prices and 2 flight prices… 6 options need only airport transfer prices… may exceed your RM 12,000 budget."; transit info);
  - the chart shows 5 marks with ×2/×3 labels, arrows and a legend;
  - rows 01–09 read "From RM …" with 10/9/9/6/8/8/8/8/8 not priced;
  - the Missing info badge is 13.
- [ ] **Add prices** opens Missing info and focuses the Kuala Lumpur → KUL airport price.
  - Type 10 taxi prices with Enter between them; the Apply bar reads "10 changes not applied: 10 airport transfers".
  - Reload the page: the drafts are restored.
  - Apply: exactly one `PUT /airport-transfer-estimates`; options 04–09 show exact totals; 01–03 still read "From"; the status reads "Applied · 9 → n best options".
- [ ] Set the KUL→PUS and PUS→HND flight prices in Journey prices, then Apply: exactly one `POST /fares/estimates`; every option is priced; the staircase line appears.
- [ ] **Id churn**: change one taxi price, then Apply: the flight prices still apply (no "not priced" comes back).
- [ ] Airport change GMP→ICN: Train, 90 min, RM 60, then Apply → `PUT /airport-connections` after the trip save; the Next steps row disappears. During a running search, a typed airport-change draft survives 5+ poll cycles.
- [ ] **Search more** runs `/continue`. With pending>0, the secondary "Check more combinations" sends `POST /optimize {expand:true}` and no `/continue`.

**Priced trip `5b72e2…` (template ids, exact and range)**
- [ ] Two options: "RM 5,395" (Includes estimates) and "RM 6,187 – 6,227" (band + hollow middle).
  - Compare 01 vs 02: "2.9 h less time in cities and RM 792 – 832 less."
  - Reverse: "… RM 792 – 832 more. That is RM 273 – 287 per extra hour."
- [ ] **Remove my price** on the flight priced RM 1,200 sends `DELETE …/fares/user:flight:b4c409a9636f4407fc3f7874` (the stored id) and the price disappears.
- [ ] A combined ticket across 2 variant flights saves without 422, shows "Your combined ticket price", and Remove works.
- [ ] Taxi row "Set price" with "All … transfers" stages a transfer draft; "Only this journey" stages a component draft; both show "Not applied · Undo".
- [ ] Adults 2 → 3: notice "16 prices you entered are for 2 adults. They are not used for 3 adults." (2 user prices + 14 transfer estimates); the strip says Search again. Return to 2: the notice disappears.

**General flows and regressions**
- [ ] New trip → Save without searching → workspace with "No options yet" (not the no-itinerary empty state) → airport transfers are editable before a search.
- [ ] DK change during a search: the notice is visible in settings; changing the end date leads to "Your trip changed…" and **Search again**; the job becomes superseded.
- [ ] Validation:
  - clearing Adults shows "Enter 1 to 9 adults.", sends no PUT, and blur restores 2;
  - end date before start disables Search with the reason, and the header reads "Fix the marked fields to save".
- [ ] **409**: open the same trip in two tabs, rename in tab A, edit in tab B → banner **Reload trip** → confirm → tab B shows A's name.
- [ ] Add a connection (Busan → Tokyo, Bus, fixed times): status "Connection added · options updated"; the form resets. Rename the trip (autosave): "Connections you added" and the gap buttons stay. Remove sends DELETE with `expected_revision`.
- [ ] Rule: create a taxi rule per vehicle → options update; Delete asks for confirmation.
- [ ] Weaker options: the first toggle shows "Loading weaker options…" and grey marks; it turns off after an Apply that returns no weaker routes.
- [ ] Budget RM 5,000: the "Over budget (k) · from RM x" group appears; selecting an over-budget option shows the over-budget header; it is not plotted.
- [ ] Open another trip while a save is in flight: no cross-trip drafts; the Apply bar reflects only the open trip; Copy trip and New trip reset selection and comparison.
- [ ] Map: on narrow screens, open it after switching tabs; it fits all places (no zero-size view). The tile error message shows when offline.

**Widths, themes, input methods**
- [ ] 1440×900, 1280×800, 1024×768, 768×1024, 390×844, 360×740:
  - no horizontal page scroll; sticky header, tabs and side panel behave;
  - the Apply bar and the settings footer never cover a focused field;
  - the 3 tabs fit at 360 px.
- [ ] Light and dark: chart tokens, warning chips, map filter, menu, tips; the `theme-color` meta switches between #fafafa and #09090b.
- [ ] Keyboard only: skip link, menu (Esc), tabs (arrows), rows, tips (Enter/Esc), price tables (Enter, Shift+Enter, Esc), Ctrl/Cmd+Enter Apply, and every focus move in I8.
- [ ] NVDA spot check: tab names with counts; one announcement per strip state change during a running search; save status; Apply result; tips read as notes; inline errors announced.
- [ ] **Network**:
  - autosave is still PUT → POST optimize → GET /trips;
  - polling every 1 s with no overlap;
  - Apply sends only the changed kinds, in the order airport changes → transfers → fares;
  - staging sends no request.