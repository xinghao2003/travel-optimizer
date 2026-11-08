/** JSON contracts and model validators ported from planner_models.py.
 * This boundary applies defaults before provider planning or worker execution.
 */
import { Temporal } from "@js-temporal/polyfill";
import type { AirportConnection, AirportTransferEstimate, Charge, JourneyPriceScope, Movement, Offer, Place, PricingRule, Segment, TripSpec } from "../../lib/planner";
import { modes } from "../../lib/planner";
import type { SolverInput } from "./types";
import { daysBetween, elapsed, iso, micros, MINUTE, modelTimestamp, timeKey } from "./time";

type Parser<T = unknown> = (value: unknown) => T;
type Value = Record<string, unknown>;
const fail = (message: string): never => { throw new Error(message); };
function record(value: unknown): Value {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Value : fail("Expected an object.");
}
function model<T>(value: unknown, fields: Record<string, Parser>): T {
  const input = record(value), result: Value = {};
  for (const key of Object.keys(input)) if (!Object.hasOwn(fields, key)) fail(`Unexpected field: ${key}.`);
  for (const [key, parse] of Object.entries(fields)) {
    try { result[key] = parse(input[key]); }
    catch (error) { fail(`${key}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  return result as T;
}
const defaults = <T>(parse: Parser<T>, value: T): Parser<T> => input => input === undefined ? structuredClone(value) : parse(input);
const nullable = <T>(parse: Parser<T>): Parser<T | null> => value => value === null ? null : parse(value);
const text = (min = 0, max = Infinity): Parser<string> => value => typeof value === "string" && [...value].length >= min && [...value].length <= max ? value : fail("Enter valid text.");
const number = (min = -Infinity, max = Infinity, integer = false): Parser<number> => value => {
  const numeric = integer ? /^[+-]?\d(?:_?\d)*(?:\.0+)?$/ : /^[+-]?(?:\d(?:_?\d)*(?:\.(?:\d(?:_?\d)*)?)?|\.\d(?:_?\d)*)(?:[eE][+-]?\d(?:_?\d)*)?$/;
  const n = typeof value === "number" || typeof value === "boolean" ? Number(value) : typeof value === "string" && numeric.test(value.trim()) ? Number(value.replaceAll("_", "")) : NaN;
  return Number.isFinite(n) && n >= min && n <= max && (!integer || Number.isInteger(n)) ? n : fail("Enter a number within the allowed range.");
};
export const parseFiniteNumber: Parser<number> = number();
export const parseInteger: Parser<number> = number(-Infinity, Infinity, true);
const bool: Parser<boolean> = value => {
  if (value === true || value === 1 || typeof value === "string" && ["1", "true", "on", "yes", "y", "t"].includes(value.toLowerCase())) return true;
  if (value === false || value === 0 || typeof value === "string" && ["0", "false", "off", "no", "n", "f"].includes(value.toLowerCase())) return false;
  return fail("Enter true or false.");
};
const enumeration = <T extends string>(values: readonly T[]): Parser<T> => value => typeof value === "string" && values.includes(value as T) ? value as T : fail("Choose a supported value.");
const array = <T>(parse: Parser<T>, min = 0, max = Infinity): Parser<T[]> => value => Array.isArray(value) && value.length >= min && value.length <= max ? value.map(parse) : fail("Enter a list within the allowed size.");
const date: Parser<string> = value => {
  let input = value;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const parsed = datetime(value);
    if (!/T00:00:00(?:\.0+)?(?:Z|[+-]\d\d:\d\d)?$/.test(parsed)) fail("Dates must have zero time.");
    input = parsed.slice(0, 10);
  }
  const result = Temporal.PlainDate.from(text()(input)).toString();
  return /^\d{4}-\d{2}-\d{2}$/.test(result) && !result.startsWith("0000") ? result : fail("Enter a valid date.");
};
const time: Parser<string> = value => timeKey(text()(value)).replace(/\.000000$/, "");
function numericTimestamp(value: number): bigint {
  // Match the pinned Pydantic-core 2.50.1 / Speedate 0.17.0 conversion,
  // including its absolute fractional part for negative values. Its integer
  // inference and fraction inference use floor(value) and value respectively.
  const whole = Math.floor(value), scale = Math.abs(whole) > 20_000_000_000 ? 1000n : 1_000_000n;
  const fraction = Math.abs(value % 1) * (Math.abs(value) > 20_000_000_000 ? 1000 : 1_000_000);
  return BigInt(whole) * scale + BigInt(Math.round(fraction));
}
const datetime: Parser<string> = value => {
  // Pydantic accepts Unix seconds, or milliseconds beyond its 2e10 cutoff.
  const numeric = typeof value === "number" || typeof value === "string" && /^[+-]?\d+(?:\.\d+)?$/.test(value);
  const raw = numeric ? Number(value) : null;
  const result = raw !== null ? iso(numericTimestamp(raw), true)
    : modelTimestamp(/^\d{4}-\d{2}-\d{2}$/.test(text()(value)) ? `${value}T00:00:00` : value as string);
  return /^\d{4}-/.test(result) && !result.startsWith("0000") ? result : fail("Enter a datetime between years 1 and 9999.");
};
const currency: Parser<string> = value => /^[A-Za-z]{3}$/.test(text()(value)) ? (value as string).toUpperCase() : fail("Use a three-letter currency code.");
const mode = enumeration(modes), transferMode = enumeration(modes.filter(m => m !== "flight"));
const nonnegative = number(0), positive: Parser<number> = value => { const n = nonnegative(value); return n > 0 ? n : fail("Enter a positive value."); };
const money = defaults(nullable(nonnegative), null), optionalText = defaults(nullable(text()), null);
const strings = defaults(array(text()), []), capacity = defaults(number(1, 9, true), 4);
const unique = (values: unknown[], message: string) => { if (new Set(values).size !== values.length) fail(message); };
function interval(low: number | null, high: number | null, maximumNeedsMinimum = true) {
  if (high !== null && (maximumNeedsMinimum && low === null || low !== null && high < low)) fail("A maximum needs a minimum and cannot be below it.");
}
function awareInterval(start: string, end: string, message: string) {
  if (micros(end) <= micros(start)) fail(message);
}

export const parsePlace: Parser<Place> = value => {
  const place = model<Place>(value, { id: text(1, 160), name: text(1, 160), latitude: number(-90, 90), longitude: number(-180, 180),
    timezone: text(), country_code: defaults(text(), ""), airport_codes: strings, flight_code: optionalText });
  try { new Intl.DateTimeFormat("en", { timeZone: place.timezone }); } catch { fail("Use a valid IANA timezone for this place."); }
  return place;
};

export const parseSpec: Parser<TripSpec> = value => {
  const cars = (input: unknown) => model<TripSpec["cars"]>(input, {
    own_enabled: defaults(bool, false), own_capacity: capacity, own_cost_per_km: defaults(nonnegative, .27),
    rental_enabled: defaults(bool, false), rental_capacity: capacity, rental_pickups: strings, rental_dropoffs: strings,
    rental_daily_myr: money, rental_pickup_myr: defaults(nonnegative, 0), rental_one_way_myr: money, rental_cost_per_km: money, taxi_capacity: capacity,
  });
  const timing = (input: unknown) => model<TripSpec["timing"]>(input, {
    connection_minutes: defaults(number(0, 360, true), 30), flight_before_minutes: defaults(number(0, 360, true), 90), flight_after_minutes: defaults(number(0, 360, true), 30),
    transit_before_minutes: defaults(number(0, 120, true), 15), transit_after_minutes: defaults(number(0, 120, true), 10), airport_transfer_fallback_minutes: defaults(nullable(number(0, 600, true)), 45),
  });
  const positioningPolicy: Parser = input => model(input, { direction: enumeration(["outbound", "return"]), gateway_id: text(), mode, search_more: defaults(bool, true), available: defaults(bool, true) });
  const positioningService: Parser = input => {
    const service = model<NonNullable<TripSpec["positioning_services"]>[number]>(input, {
      id: text(1, 160), direction: enumeration(["outbound", "return"]), gateway_id: text(), mode, departure: datetime, arrival: datetime,
      fare_amount: money, currency: defaults(currency, "MYR"), label: defaults(text(0, 160), "Supplied positioning service"),
    });
    awareInterval(service.departure, service.arrival, "Positioning services need increasing timezone-aware departure and arrival times.");
    return service;
  };
  const commitment: Parser = input => {
    const item = model<TripSpec["commitments"][number]>(input, { place_id: text(), start: datetime, end: datetime });
    awareInterval(item.start, item.end, "Commitments need timezone-aware start/end times in increasing order.");
    return item;
  };
  const fallback = (input: unknown) => model(input, { enabled: defaults(bool, false), reference_date: defaults(nullable(date), null), max_shift_days: defaults(number(7, 365, true), 180), station_radius_km: defaults(number(1, 50), 25) });
  const rates: Parser = input => Object.fromEntries(Object.entries(record(input)).map(([key, rate]) => [key, number()(rate)]));
  const spec = model<TripSpec>(value, {
    name: defaults(text(1, 120), "My trip"), home: parsePlace, departures: defaults(array(parsePlace, 0, 3), []), arrivals: defaults(array(parsePlace, 0, 3), []),
    visits: array(input => model(input, { place: parsePlace, min_stay_hours: defaults(number(0, 8760), 0) }), 1, 4),
    ordered_visits: defaults(bool, false), start_date: date, end_date: date, date_mode: defaults(enumeration(["fixed", "flexible"]), "fixed"),
    adults: defaults(number(1, 9, true), 1), budget_myr: money, modes: defaults(array(mode), ["flight", "rail", "bus", "coach"]),
    max_transfers: defaults(nullable(number(0, 10, true)), null), allow_overnight: defaults(bool, true), exclude_unpriced_flights: defaults(bool, false),
    rail_fallback: defaults(fallback, fallback({})), home_departure_earliest: defaults(nullable(time), null), home_arrival_latest: defaults(nullable(time), null),
    positioning_policies: defaults(array(positioningPolicy, 0, 48), []), positioning_services: defaults(array(positioningService, 0, 120), []),
    departure_start: defaults(time, "09:00:00"), departure_end: defaults(time, "17:00:00"), commitments: defaults(array(commitment), []),
    timing: defaults(timing, timing({})), cars: defaults(cars, cars({})), exchange_rates: defaults(rates, { MYR: 1 }),
  });
  if (daysBetween(spec.start_date, spec.end_date) < 0 || daysBetween(spec.start_date, spec.end_date) > 365) fail("Choose an increasing date range of at most 365 days.");
  if (timeKey(spec.departure_end) <= timeKey(spec.departure_start)) fail("The local departure window must end after it starts.");
  if (!spec.modes.length) fail("Select at least one transport mode.");
  const ids = spec.visits.map(v => v.place.id);
  unique(ids, "Required destinations must be unique and different from home.");
  if (ids.includes(spec.home.id)) fail("Required destinations must be unique and different from home.");
  if (!spec.departures.length) spec.departures = [spec.home];
  if (!spec.arrivals.length) spec.arrivals = [spec.home];
  for (const group of [spec.departures, spec.arrivals]) unique(group.map(p => p.id), "Candidate endpoints must be unique.");
  for (const [code, rate] of Object.entries(spec.exchange_rates)) if ([...code].length !== 3 || !/^\p{L}+$/u.test(code) || rate <= 0) fail("Exchange rates must be positive MYR per unit of currency.");
  spec.exchange_rates.MYR = 1;
  if (spec.commitments.some(c => !ids.includes(c.place_id))) fail("Fixed commitments must belong to required destinations.");
  if (spec.start_date === spec.end_date && spec.home_departure_earliest && spec.home_arrival_latest && spec.home_departure_earliest >= spec.home_arrival_latest) fail("Latest home arrival must follow earliest home departure.");
  unique((spec.positioning_policies ?? []).map(p => JSON.stringify([p.direction, p.gateway_id, p.mode])), "Positioning policies must be unique per direction, gateway, and mode.");
  unique((spec.positioning_services ?? []).map(s => s.id), "Positioning service IDs must be unique.");
  for (const item of [...(spec.positioning_policies ?? []), ...(spec.positioning_services ?? [])]) {
    const gateways = item.direction === "outbound" ? spec.departures : spec.arrivals;
    if (item.gateway_id === spec.home.id || !gateways.some(p => p.id === item.gateway_id)) fail("Positioning must reference a non-home gateway in the selected direction.");
  }
  return spec;
};

export const parseSegment: Parser<Segment> = value => model<Segment>(value, {
  mode: text(), from_name: text(), to_name: text(), departure: defaults(nullable(datetime), null), arrival: defaults(nullable(datetime), null),
  from_id: optionalText, to_id: optionalText, from_timezone: optionalText, to_timezone: optionalText, operator: optionalText, service: optionalText,
  source: optionalText, duration_minutes: defaults(nullable(number()), null), assumed: defaults(bool, false), interline_with_previous: defaults(bool, false),
});
export const parseCharge: Parser<Charge> = value => model<Charge>(value, {
  id: text(), kind: text(), mode: defaults(text(), "taxi"), distance_km: money, low: money, high: money,
  currency: defaults(text(), "MYR"), source: defaults(text(), "unknown"), from_id: optionalText, to_id: optionalText, country_code: optionalText,
});
export const parseMovement: Parser<Movement> = value => {
  const movement = model<Movement>(value, {
    schedule_estimated: defaults(bool, false), schedule_reference_date: defaults(nullable(date), null), id: text(), template_id: optionalText, usable: defaults(bool, true),
    from_id: text(), to_id: text(), mode, departure: defaults(nullable(datetime), null), arrival: defaults(nullable(datetime), null), duration_minutes: positive,
    distance_km: money, transfers: defaults(number(0, Infinity, true), 0), vehicle_kind: defaults(nullable(enumeration(["own", "rental"])), null),
    segments: defaults(array(parseSegment), []), charges: defaults(array(parseCharge), []), source: text(), search_url: optionalText, assumptions: strings,
  });
  if ((movement.departure === null) !== (movement.arrival === null)) fail("Both schedule timestamps are required together.");
  if (movement.departure !== null) {
    awareInterval(movement.departure, movement.arrival!, "Movements need increasing timezone-aware timestamps.");
    const dep = micros(movement.departure), arr = micros(movement.arrival!);
    movement.departure = iso(dep, true); movement.arrival = iso(arr, true); movement.duration_minutes = elapsed(arr - dep, MINUTE);
  }
  return movement;
};
export const parseOffer: Parser<Offer> = value => {
  const offer = model<Offer>(value, {
    id: text(), movement_ids: array(text(), 1), kind: defaults(enumeration(["one-way", "round-trip", "multi-city", "charge"]), "one-way"),
    low: money, high: money, currency: defaults(currency, "MYR"), source: defaults(enumeration(["provider", "user", "rule", "unknown"]), "provider"),
    estimated: defaults(bool, false), label: defaults(text(), ""), search_url: optionalText, validated: defaults(bool, true), adults: defaults(nullable(number(1, 9, true)), null),
    retrieved_at: defaults(nullable(datetime), null), expires_at: defaults(nullable(datetime), null),
  });
  unique(offer.movement_ids, "Ticket coverage must not contain duplicate movements."); interval(offer.low, offer.high);
  return offer;
};
const groupFields = ["stations", "category", "connections", "service", "operator", "date", "time"] as const;
export const parseScope: Parser<JourneyPriceScope> = value => {
  const scope = model<JourneyPriceScope>(value, { from_id: text(), to_id: text(), mode, vehicle_kind: defaults(nullable(enumeration(["own", "rental"])), null),
    adults: number(1, 9, true), group_by: array(enumeration(groupFields), 0, 7), values: input => Object.fromEntries(Object.entries(record(input)).map(([key, v]) => [key, text()(v)])) });
  unique(scope.group_by, "Each grouping field must have exactly one matching value.");
  if (Object.keys(scope.values).length !== scope.group_by.length || scope.group_by.some(key => !Object.hasOwn(scope.values, key))) fail("Each grouping field must have exactly one matching value.");
  scope.group_by = groupFields.filter(key => scope.group_by.includes(key));
  return scope;
};
export const parseRule: Parser<PricingRule> = value => {
  const rule = model<PricingRule>(value, { id: defaults(text(), ""), name: text(1, 120), mode: defaults(text(), "*"), from_id: optionalText, to_id: optionalText,
    service: optionalText, country_code: optionalText, kind: defaults(enumeration(["fixed", "per-km"]), "fixed"), low: nonnegative, high: money,
    unit: defaults(enumeration(["party", "person", "vehicle"]), "person"), capacity, currency: defaults(currency, "MYR"), priority: defaults(number(-Infinity, Infinity, true), 0),
    journey_scope: defaults(nullable(parseScope), null) });
  interval(rule.low, rule.high); return rule;
};
export const parseConnection: Parser<AirportConnection> = value => {
  const connection = model<AirportConnection>(value, { from_airport: currency, to_airport: currency, mode: transferMode, duration_minutes: positive, fare_amount: money, currency: defaults(currency, "MYR") });
  if (connection.from_airport === connection.to_airport) fail("An airport connection must join two different airports.");
  return connection;
};
export const parseTransfer: Parser<AirportTransferEstimate> = value => {
  const estimate = model<AirportTransferEstimate>(value, { mode: defaults(transferMode, "taxi"), duration_minutes: defaults(nullable(positive), null), from_id: text(), to_id: text(),
    adults: number(1, 9, true), low: money, high: money, currency: defaults(currency, "MYR") });
  if (estimate.mode !== "taxi" && estimate.duration_minutes === null) fail("Enter a travel time for each alternative transfer method.");
  interval(estimate.low, estimate.high); return estimate;
};
export const SOLVER_CONTRACT_VERSION = 1;
export const parseSolverInput: Parser<SolverInput> = value => model<SolverInput>(value, {
  schema_version: defaults(input => input === SOLVER_CONTRACT_VERSION ? SOLVER_CONTRACT_VERSION : fail("Unsupported solver input version."), SOLVER_CONTRACT_VERSION),
  spec: parseSpec, movements: array(parseMovement), offers: array(parseOffer), rules: defaults(array(parseRule), []), snapshot_revision: defaults(number(0, Infinity, true), 0),
  trip_revision: defaults(number(0, Infinity, true), 0), finish_at_home: defaults(bool, true), include_dominated: defaults(bool, false),
  label_limit: defaults(nullable(number(0, Infinity, true)), null), expansion_budget: defaults(nullable(number(0, Infinity, true)), null),
});
