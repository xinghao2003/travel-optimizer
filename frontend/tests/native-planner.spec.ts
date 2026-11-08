import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

test("native place search and nearest results match Python, including Unicode and date-line locations", async ({ page }) => {
  await page.route("**/native-places-test", route => route.fulfill({ contentType: "text/html", body: "<!doctype html>" }));
  await page.goto("/native-places-test");
  const summary = await page.evaluate(async () => {
    const { loadPlaces } = await import("/src/prototype/native/places.ts"), places = await loadPlaces();
    const { firstDifference } = await import("/src/prototype/comparison.ts");
    const corpus = await (await fetch("/tests/fixtures/native-places.json")).json(), failures = [];
    for (const item of corpus.cases) {
      const actual = item.operation === "search" ? places.search(item.query, item.limit) : places.nearest(item.latitude, item.longitude, item.limit);
      const difference = firstDifference(item.expected, actual);
      if (difference) failures.push({ operation: item.operation, query: item.query, latitude: item.latitude, longitude: item.longitude, ...difference });
    }
    let rejected = 0;
    for (const run of [() => places.search("a"), () => places.search("London", 31), () => places.nearest(91, 0), () => places.nearest(0, NaN)]) try { run(); } catch { rejected++; }
    return { cases: corpus.cases.length, failures, rejected };
  });
  expect(summary.cases).toBeGreaterThan(80); expect(summary.failures).toEqual([]); expect(summary.rejected).toBe(4);
});

