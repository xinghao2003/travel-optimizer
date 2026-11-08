import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

test("complete native input preparation and trip metadata match Python recalculation", async ({ page }) => {
  if (process.env.POC_PREPARATION_SAVED) {
    const body = await readFile(process.env.POC_PREPARATION_SAVED);
    await page.route("**/tests/fixtures/native-preparation.json", route => route.fulfill({ body, contentType: "application/json" }));
  }
  await page.route("**/preparation-comparison-test", route => route.fulfill({ contentType: "text/html", body: "<!doctype html>" }));
  await page.goto("/preparation-comparison-test");
  const summary = await page.evaluate(async () => {
    const { prepareSolverInput, completeResult, tripMetadata, refreshQuoteFreshness, airportPlaces } = await import("/src/prototype/native/preparation.ts");
    const { solveNative } = await import("/src/prototype/native/solver.ts");
    const { parseSpec } = await import("/src/prototype/native/contracts.ts");
    const { discoveryKey } = await import("/src/prototype/native/discovery-key.ts");
    const { importSolverInput } = await import("/src/prototype/native/import-input.ts");
    const { stableModelId } = await import("/src/prototype/native/time.ts");
    const { firstDifference } = await import("/src/prototype/comparison.ts");
    const corpus = await (await fetch("/tests/fixtures/native-preparation.json")).json();
    const failures: { name: string; path: string; expected: unknown; actual: unknown }[] = [];
    function compare(name: string, expected: unknown, actual: unknown) {
      const mismatch = firstDifference(expected, JSON.parse(JSON.stringify(actual)));
      if (mismatch) failures.push({ name, ...mismatch });
    }
    for (const item of corpus.cases) {
      try {
        const { input, snapshot } = prepareSolverInput(item.trip, item.rules, item.options);
        compare(item.name + ":input", item.expected_input, input);
        const result = completeResult(solveNative(input).result, snapshot, item.trip);
        compare(item.name + ":result", item.expected_result, result);
        compare(item.name + ":snapshot", item.expected_snapshot, item.expected_snapshot === null ? null : snapshot);
        const trip = { ...item.trip, snapshot: item.expected_snapshot === null ? null : snapshot, result };
        compare(item.name + ":metadata", item.expected_metadata, tripMetadata(trip, corpus.catalog));
        compare(item.name + ":key", item.expected_discovery_key, discoveryKey(parseSpec(item.trip.spec)));
        compare(item.name + ":airports", item.expected_airport_places, Object.fromEntries(airportPlaces(parseSpec(item.trip.spec), corpus.catalog)));
        compare(item.name + ":import", { ...item.expected_input, label_limit: null, expansion_budget: null, include_dominated: false }, importSolverInput({ ...item.trip, rules: item.rules }, item.options.now));
        const refreshed = refreshQuoteFreshness(result, item.options.now);
        compare(item.name + ":freshness-idempotent", refreshed, refreshQuoteFreshness(refreshed, item.options.now));
      } catch (error) { failures.push({ name: item.name, path: "exception", expected: "success", actual: String(error) }); }
    }
    for (const [i, item] of corpus.discovery_keys.entries()) compare("discovery-key-" + i, item.expected, discoveryKey(parseSpec(item.spec)));
    for (const [i, item] of corpus.hash_cases.entries()) compare("model-hash-" + i, item.expected, stableModelId(["low", "high", "duration_minutes"], item.value));
    return { preparationCases: corpus.cases.length, discoveryKeys: corpus.discovery_keys.length, failures };
  });
  console.log(JSON.stringify(summary, null, 2));
  expect(summary.failures).toEqual([]);
});
