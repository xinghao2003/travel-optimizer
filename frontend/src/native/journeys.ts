/** Pure provider normalization, ported from planner_journeys.py.
 * Provider retrieval and request policies belong to the browser orchestrator.
 */
import type { AirportConnection, Charge, Movement, Offer, Place, Segment, TripSpec } from "../lib/planner";
import { normalizeCharge, normalizeFare, normalizeJourney, normalizeSegment } from "./types";
import { duration, elapsed, general, iso, localDate, localTime, MINUTE, micros, round, stableId, stableModelId, timeKey, unixMicros } from "./time";

export type Road = { duration_minutes: number; distance_km: number | null };
export type Roads = Record<string, Road>;
export type RawSegment = Pick<Segment, "mode" | "from_name" | "to_name"> & Partial<Segment>;
export const pairKey = (from: string | null | undefined, to: string | null | undefined) => JSON.stringify([from, to]);
export const timestamp = (value: string | number) => typeof value === "number" ? unixMicros(value) : micros(value);
const modelTime = (value: bigint) => iso(value, true);

export function flightMovement(origin: Place, dest: Place, segments: RawSegment[], spec: TripSpec, roads: Roads, connections: Map<string, AirportConnection> = new Map(), normalizedSegments = false): Movement {
  if (!segments.length) throw new Error("A flight journey needs at least one segment.");
  const rawDeparture = timestamp(segments[0].departure!), rawArrival = timestamp(segments[segments.length - 1].arrival!);
  const id = "flight:" + (normalizedSegments ? stableModelId(["duration_minutes"], origin.id, dest.id, segments, spec.adults) : stableId(origin.id, dest.id, segments, spec.adults));
  const assumptions: string[] = [], charges: Charge[] = [], accessMinutes: number[] = [];
  let usable = true;
  for (const [kind, city, airport, reverse] of [["access", origin, segments[0].from_id, false], ["egress", dest, segments[segments.length - 1].to_id, true]] as const) {
    const [left, right] = reverse ? ["airport:" + airport, city.id] : [city.id, "airport:" + airport];
    const road = roads[left + "->" + right];
    let minutes = road ? road.duration_minutes : spec.timing.airport_transfer_fallback_minutes;
    if (minutes === null) {
      usable = false; minutes = 0;
      assumptions.push(`${city.name}: airport access time is unresolved; this movement is not usable until routing or a transfer assumption is provided`);
    }
    const distance = road?.distance_km ?? null;
    accessMinutes.push(minutes);
    if (!road) assumptions.push(`${city.name}: ${minutes} minute airport transfer assumption; road routing unavailable`);
    if (minutes > 0 || (distance ?? 0) > 0) charges.push(normalizeCharge({ id: id + ":" + kind, kind: "Airport " + kind, distance_km: distance, from_id: left, to_id: right, country_code: city.country_code } as Charge));
  }
  const dep = rawDeparture - duration(accessMinutes[0] + spec.timing.flight_before_minutes, MINUTE);
  const arr = rawArrival + duration(accessMinutes[1] + spec.timing.flight_after_minutes, MINUTE);
  if (arr <= dep) throw new Error("Movements need increasing timezone-aware timestamps.");
  const flights = segments.map(normalizeSegment).filter(segment => segment.mode === "flight");
  if (!flights.length) throw new Error("A flight journey needs flight segments.");
  const first = flights[0], last = flights[flights.length - 1], chronology: Segment[] = [];
  const append = (value: RawSegment) => chronology.push(normalizeSegment(value));
  if (accessMinutes[0]) append({ mode: "transfer", from_name: origin.name, to_name: first.from_name, departure: modelTime(dep),
    arrival: modelTime(rawDeparture - duration(spec.timing.flight_before_minutes, MINUTE)), duration_minutes: accessMinutes[0], source: "Airport access",
    assumed: assumptions.some(a => a.includes(origin.name)), from_timezone: origin.timezone, to_timezone: first.from_timezone });
  if (spec.timing.flight_before_minutes) append({ mode: "wait", from_name: first.from_name, to_name: first.from_name,
    departure: modelTime(rawDeparture - duration(spec.timing.flight_before_minutes, MINUTE)), arrival: modelTime(rawDeparture), duration_minutes: spec.timing.flight_before_minutes,
    source: "Flight readiness buffer", assumed: true, from_timezone: first.from_timezone, to_timezone: first.from_timezone });
  for (let i = 0; i < flights.length; i++) {
    const flight = flights[i];
    if (i) {
      const previous = flights[i - 1], previousArrival = timestamp(previous.arrival!), flightDeparture = timestamp(flight.departure!);
      const gap = elapsed(flightDeparture - previousArrival, MINUTE);
      if (previous.to_id !== flight.from_id) {
        const connection = connections.get(pairKey(previous.to_id, flight.from_id));
        if (connection && connection.duration_minutes <= gap) {
          const transferArrival = previousArrival + duration(connection.duration_minutes, MINUTE);
          append({ mode: connection.mode, from_name: previous.to_name, to_name: flight.from_name, departure: previous.arrival, arrival: modelTime(transferArrival),
            duration_minutes: connection.duration_minutes, from_id: previous.to_id, to_id: flight.from_id, from_timezone: previous.to_timezone,
            to_timezone: flight.from_timezone, source: "User-verified airport transfer", assumed: true });
          if (gap - connection.duration_minutes > 0) append({ mode: "wait", from_name: flight.from_name, to_name: flight.from_name, departure: modelTime(transferArrival),
            arrival: flight.departure, duration_minutes: gap - connection.duration_minutes, from_id: flight.from_id, to_id: flight.from_id,
            from_timezone: flight.from_timezone, to_timezone: flight.from_timezone, source: "Layover after airport transfer", assumed: true });
          charges.push(normalizeCharge({ id: `${id}:airport-transfer:${i}`, kind: `Airport transfer ${previous.to_id} → ${flight.from_id}`, mode: connection.mode,
            low: connection.fare_amount, high: connection.fare_amount, currency: connection.currency, source: "user", from_id: "airport:" + previous.to_id, to_id: "airport:" + flight.from_id } as Charge));
        } else {
          if (gap > 0) append({ mode: "transfer", from_name: previous.to_name, to_name: flight.from_name, departure: previous.arrival, arrival: flight.departure,
            duration_minutes: gap, from_timezone: previous.to_timezone, to_timezone: flight.from_timezone,
            source: connection ? "Airport transfer exceeds available layover" : "Airport change needs confirmation", assumed: true });
          usable = false;
          assumptions.push(connection ? `Airport connection ${previous.to_id} → ${flight.from_id} needs ${general(connection.duration_minutes)} minutes but only ${general(Math.max(0, gap))} are available`
            : `Airport change ${previous.to_id} → ${flight.from_id}: add a verified connection before using this journey`);
        }
      } else if (gap > 0) append({ mode: "wait", from_name: previous.to_name, to_name: flight.from_name, departure: previous.arrival, arrival: flight.departure,
        duration_minutes: gap, from_timezone: previous.to_timezone, to_timezone: flight.from_timezone, source: "Scheduled connection" });
    }
    chronology.push(flight);
  }
  if (spec.timing.flight_after_minutes) append({ mode: "wait", from_name: last.to_name, to_name: last.to_name, departure: modelTime(rawArrival),
    arrival: modelTime(rawArrival + duration(spec.timing.flight_after_minutes, MINUTE)), duration_minutes: spec.timing.flight_after_minutes, source: "Arrival buffer", assumed: true,
    from_timezone: last.to_timezone, to_timezone: last.to_timezone });
  if (accessMinutes[1]) append({ mode: "transfer", from_name: last.to_name, to_name: dest.name,
    departure: modelTime(rawArrival + duration(spec.timing.flight_after_minutes, MINUTE)), arrival: modelTime(arr), duration_minutes: accessMinutes[1], source: "Airport egress",
    assumed: assumptions.some(a => a.includes(dest.name)), from_timezone: last.to_timezone, to_timezone: dest.timezone });
  return normalizeJourney({ id, from_id: origin.id, to_id: dest.id, mode: "flight", departure: modelTime(dep), arrival: modelTime(arr), usable,
    duration_minutes: elapsed(arr - dep, MINUTE), transfers: segments.length - 1, segments: chronology, charges, source: "Google Flights / fast-flights", assumptions } as Movement).raw;
}

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue => value !== null && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : {};
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const requiredTime = (value: unknown) => {
  if (typeof value !== "number" && typeof value !== "string") throw new Error("Missing provider schedule timestamp.");
  return timestamp(value);
};

