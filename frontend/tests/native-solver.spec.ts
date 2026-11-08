import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

test("native solver matches current Python, including fair exploration, flight eligibility, and resumed budgets", async ({ page }) => {
  await page.route("**/native-comparison-test", route => route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Solver comparison</title>" }));
  await page.goto("/native-comparison-test");
  const summary = await page.evaluate(async () => {
    const { solveNative } = await import("/src/prototype/native/solver.ts");
    const { pricePath } = await import("/src/prototype/native/pricing.ts");
    const { normalizeJourney, normalizeFare } = await import("/src/prototype/native/types.ts");
    const { cents, duration, micros, iso } = await import("/src/prototype/native/time.ts");
    const { timestamp } = await import("/src/prototype/native/journeys.ts");
    const { firstDifference: difference } = await import("/src/prototype/comparison.ts");
    const corpus = await (await fetch("/tests/fixtures/native-solver.json")).json();
    const failures: { name: string; path: string; expected: unknown; actual: unknown }[] = [];
    for (const item of corpus.cent_cases ?? []) {
      const actual = cents(item.value).toString();
      if (actual !== item.expected) failures.push({ name: `cents:${item.value}`, path: "cents", expected: item.expected, actual });
    }
    for (const item of corpus.timestamp_cases ?? []) {
      const value = typeof item.value === "number" ? timestamp(item.value) : micros(item.value), actual = { micros: value.toString(), iso: iso(value) }, expected = { micros: item.micros, iso: item.iso };
      const mismatch = difference(expected, actual);
      if (mismatch) failures.push({ name: `timestamp:${item.value}`, ...mismatch });
    }
    for (const item of corpus.timedelta_cases ?? []) {
      const actual = duration(item.value, item.unit, item.extra).toString();
      if (actual !== item.expected) failures.push({ name: `timedelta:${item.value}:${item.unit}`, path: "microseconds", expected: item.expected, actual });
    }
    for (const item of [...corpus.cases, ...(corpus.generated ?? [])]) {
      try {
        const previous = item.prefix_expansions ? solveNative({ ...item.input, expansion_budget: null, label_limit: item.prefix_expansions }).state : undefined;
        const { result } = solveNative(item.input, previous && structuredClone(previous));
        const mismatch = difference(item.expected, JSON.parse(JSON.stringify(result)));
        if (mismatch) failures.push({ name: item.name, ...mismatch });
      } catch (error) { failures.push({ name: item.name, path: "exception", expected: "success", actual: String(error) }); }
    }
    for (const item of corpus.pricing) {
      try {
        const input = item.input;
        const result = pricePath(input.movements.map(normalizeJourney), input.offers.map(normalizeFare), input.spec, input.rules, input.extra);
        const mismatch = difference(item.expected, JSON.parse(JSON.stringify(result, (_key, value) => typeof value === "bigint" ? value.toString() : value)));
        if (mismatch) failures.push({ name: item.name, ...mismatch });
      } catch (error) { failures.push({ name: item.name, path: "exception", expected: "success", actual: String(error) }); }
    }
    return { solverCases: corpus.cases.length, generatedCases: corpus.generated?.length ?? 0, priceCases: corpus.pricing.length, centCases: corpus.cent_cases?.length ?? 0, timestampCases: corpus.timestamp_cases?.length ?? 0, timedeltaCases: corpus.timedelta_cases?.length ?? 0, failureCount: failures.length, failures: failures.slice(0, 10) };
  });
  console.log(JSON.stringify(summary, null, 2));
  expect(summary.failures).toEqual([]);
});

test("native checkpoint survives structured cloning, resumes, and rejects changed inputs", async ({ page }) => {
  await page.route("**/native-comparison-test", route => route.fulfill({ contentType: "text/html", body: "<!doctype html>" }));
  await page.goto("/native-comparison-test");
  const results = await page.evaluate(async () => {
    const { solveNative } = await import("/src/prototype/native/solver.ts");
    const { firstDifference } = await import("/src/prototype/comparison.ts");
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
    const { fingerprint } = await import("/src/prototype/native/time.ts"), { normalizeFare, normalizeJourney } = await import("/src/prototype/native/types.ts");
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

test("comparison page runs native without Pyodide, then compares both independent workers", async ({ page }) => {
  let runtimeRequests = 0;
  await page.route("https://cdn.jsdelivr.net/pyodide/v314.0.7/full/**", async route => {
    runtimeRequests++;
    if (!process.env.POC_PYODIDE_CACHE) { await route.continue(); return; }
    const name = new URL(route.request().url()).pathname.split("/").pop()!;
    await route.fulfill({ body: await readFile(join(process.env.POC_PYODIDE_CACHE!, name)), contentType: /\.m?js$/.test(name) ? "text/javascript" : name.endsWith(".wasm") ? "application/wasm" : "application/octet-stream", headers: { "Access-Control-Allow-Origin": "*" } });
  });
  await page.goto("/solver-comparison.html");
  await page.getByRole("button", { name: "Run TypeScript only", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("Comparison finished.");
  expect(runtimeRequests).toBe(0);
  await page.getByRole("button", { name: "Run both solvers", exact: true }).click();
  await expect(page.getByText("Results match, including route IDs, fares, diagnostics, and search counters.")).toBeVisible({ timeout: 60000 });
  expect(runtimeRequests).toBeGreaterThan(0);
  const corpus = JSON.parse(await readFile("tests/fixtures/native-solver.json", "utf8"));
  const limited = corpus.cases.find((item: { input: { expansion_budget?: number }; prefix_expansions: number }) => item.input.expansion_budget === 10 && !item.prefix_expansions);
  await page.getByLabel("Comparison input JSON").setInputFiles({ name: "budgeted-input.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(limited.input)) });
  await page.getByRole("button", { name: "Run both solvers", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("Comparison finished.");
  await expect(page.getByText("Results match, including route IDs, fares, diagnostics, and search counters.")).toBeVisible();
  await page.getByText("Inspect results", { exact: true }).click();
  await expect(page.locator("details pre")).toContainText('"expanded_labels": 10');
  await expect(page.locator("details pre")).toContainText('"safety_limit_reached": true');
  const preparedCorpus = JSON.parse(await readFile("tests/fixtures/native-preparation.json", "utf8"));
  const saved = preparedCorpus.cases.find((item: { expected_result: { routes: unknown[] }; trip: { airport_transfer_estimates?: unknown[] } }) => item.expected_result.routes.length && item.trip.airport_transfer_estimates?.length);
  await page.getByLabel("Comparison input JSON").setInputFiles({ name: "saved-trip.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify({ ...saved.trip, rules: saved.rules })) });
  await expect(page.getByText(`${saved.expected_input.movements.length} journeys`, { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Run both solvers", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("Comparison finished.");
  await expect(page.getByText("Results match, including route IDs, fares, diagnostics, and search counters.")).toBeVisible();
  await page.screenshot({ path: "../data/diagnostics/native-comparison/comparison.png", fullPage: true });
});
