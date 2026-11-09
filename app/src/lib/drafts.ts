import type { AirportConnection, AirportTransferEstimate, AirportTransferMode, AirportTransferRow, Charge, JourneyPriceScope, Offer, Route, SavedTrip } from "./planner";
import { modeLabel } from "./present";

/** A price for each listed component, kept in this browser until it is applied. */
export type SharedFare = { component_ids: string[]; low: number; high: number | null; currency: string; label: string; scope?: JourneyPriceScope };
/** A typed price: `high` null is open-ended ("or more"); `high` equal to `low` is a fixed price. */
export type PriceValue = Pick<SharedFare, "low" | "high" | "currency">;
/** One way between a city and its airport, as typed. Text fields keep invalid input until it is applied. */
export type TransferRowDraft = { mode: AirportTransferMode; low: string; high: string; duration: string; currency: string };
/** A typed airport change, keyed "{FROM}>{TO}". A null draft clears or removes the saved one. */
export type AirportChangeDraft = { mode: AirportTransferMode | ""; duration: string; fare: string; currency: string };
/** All drafts of one trip (F4): fare drafts by key, transfer drafts by `transferKey`, airport-change drafts by "{FROM}>{TO}". */
export type MissingInfoDeletion = { kind: "offer" | "journey_rule" | "exchange_rate" | "airport_transfer" | "airport_change"; id: string; label: string };
export const deletionKey = (item: Pick<MissingInfoDeletion, "kind" | "id">) => JSON.stringify([item.kind, item.id]);
export type DraftState = { fares: Record<string, SharedFare>; transfers: Record<string, TransferRowDraft[]>; airportChanges: Record<string, AirportChangeDraft | null>; exchangeRates?: Record<string, number>; deletions?: Record<string, MissingInfoDeletion> };

/** A ticket row of the itinerary (E9.4): the component that Set price stages, its charge, and whether it has your own price. */
export type DraftTarget = { componentId: string | null; charge: Charge | null; ownPrice: boolean };
/**
 * A draft that changes a ticket row: a price for this journey, the price of its airport transfer direction, or its
 * airport change. `value` is null when the draft has no valid price. `undo` removes only what changes this row.
 */
export type DraftPrice = { scope: "journey" | "direction" | "change"; value: PriceValue | null; amount: string; undo: () => void };

export const transferKey = (from_id: string, to_id: string, adults: number) => JSON.stringify([from_id, to_id, adults]);
/**
 * The ids of the Missing info inputs that hold transfer and airport-change drafts. "Fix {k} values" and Next steps focus them.
 * `index` is the position of the way in the direction's draft rows.
 */
export const transferFieldId = (from_id: string, to_id: string, index: number, field: keyof TransferRowDraft) => `transfer-${field}-${from_id}>${to_id}-${index}`;
/** The exchange-rate input of an airport transfer direction whose price is in `currency` (Next steps › Add rate). */
export const transferRateId = (from_id: string, to_id: string, currency: string) => `transfer-rate-${from_id}>${to_id}-${currency}`;
export const airportChangeFieldId = (key: string, field: keyof AirportChangeDraft) => `airport-change-${field}-${key}`;

/** Exact prices replace overlapping exact drafts. Reusable scopes keep their seeds and coexist with individual overrides. */
export function stageFare(drafts: Record<string, SharedFare>, key: string, fare: SharedFare): Record<string, SharedFare> {
  if (fare.scope) return { ...drafts, [key]: fare };
  const overwritten = new Set(fare.component_ids);
  const remaining = Object.fromEntries(Object.entries(drafts).flatMap(([id, value]) => {
    if (value.scope) return [[id, value]];
    const component_ids = value.component_ids.filter(id => !overwritten.has(id));
    return component_ids.length || value.scope ? [[id, { ...value, component_ids }]] : [];
  }));
  return { ...remaining, [key]: fare };
}

/** Removes one component from exact drafts. A reusable scope must be undone as a whole. */
export function removeComponent(drafts: Record<string, SharedFare>, id: string): Record<string, SharedFare> {
  return Object.fromEntries(Object.entries(drafts).flatMap(([key, value]) => {
    if (value.scope) return [[key, value]];
    const component_ids = value.component_ids.filter(item => item !== id);
    return component_ids.length || value.scope ? [[key, { ...value, component_ids }]] : [];
  }));
}

