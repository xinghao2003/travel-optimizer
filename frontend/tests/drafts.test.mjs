import assert from "node:assert/strict";
import { test } from "node:test";
import { loadTs } from "./loadTs.mjs";
const { activeFares, airportChangeFieldId, buildAirportConnections, buildTransferEstimates, canonicalFares, canonicalIds, countDrafts, invalidDraftFields, knownComponentIds, nextTransferMode, removeComponent, sameAirportChange, sameFare, sameTransferRows, savedAirportChange, savedTransferRows, stageFare, storedOfferId, transferFieldId, transferKey } = await loadTs("../src/lib/drafts.ts");

// Ids from the priced demo trip: a flight template and its transfer variant.
const T = "flight:b4c409a9636f4407fc3f7874";
const V = `${T}:transfer:b3d0287e55eaa48a3154a455`;
const fare = (component_ids, low = 10, label = "x") => ({ component_ids, low, high: low, currency: "MYR", label });

test("canonical ids map variants to their template and remove duplicates", () => {
  const templateOf = new Map([[V, T], [`${T}:transfer:other`, T], ["rail:GMP:PUS", "rail:GMP:PUS"]]);
  assert.deepEqual(canonicalIds([V, `${T}:transfer:other`, `${T}:access`, "rail:GMP:PUS"], templateOf), [T, `${T}:access`, "rail:GMP:PUS"]);
  assert.deepEqual(canonicalIds([], templateOf), []);
});

test("a purchase copied from a template offer maps back to the stored offer", () => {
  assert.equal(storedOfferId({ id: `user:${T}:${V}`, movement_ids: [V] }), `user:${T}`);
  assert.equal(storedOfferId({ id: "user:assumed:u1:assumed:u1@c0ffee", movement_ids: ["assumed:u1@c0ffee"] }), "user:assumed:u1");
});

test("purchases that are not copies keep their id", () => {
  assert.equal(storedOfferId({ id: `user:${V}`, movement_ids: [V] }), `user:${V}`);
  assert.equal(storedOfferId({ id: `user:${T}:access`, movement_ids: [`${T}:access`] }), `user:${T}:access`);
  assert.equal(storedOfferId({ id: "bundle:7", movement_ids: [V, "flight:other"] }), "bundle:7");
  assert.equal(storedOfferId({ id: `charge:${T}:airport-transfer:1`, movement_ids: [`${T}:airport-transfer:1`] }), `charge:${T}:airport-transfer:1`);
  assert.equal(storedOfferId({ id: `gf:1:${V}`, movement_ids: [V] }), `gf:1:${V}`);
});

test("staging a fare takes its components from other drafts and drops drafts left empty", () => {
  const drafts = { a: fare(["1", "2"]), b: fare(["3"]), c: fare(["4"]) };
  const staged = stageFare(drafts, "d", fare(["2", "3"], 30));
  assert.deepEqual(Object.keys(staged), ["a", "c", "d"]);
  assert.deepEqual(staged.a.component_ids, ["1"]);
  assert.deepEqual(staged.d, fare(["2", "3"], 30));
  assert.deepEqual(drafts.a.component_ids, ["1", "2"]);
  const restaged = stageFare(staged, "a", fare(["1"], 12));
  assert.deepEqual(Object.keys(restaged), ["c", "d", "a"]);
  assert.equal(restaged.a.low, 12);
});

test("active fares keep known components and skip drafts with none left", () => {
  const drafts = { a: fare(["1", "gone"]), b: fare(["gone"]), c: fare(["3"]) };
  assert.deepEqual(activeFares(drafts, new Set(["1", "3"])), [fare(["1"]), fare(["3"])]);
});

const rows = [
  { from_id: "KUL", to_id: "airport:KUL", label: "Kuala Lumpur → KUL airport" },
  { from_id: "airport:PUS", to_id: "PUS", label: "PUS airport → Busan" },
];
const estimate = (from_id, to_id, adults, extra = {}) => ({ from_id, to_id, adults, mode: "taxi", duration_minutes: null, low: 100, high: 100, currency: "MYR", ...extra });
const way = (mode, low = "", high = "", duration = "", currency = "MYR") => ({ mode, low, high, duration, currency });

test("transfer estimates keep other party sizes and directions without a draft", () => {
  const saved = [
    estimate("KUL", "airport:KUL", 2, { low: 130, high: 130 }),
    estimate("KUL", "airport:KUL", 3, { low: 180, high: null }),
    estimate("airport:PUS", "PUS", 2, { low: 95, high: 95 }),
    estimate("airport:XXX", "XXX", 3),
  ];
  const drafts = { [transferKey("airport:PUS", "PUS", 2)]: [way("taxi"), way("rail", "12.5", "", "70", "krw")] };
  assert.deepEqual(buildTransferEstimates(rows, saved, drafts, 2), [
    saved[1],
    saved[0],
    { from_id: "airport:PUS", to_id: "PUS", adults: 2, mode: "rail", duration_minutes: 70, low: 12.5, high: null, currency: "KRW" },
  ]);
});

