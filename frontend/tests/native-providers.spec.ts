import { expect, test } from "@playwright/test";

test("native provider normalization matches current Python schedules, connections and fare products", async ({ page }) => {
  await page.route("**/provider-comparison-test", route => route.fulfill({ contentType: "text/html", body: "<!doctype html>" }));
  await page.goto("/provider-comparison-test");
  const summary = await page.evaluate(async () => {
    const { flightMovement, transitMovements, transitFare, pairKey } = await import("/src/prototype/native/journeys.ts");
    const { prepareRailPayload, fallbackTask } = await import("/src/prototype/native/rail.ts");
    const { tasksFor, roughDateWindows, seedDates } = await import("/src/prototype/native/discovery.ts");
    const { iso } = await import("/src/prototype/native/time.ts");
    const { firstDifference } = await import("/src/prototype/comparison.ts");
    const corpus = await (await fetch("/tests/fixtures/native-providers.json")).json();
    const failures: { name: string; path: string; expected: unknown; actual: unknown }[] = [];
    for (const item of corpus.cases) {
      try {
        const input = item.input;
        const result = item.operation === "flight_movement" ? flightMovement(input.origin, input.dest, input.segments, input.spec, input.roads,
          new Map(input.connections.map((c: { from_airport: string; to_airport: string }) => [pairKey(c.from_airport, c.to_airport), c])))
          : item.operation === "transit_movements" ? transitMovements(input.payload, input.origin, input.dest, input.spec, input.day)
          : item.operation === "prepare_rail_payload" ? prepareRailPayload(input.payload, input.task, input.origin)
          : item.operation === "fallback_task" ? fallbackTask(input.task, input.spec, input.today)
          : item.operation === "tasks_for" ? tasksFor(input.spec, input.metros ?? corpus.metros, input.transit_enabled)
          : item.operation === "rough_date_windows" ? [...roughDateWindows(input.spec)].map(([key, values]) => [JSON.parse(key), values.map(v => iso(v))])
          : item.operation === "seed_dates" ? seedDates(input.spec)
          : transitFare(input.itinerary, input.adults);
        const mismatch = firstDifference(item.expected, JSON.parse(JSON.stringify(result)));
        if (mismatch) failures.push({ name: item.name, ...mismatch });
      } catch (error) { failures.push({ name: item.name, path: "exception", expected: "success", actual: String(error) }); }
    }
    return { cases: corpus.cases.length, failures };
  });
  console.log(JSON.stringify(summary, null, 2));
  expect(summary.failures).toEqual([]);
});
