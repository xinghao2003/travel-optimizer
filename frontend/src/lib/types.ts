export type FlightListing = {
  direction: "outbound" | "return";
  price_myr: number | null;
  booking_url: string;
  snapshot_date: string | null;
  skyscanner_origin_code: string;
  skyscanner_destination_code: string;
  direct: boolean | null;
};

export type FlightOrigin = {
  code: string;
  name: string;
  longitude: number;
  latitude: number;
  country_code: string | null;
};

export type City = {
  code: string;
  name: string;
  longitude: number;
  latitude: number;
  coordinates: [number, number];
  country_code: string | null;
  geoname_id: number | null;
  coordinate_source: string;
  outbound: FlightListing | null;
  return_flight: FlightListing | null;
};

export type ImportedFlight = {
  source_file: string;
  origin_code: string;
  destination_code: string;
  origin_name: string;
  destination_name: string;
  departure_date: string;
  return_date: string | null;
  journey_type: "one_way" | "round_trip";
  price_myr: number | null;
  booking_url: string;
  direct: boolean | null;
  stop_count: number | null;
  stops_label: string | null;
};

export type InputFileStatus = {
  source_file: string;
  status: "loaded" | "skipped" | "failed";
  parsed_count: number;
  reason: string | null;
};

export type PlannerData = {
  origin: FlightOrigin | null;
  origins: FlightOrigin[];
  cities: City[];
  snapshot_dates: { outbound: string | null; return: string | null };
  imported_flights: ImportedFlight[];
  input_files: InputFileStatus[];
  summary: {
    city_count: number;
    outbound_listings: number;
    return_listings: number;
    priced_outbound_listings: number;
    priced_return_listings: number;
    input_file_count: number;
    imported_flight_count: number;
    skipped_input_count: number;
    resolved_coordinate_count: number;
    unresolved_coordinate_count: number;
  };
  coordinate_resolution: {
    dataset: string;
    dataset_available: boolean;
    unresolved_cities: { code: string; name: string }[];
  };
  defaults: TransportSettings;
};

export type TransportSettings = {
  average_speed_kmh: number;
  distance_factor: number;
  fare_myr_per_km: number;
  connection_overhead_minutes: number;
};

export type RouteFilters = {
  max_transport_hours: number | null;
  max_budget_myr: number | null;
  arrival_cities: string[];
  departure_cities: string[];
};

export type RouteResult = {
  id: string;
  rank: number;
  arrival_city: { code: string; name: string };
  departure_city: { code: string; name: string };
  outbound_flight_myr: number;
  outbound_booking_url: string;
  return_flight_myr: number;
  return_booking_url: string;
  flight_cost_myr: number;
  base_distance_km: number;
  distance_source: "same_city" | "osrm_road" | "assumed_connection";
  estimated_transport_distance_km: number;
  estimated_transport_time_hours: number;
  estimated_transport_cost_myr: number;
  total_cost_myr: number;
  same_city_baseline_myr: number | null;
  savings_myr: number | null;
  is_same_city: boolean;
  balanced_score: number | null;
};

export type RoutesResponse = {
  routes: RouteResult[];
  preference: "cheapest" | "shortest" | "balanced";
  candidate_count: number;
  unavailable_pair_count: number;
  routing_status: "ready" | "partial" | "assumed" | "unavailable" | "not_needed";
  routing_message: string | null;
};
