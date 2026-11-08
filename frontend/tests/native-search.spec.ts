import { expect, test } from "@playwright/test";

test("native flight links and discovery rounds match independent Python lifecycle references", async ({ page }) => {
  await page.route("**/native-search-test", route => route.fulfill({ contentType: "text/html", body: "<!doctype html>" }));
  await page.goto("/native-search-test");
  const summary = await page.evaluate(async () => {
    const { PlannerRepository } = await import("/src/prototype/native/repository.ts"), { BrowserCalculator } = await import("/src/prototype/native/calculation.ts");
    const { BrowserDiscovery } = await import("/src/prototype/native/search.ts"), state = await import("/src/prototype/native/search-state.ts");
    const { applyMissingInfo, parseApplyChanges } = await import("/src/prototype/native/edits.ts");
    const { firstDifference } = await import("/src/prototype/comparison.ts");
    const corpus = await (await fetch("/tests/fixtures/native-search.json")).json();
    const failures: unknown[] = [], fields = ["status", "processed", "pending", "requests", "cache_hits", "manual_quote_queries", "failed_queries", "batch_budget", "batch_requests", "outcomes", "pause_reason", "optimization_pending", "phase", "updating_options"];
    for (const item of corpus.urls) {
      const actual = state.flightSearchUrl(item.legs, item.spec, item.kind);
      if (actual !== item.expected) failures.push({ name: "flight-url", kind: item.kind, actual, expected: item.expected });
    }
    for (const item of corpus.cases) {
      const repository = new PlannerRepository("native-search-" + crypto.randomUUID()), calculator = new BrowserCalculator(repository);
      await repository.put("trips", item.initial.id, item.initial);
      for (const [key, graph] of Object.entries(item.graphs ?? {})) await repository.put("graphs", key, graph);
      for (const rule of item.rules) await repository.put("rules", rule.id, rule);
      let requestIndex = 0, elapsed = performance.now(), enabled = item.commands[0].enabled;
      let entered!: () => void, release!: () => void;
      const waiting = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
      const gated = item.commands.some((command: { operation: string }) => command.operation.endsWith("inflight"));
      const provider = {
        settings: async () => ({ schema_version: 1 as const, flights_url: "/api/flights", osrm_base_url: "https://example.test", transit_url: "/api/transit", transit_enabled: enabled }),
        fetch: async (task: unknown) => {
          const index = requestIndex++, expected = item.requests[index];
          if (gated && index === 0) { entered(); await gate; }
          if (!expected) { failures.push({ name: item.name, unexpectedRequest: task }); return { outcome: { status: "empty" }, usedRequest: true }; }
          const difference = firstDifference(expected.task, task);
          if (difference) failures.push({ name: item.name, request: index, ...difference });
          if (item.time_pause_after === index + 1) elapsed += 61000;
          return structuredClone({ outcome: expected.outcome, usedRequest: expected.usedRequest });
        },
      };
      const discovery = new BrowserDiscovery(repository, calculator, provider, async () => corpus.catalog, { clock: { monotonic: () => elapsed, wall: () => corpus.now } });
      const command = item.commands[0], job = await discovery.start(item.initial.id, command.budget, undefined, command.minutes);
      let step = 0;
      const capture = async () => {
        await discovery.wait(job.id);
        const raw = await repository.get("jobs", job.id) as typeof item.steps[0] & { queue: unknown[]; snapshot: unknown; bundle_links: unknown[] };
        const current = await discovery.status(job.id), trip = await repository.requireTrip(item.initial.id);
        const actual = { public: Object.fromEntries(fields.filter(k => Object.hasOwn(current, k)).map(k => [k, current[k as keyof typeof current]])), queue: raw.queue, snapshot: raw.snapshot,
          trip: Object.fromEntries(["revision", "spec", "offers", "snapshot", "result"].filter(k => Object.hasOwn(trip, k)).map(k => [k, trip[k as keyof typeof trip]])), bundle_links: raw.bundle_links };
        const difference = firstDifference(item.steps[step], actual);
        if (difference) failures.push({ name: item.name, step, ...difference });
        step++;
      };
      if (gated) {
        await waiting;
        const next = item.commands[1];
        if (next.operation === "cancel_inflight") {
          await discovery.cancel(job.id);
          let blocked;
          try { await discovery.start(item.initial.id, 1, job.id); } catch (error) { blocked = (error as { status: number }).status; }
          if (blocked !== 409) failures.push({ name: item.name, inFlightContinueStatus: blocked ?? "accepted" });
          release();
        }
        else {
          if (next.expire) elapsed += 61000;
          const applying = discovery.applyChanges(item.initial.id, trip => applyMissingInfo(trip, parseApplyChanges(next.request), corpus.catalog));
          // change() is serialized; let it mark the active request before releasing it.
          await new Promise(resolve => setTimeout(resolve, 0));
          release();
          let status;
          try { await applying; } catch (error) { status = (error as { status: number }).status; }
          if (next.valid ? status !== undefined : status !== 409) failures.push({ name: item.name, applyStatus: status ?? "accepted" });
        }
      }
      await capture();
      for (const next of item.commands.filter((c: { operation: string }) => c.operation === "continue")) {
        enabled = next.enabled; await discovery.start(item.initial.id, next.budget, job.id); await capture();
      }
      if (requestIndex !== item.requests.length) failures.push({ name: item.name, requests: requestIndex, expected: item.requests.length });
      await repository.close();
    }
    return { scenarios: corpus.cases.length, urls: corpus.urls.length, failures: failures.slice(0, 30) };
  });
  console.log(JSON.stringify(summary, null, 2));
  expect(summary.scenarios).toBe(13); expect(summary.urls).toBe(54); expect(summary.failures).toEqual([]);
});

