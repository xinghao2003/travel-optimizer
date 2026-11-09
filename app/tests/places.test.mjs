import assert from "node:assert/strict";
import { test } from "node:test";
import { loadTs } from "./loadTs.mjs";
const { PlaceCatalog } = await loadTs("../src/native/places.ts");

const row = (id, name, latitude, longitude, search, population) =>
  ({ place: { id, name, latitude, longitude, timezone: "UTC", country_code: "XX", airport_codes: [], flight_code: null }, search, population });
const catalog = new PlaceCatalog({ schema_version: 2, rows: [
  row("geo:1", "São Paulo", -23.5, -46.6, "sao paulo", 12000000),
  row("geo:2", "Paulo Afonso", -9.4, -38.2, "paulo afonso", 100000),
  row("geo:3", "Suva", -18.1, 178.4, "suva", 90000),
  row("geo:4", "Apia", -13.8, -171.8, "apia", 40000),
  row("geo:5", "Nadi", -17.8, 177.4, "nadi", 40000),
] });

test("search ignores case and accents and ranks exact names, whole words, then population", () => {
  assert.equal(catalog.normalize("SÃO Pāulo"), "sao paulo");
  assert.deepEqual(catalog.search("são paulo").map(p => p.id), ["geo:1"]);
  assert.deepEqual(catalog.search("paulo").map(p => p.id), ["geo:1", "geo:2"]);
  assert.deepEqual(catalog.search("Paulo Afonso").map(p => p.id), ["geo:2"]);
  assert.throws(() => catalog.search("p"), /2 to 80 characters/);
});

test("nearest places cross the date line and report rounded distances", () => {
  const found = catalog.nearest(-16, 179.9, 2);
  assert.deepEqual(found.map(p => p.id), ["geo:3", "geo:5"]);
  assert.equal(found[0].distance_km, Math.round(found[0].distance_km * 10) / 10);
  assert.deepEqual(catalog.nearest(-14, 179.9, 3).map(p => p.id).sort(), ["geo:3", "geo:4", "geo:5"]);
});

test("an outdated catalog version is rejected", () => {
  assert.throws(() => new PlaceCatalog({ schema_version: 1, rows: [] }), /Unsupported place catalog version/);
});