/** Exact drafts need known components. Saved reusable scopes can be edited without visible journeys. */
export function activeFares(drafts: Record<string, SharedFare>, known: Set<string>, adults?: number): SharedFare[] {
  return Object.values(drafts).flatMap(draft => {
    if (draft.scope && adults !== undefined && draft.scope.adults !== adults) return [];
    const component_ids = draft.component_ids.filter(id => known.has(id));
    return component_ids.length || draft.scope ? [{ ...draft, component_ids }] : [];
  });
}

/**
 * Maps route movement ids to their template ids, without duplicates. Transfer estimates give flights
 * variant ids that change with every estimate edit; a price on the template applies to every variant.
 */
export function canonicalIds(ids: string[], templateOf: Map<string, string>): string[] {
  return [...new Set(ids.map(id => templateOf.get(id) ?? id))];
}

/** Fare drafts on canonical ids. Drafts stored before prices moved to template ids can hold variant ids; they are staged again in order. */
export function canonicalFares(drafts: Record<string, SharedFare>, templateOf: Map<string, string>): Record<string, SharedFare> {
  return Object.entries(drafts).reduce((result, [key, fare]) =>
    stageFare(result, key, { ...fare, component_ids: canonicalIds(fare.component_ids, templateOf) }), {} as Record<string, SharedFare>);
}

/**
 * The fare components the planner accepts (F4): `fare_component_ids` from GET, else the snapshot's journeys and
 * charges plus the components of `routes` (best, weaker and over-budget). PUT /trips has no fare_component_ids.
 */
export function knownComponentIds(saved: Pick<SavedTrip, "fare_component_ids" | "snapshot"> | null, routes: Pick<Route, "movements" | "extra_charges">[]): Set<string> {
  return new Set(saved?.fare_component_ids ?? [
    ...(saved?.snapshot?.movements ?? []).flatMap(movement => [movement.id, ...movement.charges.map(charge => charge.id)]),
    ...routes.flatMap(route => [
      ...route.movements.flatMap(movement => [movement.id, ...movement.charges.map(charge => charge.id)]),
      ...route.extra_charges.map(charge => charge.id),
    ]),
  ]);
}

/**
 * The id of the stored offer behind a purchase. pricePath in native/pricing.ts copies an offer
 * on template T to each variant V as "{offer id}:{V}", so "user:T:V" was stored as "user:T".
 */
export function storedOfferId(purchase: Pick<Offer, "id" | "movement_ids">): string {
  const suffix = `:${purchase.movement_ids[0]}`;
  const copied = purchase.movement_ids.length === 1 && purchase.id.startsWith("user:") && purchase.id !== `user${suffix}` && purchase.id.endsWith(suffix);
  return copied ? purchase.id.slice(0, -suffix.length) : purchase.id;
}

/** True when a staged price is the same as the saved one, so the draft changes nothing. */
export function sameFare(value: PriceValue, saved: PriceValue | null | undefined) {
  return !!saved && value.low === saved.low && value.high === saved.high && value.currency.toUpperCase() === saved.currency.toUpperCase();
}

export const blankTransferRow = (mode: AirportTransferMode = "taxi"): TransferRowDraft => ({ mode, low: "", high: "", duration: "", currency: "MYR" });
/** The ways between a city and an airport, in the order the Way selects list them (F2): taxi, the default way, first. */
export const transferModes: AirportTransferMode[] = ["taxi", "rail", "bus", "coach", "subway", "tram", "car"];
/** The way that "+ Add another way" adds: the first one not used yet; null when all are used. */
export const nextTransferMode = (rows: Pick<TransferRowDraft, "mode">[]) => transferModes.find(mode => !rows.some(row => row.mode === mode)) ?? null;
/**
 * The saved ways of one direction as row drafts; one blank taxi row (the default way) when none is saved.
 * A highest price equal to the price is a fixed price, so its optional field shows blank.
 */
export function savedTransferRows(estimates: AirportTransferEstimate[], from_id: string, to_id: string, adults: number): TransferRowDraft[] {
  const text = (value: number | null) => value === null ? "" : String(value);
  const rows = estimates.filter(e => e.from_id === from_id && e.to_id === to_id && e.adults === adults)
    .map(e => ({ mode: e.mode, low: text(e.low), high: e.high === e.low ? "" : text(e.high), duration: text(e.duration_minutes), currency: e.currency }));
  return rows.length ? rows : [blankTransferRow()];
}
// A number as text in one form ("95.0" → "95"); other text as typed.
const numberText = (text: string) => {
  const trimmed = text.trim(), value = Number(trimmed);
  return trimmed !== "" && Number.isFinite(value) ? String(value) : trimmed;
};
const isBlankTaxi = (row: TransferRowDraft) => row.mode === "taxi" && !row.low.trim() && !row.high.trim() && !row.duration.trim();
/**
 * True when the rows are only the default way: no rows, or one fully blank taxi row. The default way is no estimate.
 * The ways the user sets replace the default taxi (airportTransferVariants in native/preparation.ts), so a blank taxi
 * row beside other ways is an estimate: the taxi stays a way, with the road time and no price.
 */
