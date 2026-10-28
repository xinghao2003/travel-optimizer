import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "../node_modules/typescript/lib/typescript.js";

const source = readFileSync(new URL("../src/lib/workspace.ts", import.meta.url), "utf8");
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText;
const { tripSetupIssues, workspaceFromHash } = await import("data:text/javascript;base64," + Buffer.from(js).toString("base64"));
const trip = { name: "Taiwan", home: { id: "home" }, visits: [{ min_stay_hours: 90 }], modes: ["flight", "rail"], start_date: "2026-12-24", end_date: "2027-01-04", adults: 1, budget_myr: null, departure_start: "09:00", departure_end: "17:00" };

test("saved trips with complete essentials are ready, including a zero budget", () => {
  assert.deepEqual(tripSetupIssues(trip), []);
  assert.deepEqual(tripSetupIssues({ ...trip, budget_myr: 0 }), []);
});

test("unfinished trips explain every missing essential", () => {
  const issues = tripSetupIssues({ ...trip, name: " ", home: null, visits: [], modes: [] });
  assert.equal(issues.length, 4);
  for (const word of ["home", "city to visit", "name", "mode"]) assert.ok(issues.some(issue => issue.includes(word)));
});

test("invalid dates and unsupported date ranges cannot be submitted", () => {
  for (const change of [{ start_date: "" }, { end_date: "2026-12-23" }, { end_date: "2028-01-04" }]) {
    assert.match(tripSetupIssues({ ...trip, ...change }).join(), /365-day/);
  }
});

test("traveler, budget, and stay limits match the form requirements", () => {
  for (const adults of [0, 10, 1.5]) assert.match(tripSetupIssues({ ...trip, adults }).join(), /adult travelers/);
  assert.match(tripSetupIssues({ ...trip, budget_myr: -1 }).join(), /budget/);
  assert.match(tripSetupIssues({ ...trip, visits: [{ min_stay_hours: -1 }] }).join(), /Minimum stays/);
});

test("invalid hidden search preferences identify where to fix them", () => {
  assert.match(tripSetupIssues({ ...trip, departure_end: "08:00" }).join(), /Search preferences/);
});

test("saved and legacy section links reveal the correct workspace", () => {
  for (const hash of ["#pricing", "#missing-fares-title", "#airport-connections-title"]) assert.equal(workspaceFromHash(hash), "pricing");
  for (const hash of ["#compare", "#frontier-title", "#details-title"]) assert.equal(workspaceFromHash(hash), "compare");
  for (const hash of ["", "#setup", "#setup-title", "#unknown"]) assert.equal(workspaceFromHash(hash), "setup");
});
