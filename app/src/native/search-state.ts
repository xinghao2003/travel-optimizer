/** Persistent discovery state and deterministic queue transitions. */
import type { Coverage, Job, TripSpec } from "../lib/planner";
import type { FlightLeg, MetroAirports } from "./discovery";
import { makeLeg, placesOf } from "./discovery";
import type { ProviderOutcome, ProviderTask } from "./ingestion";
import { ingest } from "./ingestion";
import { fallbackTask, searchModes } from "./rail";
import type { RailTask } from "./rail";
import type { Snapshot } from "./preparation";
import { at, localDate, maxInstant, micros, stableId } from "./time";

export type BundleCandidate = { from_id: string; to_id: string; segments: { mode: string; departure: string }[] }[];
export type BundleLink = NonNullable<Coverage["bundle_links"]>[number] & { manual_only?: boolean };
export type SearchRecord = Omit<Job, "processed" | "pending" | "failed_queries" | "graph_revision" | "bundle_links"> & {
  discovery_key: string; queue: ProviderTask[]; cursor: number; snapshot: Snapshot; bundle_links: BundleLink[];
  batch_budget: number; batch_requests: number; outcomes: Record<string, number>; manual_quote_queries: number;
  transit_configured: boolean; created: number; round_started_at: number;
};
export const TRANSIT_DISABLED = "Transit search is turned off in this build. No transit requests were sent.";
export const TRANSIT_MODES: Record<string, string> = { rail: "HIGHSPEED_RAIL,LONG_DISTANCE,NIGHT_RAIL,REGIONAL_RAIL,SUBURBAN", bus: "BUS", coach: "COACH", subway: "SUBWAY", tram: "TRAM" };

