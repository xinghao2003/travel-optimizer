import { blankTrip, defaultBatchSize, localInputToISO, modes, type AirportConnectionRequirement, type AirportTransferMode, type AirportTransferRow, type ApiError, type Charge, type Coverage, type Job, type Mode, type Movement, type Offer, type PricingRule, type Result, type Route, type SavedTrip, type Segment, type TripDraft } from "./planner";
import type { MissingFareGroup } from "./missingFares";
import type { OptimizationJob } from "./planner";

// Pure display and decision helpers for the planner UI (spec sections C–G). No React here:
// tests load this file directly.
//
// Trip records come in two shapes. GET /trips/{id} empties snapshot.movements and adds
// fields that the server computes (read_trip in planner_api.py). PUT /trips/{id} returns the
// stored record with snapshot.movements and airport_transfer_rows, but without
// airport_connections_required, assumed_connections, city_connection_gaps and fare_component_ids.
// Helpers that read the record use the server field when it is present, otherwise they derive it the same way.

// ---------------------------------------------------------------- display

const modeLabels: Record<string, string> = { flight: "Flight", rail: "Train", bus: "Bus", coach: "Coach", subway: "Subway", tram: "Tram", car: "Car", taxi: "Taxi", rental: "Rental car", "*": "Any" };
/** Display label for a transport mode value ("rail" → "Train"). Other values show as they are. */
export function modeLabel(mode: string) {
  return modeLabels[mode] ?? mode;
}

/** A count with thousands separators ("1,234"). */
const whole = (count: number) => formatNumber(count, 0);
const plural = (count: number, word: string, many = `${word}s`) => `${whole(count)} ${count === 1 ? word : many}`;
const joinAnd = (items: string[]) => items.length > 1 ? `${items.slice(0, -1).join(", ")} and ${items.at(-1)}` : items[0] ?? "";
const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
const hhmm = (time: string) => time.slice(0, 5);
const cents = (value: number) => Math.round(value * 100) / 100;

const numberFormats = new Map<string, Intl.NumberFormat>();
function formatNumber(value: number, digits: number, currency?: string) {
  const key = `${currency ?? ""}:${digits}`;
  let format = numberFormats.get(key);
  if (!format) {
    const fraction = { minimumFractionDigits: digits, maximumFractionDigits: digits };
    format = new Intl.NumberFormat("en-MY", currency ? { style: "currency", currency, currencyDisplay: currency === "MYR" ? "symbol" : "code", ...fraction } : fraction);
    numberFormats.set(key, format);
  }
  return format.format(value);
}
const fractionDigits = (value: number) => Math.round(value * 100) % 100 === 0 ? 0 : 2;
/** An amount without the currency, by the moneyShort rule ("6,227", "6,227.50"). */
const amount = (value: number) => formatNumber(value, fractionDigits(value));

/** Money for display: whole amounts without decimals ("RM 5,395"), others with 2; other currencies by code ("JPY 12,000"). */
export function moneyShort(value: number, currency = "MYR") {
  return formatNumber(value, fractionDigits(value), currency);
}

/** A duration in minutes: "45 min", "2 h", "1 h 30 min". */
export function formatDuration(minutes: number) {
  const total = Math.round(minutes);
  const hours = Math.floor(total / 60), rest = total % 60;
  return hours ? rest ? `${hours} h ${rest} min` : `${hours} h` : `${rest} min`;
}

const dateStyles = {
  date: { weekday: "short", day: "numeric", month: "short" },
  time: { hour: "2-digit", minute: "2-digit", hourCycle: "h23" },
  day: { day: "numeric", month: "short" },
  year: { day: "numeric", month: "short", year: "numeric" },
  iso: { year: "numeric", month: "2-digit", day: "2-digit" },
} satisfies Record<string, Intl.DateTimeFormatOptions>;
const dateFormats = new Map<string, Intl.DateTimeFormat>();
function dateFormat(zone: string, style: keyof typeof dateStyles) {
  const key = `${style}|${zone}`;
  let format = dateFormats.get(key);
  if (!format) {
    // sv-SE writes dates as YYYY-MM-DD.
    format = new Intl.DateTimeFormat(style === "iso" ? "sv-SE" : "en-GB", { ...dateStyles[style], timeZone: zone });
    dateFormats.set(key, format);
  }
  return format;
}

/** A timestamp in a place's time zone: "Fri 4 Dec 18:54" (datetime), "Fri 4 Dec" (date), "18:54" (time) or "4 Dec" (day). */
export function formatLocal(value: string, zone: string, style: "datetime" | "date" | "time" | "day" = "datetime") {
  const date = new Date(value);
  return style === "datetime" ? `${dateFormat(zone, "date").format(date)} ${dateFormat(zone, "time").format(date)}` : dateFormat(zone, style).format(date);
}

/** Trip dates (YYYY-MM-DD) as "4–14 Dec 2026", "28 Nov – 4 Dec 2026" or "28 Dec 2026 – 3 Jan 2027". */
export function dateRange(start: string, end: string) {
  const [a, b] = [start, end].map(value => {
    const date = new Date(`${value}T00:00:00Z`);
    return Number.isNaN(date.getTime()) ? null : Object.fromEntries(dateFormat("UTC", "year").formatToParts(date).map(part => [part.type, part.value]));
  });
  // A cleared date input leaves "" in the draft.
  if (!a || !b) return [start, end].filter(Boolean).join(" – ");
  if (a.year !== b.year) return `${a.day} ${a.month} ${a.year} – ${b.day} ${b.month} ${b.year}`;
  if (a.month !== b.month) return `${a.day} ${a.month} – ${b.day} ${b.month} ${b.year}`;
  return a.day === b.day ? `${b.day} ${b.month} ${b.year}` : `${a.day}–${b.day} ${b.month} ${b.year}`;
}

/** The total price of an option: "RM 5,395" (exact), "RM 6,187 – 6,227" (range) or "From RM 2,480" (some items not priced). */
export function priceText(route: Pick<Route, "total_cost_myr" | "cost_low_myr" | "cost_high_myr">) {
  if (route.total_cost_myr !== null) return moneyShort(route.total_cost_myr);
  if (route.cost_high_myr === null) return `From ${moneyShort(route.cost_low_myr)}`;
  return `${moneyShort(route.cost_low_myr)} – ${amount(route.cost_high_myr)}`;
}

const isEstimate = (offer: Pick<Offer, "estimated" | "source" | "currency">) => offer.estimated || offer.source === "rule" || offer.currency !== "MYR";
/** Whether the price uses estimates: your prices, rules, older quotes or a converted currency (the backend rule). */
export function priceEstimated(route: Pick<Route, "purchases">) {
  return route.purchases.some(isEstimate);
}

const hasRate = (currency: string, rates: Record<string, number>) => currency === "MYR" || rates[currency] !== undefined;
const isPriced = (offer: Pick<Offer, "low" | "currency">, rates: Record<string, number>) => offer.low !== null && hasRate(offer.currency, rates);

type ItemKind = "flight" | "train" | "bus" | "transfer" | "change" | "other";
const itemWords: [ItemKind, string, string][] = [["flight", "flight", "flights"], ["train", "train", "trains"], ["bus", "bus", "buses"], ["transfer", "airport transfer", "airport transfers"], ["change", "airport change", "airport changes"], ["other", "other item", "other items"]];
/** What each priced component of a route is: movement ids by mode, charge ids by kind. Extra charges (rental) count as other. */
function itemKinds(route: Pick<Route, "movements">) {
  const kinds = new Map<string, ItemKind>();
  for (const movement of route.movements) {
    kinds.set(movement.id, movement.mode === "flight" ? "flight" : movement.mode === "rail" ? "train" : movement.mode === "bus" || movement.mode === "coach" ? "bus" : "other");
    for (const charge of movement.charges) kinds.set(charge.id, charge.kind === "Airport access" || charge.kind === "Airport egress" ? "transfer" : charge.kind.startsWith("Airport transfer ") ? "change" : "other");
  }
  return kinds;
}
function itemList(kinds: ItemKind[]) {
  return itemWords.flatMap(([kind, one, many]) => {
    const count = kinds.filter(item => item === kind).length;
    return count ? [plural(count, one, many)] : [];
  }).join(", ");
}

/**
 * Items without a complete price in an option. A purchase with no price, or in a currency without
 * an exchange rate, is not priced; a price without an upper limit is open-ended. `chip` is the short
 * form for option rows ("10 not priced"); `text` adds the items ("10 not priced: 2 flights, 8 airport transfers").
 */
export function unpricedSummary(route: Pick<Route, "purchases" | "movements">, rates: Record<string, number>) {
  const kinds = itemKinds(route);
  const kindOf = (offer: Offer) => kinds.get(offer.movement_ids[0]) ?? "other";
  const notPriced = route.purchases.filter(offer => !isPriced(offer, rates)).map(kindOf);
  const openEnded = route.purchases.filter(offer => isPriced(offer, rates) && offer.high === null).map(kindOf);
  const openText = plural(openEnded.length, "open-ended price");
  const chip = notPriced.length ? `${notPriced.length} not priced` : openEnded.length === 1 ? "open-ended price" : openEnded.length ? openText : "";
  const text = notPriced.length ? `${notPriced.length} not priced: ${itemList(notPriced)}${openEnded.length ? ` · ${openText}` : ""}`
    : openEnded.length ? `${openText}: ${itemList(openEnded)}` : "";
  return { count: notPriced.length, openEnded: openEnded.length, chip, text };
}

/** "RM 24.72 per city hour" (exact) or "RM 28.0 – 28.2 per city hour" (range). Null when some items are not priced. */
export function perCityHourText(route: Pick<Route, "total_cost_myr" | "cost_low_myr" | "cost_high_myr" | "cost_per_stay_hour_myr" | "stay_hours">) {
  if (route.cost_high_myr === null || route.stay_hours <= 0) return null;
  if (route.total_cost_myr !== null) return route.cost_per_stay_hour_myr === null ? null : `${moneyShort(route.cost_per_stay_hour_myr)} per city hour`;
  return `${formatNumber(route.cost_low_myr / route.stay_hours, 1, "MYR")} – ${formatNumber(route.cost_high_myr / route.stay_hours, 1)} per city hour`;
}

/** E9.4 amount of one purchase: "RM 2,180", "RM 210 – 250", "RM 900 or more" or "Not priced". */
function offerAmount(offer: Pick<Offer, "low" | "high" | "currency">) {
  if (offer.low === null) return "Not priced";
  const low = moneyShort(offer.low, offer.currency);
  return offer.high === null ? `${low} or more` : offer.high === offer.low ? low : `${low} – ${amount(offer.high)}`;
}

// ---------------------------------------------------------------- routes

/** An option's route for its list row: the start place, then each journey's mode, destination and the stay that starts there. */
export function routeChain(route: Pick<Route, "movements" | "stays">) {
  // Stays and movements write the same instant in different formats ("+00:00" and "Z").
  const stays = new Map(route.stays.map(stay => [`${stay.place_id}@${Date.parse(stay.arrival)}`, stay.hours]));
  return {
    from: route.movements[0]?.from_id ?? "",
    steps: route.movements.map(movement => ({ mode: movement.mode, to: movement.to_id, hours: movement.arrival ? stays.get(`${movement.to_id}@${Date.parse(movement.arrival)}`) ?? null : null })),
  };
}

