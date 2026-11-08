import { expect, test } from "@playwright/test";

test("native JSON model defaults and validation match Python contracts", async ({ page }) => {
  await page.route("**/contract-comparison-test", route => route.fulfill({ contentType: "text/html", body: "<!doctype html>" }));
  await page.goto("/contract-comparison-test");
  const summary = await page.evaluate(async () => {
    const c = await import("/src/prototype/native/contracts.ts");
    const { firstDifference } = await import("/src/prototype/comparison.ts");
    const parsers = { Place: c.parsePlace, TripSpec: c.parseSpec, Segment: c.parseSegment, Charge: c.parseCharge, Movement: c.parseMovement,
      FareOffer: c.parseOffer, JourneyPriceScope: c.parseScope, PricingRule: c.parseRule, AirportConnection: c.parseConnection, AirportTransferEstimate: c.parseTransfer, SolverInput: c.parseSolverInput };
    const corpus = await (await fetch("/tests/fixtures/native-contracts.json")).json();
    const failures: { name: string; path: string; expected: unknown; actual: unknown }[] = [];
    for (const item of corpus.cases) {
      let result;
      try { result = parsers[item.model as keyof typeof parsers](item.input); }
      catch (error) { if (item.valid) failures.push({ name: item.name, path: "exception", expected: "valid", actual: String(error) }); continue; }
      if (!item.valid) failures.push({ name: item.name, path: "validation", expected: "invalid", actual: result });
      else {
        const mismatch = firstDifference(item.expected, result);
        if (mismatch) failures.push({ name: item.name, ...mismatch });
      }
    }
    let unsupported = false;
    try { c.parseSolverInput({ schema_version: 99, spec: {}, movements: [], offers: [] }); } catch { unsupported = true; }
    return { cases: corpus.cases.length, unsupported, failures };
  });
  console.log(JSON.stringify(summary, null, 2));
  expect(summary.unsupported).toBe(true);
  expect(summary.failures).toEqual([]);
});
