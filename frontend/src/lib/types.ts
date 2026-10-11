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
  flight_airport_buffer_minutes: number;
};

export type Preference = "cheapest" | "shortest" | "balanced";

export type TripLeg = {
  from_city: TripCity;
  to_city: TripCity;
  departure_date: string;
  mode: "flight" | "rail" | "ground";
  cost_myr: number | null;
  duration_minutes: number;
  distance_km: number;
  distance_source: "flight" | "transitous_rail" | "osrm_road" | "assumed_connection";
  airlines: string[];
  segment_count: number;
  search_url: string | null;
  departure_time?: string | null;
  arrival_time?: string | null;
  departure_timezone?: string | null;
  arrival_timezone?: string | null;
  from_stop?: string | null;
  to_stop?: string | null;
  service_names?: string[];
  operators?: string[];
};

export type TripRoute = {
  id: string;
  variant: "preferred" | "rail";
  rank: number;
  stops: TripCity[];
  legs: TripLeg[];
  flight_cost_myr: number;
  rail_cost_myr: number | null;
  ground_distance_km: number;
  total_cost_myr: number | null;
  total_time_hours: number;
  balanced_score: number | null;
};

export type TripPlanResponse = {
  routes: TripRoute[];
  preference: Preference;
  candidate_count: number;
  searches_attempted: number;
  searches_with_priced_results: number;
  rail_searches_attempted: number;
  rail_searches_with_results: number;
  rail_searches_without_results: number;
  rail_searches_failed: number;
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
  transit_api_requests: number;
  transit_cache_hits: number;
  transit_api_failures: number;
  transit_location_failures: number;
  transit_stop_resolutions: { city_code: string; city_name: string; stop_name: string }[];
  transit_unresolved_stops: string[];
  preferred_departure_start: string;
  preferred_departure_end: string;
  min_city_stay_nights: number;
  flight_search: { available: boolean; version: string | null };
};

export type AppConfig = {
  defaults: TransportSettings;
  flight_source: string;
  rail_source: string;
  transit_routing_configured: boolean;
  max_destinations: number;
  currency: string;
  passengers: number;
};
