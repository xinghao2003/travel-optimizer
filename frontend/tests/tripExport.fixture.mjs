import { loadTs } from "./loadTs.mjs";
const { blankTrip } = await loadTs("../src/lib/planner.ts");

export function sampleTrip() {
  const place = (id, name, timezone) => ({ id, name, timezone, latitude: 0, longitude: 0, country_code: "MY", airport_codes: [], flight_code: null });
  const home = place("home", "Kuala Lumpur", "Asia/Kuala_Lumpur");
  const city = place("city", "東京 Tokyo", "Asia/Tokyo");
  const movement = (id, from_id, to_id, departure, arrival) => ({ id, from_id, to_id, departure, arrival, duration_minutes: 420, mode: "flight", distance_km: null, transfers: 0, vehicle_kind: null, source: "Google Flights / fast-flights", search_url: "https://example.com/fares?a=1&b=2", assumptions: [], charges: [], segments: [{ mode: "flight", from_name: from_id === "home" ? home.name : city.name, to_name: to_id === "home" ? home.name : city.name, from_timezone: from_id === "home" ? home.timezone : city.timezone, to_timezone: to_id === "home" ? home.timezone : city.timezone, departure, arrival, operator: "Example Air", service: "EA100", source: "Google Flights", duration_minutes: 420, assumed: false }] });
  const movements = [movement("out", "home", "city", "2026-12-04T23:00:00Z", "2026-12-05T06:00:00Z"), movement("back", "city", "home", "2026-12-08T02:00:00Z", "2026-12-08T09:00:00Z")];
  const purchases = movements.map(m => ({ id: `fare-${m.id}`, movement_ids: [m.id], kind: "one-way", low: 500, high: 500, currency: "MYR", source: "provider", estimated: false, label: "Google Flights", validated: true }));
  const route = { id: "route", departure_gateway: "home", arrival_gateway: "home", movements, purchases, stays: [{ place_id: "city", arrival: movements[0].arrival, departure: movements[1].departure, hours: 68 }], stay_hours: 68, travel_hours: 14, total_cost_myr: 1000, cost_low_myr: 1000, cost_high_myr: 1000, estimated: false, extra_charges: [], budget_status: "within", provisional: false, cost_per_stay_hour_myr: 1000 / 68 };
  return { id: "trip-1", revision: 2, spec: { ...blankTrip(), name: "Japan with friends", home, visits: [{ place: city, min_stay_hours: 48 }], adults: 3, start_date: "2026-12-05", end_date: "2026-12-08" }, offers: [], latest_job_id: null, snapshot: { revision: 4, movements, offers: purchases, coverage: {} }, result: { routes: [route], refinement_routes: [], missing_fares: [], expanded_labels: 1, pruned_labels: 0, feasible_count: 1, optimization_complete: true, snapshot_revision: 4, trip_revision: 2, coverage: {}, discovery_required: false, optimality_scope: "Best for the retrieved schedules." } };
}
