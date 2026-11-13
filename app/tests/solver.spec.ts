import { expect, test } from "@playwright/test";

test("native checkpoint survives structured cloning, resumes, and rejects changed inputs", async ({ page }) => {
  await page.route("**/native-comparison-test", route => route.fulfill({ contentType: "text/html", body: "<!doctype html>" }));
  await page.goto("/native-comparison-test");
  const results = await page.evaluate(async () => {
    const { solveNative } = await import("/src/native/solver.ts");
    const { firstDifference } = await import("/tests/compare.ts");
    const corpus = await (await fetch("/tests/fixtures/solver.json")).json();
    const item = corpus.cases.filter((item: { input: { label_limit?: number; expansion_budget?: number }; expected: { expanded_labels: number; optimization_complete: boolean } }) => item.expected.optimization_complete && !item.input.label_limit && item.input.expansion_budget == null)
      .sort((a: { expected: { expanded_labels: number } }, b: { expected: { expanded_labels: number } }) => b.expected.expanded_labels - a.expected.expanded_labels)[0];
    const first = solveNative({ ...item.input, label_limit: Math.max(1, Math.floor(item.expected.expanded_labels / 3)) });
    const resumed = solveNative(item.input, structuredClone(first.state));
    const fresh = solveNative(item.input);
    const changedInput = structuredClone(item.input);
    changedInput.spec.adults = 2;
    const changed = solveNative(changedInput, structuredClone(first.state));
    const budgeted = solveNative({ ...item.input, expansion_budget: 10 });
    const next = solveNative({ ...item.input, expansion_budget: 10 }, structuredClone(budgeted.state));
    const old = structuredClone(first.state);
    old.signature = "legacy-checkpoint-v1";
    const restarted = solveNative(item.input, old);
    const filtered = corpus.cases.find((c: { input: { spec: { exclude_unpriced_flights: boolean }; movements: { charges: { id: string }[] }[] }; expected: { routes: unknown[] } }) => c.input.spec.exclude_unpriced_flights && c.expected.routes.length && c.input.movements.some(m => m.charges.some(charge => charge.id === "access"))).input;
    const { fingerprint } = await import("/src/native/time.ts"), { normalizeFare, normalizeJourney } = await import("/src/native/types.ts");
    const filteredFresh = solveNative(filtered), filteredOld = structuredClone(filteredFresh.state);
    filteredOld.signature = fingerprint([2, filtered.spec, filtered.movements.map(normalizeJourney).map((m: { raw: unknown }) => m.raw), filtered.offers.map(normalizeFare), filtered.rules, true]);
    filteredOld.completed = []; filteredOld.expanded = 999;
    const filteredRestarted = solveNative(filtered, filteredOld);
    return { paused: !first.result.optimization_complete, resumedDifference: firstDifference(fresh.result, resumed.result),
      changedDifference: firstDifference(solveNative(changedInput).result, changed.result),
      relativeBudget: next.result.expanded_labels - budgeted.result.expanded_labels,
      legacyDifference: firstDifference(fresh.result, restarted.result), filteredLegacyDifference: firstDifference(filteredFresh.result, filteredRestarted.result) };
  });
  expect(results).toEqual({ paused: true, resumedDifference: null, changedDifference: null, relativeBudget: 10, legacyDifference: null, filteredLegacyDifference: null });
});

test("a regular service between home and another start city becomes timed journeys in both directions", async ({ page }) => {
  await page.route("**/native-pattern-test", route => route.fulfill({ contentType: "text/html", body: "<!doctype html>" }));
  await page.goto("/native-pattern-test");
  const result = await page.evaluate(async () => {
    const { solveNative } = await import("/src/native/solver.ts");
    const corpus = await (await fetch("/tests/fixtures/solver.json")).json();
    const input = structuredClone(corpus.cases[1].input);
    const gateway = { ...input.spec.home, id: "gw", name: "gw" };
    input.spec.departures = [input.spec.home, gateway]; input.spec.arrivals = [input.spec.home, gateway];
    // Rail only reaches the city to visit from the gateway; home has its flights at the same times, without a price.
    const rail = (id: string, from: string, to: string, departure: string, arrival: string) => {
      const base = structuredClone(input.movements[0]);
      return { ...base, id, from_id: from, to_id: to, mode: "rail", departure, arrival, template_id: id, charges: [],
        segments: base.segments.map((segment: object) => ({ ...segment, mode: "rail", from_id: from, to_id: to, from_name: from, to_name: to, departure, arrival })) };
    };
    input.movements.push(rail("out-rail", "gw", "a", "2027-02-10T12:00:00Z", "2027-02-10T13:00:00Z"), rail("back-rail", "a", "gw", "2027-02-12T12:00:00Z", "2027-02-12T13:00:00Z"));
    input.offers.push({ ...input.offers[0], id: "fare:out-rail", kind: "one-way", movement_ids: ["out-rail"], low: 5, high: 5 }, { ...input.offers[0], id: "fare:back-rail", kind: "one-way", movement_ids: ["back-rail"], low: 5, high: 5 });
    const pattern = { gateway_id: "gw", mode: "rail", first: "06:00:00", last: "22:00:00", every_minutes: 60, duration_minutes: 60, fare_amount: 3, currency: "MYR", label: "Regular train" };
    input.spec.positioning_patterns = [{ ...pattern, id: "p-out", direction: "outbound" }, { ...pattern, id: "p-back", direction: "return" }];
    const { result } = solveNative(input);
    return result.routes.map((route: { total_cost_myr: number | null; movements: { id: string }[] }) => ({ cost: route.total_cost_myr, ids: route.movements.map(m => m.id) }));
  });
  const regular = result.find(route => route.ids[0].startsWith("positioning:p-out@"));
  expect(regular).toBeDefined();
  expect(regular!.ids.slice(1, 3)).toEqual(["out-rail", "back-rail"]);
  expect(regular!.ids[3]).toMatch(/^positioning:p-back@2027-02-12T1[3-9]:00$/);
  expect(regular!.cost).toBe(16);
});
