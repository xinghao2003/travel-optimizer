export type TripCity = {
  code: string;
  flight_code: string;
  name: string;
  label?: string;
  country_code: string;
  longitude: number;
  latitude: number;
  coordinates: [number, number];
  airport_codes?: string[];
};

export type TransportSettings = {
  average_speed_kmh: number;
  fare_myr_per_km: number;
  ground_overhead_minutes: number;
  flight_airport_buffer_minutes: number;
};

export type Preference = "cheapest" | "shortest" | "balanced";

export type TripLeg = {
  from_city: TripCity;
  to_city: TripCity;
  departure_date: string;
  mode: "flight" | "ground";
  cost_myr: number;
  duration_minutes: number;
  distance_km: number;
  distance_source: "flight" | "osrm_road" | "assumed_connection";
  airlines: string[];
  segment_count: number;
  search_url: string | null;
};

export type TripRoute = {
  id: string;
  rank: number;
  stops: TripCity[];
  legs: TripLeg[];
  flight_cost_myr: number;
  ground_cost_myr: number;
  ground_distance_km: number;
  total_cost_myr: number;
  total_time_hours: number;
  balanced_score: number | null;
};

export type TripPlanResponse = {
  routes: TripRoute[];
  preference: Preference;
  candidate_count: number;
  searches_attempted: number;
  searches_with_priced_results: number;
  searches_without_results: number;
  searches_failed: number;
  unpriced_rows_skipped: number;
  maximum_searches: number;
  date_schedule: string[];
  limitations: string[];
  origin: TripCity;
  routing_status: "ready" | "partial" | "assumed";
  routing_message: string | null;
  search_message: string | null;
  flight_search: { available: boolean; version: string | null };
};

export type AppConfig = {
  defaults: TransportSettings;
  flight_source: string;
  max_destinations: number;
  currency: string;
  passengers: number;
};
