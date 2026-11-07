import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

async function setup(page: Page) {
  if (process.env.POC_PYODIDE_CACHE) {
    await page.route("https://cdn.jsdelivr.net/pyodide/v314.0.7/full/**", async route => {
      const name = new URL(route.request().url()).pathname.split("/").pop()!;
      const body = await readFile(join(process.env.POC_PYODIDE_CACHE!, name));
      const type = name.endsWith(".mjs") || name.endsWith(".js") ? "text/javascript" : name.endsWith(".wasm") ? "application/wasm" : "application/octet-stream";
      await route.fulfill({ body, contentType: type, headers: { "Access-Control-Allow-Origin": "*" } });
    });
  }
  await page.route("**/api/v2/**", route => { throw new Error(`Prototype called the original backend: ${route.request().url()}`); });
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto("/prototype.html");
  await expect(page.getByRole("button", { name: "Load example" })).toBeEnabled();
  return errors;
}

function itinerary(day: string, reverse: boolean) {
  return { startTime: `${day}T09:00:00+01:00`, endTime: `${day}T13:00:00+01:00`, legs: [{ mode: "REGIONAL_RAIL", startTime: `${day}T09:00:00+01:00`, endTime: `${day}T13:00:00+01:00`,
    from: { name: reverse ? "Prague" : "Berlin", tz: "Europe/Berlin" }, to: { name: reverse ? "Berlin" : "Prague", tz: "Europe/Berlin" }, agencyName: "Fixture rail", displayName: "Example train" }] };
}

test("Pyodide computes options, persists on reload, and imports exported JSON without a backend", async ({ page }) => {
  const errors = await setup(page);
  await page.getByRole("button", { name: "Load example" }).click();
  await expect(page.getByRole("status")).toHaveText("Calculation complete.", { timeout: 60000 });
  await expect(page.getByRole("heading", { name: "Option 1", exact: true })).toBeVisible();
  await expect(page.getByText("Example data", { exact: true })).toBeVisible();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export graph JSON" }).click();
  const download = await downloadPromise;
  const path = await download.path();
  expect(path).toBeTruthy();
  const before = await page.locator(".routes").innerText();
  await page.reload();
  await expect(page.getByRole("status")).toHaveText("Saved browser trip restored. Continue when ready.");
  expect(await page.locator(".routes").innerText()).toBe(before);
  await page.getByText("Import an existing graph", { exact: true }).click();
  await page.getByLabel("Import graph JSON").setInputFiles(path!);
  await expect(page.getByRole("status")).toHaveText("Calculation complete.", { timeout: 60000 });
  expect(errors).toEqual([]);
  await page.screenshot({ path: "../data/diagnostics/browser-poc/desktop.png", fullPage: true });
});

test("direct OSRM/Transitous retrieval respects batch size, caches responses, and keeps unknown fares", async ({ page }) => {
  const errors = await setup(page);
  let roadRequests = 0, transitRequests = 0;
  await page.route("https://router.project-osrm.org/**", async route => {
    roadRequests++;
    await route.fulfill({ json: { code: "Ok", durations: [[0, 14400], [14400, 0]], distances: [[0, 350000], [350000, 0]] }, headers: { "Access-Control-Allow-Origin": "*" } });
  });
  await page.route("https://api.transitous.org/**", async route => {
    transitRequests++;
    const params = new URL(route.request().url()).searchParams;
    await route.fulfill({ json: { itineraries: [itinerary(params.get("time")!.slice(0, 10), !params.get("fromPlace")!.startsWith("52.5251"))] }, headers: { "Access-Control-Allow-Origin": "*" } });
  });
  await page.getByLabel("Taxi", { exact: true }).check();
  await page.getByLabel("Requests per batch").fill("3");
  await page.getByRole("button", { name: "Start new search" }).click();
  await expect(page.getByRole("status")).toHaveText("Search paused. Search more to continue.", { timeout: 60000 });
  expect([roadRequests, transitRequests]).toEqual([1, 2]);
  await expect(page.getByText(/3\/\d+ queries processed · 3 requests/)).toBeVisible();
  await expect(page.getByRole("heading", { name: "Option 1", exact: true })).toBeVisible();
  await expect(page.getByText(/fare components need prices/)).toBeVisible();
  // Cached tasks do not consume the uncached-request allowance. This round reads
  // its first three cached tasks, then performs three further transit queries.
  await page.getByRole("button", { name: "Start new search" }).click();
  await expect(page.getByText(/3 cache hits/)).toBeVisible({ timeout: 60000 });
  await expect(page.getByRole("button", { name: "Start new search" })).toBeEnabled({ timeout: 60000 });
  await expect(page.getByRole("status")).toHaveText("Search paused. Search more to continue.", { timeout: 60000 });
  expect(roadRequests).toBe(1);
  expect(transitRequests).toBe(5);
  await expect(page.getByText(/3 cache hits/)).toBeVisible();
  expect(errors).toEqual([]);
});

