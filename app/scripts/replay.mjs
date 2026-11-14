// Replay a trip's calculation from a browser backup or debug bundle in Node.
// Run `node scripts/replay.mjs --help` from app/ for usage.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { loadTs } from "../tests/loadTs.mjs";

const USAGE = `Usage: node scripts/replay.mjs <backup.json> [options]

Recalculates a saved trip with the current solver and compares the result with
the result saved in the backup. Exit code 1 means the results differ.

  --list                  List the trips in the backup.
  --trip <id or name>     Trip to replay. Default: the selected trip.
  --label-limit <n|none>  Labels to expand. Default: the saved result's count,
                          or "none" when the saved result was complete.
  --now <ISO time>        Clock for quote freshness. Default: the clock of the
                          last logged calculation, else the export time.
  --dominated             Also calculate weaker options.
  --out <file>            Write the replayed result as JSON.
  --case <file>           Write a solver fixture case { name, input, expected }.

Debug bundles only:
  --events                List the search and calculation log of the trip.
  --event <n>             Repeat ingestion of provider event n and show the
                          journeys it produces and whether the graph has them.`;

const { values: opts, positionals } = parseArgs({ allowPositionals: true, options: {
  list: { type: "boolean" }, trip: { type: "string" }, "label-limit": { type: "string" }, now: { type: "string" }, dominated: { type: "boolean" },
  out: { type: "string" }, case: { type: "string" }, events: { type: "boolean" }, event: { type: "string" }, help: { type: "boolean", short: "h" } } });
if (opts.help || positionals.length !== 1) { console.log(USAGE); process.exit(opts.help ? 0 : 2); }

const { parseBackup } = await loadTs("../src/native/backup.ts");
const { prepareSolverInput, completeResult } = await loadTs("../src/native/preparation.ts");
const { solveNative } = await loadTs("../src/native/solver.ts");
const { parseSpec } = await loadTs("../src/native/contracts.ts");
const { micros } = await loadTs("../src/native/time.ts");

const raw = JSON.parse(readFileSync(positionals[0], "utf8")), backup = parseBackup(raw), debug = raw.debug;
const payloads = collection => backup.records.filter(r => r.collection === collection).map(r => r.payload);
const trips = payloads("trips"), rules = payloads("rules");
// The airport transfer ways shared by all trips (meta record "airport-transfers").
const sharedTransfers = backup.records.find(r => r.collection === "meta" && r.id === "airport-transfers")?.payload ?? [];
const money = value => value == null ? "?" : "RM " + Math.round(value).toLocaleString("en");
const price = route => route.cost_low_myr === route.cost_high_myr ? money(route.cost_low_myr) : `${money(route.cost_low_myr)}–${money(route.cost_high_myr)}`;
const local = iso => iso ? iso.slice(5, 16).replace("T", " ") : "—";

if (debug) console.log(`Debug bundle: commit ${debug.app_commit}, solver revision ${debug.solver_revision}, exported ${backup.exported_at}`);
else console.log(`Backup exported ${backup.exported_at} (no debug log)`);
if (opts.list) {
  for (const t of trips) console.log(`  ${t.id}  ${t.spec.name}  ${t.spec.start_date} → ${t.spec.end_date}  ${t.result ? t.result.routes.length + " options" : "no result"}`);
  process.exit(0);
}
const selected = backup.records.find(r => r.collection === "meta" && r.id === "selected-trip")?.payload;
const wanted = opts.trip ?? selected ?? (trips.length === 1 ? trips[0].id : null);
const trip = trips.find(t => t.id === wanted) ?? trips.filter(t => t.spec.name === wanted).at(0);
if (!trip) { console.error(wanted ? `Trip "${wanted}" not found. Use --list.` : "Choose a trip with --trip. Use --list."); process.exit(2); }
const events = (debug?.events ?? []).filter(e => e.trip_id === trip.id);
console.log(`Trip ${trip.id} "${trip.spec.name}", revision ${trip.revision}, ${trip.snapshot?.movements.length ?? 0} journeys, ${trip.snapshot?.offers.length ?? 0} fares`);

