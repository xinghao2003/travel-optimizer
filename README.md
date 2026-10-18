# Wayfinder Routes

A local multimodal trip optimizer that compares total party transportation cost with hours spent in required cities, including positioning from home and back.

## Trip setup and results

- Choose a home/base, up to three departure candidates, up to three arrival candidates, and one to four required cities. The optimizer chooses one departure and one arrival candidate and the visit order.
- Fixed dates are the default: leave home on the start date and arrive back on the end date. Flexible dates permit the entire journey anywhere inside those bounds. Boundaries use the home timezone.
- Set individual minimum stays in elapsed hours, one to nine adult travelers, a party budget in MYR, allowed modes, maximum transfers per intercity journey, overnight travel, and city-local fixed commitments. Overnight means crossing midnight in the departure timezone.
- Optionally set the earliest home departure on the start date and latest home arrival on the end date, in the home timezone. Blank limits use the full boundary days; limits also apply in flexible date mode.
- Under **Home time limits and positioning services**, configure each non-home gateway independently for outbound and return travel. For each mode choose **Search + supplied services**, **Supplied services only**, or **Unavailable**. These choices also apply to cached options. The trip's allowed modes still apply. Disabling positioning buses does not disable buses between required destinations.
- Add known positioning services with departure and arrival dates/times in each endpoint's local timezone and an optional whole-party fare/currency. Early outbound and late return services can be supplied without entering every departure. Supplied times are used even outside the automatic search window; airport access and flight readiness buffers remain separate for onward flights. Remove and re-add services to change them. With search disabled and no supplied service, that mode has no positioning options. Settings and services persist with the trip; start a new discovery after changing home limits or positioning search policies.
- Flight, rail, bus, coach, subway, tram, car, and taxi are modeled. Full flight timestamps include layovers and actual airport timezones. City/terminal access, readiness buffers, and final travel home are included. City-stay hours include nights; home, positioning cities, and transportation do not count.
- Edit fixed/ranged fares, save reusable fixed/distance pricing rules, and enter currency conversion rates. Overrides take precedence over retrieved fares; rules estimate missing prices. Person/party/vehicle units and seating capacity are explicit. Connector rules use their actual city/airport endpoints and country.
- Unknown fares stay unknown. Range/unknown routes are provisional, and uncertain budget compliance is flagged. Definitely over-budget routes stay outside the frontier; up to ten examples are available for ticket/fare refinement.
- Missing fares are shown in a compact table. Matching airport access/egress transfers are grouped by endpoints, type, mode, currency, and missing-fare reason, with distinct affected-itinerary counts. Standalone flight fares remain separate. Expand groups to enter individual overrides. **Save estimate** (and individual fare saves in this table) stages drafts in this browser, surviving reloads without optimizing. **Apply saved estimates** saves all staged values in one request and recalculates once. Each value is a whole-party amount per component, not a bundled total. Shared estimates cover listed components in the current snapshot; later discovery may add new unpriced components. Existing priced components remain editable in itinerary details.
- An own car must be physically available and recovered to home. Rentals require declared pickup/drop-off locations, daily/driving costs, and one-way charges. Rentals are returned at an allowed location before changing transport. Rental inventory is not live.
- Trips, fare edits, rules, graphs, and discovery checkpoints persist in SQLite. Fare, timing, and driving-price edits recalculate saved data. Changed cities, dates, travelers, or coverage may require more discovery.

The ECharts frontier links to a MapLibre map, city-stay timeline, transport details, and purchase breakdown. Comparison shows the additional money per additional city hour. Average fare per stay hour is a separate descriptive metric. Map connections are schematic, not track or road geometry.

Frontier cards show the party fare per city-stay hour beside travel time; bounded fare intervals show the corresponding ratio interval, and unbounded totals stay unknown. The chart defaults to linear axes fitted to the data, with optional logarithmic cost and city-hour axes and a zoom reset. Log controls are unavailable when an axis contains zero/non-positive values; alternatives are not silently hidden. The frontier omits dominated histories under the retrieved fares and constraints, while the underlying schedules and fares remain saved for future recalculation.

