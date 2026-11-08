/** Mutate a collected snapshot with one provider outcome, matching ingest(). */
import type { Movement, Offer, TripSpec } from "../../lib/planner";
import { parseOffer } from "./contracts";
import { makeLeg, placesOf } from "./discovery";
import type { FlightLeg, MetroAirports } from "./discovery";
import { flightMovement, timestamp, transitMovements } from "./journeys";
import type { RawSegment, Roads } from "./journeys";
import { prepareRailPayload, RAIL_FALLBACK_SOURCE, searchModes } from "./rail";
import type { RailTask } from "./rail";
import { roadMovements } from "./preparation";
import type { Snapshot } from "./preparation";
import { duration, general, iso, localDate, SECOND, stableId } from "./time";

export type ProviderTask = { kind: "road" | "flight" | "bundle" | "transit"; key: string; from_id?: string; to_id?: string; date?: string; legs?: FlightLeg[];
  round_trip_selection?: string[][]; round_trip_root?: string;
  ticket_kind?: "round-trip" | "multi-city"; rail_radius?: boolean; rail_reference_date?: string; [key: string]: unknown };
export type ProviderOutcome = { status: string; roads?: Roads; options?: { price: number | null; journeys: RawSegment[][] }[]; search_url?: string | null; flight_choices?: string[][][];
  payload?: unknown; retrieved_at?: string | number; [key: string]: unknown };
const railModes = new Set(["RAIL", "HIGHSPEED_RAIL", "LONG_DISTANCE", "NIGHT_RAIL", "REGIONAL_FAST_RAIL", "REGIONAL_RAIL", "SUBURBAN"]);

export function ingest(task: ProviderTask, outcome: ProviderOutcome, spec: TripSpec, snapshot: Snapshot, metros: MetroAirports, now = Date.now() * 1000, transitTtl = 6 * 60 * 60): Movement[] {
  const movements = new Map(snapshot.movements.map(m => [m.id, m])), offers = new Map(snapshot.offers.map(o => [o.id, o]));
  const places = placesOf(spec);
  let collected: Movement[] = [], fares: Offer[] = [];
  if (task.kind === "road" && outcome.roads) {
    snapshot.roads = outcome.roads;
    collected = roadMovements(spec, outcome.roads);
  } else if (task.kind === "flight" || task.kind === "bundle") {
    const legs = task.kind === "bundle" ? task.legs! : [makeLeg(places.get(task.from_id!)!, places.get(task.to_id!)!, task.date!, metros)];
    for (const option of outcome.options ?? []) {
      if (!Object.hasOwn(option, "price")) throw new Error("A flight option needs a price or null.");
      const covered: string[] = [];
      for (let i = 0; i < Math.min(legs.length, option.journeys.length); i++) {
        const leg = legs[i], m = flightMovement(places.get(leg.from_id)!, places.get(leg.to_id)!, option.journeys[i], spec, snapshot.roads ?? {});
        m.search_url = outcome.search_url ?? null;
        collected.push(m); covered.push(m.id);
      }
      if (covered.length !== legs.length) continue;
      if (option.price !== null) fares.push(parseOffer({ id: "provider:" + stableId(covered, task.ticket_kind ?? "one-way"), movement_ids: covered,
        kind: task.ticket_kind ?? "one-way", low: option.price, high: option.price, label: "Google Flights party fare", search_url: outcome.search_url ?? null }));
    }
  } else if (task.kind === "transit" && outcome.payload) {
    const pairSpec = { ...spec, modes: task.rail_radius ? ["rail"] as TripSpec["modes"] : searchModes(spec, task.from_id!, task.to_id!) };
    const payload = prepareRailPayload(outcome.payload, task as RailTask, places.get(task.from_id!)!);
    ({ movements: collected, offers: fares } = transitMovements(payload, places.get(task.from_id!)!, places.get(task.to_id!)!, pairSpec, task.date!));
    for (const m of collected) if (task.rail_radius) {
      m.source = RAIL_FALLBACK_SOURCE;
      m.assumptions.push(`Station search within ${general(spec.rail_fallback!.station_radius_km)} km; station access/egress uses provider walking times. Verify local access.`);
      if (task.rail_reference_date) {
        m.schedule_estimated = true; m.schedule_reference_date = task.rail_reference_date;
        m.assumptions.push(`Estimated timetable based on ${task.rail_reference_date} (same weekday), copied to ${task.date}. Travel-date coverage is unconfirmed; holidays, seasonal services and timetable changes are not checked. Fare and seat availability are unverified.`);
        for (const s of m.segments) { s.assumed = true; s.source = "Estimated timetable from " + task.rail_reference_date; }
      }
    }
  }
  function serviceDay(m: Movement) {
    const rail = m.segments.find(s => railModes.has(s.mode.toUpperCase()));
    return localDate(timestamp((rail ? rail.departure : m.departure)!), places.get(m.from_id)!.timezone);
  }
  if (task.rail_reference_date && [...movements.values()].some(m => m.from_id === task.from_id && m.to_id === task.to_id && m.mode === "rail" && !m.schedule_estimated && m.departure && serviceDay(m) === task.date)) {
    collected = []; fares = [];
  }
  for (const m of collected) movements.set(m.id, m);
  for (const offer of fares) {
    const retrieved = outcome.retrieved_at === undefined ? BigInt(now) : timestamp(outcome.retrieved_at);
    offer.adults = spec.adults; offer.retrieved_at = iso(retrieved, true);
    offer.expires_at = iso(retrieved + duration(task.kind === "flight" || task.kind === "bundle" ? 900 : transitTtl, SECOND), true);
    offers.set(offer.id, offer);
  }
  if (task.kind === "transit" && collected.some(m => m.mode === "rail" && !m.schedule_estimated) && !task.rail_reference_date) {
    const stale = new Set([...movements.values()].filter(m => m.source === RAIL_FALLBACK_SOURCE && m.schedule_reference_date && m.from_id === task.from_id && m.to_id === task.to_id && serviceDay(m) === task.date).map(m => m.id));
    for (const id of stale) movements.delete(id);
    for (const [id, offer] of offers) if (offer.movement_ids.some(key => stale.has(key))) offers.delete(id);
  }
  snapshot.movements = [...movements.values()]; snapshot.offers = [...offers.values()]; snapshot.revision++;
  return collected;
}