if (opts.events) {
  if (!debug) { console.error("--events needs a debug bundle."); process.exit(2); }
  events.forEach((e, n) => {
    const head = `${String(n).padStart(4)}  ${e.at.slice(11, 19)}  ${e.type.padEnd(12)}`;
    if (e.type === "provider") {
      const t = e.task, what = t.kind === "bundle" ? `${t.ticket_kind} ${t.legs.map(l => `${l.from_id}→${l.to_id} ${l.date}`).join(", ")}` : `${t.kind} ${t.from_id ?? ""}→${t.to_id ?? ""} ${t.rail_reference_date ? `${t.date} (from ${t.rail_reference_date})` : t.date ?? ""}${t.rail_radius ? " radius" : ""}${t.cursor ? " next page" : ""}`;
      console.log(`${head}${e.status.padEnd(9)} ${e.used_request ? "request" : "cache  "} ${String(e.duration_ms).padStart(6)} ms  +${e.new_movements} journeys  ${what}${e.outcome.message ? `  — ${e.outcome.message}` : ""}`);
    } else if (e.type === "calculation") {
      console.log(`${head}${e.optimization_complete ? "complete " : "partial  "} ${e.expanded_labels ?? "?"} labels${e.resumed_from ? ` (resumed at ${e.resumed_from})` : ""}, ${e.routes ?? "?"} options, ${e.movements} journeys, ${e.batches} batches, solve ${e.solve_ms} ms, wall ${e.wall_ms} ms${e.saved === false ? ", discarded (inputs changed)" : ""}${e.error ? `  — ${e.error}` : ""}`);
    } else {
      console.log(`${head}${e.status}${e.pause_reason ? ` (${e.pause_reason})` : ""}${e.status === "started" ? `, ${e.queued} queued, ${e.minutes ? e.minutes + " min" : e.request_budget + " requests"}${e.resumed ? ", resumed" : ""}` : `, ${e.processed} processed, ${e.pending} pending, ${e.requests} requests, ${e.cache_hits} cache hits`}`);
    }
  });
  process.exit(0);
}

if (opts.event !== undefined) {
  if (!debug) { console.error("--event needs a debug bundle."); process.exit(2); }
  const event = events[Number(opts.event)];
  if (event?.type !== "provider") { console.error(`Event ${opts.event} is not a provider event. Use --events.`); process.exit(2); }
  const { ingest } = await loadTs("../src/native/ingestion.ts");
  // Flight legs list metro airports from the generated catalog; without it, only the cities' own airports.
  const catalogFile = new URL("../public/browser-data/airports.json", import.meta.url);
  const metros = existsSync(catalogFile) ? JSON.parse(readFileSync(catalogFile, "utf8")).metros : {};
  const spec = parseSpec(trip.spec), snapshot = { revision: 0, movements: [], offers: [], roads: trip.snapshot?.roads ?? {}, coverage: {} };
  const collected = ingest(event.task, structuredClone(event.outcome), spec, snapshot, metros, event.now);
  const graph = new Set(trip.snapshot?.movements.map(m => m.id) ?? []);
  const inRoutes = new Set([...(trip.result?.routes ?? []), ...(trip.result?.refinement_routes ?? [])].flatMap(r => r.movements.map(m => m.id)));
  const payload = event.outcome.payload;
  console.log(`Provider ${event.task.kind} ${event.status}: ${payload?.itineraries ? payload.itineraries.length + " itineraries returned" : event.outcome.options ? event.outcome.options.length + " options returned" : ""}`);
  console.log(`Ingestion produces ${collected.length} journeys and ${snapshot.offers.length} fares (times in UTC; graph = in the saved graph, route = in a saved option):`);
  for (const m of collected) {
    const fare = snapshot.offers.find(o => o.movement_ids.includes(m.id));
    console.log(`  ${graph.has(m.id) ? "graph" : "     "} ${inRoutes.has(m.id) ? "route" : "     "}  ${m.mode.padEnd(6)} ${local(m.departure)} → ${local(m.arrival)}  ${m.transfers ?? 0} transfers  ${fare ? `${fare.low} ${fare.currency}` : "no fare"}${m.usable === false ? "  NOT USABLE" : ""}  ${m.segments.filter(s => !["walk", "foot", "wait", "transfer"].includes(s.mode)).map(s => s.service ?? s.mode).join(" + ")}`);
    if (m.usable === false || m.schedule_estimated) for (const a of m.assumptions) console.log(`         ${a}`);
  }
  process.exit(0);
}

