import type { Mode, TripDraft, TripSpec } from "./planner";

/**
 * What a new trip starts with: the values about the traveller, not about one trip. The planner saves them when a
 * round trip is created, or saved with one of them changed. Rental cars are not in it: their pickup and drop-off
 * places belong to one trip. Journeys with exact times ("I have tickets") are not in it either.
 */
export type Profile = Pick<TripSpec, "home" | "departures" | "arrivals" | "adults" | "timing" | "cars" | "exchange_rates" | "positioning_policies" | "positioning_patterns">;
export function profileOf(spec: TripSpec): Profile {
  return {
    home: spec.home, departures: spec.departures, arrivals: spec.arrivals, adults: spec.adults, timing: spec.timing, exchange_rates: spec.exchange_rates,
    cars: { ...spec.cars, rental_enabled: false, rental_pickups: [], rental_dropoffs: [] },
    ...(spec.positioning_policies?.length ? { positioning_policies: spec.positioning_policies } : {}),
    ...(spec.positioning_patterns?.length ? { positioning_patterns: spec.positioning_patterns } : {}),
  };
}

/**
 * Search effort: the new requests to data providers that one batch sends. Find trips runs up to 10 batches on its own,
 * so "Standard" sends up to 1,000. Other batch sizes and rounds limited by minutes are "custom".
 */
export const searchEfforts = [{ id: "quick", label: "Quick", batch: 30 }, { id: "standard", label: "Standard", batch: 100 }, { id: "thorough", label: "Thorough", batch: 300 }] as const;
export const searchEffort = (batchSize: number, minutes: number | null) => minutes === null ? searchEfforts.find(effort => effort.batch === batchSize) ?? null : null;

/** The three transport groups of the Plan step. The engine keeps its eight modes; a group turns its modes on or off together. */
export const transportGroups = [
  { id: "flights", label: "Flights", modes: ["flight"] },
  { id: "transit", label: "Trains & buses", modes: ["rail", "bus", "coach", "subway", "tram"] },
  { id: "road", label: "Car & taxi", modes: ["car", "taxi"] },
] as const satisfies readonly { id: string; label: string; modes: readonly Mode[] }[];
export type TransportGroup = (typeof transportGroups)[number];

/** "on" when every mode of the group is on, "some" when only some are, "off" when none are. */
export function groupState(modes: Mode[], group: TransportGroup): "on" | "some" | "off" {
  const on = group.modes.filter(mode => modes.includes(mode)).length;
  return on === group.modes.length ? "on" : on ? "some" : "off";
}

/** Turns all modes of a group on or off. */
export function setGroup(modes: Mode[], group: TransportGroup, on: boolean): Mode[] {
  const rest = modes.filter(mode => !(group.modes as readonly Mode[]).includes(mode));
  return on ? [...rest, ...group.modes] : rest;
}

/** No daily departure limit: the engine needs a window that ends after it starts. */
export const anyDeparture = { departure_start: "00:00", departure_end: "23:59" } as const;
export const departsAnyTime = (draft: Pick<TripDraft, "departure_start" | "departure_end">) =>
  draft.departure_start.slice(0, 5) === anyDeparture.departure_start && draft.departure_end.slice(0, 5) === anyDeparture.departure_end;

const minutesOf = (time: string | null | undefined) => time ? Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5)) : null;
const dayMs = 86_400_000;
const dayTime = (date: string) => /^\d{4}-\d{2}-\d{2}$/.test(date) ? Date.parse(`${date}T00:00:00Z`) : NaN;

/**
 * The hours the user is free, in home time: from the start date (after the leave-home time on a trip that leaves
 * home) to the end date (by the be-home time on a trip that returns home). Null while a date is incomplete.
 */
