import { expect, test } from "@playwright/test";
import { readFile, readdir } from "node:fs/promises";

test("native API preserves global-rule responses, cross-trip revisions, and deletion semantics", async ({ page }) => {
  await page.route("**/native-operation-contract", route => route.fulfill({ contentType: "text/html", body: "<!doctype html>" }));
  await page.goto("/native-operation-contract");
  const result = await page.evaluate(async () => {
    const { BrowserPlannerApi } = await import("/src/native/api.ts"), { PlannerRepository } = await import("/src/native/repository.ts");
    const corpus = await (await fetch("/tests/fixtures/preparation.json")).json(), sample = corpus.cases[5];
    const repository = new PlannerRepository("wayfinder-contract-" + crypto.randomUUID()), api = new BrowserPlannerApi(repository, async () => corpus.catalog);
    const one = await api.request("/trips", "POST", sample.trip.spec) as { id: string; revision: number };
    const two = await api.request(`/trips/${one.id}/duplicate`, "POST") as { id: string; revision: number };
    const rule = await api.request("/pricing-rules/path-id", "PUT", { id: "body-id", name: "Rail estimate", mode: "rail", low: 7 }) as { id: string; low: number };
    const afterSave = await Promise.all([one, two].map(trip => repository.requireTrip(trip.id)));
    const listed = await api.request("/pricing-rules") as { rules: { id: string }[] };
    const deletedRule = await api.request("/pricing-rules/path-id", "DELETE");
    const afterDelete = await Promise.all([one, two].map(trip => repository.requireTrip(trip.id)));
    const deletedTrip = await api.request(`/trips/${one.id}`, "DELETE");
    let missingStatus;
    try { await api.request(`/trips/${one.id}`); } catch (error) { missingStatus = (error as { status: number }).status; }
    const remaining = await api.request("/trips") as { trips: { id: string }[] };
    // A completed cache from before exact-cent/time arithmetic must not be
    // trusted just because its trip and graph revisions still match.
    const copy = await repository.requireTrip(two.id);
    await repository.put("trips", two.id, { ...sample.trip, id: two.id, spec: copy.spec, revision: copy.revision, native_solver_revision: 0,
      result: { ...sample.expected_result, routes: [], trip_revision: copy.revision } });
    const legacy = await api.request(`/trips/${two.id}`) as { result: { trip_revision: number } };
    const checking = await api.startContinuous(two.id);
    let status;
    for (let i = 0; i < 100; i++) {
      status = (await api.request(`/optimizations/${checking.id}`) as { status: string }).status;
      if (!["queued", "running", "stopping"].includes(status)) break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    const refreshed = await repository.requireTrip(two.id);
    await repository.close();
    return { rule: { id: rule.id, low: rule.low }, listed: listed.rules.map(rule => rule.id),
      savedRevisions: afterSave.map(trip => trip.revision), deletedRevisions: afterDelete.map(trip => trip.revision),
      deletedRule, deletedTrip, missingStatus, remainingIsCopy: remaining.trips.length === 1 && remaining.trips[0].id === two.id,
      legacyWasStale: legacy.result.trip_revision === -1, legacyRecalculated: status === "complete" && !!refreshed.result?.routes.length && refreshed.native_solver_revision === 1 };
  });
  expect(result).toEqual({ rule: { id: "path-id", low: 7 }, listed: ["path-id"], savedRevisions: [2, 2], deletedRevisions: [3, 3],
    deletedRule: { deleted: true }, deletedTrip: { deleted: true }, missingStatus: 404, remainingIsCopy: true, legacyWasStale: true, legacyRecalculated: true });
});

test("production artifact contains only the application and public catalogs", async () => {
  const files = (await readdir("dist", { recursive: true, withFileTypes: true })).filter(entry => entry.isFile())
    .map(entry => `${entry.parentPath}/${entry.name}`.replaceAll("\\", "/").replace(/^dist\//, "")).sort();
  expect(files).toContain("index.html");
  expect(files.filter(name => !/^index\.html$|^favicon\.svg$|^assets\/[\w.-]+\.(?:js|css)$|^browser-data\/(?:airports|places|config)\.json$/.test(name))).toEqual([]);
  expect(await readFile("dist/index.html", "utf8")).toMatch(/type="module"[^>]*src="\/assets\/index-/);
});

test("production static root supports multiple trips, weaker options, copies, and portable reports", async ({ page, context }) => {
  test.skip(!process.env.STATIC_URL, "Run against a plain static server serving dist.");
  const corpus = JSON.parse(await readFile("tests/fixtures/preparation.json", "utf8"));
  const sample = corpus.cases[5], other = structuredClone(sample.trip);
  other.id = "static-acceptance-other"; other.spec.name = "Second saved trip";
  const first = structuredClone(sample.trip); first.spec.name = "Static acceptance trip";
  const backup = { format: "wayfinder-browser-backup", schema_version: 1, exported_at: new Date().toISOString(), records: [
    ...[other, first].map(payload => ({ schema_version: 1, collection: "trips", id: payload.id, updated: 1, payload })),
    ...sample.rules.map((payload: { id: string }) => ({ schema_version: 1, collection: "rules", id: payload.id, updated: 1, payload }))] };
  const forbidden: string[] = [], errors: string[] = [], origin = new URL(process.env.STATIC_URL!).origin;
  context.on("page", opened => opened.on("pageerror", error => errors.push(error.message)));
  page.on("pageerror", error => errors.push(error.message));
  await context.route("**/*", route => {
    const url = new URL(route.request().url());
    if (url.origin === origin && /^(?:\/(?:favicon\.svg)?|\/assets\/[\w.-]+\.(?:js|css)|\/browser-data\/(?:airports|places|config)\.json)$/.test(url.pathname)) return route.continue();
    if (url.href === "https://tiles.openfreemap.org/styles/bright") return route.fulfill({ json: { version: 8, sources: {}, layers: [] } });
    forbidden.push(url.href); return route.abort();
  });
  await page.goto(origin + "/");
  await expect(page.getByRole("heading", { name: "Wayfinder Routes", exact: true })).toBeAttached();
  await page.getByLabel("More actions").click();
  await page.getByRole("button", { name: "Restore browser backup", exact: true }).click();
  await page.getByLabel("Backup file").setInputFiles({ name: "two-trips.json", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(backup)) });
  await page.getByRole("button", { name: "Restore backup", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByLabel("Trip name")).toHaveValue("Static acceptance trip");
  await expect(page.getByRole("heading", { name: /Options/ })).toBeVisible();
  const weaker = page.getByLabel("Show weaker options", { exact: true });
  await weaker.check();
  await expect(page.locator(".p-save-status")).toContainText("Weaker options loaded");
  await page.getByRole("tab", { name: "Itinerary", exact: true }).click();
  await expect(page.getByRole("tabpanel", { name: "Itinerary", exact: true }).getByRole("heading", { name: /^Option \d/ })).toBeVisible();
  await expect(page.locator(".planner-map canvas")).toBeVisible();

  async function openExport() {
    await page.getByLabel("More actions").click();
    await page.getByRole("button", { name: /^Export trips/ }).click();
  }
  await openExport();
  await page.getByRole("radio", { name: /^Selected itinerary/ }).check();
  await page.getByRole("radio", { name: /^HTML/ }).check();
  const selectedDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download HTML", exact: true }).click();
  const selectedHtml = await readFile((await (await selectedDownload).path())!, "utf8");
  expect(selectedHtml).toContain("Static acceptance trip");
  expect(selectedHtml).toContain("Tickets and prices");
  expect((selectedHtml.match(/<article class="itinerary"/g) ?? []).length).toBe(1);

  await page.getByRole("radio", { name: /^All saved trips/ }).check();
  const allDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download HTML", exact: true }).click();
  const allHtml = await readFile((await (await allDownload).path())!, "utf8");
  expect(allHtml).toContain("Static acceptance trip"); expect(allHtml).toContain("Second saved trip");
  expect(allHtml).not.toMatch(/<(?:script|link|img)[^>]+(?:src|href)=/);
  await page.getByRole("radio", { name: /^PDF/ }).check();
  const opened = page.waitForEvent("popup");
  await page.getByRole("button", { name: "Open PDF report", exact: true }).click();
  const report = await opened;
  await expect(report.getByRole("heading", { name: "Trip comparison", exact: true })).toBeVisible();
  await expect(report.getByRole("button", { name: "Print / Save as PDF", exact: true })).toBeVisible();
  await report.close();
  await page.getByLabel("Close export", { exact: true }).click();

  await page.getByLabel("More actions").click();
  await page.getByRole("button", { name: /^Copy trip/ }).click();
  await expect(page.getByLabel("Trip name")).toHaveValue("Static acceptance trip (copy)");
  await expect(page.locator(".p-save-status")).toContainText("Copied");
  await page.reload();
  await expect(page.getByLabel("Trip name")).toHaveValue("Static acceptance trip (copy)");
  await page.getByLabel("More actions").click();
  const backupDownload = page.waitForEvent("download");
  await page.getByRole("button", { name: /Download browser backup/ }).click();
  const saved = JSON.parse(await readFile((await (await backupDownload).path())!, "utf8"));
  const trips = saved.records.filter((record: { collection: string }) => record.collection === "trips");
  expect(trips).toHaveLength(3);
  const copy = trips.find((record: { payload: { spec: { name: string } } }) => record.payload.spec.name.endsWith(" (copy)")).payload;
  expect(copy.snapshot).toBeNull(); expect(copy.offers).toEqual([]);
  expect(copy.airport_connections).toEqual(first.airport_connections ?? []);
  expect(copy.airport_transfer_estimates).toEqual(first.airport_transfer_estimates ?? []);
  expect(forbidden).toEqual([]); expect(errors).toEqual([]);
});