**Show dominated alternatives** optionally loads other completed, budget/fare-eligible histories from the saved graph without provider queries. They appear as selectable grey points and itinerary cards; the frontier line still connects only non-dominated options. First loading recalculates the graph; later toggles reuse the loaded results. This view is not exhaustive enumeration: dominance pruning may already have removed other partial histories during search.

## Pricing and search coverage

One-way, round-trip, and multi-city purchases cover exact movements and cannot overlap or be charged twice. Google Flights queries request the whole party; returned prices are not multiplied again. The installed fast-flights parser can return only outbound segments for round trips and fail multi-city parsing. These are **not complete bundle quotes**: the app provides search links and accepts manually entered whole-ticket prices.

Dynamic programming preserves different ticket eligibility, vehicle states, and fare uncertainty. Ticket cover is exact. Ranking changes display order, not frontier membership. **Optimality applies to the retrieved event graph and stated assumptions, not every ticket worldwide.** Road departures are instantiated at readiness, connection, and return-boundary events; continuous-time traffic/rental optimization is not claimed. Feed gaps, missing quotes, failures, and unsearched dates remain visible. Stale provider quotes and user conversion rates are estimates.

Discovery defaults to **100 uncached requests per batch**. Continue adds another batch and reuses caches. Cancel preserves collected work; paused/interrupted jobs can resume. Start a new job when discovery inputs change. Disabled Transitous sends no transit requests. Failed queries can be retried after the queue is exhausted.

New discovery queues use rough date windows from the minimum city stays, combining all visit orders and gateway choices. This optimistic filter assumes zero travel time and keeps whole departure-local calendar days; exact schedules, buffers, and commitments are checked by the optimizer. Own-car recovery retains broad windows because it may require additional detours. Existing saved queues keep their original tasks; start a new discovery job to use the narrowed queue. Discovery currently recalculates after every four processed queries and at a batch boundary; unchanged optimization inputs reuse the previous result.

Optimization defaults to **25,000 expanded labels**. Hitting the limit is explicitly marked incomplete. Continue increases the allowance and recomputes from the saved graph, rather than searching only the previous frontier. Accommodation, sightseeing hours, and reliability remain later phases.

## Run on Windows

Use uv and Node.js 20.19+ or 22.12+. The root `pyproject.toml` declares Python 3.13 and the backend dependencies; `uv.lock` records the resolved versions.

```powershell
uv python install 3.13
uv sync
npm --prefix frontend install
Copy-Item .env.example .env
```

Optional city catalog for places without airports:

```powershell
New-Item -ItemType Directory -Force data\geonames
Invoke-WebRequest https://download.geonames.org/export/dump/cities500.zip -OutFile data\geonames\cities500.zip
```

The existing local archive is reused. Without it, airport-backed cities and custom coordinate entries remain available. First lookup builds a city index. A replaced archive or airport-data package rebuilds that index after server restart; saved trips use a separate database.

Build and serve with one process:

```powershell
npm --prefix frontend run build
uv run uvicorn app.main:app --host 127.0.0.1 --port 8000 --app-dir backend --env-file .env
```

Open <http://127.0.0.1:8000>. Health: `/api/health`; API documentation: `/docs`.

For development with backend hot reload, stop the existing backend and run:

```powershell
.\dev-backend.ps1
```

This watches Python files under `backend/app` and restarts the API after edits. Database and cache writes do not trigger reloads. Use `./dev-backend.ps1 -Port 8001` for another port. Changes to `.env` require a manual restart. A reload interrupts active discovery jobs; saved data remains available and interrupted jobs can be continued.