const saved = trip.result;
const lastCalculation = events.filter(e => e.type === "calculation" && e.trip_revision === trip.revision).at(-1);
const now = opts.now ? Number(micros(opts.now)) : lastCalculation?.now ?? Number(micros(backup.exported_at));
const limitArg = opts["label-limit"] ?? (saved && !saved.optimization_complete ? String(saved.expanded_labels) : "none");
const includeDominated = opts.dominated ?? !!saved?.dominated_routes;
const { input, snapshot } = prepareSolverInput(trip, rules, { now, include_dominated: includeDominated, shared_transfers: sharedTransfers });
input.label_limit = limitArg === "none" ? null : Number(limitArg);
input.expansion_budget = null;
console.log(`Input: ${input.movements.length} journeys, ${input.offers.length} fares, ${input.rules.length} rules; label limit ${input.label_limit ?? "none"}; clock ${new Date(now / 1000).toISOString()}`);

const began = performance.now(), solved = solveNative(input).result, ms = performance.now() - began;
const replayed = completeResult(structuredClone(solved), snapshot, trip);
const stats = r => `${r.routes.length} options, ${r.refinement_routes?.length ?? 0} over budget, ${r.expanded_labels} labels expanded, ${r.pruned_labels} pruned, ${r.remaining_labels ?? "?"} remaining, ${r.optimization_complete ? "complete" : "not complete"}`;
console.log(`Replay: ${stats(replayed)} in ${(ms / 1000).toFixed(2)} s`);
if (opts.out) writeFileSync(opts.out, JSON.stringify(replayed, null, 1));
if (opts.case) writeFileSync(opts.case, JSON.stringify({ name: `replay-${trip.id}`, input, expected: solved }));
if (!saved) { console.log("The backup has no saved result to compare."); process.exit(0); }
console.log(`Saved:  ${stats(saved)}`);
if (saved.trip_revision !== trip.revision || saved.snapshot_revision !== snapshot.revision) console.log(`Warning: the saved result is for trip revision ${saved.trip_revision} and graph revision ${saved.snapshot_revision}, not ${trip.revision} and ${snapshot.revision}. Differences are expected.`);
if (trip.native_solver_revision !== debug?.solver_revision && debug) console.log(`Warning: the saved result came from solver revision ${trip.native_solver_revision}.`);

const describe = r => `${price(r).padEnd(18)} ${r.stay_hours.toFixed(1).padStart(6)} h  ${[r.movements[0]?.from_id, ...r.movements.map(m => m.to_id)].join(" → ")}  ${r.id.slice(0, 12)}`;
let differences = 0;
for (const group of ["routes", "refinement_routes", ...(includeDominated ? ["dominated_routes"] : [])]) {
  const before = new Map((saved[group] ?? []).map(r => [r.id, r])), after = new Map((replayed[group] ?? []).map(r => [r.id, r]));
  const lost = [...before.values()].filter(r => !after.has(r.id)), added = [...after.values()].filter(r => !before.has(r.id));
  const changed = [...after.values()].filter(r => before.has(r.id) && (["cost_low_myr", "cost_high_myr", "stay_hours", "budget_status", "estimated"].some(k => r[k] !== before.get(r.id)[k])));
  if (!lost.length && !added.length && !changed.length) continue;
  differences += lost.length + added.length + changed.length;
  console.log(`\n${group}:`);
  for (const r of lost) console.log(`  - only saved     ${describe(r)}`);
  for (const r of added) console.log(`  + only replayed  ${describe(r)}`);
  for (const r of changed) console.log(`  ~ changed        ${describe(before.get(r.id))}\n                   ${describe(r)}`);
}
console.log(differences ? `\n${differences} option differences.` : "\nThe replay matches the saved options.");
process.exit(differences ? 1 : 0);
