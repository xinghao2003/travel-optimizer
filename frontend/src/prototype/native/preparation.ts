/** Prepare the full saved graph for optimization, matching recalculate(). */
import type { AirportConnection, AirportConnectionRequirement, AirportTransferEstimate, AirportTransferRow, Coverage, Movement, Offer, Place, PricingRule, Result, SavedTrip, TripSpec } from "../../lib/planner";
import { parseConnection, parseMovement, parseOffer, parsePlace, parseRule, parseSpec, parseTransfer } from "./contracts";
import { placesOf } from "./discovery";
import type { MetroAirports } from "./discovery";
import { discoveryKey } from "./discovery-key";
import { flightMovement, pairKey } from "./journeys";
import type { Roads } from "./journeys";
import { RAIL_FALLBACK_SOURCE } from "./rail";
import { iso, MINUTE, micros, pythonJson, stableId, stableModelId } from "./time";
import type { SolverInput, SolverResult } from "./types";

export type Snapshot = { revision: number; movements: Movement[]; offers: Offer[]; coverage: Coverage; roads?: Roads; label_limit?: number | null; discovery_key?: string };
export type PlannerTrip = Omit<SavedTrip, "snapshot"> & { snapshot: Snapshot | null };
export type AirportCatalog = { metros: MetroAirports; airports: Record<string, { name: string; lat: number; lon: number; tz: string }> };
export type PreparationOptions = { snapshot?: Snapshot; expand?: boolean; include_dominated?: boolean; unlimited?: boolean; now?: number; label_batch?: number; expansion_budget?: number | null };

export function airportPlaces(spec: TripSpec, catalog: AirportCatalog): Map<string, Place> {
  const result = new Map<string, Place>();
  for (const city of placesOf(spec).values()) for (const code of new Set([...city.airport_codes, ...(catalog.metros[city.flight_code ?? ""] ?? [])])) {
    const airport = catalog.airports[code];
    if (airport) result.set("airport:" + code, parsePlace({ id: "airport:" + code, name: airport.name, latitude: airport.lat, longitude: airport.lon, timezone: airport.tz }));
  }
  return result;
}

export function airportTransferRows(spec: TripSpec, movements: Movement[], catalog: AirportCatalog): AirportTransferRow[] {
  const rows = new Map<string, AirportTransferRow>(), places = placesOf(spec);
  for (const city of places.values()) {
    const codes = new Set([...city.airport_codes, ...(catalog.metros[city.flight_code ?? ""] ?? [])]);
    if (city.flight_code && Object.hasOwn(catalog.airports, city.flight_code)) codes.add(city.flight_code);
    for (const code of [...codes].sort()) for (const [a, b] of [[city.id, "airport:" + code], ["airport:" + code, city.id]]) {
      rows.set(pairKey(a, b), { from_id: a, to_id: b, label: a === city.id ? `${city.name} → ${code} airport` : `${code} airport → ${city.name}` });
    }
  }
  for (const m of movements) for (const c of m.charges ?? []) {
    if (!["Airport access", "Airport egress"].includes(c.kind) || !c.from_id || !c.to_id) continue;
    const city = c.from_id.startsWith("airport:") ? c.to_id : c.from_id, airport = c.from_id.startsWith("airport:") ? c.from_id : c.to_id;
    if (!places.has(city) || !airport.startsWith("airport:")) continue;
    const name = places.get(city)!.name, code = airport.slice(8);
    rows.set(pairKey(c.from_id, c.to_id), { from_id: c.from_id, to_id: c.to_id, label: c.from_id === airport ? `${code} airport → ${name}` : `${name} → ${code} airport` });
  }
  return [...rows.values()].sort((a, b) => a.label < b.label ? -1 : a.label > b.label ? 1 : 0);
}

