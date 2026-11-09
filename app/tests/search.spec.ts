import { expect, test } from "@playwright/test";

test("deleting an assumed connection during search does not restore it from the active graph", async ({ page }) => {
  await page.route("**/native-delete-assumption-test", route => route.fulfill({ contentType: "text/html", body: "<!doctype html>" }));
  await page.goto("/native-delete-assumption-test");
  const summary = await page.evaluate(async () => {
    const { PlannerRepository } = await import("/src/native/repository.ts"), { BrowserCalculator } = await import("/src/native/calculation.ts");
    const { BrowserDiscovery } = await import("/src/native/search.ts"), { removeAssumedMovement } = await import("/src/native/edits.ts");
    const corpus = await (await fetch("/tests/fixtures/search.json")).json(), item = corpus.cases.find((c: { name: string }) => c.name === "reuse-shared-assumptions");
    const repository = new PlannerRepository("native-delete-assumption-" + crypto.randomUUID());
    await repository.put("trips", item.initial.id, item.initial);
    for (const [key, graph] of Object.entries(item.graphs)) await repository.put("graphs", key, graph);
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; }), waiting = new Promise<void>(resolve => { release = resolve; });
    const provider = { settings: async () => ({ schema_version: 1 as const, flights_url: "/api/flights", osrm_base_url: "https://example.test", transit_url: "/api/transit", transit_enabled: true }),
      fetch: async () => { entered(); await waiting; return { outcome: { status: "empty" }, usedRequest: true }; } };
    const discovery = new BrowserDiscovery(repository, new BrowserCalculator(repository), provider, async () => corpus.catalog);
    const job = await discovery.start(item.initial.id, 1); await started;
    const removing = discovery.change(item.initial.id, () => repository.updateTrip(item.initial.id, trip => removeAssumedMovement(trip, "cached-assumption", trip.revision), true), false);
    await new Promise(resolve => setTimeout(resolve, 0)); release(); await removing; await discovery.wait(job.id);
    const trip = await repository.requireTrip(item.initial.id), record = await repository.get("jobs", job.id) as { snapshot: { movements: { id: string }[] }; requests: number }, graph = await repository.get("graphs", Object.keys(item.graphs)[0]) as { movements: { id: string }[] };
    await repository.close();
    return { revision: trip.revision, requests: record.requests, inTrip: trip.snapshot?.movements.some(m => m.id === "cached-assumption"),
      inJob: record.snapshot.movements.some(m => m.id === "cached-assumption"), inShared: graph.movements.some(m => m.id === "cached-assumption") };
  });
  expect(summary).toEqual({ revision: 2, requests: 1, inTrip: false, inJob: false, inShared: false });
});

