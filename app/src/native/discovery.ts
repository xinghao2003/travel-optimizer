/** Discovery dates, seed order, and independent return-ticket queries.
 * All input settings are normalized TripSpec values; no provider I/O here.
 */
import type { Place, TripSpec } from "../lib/planner";
import { addDate, at, daysBetween, duration, HOUR, localDate, maxInstant, micros, minInstant, round, stableId } from "./time";
import { pairKey } from "./journeys";
import { searchModes } from "./rail";

export type MetroAirports = Record<string, string[]>;
export type FlightLeg = { from_id: string; to_id: string; date: string; from_code: string | null; to_code: string | null; from_airports: string[]; to_airports: string[]; timezone: string };
export type DiscoveryTask = { kind: "road"; key: string } | { kind: "flight" | "transit"; key: string; from_id: string; to_id: string; date: string }
  | { kind: "bundle"; key: string; ticket_kind: "round-trip" | "multi-city"; legs: FlightLeg[] };
export const placesOf = (spec: TripSpec) => new Map([spec.home, ...spec.departures, ...spec.arrivals, ...spec.visits.map(v => v.place)].map(place => [place.id, place]));
export function bounds(spec: TripSpec): [bigint, bigint] {
  return [at(spec.start_date, spec.home_departure_earliest ?? "00:00", spec.home.timezone),
    spec.home_arrival_latest != null ? at(spec.end_date, spec.home_arrival_latest, spec.home.timezone) : at(addDate(spec.end_date, 1), "00:00", spec.home.timezone) - 1n];
}
export function* permutations<T>(values: T[], count = values.length): Generator<T[]> {
  if (count === 0) { yield []; return; }
  for (let i = 0; i < values.length; i++) for (const tail of permutations([...values.slice(0, i), ...values.slice(i + 1)], count - 1)) yield [values[i], ...tail];
}
/** Visit orders, with revisits on the way back for trips that return home. */
function* visitOrders(spec: TripSpec) {
  const ids = spec.visits.map(v => v.place.id);
  const firsts = spec.ordered_visits ? [ids] : permutations(ids);
  for (const first of firsts) {
    yield first;
    if (spec.one_way === "from_home") continue;
    for (let count = 1; count < first.length; count++) for (const suffix of permutations(first.slice(0, -1), count)) yield [...first, ...suffix];
  }
}
const compact = (path: string[]) => path.filter((id, i) => i === 0 || id !== path[i - 1]);
/** The places before the first visit: home and the start city, or none for a trip that starts there. */
const tripHead = (spec: TripSpec, departure: Place) => spec.one_way === "to_home" ? [] : [spec.home.id, departure.id];
/** The places after the last visit: the end city and home, or none for a trip that ends there. */
const tripTail = (spec: TripSpec, arrival: Place) => spec.one_way === "from_home" ? [] : [arrival.id, spec.home.id];
export function seedDates(spec: TripSpec): string[] {
  const days = daysBetween(spec.start_date, spec.end_date), count = spec.visits.length + 1;
  return Array.from({ length: count }, (_, i) => addDate(spec.start_date, round(days * i / Math.max(1, count - 1), 0)));
}
export function roughDateWindows(spec: TripSpec): Map<string, [bigint, bigint]> {
  const [start, end] = bounds(spec), windows = new Map<string, [bigint, bigint]>();
  if (spec.cars.own_enabled) {
    for (const [a, b] of permutations([...placesOf(spec).keys()], 2)) windows.set(pairKey(a, b), [start, end]);
    return windows;
  }
  const stays = new Map(spec.visits.map(v => [v.place.id, v.min_stay_hours]));
  for (const order of visitOrders(spec)) for (const departure of spec.departures) for (const arrival of spec.arrivals) {
    const path = compact([...tripHead(spec, departure), ...order.filter(id => id !== departure.id), ...tripTail(spec, arrival)]);
    const unspent = new Set(stays.keys());
    let elapsed = 0;
    for (let i = 0; i + 1 < path.length; i++) {
      const a = path[i], b = path[i + 1];
      if (unspent.has(a)) { elapsed += stays.get(a)!; unspent.delete(a); }
      const earliest = start + duration(elapsed, HOUR), latest = end - duration([...unspent].reduce((sum, id) => sum + stays.get(id)!, 0), HOUR);
      if (earliest > latest) continue;
      const key = pairKey(a, b), old = windows.get(key) ?? [earliest, latest];
      windows.set(key, [minInstant(old[0], earliest), maxInstant(old[1], latest)]);
    }
  }
  return windows;
}
export function makeLeg(origin: Place, dest: Place, day: string, metros: MetroAirports): FlightLeg {
  return { from_id: origin.id, to_id: dest.id, date: day, from_code: origin.flight_code, to_code: dest.flight_code,
    from_airports: [...new Set([...origin.airport_codes, ...(metros[origin.flight_code ?? ""] ?? [])])].sort(),
    to_airports: [...new Set([...dest.airport_codes, ...(metros[dest.flight_code ?? ""] ?? [])])].sort(), timezone: origin.timezone };
}
const transitModes = new Set(["rail", "bus", "coach", "subway", "tram"]);
export function tasksFor(spec: TripSpec, metros: MetroAirports, transitEnabled: boolean): DiscoveryTask[] {
  const places = placesOf(spec), windows = roughDateWindows(spec), [start, end] = bounds(spec);
  const tasks: DiscoveryTask[] = spec.modes.some(m => ["flight", "car", "taxi"].includes(m)) ? [{ kind: "road", key: "road" }] : [];
  const seen = new Set(["road"]), hasTransit = transitEnabled && spec.modes.some(mode => transitModes.has(mode));
  function task(a: string, b: string, day: string, kind: "flight" | "transit") {
    const allowed = searchModes(spec, a, b), window = windows.get(pairKey(a, b));
    if (kind === "flight" && !allowed.includes("flight") || kind === "transit" && !allowed.some(m => transitModes.has(m)) || !window) return;
    const origin = places.get(a)!, dest = places.get(b)!;
    if (day < localDate(window[0], origin.timezone) || day > localDate(window[1], origin.timezone)) return;
    const key = stableId(kind, a, b, day);
    if (seen.has(key) || kind === "flight" && (!origin.flight_code || !dest.flight_code)) return;
    seen.add(key); tasks.push({ key, kind, from_id: a, to_id: b, date: day });
  }
  const dates = seedDates(spec);
  for (const order of visitOrders(spec)) for (const departure of spec.departures) for (const arrival of spec.arrivals) {
    const path = compact([...tripHead(spec, departure), ...order, ...tripTail(spec, arrival)]);
    // Leg i leaves the i-th place of a round trip; a trip from the first city skips the leg from home.
    const shift = spec.one_way === "to_home" ? 1 : -Number(departure.id !== spec.home.id);
    for (let i = 0; i + 1 < path.length; i++) {
      let day = dates[Math.min(dates.length - 1, Math.max(0, i + shift))];
      if (i === 0 && spec.one_way !== "to_home") day = spec.start_date;
      if (i === path.length - 2 && spec.one_way !== "from_home") day = spec.end_date;
      if (spec.modes.includes("flight")) task(path[i], path[i + 1], day, "flight");
      if (hasTransit) task(path[i], path[i + 1], day, "transit");
    }
  }
  const seedCount = tasks.length;
  for (const [a, b] of permutations([...places.keys()], 2)) {
    const zone = places.get(a)!.timezone, first = localDate(start, zone), last = localDate(end, zone);
    for (let day = first; day <= last; day = addDate(day, 1)) {
      if (spec.modes.includes("flight")) task(a, b, day, "flight");
      if (hasTransit) task(a, b, day, "transit");
    }
  }
  const flightDays = new Map<string, string[]>();
  for (const item of tasks) if (item.kind === "flight") {
    const key = pairKey(item.from_id, item.to_id), days = flightDays.get(key) ?? [];
    days.push(item.date); flightDays.set(key, days);
  }
  const minimum = duration(spec.visits.reduce((sum, visit) => sum + visit.min_stay_hours, 0), HOUR), bundles: DiscoveryTask[] = [];
  // A one-way trip never both leaves and comes back to a gateway, so round trips cannot apply.
  for (const gateway of spec.one_way ? [] : spec.departures) {
    if (!spec.arrivals.some(p => p.id === gateway.id)) continue;
    let earliest = start, latest = end;
    if (gateway.id !== spec.home.id) for (const direction of ["outbound", "return"] as const) {
      const [a, b] = direction === "outbound" ? [spec.home.id, gateway.id] : [gateway.id, spec.home.id];
      const services = (spec.positioning_services ?? []).filter(s => s.direction === direction && s.gateway_id === gateway.id && spec.modes.includes(s.mode) && micros(s.departure) >= start && micros(s.arrival) <= end);
      // A regular service runs every day, so it never narrows the dates.
      const regular = (spec.positioning_patterns ?? []).some(s => s.direction === direction && s.gateway_id === gateway.id && spec.modes.includes(s.mode));
      if (!searchModes(spec, a, b).length && services.length && !regular) {
        if (direction === "outbound") earliest = maxInstant(earliest, minInstant(...services.map(s => micros(s.arrival))));
        else latest = minInstant(latest, maxInstant(...services.map(s => micros(s.departure))));
      }
    }
    for (const visit of spec.visits) {
      const dest = visit.place;
      if (gateway.id === dest.id) continue;
      for (const outbound of [...(flightDays.get(pairKey(gateway.id, dest.id)) ?? [])].sort()) {
        if (gateway.id === spec.home.id && spec.date_mode === "fixed" && outbound !== spec.start_date) continue;
        const first = maxInstant(earliest, at(outbound, spec.departure_start, gateway.timezone));
        if (first > at(outbound, spec.departure_end, gateway.timezone)) continue;
        for (const inbound of [...(flightDays.get(pairKey(dest.id, gateway.id)) ?? [])].sort()) {
          const last = minInstant(latest, at(inbound, spec.departure_end, dest.timezone));
          if (last < first + minimum || last < at(inbound, spec.departure_start, dest.timezone)) continue;
          const legs = [makeLeg(gateway, dest, outbound, metros), makeLeg(dest, gateway, inbound, metros)], key = stableId("round-trip", legs);
          if (!seen.has(key)) { seen.add(key); bundles.push({ kind: "bundle", ticket_kind: "round-trip", key, legs }); }
        }
      }
    }
  }
  return [...tasks.slice(0, seedCount), ...bundles, ...tasks.slice(seedCount)];
}