export function airportTransferRules(estimates: AirportTransferEstimate[], spec: TripSpec): PricingRule[] {
  return estimates.filter(item => item.adults === spec.adults && item.low !== null).map(item => parseRule({
    id: "airport-transfer:" + stableId(item.from_id, item.to_id, spec.adults, item.mode), name: "Trip airport transfer estimate", from_id: item.from_id, to_id: item.to_id,
    mode: item.mode, service: item.from_id.startsWith("airport:") ? "Airport egress" : "Airport access", low: item.low, high: item.high, currency: item.currency,
    unit: "party", priority: 1000000,
  }));
}

export function airportTransferVariants(movements: Movement[], estimates: AirportTransferEstimate[], spec: TripSpec, roads: Roads, connections: Map<string, AirportConnection>): Movement[] {
  const choices = new Map<string, AirportTransferEstimate[]>(), places = placesOf(spec), result: Movement[] = [];
  for (const item of estimates) if (item.adults === spec.adults) {
    const key = pairKey(item.from_id, item.to_id), options = choices.get(key) ?? [];
    options.push(item); choices.set(key, options);
  }
  for (const raw of movements) {
    const m = parseMovement(raw), flights = m.segments.filter(s => s.mode === "flight");
    if (m.source !== "Google Flights / fast-flights" || !flights.length || !places.has(m.from_id) || !places.has(m.to_id)) { result.push(m); continue; }
    const access: [string, string] = [m.from_id, "airport:" + flights[0].from_id], egress: [string, string] = ["airport:" + flights[flights.length - 1].to_id, m.to_id];
    const left: (AirportTransferEstimate | null)[] = choices.get(pairKey(...access)) ?? [null];
    const right: (AirportTransferEstimate | null)[] = choices.get(pairKey(...egress)) ?? [null];
    for (const a of left) for (const b of right) {
      const selected = [a, b];
      if (!a && !b) { result.push(m); continue; }
      const localRoads = { ...roads };
      for (const [i, pair] of [access, egress].entries()) if (selected[i]?.duration_minutes != null) localRoads[pair[0] + "->" + pair[1]] = { duration_minutes: selected[i]!.duration_minutes!, distance_km: null };
      const variant = flightMovement(places.get(m.from_id)!, places.get(m.to_id)!, flights, spec, localRoads, connections, true);
      variant.id = m.id + ":transfer:" + stableModelId(["low", "high", "duration_minutes"], selected);
      variant.template_id = m.id; variant.search_url = m.search_url;
      for (const [i, kind] of ["access", "egress"].entries()) {
        const entry = selected[i], mode = entry?.mode ?? "taxi", charge = variant.charges.find(c => c.kind === "Airport " + kind);
        if (charge) { charge.id = m.id + ":" + kind + (mode !== "taxi" ? ":" + mode : ""); charge.mode = mode; }
        const segment = variant.segments.find(s => s.source === "Airport " + kind);
        if (entry && segment) { segment.mode = mode; segment.source = "User-estimated airport " + kind; segment.assumed = true; }
      }
      result.push(variant);
    }
  }
  return result;
}

export function requiredAirportConnections(movements: Movement[], connections: Map<string, AirportConnection>): AirportConnectionRequirement[] {
  const pairs = new Map<string, AirportConnectionRequirement>();
  for (const m of movements) if (m.source === "Google Flights / fast-flights") {
    const flights = m.segments.filter(s => s.mode === "flight");
    for (let i = 1; i < flights.length; i++) {
      const a = flights[i - 1], b = flights[i];
      if (!a.to_id || !b.from_id || a.to_id === b.from_id) continue;
      const key = pairKey(a.to_id, b.from_id), connection = connections.get(key);
      const pair = pairs.get(key) ?? { from_airport: a.to_id, to_airport: b.from_id, from_name: a.to_name, to_name: b.from_name, journey_count: 0, unresolved_journey_count: 0 };
      pair.journey_count++;
      if (!connection || connection.duration_minutes > (micros(b.departure!) - micros(a.arrival!)) / MINUTE) pair.unresolved_journey_count++;
      pairs.set(key, pair);
    }
  }
  return [...pairs.values()].sort((a, b) => a.from_airport < b.from_airport ? -1 : a.from_airport > b.from_airport ? 1 : a.to_airport < b.to_airport ? -1 : a.to_airport > b.to_airport ? 1 : 0);
}