const passiveModes = new Set(["transfer", "walk", "foot", "wait"]);
// The first scheduled service in a journey. A trip transfer estimate relabels the airport access
// segment with its mode ("taxi"), so skip it the way the optimizer does (planner_optimizer.py).
function firstServiceDeparture(movement: Movement) {
  return movement.segments.find(segment => !passiveModes.has(segment.mode) && !(segment.source ?? "").startsWith("User-estimated airport") && segment.departure)?.departure ?? movement.departure;
}
/** Identifies an option across recalculations. Route and flight ids change when airport transfer prices change; templates and times do not. */
export function routeSignature(route: Pick<Route, "departure_gateway" | "arrival_gateway" | "movements">) {
  return JSON.stringify([route.departure_gateway, route.arrival_gateway, route.movements.map(movement => [movement.template_id ?? movement.id, firstServiceDeparture(movement)])]);
}

const highest = (route: Pick<Route, "total_cost_myr" | "cost_high_myr">) => route.total_cost_myr ?? route.cost_high_myr;
const byId = (a: Route, b: Route) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
// Bounded options by their highest possible price, then unbounded options.
function compareHighest(a: Route, b: Route) {
  const x = highest(a), y = highest(b);
  return x === null || y === null ? Number(x === null) - Number(y === null) : x - y;
}
function lowestPrice(a: Route, b: Route) {
  return compareHighest(a, b) || a.cost_low_myr - b.cost_low_myr || b.stay_hours - a.stay_hours || byId(a, b);
}
/**
 * Orders options (E3). "cheapest": bounded options by highest possible price, then unbounded options by
 * their known part. "stay": most time in cities first. "balanced": weighted squared distance to the
 * normalized ideal, unbounded options last. Best routes supply the reference ranges even when weaker routes show.
 */
export function sortRoutes<T extends Route>(routes: T[], key: string, { priceWeight = .5, referenceRoutes = routes }: { priceWeight?: number; referenceRoutes?: Route[] } = {}): T[] {
  if (key === "stay") return [...routes].sort((a, b) => b.stay_hours - a.stay_hours || compareHighest(a, b) || byId(a, b));
  if (key !== "balanced") return [...routes].sort(lowestPrice);
  const bounded = referenceRoutes.filter(route => highest(route) !== null);
  const prices = bounded.map(route => highest(route)!), stays = bounded.map(route => route.stay_hours);
  const minPrice = Math.min(...prices), maxPrice = Math.max(...prices), minStay = Math.min(...stays), maxStay = Math.max(...stays);
  const score = (route: Route) => {
    const priceGap = maxPrice > minPrice ? Math.max(0, (highest(route)! - minPrice) / (maxPrice - minPrice)) : 0;
    const timeGap = maxStay > minStay ? Math.max(0, (maxStay - route.stay_hours) / (maxStay - minStay)) : 0;
    // The square root would not change the ordering.
    return priceWeight * priceGap ** 2 + (1 - priceWeight) * timeGap ** 2;
  };
  return [...routes].sort((a, b) => {
    const unbounded = Number(highest(a) === null) - Number(highest(b) === null);
    return unbounded || (highest(a) === null ? lowestPrice(a, b) : score(a) - score(b) || lowestPrice(a, b));
  });
}

/** "01", "02", … */
export const optionNumber = (position: number) => String(position).padStart(2, "0");

/** Hours with one decimal ("218.3"), as the option rows show them. */
export const hoursText = (hours: number) => formatNumber(hours, 1);

/** A chip on an option row (C6): exceptions only. "warn" chips use the warning colours. */
export type OptionChip = { text: string; tone: "warn" | "plain" };
/**
 * The chips of an option row (C6, E1, E6). `estimatedOnce`: the list says once that every option includes
 * estimated prices, so the rows leave out that chip. "May exceed budget" is for bounded prices only; an
 * unbounded option says it once in Next steps (E6).
 */
export function optionChips(route: Route, { budget, rates, estimatedOnce, weaker, overBudget, compared }: {
  budget: number | null; rates: Record<string, number>; estimatedOnce: boolean; weaker: boolean; overBudget: boolean; compared: boolean;
}): OptionChip[] {
  const chips: OptionChip[] = [];
  const unpriced = unpricedSummary(route, rates).chip;
  if (unpriced) chips.push({ text: unpriced, tone: "warn" });
  if (!estimatedOnce && route.total_cost_myr !== null && priceEstimated(route)) chips.push({ text: "Includes estimates", tone: "plain" });
  const high = highest(route);
  if (!overBudget && budget !== null && high !== null && high > budget) chips.push({ text: "May exceed budget", tone: "warn" });
  if (route.movements.some(movement => movement.schedule_estimated)) chips.push({ text: "Estimated timetable", tone: "warn" });
  if (weaker) chips.push({ text: "Weaker", tone: "plain" });
  if (overBudget) chips.push({ text: "Over budget", tone: "warn" });
  if (compared) chips.push({ text: "Compared", tone: "plain" });
  return chips;
}

/**
 * Compares the selected option with another option, numbered `otherNumber` (E7). Hours use the 0.1 h
 * shown, so the price per extra hour matches the numbers on screen. Unknown totals give no price difference.
 */
export function compareText(selected: Route, other: Route, otherNumber: number) {
  const name = `Option ${optionNumber(otherNumber)}`;
  const hours = Math.round((selected.stay_hours - other.stay_hours) * 10) / 10;
  const time = hours === 0 ? "the same time in cities" : `${Math.abs(hours).toFixed(1)} h ${hours > 0 ? "more" : "less"} time in cities`;
  const selectedHigh = highest(selected), otherHigh = highest(other);
  if (selectedHigh === null || otherHigh === null) {
    const who = selectedHigh === null && otherHigh === null ? "both options have" : selectedHigh === null ? "this option has" : `${name} has`;
    return `vs ${name}: ${time}. Price difference unknown: ${who} items that are not priced.`;
  }
  // The price difference lies in [low, high]; both ends are equal when both totals are exact.
  const low = cents((selected.total_cost_myr ?? selected.cost_low_myr) - otherHigh);
  const high = cents(selectedHigh - (other.total_cost_myr ?? other.cost_low_myr));
  const span = (a: number, b: number) => a === b ? moneyShort(a) : `${moneyShort(a)} – ${amount(b)}`;
  const price = low === 0 && high === 0 ? "the same price"
    : low >= 0 ? `${span(low, high)} more`
    // Math.abs, not negation: -0 prints as "-RM 0".
    : high <= 0 ? `${span(Math.abs(high), Math.abs(low))} less`
    : `between ${moneyShort(-low)} less and ${moneyShort(high)} more`;
  // Whole ringgit per hour from RM 10, as on screen ("RM 273 – 287"); smaller values keep cents.
  const perHour = (value: number) => cents(Math.abs(value / hours) >= 10 ? Math.round(value / hours) : value / hours);
  const extra = hours > 0 && low >= 0 && high > 0 ? ` That is ${low === high ? moneyShort(perHour(low)) : `${moneyShort(perHour(low))} – ${amount(perHour(high))}`} per extra hour.`
    : hours > 0 && high < 0 ? " This option has more time in cities and costs less." : "";
  return `vs ${name}: ${time} and ${price}.${extra}`;
}

// ---------------------------------------------------------------- status

/** What a status strip button does: stop the search, start a new search, continue the search (search(true)) or recalculate with a higher limit. */
export type StripAction = { label: string; run: "stop" | "search" | "continue" | "optimize" | "stop-optimization"; tip?: string; disabled?: boolean };
export type SearchState = {
  /** Stable per state, so a live region announces state changes and not counter ticks. */
  id: string;
  tone: "busy" | "info" | "ok" | "warn" | "error";
  text: string;
  tip?: string;
  progress?: { value: number; max: number; text: string; tip: string };
  /** The "search" action of the not-searched state shows only while trip settings are closed. */
  actions: StripAction[];
  secondary: { text: string; tip: string; action: StripAction } | null;
};

/** The status strip (C3.1): the first matching row of the state table, plus the "Check more combinations" line. */
export function searchState({ invalid, dirty, saved, result, job, minutes, applying = false, optimization }: {
  invalid: boolean; dirty: boolean;
  saved: Pick<SavedTrip, "snapshot"> | null;
  result: Pick<Result, "discovery_required" | "optimization_complete" | "coverage"> | null;
  job: Job | null;
  minutes?: number | null;
  applying?: boolean;
  optimization?: OptimizationJob | null;
}): SearchState {
  const status = job?.status;
  const searched = !!saved?.snapshot || !!job;
  const active = status === "queued" || status === "running";
  const stale = !!result?.discovery_required || status === "superseded";
  const pending = job?.pending ?? 0, failed = job?.failed_queries ?? 0;
  const left = `${plural(pending, "search", "searches")} left`;
  const stop: StripAction = { label: "Stop search", run: "stop" };
  const searchMore: StripAction = { label: "Search more", run: "continue" };
  const retry: StripAction = { label: "Retry failed searches", run: "continue" };
  const roundMinutes = minutes === undefined ? (job?.time_budget_seconds != null ? job.time_budget_seconds / 60 : null) : minutes;
  const timedContinue: StripAction = { label: roundMinutes == null ? "Search more" : `Continue for ${plural(roundMinutes, "minute")}`, run: "continue" };
  // Always a recalculation with a higher limit (POST /optimize {expand: true}), never a search continuation: continuing a
  // finished search can still queue transit searches when transit search was set up after the search ran.
  const secondary = !active && result?.optimization_complete === false ? {
    text: "Not all combinations were checked. Better options may exist.",
    tip: "Checks saved combinations continuously until complete, stopped, or the checkpoint limit is reached. Changed inputs start a new calculation. No provider searches.",
    action: { label: "Check more combinations", run: "optimize" } as StripAction,
  } : null;
  const state = (id: string, tone: SearchState["tone"], text: string, actions: StripAction[] = [], extra: Partial<SearchState> = {}): SearchState => ({ id, tone, text, actions, secondary, ...extra });

  if (optimization && ["queued", "running", "stopping"].includes(optimization.status)) {
    const stopping = optimization.status === "stopping";
    return state(stopping ? "stopping-checking" : "checking", "busy", stopping
      ? "Stopping checking. The current operation and saving are finishing…"
      : `Checking combinations continuously · ${whole(optimization.expanded_labels)} explored. Saved options update after each batch.`,
    [{ label: stopping ? "Stopping…" : "Stop checking", run: "stop-optimization", disabled: stopping }], { secondary: null });
  }
  if (!active && !dirty && optimization?.status === "paused" && optimization.pause_reason === "checkpoint") return state("checking-resource", "warn",
    `Checking paused at the ${whole(optimization.checkpoint_limit_bytes / 1024 / 1024)} MiB saved-checkpoint limit. Progress is saved. Adjust inputs or raise the configured limit before continuing.`);
  if (!active && !dirty && optimization?.status === "failed") return state("checking-failed", "error", `Checking stopped: ${optimization.message || "Calculation failed"}. Saved progress is kept.`);
  if (!active && !dirty && optimization?.status === "interrupted") return state("checking-interrupted", "warn", "The server stopped while checking. Saved progress can continue.");

  if (invalid) return { ...state("invalid", "warn", "Fix the marked fields. Options show the last saved trip."), secondary: null };
  if (dirty && result) return { ...state("updating", "busy", "Updating options…"), secondary: null };
  if (applying) return { ...state("applying", "busy", "Applying changes. Waiting for the current operation to finish…"), secondary: null };
  if (active && job?.updating_options) return state("updating-options", "busy", "Updating options with your changes. Previous options are shown until recalculated.", [stop], { secondary: null });
  if (status === "queued") return state("queued", "busy", "Starting the search…", [stop]);
  if (status === "running" && job!.time_budget_seconds != null) {
    const remaining = Math.max(0, Math.ceil((job!.time_budget_seconds - (job!.round_elapsed_seconds ?? 0)) / 60));
    const activity = job!.phase === "optimization" ? "Optimizing collected schedules" : `Searching · ${whole(job!.processed)} done · ${whole(pending)} left`;
    return state("running", "busy", `${activity} · ${remaining ? `${plural(remaining, "minute")} remaining.` : "finishing the current operation…"}`, [stop]);
  }
  if (status === "running") return state("running", "busy", `Searching · ${whole(job!.processed)} done · ${whole(pending)} left. Options update as results arrive.`, [{ ...stop, tip: "Found options and your prices are kept." }], {
    progress: { value: job!.processed, max: job!.processed + pending, text: `${whole(job!.processed)} of ${whole(job!.processed + pending)} searches`, tip: "The total can grow while the search adds follow-up searches." },
  });
  // Before the stale row (C3.1 has it after): the server also marks the result of a trip that was
  // never searched as discovery_required, because no saved search matches the trip yet.
  if (!searched) return state("not-searched", "info", "Not searched yet.", [{ label: "Search transport", run: "search" }]);
  if (stale) return state("stale", "warn", "Your trip changed. Search again to include the changes. Options shown use the earlier search.", [{ label: "Search again", run: "search" }]);
  if (job?.updating_options && ["paused", "cancelled", "interrupted"].includes(status!)) return state(status === "cancelled" ? "stopped" : status!, "info",
    "Changes saved. Continue the round to update options.", [timedContinue], { secondary: null });
  if (status === "paused" && job?.pause_reason === "calculation") return state("paused", "info",
    "Calculation paused at the safety limit. Partial options are shown. Continue to check more combinations.", [timedContinue], { secondary: null });
  if (job?.time_budget_seconds != null && ["paused", "cancelled", "interrupted"].includes(status!) && (pending > 0 || (job.optimization_pending && result?.optimization_complete !== true))) {
    const id = status === "cancelled" ? "stopped" : status!;
    const text = status === "interrupted" ? "The server stopped. Saved progress can continue."
      : `${status === "paused" ? "Round paused" : "Search stopped"}${job.optimization_pending ? (result ? ". Showing the last calculated options." : ". The calculation can continue next round.") : ` · ${left}.`}`;
    return state(id, status === "interrupted" ? "warn" : "info", text, [timedContinue], {
      secondary: null, tip: "Continues unfinished calculations and remaining searches. The current operation and saving may finish after the time allowance.",
    });
  }
  if (status === "paused" && pending > 0) return state("paused", "info", `Search paused · ${left}.`, [searchMore], {
    tip: `The search pauses after each batch of ${job!.batch_budget ? `${job!.batch_budget} ` : ""}new requests to data providers. Search more runs the next batch. Saved results are reused.`,
  });
  if (status === "cancelled" && pending > 0) return state("stopped", "info", `Search stopped · ${left}. Found options are kept.`, [searchMore]);
  if (status === "interrupted") return state("interrupted", "warn", `The search stopped because the server stopped${pending > 0 ? ` · ${left}` : ""}. Found options are kept.`, pending > 0 ? [searchMore] : failed > 0 ? [retry] : []);
  if (status === "failed") {
    const message = [...job!.messages].reverse().find(text => text.startsWith("Planner:"))?.slice("Planner:".length).trim().replace(/\.$/, "");
    return state("failed", "error", `The search failed${message ? `: ${message}` : ""}. Found options are kept.`, [pending > 0 ? searchMore : { label: "Search again", run: "search" }]);
  }
  if (job && !active && pending === 0 && failed > 0) return state("failed-searches", "warn", `Search finished · ${plural(failed, "search", "searches")} failed.`, [retry]);
  if (status === "complete") {
    const coverage = result?.coverage ?? saved?.snapshot?.coverage;
    if (coverage?.discovery_complete !== false) return state("complete", "ok", "Search complete.");
    const tickets = job!.manual_quote_queries ?? 0;
    const parts = [
      ...(failed ? [plural(failed, "failed search", "failed searches")] : []),
      ...(tickets ? [`${plural(tickets, "combined ticket")} to check`] : []),
      ...(coverage.source_gaps?.length ? ["trains and buses not searched"] : []),
    ];
    return state("gaps", "warn", parts.length ? `Search finished with gaps: ${parts.join(", ")}.` : "Search finished with gaps.");
  }
  return state("idle", "info", "");
}