/** Complete GTFS fare products only; ambiguous currencies/categories stay unknown. */
export function transitFare(itinerary: unknown, adults: number): [number, string] | null {
  const transfers = list(object(itinerary).fareTransfers);
  if (!transfers.length) return null;
  let currency: string | null = null, total = 0;
  function productValue(products: unknown): number | null {
    if (!Array.isArray(products) || !products.length) return null;
    let value = 0;
    for (const raw of products) {
      const p = object(raw), category = object(p.riderCategory);
      if (typeof p.amount !== "number" || typeof p.currency !== "string" || !p.currency) return null;
      if (p.riderCategory && Object.keys(category).length && !(category.isDefaultFareCategory || String(category.name ?? "").toLowerCase().includes("adult"))) return null;
      if (currency && currency !== p.currency) return null;
      currency = p.currency; value += p.amount;
    }
    return value;
  }
  for (const raw of transfers) {
    const transfer = object(raw), rule = transfer.rule ?? "A_AB_B", effective = transfer.effectiveFareLegProducts;
    if (!Array.isArray(effective)) return null;
    const needed = rule === "AB" ? [] : rule === "A_AB" ? effective.slice(0, 1) : effective;
    for (const alternatives of needed) {
      if (!Array.isArray(alternatives)) return null;
      const valid = alternatives.map(productValue).filter((value): value is number => value !== null);
      if (!valid.length) return null;
      total += Math.min(...valid);
    }
    if (list(transfer.transferProducts).length) {
      const value = productValue(transfer.transferProducts);
      if (value === null) return null;
      total += value;
    }
  }
  return currency === null || total < 0 ? null : [round(total * adults), currency];
}

