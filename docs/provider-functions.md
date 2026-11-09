# Providers and the flight function

The browser owns trips, search queues, prices, caches and optimization. It calls
the providers directly:

- **OSRM** road matrices: `OSRM_BASE_URL`, default `https://router.project-osrm.org`.
- **Transitous** scheduled transit: `BROWSER_TRANSIT_URL`, default
  `https://api.transitous.org/api/v6/plan`.
- **Flights**: `BROWSER_FLIGHTS_URL`, default `/api/flights`, the only backend.

Google Flights has no browser-accessible API, so flight searches run in the
stateless function `api/flights.py` with `api/_flight_provider.py`
(fast-flights and primp). Vercel does not deploy `_` files as functions. It keeps no trip data, session or queue. Multi-city
quotes stay manual: the browser builds the search link and does not call the
function for them.

## Flight protocol 2

`POST /api/flights` accepts legs, party size and departure window. One-way
searches return normalized options in one invocation. Round trips use these
steps:

1. Send `kind: "round-trip"`, with `operation: "search"` (the default).
   The response keeps outbound schedules with unknown prices and supplies
   `flight_choices`. An indicative first-page amount never becomes a quote.
2. For each choice, send the same request with `operation: "return"` and
   `selection` set to that choice. The function repeats the initial query and
   retrieves the selected return page with the same HTTP client. Only complete
   matching outward/return schedules receive that page's whole-party price.

Choices contain schedule identifiers, not server sessions. The browser saves
each child task before it continues. Stop keeps the current response and leaves
remaining choices queued; reload and Continue keep progress. Cached steps do
not use the new-request allowance. Missing or changed schedules stay visible
as manual-quote opportunities; failures can be retried.

**Each uncached function call uses one request.** A round trip with two outbound
choices therefore uses three requests. Repeating the initial page for each return
costs extra upstream requests, but avoids server-owned sessions and unbounded
calls. Diagnostics separate initial and return HTTP requests.

Flight calls have a 35-second network/admission deadline and a 15-second maximum
per HTTP request. One return call makes at most two upstream requests. The
per-process admission limit is three flight calls; excess calls return 429.
This is not a global rate limiter across function instances or users.
`GET /api/flights` is a health check.

## Transitous

Search planning, response normalization, pagination, rail fallback and caching
run in the browser. Cross-origin requests send an origin referrer, and the
application footer has a Contact link (`TRANSITOUS_CONTACT_URL`, default
`https://github.com/xinghao2003/travel-optimizer`). This follows the Transitous
[browser identification policy](https://transitous.org/api/). Set
`BROWSER_TRANSIT_ENABLED=false` to disable transit.

## Configuration

`tools/prepare_catalogs.py` reads these process environment variables and
writes them to the public `browser-data/config.json`. It does not read a `.env` file.
Export them before building. No secrets belong in this file.

- `BROWSER_FLIGHTS_URL`, `BROWSER_TRANSIT_URL`, `BROWSER_TRANSIT_ENABLED`,
  `OSRM_BASE_URL`, `TRANSITOUS_CONTACT_URL`.

Function environment:

- `BROWSER_ALLOWED_ORIGINS`: comma-separated exact origins for a static site
  hosted on another origin. Same-origin hosting needs no CORS setting.

## Hosting and validation

`vercel.json` builds `app/dist` and deploys `api/flights.py` with a 60-second
limit. Runtime dependencies are pinned through `pyproject.toml` and `uv.lock`.

For an isolated runtime check of the function package:

```powershell
uv run python tools/prepare_provider_package.py
uv run python tools/check_provider_runtime.py --package data/diagnostics/provider-package
```

The packager refuses a nonempty destination and copies the function sources and
dependency files with SHA-256 provenance. The checker imports those copies,
runs native `primp` over loopback HTTP, and runs one-way and round-trip steps
through ASGI with mocked provider responses. No live provider traffic is needed.
This does not prove Vercel's generated bundle, hosted routing, or live provider
availability and bot handling from a hosting IP.

`tests/test_flight_provider.py` covers successful, empty, partial,
failed, timed-out and busy operations, request validation, CORS, the return-page
query encoding and whole-party pricing. Browser tests cover protocol-2 tasks,
one-request pauses, reload, Stop during a return call, continuation without
duplicate requests, and optimization of both fares.