const outcomeWords: [string, string][] = [["success", "found"], ["empty", "no results"], ["failed", "failed"], ["unsupported", "not supported"]];
/**
 * The status strip's Details (C3.1): search counters, the data version and the messages from data
 * providers, only the lines whose data exist. Empty before the first search.
 */
export function searchDetails({ saved, job, result }: {
  saved: Pick<SavedTrip, "snapshot"> | null;
  job: Job | null;
  result: Pick<Result, "snapshot_revision" | "feasible_count" | "expanded_labels" | "coverage"> | null;
}) {
  const lines: string[] = [];
  if (!saved?.snapshot && !job) return { lines, messages: [] };
  if (job) {
    lines.push(`Searches: ${whole(job.processed)} done · ${whole(job.pending)} left · ${whole(job.failed_queries)} failed`);
    if (job.time_budget_seconds != null) {
      const elapsed = job.round_elapsed_seconds ?? 0;
      lines.push(`This round: ${whole(Math.floor(elapsed / 60))} min ${whole(Math.floor(elapsed % 60))} s elapsed · ${formatDuration(job.time_budget_seconds / 60)} allowance`);
    } else if (job.batch_requests !== undefined && job.batch_budget !== undefined) lines.push(`This batch: ${whole(job.batch_requests)} of ${plural(job.batch_budget, "request")}`);
    lines.push(`Requests to data providers: ${whole(job.requests)} · answered from saved results: ${whole(job.cache_hits)}`);
    const outcomes = outcomeWords.filter(([key]) => job.outcomes?.[key]).map(([key, word]) => `${whole(job.outcomes![key])} ${word}`);
    if (outcomes.length) lines.push(`Results: ${outcomes.join(" · ")}`);
    if (job.manual_quote_queries) lines.push(`Combined tickets to check: ${whole(job.manual_quote_queries)}`);
  }
  if (result) lines.push(
    `Data version ${result.snapshot_revision} · ${plural(result.feasible_count, "complete itinerary", "complete itineraries")} checked · ${plural(result.expanded_labels, "combination")} explored`,
    "Scope: best among the schedules and prices collected, not every ticket on sale.",
  );
  const coverage = result?.coverage ?? saved?.snapshot?.coverage;
  const gaps = (coverage?.source_gaps ?? []).map(gap => gap === "Transitous disabled" ? "Transit search is not set up on this server." : gap);
  return { lines, messages: [...new Set([...(job?.messages ?? []), ...(coverage?.messages ?? []), ...gaps])] };
}

/** An error for the error banner (C2), with the action that removes its cause. */
export type AppError = { text: string; action: "retry-save" | "reload" | "search-again" | null };
/**
 * The error banner for a failed action (C2). Errors from api() carry the HTTP status and the request
 * path; for a conflict (409) on a search, the server's text tells the cases apart. `autosave` marks a
 * failed autosave, which offers Retry save.
 */
export function appError(error: unknown, autosave = false): AppError {
  const { message = "", status, path = "" }: Partial<ApiError> = error instanceof Error ? error : {};
  // Starting or continuing a search: an active search, a request that is finishing, or changed search inputs.
  if (status === 409 && path.includes("/searches")) return { text: message, action: message === "Start a new search after changing discovery inputs." ? "search-again" : null };
  // Every other write to the trip checks its revision.
  if (status === 409 && path.startsWith("/trips/")) return { text: "This trip changed elsewhere, for example in another tab or after a price rule change. Reload it to continue.", action: "reload" };
  const text = message || "Something went wrong. Try again.";
  return autosave ? { text: `Changes not saved: ${text}`, action: "retry-save" } : { text, action: null };
}

const bundleStatuses: Record<string, string> = { requires_manual_quote: "Check the price yourself", success: "Quote found", empty: "No results", failed: "Search failed", unsupported: "Not supported" };
/** Plain text for a combined-ticket search status. Other values show as they are. */
export function bundleStatusLabel(status: string) {
  return bundleStatuses[status] ?? status;
}

/** Where a price comes from (E9.4 source labels). */
export function sourceLabel(offer: Pick<Offer, "id" | "source" | "label">) {
  if (offer.source === "provider") {
    const label = offer.label.replace(/^Stale quote: /, "");
    const mapped = label.startsWith("Google Flights") ? "Google Flights" : label === "GTFS fare products for party" ? "Transit fare" : label;
    return label === offer.label ? mapped : `${mapped} · older quote`;
  }
  if (offer.source === "user") {
    if (offer.label.startsWith("Shared estimate:")) return "Your group price";
    if (offer.label === "Manually entered whole-ticket party fare") return "Your combined ticket price";
    return offer.id.startsWith("positioning-fare:") ? "Your journey price" : "Your price";
  }
  if (offer.source === "rule") {
    if (offer.label === "Trip airport transfer estimate") return "Your airport transfer price";
    if (offer.label === "Configured driving cost") return "Driving cost (Cars settings)";
    return offer.id.startsWith("charge:") && offer.label.startsWith("Rental") ? "Rental settings" : `Rule: ${offer.label}`;
  }
  return "Not priced";
}

const railModes = new Set(["rail", "highspeed_rail", "long_distance", "night_rail", "regional_fast_rail", "regional_rail", "suburban"]);
const transitModes = new Set(["bus", "coach", "subway", "tram"]);
/**
 * The text of one step in a journey (E9.3), without its start time: the caller writes that first, in
 * segment.from_timezone or else the journey's origin. Times inside the text use the segment's zones.
 * `warning` marks steps that make a journey unusable.
 */
export function stepLabel(segment: Segment, movement: Pick<Movement, "source">) {
  const source = segment.source ?? "";
  const minutes = segment.duration_minutes ?? (segment.departure && segment.arrival ? (Date.parse(segment.arrival) - Date.parse(segment.departure)) / 60000 : null);
  const duration = minutes === null ? "" : ` · ${formatDuration(minutes)}`;
  const at = (value: string | null, zone: string | null | undefined) => value ? ` ${formatLocal(value, zone ?? segment.from_timezone ?? "UTC", "time")}` : "";
  const times = `${segment.from_name}${at(segment.departure, segment.from_timezone)} → ${segment.to_name}${at(segment.arrival, segment.to_timezone)}`;
  // Airport access and egress keep the mode "transfer" until a trip estimate sets one; the default price is a taxi.
  const mode = segment.mode === "transfer" ? "Taxi" : railModes.has(segment.mode) ? "Train" : modeLabel(segment.mode);
  const service = segment.service ? ` ${segment.service}` : "";
  const step = (text: string, warning = false) => ({ text, warning });
  if (/^(User-estimated airport|Airport) (access|egress)$/.test(source)) return step(`${mode} to ${segment.to_name}${duration}${segment.assumed ? " (estimate)" : ""}`);
  if (source === "Flight readiness buffer") return step(`At the airport before the flight${duration}`);
  if (source === "Arrival buffer") return step(`After landing${duration}`);
  if (source === "Scheduled connection") return step(`Connection at ${segment.from_name}${duration}`);
  if (source === "User-verified airport transfer") return step(`${mode} from ${segment.from_name} to ${segment.to_name}${duration} (your airport change)`);
  if (source === "Layover after airport transfer") return step(`Wait at ${segment.to_name}${duration}`);
  if (source === "Airport change needs confirmation") return step(`Airport change ${segment.from_name} → ${segment.to_name} is not confirmed`, true);
  if (source === "Airport transfer exceeds available layover") return step("Your airport change takes longer than the layover", true);
  // Before the flight row: your journey can be a flight.
  if (source === "User-supplied positioning" || movement.source === "User-supplied positioning") return step(`${mode}${service} · ${times} (your journey)`);
  if (segment.mode === "flight") return step(`${[segment.operator, segment.service].filter(Boolean).join(" ")} · ${times}`);
  if (segment.mode === "walk" || segment.mode === "foot") return step(`Walk to ${segment.to_name}${duration}`);
  if (railModes.has(segment.mode) || transitModes.has(segment.mode)) return step([`${mode}${service}`, segment.operator, times].filter(Boolean).join(" · "));
  return step(`${mode}: ${times}`);
}

