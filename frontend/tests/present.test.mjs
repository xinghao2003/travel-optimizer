import assert from "node:assert/strict";
import { test } from "node:test";
import { loadTs } from "./loadTs.mjs";
const {
  airportChangeRows, appError, assumedConnections, assumptionNotes, blankConnectionForm, blankRuleForm, buildNextSteps, bundleStatusLabel, cityGaps, connectionFromForm, connectionText, compareText, dateModeText, dateRange, dayByDay, formatDuration,
  componentWhen, formatLocal, hoursText, journeyGroupTitle, journeyGroupWhen, journeyChips, journeySource, journeyWhen, mainService, matchingQuoteLinks, modeLabel, moneyShort, needsInputCount, optionChips, optionsEmptyState, partySizeNotice, perCityHourText, priceEstimated, priceText, routeChain, routeSignature,
  priceInputErrors, purchaseAmount, quoteLinkText, searchDetails, searchState, settingsFooter, settingsSummaries, sortRoutes, sourceLabel, splitGroups, stepLabel, staySumWarning, ticketJourney, ticketRows,
  ruleForm, ruleFromForm, ruleText, transferDirections, transferJourneyText, tripSummary, unpricedSummary, unresolvedAccessJourneys, validateDraft,
} = await loadTs("../src/lib/present.ts");
const { blankTrip } = await loadTs("../src/lib/planner.ts");

test("continuous checking swaps its action for Stop and lets old size pauses resume", () => {
  const props = { invalid: false, dirty: false, saved: { snapshot: {} }, result: { optimization_complete: false }, job: null };
  const optimization = { status: 'running', expanded_labels: 250000 };
  const running = searchState({ ...props, optimization });
  assert.equal(running.id, 'checking');
  assert.equal(running.actions[0].label, 'Stop checking');
  assert.equal(running.actions[0].run, 'stop-optimization');
  assert.equal(running.secondary, null);
  // Stop remains available even while the user types an invalid settings value.
  assert.equal(searchState({ ...props, invalid: true, optimization }).actions[0].run, 'stop-optimization');
  const stopping = searchState({ ...props, optimization: { ...optimization, status: 'stopping' } });
  assert.equal(stopping.actions[0].disabled, true);
  assert.match(stopping.text, /saving/);
  const paused = searchState({ ...props, optimization: { ...optimization, status: 'paused', pause_reason: 'checkpoint' } });
  assert.match(paused.text, /previous checkpoint-size limit.*Continue to resume without that limit/);
  assert.equal(paused.secondary.action.label, 'Check more combinations');
  assert.equal(searchState({ ...props, optimization: { ...optimization, status: 'cancelled' } }).secondary.action.run, 'optimize');
});

test("empty options explain completed itineraries hidden by flight-price eligibility", () => {
  const state = optionsEmptyState({ searched: true, active: false, pending: 0, hasResult: true, best: 0,
    refinement: [], budget: null, staySum: null, gaps: [], excludeUnpricedFlights: true, steps: [], placeName: id => id, hiddenUnpricedFlights: 74652 });
  assert.equal(state.id, 'unpriced-flights');
  assert.match(state.title, /Itineraries found/);
  assert.match(state.lines[0].text, /74,652.*hidden/);
  assert.equal(state.lines[0].action.target, 'show-unpriced-flights');
  assert.match(state.lines[1].text, /round-trip.*both matching flights/);
  const details = searchDetails({ saved: { snapshot: {} }, job: null, result: {
    snapshot_revision: 1, feasible_count: 10, expanded_labels: 30, coverage: {}, excluded_unpriced_flight_count: 3,
  } });
  assert.ok(details.lines.some(line => /Skipped 3 flight choices.*standalone or combined-ticket price/.test(line)));
});

test("an incomplete calculation does not claim that no itinerary fits", () => {
  const props = { searched: true, active: false, pending: 0, hasResult: true, best: 0, refinement: [],
    budget: null, staySum: null, gaps: [], excludeUnpricedFlights: false, steps: [], placeName: id => id, calculationPending: true };
  assert.match(optionsEmptyState(props).lines[0].text, /More combinations remain/);
  assert.match(optionsEmptyState({ ...props, checking: true }).lines[0].text, /Checking saved combinations/);
});

test("minimum stays must be explicitly positive for every city", () => {
  for (const value of [0, -1, NaN, Infinity, 8761]) {
    assert.match(validateDraft({ ...blankTrip(), visits: [{ place: { id: "city" }, min_stay_hours: value }] }).stays, /minimum stay/);
  }
  assert.equal(validateDraft({ ...blankTrip(), visits: [{ place: { id: "city" }, min_stay_hours: .5 }] }).stays, undefined);
});

test("calculation safety pause explains partial results and offers continuation", () => {
  const state = searchState({ invalid: false, dirty: false, saved: { snapshot: {} },
    result: { optimization_complete: false }, job: { status: "paused", pause_reason: "calculation", optimization_pending: true, pending: 0, time_budget_seconds: 600 } });
  assert.match(state.text, /safety limit.*Partial options/);
  assert.equal(state.actions[0].run, "continue");
  assert.equal(state.secondary, null);
});

test("timed rounds show time, pending optimizer continuation and the selected next allowance", () => {
  const job = { id: "j", trip_id: "t", status: "paused", processed: 10, pending: 0, failed_queries: 0,
    requests: 10, cache_hits: 0, messages: [], bundle_links: [], batch_budget: 1, batch_requests: 10,
    time_budget_seconds: 600, round_elapsed_seconds: 612, optimization_pending: true, phase: "optimization" };
  const saved = { snapshot: { coverage: {} } };
  const result = { discovery_required: false, optimization_complete: false, coverage: {} };
  const options = { invalid: false, dirty: false, saved, result, job };
  const paused = searchState(options);
  assert.equal(paused.actions[0].label, "Continue for 10 minutes");
  assert.equal(paused.actions[0].run, "continue");
  assert.equal(paused.secondary, null);
  assert.match(paused.text, /last calculated options/);
  assert.equal(searchState({ ...options, minutes: 5 }).actions[0].label, "Continue for 5 minutes");
  assert.equal(searchState({ ...options, minutes: null }).actions[0].label, "Search more");
  const running = searchState({ ...options, job: { ...job, status: "running", round_elapsed_seconds: 120 } });
  assert.match(running.text, /Optimizing collected schedules · 8 minutes remaining/);
  const finishing = searchState({ ...options, job: { ...job, status: "running" } });
  assert.match(finishing.text, /finishing the current operation/);
  const interrupted = searchState({ ...options, job: { ...job, status: "interrupted" } });
  assert.equal(interrupted.actions[0].run, "continue");
  const details = searchDetails({ saved, job, result: null });
  assert.ok(details.lines.includes("This round: 10 min 12 s elapsed · 10 min allowance"));
  assert.ok(!details.lines.some(line => line.startsWith("This batch:")));
  assert.equal(settingsSummaries(blankTrip(), 1, 10).searchSize.summary, "10 minutes per round");
});

test("Apply status distinguishes saved edits, updating old options and an expired round", () => {
  const job = { id: "j", trip_id: "t", status: "running", processed: 10, pending: 5, failed_queries: 0,
    requests: 10, cache_hits: 0, messages: [], bundle_links: [], time_budget_seconds: 600, updating_options: true };
  const props = { invalid: false, dirty: false, saved: { snapshot: { coverage: {} } }, job,
    result: { discovery_required: false, optimization_complete: true, coverage: {} } };
  const applying = searchState({ ...props, applying: true });
  assert.equal(applying.id, "applying");
  assert.match(applying.text, /current operation/);
  const updating = searchState(props);
  assert.equal(updating.id, "updating-options");
  assert.match(updating.text, /Previous options/);
  assert.equal(updating.actions[0].run, "stop");
  const expired = searchState({ ...props, job: { ...job, status: "paused", pending: 0 } });
  assert.match(expired.text, /Changes saved/);
  assert.equal(expired.actions[0].label, "Continue for 10 minutes");
  assert.equal(expired.secondary, null);
});

// One stored trip in its two response shapes. GET /trips/{id} empties snapshot.movements and
// adds the fields that read_trip computes; PUT /trips/{id} returns the movements and, of those
// fields, only airport_transfer_rows (not needed here).
const place = (id, name) => ({ id, name, latitude: 0, longitude: 0, timezone: "Asia/Seoul", country_code: "KR", airport_codes: [], flight_code: null });
const spec = { visits: [{ place: place("GMP", "Seoul"), min_stay_hours: 48 }, { place: place("PUS", "Busan"), min_stay_hours: 24 }, { place: place("HND", "Tokyo"), min_stay_hours: 48 }] };
const flightSegment = (from_id, to_id, from_name, to_name) => ({ mode: "flight", from_id, to_id, from_name, to_name });
const movement = (id, from_id, to_id, extra = {}) => ({ id, from_id, to_id, mode: "flight", source: "Google Flights / fast-flights", segments: [], charges: [], assumptions: [], ...extra });
const unresolvedAccess = "Kuala Lumpur: airport access time is unresolved; this movement is not usable until routing or a transfer assumption is provided";
const movements = [
  movement("f1", "KUL", "HND", {
    segments: [{ mode: "transfer", from_name: "Kuala Lumpur", to_name: "KUL" }, flightSegment("KUL", "GMP", "Kuala Lumpur International Airport", "Gimpo International Airport"), flightSegment("ICN", "HND", "Incheon International Airport", "Haneda Airport")],
    assumptions: ["Airport change GMP → ICN: add a verified connection before using this journey"], usable: false,
  }),
  movement("f2", "KUL", "HND", { segments: [flightSegment("KUL", "GMP", "Kuala Lumpur International Airport", "Gimpo International Airport"), flightSegment("ICN", "HND", "Incheon International Airport", "Haneda Airport")] }),
  movement("f3", "HND", "GMP", {
    segments: [flightSegment("HND", "HND", "Haneda Airport", "Haneda Airport"), flightSegment("NRT", "GMP", "Narita International Airport", "Gimpo International Airport")],
    assumptions: ["Airport connection HND → NRT needs 90 minutes but only 60 are available"], usable: false,
  }),
  movement("f4", "KUL", "PUS", { segments: [flightSegment("KUL", "PUS", "Kuala Lumpur International Airport", "Gimhae International Airport")], assumptions: [unresolvedAccess], usable: false }),
  movement("t1", "GMP", "PUS", { mode: "rail", source: "Transitous / MOTIS", segments: [{ mode: "rail", from_id: "a", to_id: "b", from_name: "Seoul", to_name: "Busan" }, { mode: "rail", from_id: "c", to_id: "d", from_name: "Busan", to_name: "Busan" }] }),
  movement("assumed:u1", "GMP", "PUS", { mode: "bus", source: "User-defined connection", assumptions: ["User supplied connectivity and timing"] }),
];
const airport_connections = [{ from_airport: "KIX", to_airport: "ITM", mode: "bus", duration_minutes: 80, fare_amount: null, currency: "MYR" }, { from_airport: "GMP", to_airport: "ICN", mode: "rail", duration_minutes: 70, fare_amount: 60, currency: "MYR" }];
const snapshot = { revision: 3, offers: [], coverage: {} };
const putShape = { id: "trip", revision: 5, spec, offers: [], airport_connections, snapshot: { ...snapshot, movements } };
const getShape = {
  ...putShape,
  snapshot: { ...snapshot, movements: [] },
  airport_connections_required: [
    { from_airport: "GMP", to_airport: "ICN", from_name: "Gimpo International Airport", to_name: "Incheon International Airport", journey_count: 2, unresolved_journey_count: 1 },
    { from_airport: "HND", to_airport: "NRT", from_name: "Haneda Airport", to_name: "Narita International Airport", journey_count: 1, unresolved_journey_count: 1 },
  ],
  assumed_connections: [movements[5]],
  city_connection_gaps: [{ from_id: "PUS", to_id: "HND" }],
};

