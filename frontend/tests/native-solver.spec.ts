import { expect, test } from "@playwright/test";

test("native checkpoint survives structured cloning, resumes, and rejects changed inputs", async ({ page }) => {
  await page.route("**/native-comparison-test", route => route.fulfill({ contentType: "text/html", body: "<!doctype html>" }));
  await page.goto("/native-comparison-test");
  const results = await page.evaluate(async () => {
    const { solveNative } = await import("/src/native/solver.ts");
    const { firstDifference } = await import("/tests/compare.ts");
    const corpus = await (await fetch("/tests/fixtures/native-solver.json")).json();
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
