/** Provider-only HTTP and expiring response cache; no planner server calls. */
import type { TripSpec } from "../../lib/planner";
import { makeLeg, placesOf } from "./discovery";
import { airportPlaces } from "./preparation";
import type { AirportCatalog, Snapshot } from "./preparation";
import type { ProviderOutcome, ProviderTask } from "./ingestion";
import { searchModes } from "./rail";
import { PlannerRepository } from "./repository";
import { flightSearchUrl, TRANSIT_DISABLED, TRANSIT_MODES } from "./search-state";
import { at, fingerprint, pythonFloat } from "./time";

export type ProviderSettings = { schema_version: 1; flights_url: string; osrm_base_url: string; transit_url: string; transit_enabled: boolean };
export type Retrieved = { outcome: ProviderOutcome; usedRequest: boolean };
export type SearchProvider = { settings(): Promise<ProviderSettings>; fetch(task: ProviderTask, spec: TripSpec, snapshot: Snapshot): Promise<Retrieved> };
export type ProviderPlan = { key: string; url: string; init?: RequestInit; ttl: number; nodes?: string[] };
let config: Promise<ProviderSettings> | undefined;
export function loadProviderSettings(): Promise<ProviderSettings> {
  return config ??= fetch("/browser-data/config.json").then(async response => {
    if (!response.ok) throw new Error("Provider configuration is missing. Run tools/prepare_static_planner.py.");
    const value = await response.json();
    if (value.schema_version !== 1 || ["flights_url", "osrm_base_url", "transit_url"].some(k => typeof value[k] !== "string") || typeof value.transit_enabled !== "boolean") throw new Error("Invalid browser provider configuration.");
    return value as ProviderSettings;
  });
}
export function providerPlan(task: ProviderTask, spec: TripSpec, catalog: AirportCatalog, settings: ProviderSettings): ProviderPlan {
  const places = placesOf(spec), cacheTask = Object.fromEntries(Object.entries(task).filter(([k]) => !["key", "outcome", "rail_reference_dates", "rail_sample_index", "rail_reference_date"].includes(k)));
  if (task.rail_reference_date) cacheTask.date = task.rail_reference_date;
  // Provider cache is origin-local and excluded from backups. Use its own
  // versioned key; persisted Python discovery/task identifiers stay unchanged.
  const key = "native-provider-v1:" + fingerprint([cacheTask, spec.adults, spec.departure_start, spec.departure_end,
    [...places.values()].map(p => [p.id, p.latitude, p.longitude, p.flight_code, p.airport_codes]), [...spec.modes].sort(),
    task.kind === "transit" ? spec.timing.connection_minutes : null, searchModes(spec, task.from_id!, task.to_id!),
    task.rail_radius ? spec.rail_fallback!.station_radius_km : null, settings]);
  if (task.kind === "road") {
    const nodes = new Map([...places, ...airportPlaces(spec, catalog)]), ordered = [...nodes.keys()].sort();
    const coordinates = ordered.map(id => `${pythonFloat(nodes.get(id)!.longitude)},${pythonFloat(nodes.get(id)!.latitude)}`).join(";");
    return { key: "native-road-v1:" + fingerprint([settings.osrm_base_url, coordinates]), url: `${settings.osrm_base_url.replace(/\/$/, "")}/table/v1/driving/${coordinates}?annotations=distance,duration`, ttl: 7 * 86400, nodes: ordered };
  }
  if (task.kind === "flight" || task.kind === "bundle") {
    const legs = task.kind === "bundle" ? task.legs! : [makeLeg(places.get(task.from_id!)!, places.get(task.to_id!)!, task.date!, catalog.metros)];
    return { key, url: settings.flights_url, init: { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ legs, adults: spec.adults, kind: task.ticket_kind ?? "one-way", departure_start: spec.departure_start, departure_end: spec.departure_end,
        ...(task.round_trip_selection ? { operation: "return", selection: task.round_trip_selection } : {}) }) }, ttl: 900 };
  }
  const origin = places.get(task.from_id!)!, dest = places.get(task.to_id!)!, day = task.rail_reference_date ?? task.date!;
  const start = at(day, spec.departure_start, origin.timezone);
  // Wall-time subtraction matches Python datetime.combine without DST elapsed-time adjustment.
  const seconds = (time: string) => { const [h, m, s] = time.split(":").map(Number); return h * 3600 + m * 60 + (s || 0); };
  const offset = Math.round((at(day, spec.departure_start, "UTC") - start) / 1_000_000), abs = Math.abs(offset);
  const local = day + "T" + spec.departure_start.slice(0, 8).padEnd(8, ":00") + (offset < 0 ? "-" : "+")
    + String(Math.floor(abs / 3600)).padStart(2, "0") + ":" + String(Math.floor(abs / 60) % 60).padStart(2, "0")
    + (abs % 60 ? ":" + String(abs % 60).padStart(2, "0") : "");
  const params = new URLSearchParams({ fromPlace: `${pythonFloat(origin.latitude)},${pythonFloat(origin.longitude)}`, toPlace: `${pythonFloat(dest.latitude)},${pythonFloat(dest.longitude)}`,
    time: local, arriveBy: "false", transitModes: searchModes(spec, origin.id, dest.id).filter(m => m in TRANSIT_MODES).map(m => TRANSIT_MODES[m]).join(","),
    searchWindow: String(Math.trunc(seconds(spec.departure_end) - seconds(spec.departure_start))), timetableView: "true", numItineraries: "10", joinInterlinedLegs: "false", minTransferTime: String(spec.timing.connection_minutes) });
  if (task.rail_radius) { params.set("transitModes", TRANSIT_MODES.rail); params.set("radius", pythonFloat(spec.rail_fallback!.station_radius_km * 1000)); params.set("directModes", ""); }
  if (task.cursor) params.set("pageCursor", String(task.cursor));
  return { key, url: settings.transit_url + (settings.transit_url.includes("?") ? "&" : "?") + params, ttl: 21600 };
}
export class BrowserProviders implements SearchProvider {
  private pending = new Map<string, Promise<Retrieved>>();
  constructor(readonly repository: PlannerRepository, readonly airports: () => Promise<AirportCatalog>, readonly settings = loadProviderSettings) {}
  async fetch(task: ProviderTask, spec: TripSpec, _snapshot: Snapshot): Promise<Retrieved> {
    const settings = await this.settings(), catalog = await this.airports();
    if (task.kind === "bundle" && task.ticket_kind === "multi-city") return { usedRequest: false, outcome: { status: "requires_manual_quote", automatic_query_skipped: true,
      search_url: flightSearchUrl(task.legs!, spec, "multi-city"), options: [], kind: "multi-city",
      diagnostics: { returned_rows: 0, requested_journeys: task.legs!.length, complete_options: 0 },
      message: "Automatic multi-city search skipped: fast-flights does not support reliable multi-city retrieval. This does not establish that no combined ticket exists. Open the search link and enter a whole-ticket quote manually." } };
    if (task.kind === "transit" && !settings.transit_enabled) return { usedRequest: false, outcome: { status: "unsupported", message: TRANSIT_DISABLED.replace(" No transit requests were sent.", "") } };
    const plan = providerPlan(task, spec, catalog, settings), prior = this.pending.get(plan.key);
    if (prior) { await prior; return this.fetch(task, spec, _snapshot); }
    const promise = this.cachedOrRetrieve(task, plan).finally(() => { if (this.pending.get(plan.key) === promise) this.pending.delete(plan.key); });
    this.pending.set(plan.key, promise); return promise;
  }
  private async cachedOrRetrieve(task: ProviderTask, plan: ProviderPlan): Promise<Retrieved> {
    const cached = await this.repository.getCache<ProviderOutcome>(plan.key);
    return cached ? { outcome: cached, usedRequest: false } : this.retrieve(task, plan);
  }
  private async retrieve(task: ProviderTask, plan: ProviderPlan): Promise<Retrieved> {
    const response = await fetch(plan.url, { ...plan.init, signal: AbortSignal.timeout(task.kind === "road" ? 30000 : 45000) });
    if (!response.ok) {
      const payload = await response.json().catch(() => undefined), detail = payload?.detail;
      throw new Error(typeof detail === "string" ? `${task.kind}: ${detail}` : `${task.kind} returned HTTP ${response.status}.`);
    }
    const payload = await response.json();
    let outcome: ProviderOutcome;
    if (task.kind === "road") {
      if (payload.code !== "Ok" || !Array.isArray(payload.distances) || !Array.isArray(payload.durations)) throw new Error("OSRM did not return a road matrix.");
      const roads: NonNullable<ProviderOutcome["roads"]> = {};
      for (const [i, a] of plan.nodes!.entries()) for (const [j, b] of plan.nodes!.entries()) {
        const distance = payload.distances[i]?.[j], duration = payload.durations[i]?.[j];
        if (a !== b && distance != null && duration != null) roads[a + "->" + b] = { distance_km: distance / 1000, duration_minutes: duration / 60 };
      }
      outcome = { status: "success", roads };
    } else if (task.kind === "transit") outcome = { status: payload.itineraries?.length ? "success" : "empty", payload };
    else {
      if (typeof payload.status !== "string" || !Array.isArray(payload.options)) throw new Error("Invalid flight-function response.");
      if (payload.flight_choices !== undefined && (payload.protocol_version !== 2 || task.ticket_kind !== "round-trip" || !Array.isArray(payload.flight_choices)
        || payload.flight_choices.some((choice: unknown) => !Array.isArray(choice) || !choice.length || choice.length > 64 || choice.some(segment => !Array.isArray(segment) || segment.length !== 5 || segment.some(value => typeof value !== "string" || !value.length || value.length > 120))))) throw new Error("Invalid round-trip return choices.");
      outcome = payload;
    }
    if (outcome.status !== "failed") {
      outcome.retrieved_at = new Date().toISOString();
      await this.repository.putCache(plan.key, outcome, task.kind === "transit" && outcome.status === "empty" ? 900 : plan.ttl);
    }
    return { outcome, usedRequest: true };
  }
}