test("airport change rows join required and saved pairs, the same for GET and PUT records", () => {
  const rows = airportChangeRows(getShape);
  assert.deepEqual(airportChangeRows(putShape), rows);
  assert.deepEqual(rows.map(row => [`${row.from_airport}>${row.to_airport}`, row.required, row.journey_count, row.unresolved_journey_count, row.mode]), [
    ["GMP>ICN", true, 2, 1, "rail"],
    ["HND>NRT", true, 1, 1, ""],
    ["KIX>ITM", false, 0, 0, "bus"],
  ]);
  assert.deepEqual(rows[0], { from_airport: "GMP", to_airport: "ICN", from_name: "Gimpo International Airport", to_name: "Incheon International Airport", journey_count: 2, unresolved_journey_count: 1, required: true, mode: "rail", duration_minutes: 70, fare_amount: 60, currency: "MYR" });
  assert.deepEqual(rows[2], { from_airport: "KIX", to_airport: "ITM", from_name: "KIX", to_name: "ITM", journey_count: 0, unresolved_journey_count: 0, required: false, mode: "bus", duration_minutes: 80, fare_amount: null, currency: "MYR" });
  assert.deepEqual(airportChangeRows({ snapshot: null }), []);
});

test("airport change requirements come from the result's coverage first", () => {
  // After a change of search inputs, the PUT record's snapshot can be a shared search graph in which
  // a saved airport change is still unresolved; the result calculated with the trip's changes is not.
  const coverage = { airport_connections_required: [{ from_airport: "GMP", to_airport: "ICN", from_name: "Gimpo International Airport", to_name: "Incheon International Airport", journey_count: 2, unresolved_journey_count: 0 }] };
  const rows = airportChangeRows(putShape, coverage);
  assert.deepEqual(rows.map(row => [`${row.from_airport}>${row.to_airport}`, row.required, row.journey_count, row.unresolved_journey_count]), [["GMP>ICN", true, 2, 0], ["KIX>ITM", false, 0, 0]]);
  assert.deepEqual(airportChangeRows(getShape, coverage), rows);
  // A result reused during a search has no requirements in its coverage.
  assert.deepEqual(airportChangeRows(putShape, {}), airportChangeRows(putShape));
  assert.deepEqual(airportChangeRows(getShape, {}), airportChangeRows(getShape));
});

test("only journeys with an unresolved airport access time count as unresolved access", () => {
  const coverage = [
    { id: "f0", from_id: "PUS", to_id: "KUL", assumptions: ["Busan: 45 minute airport transfer assumption; road routing unavailable", "Airport change GMP → ICN: add a verified connection before using this journey"] },
    { id: "f4", from_id: "KUL", to_id: "PUS", assumptions: [unresolvedAccess, "Kuala Lumpur: 0 minute airport transfer assumption; road routing unavailable"] },
  ];
  assert.deepEqual(unresolvedAccessJourneys(coverage).map(m => m.id), ["f4"]);
  assert.deepEqual(unresolvedAccessJourneys(putShape.snapshot.movements).map(m => m.id), ["f4"]);
  assert.deepEqual(unresolvedAccessJourneys([]), []);
});

test("connections the user added are the same for GET and PUT records", () => {
  assert.deepEqual(assumedConnections(putShape), getShape.assumed_connections);
  assert.deepEqual(assumedConnections(getShape), getShape.assumed_connections);
  assert.deepEqual(assumedConnections({ snapshot: null }), []);
});

test("city gaps are the same for GET and PUT records; a journey in either direction closes a gap", () => {
  assert.deepEqual(cityGaps(putShape), [{ from_id: "PUS", to_id: "HND" }]);
  assert.deepEqual(cityGaps(getShape), [{ from_id: "PUS", to_id: "HND" }]);
  const linked = { ...putShape, snapshot: { ...snapshot, movements: [...movements, movement("f5", "HND", "PUS")] } };
  assert.deepEqual(cityGaps(linked), []);
  assert.deepEqual(cityGaps({ spec, snapshot: null }), []);
  assert.deepEqual(cityGaps({ spec, snapshot: { ...snapshot, movements: [] } }), [{ from_id: "GMP", to_id: "PUS" }, { from_id: "GMP", to_id: "HND" }, { from_id: "PUS", to_id: "HND" }]);
});

test("mode labels", () => {
  assert.equal(modeLabel("rail"), "Train");
  assert.equal(modeLabel("taxi"), "Taxi");
  assert.equal(modeLabel("rental"), "Rental car");
  assert.equal(modeLabel("*"), "Any");
  assert.equal(modeLabel("walk"), "walk");
});

// Display, route, status, trip and refinement helpers. Fixtures follow the demo trip, cut down to what each rule reads.
// Intl writes a no-break space between a currency and its amount.
const plain = text => typeof text === "string" ? text.replace(/ /g, " ") : text;
const fare = (id, low, high = low, extra = {}) => ({ id: `fare:${id}`, movement_ids: [id], kind: "one-way", low, high, currency: "MYR", source: "provider", estimated: false, label: "Google Flights one-way", validated: true, ...extra });
const noFare = (id, label = "flight") => fare(id, null, null, { id: `unknown:${id}`, source: "unknown", label });
const charge = (id, kind, from_id, to_id) => ({ id, kind, mode: "taxi", distance_km: null, low: null, high: null, currency: "MYR", source: "unknown", from_id, to_id });
const flightTo = (id, from_id, to_id, extra = {}) => ({
  id, from_id, to_id, mode: "flight", departure: null, arrival: null, segments: [], assumptions: [], source: "Google Flights / fast-flights",
  charges: [charge(`${id}:access`, "Airport access", from_id, `airport:${from_id}`), charge(`${id}:egress`, "Airport egress", `airport:${to_id}`, to_id)], ...extra,
});
const option = (id, extra = {}) => ({ id, departure_gateway: "KUL", arrival_gateway: "KUL", movements: [], stays: [], stay_hours: 220, travel_hours: 30, total_cost_myr: null, cost_low_myr: 0, cost_high_myr: null, cost_per_stay_hour_myr: null, purchases: [], extra_charges: [], ...extra });
const exact = (id, total, stay_hours, extra = {}) => option(id, { total_cost_myr: total, cost_low_myr: total, cost_high_myr: total, stay_hours, ...extra });
const range = (id, low, high, stay_hours) => option(id, { cost_low_myr: low, cost_high_myr: high, stay_hours });
const partial = (id, low, stay_hours) => option(id, { cost_low_myr: low, stay_hours });
const kualaLumpur = { ...place("KUL", "Kuala Lumpur"), timezone: "Asia/Kuala_Lumpur" };
const draftTrip = (extra = {}) => ({ ...blankTrip(), home: kualaLumpur, visits: spec.visits, start_date: "2026-12-04", end_date: "2026-12-14", ...extra });

test("money, durations and dates", () => {
  assert.equal(plain(moneyShort(5395)), "RM 5,395");
  assert.equal(plain(moneyShort(24.72)), "RM 24.72");
  assert.equal(plain(moneyShort(12.5)), "RM 12.50");
  assert.equal(plain(moneyShort(12000, "JPY")), "JPY 12,000");
  assert.deepEqual([45, 90, 120, 594, 0].map(formatDuration), ["45 min", "1 h 30 min", "2 h", "9 h 54 min", "0 min"]);
  assert.equal(dateRange("2026-12-04", "2026-12-14"), "4–14 Dec 2026");
  assert.equal(dateRange("2026-11-28", "2026-12-04"), "28 Nov – 4 Dec 2026");
  assert.equal(dateRange("2026-12-28", "2027-01-03"), "28 Dec 2026 – 3 Jan 2027");
  assert.equal(dateRange("2026-12-04", "2026-12-04"), "4 Dec 2026");
  assert.equal(dateRange("", "2026-12-04"), "2026-12-04");
  assert.deepEqual(["datetime", "date", "time", "day"].map(style => formatLocal("2026-12-04T09:54:00Z", "Asia/Seoul", style)), ["Fri 4 Dec 18:54", "Fri 4 Dec", "18:54", "4 Dec"]);
});

test("price text, estimates and price per city hour for exact, range and unbounded totals", () => {
  const one = exact("one", 5395, 218.25, { cost_per_stay_hour_myr: 24.72 }), two = range("two", 6187, 6227, 221.1333), three = partial("three", 2480, 218.25);
  assert.deepEqual([one, two, three, exact("x", 5395.5, 200)].map(route => plain(priceText(route))), ["RM 5,395", "RM 6,187 – 6,227", "From RM 2,480", "RM 5,395.50"]);
  assert.deepEqual([one, two, three, exact("y", 100, 0)].map(route => plain(perCityHourText(route))), ["RM 24.72 per city hour", "RM 28.0 – 28.2 per city hour", null, null]);
  assert.equal(priceEstimated({ purchases: [fare("f1", 900), noFare("f2")] }), false);
  assert.equal(priceEstimated({ purchases: [fare("f1", 900), fare("c1", 130, 130, { source: "rule" })] }), true);
  assert.equal(priceEstimated({ purchases: [fare("f1", 9000, 9000, { currency: "JPY" })] }), true);
  assert.equal(priceEstimated({ purchases: [fare("f1", 900, 900, { source: "user", estimated: true })] }), true);
});

test("unpriced summary counts items without a price, without an exchange rate, or without an upper limit", () => {
  const route = option("r", {
    movements: [
      flightTo("f1", "KUL", "PUS"),
      { ...flightTo("c1", "PUS", "GMP"), mode: "coach", charges: [] },
      { ...flightTo("f2", "GMP", "HND"), charges: [charge("f2:airport-transfer:1", "Airport transfer GMP → ICN", "airport:GMP", "airport:ICN")] },
    ],
    purchases: [noFare("f1"), noFare("f1:access", "Airport access"), noFare("f1:egress", "Airport egress"), fare("c1", 9000, 9000, { currency: "JPY" }), fare("f2", 900, null, { source: "user" }), noFare("f2:airport-transfer:1", "Airport transfer GMP → ICN")],
  });
  assert.deepEqual(unpricedSummary(route, { MYR: 1 }), { count: 5, openEnded: 1, chip: "5 not priced", text: "5 not priced: 1 flight, 1 bus, 2 airport transfers, 1 airport change · 1 open-ended price" });
  // With a JPY rate the coach price counts.
  assert.equal(unpricedSummary(route, { MYR: 1, JPY: 0.03 }).text, "4 not priced: 1 flight, 2 airport transfers, 1 airport change · 1 open-ended price");
  assert.deepEqual(unpricedSummary({ ...route, purchases: [fare("f2", 900, null, { source: "user" })] }, { MYR: 1 }), { count: 0, openEnded: 1, chip: "open-ended price", text: "1 open-ended price: 1 flight" });
  assert.deepEqual(unpricedSummary({ ...route, purchases: [fare("f1", 900)] }, { MYR: 1 }), { count: 0, openEnded: 0, chip: "", text: "" });
});

test("options sort by highest possible price, by time in cities or by balance, with unbounded options last", () => {
  const routes = [exact("a", 5000, 220), range("b", 4000, 6000, 221), exact("c", 5000, 222), partial("d", 2000, 225), partial("e", 2000, 230), partial("f", 1500, 200), exact("g", 7000, 230)];
  const order = key => sortRoutes(routes, key).map(route => route.id).join("");
  assert.equal(order("cheapest"), "cabgfed");
  assert.equal(order("stay"), "gedcbaf");
  assert.equal(order("balanced"), "cagbfed");
  assert.equal(routes.map(route => route.id).join(""), "abcdefg");
});