export function roadMovements(spec: TripSpec, roads: Roads): Movement[] {
  const result: Movement[] = [];
  for (const a of placesOf(spec).keys()) for (const b of placesOf(spec).keys()) {
    const road = roads[a + "->" + b];
    if (a === b || !road || road.duration_minutes <= 0) continue;
    const variants: ["taxi" | "car", "own" | "rental" | null][] = [];
    if (spec.modes.includes("taxi")) variants.push(["taxi", null]);
    if (spec.modes.includes("car")) variants.push(["car", "own"], ["car", "rental"]);
    for (const [mode, vehicle] of variants) result.push(parseMovement({ id: "road:" + stableId(a, b, mode, vehicle), from_id: a, to_id: b, mode, vehicle_kind: vehicle,
      duration_minutes: road.duration_minutes, distance_km: road.distance_km, source: "OSRM", assumptions: ["Driving time estimate; traffic and rental availability are not live inventory."] }));
  }
  return result;
}

export function prepareSolverInput(trip: PlannerTrip, globalRules: PricingRule[], options: PreparationOptions = {}): { input: SolverInput; snapshot: Snapshot } {
  const spec = parseSpec(trip.spec), places = placesOf(spec);
  const snapshot = structuredClone(options.snapshot ?? trip.snapshot ?? { revision: 0, movements: [], offers: [], coverage: {} });
  const connections = new Map((trip.airport_connections ?? []).map(parseConnection).map(c => [pairKey(c.from_airport, c.to_airport), c]));
  const normalized: Movement[] = [];
  for (const raw of snapshot.movements) {
    let m = parseMovement(raw);
    if (m.source === RAIL_FALLBACK_SOURCE && !spec.rail_fallback?.enabled) continue;
    if (!places.has(m.from_id) || !places.has(m.to_id)) { normalized.push(raw); continue; }
    if (m.source === "Google Flights / fast-flights") {
      const updated = flightMovement(places.get(m.from_id)!, places.get(m.to_id)!, m.segments.filter(s => s.mode === "flight"), spec, snapshot.roads ?? {}, connections, true);
      updated.id = m.id; updated.search_url = m.search_url;
      for (const c of updated.charges) if (c.kind === "Airport access" || c.kind === "Airport egress") c.id = m.id + (c.kind === "Airport access" ? ":access" : ":egress");
      m = updated;
    } else if (["Transitous / MOTIS", RAIL_FALLBACK_SOURCE].includes(m.source) && m.segments.length) {
      const dep = micros(m.segments[0].departure!) - spec.timing.transit_before_minutes * MINUTE;
      const arr = micros(m.segments[m.segments.length - 1].arrival!) + spec.timing.transit_after_minutes * MINUTE;
      m = { ...m, departure: iso(dep, true), arrival: iso(arr, true), duration_minutes: (arr - dep) / MINUTE };
    }
    normalized.push(m);
  }
  if (pythonJson(normalized) !== pythonJson(snapshot.movements)) { snapshot.movements = normalized; snapshot.revision++; }
  if (snapshot.roads && Object.keys(snapshot.roads).length) {
    const movements = new Map(snapshot.movements.map(m => [m.id, m])), oldIds = new Set(movements.keys());
    for (const m of roadMovements(spec, snapshot.roads)) movements.set(m.id, m);
    snapshot.movements = [...movements.values()];
    snapshot.offers = [...new Map(snapshot.offers.map(o => [o.id, o])).values()];
    if (movements.size !== oldIds.size) snapshot.revision++;
  }
  const base = Math.max(1000, Math.trunc(options.label_batch ?? 25000));
  snapshot.label_limit = Math.max(snapshot.label_limit || base, options.expand ? trip.result?.expanded_labels ?? 0 : 0) + (options.expand ? base : 0);
  const now = options.now ?? Date.now() * 1000;
  const offers = [...new Map([...snapshot.offers, ...trip.offers].map(parseOffer).map(o => [o.id, o])).values()].map(o =>
    o.source === "provider" && o.expires_at && micros(o.expires_at) < now ? { ...o, estimated: true, label: "Stale quote: " + o.label } : o);
  const estimates = (trip.airport_transfer_estimates ?? []).map(parseTransfer);
  const input: SolverInput = { schema_version: 1, spec, movements: airportTransferVariants(snapshot.movements, estimates, spec, snapshot.roads ?? {}, connections), offers,
    rules: [...globalRules.map(parseRule), ...airportTransferRules(estimates, spec), ...(trip.journey_pricing_rules ?? []).map(parseRule)],
    snapshot_revision: snapshot.revision, trip_revision: trip.revision, finish_at_home: true, include_dominated: options.include_dominated ?? false,
    label_limit: options.unlimited ? null : snapshot.label_limit, expansion_budget: options.expansion_budget === undefined ? 100000 : options.expansion_budget };
  return { input, snapshot };
}