/** A "Check before booking" note. `action: "transfer-times"` offers Set transfer times (Missing info › Airport transfers). */
export type AssumptionNote = { text: string; action: "transfer-times" | null };
function assumptionText(assumption: string, pair: string) {
  if (assumption === "User supplied connectivity and timing" || assumption === "User-defined travel time and connectivity") return `Your connection ${pair} is assumed to exist.`;
  const copied = /^Estimated timetable based on (\d{4}-\d{2}-\d{2})/.exec(assumption);
  if (copied) return `${pair} uses an estimated timetable copied from ${dateRange(copied[1], copied[1])}. Check the real timetable.`;
  if (assumption.startsWith("Estimated timetable: provider repeated service")) return `${pair} uses an estimated timetable (extended provider calendar). Check the real timetable.`;
  const stations = /^Station search within ([\d.]+) km/.exec(assumption);
  if (stations) return `${pair} uses stations up to ${stations[1]} km away. Check how you get to them.`;
  if (assumption.startsWith("Driving time estimate;")) return "Driving times are estimates without traffic. Rental cars are not checked for availability.";
  if (assumption.startsWith("User supplied city-to-city schedule;")) return `Your journey ${pair} uses the times you entered.`;
  return assumption;
}
/** The option's assumptions in plain words (E9.6), each once. Airport transfer estimates merge into one note per duration. */
export function assumptionNotes(route: Pick<Route, "movements" | "purchases">, placeName: (id: string) => string): AssumptionNote[] {
  const notes = new Map<string, AssumptionNote>();
  const transferCities = new Map<string, Set<string>>();
  for (const movement of route.movements) {
    const pair = `${placeName(movement.from_id)} → ${placeName(movement.to_id)}`;
    for (const assumption of movement.assumptions) {
      const transfer = /^(.+): (\d+) minute airport transfer assumption; road routing unavailable$/.exec(assumption);
      if (transfer) {
        const key = `transfer:${transfer[2]}`;
        const cities = transferCities.get(key) ?? new Set<string>();
        transferCities.set(key, cities.add(transfer[1]));
        // Map.set keeps the note at the position of its first city.
        notes.set(key, { text: `Airport transfer times are estimates (${formatDuration(Number(transfer[2]))} each, no road data): ${[...cities].join(", ")}.`, action: "transfer-times" });
        continue;
      }
      const text = assumptionText(assumption, pair);
      if (!notes.has(text)) notes.set(text, { text, action: null });
    }
  }
  const estimates = route.purchases.filter(isEstimate).length;
  if (estimates) notes.set("estimates", { text: `${estimates === 1 ? "1 price is an estimate" : `${estimates} prices are estimates`} (your prices, rules or older quotes).`, action: null });
  return [...notes.values()];
}

// ---------------------------------------------------------------- itinerary

/** One row of Day by day (E9.3): a journey, a stay in a city to visit, or time at a place that does not count. */
export type DayEntry =
  | { kind: "journey"; movement: Movement }
  /** `minimum`: the city's minimum stay, on its first visit only (null when it has none). */
  | { kind: "stay"; stay: Route["stays"][number]; minimum: number | null }
  | { kind: "gap"; placeId: string; minutes: number };
/**
 * The option as one chronological list (E9.3): its journeys, a stay before the journey that ends it, and, between two
 * journeys with no stay, the time at that place when it is 30 min or more. `minStays`: minimum hours by city to visit.
 */
export function dayByDay(route: Pick<Route, "movements" | "stays">, minStays: Record<string, number>): DayEntry[] {
  const stays = [...route.stays].sort((a, b) => Date.parse(a.arrival) - Date.parse(b.arrival));
  const visited = new Set<string>();
  const entries: DayEntry[] = [];
  let next = 0;
  // Adds the stays that start by `until`; true when it added one.
  const addStays = (until: number) => {
    const first = next;
    for (; next < stays.length && Date.parse(stays[next].arrival) <= until; next++) {
      const stay = stays[next];
      entries.push({ kind: "stay", stay, minimum: !visited.has(stay.place_id) && minStays[stay.place_id] ? minStays[stay.place_id] : null });
      visited.add(stay.place_id);
    }
    return next > first;
  };
  route.movements.forEach((movement, index) => {
    const departure = movement.departure ? Date.parse(movement.departure) : null;
    const previous = route.movements[index - 1];
    if (departure !== null && !addStays(departure) && previous?.arrival) {
      const minutes = (departure - Date.parse(previous.arrival)) / 60000;
      if (minutes >= 30) entries.push({ kind: "gap", placeId: movement.from_id, minutes });
    }
    entries.push({ kind: "journey", movement });
  });
  addStays(Infinity);
  return entries;
}

/** The times of a journey, each in its place's time: "Fri 4 Dec · 08:00 → 18:54", with the arrival date when it differs. */
export function journeyWhen(movement: Pick<Movement, "departure" | "arrival">, fromZone: string, toZone: string) {
  if (!movement.departure || !movement.arrival) return "";
  const date = formatLocal(movement.departure, fromZone, "date"), arrivalDate = formatLocal(movement.arrival, toZone, "date");
  return `${date} · ${formatLocal(movement.departure, fromZone, "time")} → ${arrivalDate === date ? "" : `${arrivalDate} `}${formatLocal(movement.arrival, toZone, "time")}`;
}

// Airport transfers and airport changes are steps of a journey, not its service.
const transferSources = /^(User-estimated airport|Airport) (access|egress)$|^User-verified airport transfer$/;
/** The operator and service of a journey with one main service ("AirAsia X D7530"); null with several or none. */
export function mainService(movement: Pick<Movement, "segments">) {
  const main = movement.segments.filter(segment => !passiveModes.has(segment.mode) && !transferSources.test(segment.source ?? ""));
  return main.length === 1 ? [main[0].operator, main[0].service].filter(Boolean).join(" ") || null : null;
}

const journeySources: Record<string, string> = { "Google Flights / fast-flights": "Google Flights", "Transitous / MOTIS": "Transitous", OSRM: "Road estimate", "User-defined connection": "Your connection", "User-supplied positioning": "Your journey" };
/**
 * The source line of a journey (E9.3): "Google Flights · 1 change · 1,234 km". Journeys without scheduled steps
 * (road estimates, your connections) leave out the changes; the distance shows when it is known.
 */
export function journeySource(movement: Pick<Movement, "source" | "transfers" | "distance_km" | "segments">) {
  return [
    journeySources[movement.source] ?? movement.source,
    ...(movement.segments.length ? [plural(movement.transfers, "change")] : []),
    ...(movement.distance_km !== null ? [`${whole(movement.distance_km)} km`] : []),
  ].join(" · ");
}

/** The chips of a journey row (E9.3): estimated timetable, your connection or journey, and its items that are not priced. */
export function journeyChips(route: Pick<Route, "purchases">, movement: Movement, rates: Record<string, number>): OptionChip[] {
  const items = new Set([movement.id, ...movement.charges.map(charge => charge.id)]);
  const unpriced = route.purchases.filter(offer => items.has(offer.movement_ids[0]) && !isPriced(offer, rates)).length;
  return [
    ...(movement.schedule_estimated ? [{ text: "Estimated timetable", tone: "warn" as const }] : []),
    ...(movement.source === "User-defined connection" ? [{ text: "Your connection", tone: "plain" as const }] : []),
    ...(movement.source === "User-supplied positioning" ? [{ text: "Your journey", tone: "plain" as const }] : []),
    ...(unpriced ? [{ text: `${unpriced} not priced`, tone: "warn" as const }] : []),
  ];
}

// ---------------------------------------------------------------- tickets and prices

const ticketKinds: Record<string, string> = { "round-trip": "Round trip", "multi-city": "Multi-city" };
/** A combined ticket kind in words ("round-trip" → "Round trip"). Other values show as they are. */
export function ticketKindLabel(kind: string) {
  return ticketKinds[kind] ?? kind;
}

/** The departure a ticket shows: the first flight's, else the journey's (door to door). */
function ticketDeparture(movement: Pick<Movement, "segments" | "departure">) {
  return movement.segments.find(segment => segment.mode === "flight" && segment.departure)?.departure ?? movement.departure;
}

/** A journey as its ticket names it, with the local departure date: "Kuala Lumpur → Busan · 4 Dec". */
export function ticketJourney(movement: Pick<Movement, "from_id" | "to_id" | "segments" | "departure">, placeName: (id: string) => string, zoneOf: (id: string) => string) {
  const departure = ticketDeparture(movement);
  return `${placeName(movement.from_id)} → ${placeName(movement.to_id)}${departure ? ` · ${formatLocal(departure, zoneOf(movement.from_id), "day")}` : ""}`;
}

/** The amount of one purchase (E9.4): "RM 2,180", "RM 210 – 250", "RM 900 or more", "JPY 12,000 · needs an exchange rate" or "Not priced". */
export function purchaseAmount(offer: Pick<Offer, "low" | "high" | "currency">, rates: Record<string, number>) {
  const text = offerAmount(offer);
  return offer.low !== null && !hasRate(offer.currency, rates) ? `${text} · needs an exchange rate` : text;
}

/**
 * One row of Tickets and prices (E9.4). `kind`: a journey's ticket, an airport access or egress charge ("transfer"),
 * an airport change, another charge (rental) or a combined ticket. `componentId` is the id that Set price saves on
 * (the template id for a journey, the charge id for a charge); null when the row has no Set price. `removable`: a price
 * the user set here, which Remove my price deletes.
 */
export type TicketRow = {
  key: string; kind: "journey" | "transfer" | "change" | "charge" | "combined"; label: string;
  offer: Offer; movement: Movement | null; charge: Charge | null; flights: Movement[];
  amount: string; source: string | null; priced: boolean; componentId: string | null; removable: boolean;
};
const chargeRank = (charge: Charge) => charge.kind === "Airport access" ? 1 : charge.kind === "Airport egress" ? 2 : charge.kind.startsWith("Airport transfer ") ? 3 : 4;
/**
 * The option's purchases in itinerary order (E9.4): each journey's ticket, then its access, egress and airport-change
 * charges, then extra charges (rental). A combined ticket takes the place of its first flight. Purchases name route ids;
 * combined tickets can also name template ids.
 */