test("option rows show only the exceptions as chips", () => {
  const context = { budget: 6000, rates: { MYR: 1 }, estimatedOnce: false, weaker: false, overBudget: false, compared: false };
  const chips = (route, extra = {}) => optionChips(route, { ...context, ...extra }).map(chip => `${chip.tone}:${chip.text}`);
  const estimated = exact("e", 5395, 218, { purchases: [fare("f1", 5395, 5395, { source: "rule" })] });
  assert.deepEqual(chips(estimated), ["plain:Includes estimates"]);
  // Said once above the list instead.
  assert.deepEqual(chips(estimated, { estimatedOnce: true }), []);
  // A range above the budget may exceed it; an unbounded option says so once, in Next steps (E6).
  assert.deepEqual(chips(range("r", 5900, 6200, 220)), ["warn:May exceed budget"]);
  assert.deepEqual(chips(range("r", 5900, 6200, 220), { budget: null }), []);
  const unbounded = partial("p", 7000, 220);
  unbounded.movements = [flightTo("f1", "KUL", "PUS", { schedule_estimated: true })];
  unbounded.purchases = [noFare("f1"), noFare("f1:access", "Airport access")];
  assert.deepEqual(chips(unbounded, { weaker: true, compared: true }), ["warn:2 not priced", "warn:Estimated timetable", "plain:Weaker", "plain:Compared"]);
  // Over-budget rows carry their own chip, not "May exceed budget".
  assert.deepEqual(chips(exact("o", 7000, 220), { overBudget: true }), ["warn:Over budget"]);
  assert.equal(hoursText(218.25), "218.3");
  assert.equal(hoursText(31.6), "31.6");
});

test("the options empty state follows the search and explains why nothing fits", () => {
  const names = { PUS: "Busan", HND: "Tokyo" };
  const base = { searched: true, active: false, pending: 0, hasResult: true, best: 0, refinement: [], budget: 12000, staySum: null, gaps: [], excludeUnpricedFlights: false, steps: [], placeName: id => names[id] ?? id };
  const state = (extra = {}) => optionsEmptyState({ ...base, ...extra });
  const lines = value => value && value.lines.map(line => [plain(line.text), line.action?.target ?? null]);
  assert.equal(state({ best: 3 }), null);
  assert.deepEqual(lines(state({ searched: false })), [["No options yet. Search transport to find options. They appear while the search runs.", null]]);
  assert.deepEqual(lines(state({ active: true, pending: 85 })), [["Searching. The first options appear after a few searches.", null]]);
  assert.deepEqual(lines(state({ pending: 41 })), [["No complete itinerary yet. 41 searches are left.", null]]);
  assert.deepEqual(lines(state({ pending: 1 })), [["No complete itinerary yet. 1 search is left.", null]]);
  // Over-budget options explain the empty list, also while the search runs.
  assert.deepEqual(lines(state({ active: true, refinement: [{ cost_low_myr: 13200 }, { cost_low_myr: 14100 }] })), [["No option fits your RM 12,000 budget. 2 options cost more, from RM 13,200.", "over-budget"]]);
  // A finished search before its result arrives has nothing to explain yet.
  assert.equal(state({ hasResult: false }), null);

  const steps = [
    { id: "airport-changes", tone: "warn", text: "1 flight journey can't be used until you confirm the airport change GMP → ICN.", action: { label: "Confirm airport change", target: "airport-changes" } },
    { id: "prices", tone: "warn", text: "No option has a complete price yet.", action: { label: "Add prices", target: "prices" } },
    { id: "access-time", tone: "warn", text: "2 journeys can't be used: the airport transfer time is unknown in Busan.", action: { label: "Set default time", target: "airport-fallback" } },
  ];
  const none = state({ staySum: "Minimum stays add up to 240 h, but these dates allow at most 216 h.", gaps: [{ from_id: "PUS", to_id: "HND" }], excludeUnpricedFlights: true, steps });
  assert.equal(none.id, "no-itinerary");
  assert.equal(none.title, "No itinerary fits these settings");
  assert.deepEqual(lines(none), [
    ["Minimum stays add up to 240 h, but these dates allow at most 216 h.", "edit-trip"],
    ["No direct journey found between Busan and Tokyo.", "add-connection"],
    ["1 flight journey can't be used until you confirm the airport change GMP → ICN.", "airport-changes"],
    ["2 journeys can't be used: the airport transfer time is unknown in Busan.", "airport-fallback"],
    ["Flights without a price are skipped.", "show-unpriced-flights"],
    ["Or change the trip: fewer minimum hours, more days, more transport or wider departure times.", "edit-trip"],
  ]);
  assert.deepEqual(lines(state()), [["Or change the trip: fewer minimum hours, more days, more transport or wider departure times.", "edit-trip"]]);
});

test("comparisons state the differences in time and price, or that the price difference is unknown", () => {
  const one = exact("one", 5395, 218.25), two = range("two", 6187, 6227, 221.1333);
  // The priced demo trip (spec J).
  assert.equal(plain(compareText(one, two, 2)), "vs Option 02: 2.9 h less time in cities and RM 792 – 832 less.");
  assert.equal(plain(compareText(two, one, 1)), "vs Option 01: 2.9 h more time in cities and RM 792 – 832 more. That is RM 273 – 287 per extra hour.");
  assert.equal(plain(compareText(exact("a", 5000, 220), exact("b", 4800, 218), 2)), "vs Option 02: 2.0 h more time in cities and RM 200 more. That is RM 100 per extra hour.");
  assert.equal(plain(compareText(exact("a", 5000, 220), exact("b", 4990, 200), 12)), "vs Option 12: 20.0 h more time in cities and RM 10 more. That is RM 0.50 per extra hour.");
  // The price interval crosses 0.
  assert.equal(plain(compareText(range("a", 5000, 5600, 220), exact("b", 5300, 221), 3)), "vs Option 03: 1.0 h less time in cities and between RM 300 less and RM 300 more.");
  // The price interval ends at 0.
  assert.equal(plain(compareText(exact("a", 5000, 222), range("b", 5000, 5300, 220), 2)), "vs Option 02: 2.0 h more time in cities and RM 0 – 300 less.");
  assert.equal(plain(compareText(range("a", 5000, 5300, 220), exact("b", 5000, 222), 2)), "vs Option 02: 2.0 h less time in cities and RM 0 – 300 more.");
  assert.equal(plain(compareText(exact("a", 4800, 222), exact("b", 5000, 220), 2)), "vs Option 02: 2.0 h more time in cities and RM 200 less. This option has more time in cities and costs less.");
  assert.equal(plain(compareText(exact("a", 5000, 220.01), exact("b", 5000, 220), 2)), "vs Option 02: the same time in cities and the same price.");
  assert.equal(compareText(partial("a", 2480, 221.1), exact("b", 5395, 218.2), 2), "vs Option 02: 2.9 h more time in cities. Price difference unknown: this option has items that are not priced.");
  assert.equal(compareText(exact("a", 5395, 218.2), partial("b", 2480, 221.1), 2), "vs Option 02: 2.9 h less time in cities. Price difference unknown: Option 02 has items that are not priced.");
  assert.equal(compareText(partial("a", 2480, 218.2), partial("b", 5400, 218.2), 4), "vs Option 04: the same time in cities. Price difference unknown: both options have items that are not priced.");
});

test("the status strip shows the first matching state and routes Check more combinations", () => {
  const saved = { snapshot: { coverage: {} } };
  const done = { discovery_required: false, optimization_complete: true, coverage: { discovery_complete: true } };
  const job = (status, extra = {}) => ({ id: "j", trip_id: "t", status, processed: 96, pending: 0, failed_queries: 0, requests: 84, cache_hits: 12, messages: [], bundle_links: [], ...extra });
  const strip = (extra = {}) => searchState({ invalid: false, dirty: false, saved, result: done, job: null, ...extra });
  const row = state => [state.id, state.text, state.actions.map(action => `${action.label}:${action.run}`).join(", ")];
  assert.deepEqual(row(strip({ invalid: true, dirty: true, job: job("running") })), ["invalid", "Fix the marked fields. Options show the last saved trip.", ""]);
  assert.deepEqual(row(strip({ dirty: true, job: job("running") })), ["updating", "Updating options…", ""]);
  assert.deepEqual(row(strip({ dirty: true, result: null, job: job("queued") })), ["queued", "Starting the search…", "Stop search:stop"]);
  const running = strip({ job: job("running", { processed: 52, pending: 85 }) });
  assert.deepEqual(row(running), ["running", "Searching · 52 done · 85 left. Options update as results arrive.", "Stop search:stop"]);
  assert.deepEqual(running.progress, { value: 52, max: 137, text: "52 of 137 searches", tip: "The total can grow while the search adds follow-up searches." });
  assert.equal(running.actions[0].tip, "Found options and your prices are kept.");
  assert.deepEqual(row(strip({ result: { ...done, discovery_required: true }, job: job("paused", { pending: 41 }) })), ["stale", "Your trip changed. Search again to include the changes. Options shown use the earlier search.", "Search again:search"]);
  assert.equal(strip({ job: job("superseded", { pending: 41 }) }).id, "stale");
  assert.deepEqual(row(strip({ saved: { snapshot: null }, result: null })), ["not-searched", "Not searched yet.", "Search transport:search"]);
  // The server marks the result of a trip that was never searched as discovery_required.
  assert.deepEqual(row(strip({ saved: { snapshot: null }, result: { discovery_required: true, optimization_complete: true, coverage: {} } })), ["not-searched", "Not searched yet.", "Search transport:search"]);
  const paused = strip({ job: job("paused", { pending: 41, batch_budget: 100 }) });
  assert.deepEqual(row(paused), ["paused", "Search paused · 41 searches left.", "Search more:continue"]);
  assert.equal(paused.tip, "The search pauses after each batch of 100 new requests to data providers. Search more runs the next batch. Saved results are reused.");
  assert.deepEqual(row(strip({ job: job("cancelled", { pending: 1 }) })), ["stopped", "Search stopped · 1 search left. Found options are kept.", "Search more:continue"]);
  assert.deepEqual(row(strip({ job: job("interrupted", { pending: 3 }) })), ["interrupted", "The search stopped because the server stopped · 3 searches left. Found options are kept.", "Search more:continue"]);
  assert.deepEqual(row(strip({ job: job("interrupted", { failed_queries: 2 }) })), ["interrupted", "The search stopped because the server stopped. Found options are kept.", "Retry failed searches:continue"]);
  const messages = ["flight: no rows", "Planner: RuntimeError: provider closed."];
  assert.deepEqual(row(strip({ job: job("failed", { messages }) })), ["failed", "The search failed: RuntimeError: provider closed. Found options are kept.", "Search again:search"]);
  assert.equal(row(strip({ job: job("failed", { messages, pending: 5 }) }))[2], "Search more:continue");
  assert.deepEqual(row(strip({ job: job("complete", { failed_queries: 2 }) })), ["failed-searches", "Search finished · 2 searches failed.", "Retry failed searches:continue"]);
  const gaps = { ...done, coverage: { discovery_complete: false, source_gaps: ["Transitous disabled"] } };
  assert.deepEqual(row(strip({ result: gaps, job: job("complete", { manual_quote_queries: 2 }) })), ["gaps", "Search finished with gaps: 2 combined tickets to check, trains and buses not searched.", ""]);
  assert.deepEqual(row(strip({ job: job("complete") })), ["complete", "Search complete.", ""]);
  assert.deepEqual(row(strip()), ["idle", "", ""]);
  // Check more combinations never spends provider requests: it always recalculates, also after a finished search.
  const incomplete = { ...done, optimization_complete: false };
  const checkMore = extra => strip({ result: incomplete, ...extra }).secondary?.action.run;
  assert.equal(checkMore({ job: job("paused", { pending: 41 }) }), "optimize");
  assert.equal(checkMore({ job: job("complete") }), "optimize");
  assert.equal(checkMore({ job: job("complete", { failed_queries: 2 }) }), "optimize");
  assert.equal(checkMore({ job: job("superseded") }), "optimize");
  // A finished search can't continue after the trip's search inputs changed.
  assert.equal(checkMore({ result: { ...incomplete, discovery_required: true }, job: job("complete") }), "optimize");
  assert.equal(checkMore({}), "optimize");
  assert.equal(checkMore({ job: job("running", { pending: 3 }) }), undefined);
  assert.equal(checkMore({ invalid: true }), undefined);
  assert.equal(strip({ result: incomplete }).secondary.text, "Not all combinations were checked. Better options may exist.");
});