const onlyDefaultWay = (rows: TransferRowDraft[]) => !rows.length || (rows.length === 1 && isBlankTaxi(rows[0]));
/**
 * True when two lists of ways give the same estimates: only the default way is no estimate, and a blank
 * highest price is the same as a highest price equal to the price (a fixed price).
 */
export function sameTransferRows(a: TransferRowDraft[], b: TransferRowDraft[]) {
  const norm = (rows: TransferRowDraft[]) => JSON.stringify((onlyDefaultWay(rows) ? [] : rows).map(row => {
    const low = numberText(row.low);
    return [row.mode, low, numberText(row.high) || low, numberText(row.duration), row.currency.trim().toUpperCase()];
  }));
  return norm(a) === norm(b);
}

const blankChange = (draft: AirportChangeDraft | null) => !draft || (!draft.mode && !draft.duration.trim() && !draft.fare.trim());
/** The saved airport change as a draft; null when the pair has none. */
export function savedAirportChange(connection: AirportConnection | undefined): AirportChangeDraft | null {
  return connection ? { mode: connection.mode, duration: String(connection.duration_minutes), fare: connection.fare_amount === null ? "" : String(connection.fare_amount), currency: connection.currency } : null;
}
/** True when two airport-change drafts save the same connection. A blank draft and null both mean no connection. */
export function sameAirportChange(a: AirportChangeDraft | null, b: AirportChangeDraft | null) {
  const norm = (draft: AirportChangeDraft | null) => blankChange(draft) ? null
    : [draft!.mode, numberText(draft!.duration), numberText(draft!.fare), draft!.fare.trim() ? draft!.currency.trim().toUpperCase() : "MYR"];
  return JSON.stringify(norm(a)) === JSON.stringify(norm(b));
}

/** A problem in a typed value: the field to fix and the message without the row label. */
export type DraftProblem<F> = { field: F; message: string };
const priceProblem = "enter a price of 0 or more, and a highest price at least as large.";
/** The problems of one direction's ways, in order: the first one is the one that Apply reports. */
export function transferProblems(rows: TransferRowDraft[]): (DraftProblem<keyof TransferRowDraft> & { index: number })[] {
  const problems: (DraftProblem<keyof TransferRowDraft> & { index: number })[] = [];
  const seen = new Set<string>();
  rows.forEach((value, index) => {
    const add = (field: keyof TransferRowDraft, message: string) => problems.push({ index, field, message });
    if (seen.has(value.mode)) add("mode", "use each way once.");
    seen.add(value.mode);
    if (isBlankTaxi(value)) return;
    const low = value.low.trim() ? Number(value.low) : null;
    const high = value.high.trim() ? Number(value.high) : null;
    const duration = value.duration.trim() ? Number(value.duration) : null;
    if (low !== null && (!Number.isFinite(low) || low < 0)) add("low", priceProblem);
    else if (high !== null && (low === null || !Number.isFinite(high) || high < low)) add(low === null ? "low" : "high", priceProblem);
    if ((duration !== null && (!Number.isFinite(duration) || duration <= 0)) || (value.mode !== "taxi" && duration === null)) add("duration", `enter a travel time above 0 for ${modeLabel(value.mode)}.`);
    if (!/^[A-Z]{3}$/.test(value.currency.toUpperCase())) add("currency", "enter a 3-letter currency code.");
  });
  return problems;
}

/** The problems of one airport-change draft, in order. A null or blank draft (clear or remove) has none. */
export function airportChangeProblems(draft: AirportChangeDraft | null): DraftProblem<keyof AirportChangeDraft>[] {
  if (!draft || blankChange(draft)) return [];
  const problems: DraftProblem<keyof AirportChangeDraft>[] = [];
  const duration = draft.duration.trim() ? Number(draft.duration) : null;
  if (!draft.mode || duration === null || !Number.isFinite(duration) || duration <= 0) problems.push({ field: draft.mode ? "duration" : "mode", message: "choose a way and a time above 0, or clear the row." });
  const fare = draft.fare.trim() ? Number(draft.fare) : null;
  if (fare !== null && (!Number.isFinite(fare) || fare < 0)) problems.push({ field: "fare", message: "enter a price of 0 or more." });
  if (fare !== null && !/^[A-Z]{3}$/.test((draft.currency || "MYR").toUpperCase())) problems.push({ field: "currency", message: "enter a 3-letter currency code." });
  return problems;
}