test("flight queries use only the stateless function and preserve whole-party prices", async ({ page }) => {
  const errors = await setup(page);
  let flightRequests = 0;
  await page.route("https://router.project-osrm.org/**", async route => {
    const count = new URL(route.request().url()).pathname.split("/").pop()!.split(";").length;
    const matrix = Array.from({ length: count }, (_, i) => Array.from({ length: count }, (_, j) => i === j ? 0 : 1800));
    await route.fulfill({ json: { code: "Ok", durations: matrix, distances: matrix }, headers: { "Access-Control-Allow-Origin": "*" } });
  });
  await page.route("**/api/flights", async route => {
    flightRequests++;
    const request = route.request().postDataJSON(), leg = request.legs[0];
    expect(request.adults).toBe(3);
    await route.fulfill({ json: { status: "success", kind: "one-way", options: [{ price: 120, journeys: [[{
      mode: "flight", from_id: leg.from_airports[0], to_id: leg.to_airports[0], from_name: leg.from_code, to_name: leg.to_code,
      departure: `${leg.date}T12:00:00+01:00`, arrival: `${leg.date}T13:00:00+01:00`, from_timezone: "Europe/Berlin", to_timezone: "Europe/Prague", source: "Google Flights / fast-flights" }]] }] } });
  });
  await page.getByLabel("Rail", { exact: true }).uncheck();
  await page.getByLabel("Flights", { exact: true }).check();
  await page.getByLabel("Adults", { exact: true }).fill("3");
  await page.getByLabel("Requests per batch").fill("3");
  await page.getByRole("button", { name: "Start new search" }).click();
  await expect(page.getByRole("status")).toHaveText("Search paused. Search more to continue.", { timeout: 60000 });
  expect(flightRequests).toBe(2);
  await expect(page.getByText("From RM 240.00 · not fully priced").first()).toBeVisible();
  expect(errors).toEqual([]);
});

test("stopping an in-flight query keeps its cursor and retries it after reload", async ({ page }) => {
  const errors = await setup(page);
  let requests = 0;
  await page.route("https://api.transitous.org/**", async route => {
    requests++;
    if (requests === 1) await new Promise(resolve => setTimeout(resolve, 2000));
    const params = new URL(route.request().url()).searchParams;
    await route.fulfill({ json: { itineraries: [itinerary(params.get("time")!.slice(0, 10), !params.get("fromPlace")!.startsWith("52.5251"))] }, headers: { "Access-Control-Allow-Origin": "*" } }).catch(() => {});
  });
  await page.getByLabel("Requests per batch").fill("1");
  await page.getByRole("button", { name: "Start new search" }).click();
  await expect.poll(() => requests, { timeout: 60000 }).toBe(1);
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("Stopped. Collected data is saved in this browser.");
  await expect(page.getByText(/0\/\d+ queries processed/)).toBeVisible();
  await page.reload();
  await expect(page.getByRole("status")).toHaveText("Saved browser trip restored. Continue when ready.");
  await page.getByLabel("Requests per batch").fill("1");
  await page.getByRole("button", { name: "Search more", exact: true }).click();
  await expect(page.getByText(/1\/\d+ queries processed/)).toBeVisible({ timeout: 60000 });
  await expect(page.getByRole("button", { name: "Start new search" })).toBeEnabled({ timeout: 60000 });
  expect(requests).toBe(2);
  expect(errors).toEqual([]);
});