const modeMap: Record<string, Movement["mode"]> = { BUS: "bus", COACH: "coach", SUBWAY: "subway", TRAM: "tram" };
const railModes = new Set(["RAIL", "HIGHSPEED_RAIL", "LONG_DISTANCE", "NIGHT_RAIL", "REGIONAL_FAST_RAIL", "REGIONAL_RAIL", "SUBURBAN"]);
export function transitMovements(payload: unknown, origin: Place, dest: Place, spec: TripSpec, day: string): { movements: Movement[]; offers: Offer[] } {
  const movements: Movement[] = [], offers: Offer[] = [];
  for (const raw of list(object(payload).itineraries)) {
    try {
      const itinerary = object(raw), legs = list(itinerary.legs).map(object);
      const riding = legs.filter(leg => !["WALK", "FOOT", "WAIT", "TRANSFER"].includes(String(leg.mode)));
      if (!riding.length || riding.some(leg => !(String(leg.mode) in modeMap) && !railModes.has(String(leg.mode)))) continue;
      const modes = riding.map(leg => modeMap[String(leg.mode)] ?? "rail");
      if (modes.some(mode => !spec.modes.includes(mode))) continue;
      const dep = requiredTime(itinerary.startTime), arr = requiredTime(itinerary.endTime);
      const rideDep = requiredTime(riding[0].startTime || riding[0].scheduledStartTime);
      if (localDate(rideDep, origin.timezone) !== day || timeKey(spec.departure_start) > localTime(rideDep, origin.timezone) || localTime(rideDep, origin.timezone) > timeKey(spec.departure_end)) continue;
      const segments = legs.map(leg => {
        const from = object(leg.from), to = object(leg.to);
        return normalizeSegment({ mode: String(leg.mode ?? "transfer").toLowerCase(), from_name: (from.name ?? origin.name) as string, to_name: (to.name ?? dest.name) as string,
          from_id: (from.stopId ?? null) as string | null, to_id: (to.stopId ?? null) as string | null,
          departure: modelTime(requiredTime(leg.startTime || leg.scheduledStartTime)), arrival: modelTime(requiredTime(leg.endTime || leg.scheduledEndTime)),
          operator: (leg.agencyName ?? null) as string | null, service: (leg.displayName || leg.routeShortName || null) as string | null, source: (leg.source ?? null) as string | null,
          from_timezone: (from.tz || origin.timezone) as string, to_timezone: (to.tz || dest.timezone) as string, assumed: !!leg.loopedCalendarSince, interline_with_previous: !!leg.interlineWithPreviousLeg });
      });
      const id = "transit:" + stableId(origin.id, dest.id, segments);
      const movement = normalizeJourney({ id, from_id: origin.id, to_id: dest.id, mode: modes.includes("rail") ? "rail" : modes[0],
        departure: modelTime(dep - duration(spec.timing.transit_before_minutes, MINUTE)), arrival: modelTime(arr + duration(spec.timing.transit_after_minutes, MINUTE)), duration_minutes: elapsed(arr - dep, MINUTE),
        transfers: riding.slice(1).filter(leg => !leg.interlineWithPreviousLeg).length, segments, source: "Transitous / MOTIS" } as Movement).raw;
      if (micros(movement.arrival!) <= micros(movement.departure!)) continue;
      const looped = [...new Set(riding.filter(leg => leg.loopedCalendarSince).map(leg => String(leg.loopedCalendarSince)))].sort();
      if (looped.length) {
        movement.schedule_estimated = true;
        movement.assumptions.push("Estimated timetable: provider repeated service beyond feed validity (since " + looped.join(", ") + "). Verify the travel date; holidays and timetable changes may differ.");
      }
      movements.push(movement);
      const fare = looped.length ? null : transitFare(itinerary, spec.adults);
      if (fare) {
        if (!Number.isFinite(fare[0]) || fare[0] < 0 || !/^[A-Za-z]{3}$/.test(fare[1])) throw new Error("Invalid provider fare.");
        offers.push(normalizeFare({ id: "provider:" + id, movement_ids: [id], low: fare[0], high: fare[0], currency: fare[1].toUpperCase(), label: "GTFS fare products for party" }));
      }
    } catch { /* A malformed itinerary is skipped, as in the provider reference. */ }
  }
  return { movements, offers };
}
