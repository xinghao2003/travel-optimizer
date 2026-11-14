import { useLayoutEffect, useRef, useState } from "react";
import { removeComponent, sameAirportChange, sameFare, sameTransferRows, stageFare as withFare, type AirportChangeDraft, type DraftState, type PriceValue, type SharedFare, type TransferRowDraft } from "./drafts";

/** The kinds of drafts (F4): fare drafts, transfer drafts per direction and airport-change drafts per pair. */
export type DraftKind = keyof DraftState;
type Stored = DraftState & { tripId: string | null };

// Fare drafts keep the key and format of the old table; transfer and airport-change drafts share one new key.
const faresKey = (tripId: string) => `wayfinder:pending-estimates:${tripId}`;
const inputsKey = (tripId: string) => `wayfinder:pending-inputs:${tripId}`;
const record = (value: unknown) => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

function load(tripId: string | null): Stored {
  const read = (key: string) => { try { return JSON.parse(localStorage.getItem(key) ?? "null"); } catch { return null; } };
  if (!tripId) return { tripId, fares: {}, transfers: {}, airportChanges: {} };
  const inputs = record(read(inputsKey(tripId)));
  return { tripId, fares: record(read(faresKey(tripId))) as DraftState["fares"],
    transfers: record(inputs.transfers) as DraftState["transfers"], airportChanges: record(inputs.airportChanges) as DraftState["airportChanges"], exchangeRates: record(inputs.exchangeRates) as Record<string, number>, deletions: record(inputs.deletions) as DraftState["deletions"] };
}
function save({ tripId, fares, transfers, airportChanges, exchangeRates, deletions }: Stored) {
  if (!tripId) return;
  // Without storage (private window, blocked site data) the drafts stay in memory for this page.
  try {
    if (Object.keys(fares).length) localStorage.setItem(faresKey(tripId), JSON.stringify(fares));
    else localStorage.removeItem(faresKey(tripId));
    if (Object.keys(transfers).length || Object.keys(airportChanges).length || Object.keys(exchangeRates ?? {}).length || Object.keys(deletions ?? {}).length) localStorage.setItem(inputsKey(tripId), JSON.stringify({ transfers, airportChanges, exchangeRates, deletions }));
    else localStorage.removeItem(inputsKey(tripId));
  } catch { /* Keep the drafts in memory. */ }
}
/** Removes the stored drafts of a deleted trip. */
export function forgetDrafts(tripId: string) {
  try { localStorage.removeItem(faresKey(tripId)); localStorage.removeItem(inputsKey(tripId)); } catch { /* Nothing stored. */ }
}
const without = <T,>(values: Record<string, T>, key: string) => Object.fromEntries(Object.entries(values).filter(([item]) => item !== key));

/**
 * The drafts of one trip, kept in this browser until Apply (F4). They load when `tripId` changes and are written
 * only for that trip. Staging a value equal to the saved one (`saved`) deletes its key. `read()` returns the latest
 * drafts, also right after a stage call in the same event (Ctrl+Enter stages, then applies).
 * Fare drafts must already use canonical ids (`template_id ?? id`).
 */
export function useTripDrafts(tripId: string | null) {
  const [state, setState] = useState(() => load(tripId));
  // Another trip: its drafts replace these before the render is shown.
  if (state.tripId !== tripId) setState(load(tripId));
  const latest = useRef(state);
  useLayoutEffect(() => { latest.current = state; }, [state]);
  const empty: DraftState = { fares: {}, transfers: {}, airportChanges: {} };
  const drafts: DraftState = state.tripId === tripId ? state : empty;

  function update(change: (current: Stored) => Partial<DraftState>) {
    const current = latest.current;
    if (!tripId || current.tripId !== tripId) return;
    const next = { ...current, ...change(current) };
    latest.current = next;
    setState(next);
    save(next);
  }
  return {
    drafts,
    /** Import a validated batch in one render and one local-storage write. */
    stageImported(drafts: DraftState) { update(() => drafts); },
    read: (): DraftState => latest.current.tripId === tripId ? latest.current : empty,
    /** Stages a fare under `key` with the overlap rule of stageFare; `saved` is the price in use now (a user price). */
    stageFare(key: string, fare: SharedFare, saved?: PriceValue | null) {
      update(current => {
        const fares = withFare(current.fares, key, fare);
        return { fares: sameFare(fare, saved) ? without(fares, key) : fares };
      });
    },
    /** Undo for one journey: the component leaves every fare draft. */
    unstageComponent(id: string) { update(current => ({ fares: removeComponent(current.fares, id) })); },
    /** Stages all ways of one direction (`transferKey`); `saved` is `savedTransferRows` of that direction. */
    stageTransfer(key: string, rows: TransferRowDraft[], saved: TransferRowDraft[]) {
      update(current => ({ transfers: sameTransferRows(rows, saved) ? without(current.transfers, key) : { ...current.transfers, [key]: rows } }));
    },
    /** Stages an airport change ("{FROM}>{TO}"); null clears or removes the pair. `saved` is `savedAirportChange` of that pair. */
    stageAirportChange(key: string, draft: AirportChangeDraft | null, saved: AirportChangeDraft | null) {
      update(current => ({ airportChanges: sameAirportChange(draft, saved) ? without(current.airportChanges, key) : { ...current.airportChanges, [key]: draft } }));
    },
    /** Undo: removes one draft. */
    unstage(kind: DraftKind, key: string) { update(current => ({ [kind]: without<unknown>(current[kind] ?? {}, key) }) as Partial<DraftState>); },
    /** Removes every draft of the given kinds; all kinds without arguments (Discard). */
    clear(...kinds: DraftKind[]) {
      update(() => Object.fromEntries((kinds.length ? kinds : ["fares", "transfers", "airportChanges", "exchangeRates", "deletions"] as DraftKind[]).map(kind => [kind, {}])));
    },
  };
}
export type TripDraftsApi = ReturnType<typeof useTripDrafts>;