test("deleting an assumed connection during search does not restore it from the active graph", async ({ page }) => {
  await page.route("**/native-delete-assumption-test", route => route.fulfill({ contentType: "text/html", body: "<!doctype html>" }));
  await page.goto("/native-delete-assumption-test");
  const summary = await page.evaluate(async () => {
    const { PlannerRepository } = await import("/src/prototype/native/repository.ts"), { BrowserCalculator } = await import("/src/prototype/native/calculation.ts");
    const { BrowserDiscovery } = await import("/src/prototype/native/search.ts"), { removeAssumedMovement } = await import("/src/prototype/native/edits.ts");
    const corpus = await (await fetch("/tests/fixtures/native-search.json")).json(), item = corpus.cases.find((c: { name: string }) => c.name === "reuse-shared-assumptions");
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
  page.on("request", request => { if (/\/api\/v2|\/api\/data|pyodide|jsdelivr/.test(request.url())) forbidden.push(request.url()); });
  await page.route("**/browser-data/config.json", route => route.fulfill({ json: { schema_version: 1, flights_url: "/api/flights", osrm_base_url: "https://osrm.example.test", transit_url: "/api/transit", transit_enabled: false } }));
  await page.route("https://osrm.example.test/**", route => {
    const count = new URL(route.request().url()).pathname.split("/").pop()!.split(";").length;
    return route.fulfill({ json: { code: "Ok", distances: Array.from({ length: count }, (_, i) => Array.from({ length: count }, (_, j) => i === j ? 0 : 10000)),
      durations: Array.from({ length: count }, (_, i) => Array.from({ length: count }, (_, j) => i === j ? 0 : 1200)) } });
  });
  await page.route("**/native-flight-search-setup", route => route.fulfill({ contentType: "text/html", body: "<!doctype html>" }));
  await page.goto("/native-flight-search-setup");
  const seed = await page.evaluate(async () => {
    const { PlannerRepository } = await import("/src/prototype/native/repository.ts");
    const corpus = await (await fetch("/tests/fixtures/native-search.json")).json(), source = corpus.cases.find((c: { name: string }) => c.name === "bundles-from-complete-histories").initial;
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
  await page.goto("/native.html");
  await page.getByRole("button", { name: "Search transport", exact: true }).last().click();
  await expect.poll(() => page.evaluate(async id => {
    const { PlannerRepository } = await import("/src/prototype/native/repository.ts"), repository = new PlannerRepository();
    try {
      const trip = await repository.requireTrip(id), job = await repository.get("jobs", trip.latest_job_id!) as { status: string; requests: number } | undefined;
      return job?.status;
    } finally { await repository.close(); }
  }, seed.id)).toBe("complete");
  const saved = await page.evaluate(async id => {
    const { PlannerRepository } = await import("/src/prototype/native/repository.ts"), repository = new PlannerRepository();
    try { const trip = await repository.requireTrip(id); return { spec: trip.spec, graph: trip.snapshot, result: trip.result }; } finally { await repository.close(); }
  }, seed.id);
  const pricedReturn = saved.result?.routes.some(r => r.purchases.some(o => o.kind === "round-trip" && o.low === 50 && o.high === 50 && o.adults === 2));
  expect(pricedReturn, JSON.stringify({ thinRequests, pricedBundles, offers: saved.graph?.offers, messages: saved.graph?.coverage.messages,
    feasible: saved.result?.feasible_count, hidden: saved.result?.hidden_unpriced_flight_count })).toBe(true);
  await page.evaluate(async id => {
    const { PlannerRepository } = await import("/src/prototype/native/repository.ts"), repository = new PlannerRepository();
    try { const trip = await repository.requireTrip(id); delete trip.result!.flight_price_revision; trip.result!.routes = []; await repository.put("trips", id, trip); }
    finally { await repository.close(); }
  }, seed.id);
  const beforeReload = thinRequests; await page.reload();
  await expect.poll(() => page.evaluate(async id => {
    const { PlannerRepository } = await import("/src/prototype/native/repository.ts"), repository = new PlannerRepository();
    try { const result = (await repository.requireTrip(id)).result; return result?.flight_price_revision === 2 && result.routes.length > 0; }
    finally { await repository.close(); }
  }, seed.id)).toBe(true);
  expect(thinRequests).toBe(beforeReload);
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
    const { PlannerRepository } = await import("/src/prototype/native/repository.ts"), { BrowserProviders, providerPlan } = await import("/src/prototype/native/providers.ts");
    const corpus = await (await fetch("/tests/fixtures/native-search.json")).json(), repository = new PlannerRepository("native-provider-http-" + crypto.randomUUID());
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
  page.on("request", request => { if (/\/api\/v2|\/api\/data|pyodide|jsdelivr/.test(request.url())) forbidden.push(request.url()); });
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
    const { PlannerRepository } = await import("/src/prototype/native/repository.ts");
    const corpus = await (await fetch("/tests/fixtures/native-search.json")).json(), repository = new PlannerRepository();
    const trip = structuredClone(corpus.cases[0].initial); trip.spec.visits[0].place.latitude = 4; trip.spec.visits[0].place.longitude = 102;
    await repository.put("trips", trip.id, trip); await repository.close(); localStorage.setItem("wayfinder:last-trip", trip.id); return trip.id;
  });
  await page.goto("/native.html");
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
    const { PlannerRepository } = await import("/src/prototype/native/repository.ts"), repository = new PlannerRepository();
    try {
      const trip = await repository.requireTrip(tripId), job = await repository.get("jobs", trip.latest_job_id!) as { status: string; requests: number; batch_requests: number };
      return { status: job.status, requests: job.requests, batch: job.batch_requests, revision: trip.revision, resultRevision: trip.result?.trip_revision,
        hasPrice: [...trip.offers, ...(trip.journey_pricing_rules ?? [])].some(o => o.low === 1), movements: trip.snapshot?.movements.length };
    } finally { await repository.close(); }
  }, id)).toMatchObject({ status: "complete", requests: 6, batch: 6, revision: 2, resultRevision: 2, hasPrice: true, movements: 6 });
  expect(requests).toBe(6); expect(forbidden).toEqual([]); expect(errors).toEqual([]);
  await page.reload(); await expect(page.getByLabel("Trip name")).toHaveValue("My trip"); expect(requests).toBe(6);
});