/**
 * The ids of the fields to fix before Apply (C9 "Fix {k} values"), in Missing info order: airport changes,
 * then transfer directions in `rows` order. Only transfer drafts for `adults` and for directions in `rows` apply.
 */
export function invalidDraftFields(drafts: Pick<DraftState, "transfers" | "airportChanges">, rows: AirportTransferRow[], adults: number): string[] {
  const changes = Object.keys(drafts.airportChanges).sort().flatMap(key => airportChangeProblems(drafts.airportChanges[key]).map(problem => airportChangeFieldId(key, problem.field)));
  const transfers = rows.flatMap(row => transferProblems(drafts.transfers[transferKey(row.from_id, row.to_id, adults)] ?? [])
    .map(problem => transferFieldId(row.from_id, row.to_id, problem.index, problem.field)));
  return [...changes, ...transfers];
}

/**
 * The full estimate list for PUT /airport-transfer-estimates. Directions with a draft use the draft;
 * other directions and other party sizes keep their saved estimates. Only the default way (one fully
 * blank taxi row) means no estimate. Throws an Error with a message for the first invalid value.
 */
export function buildTransferEstimates(rows: AirportTransferRow[], saved: AirportTransferEstimate[], drafts: Record<string, TransferRowDraft[]>, adults: number): AirportTransferEstimate[] {
  // The planner accepts only the directions in rows.
  const estimates = saved.filter(e => e.adults !== adults && rows.some(r => r.from_id === e.from_id && r.to_id === e.to_id));
  for (const row of rows) {
    const draft = drafts[transferKey(row.from_id, row.to_id, adults)];
    if (!draft) {
      estimates.push(...saved.filter(e => e.adults === adults && e.from_id === row.from_id && e.to_id === row.to_id));
      continue;
    }
    const [problem] = transferProblems(draft);
    if (problem) throw new Error(`${row.label}: ${problem.message}`);
    if (onlyDefaultWay(draft)) continue;
    for (const value of draft) {
      const number = (text: string) => text.trim() ? Number(text) : null;
      estimates.push({ from_id: row.from_id, to_id: row.to_id, adults, mode: value.mode, duration_minutes: number(value.duration), low: number(value.low), high: number(value.high), currency: value.currency.trim().toUpperCase() || "MYR" });
    }
  }
  return estimates;
}

/**
 * The full connection list for PUT /airport-connections: the saved list with the drafts merged in.
 * A null or blank draft removes the pair. Throws an Error with a message for the first invalid draft.
 */
export function buildAirportConnections(saved: AirportConnection[], drafts: Record<string, AirportChangeDraft | null>): AirportConnection[] {
  const byPair = new Map(saved.map(connection => [`${connection.from_airport}>${connection.to_airport}`, connection]));
  for (const [key, draft] of Object.entries(drafts)) {
    if (!draft || blankChange(draft)) { byPair.delete(key); continue; }
    const [from_airport, to_airport] = key.split(">");
    const [problem] = airportChangeProblems(draft);
    if (problem) throw new Error(`${from_airport} → ${to_airport}: ${problem.message}`);
    const fare = draft.fare.trim() ? Number(draft.fare) : null;
    byPair.set(key, { from_airport, to_airport, mode: draft.mode as AirportTransferMode, duration_minutes: Number(draft.duration), fare_amount: fare, currency: fare === null ? "MYR" : (draft.currency || "MYR").toUpperCase() });
  }
  return [...byPair.keys()].sort().map(key => byPair.get(key)!);
}

/** Number of drafts of each kind: airport changes and transfer directions with a draft, and fare drafts. */
export function countDrafts(drafts: DraftState) {
  return { airportChanges: Object.keys(drafts.airportChanges).length, transfers: Object.keys(drafts.transfers).length, prices: Object.keys(drafts.fares).length, rates: Object.keys(drafts.exchangeRates ?? {}).length, deletions: Object.keys(drafts.deletions ?? {}).length };
}