test("status strip details list the counters, the data version and each provider message once", () => {
  const job = { id: "j", trip_id: "t", status: "paused", processed: 96, pending: 41, failed_queries: 11, requests: 84, cache_hits: 12, manual_quote_queries: 2, outcomes: { success: 85, empty: 0, failed: 11 }, messages: ["No rows for KUL → PUS.", "Batch limit reached."], bundle_links: [] };
  const result = { snapshot_revision: 2, feasible_count: 1234, expanded_labels: 1, coverage: { messages: ["Batch limit reached."], source_gaps: ["Transitous disabled"] } };
  const saved = { snapshot: { coverage: {} } };
  assert.deepEqual(searchDetails({ saved, job, result }), {
    lines: [
      "Searches: 96 done · 41 left · 11 failed",
      "Requests to data providers: 84 · answered from saved results: 12",
      "Results: 85 found · 11 failed",
      "Combined tickets to check: 2",
      "Data version 2 · 1,234 complete itineraries checked · 1 combination explored",
      "Scope: best among the schedules and prices collected, not every ticket on sale.",
    ],
    messages: ["No rows for KUL → PUS.", "Batch limit reached.", "Transit search is not set up on this server."],
  });
  // The batch line needs both fields; zero counts and a missing job leave their lines out.
  const batch = searchDetails({ saved, job: { ...job, batch_requests: 40, batch_budget: 100, outcomes: {}, manual_quote_queries: 0 }, result: null });
  assert.deepEqual(batch.lines, ["Searches: 96 done · 41 left · 11 failed", "This batch: 40 of 100 requests", "Requests to data providers: 84 · answered from saved results: 12"]);
  assert.deepEqual(searchDetails({ saved, job: null, result }).lines.map(line => line.split(" ")[0]), ["Data", "Scope:"]);
  // Nothing before the first search, although the server returns a result for the saved trip.
  assert.deepEqual(searchDetails({ saved: { snapshot: null }, job: null, result }), { lines: [], messages: [] });
  // Without a result (while openTrip recalculates a stale one), the messages come from the snapshot coverage.
  assert.deepEqual(searchDetails({ saved: { snapshot: { coverage: { messages: ["m"], source_gaps: ["Transitous disabled"] } } }, job: null, result: null }),
    { lines: [], messages: ["m", "Transit search is not set up on this server."] });
  // Counts use thousands separators, like the rest of the strip.
  assert.equal(searchDetails({ saved, job: { ...job, processed: 1234, outcomes: {}, manual_quote_queries: 0 }, result: null }).lines[0], "Searches: 1,234 done · 41 left · 11 failed");
});

test("errors map to the banner text and the action that removes their cause", () => {
  const apiError = (message, status, path) => Object.assign(new Error(message), { status, path });
  const conflict = "This trip changed elsewhere, for example in another tab or after a price rule change. Reload it to continue.";
  const unreachable = "Can't reach the planner server. Check that it is running, then try again.";
  assert.deepEqual(appError(apiError("This trip changed. Reload it before saving.", 409, "/trips/t1")), { text: conflict, action: "reload" });
  assert.deepEqual(appError(apiError("Trip changed. Reload before removing a connection.", 409, "/trips/t1/movements/m?expected_revision=3")), { text: conflict, action: "reload" });
  // A conflict also wins over Retry save: the save can't succeed before the trip is reloaded.
  assert.deepEqual(appError(apiError("This trip changed. Reload it before saving.", 409, "/trips/t1"), true), { text: conflict, action: "reload" });
  assert.deepEqual(appError(apiError("Start a new search after changing discovery inputs.", 409, "/searches/j/continue")), { text: "Start a new search after changing discovery inputs.", action: "search-again" });
  assert.deepEqual(appError(apiError("This trip already has an active discovery job.", 409, "/trips/t1/searches")), { text: "This trip already has an active discovery job.", action: null });
  assert.deepEqual(appError(apiError("An in-flight request is finishing. Continue after it stops.", 409, "/searches/j/continue")), { text: "An in-flight request is finishing. Continue after it stops.", action: null });
  assert.deepEqual(appError(Object.assign(new Error(unreachable), { path: "/trips" })), { text: unreachable, action: null });
  assert.deepEqual(appError(apiError("Input should be a valid date", 422, "/trips/t1"), true), { text: "Changes not saved: Input should be a valid date", action: "retry-save" });
  assert.deepEqual(appError(Object.assign(new Error(unreachable), { path: "/trips/t1" }), true), { text: `Changes not saved: ${unreachable}`, action: "retry-save" });
  assert.deepEqual(appError(new Error("Finish the current trip setup before copying it.")), { text: "Finish the current trip setup before copying it.", action: null });
  assert.deepEqual(appError("unexpected"), { text: "Something went wrong. Try again.", action: null });
});

test("journey steps read as plain sentences", () => {
  const step = (segment, source = "Google Flights / fast-flights") => stepLabel({ from_name: "A", to_name: "B", departure: null, arrival: null, operator: null, service: null, source: null, duration_minutes: null, assumed: false, from_timezone: "Asia/Seoul", to_timezone: "Asia/Seoul", ...segment }, { source });
  const text = (segment, source) => step(segment, source).text;
  assert.equal(text({ mode: "transfer", source: "Airport access", to_name: "Kuala Lumpur International Airport", duration_minutes: 45, assumed: true }), "Taxi to Kuala Lumpur International Airport · 45 min (estimate)");
  assert.equal(text({ mode: "rail", source: "User-estimated airport access", to_name: "Incheon International Airport", duration_minutes: 50, assumed: true }), "Train to Incheon International Airport · 50 min (estimate)");
  assert.equal(text({ mode: "wait", source: "Flight readiness buffer", duration_minutes: 90 }), "At the airport before the flight · 1 h 30 min");
  assert.equal(text({ mode: "flight", source: "Google Flights", operator: "AirAsia X", service: "D7530", from_name: "Kuala Lumpur International Airport", to_name: "Gimhae International Airport", departure: "2026-12-04T10:15:00+08:00", arrival: "2026-12-04T17:39:00+09:00", from_timezone: "Asia/Kuala_Lumpur" }), "AirAsia X D7530 · Kuala Lumpur International Airport 10:15 → Gimhae International Airport 17:39");
  assert.equal(text({ mode: "wait", source: "Scheduled connection", from_name: "Incheon International Airport", duration_minutes: 95 }), "Connection at Incheon International Airport · 1 h 35 min");
  assert.equal(text({ mode: "rail", source: "User-verified airport transfer", from_name: "Gimpo", to_name: "Incheon", duration_minutes: 70 }), "Train from Gimpo to Incheon · 1 h 10 min (your airport change)");
  assert.equal(text({ mode: "wait", source: "Layover after airport transfer", to_name: "Incheon", duration_minutes: 40 }), "Wait at Incheon · 40 min");
  assert.deepEqual(step({ mode: "transfer", source: "Airport change needs confirmation", from_name: "Gimpo", to_name: "Incheon" }), { text: "Airport change Gimpo → Incheon is not confirmed", warning: true });
  assert.deepEqual(step({ mode: "transfer", source: "Airport transfer exceeds available layover" }), { text: "Your airport change takes longer than the layover", warning: true });
  assert.equal(text({ mode: "wait", source: "Arrival buffer", duration_minutes: 30 }), "After landing · 30 min");
  assert.deepEqual(step({ mode: "transfer", source: "Airport egress", to_name: "Busan", duration_minutes: 45 }), { text: "Taxi to Busan · 45 min", warning: false });
  assert.equal(text({ mode: "walk", source: "Transitous", to_name: "Seoul Station", departure: "2026-12-07T08:48:00+09:00", arrival: "2026-12-07T09:00:00+09:00" }, "Transitous / MOTIS"), "Walk to Seoul Station · 12 min");
  assert.equal(text({ mode: "highspeed_rail", source: "Transitous", operator: "Korail", service: "KTX 179", from_name: "Seoul Station", to_name: "Busan Station", departure: "2026-12-07T09:00:00+09:00", arrival: "2026-12-07T11:40:00+09:00" }, "Transitous / MOTIS"), "Train KTX 179 · Korail · Seoul Station 09:00 → Busan Station 11:40");
  assert.equal(text({ mode: "bus", source: "Transitous", service: "1001", departure: "2026-12-07T01:00:00Z", arrival: "2026-12-07T02:00:00Z" }, "Transitous / MOTIS"), "Bus 1001 · A 10:00 → B 11:00");
  assert.equal(text({ mode: "rail", source: "User-supplied positioning", service: "ETS 9", from_name: "Kuala Lumpur", to_name: "Singapore", departure: "2026-12-03T23:00:00Z", arrival: "2026-12-04T04:30:00Z", from_timezone: "Asia/Kuala_Lumpur", to_timezone: "Asia/Singapore" }, "User-supplied positioning"), "Train ETS 9 · Kuala Lumpur 07:00 → Singapore 12:30 (your journey)");
  assert.equal(text({ mode: "flight", source: "User-supplied positioning", service: "MH603", from_name: "Kuala Lumpur", to_name: "Singapore", departure: "2026-12-03T23:00:00Z", arrival: "2026-12-04T00:05:00Z", from_timezone: "Asia/Kuala_Lumpur", to_timezone: "Asia/Singapore" }, "User-supplied positioning"), "Flight MH603 · Kuala Lumpur 07:00 → Singapore 08:05 (your journey)");
  assert.equal(text({ mode: "car", from_name: "Kuala Lumpur", to_name: "Singapore" }, "OSRM"), "Car: Kuala Lumpur → Singapore");
});

test("assumption notes are plain sentences, each listed once", () => {
  const estimated = city => `${city}: 45 minute airport transfer assumption; road routing unavailable`;
  const driving = "Driving time estimate; traffic and rental availability are not live inventory.";
  const names = { KUL: "Kuala Lumpur", PUS: "Busan", GMP: "Seoul", HND: "Tokyo" };
  const route = option("r", {
    movements: [
      flightTo("f1", "KUL", "PUS", { assumptions: [estimated("Kuala Lumpur"), estimated("Busan")] }),
      flightTo("f2", "PUS", "GMP", { assumptions: [estimated("Busan"), estimated("Seoul")] }),
      flightTo("a1", "GMP", "HND", { mode: "bus", source: "User-defined connection", assumptions: ["User supplied connectivity and timing", "User-defined travel time and connectivity"] }),
      flightTo("t1", "HND", "GMP", { mode: "rail", assumptions: ["Estimated timetable based on 2026-11-10 (same weekday), copied to 2026-12-07. Travel-date coverage is unconfirmed.", "Station search within 25 km; station access/egress uses provider walking times. Verify local access."] }),
      flightTo("r1", "GMP", "PUS", { mode: "car", assumptions: [driving] }),
      flightTo("r2", "PUS", "KUL", { mode: "car", assumptions: [driving, "Something new"] }),
    ],
    purchases: [fare("f1", 900), fare("f1:access", 130, 130, { source: "rule", label: "Trip airport transfer estimate" })],
  });
  assert.deepEqual(assumptionNotes(route, id => names[id]), [
    { text: "Airport transfer times are estimates (45 min each, no road data): Kuala Lumpur, Busan, Seoul.", action: "transfer-times" },
    { text: "Your connection Seoul → Tokyo is assumed to exist.", action: null },
    { text: "Tokyo → Seoul uses an estimated timetable copied from 10 Nov 2026. Check the real timetable.", action: null },
    { text: "Tokyo → Seoul uses stations up to 25 km away. Check how you get to them.", action: null },
    { text: "Driving times are estimates without traffic. Rental cars are not checked for availability.", action: null },
    { text: "Something new", action: null },
    { text: "1 price is an estimate (your prices, rules or older quotes).", action: null },
  ]);
});

