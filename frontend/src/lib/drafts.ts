import type { AirportConnection, AirportTransferEstimate, AirportTransferMode, AirportTransferRow, Offer } from "./planner";
import { modeLabel } from "./present";

/** A price for each listed component, kept in this browser until it is applied. */
export type SharedFare = { component_ids: string[]; low: number; high: number | null; currency: string; label: string };
/** One way between a city and its airport, as typed. Text fields keep invalid input until it is applied. */
export type TransferRowDraft = { mode: AirportTransferMode; low: string; high: string; duration: string; currency: string };
/** A typed airport change, keyed "{FROM}>{TO}". A null draft clears or removes the saved one. */
export type AirportChangeDraft = { mode: AirportTransferMode | ""; duration: string; fare: string; currency: string };

export const transferKey = (from_id: string, to_id: string, adults: number) => JSON.stringify([from_id, to_id, adults]);

/** Stages a fare under key. Other drafts lose the components it covers; drafts left empty are dropped. */
export function stageFare(drafts: Record<string, SharedFare>, key: string, fare: SharedFare): Record<string, SharedFare> {
  const overwritten = new Set(fare.component_ids);
  const remaining = Object.fromEntries(Object.entries(drafts).flatMap(([id, value]) => {
    const component_ids = value.component_ids.filter(id => !overwritten.has(id));
    return component_ids.length ? [[id, { ...value, component_ids }]] : [];
  }));
  return { ...remaining, [key]: fare };
}

/** The drafts that apply: components outside `known` are left out, and drafts left empty are skipped. */
export function activeFares(drafts: Record<string, SharedFare>, known: Set<string>): SharedFare[] {
  return Object.values(drafts).flatMap(draft => {
    const component_ids = draft.component_ids.filter(id => known.has(id));
    return component_ids.length ? [{ ...draft, component_ids }] : [];
  });
}

/**
 * Maps route movement ids to their template ids, without duplicates. Transfer estimates give flights
 * variant ids that change with every estimate edit; a price on the template applies to every variant.
 */
export function canonicalIds(ids: string[], templateOf: Map<string, string>): string[] {
  return [...new Set(ids.map(id => templateOf.get(id) ?? id))];
}

/**
 * The id of the stored offer behind a purchase. price_path in planner_optimizer.py copies an offer
 * on template T to each variant V as "{offer id}:{V}", so "user:T:V" was stored as "user:T".
 */
export function storedOfferId(purchase: Pick<Offer, "id" | "movement_ids">): string {
  const suffix = `:${purchase.movement_ids[0]}`;
  const copied = purchase.movement_ids.length === 1 && purchase.id.startsWith("user:") && purchase.id !== `user${suffix}` && purchase.id.endsWith(suffix);
  return copied ? purchase.id.slice(0, -suffix.length) : purchase.id;
}

/**
 * The full estimate list for PUT /airport-transfer-estimates. Directions with a draft use the draft;
 * other directions and other party sizes keep their saved estimates. A fully blank taxi row means
 * no estimate. Throws an Error with a message for the first invalid value.
 */
export function buildTransferEstimates(rows: AirportTransferRow[], saved: AirportTransferEstimate[], drafts: Record<string, TransferRowDraft[]>, adults: number): AirportTransferEstimate[] {
  // The server accepts only the directions in rows.
  const estimates = saved.filter(e => e.adults !== adults && rows.some(r => r.from_id === e.from_id && r.to_id === e.to_id));
  for (const row of rows) {
    const draft = drafts[transferKey(row.from_id, row.to_id, adults)];
    if (!draft) {
      estimates.push(...saved.filter(e => e.adults === adults && e.from_id === row.from_id && e.to_id === row.to_id));
      continue;
    }
    const seen = new Set<string>();
    for (const value of draft) {
      if (seen.has(value.mode)) throw new Error(`${row.label}: use each way once.`);
      seen.add(value.mode);
      if (!value.low.trim() && !value.high.trim() && !value.duration.trim() && value.mode === "taxi") continue;
      const low = value.low.trim() ? Number(value.low) : null;
      const high = value.high.trim() ? Number(value.high) : null;
      const duration = value.duration.trim() ? Number(value.duration) : null;
      if ((low !== null && (!Number.isFinite(low) || low < 0)) || (high !== null && (low === null || !Number.isFinite(high) || high < low))) throw new Error(`${row.label}: enter a price of 0 or more, and a highest price at least as large.`);
      if ((duration !== null && (!Number.isFinite(duration) || duration <= 0)) || (value.mode !== "taxi" && duration === null)) throw new Error(`${row.label}: enter a travel time above 0 for ${modeLabel(value.mode)}.`);
      const currency = value.currency.toUpperCase();
      if (!/^[A-Z]{3}$/.test(currency)) throw new Error(`${row.label}: enter a 3-letter currency code.`);
      estimates.push({ from_id: row.from_id, to_id: row.to_id, adults, mode: value.mode, duration_minutes: duration, low, high, currency });
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
    if (!draft || (!draft.mode && !draft.duration.trim() && !draft.fare.trim())) { byPair.delete(key); continue; }
    const [from_airport, to_airport] = key.split(">");
    const label = `${from_airport} → ${to_airport}`;
    const duration = draft.duration.trim() ? Number(draft.duration) : null;
    if (!draft.mode || duration === null || !Number.isFinite(duration) || duration <= 0) throw new Error(`${label}: choose a way and a time above 0, or clear the row.`);
    const fare = draft.fare.trim() ? Number(draft.fare) : null;
    if (fare !== null && (!Number.isFinite(fare) || fare < 0)) throw new Error(`${label}: enter a price of 0 or more.`);
    const currency = fare === null ? "MYR" : (draft.currency || "MYR").toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency)) throw new Error(`${label}: enter a 3-letter currency code.`);
    byPair.set(key, { from_airport, to_airport, mode: draft.mode, duration_minutes: duration, fare_amount: fare, currency });
  }
  return [...byPair.keys()].sort().map(key => byPair.get(key)!);
}

/** Number of drafts of each kind: airport changes and transfer directions with a draft, and fare drafts. */
export function countDrafts(drafts: { fares: Record<string, SharedFare>; transfers: Record<string, TransferRowDraft[]>; airportChanges: Record<string, AirportChangeDraft | null> }) {
  return { airportChanges: Object.keys(drafts.airportChanges).length, transfers: Object.keys(drafts.transfers).length, prices: Object.keys(drafts.fares).length };
}
