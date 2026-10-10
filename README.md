# Wayfinder Routes

A local flight and ground-transport route planner. Import saved Skyscanner HTML snapshots, choose a trip origin found in the imported routes, compare one-way outbound and return fares, and model an estimated road-based connection between any two recognized destinations.

Place saved Skyscanner pages in `data/inputs/` using `.txt`, `.html`, or `.htm` extensions. The loader scans files recursively, extracts both airport/city endpoints and travel dates from each result URL, and logs loaded/skipped files and parsed routes in the backend console. Every coordinate-resolved origin code found in those links is offered as a start city. Unsupported or failed files do not stop the other snapshots from loading.

For the selected origin, the optimizer uses one-way fares from the most common saved date for flights leaving that origin and flights returning to it. Round-trip results remain visible in the parsed snapshots table but are not split into fictitious one-way fares. Missing fares remain blank and are excluded from priced route combinations.

## City coordinates

The app resolves imported route endpoint names against GeoNames' `cities500` worldwide dataset and stores resolved points in `backend/data/city_coordinate_cache.json`. It falls back to a small built-in coordinate catalog when the dataset is absent. To resolve additional cities, download the free dataset once from the GeoNames download service:

```powershell
.\.venv\Scripts\python.exe backend\app\geonames.py --download
```

The downloaded archive is saved to `data/geonames/cities500.zip`. GeoNames data is CC BY 4.0 and is provided as-is; the map footer credits OpenStreetMap, and this README credits GeoNames. See the [GeoNames dataset readme](https://download.geonames.org/export/dump/readme.txt).

## Run locally on Windows

Install Python 3.10+, uv, and Node.js 20.19+ (or 22.12+), then run these commands from the project root:

```powershell
uv venv .venv
uv pip install --python .venv\Scripts\python.exe -r backend\requirements.txt
npm --prefix frontend install
```

Start the API in one PowerShell window:

```powershell
.\.venv\Scripts\python.exe -m uvicorn app.main:app --reload --app-dir backend
```

Start the Vite frontend in another PowerShell window:

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

## Estimate settings and services

- Defaults are 200 km/h, a 1.0 distance factor, RM0.27/km, and 30 minutes of connection overhead. RM0.27/km carries forward the prior ¥0.45/km × RM0.60/CNY assumption. All values can be changed in the settings panel.
- OSRM driving distances are cached in `backend/data/road_distance_cache.json`. When OSRM has no road route or is offline, the app uses a labeled great-circle distance proxy so the optimizer can model an assumed connection. These proxy distances are not road routes.
- The map uses MapLibre with an OpenStreetMap-based OpenFreeMap style. Map tiles and uncached routing distances require an internet connection; no API key is required.
- Flight fares are saved snapshots, not live quotes. Coordinates are city/place points and transport costs and times are configurable estimates. OSRM road distance and assumed-connection proxies do not confirm that a real transport service or connection exists.

To use another OSRM server, set `OSRM_BASE_URL` before starting FastAPI, for example:

```powershell
$env:OSRM_BASE_URL = "https://router.project-osrm.org"
```
