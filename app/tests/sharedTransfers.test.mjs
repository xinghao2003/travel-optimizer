import assert from "node:assert/strict";
import { test } from "node:test";
import { loadTs } from "./loadTs.mjs";
const { applyMissingInfo, applyWithSharedTransfers, parseApplyChanges } = await loadTs("../src/native/edits.ts");
const { effectiveTransfers, prepareSolverInput, usesSharedTransfers } = await loadTs("../src/native/preparation.ts");
const { profileOf } = await loadTs("../src/lib/plan.ts");
const { blankTrip } = await loadTs("../src/lib/planner.ts");

const place = (id, airport, extra = {}) => ({ id, name: id, latitude: 3, longitude: 101, timezone: "Asia/Kuala_Lumpur", country_code: "MY", airport_codes: [airport], flight_code: airport, ...extra });
const spec = { ...blankTrip(), home: place("KUL", "KUL"), visits: [{ place: place("SEL", "ICN"), min_stay_hours: 24 }] };
const catalog = { metros: {}, airports: {} };
const way = (from_id, to_id, low, extra = {}) => ({ mode: "taxi", duration_minutes: null, from_id, to_id, adults: 1, low, high: low, currency: "MYR", ...extra });
const trip = (own, extra = {}) => ({ id: "t", revision: 1, spec, snapshot: null, latest_job_id: null, offers: [], airport_connections: [], ...(own ? { airport_transfer_estimates: own } : {}), ...extra });
const text = items => items.map(item => `${item.from_id}>${item.to_id} ${item.mode} ${item.low} x${item.adults}`).sort();
const request = transfers => parseApplyChanges({ expected_revision: 1, transfers });

test("a trip's own airport transfer ways replace the shared ways of that direction and party size", () => {
  const own = [way("KUL", "airport:KUL", 50)];
  const shared = [way("KUL", "airport:KUL", 99), way("KUL", "airport:KUL", 20, { mode: "rail", duration_minutes: 30 }), way("KUL", "airport:KUL", 120, { adults: 2 }), way("SEL", "airport:ICN", 60)];
  assert.deepEqual(text(effectiveTransfers(own, shared)), ["KUL>airport:KUL taxi 120 x2", "KUL>airport:KUL taxi 50 x1", "SEL>airport:ICN taxi 60 x1"]);
  assert.equal(usesSharedTransfers(trip(own), [way("KUL", "airport:KUL", 99)]), false);
  assert.equal(usesSharedTransfers(trip(own), [way("SEL", "airport:ICN", 60)]), true);
  // Another party size, or a city that is not in the trip.
  assert.equal(usesSharedTransfers(trip(own), [way("SEL", "airport:ICN", 60, { adults: 2 }), way("PEN", "airport:PEN", 30)]), false);
});

test("the optimizer prices airport transfers with the shared ways of the trip's cities", () => {
  const shared = [way("SEL", "airport:ICN", 60), way("KUL", "airport:KUL", 99), way("PEN", "airport:PEN", 30)];
  const rules = prepareSolverInput(trip([way("KUL", "airport:KUL", 50)]), [], { shared_transfers: shared }).input.rules;
  assert.deepEqual(rules.map(rule => `${rule.from_id}>${rule.to_id} ${rule.low}`).sort(), ["KUL>airport:KUL 50", "SEL>airport:ICN 60"]);
  assert.deepEqual(prepareSolverInput(trip(null), [], {}).input.rules, []);
});

