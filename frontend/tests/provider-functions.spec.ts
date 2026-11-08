import { expect, test } from "@playwright/test";

test("Transitous defaults to direct browser HTTP with an origin referrer and repository contact", async ({ page }) => {
  const calls: { url: string; referer?: string }[] = [], proxied: string[] = [];
  page.on("request", request => { if (new URL(request.url()).pathname === "/api/transit") proxied.push(request.url()); });
  await page.route("https://api.transitous.org/api/v6/plan?*", async route => {
    calls.push({ url: route.request().url(), referer: (await route.request().allHeaders()).referer });
    return route.fulfill({ json: { itineraries: [] }, headers: { "Access-Control-Allow-Origin": "*" } });
  });
  await page.goto("/native.html");
  await expect(page.getByRole("link", { name: "Contact", exact: true })).toHaveAttribute("href", "https://github.com/xinghao2003/travel-optimizer");
  const result = await page.evaluate(async () => {
    const { BrowserProviders, providerPlan } = await import("/src/prototype/native/providers.ts"), { PlannerRepository } = await import("/src/prototype/native/repository.ts");
    const { loadAirportCatalog } = await import("/src/prototype/native/catalog.ts");
    const corpus = await (await fetch("/tests/fixtures/native-preparation.json")).json(), spec = corpus.cases[5].trip.spec;
    const repository = new PlannerRepository("direct-transit-" + crypto.randomUUID()), providers = new BrowserProviders(repository, loadAirportCatalog);
    const task = { kind: "transit" as const, key: "direct-test", from_id: spec.home.id, to_id: spec.visits[0].place.id, date: spec.start_date };
    const snapshot = { revision: 0, movements: [], offers: [], coverage: {} }, settings = await providers.settings();
    const first = await providers.fetch(task, spec, snapshot), cached = await providers.fetch(task, spec, snapshot);
    const disabled = await new BrowserProviders(repository, loadAirportCatalog, async () => ({ ...settings, transit_enabled: false })).fetch(task, spec, snapshot);
    const proxy = providerPlan(task, spec, await loadAirportCatalog(), { ...settings, transit_url: "/api/transit" });
    await repository.close();
    return { enabled: settings.transit_enabled, url: settings.transit_url, contact: settings.contact_url,
      first: { status: first.outcome.status, request: first.usedRequest }, cached: cached.usedRequest,
      disabled: { status: disabled.outcome.status, request: disabled.usedRequest }, optionalProxy: proxy.url.startsWith("/api/transit?") };
  });
  expect(result).toEqual({ enabled: true, url: "https://api.transitous.org/api/v6/plan", contact: "https://github.com/xinghao2003/travel-optimizer",
    first: { status: "empty", request: true }, cached: false, disabled: { status: "unsupported", request: false }, optionalProxy: true });
  expect(calls).toHaveLength(1); expect(calls[0].referer).toBe(new URL(page.url()).origin + "/");
  expect(proxied).toEqual([]);
});

