# Stateless provider functions

The native Planner owns trips, search queues, prices, caches and optimization.
Only provider HTTP operations run in `api/flights.py` and `api/transit.py`.
Neither entry imports the planner API, discovery manager or SQLite store.
OSRM remains a direct browser request. Multi-city flight quotes remain manual,
as in the Python provider adapter.

## Flight protocol 2

`POST /api/flights` accepts the existing legs, party size and departure window.
One-way searches return normalized options in one invocation. Round trips use
these steps:

1. Send `kind: "round-trip"`, with `operation: "search"` (the default).
   The response preserves outbound schedules with unknown prices and supplies
   `flight_choices`. An indicative first-page amount never becomes a quote.
2. For each choice, send the same request with `operation: "return"` and
   `selection` set to that choice. The function repeats the initial query and
   retrieves the selected return page using the same HTTP client. Only complete
   matching outward/return schedules receive that page's whole-party price.

Choices contain schedule identifiers, not server sessions. The browser saves
each child task before proceeding. Stop retains the current response and leaves
remaining choices queued; reload and Continue retain progress. Cached steps do
not consume the new-request allowance. Missing or changed schedules remain
visible as manual-quote opportunities; failures can be retried.

**Each uncached function invocation consumes one request.** This differs from
the Python backend's single logical round-trip task, which can retrieve several
returns internally. A native round trip with two outbound choices can therefore
consume three requests. Replaying the initial page for each return costs extra
upstream requests, but avoids server-owned sessions and unbounded invocations.
Diagnostics distinguish initial and conditional-return HTTP requests.

Flight calls have a 35-second network/admission deadline and a 15-second maximum
per HTTP request. One return invocation performs at most two upstream requests.
The local per-process admission limit is three flight calls; excess calls return
429. This is not a global rate limiter across function instances or users.

## Transitous and configuration

`GET /api/transit` accepts validated coordinates, offset-aware time, supported
transit modes, search window, transfer time, radius and pagination cursor. It
forwards only to the server-configured Transitous `/v6/plan` endpoint. It does
not accept arbitrary destination URLs. It returns routing JSON for native
normalization and browser-owned caching. It has a 35-second overall timeout,
25-second HTTP timeout and two-call per-process admission limit. Busy, failed
and timed-out requests return 429, 502 and 504 respectively.

Server environment:

- `TRANSITOUS_CONTACT_URL`: required before enabling routing, after coordinating
  application use with the provider. Without it the endpoint returns 503.
- `TRANSITOUS_API_BASE_URL`: defaults to `https://api.transitous.org/api`.
- `BROWSER_ALLOWED_ORIGINS`: comma-separated exact static-site origins for a
  separately hosted function backend. Same-origin hosting needs no CORS setting.

Public build environment:

- `BROWSER_FLIGHTS_URL`: defaults to `/api/flights`.
- `BROWSER_TRANSIT_URL`: defaults to `/api/transit`.
- `BROWSER_TRANSIT_ENABLED`: defaults to false; explicitly enable after setup.
- `OSRM_BASE_URL`: existing direct road-routing endpoint.

`prepare_static_planner.py` reads process environment variables and generates
`browser-data/config.json`. It does not load `.env` automatically. Export the
public build variables before building; keep provider contact and server-only
configuration in the function environment. No secrets belong in the public JSON.

## Local and package validation

`start-browser-poc.ps1` runs `backend.app.provider_dev:app`, which assembles both
routes, and Vite. Native Vite forwards only `/api/flights` and `/api/transit`.
The original planner server is unnecessary for the native interface.

`vercel.json` selects `frontend/dist-native` with its `index.html` root entry and
configures both Python entries with 60-second platform limits. The runtime
dependencies remain pinned through `pyproject.toml` and `uv.lock`. These files
prepare the hosting boundary; no deployment was performed.

For an independent runtime check:

```powershell
uv run python tools/prepare_provider_package.py
uv run python tools/check_provider_runtime.py --package data/diagnostics/provider-package
```

The packager refuses a nonempty destination and copies ten explicit provider
source/dependency files with SHA-256 provenance. The checker imports those
copies, verifies no planner server/store was imported, exercises native `primp`
over loopback HTTP, and runs flight and transit requests through ASGI. Provider
responses are mocked; no live provider traffic is required.

The same isolated package passed on Windows and Linux x86_64, Python 3.13.17,
glibc 2.39, with fast-flights 3.1.0, primp 2.0.1, FastAPI 0.143.3 and Pydantic
2.14.1. The temporary Linux validation distribution was removed afterward;
its report remains under ignored `data/diagnostics/linux-provider-check/`.
This proves the isolated source and native dependencies work in that Linux
environment. It does not prove Vercel's actual generated bundle, hosted routing,
or live providers' availability and bot handling from a hosting IP.

Backend tests cover successful, empty, partial, failed, timed-out and busy
operations, validation, CORS and whole-party pricing. A real-browser test covers
protocol-2 task insertion, one-request pauses, reload, Stop during a return call,
continuation without duplicate requests, and native optimization of both fares.
