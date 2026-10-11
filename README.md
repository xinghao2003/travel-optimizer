# Wayfinder Routes

A local multi-city flight and scheduled-rail planner. Choose an origin, a date window, and one to four destination cities. Every selected city is visited once; the app compares every destination order and can return to the origin at the end.

Flight fares are searched from Google Flights through [`fast-flights`](https://github.com/AWeirdDev/flights). Scheduled rail itineraries are requested from the public [Transitous API](https://transitous.org/api/) (MOTIS). City and airport codes come from [`airportsdata`](https://github.com/mborsetti/airportsdata); Transitous geocodes each selected city to a place coordinate before searching for trains. No Transitous API key is required.

## Trip search behavior and limits

- The trip uses one adult, economy fares, and MYR. Each selected destination is mandatory. The planner exhaustively compares every order for up to four destinations (24 possible orders).
- Travel legs are assigned dates evenly between the start and end dates. The end date is the final return-to-origin flight date when “Return to start city” is selected. The planner does not search every possible date or optimize how many nights to spend in each city.
- Searches use one-way queries for each possible city pair at its assigned leg date. Four destinations can require up to 44 flight searches and 44 Transitous rail searches; each service is queried with a small concurrency limit. Google may return no results, omit prices, change its page data, or temporarily block requests. Transitous may not have rail data for a selected city pair or date.
- The train search time defaults to 09:00 local time at each departure city. The planner requests rail-only itineraries and shows the scheduled departure/arrival, train or route name, operator, and station names when provided by the feed.
- When a rail itinerary is available, the result list includes a separate rail alternative even when the selected ranking preference favors a priced flight. This keeps unpriced train options visible without treating them as free.
- Transitous itinerary responses and place lookups are cached in a local SQLite database outside the project directory. Successful itinerary responses are cached for 6 hours, empty results for 15 minutes, place lookups for 30 days, and empty place lookups for 7 days. Set `TRANSITOUS_ROUTE_TTL_SECONDS`, `TRANSITOUS_EMPTY_ROUTE_TTL_SECONDS`, `TRANSITOUS_GEOCODE_TTL_SECONDS`, or `TRANSITOUS_EMPTY_GEOCODE_TTL_SECONDS` to change these values (seconds; zero disables caching for that category). Transient HTTP failures are not cached.
- Rail fares are not currently used in route totals. Unknown fares are never treated as zero: routes containing a rail leg show an incomplete total, and “Lowest total” ranks routes using only known fares. “Shortest” can select rail based on timetable duration.
- Flight results link back to a Google Flights search. Prices and schedules can change and are not booking guarantees. Map lines connect city locations and do not represent rail-track geometry.

Transitous asks projects to identify themselves and coordinate before sending routing traffic or many requests. Rail lookups stay disabled until `TRANSITOUS_CONTACT_URL` is set to the project homepage or maintainer contact URL; the client sends it in its User-Agent. Contact Transitous about this planner's routing load before enabling it. The app sends no credentials or API key and makes no Transitous calls until a user submits a trip search after configuration. The UI links to Transitous source attribution.

The `fast-flights` query builder can serialize multi-city queries, but its published getting-started docs still describe multi-city as unsupported and its parser can fail when Google returns rows without prices. Wayfinder therefore requests one-way legs and filters rows without a fare before passing the remaining response through the package parser.

## Run locally on Windows

Install Python 3.11+, uv, and Node.js 20.19+ (or 22.12+), then run from the project root:

```powershell
uv venv .venv
uv pip install --python .venv\Scripts\python.exe -r backend\requirements.txt
npm --prefix frontend install
Copy-Item .env.example .env
```

Edit `.env` and set `TRANSITOUS_CONTACT_URL` to your project homepage or maintainer contact URL after coordinating with Transitous. No Transitous API key is required. The real `.env` is ignored by Git; `.env.example` contains the supported settings and can be committed.

Start the API in one PowerShell window:

```powershell
.\.venv\Scripts\python.exe -m uvicorn app.main:app --reload --app-dir backend --env-file .env
```

Start the frontend in another PowerShell window:

```powershell
npm --prefix frontend run dev
```

Open <http://127.0.0.1:5173>. The API health check is at <http://127.0.0.1:8000/api/health>.

## Run the built app with one local server

```powershell
npm --prefix frontend run build
.\.venv\Scripts\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8000 --app-dir backend --env-file .env
```

Open <http://127.0.0.1:8000>. FastAPI serves the generated frontend from `frontend/dist` when that directory exists.

## Configuration

The airport buffer is editable in the trip form. Transitous settings, including the API base and local cache TTLs, are documented in `.env.example`. The default cache is `%LOCALAPPDATA%\Wayfinder Routes\transitous-cache.sqlite3` on Windows, `$XDG_CACHE_HOME/Wayfinder Routes/transitous-cache.sqlite3` on Linux/macOS, or `~/.cache/Wayfinder Routes/transitous-cache.sqlite3` when `XDG_CACHE_HOME` is unset.

Airport data is provided by airportsdata under the MIT License. The map uses MapLibre and an OpenFreeMap style with OpenStreetMap contributors credited in the map.