function varint(number: number): number[] {
  const bytes = []; do { const byte = number % 128; number = Math.floor(number / 128); bytes.push(byte | (number ? 128 : 0)); } while (number);
  return bytes;
}
const bytesField = (field: number, value: number[]) => [...varint(field * 8 + 2), ...varint(value.length), ...value];
const stringField = (field: number, value: string) => bytesField(field, [...new TextEncoder().encode(value)]);
const integerField = (field: number, value: number) => [...varint(field * 8), ...varint(value)];
/** The pinned fast-flights query fields used by flight_query in api/_flight_provider.py. */
export function flightSearchUrl(legs: FlightLeg[], spec: TripSpec, kind: "one-way" | "round-trip" | "multi-city"): string {
  const data = legs.flatMap(leg => bytesField(3, [...stringField(2, leg.date), ...integerField(8, Number(spec.departure_start.slice(0, 2))),
    ...integerField(9, Number(spec.departure_end.slice(0, 2))), ...bytesField(13, stringField(2, leg.from_code!)), ...bytesField(14, stringField(2, leg.to_code!))]));
  data.push(...bytesField(8, Array(spec.adults).fill(1)), ...integerField(9, 1), ...integerField(19, { "round-trip": 1, "one-way": 2, "multi-city": 3 }[kind]));
  return "https://www.google.com/travel/flights/search?tfs=" + btoa(String.fromCharCode(...data)) + "&hl=en-US&curr=MYR";
}
export function registerManualQuote(job: SearchRecord, legs: FlightLeg[], spec: TripSpec): boolean {
  const key = stableId("multi-city", legs);
  if (job.bundle_links.some(link => link.kind === "multi-city" && stableId("multi-city", link.legs) === key)) return false;
  job.bundle_links.push({ kind: "multi-city", status: "requires_manual_quote", url: flightSearchUrl(legs, spec, "multi-city"), legs, manual_only: true });
  job.manual_quote_queries = job.bundle_links.filter(link => link.kind === "multi-city").length;
  return true;
}
export function separateManualQuotes(job: SearchRecord, spec: TripSpec) {
  const future = [];
  for (const task of job.queue.slice(job.cursor)) {
    if (task.ticket_kind === "multi-city") registerManualQuote(job, task.legs!, spec); else future.push(task);
  }
  job.queue = [...job.queue.slice(0, job.cursor), ...future];
  job.manual_quote_queries = job.bundle_links.filter(link => link.kind === "multi-city").length;
}
export function publicSearch(job: SearchRecord, deadline?: number, now = performance.now()): Job & { cursor: number } {
  const { queue, snapshot, cursor, ...result } = structuredClone(job), latest = new Map(queue.slice(0, cursor).map(t => [t.key, t]));
  return { ...result, cursor, processed: cursor, pending: queue.length - cursor, failed_queries: [...latest.values()].filter(t => t.outcome === "failed").length,
    graph_revision: snapshot.revision, ...(deadline === undefined ? {} : { round_elapsed_seconds: Math.max(0, (job.time_budget_seconds ?? 0) + (now - deadline) / 1000) }) };
}
export function updateCoverage(job: SearchRecord, spec: TripSpec, transitConfigured: boolean) {
  const source_gaps = spec.modes.some(m => m in TRANSIT_MODES) && !transitConfigured ? ["Transitous disabled"] : [];
  const latest = new Map(job.queue.slice(0, job.cursor).map(t => [t.key, t.outcome]));
  job.snapshot.coverage = { processed: job.cursor, pending: job.queue.length - job.cursor, requests: job.requests, cache_hits: job.cache_hits, outcomes: job.outcomes,
    discovery_complete: !source_gaps.length && job.cursor === job.queue.length && ![...latest.values()].some(s => ["failed", "unsupported", "requires_manual_quote"].includes(String(s)))
      && !job.bundle_links.some(l => l.status === "requires_manual_quote"), messages: job.messages.slice(-12), bundle_links: job.bundle_links,
    manual_quote_queries: job.manual_quote_queries, source_gaps, unresolved_movements: job.snapshot.movements.filter(m => m.usable === false).map(m => ({ id: m.id, from_id: m.from_id, to_id: m.to_id, assumptions: m.assumptions })) };
}
export function recordOutcome(job: SearchRecord, task: ProviderTask, outcome: ProviderOutcome, usedRequest: boolean, spec: TripSpec, metros: MetroAirports, now = Date.now() * 1000) {
  job.cursor++; job.batch_requests += Number(usedRequest); job.requests += Number(usedRequest);
  const skipped = !!outcome.automatic_query_skipped;
  job.manual_quote_queries += Number(skipped); job.cache_hits += Number(!usedRequest && !skipped && outcome.status !== "unsupported");
  task.outcome = outcome.status; job.outcomes[outcome.status] = (job.outcomes[outcome.status] ?? 0) + 1;
  if (outcome.message) { const message = `${task.kind}: ${outcome.message}`; if (!job.messages.includes(message)) job.messages.push(message); }
  if (task.kind === "bundle" && outcome.search_url) {
    const link: BundleLink = { kind: task.ticket_kind!, status: outcome.status, url: outcome.search_url, legs: task.legs! };
    if (!job.bundle_links.some(existing => JSON.stringify(existing) === JSON.stringify(link))) job.bundle_links.push(link);
  }
  const collected = ingest(task, outcome, spec, job.snapshot, metros, now);
  if (collected.length) job.optimization_pending = true;
  const known = new Set(job.queue.map(t => t.key)), places = placesOf(spec);
  if (task.kind === "bundle" && task.ticket_kind === "round-trip" && outcome.flight_choices) {
    const root = task.round_trip_root ?? task.key, children: ProviderTask[] = [];
    for (const selection of outcome.flight_choices) {
      const key = stableId("round-trip-return-v1", root, selection);
      if (known.has(key)) continue;
      known.add(key);
      const child: ProviderTask = { ...task, key, round_trip_root: root, round_trip_selection: selection }; delete child.outcome;
      children.push(child);
    }
    job.queue.splice(job.cursor, 0, ...children);
  }
  if (task.kind === "transit" && ["empty", "success"].includes(outcome.status) && !collected.length) {
    const probe = fallbackTask(task as RailTask, spec, localDate(now, places.get(task.from_id!)!.timezone));
    if (probe && !known.has(probe.key!)) {
      job.queue.splice(job.cursor, 0, probe as ProviderTask); known.add(probe.key!);
      const message = "Opt-in rail fallback searches nearby stations and samples matching weekdays when no usable actual-date journey was collected. An empty response does not establish timetable coverage; copied services are estimates with unverified holidays, fares and availability.";
      if (!job.messages.includes(message)) job.messages.push(message);
    }
  }
  if (task.kind === "transit") {
    const payload = (outcome.payload ?? {}) as { nextPageCursor?: string; itineraries?: { startTime?: string }[] }, origin = places.get(task.from_id!);
    const times = (payload.itineraries ?? []).filter(i => i.startTime).map(i => micros(i.startTime!)), latest = times.length ? maxInstant(...times) : null;
    const limit = origin ? at(task.rail_reference_date ?? task.date!, spec.departure_end, origin.timezone) : null;
    if (payload.nextPageCursor && latest && limit && latest <= limit) {
      const more = { ...task, cursor: payload.nextPageCursor, key: stableId(task.from_id, task.to_id, task.date, task.rail_reference_date ?? null, task.rail_radius ?? null, payload.nextPageCursor) };
      if (!known.has(more.key)) job.queue.splice(job.cursor, 0, more);
    }
  }
}
export function enqueueTickets(job: SearchRecord, candidates: BundleCandidate[], spec: TripSpec, metros: MetroAirports) {
  const known = new Set([...job.queue.map(t => t.key), ...job.bundle_links.map(l => stableId(l.kind, l.legs))]), seen = new Set<string>(), places = placesOf(spec);
  for (const flights of candidates) {
    const tickets: ["multi-city" | "round-trip", BundleCandidate][] = [["multi-city", flights]];
    for (const [i, first] of flights.entries()) for (const last of flights.slice(i + 1)) if (first.from_id === last.to_id && first.to_id === last.from_id) tickets.push(["round-trip", [first, last]]);
    for (const [kind, selected] of tickets) {
      if (selected.some(m => !searchModes(spec, m.from_id, m.to_id).includes("flight"))) continue;
      const signature = selected.map(m => [m.from_id, m.to_id, localDate(micros(m.segments.find(s => s.mode === "flight")!.departure), places.get(m.from_id)!.timezone)]);
      const ticket = JSON.stringify([kind, signature]); if (seen.has(ticket)) continue; seen.add(ticket);
      const legs = signature.map(([a, b, day]) => makeLeg(places.get(a)!, places.get(b)!, day, metros)), key = stableId(kind, legs);
      if (known.has(key)) continue; known.add(key);
      if (kind === "multi-city") registerManualQuote(job, legs, spec);
      else job.queue.splice(job.cursor, 0, { kind: "bundle", ticket_kind: kind, key, legs });
    }
  }
  job.snapshot.coverage.pending = job.queue.length - job.cursor;
  job.snapshot.coverage.manual_quote_queries = job.manual_quote_queries;
  job.snapshot.coverage.discovery_complete &&= job.cursor === job.queue.length && !job.bundle_links.some(l => l.status === "requires_manual_quote");
}