export function ticketRows(route: Pick<Route, "movements" | "purchases" | "extra_charges">, rates: Record<string, number>, placeName: (id: string) => string, zoneOf: (id: string) => string): TicketRow[] {
  type Slot = { order: number; movement: Movement | null; charge: Charge | null };
  const slots = new Map<string, Slot>();
  route.movements.forEach((movement, index) => {
    const slot = { order: index * 10, movement, charge: null };
    slots.set(movement.id, slot);
    if (movement.template_id && !slots.has(movement.template_id)) slots.set(movement.template_id, slot);
    for (const charge of movement.charges) slots.set(charge.id, { order: index * 10 + chargeRank(charge), movement, charge });
  });
  for (const charge of route.extra_charges) slots.set(charge.id, { order: route.movements.length * 10, movement: null, charge });

  const rows = route.purchases.map((offer, index) => {
    const covered = offer.movement_ids.map(id => slots.get(id));
    const order = Math.min(...covered.map(slot => slot?.order ?? Infinity));
    const base = { key: offer.id, offer, movement: null, charge: null, flights: [], amount: purchaseAmount(offer, rates),
      source: offer.source === "unknown" ? null : sourceLabel(offer), priced: isPriced(offer, rates), componentId: null, removable: offer.source === "user" };
    let row: TicketRow;
    if (offer.movement_ids.length > 1) {
      const flights = covered.flatMap(slot => slot?.movement && !slot.charge ? [slot.movement] : []).sort((a, b) => route.movements.indexOf(a) - route.movements.indexOf(b));
      row = { ...base, kind: "combined", flights, label: `Combined ticket · ${ticketKindLabel(offer.kind)} · ${plural(offer.movement_ids.length, "flight")}` };
    } else {
      const { movement = null, charge = null } = covered[0] ?? {};
      if (charge && charge.kind.startsWith("Airport transfer ")) {
        // An airport change is priced in Missing info › Airport changes.
        row = { ...base, kind: "change", movement, charge, removable: false, label: `${charge.kind.replace(/^Airport transfer /, "Airport change ")} · ${modeLabel(charge.mode)}` };
      } else if (charge && (charge.kind === "Airport access" || charge.kind === "Airport egress")) {
        row = { ...base, kind: "transfer", movement, charge, componentId: charge.id,
          label: `${modeLabel(charge.mode)} ${placeName(charge.from_id ?? movement?.from_id ?? "")} → ${placeName(charge.to_id ?? movement?.to_id ?? "")}` };
      } else if (charge) {
        const rental = /^Rental: (\d+) day\(s\), (.+)$/.exec(charge.kind);
        row = { ...base, kind: "charge", movement, charge, componentId: charge.id, label: rental ? `Rental car · ${plural(Number(rental[1]), "day")}, ${rental[2]}` : charge.kind };
      } else if (movement) {
        const service = mainService(movement);
        // A price for your journey comes from Trip settings › your journeys, not from the trip's prices.
        row = { ...base, kind: "journey", movement, componentId: movement.template_id ?? movement.id, removable: base.removable && !offer.id.startsWith("positioning-fare:"),
          label: `${modeLabel(movement.mode)} ${ticketJourney(movement, placeName, zoneOf)}${service ? ` · ${service}` : ""}` };
      } else {
        row = { ...base, kind: "charge", label: offer.label || offer.kind };
      }
    }
    return { row, order, index };
  });
  return rows.sort((a, b) => a.order - b.order || a.index - b.index).map(item => item.row);
}

/** A combined-ticket search (E9.5): "Round trip: Kuala Lumpur → Seoul (4 Dec) · Seoul → Kuala Lumpur (14 Dec)". Leg dates are local dates. */
export function quoteLinkText(link: { kind: string; legs: { from_id: string; to_id: string; date: string }[] }, placeName: (id: string) => string) {
  const day = (date: string) => Number.isNaN(Date.parse(`${date}T00:00:00Z`)) ? date : formatLocal(`${date}T00:00:00Z`, "UTC", "day");
  return `${ticketKindLabel(link.kind)}: ${link.legs.map(leg => `${placeName(leg.from_id)} → ${placeName(leg.to_id)} (${day(leg.date)})`).join(" · ")}`;
}

/**
 * Errors of a typed price (E9.4, E9.5), by field: `low` is required and 0 or more, `high` (blank for none) at least `low`,
 * and the currency 3 letters. Empty when the price is valid.
 */
export function priceInputErrors(low: string, high: string, currency: string): Partial<Record<"low" | "high" | "currency", string>> {
  const errors: Partial<Record<"low" | "high" | "currency", string>> = {};
  const lowest = Number(low), highest = Number(high);
  if (low.trim() === "" || !Number.isFinite(lowest) || lowest < 0) errors.low = "Enter a price of 0 or more.";
  else if (high.trim() !== "" && (!Number.isFinite(highest) || highest < lowest)) errors.high = "The highest price must be at least the lowest.";
  if (!/^[A-Za-z]{3}$/.test(currency.trim())) errors.currency = "Enter a 3-letter currency code.";
  return errors;
}

// ---------------------------------------------------------------- trip

const placeNames = (places: { name: string }[], home: { name: string } | null) => (places.length ? places : home ? [home] : []).map(place => place.name).join(" or ") || "home";

/** The two summary lines of a trip (C3): its places, then dates, departure times, adults, budget and transport. */
export function tripSummary(draft: TripDraft) {
  const visits = draft.visits.map(visit => visit.min_stay_hours > 0 ? `${visit.place.name} ${visit.min_stay_hours} h+` : visit.place.name).join(", ");
  const route = `${placeNames(draft.departures, draft.home)} → ${visits}${draft.visits.length > 1 ? draft.ordered_visits ? " (in this order)" : " (any order)" : ""} → ${placeNames(draft.arrivals, draft.home)}`;
  const details = [
    `${dateRange(draft.start_date, draft.end_date)} (${draft.date_mode === "fixed" ? "exact dates" : "any days"})`,
    `leave ${hhmm(draft.departure_start)}–${hhmm(draft.departure_end)}`,
    plural(draft.adults, "adult"),
    draft.budget_myr === null ? "no budget" : `budget ${moneyShort(draft.budget_myr)}`,
    modes.filter(mode => draft.modes.includes(mode)).map(modeLabel).join(", "),
  ].join(" · ");
  return { route, details };
}

/** One More settings group: its summary line, and its non-default parts for the More settings summary (none = all default). */
export type SettingsSummary = { summary: string; changes: string[] };
/** Summary lines of the More settings groups (G). `batchSize` is the requests per search batch, kept outside the trip. */
export function settingsSummaries(draft: TripDraft, batchSize: number, minutes: number | null = null): Record<"places" | "departures" | "buffers" | "appointments" | "cars" | "prices" | "timetables" | "searchSize", SettingsSummary> {
  const defaults = blankTrip();
  // Each part is [text, changed from the default].
  const group = (parts: [string, boolean][], fallback?: string): SettingsSummary => {
    const changes = parts.filter(([, changed]) => changed).map(([text]) => capitalize(text));
    return { summary: fallback && !changes.length ? fallback : capitalize(parts.map(([text]) => text).join(" · ")), changes };
  };
  const homeOnly = (places: { id: string }[]) => !places.length || (places.length === 1 && places[0].id === draft.home?.id);
  const journeys = draft.positioning_services?.length ?? 0;
  const places = group([
    [`Start: ${placeNames(draft.departures, draft.home)}`, !homeOnly(draft.departures)],
    [`End: ${placeNames(draft.arrivals, draft.home)}`, !homeOnly(draft.arrivals)],
    ...(draft.home_departure_earliest ? [[`leave home after ${hhmm(draft.home_departure_earliest)}`, true] as [string, boolean]] : []),
    ...(draft.home_arrival_latest ? [[`be home by ${hhmm(draft.home_arrival_latest)}`, true] as [string, boolean]] : []),
    ...(journeys ? [[plural(journeys, "journey"), true] as [string, boolean]] : []),
  ], "Home only");

  const leave = (trip: TripDraft) => `${hhmm(trip.departure_start)}–${hhmm(trip.departure_end)}`;
  const transfers = draft.max_transfers === null ? "any number of changes" : draft.max_transfers === 0 ? "no changes" : `max ${plural(draft.max_transfers, "change")}`;
  const departures = group([
    [`leave ${leave(draft)}`, leave(draft) !== leave(defaults)],
    [transfers, draft.max_transfers !== defaults.max_transfers],
    [draft.allow_overnight ? "overnight allowed" : "no overnight journeys", draft.allow_overnight !== defaults.allow_overnight],
  ]);

  const timing = draft.timing;
  const changed = (...keys: (keyof TripDraft["timing"])[]) => keys.some(key => timing[key] !== defaults.timing[key]);
  const buffers = group([
    [`flights ${timing.flight_before_minutes} + ${timing.flight_after_minutes} min`, changed("flight_before_minutes", "flight_after_minutes")],
    [`trains and buses ${timing.transit_before_minutes} + ${timing.transit_after_minutes} min`, changed("transit_before_minutes", "transit_after_minutes")],
    [`changes ${timing.connection_minutes} min`, changed("connection_minutes")],
    [timing.airport_transfer_fallback_minutes === null ? "no default airport transfer time" : `airport transfer ${timing.airport_transfer_fallback_minutes} min`, changed("airport_transfer_fallback_minutes")],
  ]);

  const first = draft.commitments[0];
  let appointments: SettingsSummary = { summary: "None", changes: [] };
  if (first) {
    const place = draft.visits.find(visit => visit.place.id === first.place_id)?.place;
    const zone = place?.timezone ?? "UTC";
    const sameDay = formatLocal(first.start, zone, "date") === formatLocal(first.end, zone, "date");
    const count = draft.commitments.length;
    appointments = {
      summary: `${count}: ${place?.name ?? first.place_id} ${formatLocal(first.start, zone)}–${formatLocal(first.end, zone, sameDay ? "time" : "datetime")}${count > 1 ? ", …" : ""}`,
      changes: [plural(count, "appointment")],
    };
  }

  const carText = [draft.cars.own_enabled ? "own car" : "", draft.cars.rental_enabled ? "rental car" : ""].filter(Boolean).join(", ");
  const cars = group([[carText || "not used", !!carText]]);

  const currencies = ["MYR", ...Object.keys(draft.exchange_rates).filter(code => code !== "MYR")];
  const prices = group([
    [currencies.length > 1 ? currencies.join(", ") : "MYR only", currencies.length > 1],
    ...(draft.exclude_unpriced_flights ? [["flights without a price skipped", true] as [string, boolean]] : []),
  ]);

  const rail = draft.rail_fallback;
  const timetables = rail?.enabled
    ? { summary: `On · stations within ${rail.station_radius_km} km · up to ${rail.max_shift_days} days`, changes: ["Estimated train timetables"] }
    : { summary: "Off", changes: [] };

  const searchSize = minutes === null ? group([[`${plural(batchSize, "request")} per batch`, batchSize !== defaultBatchSize]])
    : group([[`${plural(minutes, "minute")} per round`, true]]);
  return { places, departures, buffers, appointments, cars, prices, timetables, searchSize };
}

/**
 * Errors that keep the trip from saving or searching, keyed by field. The keys are in the order the
 * settings footer reports them, so the first value is the footer's reason.
 */
export function validateDraft(draft: TripDraft): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!draft.home) errors.home = "Add your home city.";
  if (!draft.visits.length) errors.visits = "Add at least one city to visit.";
  if (!draft.modes.length) errors.modes = "Choose at least one type of transport.";
  if (!draft.start_date || !draft.end_date) errors.dates = "Choose a start date and an end date.";
  else if (draft.end_date < draft.start_date) errors.dates = "The end date must be on or after the start date.";
  else {
    // A date input can hold a 5-digit year, which is not a valid date.
    const start = dayParts(draft.start_date), end = dayParts(draft.end_date);
    if (!start || !end || (end.time - start.time) / 86_400_000 > 365) errors.dates = "Choose up to 365 days.";
  }
  if (!draft.departure_start || !draft.departure_end) errors.departureWindow = "Enter both departure times.";
  else if (hhmm(draft.departure_end) <= hhmm(draft.departure_start)) errors.departureWindow = "The latest departure must be after the earliest.";
  if (draft.start_date === draft.end_date && draft.home_departure_earliest && draft.home_arrival_latest && hhmm(draft.home_arrival_latest) <= hhmm(draft.home_departure_earliest)) errors.homeTimes = "Be home after you leave home.";
  if (draft.visits.some(visit => !(Number.isFinite(visit.min_stay_hours) && visit.min_stay_hours > 0 && visit.min_stay_hours <= 8760))) errors.stays = "Enter a minimum stay greater than 0 and up to 8,760 hours for each city.";
  if (!Number.isInteger(draft.adults) || draft.adults < 1 || draft.adults > 9) errors.adults = "Enter 1 to 9 adults.";
  if (draft.budget_myr !== null && !(draft.budget_myr >= 0)) errors.budget = "Enter 0 or more, or leave it blank.";
  return errors;
}