test("a changed airport transfer direction is saved for all trips; an unchanged one keeps its source", () => {
  const own = [way("KUL", "airport:KUL", 50)];
  const shared = [way("KUL", "airport:KUL", 99), way("SEL", "airport:ICN", 60), way("airport:KUL", "KUL", 45), way("PEN", "airport:PEN", 30)];
  // What the planner shows for the trip: its own way, and the shared ways of its other directions.
  const shown = [way("KUL", "airport:KUL", 50), way("SEL", "airport:ICN", 60), way("airport:KUL", "KUL", 45)];
  assert.deepEqual(text(effectiveTransfers(own, shared.filter(item => item.from_id !== "PEN"))), text(shown));

  // A new price for Seoul → ICN, a new direction ICN → Seoul, and airport KUL → KUL cleared.
  const result = applyWithSharedTransfers(trip(own), request([way("KUL", "airport:KUL", 50), way("SEL", "airport:ICN", 70), way("airport:ICN", "SEL", 65)]), catalog, shared);
  assert.deepEqual(text(result.trip.airport_transfer_estimates), ["KUL>airport:KUL taxi 50 x1"]);
  assert.deepEqual(text(result.shared), ["KUL>airport:KUL taxi 99 x1", "PEN>airport:PEN taxi 30 x1", "SEL>airport:ICN taxi 70 x1", "airport:ICN>SEL taxi 65 x1"]);
  assert.deepEqual(text(result.changed).map(item => item.split(" ")[0]), ["SEL>airport:ICN", "airport:ICN>SEL", "airport:KUL>KUL"]);
  assert.equal(result.trip.revision, 2);

  // The trip's own way changes: it becomes the shared way, and the trip has no own way left.
  const replaced = applyWithSharedTransfers(trip(own), request([way("KUL", "airport:KUL", 55), way("SEL", "airport:ICN", 60), way("airport:KUL", "KUL", 45)]), catalog, shared);
  assert.deepEqual(replaced.trip.airport_transfer_estimates, []);
  assert.deepEqual(text(replaced.shared), ["KUL>airport:KUL taxi 55 x1", "PEN>airport:PEN taxi 30 x1", "SEL>airport:ICN taxi 60 x1", "airport:KUL>KUL taxi 45 x1"]);

  // Nothing changes: a fixed price reads the same without its highest price. The trip keeps its own way.
  const same = applyWithSharedTransfers(trip(own), request([way("KUL", "airport:KUL", 50, { high: null }), way("SEL", "airport:ICN", 60), way("airport:KUL", "KUL", 45)]), catalog, shared);
  assert.equal(same.shared, null);
  assert.deepEqual(text(same.trip.airport_transfer_estimates), ["KUL>airport:KUL taxi 50 x1"]);

  // A request without airport transfers is applyMissingInfo, and reads no shared way.
  const rates = parseApplyChanges({ expected_revision: 1, exchange_rates: { USD: 4.5 } });
  assert.deepEqual(applyWithSharedTransfers(trip(own), rates, catalog, shared), { trip: applyMissingInfo(trip(own), rates, catalog), shared: null, changed: [] });
  // A shared way deleted by its id in the trip's list (CSV editing).
  const deleted = applyWithSharedTransfers(trip(null), parseApplyChanges({ expected_revision: 1, deletions: [{ kind: "airport_transfer", id: JSON.stringify(["SEL", "airport:ICN", 1, "taxi"]) }] }), catalog, shared);
  assert.deepEqual(text(deleted.shared), ["KUL>airport:KUL taxi 99 x1", "PEN>airport:PEN taxi 30 x1", "airport:KUL>KUL taxi 45 x1"]);
});

test("the profile holds what a new trip starts with", () => {
  const full = { ...spec, departures: [spec.home, place("PEN", "PEN")], arrivals: [spec.home, place("PEN", "PEN")], adults: 2, exchange_rates: { MYR: 1, KRW: 0.0032 },
    cars: { ...spec.cars, own_enabled: true, rental_enabled: true, rental_pickups: ["SEL"], rental_dropoffs: ["SEL"] },
    positioning_policies: [], positioning_patterns: [{ id: "p", direction: "outbound", gateway_id: "PEN", mode: "bus", first: "06:00", last: "22:00", every_minutes: 30, duration_minutes: 300, fare_amount: 90, currency: "MYR", label: "Bus" }],
    positioning_services: [{ id: "s", direction: "outbound", gateway_id: "PEN", mode: "bus", departure: "2026-12-14T00:00:00Z", arrival: "2026-12-14T05:00:00Z", fare_amount: null, currency: "MYR", label: "Bus" }] };
  const profile = profileOf(full);
  assert.deepEqual(Object.keys(profile).sort(), ["adults", "arrivals", "cars", "departures", "exchange_rates", "home", "positioning_patterns", "timing"]);
  assert.deepEqual([profile.home.id, profile.departures.map(item => item.id), profile.adults, profile.exchange_rates.KRW], ["KUL", ["KUL", "PEN"], 2, 0.0032]);
  // Rental pickup and drop-off places belong to one trip.
  assert.deepEqual([profile.cars.own_enabled, profile.cars.rental_enabled, profile.cars.rental_pickups, profile.cars.rental_dropoffs], [true, false, [], []]);
  // A new trip: the blank trip with the profile, so its dates, cities to visit and transport stay blank.
  const next = { ...blankTrip(), ...profile };
  assert.deepEqual([next.home.id, next.visits, next.positioning_services, next.one_way], ["KUL", [], undefined, undefined]);
});