test("native live discovery keeps unpriced flight schedules and finds the independently priced round trip", async ({ page }) => {
  let thinRequests = 0, pricedBundles = 0;
  const forbidden: string[] = [];
  page.on("request", request => { if (/\/api\/v2|\/api\/data|jsdelivr/.test(request.url())) forbidden.push(request.url()); });
  await page.route("**/browser-data/config.json", route => route.fulfill({ json: { schema_version: 1, flights_url: "/api/flights", osrm_base_url: "https://osrm.example.test", transit_url: "/api/transit", transit_enabled: false } }));
  await page.route("https://osrm.example.test/**", route => {
    const count = new URL(route.request().url()).pathname.split("/").pop()!.split(";").length;
    return route.fulfill({ json: { code: "Ok", distances: Array.from({ length: count }, (_, i) => Array.from({ length: count }, (_, j) => i === j ? 0 : 10000)),
      durations: Array.from({ length: count }, (_, i) => Array.from({ length: count }, (_, j) => i === j ? 0 : 1200)) } });
  });
  await page.route("**/native-flight-search-setup", route => route.fulfill({ contentType: "text/html", body: "<!doctype html>" }));
  await page.goto("/native-flight-search-setup");
  const seed = await page.evaluate(async () => {
    const { PlannerRepository } = await import("/src/native/repository.ts");
    const corpus = await (await fetch("/tests/fixtures/search.json")).json(), source = corpus.cases.find((c: { name: string }) => c.name === "bundles-from-complete-histories").initial;
    const trip = structuredClone(source), movements = trip.snapshot.movements.filter((m: { mode: string }) => m.mode === "flight");
    trip.spec.modes = ["flight"]; trip.spec.adults = 2; trip.spec.exclude_unpriced_flights = true; trip.snapshot = null; trip.offers = [];
    trip.spec.departure_start = "00:00:00"; trip.spec.departure_end = "23:59:00";
    // Use a valid direct outbound. The source preparation fixture deliberately
    // contains an infeasible GMP/ICN airport change for normalization tests.
    const outbound = movements[0].segments.find((s: { mode: string }) => s.mode === "flight");
    movements[0].segments = [{ ...outbound, to_id: "ICN", to_name: "ICN", arrival: "2027-02-10T12:00:00Z" }];
    trip.airport_transfer_estimates = []; trip.journey_pricing_rules = [];
    const repository = new PlannerRepository(); await repository.put("trips", trip.id, trip); await repository.close();
    localStorage.setItem("wayfinder:last-trip", trip.id); return { id: trip.id, movements };
  });
  await page.route("**/api/flights", async route => {
    thinRequests++;
    const request = route.request().postDataJSON();
    const selected = request.legs.map((leg: { from_id: string; to_id: string; date: string }) => seed.movements.find((m: { from_id: string; to_id: string; segments: { mode: string; departure: string }[] }) => m.from_id === leg.from_id && m.to_id === leg.to_id
      && m.segments.find(s => s.mode === "flight")!.departure.slice(0, 10) === leg.date));
    const found = selected.every(Boolean), bundled = request.kind === "round-trip";
    if (found && bundled) pricedBundles++;
    await route.fulfill({ json: { status: found ? "success" : "empty", options: found ? [{ price: bundled ? 50 : null,
      journeys: selected.map((m: { segments: { mode: string }[] }) => m.segments.filter(s => s.mode === "flight")) }] : [], search_url: "https://www.google.com/travel/flights", kind: request.kind } });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Search transport", exact: true }).last().click();
  await expect.poll(() => page.evaluate(async id => {
    const { PlannerRepository } = await import("/src/native/repository.ts"), repository = new PlannerRepository();
    try {
      const trip = await repository.requireTrip(id), job = await repository.get("jobs", trip.latest_job_id!) as { status: string; requests: number } | undefined;
      return job?.status;
    } finally { await repository.close(); }
  }, seed.id)).toBe("complete");
  const saved = await page.evaluate(async id => {
    const { PlannerRepository } = await import("/src/native/repository.ts"), repository = new PlannerRepository();
    try { const trip = await repository.requireTrip(id); return { spec: trip.spec, graph: trip.snapshot, result: trip.result }; } finally { await repository.close(); }
  }, seed.id);
  const pricedReturn = saved.result?.routes.some(r => r.purchases.some(o => o.kind === "round-trip" && o.low === 50 && o.high === 50 && o.adults === 2));
  expect(pricedReturn, JSON.stringify({ thinRequests, pricedBundles, offers: saved.graph?.offers, messages: saved.graph?.coverage.messages,
    feasible: saved.result?.feasible_count, hidden: saved.result?.hidden_unpriced_flight_count })).toBe(true);
  expect(thinRequests).toBeGreaterThan(0); expect(pricedBundles).toBeGreaterThan(0); expect(forbidden).toEqual([]);
});

test("native provider HTTP coalesces cached queries and preserves failures, matrices and empty-route TTL", async ({ page }) => {
  let transitCalls = 0, flightCalls = 0, roadCalls = 0;
  await page.route("**/native-provider-http-test", route => route.fulfill({ contentType: "text/html", body: "<!doctype html>" }));
  await page.route("**/mock-transit?*", route => { transitCalls++; return route.fulfill({ json: { itineraries: [] } }); });
  await page.route("**/mock-flights", route => { flightCalls++; return route.fulfill({ json: { status: "failed", options: [], message: "Recorded provider failure" } }); });
  await page.route("**/mock-osrm/table/**", route => { roadCalls++; return route.fulfill({ json: { code: "Ok", distances: [[0, 2000], [3000, 0]], durations: [[0, 60], [120, 0]] } }); });
  await page.goto("/native-provider-http-test");
  const summary = await page.evaluate(async () => {
    const { PlannerRepository } = await import("/src/native/repository.ts"), { BrowserProviders, providerPlan } = await import("/src/native/providers.ts");
    const corpus = await (await fetch("/tests/fixtures/search.json")).json(), repository = new PlannerRepository("native-provider-http-" + crypto.randomUUID());
    const spec = corpus.cases[0].initial.spec, snapshot = { revision: 0, movements: [], offers: [], coverage: {} };
    const settings = { schema_version: 1 as const, flights_url: "/mock-flights", osrm_base_url: "/mock-osrm", transit_url: "/mock-transit", transit_enabled: true };
    const provider = new BrowserProviders(repository, async () => corpus.catalog, async () => settings);
    const task = { kind: "transit" as const, key: "test", from_id: "home", to_id: "a", date: "2027-02-10" };
    const parallel = await Promise.all([provider.fetch(task, spec, snapshot), provider.fetch(task, spec, snapshot)]);
    const cached = await provider.fetch(task, spec, snapshot), plan = providerPlan(task, spec, corpus.catalog, settings);
    const emptyExpires = await repository.getCache(plan.key, Date.now() + 901_000) === undefined;
    const road = await provider.fetch({ kind: "road", key: "road" }, spec, snapshot);
    const flightCase = corpus.cases.find((c: { name: string }) => c.name === "bundles-from-complete-histories");
    const flightTask = flightCase.steps[0].queue.find((t: { kind: string }) => t.kind === "flight");
    const failed = await provider.fetch(flightTask, flightCase.initial.spec, snapshot), retried = await provider.fetch(flightTask, flightCase.initial.spec, snapshot);
    const disabled = new BrowserProviders(repository, async () => corpus.catalog, async () => ({ ...settings, transit_enabled: false }));
    const unsupported = await disabled.fetch(task, spec, snapshot);
    await repository.close();
    return { used: parallel.map(r => r.usedRequest), cached: cached.usedRequest, emptyExpires, roads: road.outcome.roads,
      failed: failed.outcome.status, retried: retried.usedRequest, unsupported: unsupported.outcome.status, disabledRequest: unsupported.usedRequest };
  });
  expect(summary).toEqual({ used: [true, false], cached: false, emptyExpires: true, roads: { "a->home": { distance_km: 2, duration_minutes: 1 }, "home->a": { distance_km: 3, duration_minutes: 2 } },
    failed: "failed", retried: true, unsupported: "unsupported", disabledRequest: false });
  expect({ transitCalls, flightCalls, roadCalls }).toEqual({ transitCalls: 1, flightCalls: 2, roadCalls: 1 });
});

test("full native Planner searches and applies Missing info while a provider response is in flight", async ({ page }) => {
  const forbidden: string[] = [], errors: string[] = [];
  let requests = 0, release!: () => void, entered!: () => void;
  const inFlight = new Promise<void>(resolve => { entered = resolve; }), hold = new Promise<void>(resolve => { release = resolve; });
  page.on("request", request => { if (/\/api\/v2|\/api\/data|jsdelivr/.test(request.url())) forbidden.push(request.url()); });
  page.on("pageerror", error => errors.push(error.message));
  await page.route("**/browser-data/config.json", route => route.fulfill({ json: { schema_version: 1, flights_url: "/api/flights", osrm_base_url: "https://example.test", transit_url: "/api/transit", transit_enabled: true } }));
  await page.route("**/api/transit?*", async route => {
    if (++requests === 5) { entered(); await hold; }
    const params = new URL(route.request().url()).searchParams, day = params.get("time")!.slice(0, 10), outbound = params.get("fromPlace") === "3.0,101.0";
    const start = `${day}T${outbound ? "09:30:00" : "16:00:00"}+00:00`, end = `${day}T${outbound ? "10:30:00" : "17:00:00"}+00:00`;
    await route.fulfill({ json: { itineraries: [{ startTime: start, endTime: end, legs: [{ mode: "BUS", startTime: start, endTime: end,
      from: { name: outbound ? "home" : "a" }, to: { name: outbound ? "a" : "home" }, agencyName: "Fixture", displayName: "1", source: "fixture.gtfs.zip" }] }] } });
  });
  await page.route("**/native-ui-search-setup", route => route.fulfill({ contentType: "text/html", body: "<!doctype html>" }));
  await page.goto("/native-ui-search-setup");
  const id = await page.evaluate(async () => {
    const { PlannerRepository } = await import("/src/native/repository.ts");
    const corpus = await (await fetch("/tests/fixtures/search.json")).json(), repository = new PlannerRepository();
    const trip = structuredClone(corpus.cases[0].initial); trip.spec.visits[0].place.latitude = 4; trip.spec.visits[0].place.longitude = 102;
    await repository.put("trips", trip.id, trip); await repository.close(); localStorage.setItem("wayfinder:last-trip", trip.id); return trip.id;
  });
  await page.goto("/");
  await page.getByRole("button", { name: "Search transport", exact: true }).last().click();
  await inFlight;
  await page.getByRole("tab", { name: /Missing info/ }).click();
  const price = page.locator("#panel-missing [data-price-input]").first();
  await expect(price).toBeVisible(); await price.fill("1"); await price.press("Enter");
  await expect(page.getByRole("region", { name: "Changes not applied" })).toBeVisible();
  await page.getByRole("button", { name: "Apply and continue", exact: true }).click();
  release();
  await expect(page.getByRole("region", { name: "Changes not applied" })).toHaveCount(0);
  await expect.poll(() => page.evaluate(async tripId => {
    const { PlannerRepository } = await import("/src/native/repository.ts"), repository = new PlannerRepository();
    try {
      const trip = await repository.requireTrip(tripId), job = await repository.get("jobs", trip.latest_job_id!) as { status: string; requests: number; batch_requests: number };
      return { status: job.status, requests: job.requests, batch: job.batch_requests, revision: trip.revision, resultRevision: trip.result?.trip_revision,
        hasPrice: [...trip.offers, ...(trip.journey_pricing_rules ?? [])].some(o => o.low === 1), movements: trip.snapshot?.movements.length };
    } finally { await repository.close(); }
  }, id)).toMatchObject({ status: "complete", requests: 6, batch: 6, revision: 2, resultRevision: 2, hasPrice: true, movements: 6 });
  expect(requests).toBe(6); expect(forbidden).toEqual([]); expect(errors).toEqual([]);
  await page.reload(); await expect(page.getByLabel("Trip name")).toHaveValue("My trip"); expect(requests).toBe(6);
});

test("native Planner reloads a paused queue and continues only its remaining requests", async ({ page }) => {
  let requests = 0;
  await page.route("**/native-resume-setup", route => route.fulfill({ contentType: "text/html", body: "<!doctype html>" }));
  await page.route("**/browser-data/config.json", route => route.fulfill({ json: { schema_version: 1, flights_url: "/api/flights", osrm_base_url: "https://example.test", transit_url: "/api/transit", transit_enabled: true } }));
  await page.route("**/api/transit?*", route => { requests++; return route.fulfill({ json: { itineraries: [] } }); });
  await page.goto("/native-resume-setup");
  const id = await page.evaluate(async () => {
    const { PlannerRepository } = await import("/src/native/repository.ts"), corpus = await (await fetch("/tests/fixtures/search.json")).json();
    const item = corpus.cases.find((c: { name: string }) => c.name === "budget-resume"), step = item.steps[0], repository = new PlannerRepository();
    const trip = { ...item.initial, ...step.trip, latest_job_id: "imported-paused-queue" };
    // The fixture record predates the messages field; native search records always have it.
    const job = { messages: [], ...step.public, id: trip.latest_job_id, trip_id: trip.id, discovery_key: step.snapshot.discovery_key, queue: step.queue,
      cursor: step.public.processed, snapshot: step.snapshot, bundle_links: step.bundle_links, transit_configured: true, created: corpus.now / 1000 };
    await repository.put("trips", trip.id, trip); await repository.put("jobs", job.id, job); await repository.close();
    localStorage.setItem("wayfinder:last-trip", trip.id); return trip.id;
  });
  await page.goto("/");
  await expect(page.getByRole("button", { name: "Search more", exact: true })).toBeVisible();
  expect(requests).toBe(0);
  await page.reload();
  await page.getByRole("button", { name: "Search more", exact: true }).click();
  await expect.poll(() => page.evaluate(async tripId => {
    const { PlannerRepository } = await import("/src/native/repository.ts"), repository = new PlannerRepository();
    try { const trip = await repository.requireTrip(tripId), job = await repository.get("jobs", trip.latest_job_id!) as { status: string; cursor: number; requests: number }; return { status: job.status, cursor: job.cursor, requests: job.requests }; }
    finally { await repository.close(); }
  }, id)).toEqual({ status: "complete", cursor: 6, requests: 6 });
  expect(requests).toBe(4);
});
