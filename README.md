# Wayfinder Routes

A multimodal trip optimizer that compares total party transportation cost with hours spent in required cities, including positioning from home and back.

The planner runs entirely in the browser: trips, prices and search progress are stored in IndexedDB, and a Web Worker runs the optimizer. The browser calls OSRM and Transitous directly. The only backend is a stateless flight-search function in `api/`, because Google Flights has no browser API. See [providers and the flight function](docs/provider-functions.md).

| Folder | Contents |
| --- | --- |
| `app/` | The static planner: React interface, IndexedDB storage, solver worker, browser tests |
| `api/` | The flight-search function: `flights.py` (the endpoint) and `_flight_provider.py` |
| `tests/` | Flight function tests |
| `tools/` | Catalog build and local static server |

## Trip setup and results

The page has a header (trip select, save status, and the **⋯** menu), the trip bar with **Edit trip** and the search status, the **Plan a trip** form, and a workspace with three panels: **Options**, **Itinerary**, and **Missing info**. From 1100 px the Options column is beside a side panel for Itinerary and Missing info; on narrower screens one tab bar switches the three panels.

- The form asks four questions: **Where's home?**, **Where to?**, **When are you free?** and **Who's going?**, then **Transport**. Everything else is under **Advanced**.
- Choose a home city, up to two other cities to leave from and return to (**Also leave from and return to**; **Different on the way back** gives separate start and end lists), and one to four cities to visit. The optimizer chooses one start and one end city and the visit order.
- Next to the home city, choose **Round trip**, **One way from home**, or **One way to home**. One way from home ends in the last city visited; its time counts until the end of the end date. One way to home starts in the first city visited; its time counts from the start of the start date. The side without home travel is not searched, round-trip tickets are not searched, and that side's start or end cities, your journeys, and home time are removed. An own car must still start and end at home.
- Use **Copy trip** in the **⋯** menu to start a separate trip with the selected trip's settings, airport changes, and airport transfer prices. Schedules and trip-specific prices start fresh.
- Use **⋯ › Export trips** to share the selected itinerary, all calculated options in the current trip, or all saved trips. **PDF** opens a print-ready report in a new tab; click **Print / Save as PDF** and choose **Save as PDF**. **HTML** downloads a standalone report that friends can open in a browser without running this app. Reports contain comparison tables, local schedules, tickets, group transport prices, missing-price warnings and booking assumptions. They use saved settings and calculated prices; save or apply pending edits first. Trips without current results include their settings and a notice. More options are included only when already loaded, and over-budget examples are labeled. Export reads existing results without starting a search or recalculation.
- **When are you free?** takes a **From** and an **Until** date, each with an optional time in the home timezone: the earliest home departure on the From date and the latest home arrival on the Until date. Blank times use the whole day. By default the whole journey can be on any days in that period; **Advanced › Dates and departures › Leave on the first day and return on the last day** gives exact dates.
- Each city has a minimum stay in days. By default it is automatic: the free time, less 1 day for each journey, divided evenly between the cities and rounded down to whole days; it follows changes to the dates and cities until you type another value. Then choose one to nine adult travelers, a party budget in MYR, and the transport groups **Flights**, **Trains & buses** (train, bus, coach, subway, tram; choose single types under **Advanced › Trains & buses**) and **Car & taxi**. Under **Advanced** set an optional daily departure window (none by default), maximum transfers per intercity journey, overnight travel, and city-local fixed commitments. Overnight means crossing midnight in the departure timezone.
- Under each other start or end city, configure the travel to it independently for before and after the trip. For each mode choose **Search**, **Your journeys only**, or **Don't use**. These choices also apply to cached options. The trip's allowed modes still apply. Turning off buses to a start city does not turn off buses between the cities to visit.
- Add your known journeys to and from start and end cities with departure and arrival dates/times in each endpoint's local timezone and an optional whole-party price/currency. Early journeys before the trip and late journeys after it can be added without entering every departure. Their times are used even outside the automatic search window; airport access and flight readiness buffers remain separate for onward flights. Remove and re-add a journey to change it. With **Don't use**, or **Your journeys only** and no journey added, that mode has no options. Settings and journeys persist with the trip; search again after changing the home times or these choices.
- Flight, rail, bus, coach, subway, tram, car, and taxi are modeled. Full flight timestamps include layovers and actual airport timezones. City/terminal access, readiness buffers, and final travel home are included. City-stay hours include nights; home, positioning cities, and transportation do not count.
- Edit fixed/ranged fares, save reusable fixed/distance pricing rules, and enter currency conversion rates. Overrides take precedence over retrieved fares; rules estimate missing prices. Person/party/vehicle units and seating capacity are explicit. Connector rules use their actual city/airport endpoints and country.
- Unknown fares stay not priced. Options with a range or a not-priced part show "RM x + unknown" or "RM a – b", and options that may exceed the budget are flagged. Definitely over-budget options stay outside the best options; up to ten examples are in the **Over budget** group for ticket/price refinement.
- The **Missing info** panel lists what to check, in priority order: airport changes, airport transfers, journey prices, connections between cities, combined tickets to check, group prices you set, and price rules. Repeated journeys with the same endpoints, fare type, mode, currency, and missing-price reason share one row, with distinct affected-itinerary counts. Expand a group to inspect journey dates and services or enter individual prices. A value you enter (here or with **Set price** in the itinerary) is a draft marked **Not applied**; drafts are kept in this browser and survive reloads without recalculating. The **Apply** bar at the bottom shows the drafts of the trip: **Apply** (Ctrl+Enter) saves them all and recalculates once, **Discard** removes them. Each value is a whole-party amount per journey, not a bundled total. Group prices are reusable estimates for their selected matching scope within this trip; later journeys reuse them when they match. Prices of priced journeys remain editable in the itinerary's **Tickets and prices**.
- An own car must be physically available and recovered to home. Rentals require declared pickup/drop-off locations, daily/driving costs, and one-way charges. Rentals are returned at an allowed location before changing transport. Rental inventory is not live.
- Trips, price edits, rules, graphs, and search checkpoints persist in this browser (IndexedDB); see [browser storage](docs/browser-storage.md). To debug a search or calculation, use **⋯ › Download debug bundle** and replay it with `app/scripts/replay.mjs`; see [debug bundles and replay](docs/browser-storage.md#debug-bundles-and-replay). Price, timing, and driving-price edits recalculate saved data. Changed cities, dates, travelers, or coverage may require another search.

The **Options** panel shows **Next steps**, up to three recommended picks (**Cheapest**, **Most time in cities**, **Best balance**; Cheapest and Best balance consider only options with a known highest price), and the best options as a **List** or as the ECharts **Chart** of price vs. time in cities. Selecting an option in a pick, the chart or the list opens it in the **Itinerary** panel: the total price, **Compare with** (the additional money per additional hour in cities), a MapLibre map, **Day by day**, and **Tickets and prices**. The price per hour in cities is a separate descriptive metric. Map connections are schematic, not track or road geometry.

Option rows show the total price for the party, the time in cities, and the price per hour in cities; bounded price ranges show the corresponding ratio range, and unbounded totals stay unknown. Every unselected row also compares its price and city time with the selected baseline, including cost per extra hour in cities when that rate is meaningful. Its comparison details show travel-time differences, savings per hour given up, and the increment from the next cheaper best option without a price range. Missing prices never become zero-cost upgrades. **Best balance** uses weighted straight-line distance to the normalized cheapest-price/most-city-time ideal; its preference slider favors price or city time. Showing more options does not change the reference scale, and changing the ranking does not change the selected baseline. The chart defaults to linear axes fitted to the data, with optional logarithmic price and time-in-cities axes (**Chart options**) and **Reset zoom**. A log option is unavailable when an axis contains zero/non-positive values; options are not silently hidden. The best options leave out weaker itineraries under the retrieved prices and constraints, while the underlying schedules and prices remain saved for future recalculation.

**Show more options** optionally loads other complete, budget/price-eligible itineraries from the saved graph without provider requests. They appear as selectable muted chart marks and rows with the chip "More"; the chart line still connects only the best options. First loading recalculates the graph; later toggles reuse the loaded results. This view is not exhaustive enumeration: pruning may already have removed other partial itineraries during the search.

## Pricing and search coverage

**Missing info → Edit as CSV** opens one text editor with the current journey
prices, airport transfers, airport changes, and exchange rates. Select **Copy
CSV**, fill the values elsewhere, and paste them back into the same box; direct
editing and pasted spreadsheet cells are also supported. **Preview changes**
checks the rows, then **Import as drafts** fills the forms. **Apply** saves the
batch and recalculates once. Blank cells leave values unchanged. Exchange rates
entered in Missing info also remain drafts until Apply. See
[CSV editing](docs/missing-info-csv.md) for columns, scopes and limits.

**Journey prices > Group by** selects which station, category, connection,
service/route, operator, date, and time fields distinguish groups. New group
prices are reusable estimates within the trip, including matching journeys
found later. Individual prices and provider fares take precedence. Changing
the grouping does not change saved estimate scopes. Expand **Show journeys**
to inspect services, stations, times, duration, and transfers. See
[reusable journey estimates](docs/reusable-journey-pricing.md).

One-way, round-trip, and multi-city purchases cover exact movements and cannot overlap or be charged twice. Google Flights queries request the whole party; returned prices are not multiplied again. Round-trip fares come from the selected-return step described below. Multi-city tickets are not retrieved automatically: the app provides search links and accepts manually entered whole-ticket prices.

Dynamic programming preserves different ticket eligibility, vehicle states, and fare uncertainty. Ticket cover is exact. Ranking changes display order, not frontier membership. **Optimality applies to the retrieved event graph and stated assumptions, not every ticket worldwide.** Road departures are instantiated at readiness, connection, and return-boundary events; continuous-time traffic/rental optimization is not claimed. Feed gaps, missing quotes, failures, and unsearched dates remain visible. Stale provider quotes and user conversion rates are estimates.

**Estimated rail timetables** are opt-in per trip and work across countries covered by Transitous. After an actual-date transit search collects no usable journey, discovery first retries rail with a bounded station radius (default 25 km), preserving provider walking access/egress times. For dates more than 14 days away, it can then sample up to three matching weekdays in a reference period (blank starts today), nearest to the target first, with a default maximum shift of 180 days. The public routing API does not expose per-route timetable validity: these are explicitly unconfirmed assumptions, not a diagnosis that the date is outside coverage. Holidays and seasonal exceptions are not checked. Change the reference period if the default samples find nothing. No service is invented when the reference searches are empty or fail.

Reference journeys use scheduled times, preserve origin-local departure times and elapsed journey/transfer/access durations across timezone changes, and reject ambiguous or nonexistent departure times at daylight-saving changes. Historical fare products are discarded. Option rows and journey details identify estimated timetables and their reference dates even after fares are entered. MOTIS-provided extended calendars (`loopedCalendarSince`) are also labeled as estimates. Each probe/page counts separately against the discovery request budget, shares reference query caches across target dates, and persists through pause/resume. Actual-date rail data replaces local projections for that pair/day; starting fresh discovery refreshes generated assumptions. Disabling the option removes local fallback journeys on recalculation. Flights are never shifted. Search again after changing fallback settings (**Advanced › Estimated train timetables**); saved trips keep this option off until selected.

**Find trips** defaults to **100 uncached requests per batch** (**Advanced › Search size**) and continues on its own for up to 10 batches; after that, **Search more** in the status strip adds another batch and reuses caches. When the search is complete and not all combinations were checked, checking starts once on its own (see **Check more combinations**). **Stop search** preserves collected work; paused/interrupted searches can resume. Search again when the search inputs change. Disabled Transitous sends no transit requests. Failed queries can be retried after the queue is exhausted.

New discovery queues use rough date windows from the minimum city stays, combining all visit orders and gateway choices. This optimistic filter assumes zero travel time and keeps whole departure-local calendar days; exact schedules, buffers, and commitments are checked by the optimizer. Own-car recovery retains broad windows because it may require additional detours. Discovery publishes coverage every four processed queries. Recalculation is batched according to the preceding solve cost, with at most sixteen queries between solves; batch boundaries always flush current results. Unchanged optimization inputs reuse the previous result.

Under **Advanced › Search size**, choose **Minutes** to run the whole search and optimizer for up to that duration (ten minutes initially). Timed mode ignores the request and state allowances, but pauses at a safety limit of 100,000 additional expanded states per calculation; Continue resumes saved work. Provider limits and timeouts still apply. The current operation and saving can finish after the deadline. **Continue for … minutes** resumes saved provider and optimizer progress with a new time allowance. It also works when only optimization remains. Paused checkpoints survive a page reload; changed schedules, fares, rules, or trip inputs start a new calculation. See [timed rounds and checkpoints](docs/timed-search.md).

In request mode, optimization defaults to **25,000 expanded labels**. Hitting the limit is explicitly marked "Not all combinations were checked". **Check more combinations** starts continuous checking on the saved graph and becomes **Stop checking**. It resumes a matching checkpoint in bounded batches, publishes options after each batch, and makes no provider requests. Exploration shares short turns across starting routes, favoring usable prices while giving unpriced paths regular turns so later combined tickets remain eligible. It stops when complete, when requested, or before edits are applied. There is no checkpoint-size limit; large searches can exhaust memory or disk space. Stopping can wait for the current operation and saving. Only one continuous checker runs at a time; closing the page stops it, and it continues only when requested again. Changed inputs restart from the saved graph, rather than searching only the previous frontier. Accommodation, sightseeing hours, and reliability remain later phases.

While a search runs, Missing info remains editable. **Apply and continue**
pauses safely, saves all Apply-bar drafts together, and recalculates from the
full saved graph within the same remaining round allowance. Previously weaker
routes can become best under the new inputs. If time expires, edits remain
saved and the round waits for explicit continuation. See
[Apply during a search](docs/apply-during-search.md).

## Run on Windows

Use uv and Node.js 20.19+ or 22.12+. The root `pyproject.toml` declares Python 3.13 and the flight function's dependencies; `uv.lock` records the resolved versions.

```powershell
uv python install 3.13
uv sync
npm --prefix app install
```

The catalog build downloads the GeoNames city list to `data/geonames/cities500.zip` when it is missing, and fails without it. GeoNames gives each airport city its city-centre coordinates, so train, bus and road searches start in the city, not at the airport. Towns without an airport are included from `CATALOG_MIN_POPULATION` people (default 15000); a lower value makes the place catalog larger (about 70 MB with all towns).

Start the flight function and the Vite dev server, both with hot reload, in one console, then open <http://127.0.0.1:5173>. Ctrl+C stops both. Use `-Port` and `-WebPort` for other ports.

```powershell
.\start-dev.ps1
```

The script first runs `tools/prepare_catalogs.py`, which writes the place and airport catalogs and the public provider configuration to `app/public/browser-data/`. Run `npm --prefix app run catalogs` again after you change the GeoNames file or the build settings.

## Build and deploy

```powershell
npm --prefix app run build
```

The static site is `app/dist/`. `vercel.json` builds it and deploys `api/flights.py`. To preview the build without any API proxy, run `uv run python tools/serve_static_planner.py` and open <http://127.0.0.1:5176/>. Opening and editing saved trips needs no backend; flight searches need the flight function.

## Configuration

The catalog build writes `BROWSER_FLIGHTS_URL`, `BROWSER_TRANSIT_URL`, `BROWSER_TRANSIT_ENABLED`, `OSRM_BASE_URL` and `TRANSITOUS_CONTACT_URL` into the public `browser-data/config.json`; set them as environment variables before building (it does not read a `.env` file). `BROWSER_ALLOWED_ORIGINS` enables CORS on the flight function for a static site on another origin. Keep source attribution. Transitous has regional feed gaps and its own [API usage policy](https://transitous.org/api/); an empty result does not prove that transportation is unavailable.

Default assumptions: 90 minutes before flights, 30 after flights, 15 before transit, 10 after transit, and a 30-minute minimum connection. Airport access uses OSRM when available. Otherwise the editable fallback is 45 minutes per side with an unknown fare. Clear the fallback to require resolved access time. An unavailable intercity road never becomes an automatic straight-line driving connection.

Flight responses cache for 15 minutes, road matrices for seven days, and transit routes for six hours (15 minutes when empty). Reopening a trip does not refresh its provider quotes; expired quotes are shown as stale estimates.

## Search details

The optimizer can return through previously visited destinations after completing all required visits, for example KUL → Seoul → Busan → Seoul → KUL. Each destination can appear once on the return path; first visits must meet their minimum stays and commitments, while return visits can be short connections. Destination time on return visits counts toward stay hours. Independent one-way fares and validated, non-overlapping round-trip bundles are compared. Gateway-to-destination round-trip queries are seeded independently of completed one-way itineraries, using optimistic date windows and the total minimum stay; exact returned schedules must still pass the optimizer's full constraints. Multi-city retrieval remains limited by fast-flights; diagnostics distinguish no returned rows from incomplete journeys and do not interpret either as proof that no bundle exists. Existing trips need a new search to cover the expanded return dates and independent round-trip queries; cached provider responses remain reusable.

Round trips use two kinds of flight-function calls: one search returns the outbound choices, and one call per choice retrieves its conditional return fares. Only pairs that pass endpoint, date, time, and chronological validation receive the return page's whole-ticket fare; indicative first-page fares are never assigned to complete trips. Each uncached call counts as one request, and remaining choices persist across Stop, reload, and Continue. Multi-city retrieval remains manual.

Multi-city ticket opportunities are registered directly in the manual-quote list with search links. They never enter the provider queue or increment processed, pending, provider-request, or cache-hit counts, and they do not trigger extra publications. A separate manual-quote counter shows the number of unique opportunities. Ticket candidates are deduplicated by city pairs and departure dates before constructing provider queries. Coverage is published every four provider-query tasks; when a solve takes at least one second, changed provider data is batched until other discovery work has had as much time as that solve, or sixteen queries have been processed, whichever comes first. Pausing/completing discovery and manual trip/rule changes force an up-to-date solve. Overlapping optimization requests can reuse a matching completed snapshot.

Airport–city transfers can be entered before a search in **Missing info › Airport transfers**. It lists configured airports in both directions and adds airports encountered in retrieved journeys. Add taxi, car, rail, subway, tram, bus, or coach ways with a travel time and optional whole-party price/range; they are drafts until **Apply**. Applied ways apply to current and future matching journeys in that trip and party size; individual component fare overrides take priority. Alternatives change door-to-door timing while retaining the underlying flight ticket and bundle coverage. They are user assumptions, without timetable or operating-hour verification. An unedited taxi retains the existing road/fallback timing; airport-to-airport connections remain separate.

## Tests

```powershell
uv run python -m unittest discover -s tests -v
npm --prefix app test
npm --prefix app run build
```

Browser tests use Playwright with Chrome. Start the dev server (`npm --prefix app run dev`), then run `npm --prefix app run test:browser`. To include the production-artifact tests, serve the build with `tools/serve_static_planner.py` and set `$env:STATIC_URL = 'http://127.0.0.1:5176'` first. If uv's global cache is inaccessible, set `$env:UV_CACHE_DIR = ".uv-cache"`.

Sources: [fast-flights](https://github.com/AWeirdDev/flights), [Transitous](https://transitous.org/sources/), [OSRM](https://project-osrm.org/), GeoNames (CC BY 4.0), airportsdata (MIT), and MapLibre/OpenFreeMap with OpenStreetMap attribution.
