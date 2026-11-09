/** Opt-in rail sampling and schedule projection, matching planner_rail.py. */
import type { Place, TripSpec } from "../lib/planner";
import { addDate, daysBetween, iso, localDate, shiftWallDate, stableId, weekday } from "./time";
import { timestamp } from "./journeys";

export const RAIL_FALLBACK_SOURCE = "Transitous / MOTIS rail fallback";
export type RailTask = Record<string, unknown> & { kind: string; from_id: string; to_id: string; date: string; key?: string;
  cursor?: string; rail_radius?: boolean; rail_reference_dates?: string[]; rail_sample_index?: number; rail_reference_date?: string };

export function searchModes(spec: TripSpec, from: string, to: string) {
  const blocked = new Set((spec.positioning_policies ?? []).filter(p => (p.direction === "outbound" ? from === spec.home.id && to === p.gateway_id : from === p.gateway_id && to === spec.home.id)
    && (!p.available || !p.search_more)).map(p => p.mode));
  return spec.modes.filter(mode => !blocked.has(mode));
}

export function fallbackTask(task: RailTask, spec: TripSpec, today: string): RailTask | null {
  const settings = spec.rail_fallback;
  if (!settings?.enabled || task.cursor || !searchModes(spec, task.from_id, task.to_id).includes("rail")) return null;
  let next: RailTask;
  if (!task.rail_radius) {
    let dates: string[] = [];
    if (task.date > addDate(today, 14)) {
      const anchor = settings.reference_date ?? today;
      const first = addDate(anchor, (weekday(task.date) - weekday(anchor) + 7) % 7);
      dates = [0, 1, 2].map(i => addDate(first, i * 7)).sort((a, b) => Math.abs(daysBetween(task.date, a)) - Math.abs(daysBetween(task.date, b)) || a.localeCompare(b))
        .filter(day => day !== task.date && Math.abs(daysBetween(task.date, day)) <= settings.max_shift_days);
    }
    next = { kind: "transit", from_id: task.from_id, to_id: task.to_id, date: task.date, rail_radius: true, rail_reference_dates: dates };
  } else {
    const dates = task.rail_reference_dates ?? [], index = (task.rail_sample_index ?? -1) + 1;
    if (index >= dates.length) return null;
    next = { ...task, rail_sample_index: index, rail_reference_date: dates[index] };
    delete next.key; delete next.outcome;
  }
  next.key = stableId("rail-fallback-v1", next);
  return next;
}

type Value = Record<string, unknown>;
const record = (value: unknown): Value => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected a provider object.");
  return value as Value;
};
const parseTime = (value: unknown) => {
  if (typeof value !== "number" && typeof value !== "string") throw new Error("Timetable timestamps must include a timezone.");
  return timestamp(value);
};
const passive = new Set(["WALK", "FOOT", "WAIT", "TRANSFER"]);
function distance(from: unknown, to: unknown): number | null {
  try {
    const a = record(from), b = record(to), coords = [a.lat, b.lat, a.lon, b.lon];
    if (coords.some(n => n == null || !Number.isFinite(Number(n)))) return null;
    const [lat1, lat2, lon1, lon2] = coords.map(n => Number(n) * Math.PI / 180);
    const h = Math.sin((lat2 - lat1) / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin((lon2 - lon1) / 2) ** 2;
    return 6371000 * 2 * Math.asin(Math.min(1, Math.sqrt(h)));
  } catch { return null; }
}

export function prepareRailPayload(payload: unknown, task: RailTask, origin: Place): unknown {
  if (!task.rail_radius) return payload;
  const result: { itineraries: Value[] } = { itineraries: [] }, source = record(payload);
  if (!Array.isArray(source.itineraries)) return result;
  for (const original of source.itineraries) {
    try {
      const item = structuredClone(record(original));
      if (!Array.isArray(item.legs)) continue;
      const legs = item.legs.map(record), riding = legs.filter(leg => !passive.has(String(leg.mode)));
      if (!riding.length) continue;
      for (const leg of legs) {
        leg.startTime = leg.scheduledStartTime || leg.startTime;
        leg.endTime = leg.scheduledEndTime || leg.endTime;
        const start = parseTime(leg.startTime), end = parseTime(leg.endTime);
        if (end < start) throw new Error("Invalid timetable interval.");
        if (["WALK", "FOOT"].includes(String(leg.mode)) && end === start) {
          const meters = distance(leg.from, leg.to);
          if (meters === null || meters > 100) throw new Error("Station access time was not supplied.");
        }
      }
      let delta = 0n;
      if (task.rail_reference_date) {
        const local = parseTime(riding[0].startTime);
        if (localDate(local, origin.timezone) !== task.rail_reference_date) continue;
        delta = shiftWallDate(local, task.date, origin.timezone) - local;
      }
      let previousEnd: bigint | null = null;
      for (const leg of legs) {
        const start = parseTime(leg.startTime) + delta, end = parseTime(leg.endTime) + delta;
        if (previousEnd !== null && start < previousEnd) throw new Error("Overlapping timetable legs.");
        previousEnd = end;
        Object.assign(leg, { startTime: iso(start), endTime: iso(end), scheduledStartTime: iso(start), scheduledEndTime: iso(end) });
        if (task.rail_reference_date) delete leg.loopedCalendarSince;
      }
      Object.assign(item, { startTime: legs[0].startTime, endTime: legs[legs.length - 1].endTime });
      if (task.rail_reference_date) delete item.fareTransfers;
      result.itineraries.push(item);
    } catch { /* Incomplete/invalid/ambiguous schedules cannot become projections. */ }
  }
  return result;
}