test("day by day lists journeys, stays and time at places that does not count, in order", () => {
  const stay = (place_id, arrival, departure, hours) => ({ place_id, arrival, departure, hours });
  const route = option("r", {
    movements: [
      flightTo("f1", "KUL", "SIN", { departure: "2026-12-04T00:00:00Z", arrival: "2026-12-04T02:00:00Z" }),
      flightTo("f2", "SIN", "PUS", { departure: "2026-12-04T07:00:00Z", arrival: "2026-12-04T09:54:00Z" }),
      flightTo("f3", "PUS", "HND", { departure: "2026-12-08T02:15:00Z", arrival: "2026-12-08T07:57:00Z" }),
      flightTo("f4", "HND", "PUS", { departure: "2026-12-10T23:45:00Z", arrival: "2026-12-11T02:00:00Z" }),
      flightTo("f5", "PUS", "ICN", { departure: "2026-12-11T02:20:00Z", arrival: "2026-12-11T03:00:00Z" }),
    ],
    // Stays write their instants with "+00:00", movements with "Z".
    stays: [stay("PUS", "2026-12-04T09:54:00+00:00", "2026-12-08T02:15:00+00:00", 88.35), stay("HND", "2026-12-08T07:57:00+00:00", "2026-12-10T23:45:00+00:00", 63.8), stay("PUS", "2026-12-11T02:00:00+00:00", "2026-12-11T02:20:00+00:00", 0.33)],
  });
  const rows = dayByDay(route, { PUS: 24, HND: 0 }).map(entry => entry.kind === "journey" ? entry.movement.id : entry.kind === "stay" ? `${entry.stay.place_id}:${entry.minimum}` : `gap:${entry.placeId}:${entry.minutes}`);
  // 5 h in Singapore do not count; the second stay in Busan has no minimum; 0 h is no minimum.
  assert.deepEqual(rows, ["f1", "gap:SIN:300", "f2", "PUS:24", "f3", "HND:null", "f4", "PUS:null", "f5"]);
  // A gap under 30 min is not listed.
  assert.deepEqual(dayByDay({ ...route, stays: [] }, {}).filter(entry => entry.kind === "gap").map(entry => entry.minutes), [300, 5301, 3828]);
  assert.deepEqual(dayByDay({ movements: [flightTo("a", "KUL", "SIN", { departure: "2026-12-04T00:00:00Z", arrival: "2026-12-04T02:00:00Z" }), flightTo("b", "SIN", "KUL", { departure: "2026-12-04T02:29:00Z", arrival: "2026-12-04T05:00:00Z" })], stays: [] }, {}).map(entry => entry.kind), ["journey", "journey"]);
});

test("journey rows: times, main service, source line and chips", () => {
  const flight = { departure: "2026-12-04T00:00:00Z", arrival: "2026-12-04T09:54:00Z" };
  assert.equal(journeyWhen(flight, "Asia/Kuala_Lumpur", "Asia/Seoul"), "Fri 4 Dec · 08:00 → 18:54");
  assert.equal(journeyWhen({ departure: "2026-12-04T14:00:00Z", arrival: "2026-12-04T22:00:00Z" }, "Asia/Kuala_Lumpur", "Asia/Seoul"), "Fri 4 Dec · 22:00 → Sat 5 Dec 07:00");
  assert.equal(journeyWhen({ departure: null, arrival: null }, "UTC", "UTC"), "");
  const segment = (mode, source, extra = {}) => ({ mode, source, operator: null, service: null, ...extra });
  const access = [segment("taxi", "User-estimated airport access"), segment("wait", "Flight readiness buffer")];
  assert.equal(mainService({ segments: [...access, segment("flight", "Google Flights", { operator: "AirAsia X", service: "D7530" }), segment("transfer", "Airport egress")] }), "AirAsia X D7530");
  assert.equal(mainService({ segments: [segment("flight", "Google Flights", { operator: "Asiana", service: "OZ1" }), segment("rail", "User-verified airport transfer"), segment("flight", "Google Flights", { operator: "Asiana", service: "OZ2" })] }), null);
  assert.equal(mainService({ segments: [] }), null);
  assert.equal(journeySource({ source: "Google Flights / fast-flights", transfers: 1, distance_km: null, segments: [{}] }), "Google Flights · 1 change");
  assert.equal(journeySource({ source: "Transitous / MOTIS", transfers: 0, distance_km: 324.6, segments: [{}] }), "Transitous · 0 changes · 325 km");
  assert.equal(journeySource({ source: "OSRM", transfers: 0, distance_km: 1234, segments: [] }), "Road estimate · 1,234 km");
  assert.equal(journeySource({ source: "User-defined connection", transfers: 0, distance_km: null, segments: [] }), "Your connection");
  const movement = flightTo("f1", "KUL", "PUS");
  const route = option("r", { purchases: [noFare("f1"), noFare("f1:access", "Airport access"), fare("f1:egress", 144), fare("f2", 9000, 9000, { currency: "JPY" })] });
  const chips = (m, rates = { MYR: 1 }) => journeyChips(route, m, rates).map(chip => `${chip.tone}:${chip.text}`);
  assert.deepEqual(chips(movement), ["warn:2 not priced"]);
  assert.deepEqual(chips({ ...flightTo("f2", "PUS", "HND"), schedule_estimated: true }), ["warn:Estimated timetable", "warn:1 not priced"]);
  assert.deepEqual(chips({ ...flightTo("f2", "PUS", "HND"), source: "User-defined connection" }, { MYR: 1, JPY: 0.03 }), ["plain:Your connection"]);
  assert.deepEqual(chips({ ...flightTo("x", "PUS", "HND"), source: "User-supplied positioning" }), ["plain:Your journey"]);
});

test("trip summary lines", () => {
  const summary = tripSummary(draftTrip({ departures: [kualaLumpur, place("SIN", "Singapore")], arrivals: [kualaLumpur], adults: 2, budget_myr: 12000, departure_start: "09:00:00", departure_end: "17:00:00", modes: ["coach", "flight", "rail", "bus"] }));
  assert.equal(summary.route, "Kuala Lumpur or Singapore → Seoul 48 h+, Busan 24 h+, Tokyo 48 h+ (any order) → Kuala Lumpur");
  assert.equal(plain(summary.details), "4–14 Dec 2026 (exact dates) · leave 09:00–17:00 · 2 adults · budget RM 12,000 · Flight, Train, Bus, Coach");
  assert.deepEqual(tripSummary(draftTrip({ visits: [{ place: place("GMP", "Seoul"), min_stay_hours: 0 }], start_date: "2026-11-28", date_mode: "flexible", departure_start: "08:00", departure_end: "20:00", modes: ["flight"] })), {
    route: "Kuala Lumpur → Seoul → Kuala Lumpur",
    details: "28 Nov – 14 Dec 2026 (any days) · leave 08:00–20:00 · 1 adult · no budget · Flight",
  });
});

test("settings summaries show each group and what differs from the defaults", () => {
  const defaults = settingsSummaries(draftTrip(), 100);
  assert.deepEqual(Object.fromEntries(Object.entries(defaults).map(([key, group]) => [key, group.summary])), {
    places: "Home only",
    departures: "Leave 09:00–17:00 · any number of changes · overnight allowed",
    buffers: "Flights 90 + 30 min · trains and buses 15 + 10 min · changes 30 min · airport transfer 45 min",
    appointments: "None", cars: "Not used", prices: "MYR only", timetables: "Off", searchSize: "100 requests per batch",
  });
  assert.deepEqual(Object.values(defaults).flatMap(group => group.changes), []);
  const base = blankTrip();
  const changed = settingsSummaries(draftTrip({
    departures: [kualaLumpur, place("SIN", "Singapore")], home_departure_earliest: "07:00:00",
    positioning_services: [{ id: "s1", direction: "outbound", gateway_id: "SIN", mode: "rail", departure: "2026-12-03T23:00:00Z", arrival: "2026-12-04T04:30:00Z", fare_amount: null, currency: "MYR", label: "ETS" }],
    max_transfers: 1, timing: { ...base.timing, airport_transfer_fallback_minutes: null },
    commitments: [{ place_id: "GMP", start: "2026-12-05T05:00:00Z", end: "2026-12-05T07:00:00Z" }, { place_id: "PUS", start: "2026-12-08T01:00:00Z", end: "2026-12-08T02:00:00Z" }],
    cars: { ...base.cars, own_enabled: true, rental_enabled: true }, exchange_rates: { MYR: 1, JPY: 0.031, KRW: 0.0032 }, exclude_unpriced_flights: true,
    rail_fallback: { enabled: true, reference_date: null, max_shift_days: 180, station_radius_km: 25 },
  }), 50);
  assert.equal(changed.places.summary, "Start: Kuala Lumpur or Singapore · End: Kuala Lumpur · leave home after 07:00 · 1 journey");
  assert.equal(changed.appointments.summary, "2: Seoul Sat 5 Dec 14:00–16:00, …");
  assert.equal(changed.cars.summary, "Own car, rental car");
  assert.equal(changed.prices.summary, "MYR, JPY, KRW · flights without a price skipped");
  assert.equal(changed.timetables.summary, "On · stations within 25 km · up to 180 days");
  assert.deepEqual(Object.values(changed).flatMap(group => group.changes), [
    "Start: Kuala Lumpur or Singapore", "Leave home after 07:00", "1 journey", "Max 1 change", "No default airport transfer time",
    "2 appointments", "Own car, rental car", "MYR, JPY, KRW", "Flights without a price skipped", "Estimated train timetables", "50 requests per batch",
  ]);
});

test("draft validation lists errors in the order the settings footer reports them", () => {
  assert.deepEqual(validateDraft(draftTrip()), {});
  const empty = validateDraft({ ...blankTrip(), modes: [], start_date: "2026-12-14", end_date: "2026-12-04", departure_end: "09:00" });
  assert.deepEqual(Object.keys(empty), ["home", "visits", "modes", "dates", "departureWindow"]);
  assert.equal(Object.values(empty)[0], "Add your home city.");
  assert.equal(empty.visits, "Add at least one city to visit.");
  assert.equal(empty.modes, "Choose at least one type of transport.");
  assert.equal(empty.dates, "The end date must be on or after the start date.");
  assert.equal(empty.departureWindow, "The latest departure must be after the earliest.");
  assert.equal(validateDraft(draftTrip({ end_date: "2027-12-05" })).dates, "Choose up to 365 days.");
  assert.deepEqual(validateDraft(draftTrip({ end_date: "2027-12-04" })), {});
  // A date input can hold a 5-digit year: Date.parse accepts "20266-12-14", but it is not a valid ISO date.
  assert.equal(validateDraft(draftTrip({ end_date: "20266-12-14" })).dates, "Choose up to 365 days.");
  assert.equal(validateDraft(draftTrip({ start_date: "" })).dates, "Choose a start date and an end date.");
  assert.equal(validateDraft(draftTrip({ departure_start: "" })).departureWindow, "Enter both departure times.");
  const sameDay = { start_date: "2026-12-04", end_date: "2026-12-04", home_departure_earliest: "18:00", home_arrival_latest: "18:00:00" };
  assert.deepEqual(validateDraft(draftTrip(sameDay)), { homeTimes: "Be home after you leave home." });
  assert.deepEqual(validateDraft(draftTrip({ ...sameDay, end_date: "2026-12-05" })), {});
  assert.deepEqual(validateDraft(draftTrip({ adults: 0, budget_myr: -1, visits: [{ place: place("GMP", "Seoul"), min_stay_hours: 9000 }] })), {
    stays: "Enter a minimum stay greater than 0 and up to 8,760 hours for each city.", adults: "Enter 1 to 9 adults.", budget: "Enter 0 or more, or leave it blank.",
  });
});

