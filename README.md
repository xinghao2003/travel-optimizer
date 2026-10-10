# Wayfinder Routes

A live multi-city flight and ground-route planner. Choose an origin, a date window, and one to four destination cities. Every selected city is visited once; the app compares every destination order and can return to the origin at the end.

Flight fares are searched from Google Flights through [`fast-flights`](https://github.com/AWeirdDev/flights). City and airport codes come from [`airportsdata`](https://github.com/mborsetti/airportsdata). The app searches one-way city pairs so it can compare flight and estimated ground travel separately for each leg.

## Trip search behavior and limits

- The trip uses one adult, economy fares, and MYR. Each selected destination is mandatory. The planner exhaustively compares every order for up to four destinations (24 possible orders).
- Travel legs are assigned dates evenly between the start and end dates. The end date is the final return-to-origin flight date when “Return to start city” is selected. The planner does not search every possible date or optimize how many nights to spend in each city.
- Searches use one-way queries for each possible city pair at its assigned leg date. Four destinations can require up to 44 Google Flights requests; searches run with a small concurrency limit. Google may return no results, omit prices, change its page data, or temporarily block requests. Unpriced rows are skipped, and successful ground estimates remain available when a flight search fails.
- A city resolves to one airport or an IATA multi-airport city code when available. The bundled airport catalog contains IATA airport locations, not train or bus stations.
- Road distances use OSRM driving routes and are cached in `backend/data/road_distance_cache.json`. Where OSRM cannot find a road, the planner uses a labeled direct-distance proxy. Ground costs and times follow editable assumptions; they do not confirm a bus, train, ferry, road connection, or service schedule.
- Flight results link back to a Google Flights search. Prices are live search results, not booking guarantees.

The `fast-flights` query builder can serialize multi-city queries, but its published getting-started docs still describe multi-city as unsupported and its parser can fail when Google returns rows without prices. Wayfinder therefore requests one-way legs and filters rows without a fare before passing the remaining response through the package parser.

## Run locally on Windows

Install Python 3.11+, uv, and Node.js 20.19+ (or 22.12+), then run from the project root:

```powershell
uv venv .venv
uv pip install --python .venv\Scripts\python.exe -r backend\requirements.txt
npm --prefix frontend install
```

Start the API in one PowerShell window:

```powershell
.\.venv\Scripts\python.exe -m uvicorn app.main:app --reload --app-dir backend
```

Start the frontend in another PowerShell window:

```powershell
npm --prefix frontend run dev
```

Open <http://127.0.0.1:5173>. The API health check is at <http://127.0.0.1:8000/api/health>.

## Run the built app with one local server

```powershell
npm --prefix frontend run build
.\.venv\Scripts\python.exe -m uvicorn app.main:app --host 127.0.0.1 --port 8000 --app-dir backend
```

Open <http://127.0.0.1:8000>. FastAPI serves the generated frontend from `frontend/dist` when that directory exists.

## Configuration

Ground speed, fare per kilometer, connection overhead, and flight airport buffer are editable in the trip form. To use another OSRM server, set `OSRM_BASE_URL` before starting FastAPI:

```powershell
$env:OSRM_BASE_URL = "https://router.project-osrm.org"
```

Airport data is provided by airportsdata under the MIT License. The map uses MapLibre and an OpenFreeMap style with OpenStreetMap contributors credited in the map.
