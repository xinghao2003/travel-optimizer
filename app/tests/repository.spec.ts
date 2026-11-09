import { spawnSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";

test("browser repository commits edits atomically, rejects stale workers, and prunes only provider cache", async ({ page }) => {
  await page.route("**/repository-test", route => route.fulfill({ contentType: "text/html", body: "<!doctype html>" }));
  await page.goto("/repository-test");
  const result = await page.evaluate(async () => {
    const { PlannerRepository } = await import("/src/native/repository.ts");
    const { applyMissingInfo, parseApplyChanges } = await import("/src/native/edits.ts");
    const { prepareSolverInput, completeResult } = await import("/src/native/preparation.ts");
    const { solveNative } = await import("/src/native/solver.ts");
    const corpus = await (await fetch("/tests/fixtures/preparation.json")).json();
    const sample = corpus.cases.find((c: { trip: { snapshot: unknown }; expected_result: { routes: unknown[] } }) => c.trip.snapshot && c.expected_result.routes.length);
    const name = "wayfinder-repository-test-" + crypto.randomUUID(), repository = new PlannerRepository(name);
    const trip = structuredClone(sample.trip);
    await repository.put("trips", trip.id, trip);
    const { input, snapshot } = prepareSolverInput(trip, sample.rules, { ...sample.options, expansion_budget: 5 });
    const partial = solveNative(input);
    const saved = await repository.saveCalculation(trip.id, trip.revision, trip.snapshot.revision, snapshot, completeResult(partial.result, snapshot, trip), partial.state);
    const stored = await repository.requireTrip(trip.id);
    const state = await repository.checkpoint(trip.id);
    const clonePreserved = state?.labels instanceof Map && Array.isArray(state.queue.buckets) && state.queue.buckets[0] instanceof Map;
    const before = JSON.stringify(stored);
    let invalid = false;
    try { await repository.updateTrip(trip.id, current => applyMissingInfo(current, parseApplyChanges({ expected_revision: current.revision, connections: [], estimates: [{ component_ids: ["not-this-trip"], low: 1 }] }), corpus.catalog)); }
    catch { invalid = true; }
    const rolledBack = JSON.stringify(await repository.requireTrip(trip.id)) === before && !!await repository.checkpoint(trip.id);
    const edits = await Promise.allSettled([1, 2].map(rate => repository.updateTrip(trip.id, current => applyMissingInfo(current, parseApplyChanges({ expected_revision: stored.revision, exchange_rates: { USD: rate } }), corpus.catalog))));
    const oneWinner = edits.filter(r => r.status === "fulfilled").length === 1 && edits.filter(r => r.status === "rejected" && r.reason?.status === 409).length === 1;
    const checkpointCleared = await repository.checkpoint(trip.id) === undefined;
    const staleWorkerRejected = !await repository.saveCalculation(trip.id, stored.revision, stored.snapshot!.revision, snapshot, completeResult(partial.result, snapshot, trip), partial.state);
    const updated = await repository.requireTrip(trip.id);
    await repository.put("trips", trip.id, { ...updated, snapshot: { ...updated.snapshot!, revision: updated.snapshot!.revision + 1 } });
    const staleGraphRejected = !await repository.saveCalculation(trip.id, updated.revision, updated.snapshot!.revision, snapshot, completeResult(partial.result, snapshot, trip), partial.state);
    await repository.put("graphs", "retained", updated.snapshot);
    const now = Date.now();
    await repository.putCache("expired", { provider: true }, .001, now - 1000);
    await repository.putCache("fresh", { provider: true }, 3600, now);
    await repository.putCache("expires-on-reopen", { provider: true }, .001);
    const expiredMiss = await repository.getCache("expired") === undefined;
    await repository.close();
    await new Promise(resolve => setTimeout(resolve, 5));
    const reopened = new PlannerRepository(name);
    await reopened.ready();
    const persisted = (await reopened.requireTrip(trip.id)).revision === stored.revision + 1 && !!await reopened.get("graphs", "retained") && !!await reopened.getCache("fresh");
    const startupPruned = await reopened.pruneCache() === 0 && await reopened.getCache("expires-on-reopen") === undefined;
    await reopened.put("meta", "selected-trip", trip.id);
    const copy = await reopened.duplicateTrip(trip.id);
    const copyCorrect = copy.id !== trip.id && copy.spec.name.endsWith(" (copy)") && copy.snapshot === null && copy.offers.length === 0;
    await reopened.put("jobs", "job", { id: "job", trip_id: trip.id, status: "running" });
    let activeDeleteStatus: number | null = null;
    try { await reopened.deleteTrip(trip.id); } catch (e) { if (e && typeof e === "object" && "status" in e) activeDeleteStatus = Number(e.status); }
    await reopened.put("jobs", "job", { id: "job", trip_id: trip.id, status: "complete" });
    await reopened.deleteTrip(trip.id);
    const deleted = !await reopened.get("trips", trip.id) && !await reopened.get("jobs", "job") && await reopened.get("meta", "selected-trip") === null && !!await reopened.get("trips", copy.id);
    await reopened.close();
    await new Promise<void>((resolve, reject) => { const request = indexedDB.deleteDatabase(name); request.onsuccess = () => resolve(); request.onerror = () => reject(request.error); });
    return { saved, clonePreserved, invalid, rolledBack, oneWinner, checkpointCleared, staleWorkerRejected, staleGraphRejected, expiredMiss, startupPruned, persisted, copyCorrect, activeDeleteStatus, deleted };
  });
  expect(result).toEqual({ saved: true, clonePreserved: true, invalid: true, rolledBack: true, oneWinner: true, checkpointCleared: true, staleWorkerRejected: true, staleGraphRejected: true, expiredMiss: true, startupPruned: true, persisted: true, copyCorrect: true, activeDeleteStatus: 409, deleted: true });
});

test("portable backup import is atomic, preserves trip data and rules, and interrupts imported jobs", async ({ page }) => {
  await page.route("**/backup-test", route => route.fulfill({ contentType: "text/html", body: "<!doctype html>" }));
  await page.goto("/backup-test");
  const summary = await page.evaluate(async () => {
    const { PlannerRepository } = await import("/src/native/repository.ts");
    const { firstDifference } = await import("/tests/compare.ts");
    const { prepareSolverInput, completeResult, tripMetadata } = await import("/src/native/preparation.ts");
    const { solveNative } = await import("/src/native/solver.ts");
    const corpus = await (await fetch("/tests/fixtures/preparation.json")).json();
    const sample = corpus.cases[1], name = "wayfinder-backup-test-" + crypto.randomUUID(), targetName = name + "-target", roundtripName = name + "-roundtrip";
    const source = new PlannerRepository(name), target = new PlannerRepository(targetName);
    await source.put("trips", sample.trip.id, sample.trip);
    for (const rule of sample.rules) await source.put("rules", rule.id, rule);
    await source.put("jobs", "search", { id: "search", trip_id: sample.trip.id, status: "running", queue: [{ kind: "flight", key: "retained-query" }], cursor: 0, snapshot: sample.trip.snapshot });
    await source.put("meta", "selected-trip", sample.trip.id);
    const backup = JSON.parse(JSON.stringify(await source.exportBackup()));
    const count = await target.importBackup(backup);
    const importedTrip = await target.requireTrip(sample.trip.id), rules = await target.list("rules"), job = await target.get<{ status: string; queue: { key: string }[] }>("jobs", "search");
    const prepared = prepareSolverInput(importedTrip, rules as typeof sample.rules, sample.options);
    const result = completeResult(solveNative(prepared.input).result, prepared.snapshot, importedTrip);
    const preservationDifference = firstDifference(sample.expected_input, prepared.input) ?? firstDifference(sample.expected_result, result)
      ?? firstDifference(sample.expected_metadata, tripMetadata({ ...importedTrip, snapshot: prepared.snapshot, result }, corpus.catalog)) ?? firstDifference(sample.rules, rules);
    const preserved = preservationDifference === null && job?.status === "interrupted" && job.queue[0].key === "retained-query" && await target.get("meta", "selected-trip") === sample.trip.id;
    const before = JSON.stringify(await target.exportBackup());
    let conflict = false;
    try { await target.importBackup(backup); } catch { conflict = true; }
    const afterConflict = await target.exportBackup();
    const unchangedOnConflict = firstDifference(JSON.parse(before).records, afterConflict.records) === null;
    const invalid = structuredClone(backup);
    invalid.records.push({ schema_version: 1, collection: "trips", id: "bad", payload: { id: "bad", spec: {} } });
    let rejected = false;
    try { await target.importBackup(invalid, true); } catch { rejected = true; }
    const unchangedOnInvalid = firstDifference(afterConflict.records, (await target.exportBackup()).records) === null;
    await target.importBackup(backup, true);
    const replacementRevisionAdvanced = (await target.requireTrip(sample.trip.id)).revision > importedTrip.revision;
    const exported = await target.exportBackup(), restored = new PlannerRepository(roundtripName);
    await restored.importBackup(JSON.parse(JSON.stringify(exported)));
    const roundtrip = firstDifference(exported.records, (await restored.exportBackup()).records) === null;
    await source.close(); await target.close(); await restored.close();
    await Promise.all([name, targetName, roundtripName].map(db => new Promise<void>((resolve, reject) => { const r = indexedDB.deleteDatabase(db); r.onsuccess = () => resolve(); r.onerror = () => reject(r.error); })));
    return { count, expectedCount: backup.records.length, preserved, preservationDifference, conflict, unchangedOnConflict, rejected, unchangedOnInvalid, replacementRevisionAdvanced, roundtrip };
  });
  expect(summary.count).toBe(summary.expectedCount);
  console.log(JSON.stringify(summary, null, 2));
  expect(summary).toMatchObject({ preserved: true, conflict: true, unchangedOnConflict: true, rejected: true, unchangedOnInvalid: true, replacementRevisionAdvanced: true, roundtrip: true });
});

test("native worker calculation resumes stored checkpoints, stops cleanly, and reprices the complete graph", async ({ page }) => {
  const requests: string[] = [];
  page.on("request", request => requests.push(request.url()));
  await page.route("**/calculation-test", route => route.fulfill({ contentType: "text/html", body: "<!doctype html>" }));
  await page.goto("/calculation-test");
  const summary = await page.evaluate(async () => {
    const { PlannerRepository } = await import("/src/native/repository.ts");
    const { BrowserCalculator } = await import("/src/native/calculation.ts");
    const { applyMissingInfo, parseApplyChanges } = await import("/src/native/edits.ts");
    const { prepareSolverInput, completeResult } = await import("/src/native/preparation.ts");
    const { solveNative } = await import("/src/native/solver.ts");
    const { firstDifference } = await import("/tests/compare.ts");
    const corpus = await (await fetch("/tests/fixtures/preparation.json")).json(), edits = await (await fetch("/tests/fixtures/edits.json")).json();
    const name = "wayfinder-calculation-test-" + crypto.randomUUID(), sample = corpus.cases[1];
    let repository = new PlannerRepository(name), calculator = new BrowserCalculator(repository);
    await repository.put("trips", sample.trip.id, sample.trip);
    for (const rule of sample.rules) await repository.put("rules", rule.id, rule);
    const prefix = await calculator.calculate(sample.trip.id, { ...sample.options, unlimited: true, expansion_budget: 5 });
    const paused = !prefix.optimization_complete && prefix.expanded_labels === 5 && !!await repository.checkpoint(sample.trip.id);
    await repository.close(); repository = new PlannerRepository(name); calculator = new BrowserCalculator(repository);
    const resumed = await calculator.calculate(sample.trip.id, { ...sample.options, unlimited: true, expansion_budget: null });
    const expected = { ...sample.expected_result, label_limit: null }; delete expected.safety_limit_reached;
    const resumedDifference = firstDifference(expected, resumed), finishedClearedCheckpoint = !await repository.checkpoint(sample.trip.id);
    const corrected = edits.cases.find((item: { operation: string; valid: boolean; input: { request?: { estimates?: { component_ids: string[]; low: number }[] } } }) => item.operation === "apply_missing_info" && item.valid && item.input.request?.estimates?.some(e => e.component_ids.includes("weaker") && e.low === 1));
    await repository.put("trips", corrected.input.trip.id, corrected.input.trip);
    await calculator.calculate(corrected.input.trip.id, { unlimited: true, expansion_budget: null });
    await repository.updateTrip(corrected.input.trip.id, trip => applyMissingInfo(trip, parseApplyChanges(corrected.input.request), edits.catalog));
    const repriced = await calculator.calculate(corrected.input.trip.id, { unlimited: true, expansion_budget: null });
    const weakerBecameBest = repriced.routes.some(r => r.movements[0].id === "weaker" && r.total_cost_myr === 11);
    const solverCorpus = await (await fetch("/tests/fixtures/solver.json")).json();
    const fair = solverCorpus.cases.find((c: { input: { movements: { id: string }[]; expansion_budget?: number } }) => c.input.expansion_budget === 100 && c.input.movements.some(m => m.id === "priced-out")).input;
    const movements = [...fair.movements], offers = [...fair.offers];
    for (let copy = 1; copy < 10; copy++) for (const m of fair.movements.filter((m: { id: string }) => m.id.startsWith("train-"))) {
      const id = `${m.id}-copy-${copy}`; movements.push({ ...m, id });
      for (const o of fair.offers.filter((o: { movement_ids: string[] }) => o.movement_ids.length === 1 && o.movement_ids[0] === m.id)) offers.push({ ...o, id: `${o.id}-copy-${copy}`, movement_ids: [id] });
    }
    const stopTrip = { id: "stop-test", revision: 1, spec: fair.spec, offers: [], latest_job_id: null, snapshot: { revision: 1, movements, offers, coverage: {} } };
    await repository.put("trips", stopTrip.id, stopTrip);
    const stopping = new BrowserCalculator(repository, id => { void stopping.stop(id); });
    const stopped = await stopping.calculate(stopTrip.id, { unlimited: true, expansion_budget: null });
    const stopPersisted = !stopped.optimization_complete && stopped.expanded_labels > 0 && !!await repository.checkpoint(stopTrip.id) && !stopping.isRunning(stopTrip.id);
    const current = await repository.requireTrip(stopTrip.id), currentRules = await repository.list("rules");
    const fullInput = prepareSolverInput(current, currentRules as typeof sample.rules, { unlimited: true, expansion_budget: null });
    const fullExpected = completeResult(solveNative(fullInput.input).result, fullInput.snapshot, current);
    const completedAfterStop = await calculator.calculate(stopTrip.id, { unlimited: true, expansion_budget: null });
    const stoppedResumeDifference = firstDifference(fullExpected, completedAfterStop);
    const budgetId = "multi-batch-budget", allowance = Math.floor((fullExpected.expanded_labels + stopped.expanded_labels) / 2);
    await repository.put("trips", budgetId, { ...stopTrip, id: budgetId });
    const budgeted = await calculator.calculate(budgetId, { unlimited: true, expansion_budget: allowance });
    const multiBatchBudget = !budgeted.optimization_complete && budgeted.expanded_labels === allowance && budgeted.safety_limit_reached;
    await repository.close();
    await new Promise<void>((resolve, reject) => { const r = indexedDB.deleteDatabase(name); r.onsuccess = () => resolve(); r.onerror = () => reject(r.error); });
    return { paused, resumedDifference, finishedClearedCheckpoint, weakerBecameBest, stopPersisted, stoppedResumeDifference, multiBatchBudget };
  });
  console.log(JSON.stringify(summary, null, 2));
  expect(summary).toEqual({ paused: true, resumedDifference: null, finishedClearedCheckpoint: true, weakerBecameBest: true, stopPersisted: true, stoppedResumeDifference: null, multiBatchBudget: true });
  expect(requests.filter(url => /\/api\/|jsdelivr/.test(url))).toEqual([]);
});

test("debug bundles add the event log, restore as backups, and replay in Node", async ({ page }, testInfo) => {
  await page.route("**/debug-bundle-test", route => route.fulfill({ contentType: "text/html", body: "<!doctype html>" }));
  await page.goto("/debug-bundle-test");
  const summary = await page.evaluate(async () => {
    const { PlannerRepository } = await import("/src/native/repository.ts");
    const { BrowserCalculator } = await import("/src/native/calculation.ts");
    const corpus = await (await fetch("/tests/fixtures/preparation.json")).json(), sample = corpus.cases[1];
    const name = "wayfinder-debug-test-" + crypto.randomUUID(), repository = new PlannerRepository(name), calculator = new BrowserCalculator(repository);
    await repository.put("trips", sample.trip.id, sample.trip);
    await repository.put("trips", "other", { ...sample.trip, id: "other" });
    for (const rule of sample.rules) await repository.put("rules", rule.id, rule);
    await repository.put("meta", "selected-trip", sample.trip.id);
    const partial = await calculator.calculate(sample.trip.id, { ...sample.options, unlimited: true, expansion_budget: 5 });
    await repository.logEvent("other", { type: "search", status: "started" });
    const plain = await repository.exportBackup(), bundle = JSON.parse(JSON.stringify(await repository.exportBackup({ app_commit: "test" })));
    const restored = new PlannerRepository(name + "-restored"), restoredCount = await restored.importBackup(bundle);
    await repository.clearEvents(sample.trip.id);
    const afterClear = (await repository.exportBackup({})).debug!.events.map(e => e.trip_id);
    await repository.deleteTrip("other");
    const afterDelete = (await repository.exportBackup({})).debug!.events.length;
    await repository.close(); await restored.close();
    await Promise.all([name, name + "-restored"].map(db => new Promise<void>((resolve, reject) => { const r = indexedDB.deleteDatabase(db); r.onsuccess = () => resolve(); r.onerror = () => reject(r.error); })));
    const calculation = bundle.debug.events.find((e: { type: string }) => e.type === "calculation");
    return { bundle, partialIncomplete: !partial.optimization_complete, plainHasNoEvents: !plain.debug && !plain.records.some(r => r.collection === "events"),
      eventTypes: bundle.debug.events.map((e: { type: string }) => e.type).sort(), calculationLogged: calculation.now === sample.options.now && calculation.expanded_labels === 5 && calculation.batches === 1 && calculation.saved,
      restoredAll: restoredCount === bundle.records.length, afterClear, afterDelete };
  });
  const { bundle, ...checks } = summary;
  expect(checks).toEqual({ partialIncomplete: true, plainHasNoEvents: true, eventTypes: ["calculation", "search"], calculationLogged: true, restoredAll: true, afterClear: ["other"], afterDelete: 0 });
  const file = testInfo.outputPath("debug-bundle.json");
  await writeFile(file, JSON.stringify(bundle));
  const replay = spawnSync(process.execPath, ["scripts/replay.mjs", file], { encoding: "utf8" });
  expect(replay.stdout).toContain("The replay matches the saved options.");
  expect(replay.status).toBe(0);
  const events = spawnSync(process.execPath, ["scripts/replay.mjs", file, "--events"], { encoding: "utf8" });
  expect(events.stdout).toMatch(/calculation\s+partial\s+5 labels/);
});