test("native Planner reloads a paused Python queue and continues only its remaining requests", async ({ page }) => {
  let requests = 0;
  await page.route("**/native-resume-setup", route => route.fulfill({ contentType: "text/html", body: "<!doctype html>" }));
  await page.route("**/browser-data/config.json", route => route.fulfill({ json: { schema_version: 1, flights_url: "/api/flights", osrm_base_url: "https://example.test", transit_url: "/api/transit", transit_enabled: true } }));
  await page.route("**/api/transit?*", route => { requests++; return route.fulfill({ json: { itineraries: [] } }); });
  await page.goto("/native-resume-setup");
  const id = await page.evaluate(async () => {
    const { PlannerRepository } = await import("/src/prototype/native/repository.ts"), corpus = await (await fetch("/tests/fixtures/native-search.json")).json();
    const item = corpus.cases.find((c: { name: string }) => c.name === "budget-resume"), step = item.steps[0], repository = new PlannerRepository();
    const trip = { ...item.initial, ...step.trip, latest_job_id: "imported-paused-queue" };
    const job = { ...step.public, id: trip.latest_job_id, trip_id: trip.id, discovery_key: step.snapshot.discovery_key, queue: step.queue,
      cursor: step.public.processed, snapshot: step.snapshot, bundle_links: step.bundle_links, transit_configured: true, created: corpus.now / 1000 };
    await repository.put("trips", trip.id, trip); await repository.put("jobs", job.id, job); await repository.close();
    localStorage.setItem("wayfinder:last-trip", trip.id); return trip.id;
  });
  await page.goto("/native.html");
  await expect(page.getByRole("button", { name: "Search more", exact: true })).toBeVisible();
  expect(requests).toBe(0);
  await page.reload();
  await page.getByRole("button", { name: "Search more", exact: true }).click();
  await expect.poll(() => page.evaluate(async tripId => {
    const { PlannerRepository } = await import("/src/prototype/native/repository.ts"), repository = new PlannerRepository();
    try { const trip = await repository.requireTrip(tripId), job = await repository.get("jobs", trip.latest_job_id!) as { status: string; cursor: number; requests: number }; return { status: job.status, cursor: job.cursor, requests: job.requests }; }
    finally { await repository.close(); }
  }, id)).toEqual({ status: "complete", cursor: 6, requests: 6 });
  expect(requests).toBe(4);
});