test("bounded round-trip choices persist across reload, Stop, and Continue with whole-party prices", async ({ page }) => {
  let calls = 0, release!: () => void, entered!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; }), active = new Promise<void>(resolve => { entered = resolve; });
  const selections = [[["KUL", "2027-02-10", "ICN", "MH", "123"]], [["KUL", "2027-02-10", "ICN", "MH", "456"]]];
  const segment = (back: boolean, service: string) => ({ mode: "flight", from_id: back ? "ICN" : "KUL", to_id: back ? "KUL" : "ICN", from_name: back ? "ICN" : "KUL", to_name: back ? "KUL" : "ICN",
    departure: back ? "2027-02-12T10:00:00Z" : "2027-02-10T10:00:00Z", arrival: back ? "2027-02-12T16:00:00Z" : "2027-02-10T12:00:00Z", operator: "Fixture", service, source: "Google Flights / fast-flights" });
  await page.route("**/bounded-flight-test", route => route.fulfill({ contentType: "text/html", body: "<!doctype html>" }));
  await page.route("**/api/flights", async route => {
    calls++;
    const request = route.request().postDataJSON();
    if (request.operation === "return") {
      const number = request.selection[0][4];
      if (number === "456") { entered(); await waiting; }
      await route.fulfill({ json: { protocol_version: 2, status: "success", kind: "round-trip", search_url: "https://www.google.com/travel/flights",
        options: [{ price: number === "123" ? 60 : 40, journeys: [[segment(false, number)], [segment(true, "back")]] }] } });
    } else await route.fulfill({ json: { protocol_version: 2, status: "success", kind: "round-trip", search_url: "https://www.google.com/travel/flights", flight_choices: selections,
      options: selections.map(selection => ({ price: null, journeys: [[segment(false, selection[0][4])]] })) } });
  });
  await page.goto("/bounded-flight-test");
  const first = await page.evaluate(async () => {
    const { PlannerRepository } = await import("/src/prototype/native/repository.ts"), { BrowserCalculator } = await import("/src/prototype/native/calculation.ts");
    const { BrowserDiscovery } = await import("/src/prototype/native/search.ts"), { BrowserProviders } = await import("/src/prototype/native/providers.ts");
    const { makeLeg } = await import("/src/prototype/native/discovery.ts"), { discoveryKey } = await import("/src/prototype/native/discovery-key.ts");
    const { stableId } = await import("/src/prototype/native/time.ts");
    const corpus = await (await fetch("/tests/fixtures/native-search.json")).json(), trip = structuredClone(corpus.cases.find((c: { name: string }) => c.name === "bundles-from-complete-histories").initial);
    trip.snapshot = null; trip.offers = []; trip.airport_transfer_estimates = []; trip.journey_pricing_rules = [];
    trip.spec.modes = ["flight"]; trip.spec.adults = 2; trip.spec.exclude_unpriced_flights = true; trip.spec.departure_start = "00:00:00"; trip.spec.departure_end = "23:59:00";
    const legs = [makeLeg(trip.spec.home, trip.spec.visits[0].place, "2027-02-10", corpus.catalog.metros), makeLeg(trip.spec.visits[0].place, trip.spec.home, "2027-02-12", corpus.catalog.metros)];
    const repository = new PlannerRepository("bounded-returns"); await repository.put("trips", trip.id, trip);
    const key = discoveryKey(trip.spec), jobId = "bounded-flight-job";
    await repository.put("jobs", jobId, { id: jobId, trip_id: trip.id, status: "paused", discovery_key: key, queue: [{ kind: "bundle", ticket_kind: "round-trip", key: stableId("round-trip", legs), legs }], cursor: 0,
      snapshot: { revision: 0, movements: [], offers: [], roads: {}, coverage: {}, discovery_key: key }, requests: 0, cache_hits: 0, outcomes: {}, messages: [], bundle_links: [], batch_budget: 1, batch_requests: 0,
      manual_quote_queries: 0, transit_configured: false });
    const settings = async () => ({ schema_version: 1 as const, flights_url: "/api/flights", osrm_base_url: "https://example.test", transit_url: "/api/transit", transit_enabled: false });
    const provider = new BrowserProviders(repository, async () => corpus.catalog, settings), discovery = new BrowserDiscovery(repository, new BrowserCalculator(repository), provider, async () => corpus.catalog);
    await discovery.start(trip.id, 1, jobId); await discovery.wait(jobId);
    const status = await discovery.status(jobId), saved = await repository.requireTrip(trip.id), raw = await repository.get("jobs", jobId) as { queue: { round_trip_selection?: string[][] }[] };
    await repository.close();
    localStorage.setItem("bounded-trip", trip.id);
    return { requests: status.requests, processed: status.processed, pending: status.pending, offers: saved.snapshot!.offers.length,
      choices: raw.queue.slice(1).map(t => t.round_trip_selection) };
  });
  expect(first).toEqual({ requests: 1, processed: 1, pending: 2, offers: 0, choices: selections });
  await page.reload();
  const second = await page.evaluate(async () => {
    const { PlannerRepository } = await import("/src/prototype/native/repository.ts"), { BrowserCalculator } = await import("/src/prototype/native/calculation.ts");
    const { BrowserDiscovery } = await import("/src/prototype/native/search.ts"), { BrowserProviders } = await import("/src/prototype/native/providers.ts");
    const corpus = await (await fetch("/tests/fixtures/native-search.json")).json(), repository = new PlannerRepository("bounded-returns"), tripId = localStorage.getItem("bounded-trip")!;
    const settings = async () => ({ schema_version: 1 as const, flights_url: "/api/flights", osrm_base_url: "https://example.test", transit_url: "/api/transit", transit_enabled: false });
    const discovery = new BrowserDiscovery(repository, new BrowserCalculator(repository), new BrowserProviders(repository, async () => corpus.catalog, settings), async () => corpus.catalog);
    await discovery.start(tripId, 1, "bounded-flight-job"); await discovery.wait("bounded-flight-job");
    const status = await discovery.status("bounded-flight-job"), trip = await repository.requireTrip(tripId);
    Object.assign(window, { boundedDiscovery: discovery, boundedRepository: repository });
    return { requests: status.requests, processed: status.processed, pending: status.pending, ticket: trip.snapshot!.offers.find(o => o.kind === "round-trip")?.low, adults: trip.snapshot!.offers[0]?.adults };
  });
  expect(second).toEqual({ requests: 2, processed: 2, pending: 1, ticket: 60, adults: 2 });
  const finishing = page.evaluate(async () => {
    const { boundedDiscovery: discovery } = window as unknown as { boundedDiscovery: { start(id: string, budget: number, job: string): Promise<unknown>; wait(id: string): Promise<void> } };
    await discovery.start(localStorage.getItem("bounded-trip")!, 1, "bounded-flight-job"); await discovery.wait("bounded-flight-job");
  });
  await active;
  await page.evaluate(async () => { await (window as unknown as { boundedDiscovery: { cancel(id: string): Promise<unknown> } }).boundedDiscovery.cancel("bounded-flight-job"); });
  release(); await finishing;
  const last = await page.evaluate(async () => {
    const { boundedDiscovery: discovery, boundedRepository: repository } = window as unknown as { boundedDiscovery: import("../src/prototype/native/search").BrowserDiscovery; boundedRepository: import("../src/prototype/native/repository").PlannerRepository };
    const cancelled = await discovery.status("bounded-flight-job"), before = await repository.requireTrip(localStorage.getItem("bounded-trip")!);
    await discovery.start(before.id, 1, "bounded-flight-job"); await discovery.wait("bounded-flight-job");
    const status = await discovery.status("bounded-flight-job"), after = await repository.requireTrip(before.id);
    await repository.close();
    return { cancelled: cancelled.status, keptBoth: before.snapshot!.offers.length === 2, requests: status.requests, processed: status.processed, pending: status.pending, status: status.status,
      best: Math.min(...after.result!.routes.flatMap(r => r.purchases.filter(o => o.kind === "round-trip").map(o => o.low!))) };
  });
  expect(last).toEqual({ cancelled: "cancelled", keptBoth: true, requests: 3, processed: 3, pending: 0, status: "complete", best: 40 });
  expect(calls).toBe(3);
});
