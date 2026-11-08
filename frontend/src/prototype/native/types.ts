import type { Charge, Movement, Offer, PricingRule, Route, TripSpec } from "../../lib/planner";
import { micros, iso } from "./time";

export type Spec = TripSpec;
export type Fare = Offer;
export type Rule = PricingRule;
export type Journey = { raw: Movement; dep: number | null; arr: number | null };
export type Missing = { component_id: string; movement_id: string; label: string; from_id: string; to_id: string; currency: string; reason: string };
export type Price = { low_cents: number; high_cents: number; total_cost_myr: number | null; cost_low_myr: number; cost_high_myr: number | null; estimated: boolean; purchases: Fare[]; missing: Missing[]; uncertainty_key: string[] };
export type Stay = { place_id: string; arrival: number; departure: number; hours: number };
export type Label = {
  city: string; phase: number; mask: number; arrival: number; path: Journey[]; stays: Stay[];
  reward: boolean; own_location: string; own_used: boolean; rental_pickup: string | null; rental_start: number | null;
  charges: Charge[]; departure_gateway: string; arrival_gateway: string; price: Price | null;
  return_mask: number; revisiting: boolean; history: unknown[]; stay_hours: number;
};
export type Frontier = { buckets: Map<string, Label[]>[]; turns: string[][]; active: { priority: number; key: string } | null; remaining: number; slot: number; size: number };
export type SearchState = { signature: string; queue: Frontier; labels: Map<string, Label[]>; completed: Label[]; expanded: number; pruned: number };
export type SolverInput = { spec: Spec; movements: Movement[]; offers: Offer[]; rules: Rule[]; snapshot_revision?: number; trip_revision?: number; finish_at_home?: boolean; include_dominated?: boolean; label_limit?: number | null; expansion_budget?: number | null };
export type SolverResult = { routes: Route[]; refinement_routes: Route[]; dominated_routes?: Route[]; missing_fares: (Missing & { affected_itineraries: number; break_even_myr: number | null })[]; bundle_candidates: unknown[]; expanded_labels: number; pruned_labels: number; feasible_count: number; hidden_unpriced_flight_count: number; excluded_unpriced_flight_count: number; safety_limit_reached?: boolean; optimization_complete: boolean; remaining_labels: number; label_limit: number | null; snapshot_revision: number; trip_revision: number; optimality_scope: string };

export function normalizeFare(offer: Partial<Fare>): Fare {
  return { id: "", movement_ids: [], kind: "one-way", low: null, high: null, currency: "MYR", source: "provider", estimated: false, label: "", search_url: null, validated: true, adults: null, retrieved_at: null, expires_at: null, ...offer };
}
export function normalizeCharge(charge: Charge): Charge {
  return Object.assign({ mode: "taxi", distance_km: null, low: null, high: null, currency: "MYR", source: "unknown", from_id: null, to_id: null, country_code: null }, charge);
}
export function normalizeJourney(movement: Movement): Journey {
  const dep = movement.departure === null ? null : micros(movement.departure);
  const arr = movement.arrival === null ? null : micros(movement.arrival);
  const raw = Object.assign({ schedule_estimated: false, schedule_reference_date: null, template_id: null, usable: true, distance_km: null, transfers: 0, vehicle_kind: null,
    segments: [], charges: [], search_url: null, assumptions: [] }, movement, {
    departure: dep === null ? null : iso(dep, true), arrival: arr === null ? null : iso(arr, true),
    duration_minutes: dep !== null && arr !== null ? (arr - dep) / 60_000_000 : movement.duration_minutes }) as Movement;
  raw.charges = raw.charges.map(normalizeCharge);
  raw.segments = raw.segments.map(segment => Object.assign({ departure: null, arrival: null, from_id: null, to_id: null,
    from_timezone: null, to_timezone: null, operator: null, service: null, source: null, duration_minutes: null,
    assumed: false, interline_with_previous: false }, segment));
  return { raw, dep, arr };
}