For frontend development, keep the API on port 8000 and run `npm --prefix frontend run dev` in another terminal, then open port 5173. Vite uses `--configLoader runner` on Windows. If a restricted environment prevents its dependency optimizer reading parent directories, use the built app command above.

## Configuration and saved work

See `.env.example`. Set `TRANSITOUS_CONTACT_URL` after coordinating routing use with Transitous. Keep source attribution. The public service has regional feed gaps and its own [API usage policy](https://transitous.org/api/); an empty result does not prove that transportation is unavailable.

| Setting | Default |
| --- | --- |
| `PLANNER_DB_PATH` | `backend/data/planner.sqlite3` |
| `PLANNER_PLACES_PATH` | `backend/data/places.sqlite3` |
| `PLANNER_LABEL_BATCH` | `25000` |
| `PLANNER_DEBUG` | `0` (set to `1` for diagnostics) |
| `OSRM_BASE_URL` | `https://router.project-osrm.org` |
| `TRANSITOUS_ROUTE_TTL_SECONDS` | `21600` |
| `TRANSITOUS_EMPTY_ROUTE_TTL_SECONDS` | `900` |

The planner database uses WAL and schema versioning. Stop the server before copying a backup, or include its active `-wal`/`-shm` files. The city index is disposable; the planner database contains user work. Both are ignored by Git. Existing Transitous caching remains in the platform application-cache directory.

Default assumptions: 90 minutes before flights, 30 after flights, 15 before transit, 10 after transit, and a 30-minute minimum connection. Airport access uses OSRM when available. Otherwise the editable fallback is 45 minutes per side with an unknown fare. Clear the fallback to require resolved access time. An unavailable intercity road never becomes an automatic straight-line driving connection.

Flight responses cache for 15 minutes and road matrices for seven days. Transitous uses its configured TTLs. Reopening a trip does not refresh its provider quotes; expired quotes are shown as stale estimates.

For slow or unresponsive searches, set `PLANNER_DEBUG=1` in `.env` and restart the backend. Stage timings, provider query outcomes, graph persistence, bundle queue generation, and optimizer progress (every five seconds during label expansion) appear in the terminal and rotating `backend/data/planner-debug.log` files. If the API event loop cannot advance for 30 seconds, a separate watchdog writes all Python thread stacks to `backend/data/planner-stacks.log`, repeating every 30 seconds until it recovers. These diagnostics distinguish network waits, optimization, serialization, and event loop blocking. Set `PLANNER_DEBUG=0` and restart to disable them.

## API and verification

The optimizer can return through previously visited destinations after completing all required visits, for example KUL → Seoul → Busan → Seoul → KUL. Each destination can appear once on the return path; first visits must meet their minimum stays and commitments, while return visits can be short connections. Destination time on return visits counts toward stay hours. Independent one-way fares and validated, non-overlapping round-trip bundles are compared. Gateway-to-destination round-trip queries are seeded independently of completed one-way itineraries, using optimistic date windows and the total minimum stay; exact returned schedules must still pass the optimizer's full constraints. Multi-city retrieval remains limited by fast-flights; diagnostics distinguish no returned rows from incomplete journeys and do not interpret either as proof that no bundle exists. Existing trips need a new discovery to cover the expanded return dates and independent round-trip queries; cached provider responses remain reusable.

The `/api/v2` API provides city lookup; trip CRUD with `expected_revision`; discovery start/status/continue/cancel; optimization; fare editing; assumed connections; and reusable pricing rules. Main actions:

- `POST /trips/{id}/searches` with `{ "budget": 100 }`.
- `GET /searches/{id}`, `POST /searches/{id}/continue`, `POST /searches/{id}/cancel`.
- `POST /trips/{id}/optimize`; `{ "expand": true }` increases the solver allowance.
- `PUT/DELETE /trips/{id}/fares/{offer_id}`, `POST /trips/{id}/movements`.
- `GET /pricing-rules`, `PUT/DELETE /pricing-rules/{id}`.

Trip reads omit the large movement graph unless `?include_graph=true` is supplied. Results identify trip/snapshot revisions and discovery/optimization completion. The frontend rejects stale results. `/api/routes` remains a compatibility adapter for single-origin requests with assigned dates, using the new schedule-aware engine.

Pricing indexes valid fares once per solver run, reuses ticket-cover results across phase changes, and indexes missing-fare comparison thresholds. Debug `dp.search.done` logs report price calculations and reuses. Unchanged discovery inputs reuse prior results; quote expiry refreshes stale warnings without rerunning optimization. Fare, schedule, rule, constraint, and solver-allowance changes still require recalculation.

Multi-city ticket opportunities are registered directly in the manual-quote list with search links. They never enter the provider queue or increment processed, pending, provider-request, or cache-hit counts, and they do not trigger extra publications. A separate manual-quote counter shows the number of unique opportunities. Resuming an older job moves its unprocessed multi-city tasks out of the queue while preserving historical counters. One-way and round-trip retrieval still use fast-flights. Ticket candidates are deduplicated by city pairs and departure dates before constructing provider queries. Coverage is published every four provider-query tasks; when a solve takes at least five seconds, changed provider data is batched until sixteen queries have been processed since that solve. Pausing/completing discovery and manual trip/rule changes force an up-to-date solve. Overlapping optimization requests can reuse a matching completed snapshot.

Saved itinerary results share repeated movement, purchase, and extra-charge objects in a versioned, lossless representation. Normal API reads retain the expanded format; `GET /trips/{id}?compact=true` and `POST /trips/{id}/optimize` with `{ "compact": true }` opt into the shared representation. The frontend expands references locally. Trip response reads and JSON encoding run in a worker thread, with direct JSON responses avoiding a redundant recursive conversion. Existing saved trips are readable without migration; their next normal save adopts the compact storage format.

```powershell
$env:PYTHONPATH = "backend"
uv run python -m unittest discover -s backend/tests -v
npm --prefix frontend run build
```

If uv's global cache is inaccessible, set `$env:UV_CACHE_DIR = ".uv-cache"` in PowerShell before running uv commands. Deterministic tests cover exhaustive small-graph comparison, mixed modes, bundle discounts and overlap, fare uncertainty, traveler/vehicle units, timing/DST, positioning, car recovery, rental fees, caching, budgets, cancellation, revision conflicts, and restart persistence. Browser interactions and live provider checks are separate validations.

Sources: [fast-flights](https://github.com/AWeirdDev/flights), [Transitous](https://transitous.org/sources/), [OSRM](https://project-osrm.org/), GeoNames (CC BY 4.0), airportsdata (MIT), and MapLibre/OpenFreeMap with OpenStreetMap attribution.

Airport–city transfers can be entered before discovery in the trip's dedicated table. It lists configured airports in both directions and adds airports encountered in retrieved journeys. Add taxi, car, rail, subway, tram, bus, or coach options with a travel time and optional whole-party fare/range. Saved options apply to current and future matching journeys in that trip and party size; individual component fare overrides take priority. Alternatives change door-to-door timing while retaining the underlying flight ticket and bundle coverage. They are user assumptions, without timetable or operating-hour verification. An unedited taxi retains the existing road/fallback timing; airport-to-airport connections remain separate.

Round-trip discovery selects each returned outbound journey and fetches its conditional return choices. Only pairs passing endpoint, date, time, and chronological validation receive the return page's whole-ticket fare; indicative first-page fares are never assigned to complete trips. Return follow-up failures remain diagnostic/manual-quote results. Each round-trip query may make multiple HTTP requests and limits follow-up work to 25 seconds; diagnostics record the number of outbound choices checked and any errors. Start a new discovery for existing trips to retrieve these complete quotes; older round-trip cache entries are bypassed. Multi-city retrieval remains manual.
