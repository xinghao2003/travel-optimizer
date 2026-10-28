import { expandSharedResult } from "./sharedResults";

export type Mode = "flight" | "rail" | "bus" | "coach" | "subway" | "tram" | "car" | "taxi" | "ferry";
export type AirportTransferMode = Exclude<Mode, "flight">;
export type AirportConnection = { from_airport: string; to_airport: string; mode: AirportTransferMode; duration_minutes: number; fare_amount: number | null; currency: string };
export type AirportConnectionRequirement = { from_airport: string; to_airport: string; from_name: string; to_name: string; journey_count: number; unresolved_journey_count: number };
export const modes: Mode[] = ["flight", "rail", "bus", "coach", "subway", "tram", "car", "taxi", "ferry"];

export type TransportOption = {
  positioning_direction?: "outbound" | "return" | null;
  id: string; from_id: string; to_id: string; mode: Mode; adults: number;
  availability: "available" | "unavailable" | "unknown";
  duration_minutes: number | null; before_minutes: number; after_minutes: number;
  departure: string | null; low: number | null; high: number | null; fare_kind: "fixed" | "range"; currency: string;
  unit: "party" | "person" | "vehicle"; capacity: number; label: string;
};
export type TransportConnectionRow = {
  from_id: string; to_id: string; label: string; kind: "airport-city" | "airport-airport" | "city-city" | "saved";
  from_timezone: string; to_timezone: string; journey_count: number;
  suggested_minutes: number | null; timing_source: string | null;
};
export type Place = { id: string; name: string; latitude: number; longitude: number; timezone: string; country_code: string; airport_codes: string[]; flight_code: string | null };
export type Visit = { place: Place; min_stay_hours: number };
export type PositioningPolicy = { direction: "outbound" | "return"; gateway_id: string; mode: Mode; search_more: boolean; available: boolean };
export type PositioningService = { id: string; direction: "outbound" | "return"; gateway_id: string; mode: Mode; departure: string; arrival: string; fare_amount: number | null; currency: string; label: string };
export type TripSpec = {
  name: string; home: Place; departures: Place[]; arrivals: Place[]; visits: Visit[];
  start_date: string; end_date: string; date_mode: "fixed" | "flexible";
  adults: number; budget_myr: number | null; modes: Mode[]; max_transfers: number | null; allow_overnight: boolean;
  departure_start: string; departure_end: string;
  exclude_unpriced_flights?: boolean;
  rail_fallback?: { enabled: boolean; reference_date: string | null; max_shift_days: number; station_radius_km: number };
  home_departure_earliest?: string | null; home_arrival_latest?: string | null;
  positioning_policies?: PositioningPolicy[]; positioning_services?: PositioningService[];
  commitments: { place_id: string; start: string; end: string }[];
  timing: { connection_minutes: number; flight_before_minutes: number; flight_after_minutes: number; transit_before_minutes: number; transit_after_minutes: number; airport_transfer_fallback_minutes: number | null };
  cars: { own_enabled: boolean; own_capacity: number; own_cost_per_km: number; rental_enabled: boolean; rental_capacity: number; rental_pickups: string[]; rental_dropoffs: string[]; rental_daily_myr: number | null; rental_pickup_myr: number; rental_one_way_myr: number | null; rental_cost_per_km: number | null; taxi_capacity: number };
  exchange_rates: Record<string, number>;
};
export type TripDraft = Omit<TripSpec, "home"> & { home: Place | null };
export type Segment = { from_timezone?: string | null; to_timezone?: string | null; mode: string; from_name: string; to_name: string; departure: string | null; arrival: string | null; operator: string | null; service: string | null; source: string | null; duration_minutes: number | null; assumed: boolean };
export type Charge = { id: string; kind: string; mode: string; distance_km: number | null; low: number | null; high: number | null; currency: string; source: string };
export type Movement = { schedule_estimated?: boolean; schedule_reference_date?: string | null; id: string; from_id: string; to_id: string; mode: Mode; departure: string | null; arrival: string | null; duration_minutes: number; distance_km: number | null; transfers: number; vehicle_kind: "own" | "rental" | null; segments: Segment[]; charges: Charge[]; source: string; search_url: string | null; assumptions: string[] };
export type Offer = { id: string; movement_ids: string[]; kind: "one-way" | "round-trip" | "multi-city" | "charge"; low: number | null; high: number | null; currency: string; source: "provider" | "user" | "rule" | "unknown"; estimated: boolean; label: string; search_url?: string | null; validated: boolean };
export type PricingRule = { id: string; name: string; mode: string; from_id: string | null; to_id: string | null; service: string | null; country_code: string | null; kind: "fixed" | "per-km"; low: number; high: number | null; unit: "party" | "person" | "vehicle"; capacity: number; currency: string; priority: number };
export type Route = { id: string; departure_gateway: string; arrival_gateway: string; movements: Movement[]; stays: { place_id: string; arrival: string; departure: string; hours: number }[]; stay_hours: number; travel_hours: number; total_cost_myr: number | null; cost_low_myr: number; cost_high_myr: number | null; estimated: boolean; purchases: Offer[]; extra_charges: Charge[]; budget_status: string; provisional: boolean; cost_per_stay_hour_myr: number | null };
export type Coverage = { unresolved_movements?: { id: string; from_id: string; to_id: string; assumptions: string[] }[]; airport_connections_required?: AirportConnectionRequirement[]; source_gaps?: string[]; processed?: number; pending?: number; requests?: number; cache_hits?: number; outcomes?: Record<string, number>; discovery_complete?: boolean; messages?: string[]; bundle_links?: { kind: string; status: string; url: string; legs: { from_id: string; to_id: string; date: string }[] }[] };
export type Result = { routes: Route[]; dominated_routes?: Route[]; refinement_routes?: Route[]; missing_fares: { component_id: string; movement_id: string; label: string; from_id: string; to_id: string; affected_itineraries: number; break_even_myr: number | null; reason: string; currency: string }[]; expanded_labels: number; pruned_labels: number; feasible_count: number; optimization_complete: boolean; snapshot_revision: number; trip_revision: number; coverage: Coverage; discovery_required: boolean; optimality_scope: string };
export type SavedTrip = { transport_options?: TransportOption[]; transport_connection_rows?: TransportConnectionRow[]; assumed_connections?: Movement[]; city_connection_gaps?: { from_id: string; to_id: string }[]; airport_transfer_estimates?: AirportTransferEstimate[]; airport_transfer_rows?: AirportTransferRow[]; fare_component_ids?: string[]; id: string; revision: number; spec: TripSpec; offers: Offer[]; airport_connections?: AirportConnection[]; airport_connections_required?: AirportConnectionRequirement[]; latest_job_id: string | null; result?: Result; snapshot: { revision: number; movements: Movement[]; offers: Offer[]; coverage: Coverage } | null };
export type Job = { id: string; trip_id: string; status: "queued" | "running" | "paused" | "cancelled" | "complete" | "interrupted" | "failed" | "superseded"; processed: number; pending: number; requests: number; cache_hits: number; manual_quote_queries?: number; failed_queries: number; messages: string[]; bundle_links: Coverage["bundle_links"] };
export type SavedSummary = { id: string; name: string; revision: number; start_date: string; end_date: string };