test("date mode helper lines and the minimum stay warning", () => {
  assert.equal(dateModeText(draftTrip()), "Leave home on 4 Dec. Be back home on 14 Dec.");
  assert.equal(dateModeText(draftTrip({ date_mode: "flexible" })), "Leave and come back on any days from 4 to 14 Dec.");
  assert.equal(dateModeText(draftTrip({ date_mode: "flexible", start_date: "2026-11-28" })), "Leave and come back on any days from 28 Nov to 14 Dec.");
  assert.equal(dateModeText(draftTrip({ end_date: "" })), "");
  // 4–14 Dec is 11 days: 264 h. The demo stays add up to 120 h.
  assert.equal(staySumWarning(draftTrip()), null);
  assert.equal(staySumWarning(draftTrip({ end_date: "2026-12-08" })), null);
  assert.equal(staySumWarning(draftTrip({ end_date: "2026-12-07" })), "Minimum stays add up to 120 h, but these dates allow at most 96 h.");
  assert.equal(staySumWarning(draftTrip({ end_date: "2026-12-01" })), null);
});

test("the party-size notice counts your prices and airport transfer prices for another number of adults", () => {
  const offer = (id, source, adults) => ({ id, source, adults, movement_ids: [id], kind: "one-way", low: 1, high: 1, currency: "MYR", estimated: true, label: "", validated: true });
  const estimate = adults => ({ mode: "taxi", duration_minutes: null, from_id: "KUL", to_id: "airport:KUL", adults, low: 95, high: 95, currency: "MYR" });
  // The priced demo trip: 2 user prices and 14 airport transfer prices, all for 2 adults.
  const saved = { offers: [offer("user:a", "user", 2), offer("user:b", "user", 2), offer("p", "provider", 3), offer("user:old", "user", null)], airport_transfer_estimates: Array.from({ length: 14 }, () => estimate(2)) };
  assert.equal(partySizeNotice(saved, 2), null);
  assert.equal(partySizeNotice(saved, 3), "16 prices you entered are for 2 adults. They are not used for 3 adults.");
  assert.equal(partySizeNotice({ offers: [offer("user:a", "user", 1)], airport_transfer_estimates: [estimate(3)] }, 2), "2 prices you entered are for 1 or 3 adults. They are not used for 2 adults.");
  assert.equal(partySizeNotice({ offers: [offer("user:a", "user", 1)] }, 2), "1 price you entered is for 1 adult. It is not used for 2 adults.");
  assert.equal(partySizeNotice(null, 2), null);
});

test("the settings footer states", () => {
  const flags = { errors: {}, isNew: false, searched: true, active: false, stale: false };
  const labels = state => state.buttons.map(button => button.label);
  const fresh = settingsFooter({ ...flags, isNew: true, searched: false });
  assert.equal(fresh.text, "Ready. The search can take a few minutes.");
  assert.deepEqual(labels(fresh), ["Save without searching", "Search transport"]);
  assert.deepEqual(fresh.buttons.map(button => button.run), ["save", "search"]);
  // The result of a trip that was never searched is marked stale too.
  assert.deepEqual(labels(settingsFooter({ ...flags, searched: false, stale: true })), ["Search transport"]);
  const stale = settingsFooter({ ...flags, stale: true });
  assert.deepEqual([stale.text, labels(stale), stale.disabled], ["Your changes need a new search.", ["Search again"], false]);
  const idle = settingsFooter(flags);
  assert.deepEqual([idle.text, labels(idle)], ["", ["Start a new search"]]);
  assert.equal(idle.buttons[0].tip, "Starts the search again from the beginning. Saved provider responses are reused.");
  const active = settingsFooter({ ...flags, active: true, stale: true });
  assert.deepEqual([active.text, active.disabled], ["Searching…", true]);
  const invalid = settingsFooter({ ...flags, isNew: true, searched: false, errors: { home: "Add your home city.", modes: "Choose at least one type of transport." } });
  assert.deepEqual([invalid.text, labels(invalid), invalid.disabled], ["Add your home city.", ["Save without searching", "Search transport"], true]);
});

test("airport transfer directions show their use, missing prices, own prices and order", () => {
  const rows = [
    { from_id: "PUS", to_id: "airport:PUS", label: "Busan → PUS airport" },
    { from_id: "KUL", to_id: "airport:KUL", label: "Kuala Lumpur → KUL airport" },
    { from_id: "airport:PUS", to_id: "PUS", label: "PUS airport → Busan" },
    { from_id: "airport:SIN", to_id: "SIN", label: "SIN airport → Singapore" },
  ];
  const estimate = id => fare(id, 144, 144, { id: `rule:airport-transfer:x:${id}`, source: "rule", label: "Trip airport transfer estimate" });
  const routes = [
    option("r1", { movements: [flightTo("f1", "KUL", "PUS")], purchases: [noFare("f1:access", "Airport access"), estimate("f1:egress")] }),
    option("r2", { movements: [flightTo("f2", "PUS", "KUL")], purchases: [noFare("f2:access", "Airport access"), noFare("f2:egress", "Airport egress")] }),
    option("r3", { movements: [flightTo("f3", "KUL", "PUS"), flightTo("f4", "PUS", "KUL")], purchases: [estimate("f3:access"), fare("f3:egress", 150, 150, { id: "user:f3:egress", source: "user" }), fare("f4:access", 9000, 9000, { currency: "JPY" }), estimate("f4:egress")] }),
  ];
  const directions = transferDirections(rows, routes, 2, { MYR: 1 });
  assert.deepEqual(directions.map(d => [d.label, d.state, d.options, d.missing, d.journeys.length, d.ownPrices, plain(d.status)]), [
    ["Busan → PUS airport", "missing", 2, 2, 2, 0, "Price missing · in 2 options"],
    ["Kuala Lumpur → KUL airport", "missing", 2, 1, 2, 0, "Price missing · in 1 option"],
    // The journey with its own price (RM 150) does not change the direction's price.
    ["PUS airport → Busan", "priced", 2, 0, 2, 1, "RM 144 for 2 adults"],
    ["SIN airport → Singapore", "unused", 0, 0, 0, 0, "Not used now"],
  ]);
  assert.equal(directions[2].journeys[1].offer.id, "user:f3:egress");
  // With a JPY rate the f4 transfer has a price.
  assert.equal(transferDirections(rows, routes, 2, { MYR: 1, JPY: 0.03 })[0].missing, 1);
  assert.deepEqual(directions.map(d => d.rateCurrencies), [["JPY"], [], [], []]);
  // A direction whose only problem is a price without an exchange rate says so.
  const krw = [option("r5", { movements: [flightTo("f6", "KUL", "PUS")], purchases: [fare("f6:access", 9000, 9000, { currency: "KRW" }), estimate("f6:egress")] })];
  const rateOnly = transferDirections(rows, krw, 2, { MYR: 1 }).find(d => d.label === "Kuala Lumpur → KUL airport");
  assert.deepEqual([rateOnly.state, rateOnly.rateCurrencies, plain(rateOnly.status)], ["missing", ["KRW"], "Needs an exchange rate · in 1 option"]);
  // When every journey has its own price, the status shows those prices.
  const own = [option("r4", { movements: [flightTo("f5", "KUL", "PUS")], purchases: [fare("f5:access", 90, 90, { id: "user:f5:access", source: "user" }), fare("f5:egress", 150, 150, { id: "user:f5:egress", source: "user" })] })];
  assert.equal(plain(transferDirections(rows, own, 2, { MYR: 1 }).find(d => d.label === "PUS airport → Busan").status), "RM 150 for 2 adults");
});

test("journeys of an airport transfer direction read in the local time at their end of the journey", () => {
  const names = { KUL: "Kuala Lumpur", PUS: "Busan" };
  const flight = flightTo("f1", "KUL", "PUS", { departure: "2026-12-04T00:00:00Z", arrival: "2026-12-04T09:54:00Z" });
  const zoneOf = id => id === "KUL" ? "Asia/Kuala_Lumpur" : "Asia/Seoul";
  assert.equal(transferJourneyText({ charge: flight.charges[0], movement: flight }, id => names[id], zoneOf), "Fri 4 Dec 08:00 · flight to Busan");
  assert.equal(transferJourneyText({ charge: flight.charges[1], movement: flight }, id => names[id], zoneOf), "Fri 4 Dec 18:54 · flight from Kuala Lumpur");
  const rail = { ...flight, mode: "rail", departure: null };
  assert.equal(transferJourneyText({ charge: rail.charges[0], movement: rail }, id => names[id], zoneOf), "Train to Busan");
});

test("journey price rows name the journey and its dates in the origin's time", () => {
  const names = { KUL: "Kuala Lumpur", PUS: "Busan" };
  const component = (departure, service = null) => ({ departure, service });
  const group = (label, components) => ({ label, from_id: "KUL", to_id: "PUS", components });
  assert.equal(journeyGroupTitle(group("flight", []), id => names[id]), "Flight · Kuala Lumpur → Busan");
  assert.equal(journeyGroupTitle(group("rail", []), id => names[id]), "Train · Kuala Lumpur → Busan");
  assert.equal(journeyGroupTitle(group("Airport access", []), id => names[id]), "Airport access · Kuala Lumpur → Busan");
  const zone = "Asia/Kuala_Lumpur";
  assert.equal(componentWhen(component("2026-12-04T02:15:00Z", "AirAsia X D7530"), zone), "Fri 4 Dec 10:15 · AirAsia X D7530");
  assert.equal(componentWhen(component(null), zone), "");
  assert.equal(journeyGroupWhen(group("flight", [component("2026-12-04T02:15:00Z", "AirAsia X D7530")]), zone), "1 journey · Fri 4 Dec 10:15 · AirAsia X D7530");
  assert.equal(journeyGroupWhen(group("flight", [component(null)]), zone), "1 journey");
  // 9 Dec 20:00 UTC is 10 Dec in Kuala Lumpur.
  assert.equal(journeyGroupWhen(group("flight", [component("2026-12-09T20:00:00Z"), component("2026-12-04T02:15:00Z"), component("2026-12-06T02:15:00Z")]), zone), "3 journeys · 4–10 Dec");
  assert.equal(journeyGroupWhen(group("flight", [component("2026-11-28T02:15:00Z"), component("2026-12-04T02:15:00Z")]), zone), "2 journeys · 28 Nov – 4 Dec");
  assert.equal(journeyGroupWhen(group("flight", [component("2026-12-04T02:15:00Z"), component("2026-12-04T09:15:00Z")]), zone), "2 journeys · 4 Dec");
  assert.equal(journeyGroupWhen(group("flight", [component(null), component(null)]), zone), "2 journeys");
});