export function freeHours(draft: Pick<TripDraft, "start_date" | "end_date" | "home_departure_earliest" | "home_arrival_latest" | "one_way">) {
  const start = dayTime(draft.start_date), end = dayTime(draft.end_date);
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  const leave = draft.one_way === "to_home" ? 0 : minutesOf(draft.home_departure_earliest) ?? 0;
  const back = draft.one_way === "from_home" ? 1440 : minutesOf(draft.home_arrival_latest) ?? 1440;
  const hours = (end - start) / 3_600_000 + (back - leave) / 60;
  return hours > 0 ? hours : null;
}

/**
 * The automatic minimum stay per city: the free time after one day per journey, divided evenly, rounded down to
 * whole days (or whole hours under a day, at least 1 h). Null without free time or cities.
 */
export function autoStayHours(draft: Pick<TripDraft, "start_date" | "end_date" | "home_departure_earliest" | "home_arrival_latest" | "one_way" | "visits">) {
  const hours = freeHours(draft), cities = draft.visits.length;
  if (hours === null || !cities) return null;
  const journeys = cities + (draft.one_way ? 0 : 1);
  const share = (hours - 24 * journeys) / cities;
  return share >= 24 ? Math.floor(share / 24) * 24 : Math.max(1, Math.floor(share));
}

/**
 * Applies `next` after `previous`, keeping automatic minimum stays automatic: a city whose stay was the automatic
 * value (or unset) before the change gets the new automatic value. A stay the user typed stays as typed.
 */
export function withAutoStays(previous: TripDraft, next: TripDraft): TripDraft {
  const before = autoStayHours(previous), after = autoStayHours(next);
  if (after === null) return next;
  const old = new Map(previous.visits.map(visit => [visit.place.id, visit.min_stay_hours]));
  const isAuto = (id: string, hours: number) => !old.has(id) ? hours <= 0 : old.get(id)! <= 0 || old.get(id) === before;
  const visits = next.visits.map(visit => isAuto(visit.place.id, visit.min_stay_hours) && visit.min_stay_hours !== after ? { ...visit, min_stay_hours: after } : visit);
  return visits.some((visit, i) => visit !== next.visits[i]) ? { ...next, visits } : next;
}

/** Whether a city's minimum stay is the automatic value. */
export const isAutoStay = (draft: TripDraft, hours: number) => hours > 0 && hours === autoStayHours(draft);

/** "3 days", "1.5 days" or "10 h". */
export function stayText(hours: number) {
  if (hours >= 24) { const days = Math.round(hours / 2.4) / 10; return `${days} ${days === 1 ? "day" : "days"}`; }
  return `${Math.round(hours * 10) / 10} h`;
}

const weekday = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
/**
 * The availability sentence: "10 days 11 h · leave Penang after Thu 24 Dec 18:00, be back by Mon 4 Jan 05:00
 * (Penang time)". Null while the dates are incomplete.
 */
export function availabilityText(draft: TripDraft) {
  const hours = freeHours(draft);
  const start = dayTime(draft.start_date), end = dayTime(draft.end_date);
  if (hours === null || Number.isNaN(start) || Number.isNaN(end)) return null;
  const days = Math.floor(hours / 24), rest = Math.round(hours - days * 24);
  const length = [days && `${days} ${days === 1 ? "day" : "days"}`, rest && `${rest} h`].filter(Boolean).join(" ") || "0 h";
  const home = draft.home?.name ?? "home";
  const when = (time: number, clock: string | null | undefined) => `${weekday.format(new Date(time))}${clock ? ` ${clock.slice(0, 5)}` : ""}`;
  const parts = [
    draft.one_way === "to_home" ? `start from ${when(start, null)}` : `leave ${home} ${draft.home_departure_earliest ? "after" : "from"} ${when(start, draft.home_departure_earliest)}`,
    draft.one_way === "from_home" ? `end by ${when(end + dayMs - 1, null)}` : `be back by ${draft.home_arrival_latest ? when(end, draft.home_arrival_latest) : `the end of ${weekday.format(new Date(end))}`}`,
  ];
  return `${length} · ${parts.join(", ")}${draft.home ? ` (${home} time)` : ""}`;
}