export function completeResult(result: SolverResult, snapshot: Snapshot, trip: PlannerTrip): Result {
  const connections = new Map((trip.airport_connections ?? []).map(parseConnection).map(c => [pairKey(c.from_airport, c.to_airport), c]));
  const coverage = { ...snapshot.coverage, unresolved_movements: snapshot.movements.filter(m => m.usable === false).map(m => ({ id: m.id, from_id: m.from_id, to_id: m.to_id, assumptions: m.assumptions })),
    airport_connections_required: requiredAirportConnections(snapshot.movements, connections) };
  snapshot.coverage = coverage;
  return { ...result, coverage, discovery_required: snapshot.discovery_key !== discoveryKey(parseSpec(trip.spec)) };
}

export function refreshQuoteFreshness(result: Result, now: number): Result {
  const updated = structuredClone(result);
  for (const route of [...updated.routes, ...(updated.dominated_routes ?? []), ...(updated.refinement_routes ?? [])]) for (const offer of route.purchases) {
    if (offer.source === "provider" && offer.expires_at && micros(offer.expires_at) < now) {
      offer.estimated = true; if (!offer.label.startsWith("Stale quote: ")) offer.label = "Stale quote: " + offer.label;
      route.estimated = true;
    }
  }
  return updated;
}

export function tripMetadata(trip: PlannerTrip, catalog: AirportCatalog) {
  const movements = trip.snapshot?.movements ?? [], result = trip.result;
  const routes = [...(result?.routes ?? []), ...(result?.dominated_routes ?? []), ...(result?.refinement_routes ?? [])];
  const ids = new Set(movements.flatMap(m => [m.id, ...(m.charges ?? []).map(c => c.id)]));
  for (const route of routes) {
    for (const m of route.movements) { ids.add(m.id); for (const c of m.charges) ids.add(c.id); }
    for (const c of route.extra_charges) ids.add(c.id);
  }
  const gaps: { from_id: string; to_id: string }[] = [], pairs = new Set(movements.map(m => pairKey(m.from_id, m.to_id)));
  if (trip.snapshot) for (const [i, a] of trip.spec.visits.entries()) for (const b of trip.spec.visits.slice(i + 1)) {
    if (!pairs.has(pairKey(a.place.id, b.place.id)) && !pairs.has(pairKey(b.place.id, a.place.id))) gaps.push({ from_id: a.place.id, to_id: b.place.id });
  }
  const connections = new Map((trip.airport_connections ?? []).map(parseConnection).map(c => [pairKey(c.from_airport, c.to_airport), c]));
  return { airport_transfer_rows: airportTransferRows(parseSpec(trip.spec), movements, catalog), airport_connections_required: requiredAirportConnections(movements, connections),
    assumed_connections: movements.filter(m => m.source === "User-defined connection"), fare_component_ids: [...ids].sort(), city_connection_gaps: gaps };
}