test("missing-price groups split into airport transfer rows and journey prices", () => {
  const group = (label, from_id, to_id, mode = "taxi") => ({ key: JSON.stringify([from_id, to_id, label]), label, from_id, to_id, mode, currency: "MYR", reason: "missing_fare", affected_itineraries: 1, components: [] });
  const rows = [{ from_id: "KUL", to_id: "airport:KUL", label: "Kuala Lumpur → KUL airport" }];
  const { transfers, journeys } = splitGroups([group("Airport access", "KUL", "airport:KUL"), group("Airport access", "KUL", "airport:XSP"), group("flight", "KUL", "PUS", "flight"), group("Airport transfer GMP → ICN", "airport:GMP", "airport:ICN")], rows);
  assert.deepEqual(transfers.map(g => g.to_id), ["airport:KUL"]);
  assert.deepEqual(journeys.map(g => `${g.label} ${g.to_id}`), ["Airport access airport:XSP", "flight PUS"]);
});

test("combined-ticket searches match an option's flights by places and local departure date", () => {
  const flightOn = (id, from_id, to_id, departure) => flightTo(id, from_id, to_id, { departure: "2026-12-01T00:00:00Z", segments: [{ mode: "transfer", departure: "2026-12-01T00:00:00Z" }, { mode: "flight", departure }] });
  const route = option("r", { movements: [flightOn("f1", "KUL", "GMP", "2026-12-04T09:35:00+08:00"), flightTo("t1", "GMP", "PUS", { mode: "rail" }), flightOn("f2", "HND", "KUL", "2026-12-13T23:30:00Z")] });
  const leg = (from_id, to_id, date) => ({ from_id, to_id, date });
  const links = [
    { kind: "multi-city", status: "requires_manual_quote", url: "u1", legs: [leg("KUL", "GMP", "2026-12-04"), leg("HND", "KUL", "2026-12-14")] },
    { kind: "round-trip", status: "requires_manual_quote", url: "u2", legs: [leg("KUL", "GMP", "2026-12-04"), leg("GMP", "KUL", "2026-12-14")] },
    { kind: "multi-city", status: "success", url: "u3", legs: [leg("KUL", "GMP", "2026-12-04"), leg("HND", "KUL", "2026-12-13")] },
  ];
  const zones = { KUL: "Asia/Kuala_Lumpur", GMP: "Asia/Seoul", HND: "Asia/Tokyo" };
  // 23:30 UTC on 13 Dec is 14 Dec in Tokyo.
  assert.deepEqual(matchingQuoteLinks(links, route, id => zones[id]).map(link => link.url), ["u1"]);
  assert.deepEqual(matchingQuoteLinks(links, option("x"), id => zones[id]), []);
});

test("next steps and the needs-input count follow the counting rules", () => {
  const change = (from_airport, to_airport, unresolved_journey_count) => ({ from_airport, to_airport, from_name: from_airport, to_name: to_airport, journey_count: 2, unresolved_journey_count, required: true, mode: "", duration_minutes: null, fare_amount: null, currency: "MYR" });
  const group = (mode, extra = {}) => ({ key: mode, label: mode, from_id: "KUL", to_id: "PUS", mode, currency: "MYR", reason: "missing_fare", affected_itineraries: 1, components: [], ...extra });
  const direction = state => ({ from_id: "a", to_id: "b", label: "x", state });
  // r1 misses a flight price and a transfer price; r2 only transfer prices (one without an upper limit); r3 is priced.
  const routes = [
    option("r1", { movements: [flightTo("f1", "KUL", "PUS")], purchases: [noFare("f1"), noFare("f1:access", "Airport access"), fare("f1:egress", 140)] }),
    option("r2", { movements: [flightTo("f2", "KUL", "PUS")], purchases: [fare("f2", 900), noFare("f2:access", "Airport access"), fare("f2:egress", 140, null)] }),
    exact("r3", 5000, 220),
  ];
  const state = {
    routes, airportChanges: [change("GMP", "ICN", 1), change("KIX", "ITM", 0)], unresolvedAccess: [],
    directions: [direction("missing"), direction("missing"), direction("priced"), direction("unused")],
    groups: { transfers: [group("taxi", { reason: "exchange_rate", currency: "KRW" })], journeys: [group("flight"), group("flight"), group("flight", { reason: "exchange_rate", currency: "JPY" }), group("rail"), group("bus")] },
    gaps: [{ from_id: "PUS", to_id: "HND" }],
  };
  const context = { searched: true, budget: 12000, rates: { MYR: 1 }, excludeUnpricedFlights: false, transitOff: false };
  assert.deepEqual(buildNextSteps({ ...state, ...context }).map(step => [step.id, plain(step.text), step.action?.label]), [
    ["airport-changes", "1 flight journey can't be used until you confirm the airport change GMP → ICN.", "Confirm airport change"],
    ["prices", "2 of 3 options are not fully priced: 2 airport transfer prices, 3 flight prices, 1 train price and 1 other price are missing. 1 option needs only airport transfer prices. Until then, options may exceed your RM 12,000 budget.", "Add prices"],
    ["exchange-rates", "Prices in KRW and JPY need exchange rates.", "Add rate"],
  ]);
  // 1 airport change + 2 transfer directions + 5 journey groups; city gaps count only when there is no option.
  assert.equal(needsInputCount(state), 8);
  assert.equal(needsInputCount({ ...state, routes: [] }), 9);

  const unresolved = city => `${city}: airport access time is unresolved; this movement is not usable until routing or a transfer assumption is provided`;
  const blocked = {
    ...state, routes: routes.slice(0, 1), airportChanges: [change("GMP", "ICN", 2), change("HND", "NRT", 1)],
    unresolvedAccess: [{ assumptions: [unresolved("Busan")] }, { assumptions: [unresolved("Seoul"), unresolved("Busan")] }],
    directions: [], groups: { transfers: [], journeys: [group("flight")] },
  };
  const steps = buildNextSteps({ ...blocked, ...context, budget: null, excludeUnpricedFlights: true, transitOff: true });
  assert.deepEqual(steps.map(step => [step.text, step.action?.target ?? null]), [
    ["3 flight journeys can't be used until you confirm 2 airport changes (GMP → ICN, HND → NRT).", "airport-changes"],
    ["2 journeys can't be used: the airport transfer time is unknown in Busan, Seoul.", "airport-fallback"],
    ["No option has a complete price yet: 1 flight price is missing.", "prices"],
    ["Options that need a flight without a price are hidden.", "show-unpriced-flights"],
    ["Trains, buses, coaches, subways and trams were not searched: transit search is not set up on this server.", null],
  ]);
  // 2 airport changes + 1 journey group + 2 cities with an unresolved access time.
  assert.equal(needsInputCount(blocked), 5);
  assert.deepEqual(buildNextSteps({ ...blocked, ...context, searched: false, excludeUnpricedFlights: true, transitOff: true }).map(step => step.id), ["airport-changes", "access-time", "prices"]);
});

test("an option keeps its signature when airport transfer prices change its ids", () => {
  const segments = (mode, source) => [{ mode, source, departure: "2026-12-04T00:00:00Z" }, { mode: "wait", source: "Flight readiness buffer", departure: "2026-12-04T00:45:00Z" }, { mode: "flight", source: "Google Flights", departure: "2026-12-04T10:15:00+08:00" }];
  const before = option("a", { movements: [flightTo("flight:x", "KUL", "PUS", { departure: "2026-12-04T00:00:00Z", segments: segments("transfer", "Airport access") })] });
  // A taxi estimate gives the flight a variant id and relabels its airport access with the taxi mode.
  const after = option("b", { movements: [flightTo("flight:x:transfer:1", "KUL", "PUS", { template_id: "flight:x", departure: "2026-12-03T23:50:00Z", segments: segments("taxi", "User-estimated airport access") })] });
  assert.equal(routeSignature(after), routeSignature(before));
  const later = option("c", { movements: [flightTo("flight:x", "KUL", "PUS", { segments: [{ mode: "flight", departure: "2026-12-04T12:15:00+08:00" }] })] });
  assert.notEqual(routeSignature(later), routeSignature(before));
  assert.notEqual(routeSignature({ ...before, arrival_gateway: "SIN" }), routeSignature(before));
});

test("route chains show each stay where it starts", () => {
  const route = option("r", {
    movements: [flightTo("f1", "KUL", "PUS", { arrival: "2026-12-04T09:54:00Z" }), flightTo("f2", "PUS", "SIN", { arrival: "2026-12-08T07:57:00Z" }), flightTo("f3", "SIN", "KUL", { mode: "rail", arrival: "2026-12-09T07:57:00Z" })],
    // Stays write their instants with "+00:00", movements with "Z".
    stays: [{ place_id: "PUS", arrival: "2026-12-04T09:54:00+00:00", departure: "2026-12-08T02:15:00+00:00", hours: 88.35 }],
  });
  assert.deepEqual(routeChain(route), { from: "KUL", steps: [{ mode: "flight", to: "PUS", hours: 88.35 }, { mode: "flight", to: "SIN", hours: null }, { mode: "rail", to: "KUL", hours: null }] });
});

test("price sources and combined-ticket statuses in plain words", () => {
  const offer = (source, label, id = "fare:x") => ({ id, source, label });
  assert.deepEqual([
    offer("provider", "Stale quote: Google Flights party fare"), offer("provider", "Google Flights one-way"), offer("provider", "GTFS fare products for party"), offer("provider", "Transitous fare"),
    offer("user", "Shared estimate: Kuala Lumpur → Busan · flight"), offer("user", "Manually entered whole-ticket party fare", "bundle:1"), offer("user", "ETS · whole party", "positioning-fare:s1"), offer("user", "Standalone flight fare"),
    offer("rule", "Trip airport transfer estimate"), offer("rule", "Configured driving cost", "driving:r"), offer("rule", "Rental: 3 day(s), pickup and drop-off", "charge:rental:1"), offer("rule", "Korea taxi"),
    offer("unknown", "flight", "unknown:x"),
  ].map(sourceLabel), [
    "Google Flights · older quote", "Google Flights", "Transit fare", "Transitous fare",
    "Your group price", "Your combined ticket price", "Your journey price", "Your price",
    "Your airport transfer price", "Driving cost (Cars settings)", "Rental settings", "Rule: Korea taxi",
    "Not priced",
  ]);
  assert.deepEqual(["requires_manual_quote", "success", "empty", "failed", "unsupported", "other"].map(bundleStatusLabel), ["Check the price yourself", "Quote found", "No results", "Search failed", "Not supported", "other"]);
});

test("purchase amounts state ranges, open-ended prices, missing rates and missing prices", () => {
  const amount = (low, high, currency = "MYR") => plain(purchaseAmount({ low, high, currency }, { USD: 4.5 }));
  assert.deepEqual([amount(2180, 2180), amount(210, 250), amount(900, null), amount(12000, 12000, "JPY"), amount(100, 120, "USD"), amount(null, null)],
    ["RM 2,180", "RM 210 – 250", "RM 900 or more", "JPY 12,000 · needs an exchange rate", "USD 100 – 120", "Not priced"]);
});

