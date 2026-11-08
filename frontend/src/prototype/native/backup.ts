import { expandSharedResult } from "../../lib/sharedResults";
import type { Result, Route } from "../../lib/planner";
import { parseConnection, parseInteger, parseMovement, parseOffer, parseRule, parseSpec, parseTransfer } from "./contracts";
import type { PlannerTrip, Snapshot } from "./preparation";
import type { Collection, StoredRecord } from "./repository";

export type PlannerBackup = { format: "wayfinder-browser-backup"; schema_version: 1; exported_at: string; records: StoredRecord[] };
type Value = Record<string, unknown>;
function record(raw: unknown): Value {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("A backup record must be an object.");
  return raw as Value;
}
function list(raw: unknown): unknown[] { if (!Array.isArray(raw)) throw new Error("A backup field must be a list."); return raw; }
function id(raw: unknown): string { if (typeof raw !== "string" || !raw.length) throw new Error("A backup record needs an ID."); return raw; }
export function parseSnapshot(raw: unknown): Snapshot {
  const value = record(raw);
  const revision = parseInteger(value.revision ?? 0);
  if (revision < 0) throw new Error("Snapshot revisions cannot be negative.");
  return { ...value, revision, movements: list(value.movements).map(parseMovement), offers: list(value.offers ?? []).map(parseOffer), coverage: record(value.coverage ?? {}) } as Snapshot;
}
function parseResult(raw: unknown): Result {
  const original = record(raw);
  const value = Object.hasOwn(original, "_shared_route_data") ? expandSharedResult(original as unknown as Parameters<typeof expandSharedResult>[0]) as unknown as Value : original;
  const result = { ...value };
  for (const group of ["routes", "dominated_routes", "refinement_routes"]) if (Object.hasOwn(result, group)) result[group] = list(result[group]).map(raw => {
    const route = record(raw);
    return { ...route, movements: list(route.movements).map(parseMovement), purchases: list(route.purchases).map(parseOffer), extra_charges: list(route.extra_charges ?? []) } as unknown as Route;
  });
  if (!Array.isArray(result.routes)) throw new Error("Saved results need a route list.");
  return result as unknown as Result;
}
export function parseSavedTrip(raw: unknown): PlannerTrip {
  const value = record(raw), revision = parseInteger(value.revision ?? 1);
  if (revision < 0) throw new Error("Trip revisions cannot be negative.");
  const trip = { ...value, id: id(value.id), revision, spec: parseSpec(value.spec), snapshot: value.snapshot == null ? null : parseSnapshot(value.snapshot),
    offers: list(value.offers ?? []).map(parseOffer), airport_connections: list(value.airport_connections ?? []).map(parseConnection), latest_job_id: value.latest_job_id ?? null } as PlannerTrip;
  if (value.airport_transfer_estimates !== undefined) trip.airport_transfer_estimates = list(value.airport_transfer_estimates).map(parseTransfer);
  if (value.journey_pricing_rules !== undefined) trip.journey_pricing_rules = list(value.journey_pricing_rules).map(parseRule);
  if (value.result != null) trip.result = parseResult(value.result);
  return trip;
}
const collections = new Set<Collection>(["trips", "rules", "graphs", "jobs", "optimizations", "meta"]);
export function parseBackup(raw: unknown): PlannerBackup {
  const value = record(raw);
  if (value.format !== "wayfinder-browser-backup" || value.schema_version !== 1) throw new Error("Unsupported planner backup format or version.");
  const seen = new Set<string>();
  const records = list(value.records).map(raw => {
    const entry = record(raw), collection = entry.collection as Collection, key = JSON.stringify([collection, entry.id]);
    if (entry.schema_version !== 1 || !collections.has(collection) || seen.has(key)) throw new Error("Unsupported or duplicate backup record.");
    seen.add(key);
    if (typeof entry.id !== "string") throw new Error("A backup record key must be a string.");
    const identifier = entry.id;
    let payload: unknown = entry.payload;
    if (collection === "trips") { payload = parseSavedTrip(payload); if ((payload as PlannerTrip).id !== identifier) throw new Error("A trip record's ID must match its key."); }
    else if (collection === "rules") payload = { ...parseRule(payload), id: identifier };
    else if (collection === "graphs") payload = parseSnapshot(payload);
    else if (collection === "jobs" || collection === "optimizations") {
      const job = { ...record(payload) };
      if (job.id !== identifier || typeof job.trip_id !== "string") throw new Error("A search/calculation record needs matching IDs.");
      if (["queued", "running", "stopping"].includes(String(job.status))) job.status = "interrupted";
      if (job.snapshot != null) job.snapshot = parseSnapshot(job.snapshot);
      payload = job;
    }
    const updated = typeof entry.updated === "number" && Number.isFinite(entry.updated) ? entry.updated : Date.now();
    return { schema_version: 1 as const, collection, id: identifier, updated, payload };
  });
  return { format: "wayfinder-browser-backup", schema_version: 1, exported_at: typeof value.exported_at === "string" ? value.exported_at : new Date().toISOString(), records };
}
