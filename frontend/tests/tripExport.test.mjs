import assert from "node:assert/strict";
import { test } from "node:test";
import { loadTs } from "./loadTs.mjs";
import { sampleTrip } from "./tripExport.fixture.mjs";
const { exportFilename, exportTrip, tripReportHtml } = await loadTs("../src/lib/tripExport.ts");
const generated = new Date("2026-11-07T10:00:00Z");

test("a shared report preserves group cost, full local dates, city stays and tickets", () => {
  const html = tripReportHtml([exportTrip(sampleTrip())], generated);
  assert.match(html, /RM\s*1,000 for 3 adults/);
  assert.match(html, /5 Dec 2026, 07:00.*Asia\/Kuala_Lumpur/);
  assert.match(html, /5 Dec 2026, 15:00.*Asia\/Tokyo/);
  assert.match(html, /68\.0 h in city/);
  assert.match(html, /Example Air EA100/);
  assert.match(html, /Tickets and prices/);
  assert.match(html, /2026-11-07 10:00:00 UTC/);
  assert.match(html, /Accommodation, meals and activities are excluded/);
});

test("unpriced, ranged and foreign-currency fares are never shown as complete totals", () => {
  const record = sampleTrip(), route = record.result.routes[0];
  route.total_cost_myr = null; route.cost_high_myr = null; route.cost_low_myr = 500;
  route.purchases[1].low = null; route.purchases[1].high = null; route.purchases[1].source = "unknown";
  let html = tripReportHtml([exportTrip(record)], generated);
  assert.match(html, /From RM\s*500/);
  assert.match(html, /1 not priced: 1 flight/);
  assert.match(html, /The total is incomplete/);
  route.cost_high_myr = 1500;
  route.purchases[1] = { ...route.purchases[1], low: 500, high: 1000, currency: "JPY" };
  html = tripReportHtml([exportTrip(record)], generated);
  assert.match(html, /RM\s*500 – 1,500/);
  assert.match(html, /needs an exchange rate/);
});

test("selected-option labels and categories survive export without renumbering", () => {
  const record = sampleTrip(), route = record.result.routes[0];
  const trip = exportTrip(record, [{ label: "Option 37", route, category: "Weaker" }]);
  const html = tripReportHtml([trip], generated);
  assert.match(html, /Option 37/);
  assert.match(html, /Weaker/);
  assert.equal((html.match(/class="itinerary"/g) ?? []).length, 1);
});

test("all-trip reports include every result group and trips with no results", () => {
  const record = sampleTrip();
  record.result.dominated_routes = [{ ...record.result.routes[0], id: "weak" }];
  record.result.refinement_routes = [{ ...record.result.routes[0], id: "over" }];
  const empty = sampleTrip(); empty.spec.name = "Next holiday"; delete empty.result;
  const trip = exportTrip(record);
  assert.deepEqual(trip.options.map(option => option.category), ["Best", "Weaker", "Over budget"]);
  const html = tripReportHtml([trip, exportTrip(empty)], generated);
  assert.match(html, /Trip comparison/);
  assert.match(html, /Next holiday/);
  assert.match(html, /No calculated options saved yet/);
});

test("stale trip revisions exclude itineraries; pending snapshots and partial search are explicit", () => {
  const record = sampleTrip();
  record.revision++;
  const stale = exportTrip(record, [{ label: "Old option", route: record.result.routes[0], category: "Best" }]);
  assert.equal(stale.options.length, 0);
  assert.match(stale.notes.join(" "), /out of date/);
  record.revision--; record.snapshot.revision++;
  record.result.optimization_complete = false; record.result.coverage.pending = 10;
  assert.match(exportTrip(record).notes.join(" "), /Newer collected schedules/);
  assert.match(exportTrip(record).notes.join(" "), /Not all combinations/);
  assert.match(exportTrip(record).notes.join(" "), /search is incomplete/);
});

test("user and provider text is escaped, non-English names survive, and unsafe links are omitted", () => {
  const record = sampleTrip(); record.spec.name = '<script>alert("trip")</script> 東京';
  record.result.routes[0].movements[0].search_url = "javascript:alert(1)";
  record.result.routes[0].movements[0].assumptions = ['<img src=x onerror="alert(1)">'];
  const html = tripReportHtml([exportTrip(record)], generated);
  assert.doesNotMatch(html, /<script|<img|javascript:/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /東京/);
  assert.match(html, /https:\/\/example.com\/fares\?a=1&amp;b=2/);
});

test("estimated timetable notices include their reference date", () => {
  const record = sampleTrip();
  Object.assign(record.result.routes[0].movements[0], { schedule_estimated: true, schedule_reference_date: "2026-10-30" });
  assert.match(tripReportHtml([exportTrip(record)], generated), /Estimated timetable copied from 2026-10-30/);
});

test("download names keep Unicode and remove filesystem-invalid characters", () => {
  assert.equal(exportFilename('東京: friends / trip?'), "東京- friends - trip-.html");
  assert.equal(exportFilename("  ...  "), "trips.html");
});