test("tickets and prices follow the itinerary: ticket, access, egress, airport change, then extra charges", () => {
  const names = { KUL: "Kuala Lumpur", PUS: "Busan", GMP: "Seoul", HND: "Tokyo" };
  const placeName = id => names[id] ?? (id.startsWith("airport:") ? `${id.slice(8)} airport` : id);
  const zoneOf = () => "Asia/Kuala_Lumpur";
  const f1 = flightTo("f1:transfer:h", "KUL", "PUS", { template_id: "f1", departure: "2026-12-04T00:00:00Z", segments: [{ mode: "transfer", departure: "2026-12-04T00:00:00Z" }, { mode: "flight", operator: "AirAsia X", service: "D7530", departure: "2026-12-04T01:30:00Z" }] });
  const f2 = flightTo("f2", "PUS", "HND", { departure: "2026-12-08T02:15:00Z" });
  f2.charges.push({ ...charge("f2:airport-transfer:1", "Airport transfer GMP → ICN", "airport:GMP", "airport:ICN"), mode: "rail", source: "user", low: 60, high: 60 });
  const f3 = flightTo("f3", "HND", "KUL", { departure: "2026-12-13T23:30:00Z" });
  const rental = { ...charge("rental:1", "Rental: 3 day(s), pickup and drop-off", "PUS", "PUS"), mode: "rental" };
  const route = option("r", {
    movements: [f1, f2, f3], extra_charges: [rental],
    purchases: [
      fare("rental:1", 300, 300, { id: "charge:rental:1", source: "rule", label: rental.kind }),
      { ...fare("f2", 900, 1000), id: "bundle:b1", movement_ids: ["f3", "f2"], kind: "round-trip", source: "user", label: "Manually entered whole-ticket party fare" },
      fare("f2:airport-transfer:1", 60, 60, { id: "charge:f2:airport-transfer:1", source: "user", label: "Airport transfer GMP → ICN" }),
      noFare("f1:transfer:h:egress", "Airport egress"),
      fare("f1:transfer:h", 2180, 2180, { id: "user:f1:f1:transfer:h", source: "user", label: "Standalone flight fare" }),
      noFare("f1:transfer:h:access", "Airport access"),
      fare("f2:access", 12000, 12000, { currency: "JPY", source: "rule", label: "Trip airport transfer estimate" }),
    ],
  });
  const rows = ticketRows(route, {}, placeName, zoneOf);
  assert.deepEqual(rows.map(row => [row.kind, plain(row.label), plain(row.amount), row.source, row.priced, row.componentId, row.removable]), [
    ["journey", "Flight Kuala Lumpur → Busan · 4 Dec · AirAsia X D7530", "RM 2,180", "Your price", true, "f1", true],
    ["transfer", "Taxi Kuala Lumpur → KUL airport", "Not priced", null, false, "f1:transfer:h:access", false],
    ["transfer", "Taxi PUS airport → Busan", "Not priced", null, false, "f1:transfer:h:egress", false],
    ["combined", "Combined ticket · Round trip · 2 flights", "RM 900 – 1,000", "Your combined ticket price", true, null, true],
    ["transfer", "Taxi Busan → PUS airport", "JPY 12,000 · needs an exchange rate", "Your airport transfer price", false, "f2:access", false],
    ["change", "Airport change GMP → ICN · Train", "RM 60", "Your price", true, null, false],
    ["charge", "Rental car · 3 days, pickup and drop-off", "RM 300", "Rental settings", true, "rental:1", false],
  ]);
  // A combined ticket lists its flights in itinerary order.
  assert.deepEqual(rows[3].flights.map(flight => flight.id), ["f2", "f3"]);
  assert.equal(ticketJourney(f3, placeName, () => "Asia/Tokyo"), "Tokyo → Kuala Lumpur · 14 Dec");
  // A combined ticket on template ids takes the place of its first flight.
  const templates = ticketRows(option("t", { movements: [f1, f2], purchases: [{ ...fare("x", 1500), id: "bundle:b2", movement_ids: ["f1", "f2"], kind: "multi-city", source: "user", label: "Manually entered whole-ticket party fare" }, noFare("f1:transfer:h:access", "Airport access")] }), {}, placeName, zoneOf);
  assert.deepEqual(templates.map(row => row.label), ["Combined ticket · Multi-city · 2 flights", "Taxi Kuala Lumpur → KUL airport"]);
});

test("combined-ticket searches and typed prices in plain words", () => {
  const placeName = id => ({ KUL: "Kuala Lumpur", GMP: "Seoul" })[id] ?? id;
  assert.equal(quoteLinkText({ kind: "round-trip", legs: [{ from_id: "KUL", to_id: "GMP", date: "2026-12-04" }, { from_id: "GMP", to_id: "KUL", date: "2026-12-14" }] }, placeName),
    "Round trip: Kuala Lumpur → Seoul (4 Dec) · Seoul → Kuala Lumpur (14 Dec)");
  assert.deepEqual(priceInputErrors("120", "", "myr"), {});
  assert.deepEqual(priceInputErrors("0", "0", "MYR"), {});
  assert.deepEqual(priceInputErrors("", "", "MY"), { low: "Enter a price of 0 or more.", currency: "Enter a 3-letter currency code." });
  assert.deepEqual(priceInputErrors("-1", "", "MYR"), { low: "Enter a price of 0 or more." });
  assert.deepEqual(priceInputErrors("200", "150", "MYR"), { high: "The highest price must be at least the lowest." });
  assert.deepEqual(priceInputErrors("200", "abc", "MYR"), { high: "The highest price must be at least the lowest." });
});

test("connections you add: text, and times read in each city's own time zone", () => {
  const placeName = id => ({ PUS: "Busan", HND: "Tokyo", LON: "London" })[id] ?? id;
  const zoneOf = id => ({ PUS: "Asia/Seoul", HND: "Asia/Tokyo", LON: "Europe/London" })[id] ?? "UTC";
  const form = { ...blankConnectionForm(), from: "PUS", to: "HND" };
  // Any time: the travel time in hours.
  const any = connectionFromForm({ ...form, hours: "4.5", distance: "" }, zoneOf, "assumed:a");
  assert.equal(any.errors, undefined);
  assert.deepEqual({ ...any.movement, segments: undefined, charges: undefined }, {
    id: "assumed:a", from_id: "PUS", to_id: "HND", mode: "bus", duration_minutes: 270, distance_km: null, departure: null, arrival: null,
    source: "User-defined connection", assumptions: ["User supplied connectivity and timing"], segments: undefined, charges: undefined, transfers: 0, vehicle_kind: null, search_url: null,
  });
  assert.equal(connectionText(any.movement, placeName, zoneOf), "Busan → Tokyo · Bus · 4 h 30 min · any time");
  // A car connection is a rental car.
  assert.equal(connectionFromForm({ ...form, mode: "car", hours: "2" }, zoneOf, "assumed:c").movement.vehicle_kind, "rental");
  // Fixed times: departure in Busan's time, arrival in Tokyo's time; the travel time is the time between them.
  const fixed = connectionFromForm({ ...form, fixed: true, hours: "", departure: "2026-12-07T09:00", arrival: "2026-12-07T13:30", distance: "580" }, zoneOf, "assumed:b");
  assert.equal(fixed.movement.departure, "2026-12-07T00:00:00.000Z");
  assert.equal(fixed.movement.arrival, "2026-12-07T04:30:00.000Z");
  assert.equal(fixed.movement.duration_minutes, 270);
  assert.equal(fixed.movement.distance_km, 580);
  assert.equal(connectionText(fixed.movement, placeName, zoneOf), "Busan → Tokyo · Bus · 4 h 30 min · Mon 7 Dec 09:00 → 13:30");
  assert.equal(connectionText({ ...fixed.movement, arrival: "2026-12-07T16:00:00.000Z" }, placeName, zoneOf), "Busan → Tokyo · Bus · 4 h 30 min · Mon 7 Dec 09:00 → Tue 8 Dec 01:00");
  // Errors, by field.
  assert.deepEqual(connectionFromForm({ ...form, to: "PUS", hours: "1" }, zoneOf, "x").errors, { places: "Choose two different places." });
  assert.deepEqual(connectionFromForm({ ...form, from: "", hours: "0", distance: "-1" }, zoneOf, "x").errors,
    { places: "Choose two different places.", hours: "Enter a travel time above 0.", distance: "Enter a distance of 0 or more." });
  assert.deepEqual(connectionFromForm({ ...form, fixed: true, departure: "2026-12-07T09:00" }, zoneOf, "x").errors, { arrival: "Enter both times, or choose Any time." });
  assert.deepEqual(connectionFromForm({ ...form, fixed: true }, zoneOf, "x").errors, { departure: "Enter both times, or choose Any time." });
  // 13:30 in Busan is 13:30 in Tokyo too (same offset): an arrival at 08:59 Tokyo time is before the departure.
  assert.deepEqual(connectionFromForm({ ...form, fixed: true, departure: "2026-12-07T09:00", arrival: "2026-12-07T08:59" }, zoneOf, "x").errors, { arrival: "Arrival must be after departure." });
  // A local time that a clock change skips.
  assert.deepEqual(connectionFromForm({ ...form, to: "LON", fixed: true, departure: "2026-03-28T09:00", arrival: "2026-03-29T01:30" }, zoneOf, "x").errors,
    { arrival: "This local time does not exist because of a timezone clock change." });
});

test("price rules: list text, form values and validation", () => {
  const placeName = id => id.startsWith("airport:") ? `${id.slice(8)} airport` : ({ PUS: "Busan" })[id] ?? id;
  const rule = { id: "r1", name: "Busan taxi", mode: "taxi", from_id: "PUS", to_id: "airport:PUS", service: "Airport access", country_code: "KR", kind: "fixed", low: 80, high: 120, unit: "vehicle", capacity: 4, currency: "MYR", priority: 0 };
  assert.equal(plain(ruleText(rule, placeName)), "Taxi · Busan → PUS airport · Airport access · RM 80 – 120 · per vehicle (4 seats) · from KR · priority 0");
  assert.equal(plain(ruleText({ ...rule, mode: "*", from_id: null, to_id: null, service: null, country_code: null, kind: "per-km", low: 0.5, high: null, unit: "party", priority: 5 }, placeName)),
    "Any · RM 0.50/km · per group · priority 5");
  assert.equal(plain(ruleText({ ...rule, mode: "rental", from_id: null, service: null, unit: "person", currency: "JPY", low: 3000, high: 3000 }, placeName)),
    "Rental car · any place → PUS airport · JPY 3,000 · per person · from KR · priority 0");
  // Edit loads the rule; saving it unchanged gives the same rule.
  assert.deepEqual(ruleFromForm(ruleForm(rule)).rule, rule);
  assert.deepEqual(ruleFromForm(ruleForm({ ...rule, high: null })).rule, { ...rule, high: null });
  // A new rule: blank optional fields are null, codes are upper case, a blank priority is 0.
  const blank = blankRuleForm("r2");
  assert.deepEqual(ruleFromForm({ ...blank, name: " Taxi ", low: "30", currency: "myr", country_code: "kr", service: " ", priority: "" }).rule,
    { id: "r2", name: "Taxi", mode: "*", from_id: null, to_id: null, service: null, country_code: "KR", kind: "fixed", low: 30, high: null, unit: "person", capacity: 4, currency: "MYR", priority: 0 });
  // Seats count only per vehicle; a hidden invalid value goes back to 4.
  assert.equal(ruleFromForm({ ...blank, name: "a", low: "1", capacity: "12" }).rule.capacity, 4);
  assert.deepEqual(ruleFromForm({ ...blank, name: "a", low: "1", unit: "vehicle", capacity: "12" }).errors, { capacity: "Enter 1 to 9 seats." });
  assert.deepEqual(ruleFromForm({ ...blank, name: "a", low: "1", unit: "vehicle", capacity: "" }).errors, { capacity: "Enter 1 to 9 seats." });
  assert.deepEqual(ruleFromForm({ ...blank, low: "50", high: "40", currency: "MY", country_code: "KOR", priority: "1.5" }).errors, {
    name: "Enter a rule name.", high: "The highest price must be at least the lowest.", currency: "Enter a 3-letter currency code.",
    country_code: "Enter a 2-letter country code.", priority: "Enter a whole number.",
  });
  assert.deepEqual(ruleFromForm({ ...blank, name: "a" }).errors, { low: "Enter a price of 0 or more." });
});
