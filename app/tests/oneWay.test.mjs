import assert from "node:assert/strict";
import { test } from "node:test";
import { loadTs } from "./loadTs.mjs";
const { parseMovement, parseOffer, parseSpec } = await loadTs("../src/native/contracts.ts");
const { bounds, tasksFor } = await loadTs("../src/native/discovery.ts");
const { discoveryKey } = await loadTs("../src/native/discovery-key.ts");
const { solveNative } = await loadTs("../src/native/solver.ts");
const { micros } = await loadTs("../src/native/time.ts");

const place = (id, code = null) => ({ id, name: id, latitude: 3, longitude: 101, timezone: "UTC", country_code: "", airport_codes: code ? [code] : [], flight_code: code });
const HOME = place("home"), A = place("a"), B = place("b");
const trip = fields => parseSpec({ home: HOME, visits: [{ place: A }], start_date: "2027-02-10", end_date: "2027-02-12", modes: ["flight", "rail"], ...fields });
const dt = (day, hour = 9) => `2027-02-${day}T${String(hour).padStart(2, "0")}:00:00Z`;
const movement = (id, from, to, departure, arrival) => parseMovement({ id, from_id: from.id, to_id: to.id, mode: "flight", departure, arrival,
  duration_minutes: (Date.parse(arrival) - Date.parse(departure)) / 60000, source: "fixture" });
const fare = (id, amount) => parseOffer({ id: `fare:${id}`, movement_ids: [id], low: amount, high: amount });
const flightPairs = tasks => new Set(tasks.filter(t => t.kind === "flight").map(t => `${t.from_id}>${t.to_id}`));

function flightTrip(oneWay, gateway) {
  const home = place("home", "PEN"), seoul = place("a", "SEL"), busan = place("b", "PUS");
  return parseSpec({ home, ...gateway, one_way: oneWay, home_arrival_latest: "12:00:00", home_departure_earliest: "12:00:00",
    visits: [{ place: seoul, min_stay_hours: 12 }, { place: busan, min_stay_hours: 12 }], start_date: "2027-02-10", end_date: "2027-02-14", modes: ["flight"] });
}

test("one-way trip from home does not search back home or round trips", () => {
  const spec = flightTrip("from_home", { arrivals: [place("end", "KUL")] });
  assert.deepEqual(spec.arrivals.map(p => p.id), ["home"]);
  assert.equal(spec.home_arrival_latest, null);
  const tasks = tasksFor(spec, {}, false);
  assert.deepEqual(flightPairs(tasks), new Set(["home>a", "home>b", "a>b", "b>a"]));
  assert.equal(tasks.some(t => t.kind === "bundle"), false);
  assert.notEqual(discoveryKey(spec), discoveryKey({ ...spec, one_way: null }));
});

test("one-way trip to home does not search from home", () => {
  const spec = flightTrip("to_home", { departures: [place("start", "KUL")] });
  assert.deepEqual(spec.departures.map(p => p.id), ["home"]);
  assert.equal(spec.home_departure_earliest, null);
  const tasks = tasksFor(spec, {}, false);
  assert.deepEqual(flightPairs(tasks), new Set(["a>home", "b>home", "a>b", "b>a"]));
  assert.equal(tasks.some(t => t.kind === "bundle"), false);
  assert.notEqual(discoveryKey(spec), discoveryKey({ ...spec, one_way: "from_home" }));
});

const moves = [movement("out", HOME, A, dt(10), dt(10, 10)), movement("ab", A, B, dt(11), dt(11, 10)), movement("back", B, HOME, dt(12), dt(12, 10))];
const solve = oneWay => {
  const spec = trip({ visits: [{ place: A, min_stay_hours: 5 }, { place: B, min_stay_hours: 5 }], one_way: oneWay, ordered_visits: true });
  return { spec, result: solveNative({ spec, movements: moves, offers: moves.map(m => fare(m.id, 10)), rules: [] }).result };
};

test("one-way trip from home ends in the last city", () => {
  const { spec, result } = solve("from_home");
  assert.equal(result.routes.length, 1);
  const [route] = result.routes;
  assert.deepEqual(route.movements.map(m => m.id), ["out", "ab"]);
  assert.equal(route.stays.at(-1).place_id, "b");
  assert.equal(micros(route.stays.at(-1).departure), bounds(spec)[1]);
});

test("one-way trip to home starts in the first city", () => {
  const { spec, result } = solve("to_home");
  assert.equal(result.routes.length, 1);
  const [route] = result.routes;
  assert.deepEqual(route.movements.map(m => m.id), ["ab", "back"]);
  assert.equal(route.stays[0].place_id, "a");
  assert.equal(micros(route.stays[0].arrival), bounds(spec)[0]);
});
