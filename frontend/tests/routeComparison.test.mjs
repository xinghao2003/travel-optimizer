import assert from "node:assert/strict";
import { test } from "node:test";
import { loadTs } from "./loadTs.mjs";
const { compareRoute, marginalComparisons } = await loadTs("../src/lib/routeComparison.ts");
const { sortRoutes } = await loadTs("../src/lib/present.ts");
const route = (id, price, hours, extra = {}) => ({ id, total_cost_myr: price, cost_low_myr: price ?? 0,
  cost_high_myr: price, stay_hours: hours, travel_hours: 24, ...extra });
const compact = text => text.replaceAll(/\s/g, "");

test("selected-baseline deltas use full precision and distinguish upgrade cost from total cost per hour", () => {
  const base = route("base", 2173.5, 184.7667);
  const candidate = route("candidate", 2541.5, 190.4333, { travel_hours: 18 });
  const result = compareRoute(candidate, base);
  assert.match(compact(result.summary), /\+RM368.*\+5\.7cityh/);
  assert.equal(compact(result.rate), "RM64.94/extracityh");
  assert.ok(result.details.some(line => line.includes("−6.0 travel h")));
  assert.ok(result.details.some(line => line.includes("24 hours")));
  assert.equal(base.stay_hours, 184.7667);
});

test("cheaper/shorter, cheaper/longer, equal times, and free time avoid misleading upgrade rates", () => {
  const base = route("base", 100, 100);
  const shorter = compareRoute(route("cheap", 60, 90), base);
  assert.equal(shorter.rate, null);
  assert.ok(shorter.details.some(line => compact(line).includes("Savingspercityhourgivenup:RM4")));
  assert.ok(compareRoute(route("dominates", 90, 110), base).details.includes("Cheaper and more city time."));
  assert.ok(compareRoute(route("worse", 110, 90), base).details.includes("Costs more and gives less city time."));
  assert.equal(compareRoute(route("same-time", 110, 100), base).rate, null);
  const free = compareRoute(route("free", 100, 110), base);
  assert.match(free.summary, /Same price/);
  assert.equal(free.rate, null);
  assert.ok(free.details.includes("More city time at no extra cost."));
  assert.match(compareRoute(route("tiny", 110, 100.0001), base).summary, /\+<0.1 city h/);
});

test("bounded differences use conservative intervals; incomplete prices never become zero-cost upgrades", () => {
  const base = route("base", null, 100, { cost_low_myr: 100, cost_high_myr: 120 });
  const candidate = route("candidate", null, 110, { cost_low_myr: 150, cost_high_myr: 180 });
  const result = compareRoute(candidate, base);
  assert.match(compact(result.summary), /\+RM30to\+RM80/);
  assert.equal(compact(result.rate), "RM3toRM8/extracityh");
  const overlap = compareRoute(route("overlap", null, 110, { cost_low_myr: 110, cost_high_myr: 130 }), base);
  assert.match(compact(overlap.summary), /−RM10to\+RM30/);
  assert.equal(overlap.rate, null);
  for (const [a, b] of [[route("unknown", null, 120), base], [candidate, route("unknown", null, 100)]]) {
    const missing = compareRoute(a, b);
    assert.match(missing.summary, /Price difference unknown/);
    assert.equal(missing.rate, null);
    assert.ok(!missing.details.join(" ").match(/NaN|Infinity/));
  }
});

test("marginal frontier steps expose diminishing returns independently of selection, ties and weaker points", () => {
  const a = route("a", 2173.5, 184.8), b = route("b", 3516.5, 211.5), c = route("c", 4998.5, 212.4);
  const tied = { ...c, id: "tied" };
  const map = marginalComparisons([c, a, route("dominated", 3600, 200), tied, b, route("unknown", null, 230)]);
  assert.equal(map.get("c").baselineId, "b");
  assert.match(compact(map.get("c").comparison.summary), /\+RM1,482.*\+0\.9cityh/);
  assert.equal(compact(map.get("c").comparison.rate), "RM1,646.67/extracityh");
  assert.deepEqual(map.get("c"), map.get("tied"));
  assert.ok(!map.has("dominated"));
  assert.ok(!map.has("unknown"));
  assert.ok(!map.has("a"));
});

test("weighted ideal distance favors the compromise and slider endpoints match price/time preferences", () => {
  const routes = [route("cheap", 2000, 180), route("middle", 2200, 220), route("long", 3000, 230)];
  assert.equal(sortRoutes(routes, "balanced")[0].id, "middle");
  assert.equal(sortRoutes(routes, "balanced", { priceWeight: 1 })[0].id, "cheap");
  assert.equal(sortRoutes(routes, "balanced", { priceWeight: 0 })[0].id, "long");
  const before = routes.map(route => route.id);
  sortRoutes(routes, "balanced");
  assert.deepEqual(routes.map(route => route.id), before);
});

test("showing weaker options does not change best-option balance scores or ordering", () => {
  const best = [route("cheap", 2000, 180), route("middle", 2200, 220), route("long", 3000, 230)];
  const before = sortRoutes(best, "balanced", { priceWeight: .7, referenceRoutes: best }).map(route => route.id);
  const weaker = route("weaker", 100000, 1);
  const after = sortRoutes([...best, weaker], "balanced", { priceWeight: .7, referenceRoutes: best })
    .filter(route => route.id !== "weaker").map(route => route.id);
  assert.deepEqual(after, before);
  assert.ok(sortRoutes([route("a", 0, 10), route("b", 0, 10)], "balanced").every(route => route.total_cost_myr === 0));
});