test("a fully blank taxi row and an empty draft give no estimate for that direction", () => {
  const saved = [estimate("KUL", "airport:KUL", 2), estimate("airport:PUS", "PUS", 2)];
  const drafts = { [transferKey("KUL", "airport:KUL", 2)]: [way("taxi", "", "", "", "")], [transferKey("airport:PUS", "PUS", 2)]: [] };
  assert.deepEqual(buildTransferEstimates(rows, saved, drafts, 2), []);
  assert.deepEqual(buildTransferEstimates(rows, saved, { [transferKey("KUL", "airport:KUL", 2)]: [way("taxi", "", "", "35")] }, 2), [
    { from_id: "KUL", to_id: "airport:KUL", adults: 2, mode: "taxi", duration_minutes: 35, low: null, high: null, currency: "MYR" },
    saved[1],
  ]);
});

test("transfer estimates report the first invalid value with the direction label", () => {
  const build = (...ways) => () => buildTransferEstimates(rows, [], { [transferKey("KUL", "airport:KUL", 2)]: ways }, 2);
  assert.throws(build(way("taxi", "50"), way("taxi", "60")), { message: "Kuala Lumpur → KUL airport: use each way once." });
  const price = { message: "Kuala Lumpur → KUL airport: enter a price of 0 or more, and a highest price at least as large." };
  assert.throws(build(way("taxi", "-1")), price);
  assert.throws(build(way("taxi", "", "50")), price);
  assert.throws(build(way("taxi", "60", "50")), price);
  assert.throws(build(way("rail", "20")), { message: "Kuala Lumpur → KUL airport: enter a travel time above 0 for Train." });
  assert.throws(build(way("taxi", "20", "", "0")), { message: "Kuala Lumpur → KUL airport: enter a travel time above 0 for Taxi." });
  assert.throws(build(way("taxi", "20", "", "", "RM")), { message: "Kuala Lumpur → KUL airport: enter a 3-letter currency code." });
});

const connection = (from_airport, to_airport, extra = {}) => ({ from_airport, to_airport, mode: "bus", duration_minutes: 90, fare_amount: null, currency: "MYR", ...extra });
const change = (mode, duration = "", fare = "", currency = "MYR") => ({ mode, duration, fare, currency });

test("airport connection drafts merge into the saved list as changes", () => {
  const saved = [connection("GMP", "ICN", { mode: "rail", duration_minutes: 70, fare_amount: 60 }), connection("NRT", "HND"), connection("KIX", "ITM")];
  const drafts = {
    "NRT>HND": null,
    "KIX>ITM": change(""),
    "CTS>OKD": change("taxi", "45", "", "jpy"),
    "HND>NRT": change("coach", "75", "3200", "jpy"),
  };
  assert.deepEqual(buildAirportConnections(saved, drafts), [
    connection("CTS", "OKD", { mode: "taxi", duration_minutes: 45 }),
    saved[0],
    connection("HND", "NRT", { mode: "coach", duration_minutes: 75, fare_amount: 3200, currency: "JPY" }),
  ]);
  assert.deepEqual(buildAirportConnections(saved, {}), [saved[0], saved[2], saved[1]]);
  assert.deepEqual(buildAirportConnections([], { "GMP>ICN": change("rail", "30", "5", "") }), [connection("GMP", "ICN", { mode: "rail", duration_minutes: 30, fare_amount: 5 })]);
});

test("airport connection drafts report the first invalid value with the pair", () => {
  const build = draft => () => buildAirportConnections([], { "GMP>ICN": draft });
  const incomplete = { message: "GMP → ICN: choose a way and a time above 0, or clear the row." };
  assert.throws(build(change("", "30")), incomplete);
  assert.throws(build(change("rail", "0")), incomplete);
  assert.throws(build(change("rail", "", "10")), incomplete);
  assert.throws(build(change("rail", "30", "-5")), { message: "GMP → ICN: enter a price of 0 or more." });
  assert.throws(build(change("rail", "30", "5", "RM")), { message: "GMP → ICN: enter a 3-letter currency code." });
});

test("draft counts by kind", () => {
  assert.deepEqual(countDrafts({ fares: { a: fare(["1"]), b: fare(["2"]) }, transfers: { [transferKey("KUL", "airport:KUL", 2)]: [] }, airportChanges: { "GMP>ICN": null } }),
    { airportChanges: 1, transfers: 1, prices: 2 });
  assert.deepEqual(countDrafts({ fares: {}, transfers: {}, airportChanges: {} }), { airportChanges: 0, transfers: 0, prices: 0 });
});

test("undoing one component removes it from every fare draft", () => {
  const drafts = { a: fare(["1", "2"]), b: fare(["2"]), c: fare(["3"]) };
  assert.deepEqual(removeComponent(drafts, "2"), { a: fare(["1"]), c: fare(["3"]) });
});

