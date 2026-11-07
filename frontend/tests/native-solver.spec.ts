import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

test("native solver matches the Python reference corpus, including latest journey-pricing rules", async ({ page }) => {
  await page.route("**/native-comparison-test", route => route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Solver comparison</title>" }));
  await page.goto("/native-comparison-test");
  const summary = await page.evaluate(async () => {
    const { solveNative } = await import("/src/prototype/native/solver.ts");
    const { pricePath } = await import("/src/prototype/native/pricing.ts");
    const { normalizeJourney, normalizeFare } = await import("/src/prototype/native/types.ts");
    const { firstDifference: difference } = await import("/src/prototype/comparison.ts");
    const corpus = await (await fetch("/tests/fixtures/native-solver.json")).json();
    const failures: { name: string; path: string; expected: unknown; actual: unknown }[] = [];
    for (const item of [...corpus.cases, ...(corpus.generated ?? [])]) {
      try {
        const { result } = solveNative(item.input);
        const mismatch = difference(item.expected, JSON.parse(JSON.stringify(result)));
        if (mismatch) failures.push({ name: item.name, ...mismatch });
      } catch (error) { failures.push({ name: item.name, path: "exception", expected: "success", actual: String(error) }); }
    }
    for (const item of corpus.pricing) {
      try {
        const input = item.input;
        const result = pricePath(input.movements.map(normalizeJourney), input.offers.map(normalizeFare), input.spec, input.rules, input.extra);
        const mismatch = difference(item.expected, JSON.parse(JSON.stringify(result)));
        if (mismatch) failures.push({ name: item.name, ...mismatch });
      } catch (error) { failures.push({ name: item.name, path: "exception", expected: "success", actual: String(error) }); }
    }
    return { solverCases: corpus.cases.length, generatedCases: corpus.generated?.length ?? 0, priceCases: corpus.pricing.length, failures };
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
    const item = corpus.cases.filter((item: { input: { label_limit?: number }; expected: { expanded_labels: number; optimization_complete: boolean } }) => item.expected.optimization_complete && !item.input.label_limit)
      .sort((a: { expected: { expanded_labels: number } }, b: { expected: { expanded_labels: number } }) => b.expected.expanded_labels - a.expected.expanded_labels)[0];
    const first = solveNative({ ...item.input, label_limit: Math.max(1, Math.floor(item.expected.expanded_labels / 3)) });
    const resumed = solveNative(item.input, structuredClone(first.state));
    const fresh = solveNative(item.input);
    const changedInput = structuredClone(item.input);
    changedInput.spec.adults = 2;
    const changed = solveNative(changedInput, structuredClone(first.state));
    return { paused: !first.result.optimization_complete, resumedDifference: firstDifference(fresh.result, resumed.result), changedDifference: firstDifference(solveNative(changedInput).result, changed.result) };
  });
  expect(results).toEqual({ paused: true, resumedDifference: null, changedDifference: null });
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
  await page.screenshot({ path: "../data/diagnostics/native-comparison/comparison.png", fullPage: true });
});