// A trip date (YYYY-MM-DD) as day parts, or null for a cleared or invalid date.
function dayParts(value: string) {
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return null;
  const parts = Object.fromEntries(dateFormat("UTC", "year").formatToParts(date).map(part => [part.type, part.value]));
  return { time: date.getTime(), day: parts.day, month: parts.month, year: parts.year };
}

/** The helper line under the date mode (C4): "Leave home on 4 Dec. Be back home on 14 Dec." or "Leave and come back on any days from 4 to 14 Dec." */
export function dateModeText(draft: Pick<TripDraft, "start_date" | "end_date" | "date_mode">) {
  const start = dayParts(draft.start_date), end = dayParts(draft.end_date);
  if (!start || !end) return "";
  if (draft.date_mode === "fixed") return `Leave home on ${start.day} ${start.month}. Be back home on ${end.day} ${end.month}.`;
  const from = start.month === end.month && start.year === end.year ? start.day : `${start.day} ${start.month}`;
  return `Leave and come back on any days from ${from} to ${end.day} ${end.month}.`;
}

/** The notice when the minimum stays need more hours than the trip dates have (C4). Null when they fit or the dates are invalid. */
export function staySumWarning(draft: Pick<TripDraft, "start_date" | "end_date" | "visits">) {
  const start = dayParts(draft.start_date), end = dayParts(draft.end_date);
  if (!start || !end || end.time < start.time) return null;
  const sum = draft.visits.reduce((total, visit) => total + visit.min_stay_hours, 0);
  const allowed = ((end.time - start.time) / 86_400_000 + 1) * 24;
  return sum > allowed ? `Minimum stays add up to ${amount(sum)} h, but these dates allow at most ${whole(allowed)} h.` : null;
}

/**
 * The notice next to Adults (A2 row 12, C4). Your prices and airport transfer prices are saved for the
 * number of adults at that time, and the server uses only those for the trip's number of adults.
 */
export function partySizeNotice(saved: Pick<SavedTrip, "offers" | "airport_transfer_estimates"> | null, adults: number) {
  const others = [...(saved?.offers ?? []).filter(offer => offer.source === "user"), ...(saved?.airport_transfer_estimates ?? [])]
    .flatMap(item => item.adults != null && item.adults !== adults ? [item.adults] : []);
  if (!others.length) return null;
  const counts = [...new Set(others)].sort((a, b) => a - b);
  const one = others.length === 1;
  return `${plural(others.length, "price")} you entered ${one ? "is" : "are"} for ${counts.join(" or ")} ${counts.length === 1 && counts[0] === 1 ? "adult" : "adults"}. ${one ? "It is" : "They are"} not used for ${plural(adults, "adult")}.`;
}

/** A button of the trip settings footer: "save" saves without searching, "search" starts a new search. */
export type FooterButton = { label: string; run: "save" | "search"; variant: "default" | "secondary" | "ghost"; tip?: string };
export type FooterState = { text: string; buttons: FooterButton[]; disabled: boolean };
/** The sticky footer of the trip settings (C4). `errors` is validateDraft(); its first error is the reason the buttons are disabled. */
export function settingsFooter({ errors, isNew, searched, active, stale }: {
  errors: Record<string, string>; isNew: boolean; searched: boolean; active: boolean; stale: boolean;
}): FooterState {
  const ready = "Ready. The search can take a few minutes.";
  const search: FooterButton = { label: "Search transport", run: "search", variant: "default" };
  const restart: FooterButton = { label: "Start a new search", run: "search", variant: "secondary" };
  const state: FooterState = active ? { text: "Searching…", buttons: [restart], disabled: true }
    : isNew ? { text: ready, buttons: [{ label: "Save without searching", run: "save", variant: "ghost" }, search], disabled: false }
    // Before the stale check, as in searchState: the result of a trip that was never searched is marked discovery_required.
    : !searched ? { text: ready, buttons: [search], disabled: false }
    : stale ? { text: "Your changes need a new search.", buttons: [{ ...search, label: "Search again" }], disabled: false }
    : { text: "", buttons: [{ ...restart, tip: "Starts the search again from the beginning. Saved provider responses are reused." }], disabled: false };
  const first = Object.values(errors)[0];
  return first ? { ...state, text: first, disabled: true } : state;
}

// ---------------------------------------------------------------- refinement

export type AirportChangeRow = {
  from_airport: string; to_airport: string; from_name: string; to_name: string;
  journey_count: number; unresolved_journey_count: number; required: boolean;
  mode: AirportTransferMode | ""; duration_minutes: number | null; fare_amount: number | null; currency: string;
};

// The same list as required_airport_connections in planner_discovery.py, without its sort.
function requiredAirportConnections(movements: Movement[]): AirportConnectionRequirement[] {
  const pairs = new Map<string, AirportConnectionRequirement>();
  for (const movement of movements) {
    if (movement.source !== "Google Flights / fast-flights") continue;
    const flights = movement.segments.filter(segment => segment.mode === "flight");
    flights.slice(1).forEach((following, i) => {
      const previous = flights[i];
      const from_airport = previous.to_id, to_airport = following.from_id;
      if (!from_airport || !to_airport || from_airport === to_airport) return;
      const key = `${from_airport}>${to_airport}`;
      const pair = pairs.get(key) ?? { from_airport, to_airport, from_name: previous.to_name ?? from_airport, to_name: following.from_name ?? to_airport, journey_count: 0, unresolved_journey_count: 0 };
      pairs.set(key, pair);
      pair.journey_count++;
      if (movement.assumptions.some(text => text.startsWith(`Airport change ${from_airport} → ${to_airport}:`) || text.startsWith(`Airport connection ${from_airport} → ${to_airport} `))) pair.unresolved_journey_count++;
    });
  }
  return [...pairs.values()];
}

/**
 * One row per directed airport pair that journeys need or that the trip has saved, sorted by pair.
 * The requirements come from the result's coverage first: after a change of search inputs, the PUT
 * record's snapshot can be a shared search graph without the trip's airport changes. A result reused
 * during a search has no requirements in its coverage.
 */
export function airportChangeRows(saved: Pick<SavedTrip, "snapshot" | "airport_connections" | "airport_connections_required">, coverage?: Pick<Coverage, "airport_connections_required">): AirportChangeRow[] {
  const requirements = coverage?.airport_connections_required ?? saved.airport_connections_required ?? requiredAirportConnections(saved.snapshot?.movements ?? []);
  const requiredByPair = new Map(requirements.map(item => [`${item.from_airport}>${item.to_airport}`, item]));
  const connectionByPair = new Map((saved.airport_connections ?? []).map(item => [`${item.from_airport}>${item.to_airport}`, item]));
  const keys = [...new Set([...requiredByPair.keys(), ...connectionByPair.keys()])].sort();
  return keys.map(key => {
    const requirement = requiredByPair.get(key);
    const connection = connectionByPair.get(key);
    const [from_airport, to_airport] = key.split(">");
    return {
      from_airport, to_airport,
      from_name: requirement?.from_name ?? from_airport,
      to_name: requirement?.to_name ?? to_airport,
      journey_count: requirement?.journey_count ?? 0,
      unresolved_journey_count: requirement?.unresolved_journey_count ?? 0,
      required: !!requirement,
      mode: connection?.mode ?? "",
      duration_minutes: connection?.duration_minutes ?? null,
      fare_amount: connection?.fare_amount ?? null,
      currency: connection?.currency ?? "MYR",
    };
  });
}

const unresolvedAccessText = ": airport access time is unresolved";
/** Journeys that can't be used because an airport transfer time is unknown (no road time and no default time). */
export function unresolvedAccessJourneys<T extends { assumptions: string[] }>(movements: T[]): T[] {
  return movements.filter(movement => movement.assumptions.some(text => text.includes("airport access time is unresolved")));
}
// The server writes "{city}: airport access time is unresolved; …".
function unresolvedAccessCities(movements: { assumptions: string[] }[]) {
  return [...new Set(movements.flatMap(movement => movement.assumptions.filter(text => text.includes(unresolvedAccessText)).map(text => text.slice(0, text.indexOf(unresolvedAccessText)))))];
}

/** Connections the user added to the trip. */
export function assumedConnections(saved: Pick<SavedTrip, "snapshot" | "assumed_connections">): Movement[] {
  return saved.assumed_connections ?? (saved.snapshot?.movements ?? []).filter(movement => movement.source === "User-defined connection");
}

/** Pairs of cities to visit with no journey in either direction. Empty before the first search. */
export function cityGaps(saved: Pick<SavedTrip, "spec" | "snapshot" | "city_connection_gaps">): { from_id: string; to_id: string }[] {
  if (saved.city_connection_gaps) return saved.city_connection_gaps;
  if (!saved.snapshot) return [];
  const pairs = new Set(saved.snapshot.movements.map(movement => `${movement.from_id}\n${movement.to_id}`));
  const ids = saved.spec.visits.map(visit => visit.place.id);
  return ids.flatMap((a, i) => ids.slice(i + 1)
    .filter(b => !pairs.has(`${a}\n${b}`) && !pairs.has(`${b}\n${a}`))
    .map(b => ({ from_id: a, to_id: b })));
}

/** One charge of an airport transfer direction in the current results, with the purchase that prices it. */
export type TransferJourney = { charge: Charge; movement: Movement; offer: Offer | undefined };
export type TransferDirection = AirportTransferRow & {
  /** "missing": some option has no price for it; "priced": used and priced; "unused": no option uses it. */
  state: "missing" | "priced" | "unused";
  /** Options that use this direction, and options in which it has no price. */
  options: number; missing: number;
  /** Its charges in the current results, once each. */
  journeys: TransferJourney[];
  /** Journeys priced by a price the user set for that journey. */
  ownPrices: number;
  /** Currencies of prices in options that can't be used without an exchange rate. */
  rateCurrencies: string[];
  /** "Price missing · in 9 options", "Needs an exchange rate · in 9 options", "RM 130 for 2 adults" or "Not used now". */
  status: string;
};
/**
 * One entry per airport transfer row (F2 Airport transfers), with its use in `routes` (best, weaker
 * and over-budget options). Order: missing (most options first), then priced, then unused; ties keep
 * the server's label order.
 */