export async function api<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  if (method === "GET" && /^\/trips\/[^/?]+$/.test(path)) path += "?compact=true";
  if (method === "POST" && /^\/trips\/[^/?]+\/optimize$/.test(path)) body = { ...(body as Record<string, unknown> | undefined), compact: true };
  const response = await fetch(`/api/v2${path}`, { method, headers: body === undefined ? undefined : { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const payload = await response.json();
  if (!response.ok) {
    const detail = Array.isArray(payload.detail) ? payload.detail.map((d: { msg: string }) => d.msg).join(" · ") : payload.detail;
    throw new Error(detail || `Request failed (${response.status})`);
  }
  if (payload.result?._shared_route_data) payload.result = expandSharedResult(payload.result);
  return (payload._shared_route_data ? expandSharedResult(payload) : payload) as T;
}
export function money(value: number | null, currency = "MYR") {
  return value === null ? "Unknown" : new Intl.NumberFormat("en-MY", { style: "currency", currency, maximumFractionDigits: 2 }).format(value);
}
export function routeCost(route: Route) {
  return route.total_cost_myr !== null ? money(route.total_cost_myr) : route.cost_high_myr === null ? `${money(route.cost_low_myr)} + unknown` : `${money(route.cost_low_myr)} – ${money(route.cost_high_myr)}`;
}
export function cityHourCost(route: Route) {
  if (route.stay_hours <= 0) return "Cost/city h unavailable";
  if (route.cost_per_stay_hour_myr !== null) return `${money(route.cost_per_stay_hour_myr)}/city h`;
  if (route.cost_high_myr !== null) return `${money(route.cost_low_myr/route.stay_hours)}–${money(route.cost_high_myr/route.stay_hours)}/city h`;
  return "Cost/city h unknown";
}
export function localTime(value: string | null, zone: string) {
  return value ? new Intl.DateTimeFormat("en-MY", { dateStyle: "medium", timeStyle: "short", timeZone: zone }).format(new Date(value)) : "Flexible departure";
}
export function localInputToISO(value: string, zone: string) {
  const desired = new Date(`${value}:00Z`).getTime();
  let instant = desired;
  const formatter = new Intl.DateTimeFormat("sv-SE", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  for (let i = 0; i < 4; i++) {
    const shown = formatter.format(new Date(instant)).replace(" ", "T");
    const delta = desired - new Date(`${shown}:00Z`).getTime();
    if (delta === 0) return new Date(instant).toISOString();
    instant += delta;
  }
  throw new Error("This local time does not exist because of a timezone clock change.");
}
export function blankTrip(): TripDraft {
  const day = (offset: number) => { const d = new Date(); d.setDate(d.getDate() + offset); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };
  return { name: "My trip", home: null, departures: [], arrivals: [], visits: [], start_date: day(30), end_date: day(38), date_mode: "fixed", adults: 1, budget_myr: null, modes: ["flight", "rail", "bus", "coach"], max_transfers: null, allow_overnight: true, departure_start: "09:00", departure_end: "17:00", commitments: [], timing: { connection_minutes: 30, flight_before_minutes: 90, flight_after_minutes: 30, transit_before_minutes: 15, transit_after_minutes: 10, airport_transfer_fallback_minutes: 45 }, cars: { own_enabled: false, own_capacity: 4, own_cost_per_km: .27, rental_enabled: false, rental_capacity: 4, rental_pickups: [], rental_dropoffs: [], rental_daily_myr: null, rental_pickup_myr: 0, rental_one_way_myr: null, rental_cost_per_km: null, taxi_capacity: 4 }, exchange_rates: { MYR: 1 } };
}

export type AirportTransferEstimate = { mode: AirportTransferMode; duration_minutes: number | null; from_id: string; to_id: string; adults: number; low: number | null; high: number | null; currency: string };
export type AirportTransferRow = { from_id: string; to_id: string; label: string };