test("native Planner restores a backup, calculates, edits and reloads without planner HTTP calls", async ({ page }) => {
  const forbidden: string[] = [], errors: string[] = [];
  page.on("request", request => { if (/\/api\/|pyodide|jsdelivr|browser-python/.test(request.url())) forbidden.push(request.url()); });
  page.on("pageerror", error => errors.push(error.message));
  await page.goto("/native.html");
  await expect(page.getByRole("heading", { name: "Wayfinder Routes", exact: true })).toBeAttached();
  await page.getByLabel("More actions").click();
  await expect(page.getByRole("button", { name: "Restore browser backup", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Restore browser backup", exact: true }).click();
  const fixture = await page.evaluate(async () => {
    const corpus = await (await fetch("/tests/fixtures/native-preparation.json")).json(), sample = corpus.cases[5];
    const records = [{ schema_version: 1, collection: "trips", id: sample.trip.id, updated: 1, payload: sample.trip },
      ...sample.rules.map((rule: { id: string }) => ({ schema_version: 1, collection: "rules", id: rule.id, updated: 1, payload: rule }))];
    return { id: sample.trip.id, backup: { format: "wayfinder-browser-backup", schema_version: 1, exported_at: new Date().toISOString(), records },
      routes: sample.expected_result.routes.map((route: { total_cost_myr: number; movements: { id: string }[] }) => ({ cost: route.total_cost_myr, ids: route.movements.map(m => m.id) })) };
  });
  await page.getByLabel("Backup file").setInputFiles({ name: "public-backup.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(fixture.backup)) });
  await page.getByRole("button", { name: "Restore backup", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByLabel("Trip name")).toHaveValue("My trip");
  await expect.poll(() => page.evaluate(async id => {
    const { PlannerRepository } = await import("/src/prototype/native/repository.ts"), repository = new PlannerRepository();
    try { return (await repository.requireTrip(id)).result?.routes.map(route => ({ cost: route.total_cost_myr, ids: route.movements.map(m => m.id) })); }
    finally { await repository.close(); }
  }, fixture.id)).toEqual(fixture.routes);
  await page.getByRole("tab", { name: /Missing info/ }).click();
  await page.locator("#panel-missing [data-price-input]").first().fill("1");
  await page.locator("#panel-missing [data-price-input]").first().press("Tab");
  await expect(page.getByRole("region", { name: "Changes not applied" })).toBeVisible();
  await page.getByLabel("More actions").click();
  await expect(page.getByRole("button", { name: "Restore browser backup", exact: true })).toBeDisabled();
  await page.getByLabel("More actions").click();
  await page.getByRole("button", { name: "Apply", exact: true }).click();
  await expect(page.getByRole("region", { name: "Changes not applied" })).toHaveCount(0);
  await page.getByLabel("Trip name").fill("Native saved trip");
  await page.getByLabel("Trip name").press("Tab");
  await expect.poll(() => page.evaluate(async id => {
    const { PlannerRepository } = await import("/src/prototype/native/repository.ts"), repository = new PlannerRepository();
    try { return (await repository.requireTrip(id)).spec.name; } finally { await repository.close(); }
  }, fixture.id)).toBe("Native saved trip");
  await page.reload();
  await expect(page.getByLabel("Trip name")).toHaveValue("Native saved trip");
  await page.getByLabel("More actions").click();
  await expect(page.getByRole("button", { name: /Download browser backup/ })).toBeEnabled();
  const downloading = page.waitForEvent("download");
  await page.getByRole("button", { name: /Download browser backup/ }).click();
  expect((await downloading).suggestedFilename()).toMatch(/^wayfinder-backup-.*\.json$/);
  expect(forbidden).toEqual([]); expect(errors).toEqual([]);
});

test("native service applies prices to the full graph and persists continuous calculation status", async ({ page }) => {
  await page.route("**/native-api-test", route => route.fulfill({ contentType: "text/html", body: "<!doctype html>" }));
  await page.goto("/native-api-test");
  const summary = await page.evaluate(async () => {
    const { BrowserPlannerApi } = await import("/src/prototype/native/api.ts"), { PlannerRepository } = await import("/src/prototype/native/repository.ts");
    const edits = await (await fetch("/tests/fixtures/native-edits.json")).json();
    const sample = edits.cases.find((item: { operation: string; valid: boolean; input: { request?: { estimates?: { component_ids: string[]; low: number }[] } } }) => item.operation === "apply_missing_info" && item.valid && item.input.request?.estimates?.some(e => e.component_ids.includes("weaker") && e.low === 1));
    const repository = new PlannerRepository("wayfinder-api-" + crypto.randomUUID()), service = new BrowserPlannerApi(repository, async () => edits.catalog);
    await service.ready(); const trip = sample.input.trip;
    let otherTabStatus;
    try { await new BrowserPlannerApi(new PlannerRepository(repository.name)).ready(); } catch (error) { otherTabStatus = (error as { status: number }).status; }
    await repository.put("trips", trip.id, trip);
    const result = await service.request(`/trips/${trip.id}/apply`, "POST", sample.input.request) as { trip: { revision: number; result: { routes: { total_cost_myr: number; movements: { id: string }[] }[] } }; updating: boolean };
    const weakerBecameBest = result.trip.result.routes.some(r => r.movements[0].id === "weaker" && r.total_cost_myr === 11);
    let staleStatus;
    try { await service.request(`/trips/${trip.id}/apply`, "POST", sample.input.request); } catch (error) { staleStatus = (error as { status: number }).status; }
    let zeroStayStatus;
    try { await service.request(`/trips/${trip.id}/optimizations`, "POST"); } catch (error) { zeroStayStatus = (error as { status: number }).status; }
    await service.request(`/trips/${trip.id}`, "PUT", { expected_revision: result.trip.revision, spec: { ...trip.spec, visits: trip.spec.visits.map((visit: object) => ({ ...visit, min_stay_hours: 1 })) } });
    const job = await service.request(`/trips/${trip.id}/optimizations`, "POST") as { id: string };
    let status;
    for (let i = 0; i < 100; i++) {
      const current = await service.request(`/optimizations/${job.id}`) as { status: string };
      if (!["queued", "running", "stopping"].includes(current.status)) { status = current.status; break; }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    const latest = (await repository.requireTrip(trip.id)).latest_optimization_id;
    await repository.close();
    return { weakerBecameBest, staleStatus, zeroStayStatus, otherTabStatus, status, latest: latest === job.id, updating: result.updating };
  });
  expect(summary).toEqual({ weakerBecameBest: true, staleStatus: 409, zeroStayStatus: 422, otherTabStatus: 409, status: "complete", latest: true, updating: false });
});

test("production static Planner restores and edits a saved trip without a planner server", async ({ page }) => {
  test.skip(!process.env.POC_STATIC_URL, "Run against the separately built native static artifact.");
  const corpus = JSON.parse(await readFile("tests/fixtures/native-preparation.json", "utf8")), sample = corpus.cases[5];
  const backup = { format: "wayfinder-browser-backup", schema_version: 1, exported_at: new Date().toISOString(), records: [
    { schema_version: 1, collection: "trips", id: sample.trip.id, updated: 1, payload: sample.trip },
    ...sample.rules.map((rule: { id: string }) => ({ schema_version: 1, collection: "rules", id: rule.id, updated: 1, payload: rule }))] };
  const forbidden: string[] = [], errors: string[] = [];
  let providerCalls = 0;
  page.on("request", request => { if (/\/api\/(?:v2|data)|pyodide|jsdelivr|browser-python|\/src\//.test(request.url())) forbidden.push(request.url()); });
  await page.route("**/api/flights", route => { providerCalls++; return route.fulfill({ json: { status: "empty", options: [], search_url: "https://www.google.com/travel/flights" } }); });
  await page.route("**/table/v1/driving/**", route => {
    const count = new URL(route.request().url()).pathname.split("/").pop()!.split(";").length;
    return route.fulfill({ json: { code: "Ok", distances: Array.from({ length: count }, (_, i) => Array.from({ length: count }, (_, j) => i === j ? 0 : 10000)),
      durations: Array.from({ length: count }, (_, i) => Array.from({ length: count }, (_, j) => i === j ? 0 : 1200)) } });
  });
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(new URL("/native.html", process.env.POC_STATIC_URL!).href);
  await page.getByLabel("More actions").click();
  await page.getByRole("button", { name: "Restore browser backup", exact: true }).click();
  await page.getByLabel("Backup file").setInputFiles({ name: "saved-trip.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(backup)) });
  await page.getByRole("button", { name: "Restore backup", exact: true }).click();
  await expect(page.getByLabel("Trip name")).toHaveValue("My trip");
  await expect(page.getByRole("heading", { name: /Options/ })).toBeVisible();
  await page.getByLabel("Trip name").fill("Static artifact trip");
  await page.getByLabel("Trip name").press("Tab");
  await expect(page.locator(".p-save-status")).toContainText("Saved");
  await page.reload();
  await expect(page.getByLabel("Trip name")).toHaveValue("Static artifact trip");
  await page.getByLabel("More actions").click();
  await expect(page.getByRole("button", { name: /Download browser backup/ })).toBeEnabled();
  const downloading = page.waitForEvent("download");
  await page.getByRole("button", { name: /Download browser backup/ }).click();
  const downloaded = await downloading, downloadPath = await downloaded.path();
  const saved = JSON.parse(await readFile(downloadPath!, "utf8"));
  const trip = saved.records.find((record: { collection: string; id: string }) => record.collection === "trips" && record.id === sample.trip.id).payload;
  expect(trip.spec.name).toBe("Static artifact trip");
  expect(trip.result.routes.length).toBe(sample.expected_result.routes.length);
  await page.getByLabel("More actions").click();
  await page.getByRole("button", { name: "Edit trip", exact: true }).click();
  await page.getByRole("button", { name: "Start a new search", exact: true }).click();
  await expect.poll(() => providerCalls).toBeGreaterThan(0);
  await page.getByLabel("More actions").click();
  await expect(page.getByRole("button", { name: /Download browser backup/ })).toBeEnabled();
  const afterSearch = page.waitForEvent("download");
  await page.getByRole("button", { name: /Download browser backup/ }).click();
  const afterPath = await (await afterSearch).path(), searched = JSON.parse(await readFile(afterPath!, "utf8"));
  const job = searched.records.find((record: { collection: string }) => record.collection === "jobs").payload;
  expect(job.status).toBe("complete"); expect(job.cursor).toBe(job.queue.length); expect(job.requests).toBeGreaterThan(0);
  expect(forbidden).toEqual([]); expect(errors).toEqual([]);
});