export function transferDirections(rows: AirportTransferRow[], routes: Route[], adults: number, rates: Record<string, number>): TransferDirection[] {
  const uses = new Map(rows.map(row => [`${row.from_id}>${row.to_id}`, { journeys: new Map<string, TransferJourney>(), used: new Set<string>(), missing: new Set<string>(), rates: new Set<string>(), unpriced: false }]));
  for (const route of routes) {
    const offers = new Map(route.purchases.flatMap(offer => offer.movement_ids.map(id => [id, offer] as const)));
    for (const movement of route.movements) for (const charge of movement.charges) {
      const use = (charge.kind === "Airport access" || charge.kind === "Airport egress") && uses.get(`${charge.from_id}>${charge.to_id}`);
      if (!use) continue;
      const offer = offers.get(charge.id);
      if (!use.journeys.has(charge.id)) use.journeys.set(charge.id, { charge, movement, offer });
      use.used.add(route.id);
      if (offer && isPriced(offer, rates)) continue;
      use.missing.add(route.id);
      // A price in a currency without an exchange rate needs only the rate.
      if (offer && offer.low !== null) use.rates.add(offer.currency); else use.unpriced = true;
    }
  }
  const rank = { missing: 0, priced: 1, unused: 2 };
  return rows.map((row): TransferDirection => {
    const use = uses.get(`${row.from_id}>${row.to_id}`)!;
    const journeys = [...use.journeys.values()];
    const state = use.missing.size ? "missing" : use.used.size ? "priced" : "unused";
    const priced = journeys.flatMap(journey => journey.offer && isPriced(journey.offer, rates) ? [journey.offer] : []);
    // A journey's own price is an exception to the direction's price (F5); own prices show only when every journey has one.
    const directionPrices = priced.filter(offer => offer.source !== "user");
    const amounts = [...new Set((directionPrices.length ? directionPrices : priced).map(offerAmount))];
    return {
      ...row, state, journeys,
      options: use.used.size, missing: use.missing.size,
      ownPrices: journeys.filter(journey => journey.offer?.source === "user").length,
      rateCurrencies: [...use.rates].sort(),
      status: state === "missing" ? `${use.unpriced ? "Price missing" : "Needs an exchange rate"} · in ${plural(use.missing.size, "option")}`
        : state === "unused" ? "Not used now" : `${amounts.join(", ")} for ${plural(adults, "adult")}`,
    };
  }).sort((a, b) => rank[a.state] - rank[b.state] || b.missing - a.missing);
}

/**
 * A journey of an airport transfer direction (F2 Show journeys): "Fri 4 Dec 07:20 · flight to Busan" for access, at the
 * journey's start in its origin's time, or "Fri 4 Dec 18:54 · flight from Kuala Lumpur" for egress, at its end.
 */
export function transferJourneyText({ charge, movement }: Pick<TransferJourney, "charge" | "movement">, placeName: (id: string) => string, zoneOf: (id: string) => string) {
  const egress = charge.kind === "Airport egress";
  const time = egress ? movement.arrival : movement.departure;
  const what = `${modeLabel(movement.mode).toLowerCase()} ${egress ? "from" : "to"} ${placeName(egress ? movement.from_id : movement.to_id)}`;
  return time ? `${formatLocal(time, zoneOf(egress ? movement.to_id : movement.from_id))} · ${what}` : capitalize(what);
}

/** The title of a Journey prices row (F2): "Flight · Kuala Lumpur → Busan". A label that is a mode value reads as the mode. */
export function journeyGroupTitle(group: Pick<MissingFareGroup, "label" | "from_id" | "to_id">, placeName: (id: string) => string) {
  const kind = (modes as string[]).includes(group.label) ? modeLabel(group.label) : group.label;
  return `${kind} · ${placeName(group.from_id)} → ${placeName(group.to_id)}`;
}

/** One journey of a Journey prices row: "Fri 4 Dec 10:15 · AirAsia X D7530" in the origin's time (`zone`); "" when both are unknown. */
export function componentWhen(component: Pick<MissingFareGroup["components"][number], "departure" | "service">, zone: string) {
  return [component.departure ? formatLocal(component.departure, zone) : null, component.service].filter(Boolean).join(" · ");
}

/** The journeys of a Journey prices row: "1 journey · Fri 4 Dec 10:15 · AirAsia X D7530" or "3 journeys · 4–9 Dec" (dates in the origin's time). */
export function journeyGroupWhen(group: Pick<MissingFareGroup, "components">, zone: string) {
  const count = plural(group.components.length, "journey");
  if (group.components.length === 1) {
    const when = componentWhen(group.components[0], zone);
    return when ? `${count} · ${when}` : count;
  }
  const times = group.components.flatMap(component => component.departure ? [new Date(component.departure).getTime()] : []).sort((a, b) => a - b);
  if (!times.length) return count;
  const [first, last] = [times[0], times.at(-1)!].map(time => formatLocal(new Date(time).toISOString(), zone, "day"));
  const [firstDay, firstMonth] = first.split(" "), lastMonth = last.split(" ")[1];
  return `${count} · ${first === last ? first : firstMonth === lastMonth ? `${firstDay}–${last}` : `${first} – ${last}`}`;
}

/**
 * Splits missing-price groups for Missing info: airport access and egress groups that match a transfer row
 * belong to Airport transfers; the rest are Journey prices. Airport change groups ("Airport transfer …") belong to neither.
 */
export function splitGroups(groups: MissingFareGroup[], rows: AirportTransferRow[]) {
  const pairs = new Set(rows.map(row => `${row.from_id}>${row.to_id}`));
  const transfers: MissingFareGroup[] = [], journeys: MissingFareGroup[] = [];
  for (const group of groups) {
    if (group.label.startsWith("Airport transfer ")) continue;
    const transfer = (group.label === "Airport access" || group.label === "Airport egress") && pairs.has(`${group.from_id}>${group.to_id}`);
    (transfer ? transfers : journeys).push(group);
  }
  return { transfers, journeys };
}

/**
 * Combined-ticket searches for this option (E9.5): every leg matches one of its flights by places and
 * by the local date of the flight's first departure, as the server builds them.
 */
export function matchingQuoteLinks<L extends { legs: { from_id: string; to_id: string; date: string }[] }>(links: L[], route: Pick<Route, "movements">, zoneOf: (placeId: string) => string): L[] {
  const flights = new Set(route.movements.filter(movement => movement.mode === "flight").map(movement => {
    const departure = ticketDeparture(movement);
    return `${movement.from_id}>${movement.to_id}>${departure ? dateFormat(zoneOf(movement.from_id), "iso").format(new Date(departure)) : ""}`;
  }));
  return links.filter(link => link.legs.length > 0 && link.legs.every(leg => flights.has(`${leg.from_id}>${leg.to_id}>${leg.date}`)));
}

/** What blocks the decision (F1, F2). `routes` are the best options. */
export type RefinementState = {
  routes: Route[];
  airportChanges: AirportChangeRow[];
  /** unresolvedAccessJourneys() of the result's coverage. */
  unresolvedAccess: { assumptions: string[] }[];
  directions: TransferDirection[];
  /** splitGroups() of the missing-price groups. */
  groups: { transfers: MissingFareGroup[]; journeys: MissingFareGroup[] };
  gaps: { from_id: string; to_id: string }[];
};

/** Items that need input (F2): the Missing info tab badge and status. */
export function needsInputCount(state: RefinementState) {
  return state.airportChanges.filter(row => row.unresolved_journey_count > 0).length
    + state.directions.filter(direction => direction.state === "missing").length
    + state.groups.journeys.length
    + unresolvedAccessCities(state.unresolvedAccess).length
    + (state.routes.length ? 0 : state.gaps.length);
}

/** Modes that need transit search (Transitous). */
export const transitSearchModes: string[] = ["rail", "bus", "coach", "subway", "tram"];

/** Where a next step's button goes. */
export type NextStepTarget = "airport-changes" | "airport-fallback" | "prices" | "exchange-rate" | "show-unpriced-flights";
export type NextStep = { id: string; tone: "warn" | "info"; text: string; action: { label: string; target: NextStepTarget } | null };
/** The Next steps rows (F1), in priority order. Rows about search scope wait for the first search. */
export function buildNextSteps(state: RefinementState & {
  searched: boolean; budget: number | null; rates: Record<string, number>;
  excludeUnpricedFlights: boolean;
  /** Transit search is not set up on the server and a transit mode is on. */
  transitOff: boolean;
}): NextStep[] {
  const steps: NextStep[] = [];
  const blocked = state.airportChanges.filter(row => row.unresolved_journey_count > 0);
  if (blocked.length) {
    const journeys = plural(blocked.reduce((sum, row) => sum + row.unresolved_journey_count, 0), "flight journey");
    // "Airport changes" is the Missing info section; "Airport transfers" is another one (city and airport).
    const what = blocked.length === 1 ? `the airport change ${blocked[0].from_airport} → ${blocked[0].to_airport}` : `${blocked.length} airport changes (${blocked.map(row => `${row.from_airport} → ${row.to_airport}`).join(", ")})`;
    steps.push({ id: "airport-changes", tone: "warn", text: `${journeys} can't be used until you confirm ${what}.`, action: { label: blocked.length === 1 ? "Confirm airport change" : "Confirm airport changes", target: "airport-changes" } });
  }
  if (state.unresolvedAccess.length) {
    const count = state.unresolvedAccess.length;
    steps.push({ id: "access-time", tone: "warn", text: `${plural(count, "journey")} can't be used: the airport transfer time is unknown in ${unresolvedAccessCities(state.unresolvedAccess).join(", ")}.`, action: { label: "Set default time", target: "airport-fallback" } });
  }
  const unbounded = state.routes.filter(route => route.cost_high_myr === null);
  if (unbounded.length) {
    const total = state.routes.length;
    const lead = unbounded.length === total ? "No option has a complete price yet" : `${unbounded.length} of ${total} options ${unbounded.length === 1 ? "is" : "are"} not fully priced`;
    // Rows the user fills: transfer directions, then journey groups by mode.
    const byMode = (test: (mode: string) => boolean) => state.groups.journeys.filter(group => test(group.mode)).length;
    const counts: [number, string][] = [
      [state.directions.filter(direction => direction.state === "missing").length, "airport transfer price"],
      [byMode(mode => mode === "flight"), "flight price"],
      [byMode(mode => mode === "rail"), "train price"],
      [byMode(mode => mode !== "flight" && mode !== "rail"), "other price"],
    ];
    const parts = counts.filter(([count]) => count > 0);
    const missing = parts.reduce((sum, [count]) => sum + count, 0);
    // Options that only airport transfer prices keep from a complete price.
    const transfersOnly = unbounded.filter(route => {
      const kinds = itemKinds(route);
      const open = route.purchases.filter(offer => !isPriced(offer, state.rates) || offer.high === null);
      return open.length > 0 && open.every(offer => kinds.get(offer.movement_ids[0]) === "transfer");
    }).length;
    const text = [
      parts.length ? `${lead}: ${joinAnd(parts.map(([count, word]) => plural(count, word)))} ${missing === 1 ? "is" : "are"} missing.` : `${lead}.`,
      ...(transfersOnly ? [`${plural(transfersOnly, "option")} ${transfersOnly === 1 ? "needs" : "need"} only airport transfer prices.`] : []),
      ...(state.budget !== null ? [`Until then, options may exceed your ${moneyShort(state.budget)} budget.`] : []),
    ].join(" ");
    steps.push({ id: "prices", tone: "warn", text, action: { label: "Add prices", target: "prices" } });
  }
  const currencies = [...new Set([...state.groups.transfers, ...state.groups.journeys].filter(group => group.reason === "exchange_rate").map(group => group.currency))];
  if (currencies.length) steps.push({ id: "exchange-rates", tone: "warn", text: `Prices in ${joinAnd(currencies)} need ${currencies.length === 1 ? "an exchange rate" : "exchange rates"}.`, action: { label: "Add rate", target: "exchange-rate" } });
  if (state.searched && state.excludeUnpricedFlights) steps.push({ id: "unpriced-flights", tone: "info", text: "Options that need a flight without a price are hidden.", action: { label: "Show them", target: "show-unpriced-flights" } });
  if (state.searched && state.transitOff) steps.push({ id: "transit", tone: "info", text: "Trains, buses, coaches, subways and trams were not searched: transit search is not set up on this server.", action: null });
  return steps;
}

/**
 * Where an Options or Itinerary action goes: a next step's target, the trip settings, the connection form, the Over budget
 * group or Missing info › Airport transfers (Check before booking › Set transfer times).
 */