test("stored fare drafts on variant ids move to their template ids", () => {
  const templateOf = new Map([[V, T]]);
  assert.deepEqual(canonicalFares({ a: fare([V, "x"]), b: fare([T], 20) }, templateOf), { a: fare(["x"]), b: fare([T], 20) });
});

test("known components come from the GET field, else from the snapshot and the routes", () => {
  const movement = (id, charges = []) => ({ id, charges: charges.map(id => ({ id })) });
  const routes = [{ movements: [movement(V, [`${V}:access`])], extra_charges: [{ id: "charge:rental" }] }];
  assert.deepEqual([...knownComponentIds({ fare_component_ids: ["a"], snapshot: null }, routes)], ["a"]);
  assert.deepEqual([...knownComponentIds({ snapshot: { movements: [movement(T, [`${T}:egress`])] } }, routes)], [T, `${T}:egress`, V, `${V}:access`, "charge:rental"]);
  assert.deepEqual([...knownComponentIds(null, [])], []);
});

test("a staged price equal to the saved one changes nothing", () => {
  assert.equal(sameFare({ low: 10, high: 10, currency: "myr" }, { low: 10, high: 10, currency: "MYR" }), true);
  assert.equal(sameFare({ low: 10, high: null, currency: "MYR" }, { low: 10, high: 10, currency: "MYR" }), false);
  assert.equal(sameFare({ low: 10, high: 10, currency: "MYR" }, undefined), false);
});

test("saved transfer rows as drafts, and equal rows", () => {
  const saved = [estimate("KUL", "airport:KUL", 2, { low: 95, high: 95 }), estimate("KUL", "airport:KUL", 3), estimate("KUL", "airport:KUL", 2, { mode: "rail", duration_minutes: 40, low: null, high: null })];
  const rowsKul = savedTransferRows(saved, "KUL", "airport:KUL", 2);
  assert.deepEqual(rowsKul, [way("taxi", "95", "95"), way("rail", "", "", "40")]);
  assert.deepEqual(savedTransferRows(saved, "airport:PUS", "PUS", 2), [way("taxi")]);
  assert.equal(sameTransferRows([way("taxi", "95.0", ""), way("rail", "", "", "40", "myr")], rowsKul), true);
  assert.equal(sameTransferRows([way("taxi", "96"), way("rail", "", "", "40")], rowsKul), false);
  assert.equal(sameTransferRows([], [way("taxi")]), true);
  assert.equal(sameTransferRows([way("taxi", "", "", "", "")], []), true);
});

test("saved airport changes as drafts, and equal drafts", () => {
  const saved = savedAirportChange(connection("GMP", "ICN", { mode: "rail", duration_minutes: 70, fare_amount: 60 }));
  assert.deepEqual(saved, change("rail", "70", "60"));
  assert.equal(savedAirportChange(undefined), null);
  assert.equal(sameAirportChange(change("rail", "70.0", "60", "myr"), saved), true);
  assert.equal(sameAirportChange(change("rail", "70", "", "KRW"), change("rail", "70")), true);
  assert.equal(sameAirportChange(change(""), null), true);
  assert.equal(sameAirportChange(null, saved), false);
});

test("invalid draft fields are listed by input id, airport changes first", () => {
  const drafts = {
    airportChanges: { "GMP>ICN": change("rail", "", "-1"), "HND>NRT": null },
    transfers: {
      [transferKey("KUL", "airport:KUL", 2)]: [way("taxi", "20"), way("rail", "5")],
      [transferKey("airport:PUS", "PUS", 3)]: [way("rail")],
    },
  };
  assert.deepEqual(invalidDraftFields(drafts, rows, 2), [
    airportChangeFieldId("GMP>ICN", "duration"), airportChangeFieldId("GMP>ICN", "fare"),
    transferFieldId("KUL", "airport:KUL", 1, "duration"),
  ]);
  assert.equal(transferFieldId("KUL", "airport:KUL", 0, "low"), "transfer-low-KUL>airport:KUL-0");
  assert.deepEqual(invalidDraftFields({ airportChanges: {}, transfers: { [transferKey("KUL", "airport:KUL", 2)]: [way("taxi", "", "9")] } }, rows, 2), [transferFieldId("KUL", "airport:KUL", 0, "low")]);
});

test("another way adds the first way not used yet, taxi first", () => {
  assert.equal(nextTransferMode([]), "taxi");
  assert.equal(nextTransferMode([{ mode: "taxi" }]), "rail");
  assert.equal(nextTransferMode([{ mode: "rail" }, { mode: "taxi" }, { mode: "bus" }]), "coach");
  assert.equal(nextTransferMode(["taxi", "rail", "bus", "coach", "subway", "tram", "car"].map(mode => ({ mode }))), null);
});