export type OptionsTarget = NextStepTarget | "edit-trip" | "add-connection" | "over-budget" | "transfer-times";
export type OptionsAction = { label: string; target: OptionsTarget };
/** The Options panel when it has no best option (C12): a title (only for "no-itinerary") and lines, each with at most one action. */
export type EmptyState = {
  id: "not-searched" | "searching" | "searches-left" | "over-budget" | "no-itinerary" | "unpriced-flights" | "combinations-left";
  title: string | null;
  lines: { text: string; action: OptionsAction | null }[];
};
const editTrip: OptionsAction = { label: "Edit trip", target: "edit-trip" };
/**
 * The Options empty state (C12), or null when best options exist. `steps` are the Next steps (buildNextSteps):
 * the no-itinerary reasons reuse their airport-change and access-time rows. `staySum` is staySumWarning() of
 * the trip. Without a result there is nothing to explain yet, so a finished search shows nothing until it arrives.
 */
export function optionsEmptyState({ searched, active, pending, hasResult, best, refinement, budget, staySum, gaps, excludeUnpricedFlights, steps, placeName, hiddenUnpricedFlights = 0, calculationPending = false, checking = false }: {
  searched: boolean; active: boolean; pending: number; hasResult: boolean; best: number;
  refinement: Pick<Route, "cost_low_myr">[]; budget: number | null; staySum: string | null;
  gaps: { from_id: string; to_id: string }[]; excludeUnpricedFlights: boolean; steps: NextStep[];
  placeName: (id: string) => string;
  hiddenUnpricedFlights?: number;
  calculationPending?: boolean; checking?: boolean;
}): EmptyState | null {
  if (best > 0) return null;
  const line = (text: string, action: OptionsAction | null = null) => ({ text, action });
  if (!searched) return { id: "not-searched", title: null, lines: [line("No options yet. Search transport to find options. They appear while the search runs.")] };
  if (excludeUnpricedFlights && hiddenUnpricedFlights > 0) return { id: "unpriced-flights", title: "Itineraries found, but flight prices are missing", lines: [
    line(`${plural(hiddenUnpricedFlights, "complete itinerary", "complete itineraries")} found so far ${hiddenUnpricedFlights === 1 ? "is" : "are"} hidden because at least one flight has no applicable price.`, { label: "Show them", target: "show-unpriced-flights" }),
    line("A round-trip price applies only when both matching flights are included. Add missing flight prices to compare complete totals."),
  ] };
  if (refinement.length && budget !== null) {
    const from = moneyShort(Math.min(...refinement.map(route => route.cost_low_myr)));
    return { id: "over-budget", title: null, lines: [line(`No option fits your ${moneyShort(budget)} budget. ${plural(refinement.length, "option")} ${refinement.length === 1 ? "costs" : "cost"} more, from ${from}.`, { label: "Show over-budget options", target: "over-budget" })] };
  }
  if (active) return { id: "searching", title: null, lines: [line("Searching. The first options appear after a few searches.")] };
  if (pending > 0) return { id: "searches-left", title: null, lines: [line(`No complete itinerary yet. ${plural(pending, "search", "searches")} ${pending === 1 ? "is" : "are"} left.`)] };
  if (!hasResult) return null;
  if (calculationPending) return { id: "combinations-left", title: null, lines: [line(checking
    ? "Checking saved combinations. No complete itinerary has been found yet."
    : "No complete itinerary found yet. More combinations remain to be checked.")] };
  const blocked = steps.filter(step => step.id === "airport-changes" || step.id === "access-time");
  return { id: "no-itinerary", title: "No itinerary fits these settings", lines: [
    ...(staySum ? [line(staySum, editTrip)] : []),
    ...gaps.map(gap => line(`No direct journey found between ${placeName(gap.from_id)} and ${placeName(gap.to_id)}.`, { label: "Add a connection", target: "add-connection" })),
    ...blocked.map(step => line(step.text, step.action)),
    ...(excludeUnpricedFlights ? [line("Flights without a price are skipped.", { label: "Show them", target: "show-unpriced-flights" })] : []),
    line("Or change the trip: fewer minimum hours, more days, more transport or wider departure times.", editTrip),
  ] };
}

// ---------------------------------------------------------------- connections and price rules

/**
 * A connection you added (F2 row 4): "Busan → Tokyo · Bus · 4 h 30 min · any time", or with fixed times
 * "… · Mon 7 Dec 09:00 → 13:30", the departure in the origin's time and the arrival in the destination's time.
 */
export function connectionText(movement: Pick<Movement, "from_id" | "to_id" | "mode" | "duration_minutes" | "departure" | "arrival">, placeName: (id: string) => string, zoneOf: (id: string) => string) {
  const from = zoneOf(movement.from_id), to = zoneOf(movement.to_id);
  const when = movement.departure && movement.arrival
    ? `${formatLocal(movement.departure, from)} → ${formatLocal(movement.arrival, to, formatLocal(movement.departure, from, "date") === formatLocal(movement.arrival, to, "date") ? "time" : "datetime")}`
    : "any time";
  return `${placeName(movement.from_id)} → ${placeName(movement.to_id)} · ${modeLabel(movement.mode)} · ${formatDuration(movement.duration_minutes)} · ${when}`;
}

/** The Add a connection form (F2 row 4) as typed. `departure` and `arrival` are datetime-local values. */
export type ConnectionForm = { from: string; to: string; mode: Mode; fixed: boolean; hours: string; distance: string; departure: string; arrival: string };
export type ConnectionErrors = Partial<Record<"places" | "hours" | "distance" | "departure" | "arrival", string>>;
export const blankConnectionForm = (): ConnectionForm => ({ from: "", to: "", mode: "bus", fixed: false, hours: "", distance: "", departure: "", arrival: "" });
/**
 * The connection to add (F2 row 4), or the errors of the form by field. Fixed times are read in each city's own time
 * zone (`zoneOf`, I6 item 6): both or neither; the travel time is then the time between them. `id` is "assumed:{uuid}".
 */
export function connectionFromForm(form: ConnectionForm, zoneOf: (id: string) => string, id: string): { movement: Movement; errors?: undefined } | { movement?: undefined; errors: ConnectionErrors } {
  const errors: ConnectionErrors = {};
  if (!form.from || !form.to || form.from === form.to) errors.places = "Choose two different places.";
  const distance = form.distance.trim() === "" ? null : Number(form.distance);
  if (distance !== null && (!Number.isFinite(distance) || distance < 0)) errors.distance = "Enter a distance of 0 or more.";
  let duration = Number(form.hours) * 60, departure: string | null = null, arrival: string | null = null;
  if (!form.fixed) {
    if (form.hours.trim() === "" || !Number.isFinite(duration) || duration <= 0) errors.hours = "Enter a travel time above 0.";
  } else if (!form.departure || !form.arrival) {
    errors[form.departure ? "arrival" : "departure"] = "Enter both times, or choose Any time.";
  } else if (!errors.places) {
    const read = (field: "departure" | "arrival", place: string) => {
      try { return localInputToISO(form[field], zoneOf(place)); }
      catch (err) { errors[field] = err instanceof Error ? err.message : String(err); return null; }
    };
    departure = read("departure", form.from); arrival = read("arrival", form.to);
    if (departure && arrival) {
      duration = (Date.parse(arrival) - Date.parse(departure)) / 60000;
      if (duration <= 0) errors.arrival = "Arrival must be after departure.";
    }
  }
  if (Object.keys(errors).length) return { errors };
  return { movement: {
    id, from_id: form.from, to_id: form.to, mode: form.mode, duration_minutes: duration, distance_km: distance, departure, arrival,
    source: "User-defined connection", assumptions: ["User supplied connectivity and timing"], segments: [], charges: [], transfers: 0,
    vehicle_kind: form.mode === "car" ? "rental" : null, search_url: null,
  } };
}

/** Transport values of a price rule (F2 row 7), in the order of the Transport select. */
export const ruleModes = ["*", ...modes, "rental"];
const ruleUnits: Record<PricingRule["unit"], string> = { person: "per person", party: "per group", vehicle: "per vehicle" };
/**
 * A price rule in the rule list (F2 row 7): "Taxi · Busan → PUS airport · RM 80 – 120 · per vehicle (4 seats) · from KR · priority 0".
 * Places and the service show only when the rule names them.
 */
export function ruleText(rule: PricingRule, placeName: (id: string) => string) {
  const price = `${moneyShort(rule.low, rule.currency)}${rule.high !== null && rule.high !== rule.low ? ` – ${amount(rule.high)}` : ""}${rule.kind === "per-km" ? "/km" : ""}`;
  return [
    modeLabel(rule.mode),
    rule.from_id || rule.to_id ? `${rule.from_id ? placeName(rule.from_id) : "any place"} → ${rule.to_id ? placeName(rule.to_id) : "any place"}` : "",
    rule.service ?? "",
    price,
    rule.unit === "vehicle" ? `per vehicle (${plural(rule.capacity, "seat")})` : ruleUnits[rule.unit],
    rule.country_code ? `from ${rule.country_code}` : "",
    `priority ${rule.priority}`,
  ].filter(Boolean).join(" · ");
}

/** The price rule form (F2 row 7) as typed. */
export type RuleForm = Omit<PricingRule, "from_id" | "to_id" | "service" | "country_code" | "low" | "high" | "capacity" | "priority">
  & Record<"from_id" | "to_id" | "service" | "country_code" | "low" | "high" | "capacity" | "priority", string>;
export type RuleErrors = Partial<Record<"name" | "country_code" | "low" | "high" | "currency" | "capacity" | "priority", string>>;
export const blankRuleForm = (id: string): RuleForm => ({ id, name: "", mode: "*", from_id: "", to_id: "", service: "", country_code: "", kind: "fixed", low: "", high: "", currency: "MYR", unit: "person", capacity: "4", priority: "0" });
/** A saved rule in the form, for Edit. */
export function ruleForm(rule: PricingRule): RuleForm {
  return { ...rule, from_id: rule.from_id ?? "", to_id: rule.to_id ?? "", service: rule.service ?? "", country_code: rule.country_code ?? "",
    low: String(rule.low), high: rule.high === null ? "" : String(rule.high), capacity: String(rule.capacity), priority: String(rule.priority) };
}
/**
 * The rule to save, or the errors of the form by field. A blank highest price is a fixed price; a blank priority is 0.
 * Seats count only per vehicle; otherwise an invalid hidden value goes back to 4.
 */
export function ruleFromForm(form: RuleForm): { rule: PricingRule; errors?: undefined } | { rule?: undefined; errors: RuleErrors } {
  const errors: RuleErrors = { ...priceInputErrors(form.low, form.high, form.currency) };
  if (!form.name.trim()) errors.name = "Enter a rule name.";
  if (form.country_code.trim() && !/^[A-Za-z]{2}$/.test(form.country_code.trim())) errors.country_code = "Enter a 2-letter country code.";
  const capacity = Number(form.capacity), priority = form.priority.trim() === "" ? 0 : Number(form.priority);
  const seatsValid = form.capacity.trim() !== "" && Number.isInteger(capacity) && capacity >= 1 && capacity <= 9;
  if (form.unit === "vehicle" && !seatsValid) errors.capacity = "Enter 1 to 9 seats.";
  if (!Number.isInteger(priority)) errors.priority = "Enter a whole number.";
  if (Object.keys(errors).length) return { errors };
  const text = (value: string) => value.trim() || null;
  return { rule: {
    id: form.id, name: form.name.trim(), mode: form.mode, from_id: form.from_id || null, to_id: form.to_id || null,
    service: text(form.service), country_code: text(form.country_code)?.toUpperCase() ?? null, kind: form.kind,
    low: Number(form.low), high: form.high.trim() === "" ? null : Number(form.high), unit: form.unit,
    capacity: seatsValid ? capacity : 4, currency: form.currency.trim().toUpperCase(), priority,
  } };
}
