/** Trip edit semantics; all transforms are pure. */
import type { AirportConnection, AirportTransferEstimate, JourneyGroupField, JourneyPriceScope, Movement, Offer, PricingRule, TripSpec } from "../lib/planner";
import { journeyGroupFields, journeyPriceScope, sameJourneyScope } from "../lib/journeyPricing";
import { parseConnection, parseFiniteNumber, parseInteger, parseMovement, parseOffer, parseRule, parseScope, parseSpec, parseTransfer } from "./contracts";
import { discoveryKey } from "./discovery-key";
import { placesOf } from "./discovery";
import { airportTransferRows, effectiveTransfers, transferKey } from "./preparation";
import type { AirportCatalog, PlannerTrip, Snapshot } from "./preparation";
import { stableId } from "./time";

export class PlannerError extends Error {
  constructor(message: string, readonly status = 422) { super(message); this.name = "PlannerError"; }
}
function reject(message: string, status = 422): never { throw new PlannerError(message, status); }
export function requireRevision(trip: PlannerTrip, expected: number) {
  if (trip.revision !== expected) reject("This trip changed. Reload it before saving.", 409);
}
export function requireMinimumStays(spec: TripSpec) {
  if (spec.visits.some(v => v.min_stay_hours <= 0)) reject("Enter a minimum stay greater than 0 hours for each city.");
}
export function fareMovements(trip: PlannerTrip): Movement[] {
  const result = trip.result;
  return [...(trip.snapshot?.movements ?? []), ...[...(result?.routes ?? []), ...(result?.dominated_routes ?? []), ...(result?.refinement_routes ?? [])].flatMap(r => r.movements)];
}
export type SharedFare = { component_ids: string[]; low: number; high: number | null; currency: string; label: string; scope: JourneyPriceScope | null };
export type Deletion = { kind: "offer" | "journey_rule" | "exchange_rate" | "airport_change" | "airport_transfer"; id: string };
export type ApplyChanges = { expected_revision: number; connections: AirportConnection[] | null; transfers: AirportTransferEstimate[] | null; estimates: SharedFare[]; exchange_rates: Record<string, number>; deletions: Deletion[] };
type Value = Record<string, unknown>;
const record = (input: unknown): Value => input !== null && typeof input === "object" && !Array.isArray(input) ? input as Value : reject("Enter a JSON object.");
function list(value: unknown, maximum: number): unknown[] {
  if (!Array.isArray(value) || value.length > maximum) reject("Too many items or an invalid list.");
  return value as unknown[];
}
export function expectedRevision(value: unknown): number {
  return parseInteger(value);
}
export function parseSharedFare(value: unknown): SharedFare {
  const input = record(value), ids = list(input.component_ids ?? [], 5000);
  if (ids.some(id => typeof id !== "string")) reject("Fare components must be strings.");
  const scope = input.scope == null ? null : parseScope(input.scope);
  if (!ids.length && !scope) reject("Choose at least one fare component.");
  const label = input.label ?? "Shared transfer estimate";
  if (typeof label !== "string" || [...label].length > 200) reject("An estimate label may contain at most 200 characters.");
  if (input.low === undefined) reject("A minimum fare is required.");
  const fare = parseOffer({ id: "validation", movement_ids: ["validation"], low: input.low, high: input.high ?? null, currency: input.currency ?? "MYR", label });
  return { component_ids: ids as string[], low: fare.low!, high: fare.high, currency: fare.currency, label, scope };
}
export function parseApplyChanges(value: unknown): ApplyChanges {
  const data = record(value), rates = record(data.exchange_rates ?? {});
  const exchange_rates: Record<string, number> = {};
  for (const [code, raw] of Object.entries(rates)) {
    const rate = parseFiniteNumber(raw);
    if (!/^[A-Z]{3}$/.test(code) || !Number.isFinite(rate) || rate <= 0 || code === "MYR" && rate !== 1) reject("Use 3-letter uppercase currencies and positive MYR per unit. MYR must be 1.");
    exchange_rates[code] = rate;
  }
  const kinds = new Set(["offer", "journey_rule", "exchange_rate", "airport_change", "airport_transfer"]);
  const deletions = list(data.deletions ?? [], 5000).map(raw => {
    const item = record(raw);
    if (typeof item.kind !== "string" || !kinds.has(item.kind) || typeof item.id !== "string" || !item.id.length || [...item.id].length > 1000) reject("Choose a saved value to delete.");
    return item as unknown as Deletion;
  });
  return { expected_revision: expectedRevision(data.expected_revision), connections: data.connections == null ? null : list(data.connections, 120).map(parseConnection),
    transfers: data.transfers == null ? null : list(data.transfers, 240).map(parseTransfer), estimates: list(data.estimates ?? [], 5000).map(parseSharedFare), exchange_rates, deletions };
}
export function connectionPayload(connections: AirportConnection[]): AirportConnection[] {
  const parsed = connections.map(parseConnection), keys = parsed.map(c => JSON.stringify([c.from_airport, c.to_airport]));
  if (new Set(keys).size !== keys.length) reject("Enter each directed airport pair only once.");
  return parsed;
}
export function transferPayload(trip: PlannerTrip, estimates: AirportTransferEstimate[], catalog: AirportCatalog): AirportTransferEstimate[] {
  const parsed = estimates.map(parseTransfer), allowed = new Set(airportTransferRows(parseSpec(trip.spec), trip.snapshot?.movements ?? [], catalog).map(r => JSON.stringify([r.from_id, r.to_id])));
  const keys = parsed.map(e => JSON.stringify([e.from_id, e.to_id, e.adults, e.mode]));
  if (new Set(keys).size !== keys.length || parsed.some(e => !allowed.has(JSON.stringify([e.from_id, e.to_id])))) reject("Enter each method once per airport/city direction and party size, using airports in this trip.");
  return parsed;
}
export function sharedFareOffers(trip: PlannerTrip, estimates: SharedFare[]): Offer[] {
  const exact = estimates.filter(e => !e.scope).flatMap(e => e.component_ids);
  if (new Set(exact).size !== exact.length) reject("Fare components must be unique across saved estimates.");
  if (estimates.some(e => e.high !== null && e.high < e.low)) reject("Maximum fare must be at least the minimum.");
  const movements = fareMovements(trip), routes = [...(trip.result?.routes ?? []), ...(trip.result?.dominated_routes ?? []), ...(trip.result?.refinement_routes ?? [])];
  const charges = new Set([...movements.flatMap(m => m.charges.map(c => c.id)), ...routes.flatMap(r => r.extra_charges.map(c => c.id))]);
  const known = new Set([...movements.map(m => m.id), ...charges]);
  if (estimates.some(e => e.component_ids.some(id => !known.has(id)))) reject("Every fare component must belong to this trip.");
  const adults = parseSpec(trip.spec).adults, byId = new Map(movements.map(m => [m.id, m]));
  for (const e of estimates) if (e.scope) {
    if (e.scope.adults !== adults) reject("The estimate must match this trip's party size.");
    if (!e.component_ids.length && !(trip.journey_pricing_rules ?? []).some(r => r.journey_scope && sameJourneyScope(r.journey_scope, e.scope!))) reject("A new reusable estimate needs a matching journey.");
    for (const id of e.component_ids) {
      const m = byId.get(id);
      if (!m || !sameJourneyScope(journeyPriceScope(parseMovement(m), adults, e.scope.group_by), e.scope)) reject("Every journey must match the reusable estimate's scope.");
    }
  }
  return estimates.filter(e => !e.scope).flatMap(e => e.component_ids.map(id => parseOffer({ id: "user:" + id, movement_ids: [id], kind: charges.has(id) ? "charge" : "one-way",
    low: e.low, high: e.high, currency: e.currency, source: "user", adults, estimated: true, label: e.label })));
}
export function reusableJourneyRules(trip: PlannerTrip, estimates: SharedFare[]): PricingRule[] {
  const rules = new Map((trip.journey_pricing_rules ?? []).map(r => [r.id, r]));
  for (const e of estimates) if (e.scope) {
    const scope = e.scope, id = "journey-estimate:" + stableId(scope);
    rules.set(id, parseRule({ id, name: [...e.label].slice(0, 120).join(""), from_id: scope.from_id, to_id: scope.to_id, mode: scope.mode, unit: "party",
      low: e.low, high: e.high, currency: e.currency, priority: trip.revision + 1, journey_scope: scope }));
  }
  return [...rules.values()];
}
export function applyMissingInfo(trip: PlannerTrip, request: ApplyChanges, catalog: AirportCatalog): PlannerTrip {
  requireRevision(trip, request.expected_revision);
  if (request.connections === null && request.transfers === null && !request.estimates.length && !Object.keys(request.exchange_rates).length && !request.deletions.length) reject("No changes to apply.");
  const updated = structuredClone(trip);
  if (Object.keys(request.exchange_rates).length) updated.spec.exchange_rates = { ...trip.spec.exchange_rates, ...request.exchange_rates };
  if (request.connections !== null) updated.airport_connections = connectionPayload(request.connections);
  if (request.transfers !== null) updated.airport_transfer_estimates = transferPayload(updated, request.transfers, catalog);
  const offers = request.estimates.length ? sharedFareOffers(trip, request.estimates) : [], replaced = new Set(offers.map(o => o.id));
  if (request.estimates.length) {
    updated.offers = [...trip.offers.filter(o => !replaced.has(o.id)), ...offers];
    updated.journey_pricing_rules = reusableJourneyRules(trip, request.estimates);
  }
  const targets: Record<Deletion["kind"], Set<string>> = {
    offer: new Set(trip.offers.filter(o => o.source === "user").map(o => o.id)), journey_rule: new Set((trip.journey_pricing_rules ?? []).map(r => r.id)),
    exchange_rate: new Set(Object.keys(trip.spec.exchange_rates).filter(c => c !== "MYR")),
    airport_change: new Set((trip.airport_connections ?? []).map(c => c.from_airport + ">" + c.to_airport)),
    airport_transfer: new Set((trip.airport_transfer_estimates ?? []).map(e => JSON.stringify([e.from_id, e.to_id, e.adults, e.mode]))),
  };
  const removed: Record<Deletion["kind"], Set<string>> = { offer: new Set(), journey_rule: new Set(), exchange_rate: new Set(), airport_change: new Set(), airport_transfer: new Set() };
  for (const deletion of request.deletions) {
    if (!targets[deletion.kind].has(deletion.id)) reject("A deletion must identify an existing user-entered value in this trip. MYR and provider data cannot be deleted.");
    removed[deletion.kind].add(deletion.id);
  }
  if (Object.keys(request.exchange_rates).some(key => removed.exchange_rate.has(key))) reject("Do not update and delete the same exchange rate in one batch.");
  if (request.estimates.length && (offers.some(o => removed.offer.has(o.id)) || request.estimates.some(e => e.scope && removed.journey_rule.has("journey-estimate:" + stableId(e.scope))))) reject("Do not update and delete the same saved price in one batch.");
  if (removed.offer.size) updated.offers = updated.offers.filter(o => !removed.offer.has(o.id));
  if (removed.journey_rule.size) updated.journey_pricing_rules = (updated.journey_pricing_rules ?? []).filter(r => !removed.journey_rule.has(r.id));
  if (removed.exchange_rate.size) updated.spec.exchange_rates = Object.fromEntries(Object.entries(updated.spec.exchange_rates).filter(([key]) => !removed.exchange_rate.has(key)));
  if (removed.airport_change.size) updated.airport_connections = (updated.airport_connections ?? []).filter(c => !removed.airport_change.has(c.from_airport + ">" + c.to_airport));
  if (removed.airport_transfer.size) updated.airport_transfer_estimates = (updated.airport_transfer_estimates ?? []).filter(e => !removed.airport_transfer.has(JSON.stringify([e.from_id, e.to_id, e.adults, e.mode])));
  updated.revision++; delete updated.result;
  return updated;
}
/**
 * applyMissingInfo for a trip that reads the airport transfer ways shared by all trips. The request holds the ways in
 * effect for the trip's directions, as the planner shows them. A direction whose ways change is saved for all trips
 * (`shared`, with the directions in `changed`) and the trip's own ways for it go away. A direction that does not
 * change keeps its source: the trip's own ways or the shared ones. `shared` is null when no shared way changes.
 */
export function applyWithSharedTransfers(trip: PlannerTrip, request: ApplyChanges, catalog: AirportCatalog, shared: AirportTransferEstimate[]): { trip: PlannerTrip; shared: AirportTransferEstimate[] | null; changed: AirportTransferEstimate[] } {
  if (request.transfers === null && !request.deletions.some(deletion => deletion.kind === "airport_transfer")) return { trip: applyMissingInfo(trip, request, catalog), shared: null, changed: [] };
  const direction = (item: Pick<AirportTransferEstimate, "from_id" | "to_id">) => JSON.stringify([item.from_id, item.to_id]);
  const allowed = new Set(airportTransferRows(parseSpec(trip.spec), trip.snapshot?.movements ?? [], catalog).map(direction));
  const own = (trip.airport_transfer_estimates ?? []).map(parseTransfer), known = shared.map(parseTransfer);
  const before = effectiveTransfers(own, known.filter(item => allowed.has(direction(item))));
  const next = applyMissingInfo({ ...trip, airport_transfer_estimates: before }, request, catalog), after = next.airport_transfer_estimates ?? [];
  // A fixed price reads the same with or without its highest price.
  const ways = (items: AirportTransferEstimate[], key: string) => JSON.stringify(items.filter(item => transferKey(item) === key)
    .map(item => [item.mode, item.duration_minutes, item.low, item.high ?? item.low, item.currency]).sort());
  const changed = [...new Map([...before, ...after].filter(item => allowed.has(direction(item))).map(item => [transferKey(item), item])).entries()]
    .filter(([key]) => ways(before, key) !== ways(after, key));
  const keys = new Set(changed.map(([key]) => key));
  next.airport_transfer_estimates = own.filter(item => !keys.has(transferKey(item)));
  return { trip: next, changed: changed.map(([, item]) => item),
    shared: keys.size ? [...known.filter(item => !keys.has(transferKey(item))), ...after.filter(item => keys.has(transferKey(item)))] : null };
}
export function saveSharedEstimates(trip: PlannerTrip, estimates: SharedFare[], revision: number): PlannerTrip {
  requireRevision(trip, revision);
  const offers = sharedFareOffers(trip, estimates), replaced = new Set(offers.map(o => o.id));
  return { ...trip, offers: [...trip.offers.filter(o => !replaced.has(o.id)), ...offers], journey_pricing_rules: reusableJourneyRules(trip, estimates), revision: trip.revision + 1 };
}
export function reuseJourneyEstimate(trip: PlannerTrip, request: SharedFare & { expected_revision: number; group_by: JourneyGroupField[] }, catalog: AirportCatalog): PlannerTrip {
  requireRevision(trip, request.expected_revision);
  if (request.group_by.length > 7 || new Set(request.group_by).size !== request.group_by.length) reject("Choose each grouping field once.");
  if (request.group_by.some(key => !journeyGroupFields.some(field => field.key === key))) reject("Choose a supported grouping field.");
  const movements = new Map(fareMovements(trip).map(m => [m.id, m]));
  const offers = new Map(trip.offers.filter(o => o.source === "user" && o.label.startsWith("Shared estimate:") && o.movement_ids.length === 1).map(o => [o.movement_ids[0], o]));
  const groups = new Map<string, SharedFare>();
  for (const key of request.component_ids) {
    const offer = offers.get(key), m = movements.get(key);
    if (!m || !offer || offer.adults != null && offer.adults !== trip.spec.adults || offer.low !== request.low || offer.high !== request.high || offer.currency !== request.currency.toUpperCase() || offer.label !== request.label) reject("Choose an unchanged saved group price for these journeys.");
    const scope = journeyPriceScope(parseMovement(m), trip.spec.adults, request.group_by), signature = stableId(scope);
    if (!groups.has(signature)) groups.set(signature, { ...request, component_ids: [], scope });
    groups.get(signature)!.component_ids.push(key);
  }
  const updated = applyMissingInfo(trip, { expected_revision: request.expected_revision, connections: null, transfers: null, estimates: [...groups.values()], exchange_rates: {}, deletions: [] }, catalog);
  const ids = new Set(request.component_ids.map(key => offers.get(key)!.id));
  updated.offers = updated.offers.filter(o => !ids.has(o.id));
  return updated;
}
export function removeJourneyRule(trip: PlannerTrip, ruleId: string, revision: number): PlannerTrip {
  requireRevision(trip, revision);
  const rules = (trip.journey_pricing_rules ?? []).filter(r => r.id !== ruleId);
  if (rules.length === (trip.journey_pricing_rules ?? []).length) reject("Reusable estimate not found.", 404);
  const updated = { ...trip, journey_pricing_rules: rules, revision: trip.revision + 1 }; delete updated.result; return updated;
}
export function editFare(trip: PlannerTrip, offerId: string, raw: unknown): PlannerTrip {
  const offer = parseOffer(raw);
  if (offer.id !== offerId) reject("Offer ID must match its URL.");
  const routes = [...(trip.result?.routes ?? []), ...(trip.result?.dominated_routes ?? [])], snapshot = trip.snapshot;
  const known = new Set([...(snapshot?.movements ?? []).flatMap(m => [m.id, ...m.charges.map(c => c.id)]), ...routes.flatMap(r => [...r.movements.map(m => m.id), ...r.extra_charges.map(c => c.id)])]);
  if (offer.movement_ids.some(id => !known.has(id))) reject("Every fare component must belong to this trip's retrieved movements or current rental charges.");
  if (["round-trip", "multi-city"].includes(offer.kind)) {
    const byId = new Map((snapshot?.movements ?? []).map(m => [m.id, m])), covered = offer.movement_ids.map(id => byId.get(id));
    if (covered.length < 2 || covered.some(m => !m || m.mode !== "flight")) reject("Flight bundles must cover at least two retrieved flight journeys.");
    if (offer.kind === "round-trip" && (covered.length !== 2 || covered[0]!.from_id !== covered[1]!.to_id || covered[0]!.to_id !== covered[1]!.from_id)) reject("A round-trip ticket must cover two opposite-direction journeys.");
  }
  return { ...trip, offers: [...trip.offers.filter(o => o.id !== offer.id), { ...offer, source: "user", validated: true, adults: parseSpec(trip.spec).adults }], revision: trip.revision + 1 };
}
export function addAssumedMovement(trip: PlannerTrip, raw: unknown): PlannerTrip {
  const movement = parseMovement(raw), spec = parseSpec(trip.spec), places = placesOf(spec);
  if (!places.has(movement.from_id) || !places.has(movement.to_id)) reject("An assumed connection must join places in this trip.");
  movement.source = "User-defined connection"; movement.assumptions.push("User-defined travel time and connectivity");
  const snapshot: Snapshot = structuredClone(trip.snapshot ?? { revision: 0, discovery_key: discoveryKey(spec), movements: [], offers: [], roads: {}, coverage: { discovery_complete: false } });
  snapshot.movements = [...snapshot.movements.filter(m => m.id !== movement.id), movement]; snapshot.revision++;
  return { ...trip, snapshot, revision: trip.revision + 1 };
}
export function removeAssumedMovement(trip: PlannerTrip, movementId: string, revision: number): PlannerTrip {
  requireRevision(trip, revision);
  const movement = trip.snapshot?.movements.find(m => m.id === movementId);
  if (!movement || movement.source !== "User-defined connection") reject("Assumed connection not found.", 404);
  const snapshot = structuredClone(trip.snapshot!);
  snapshot.movements = snapshot.movements.filter(m => m.id !== movementId); snapshot.revision++;
  return { ...trip, snapshot, revision: trip.revision + 1 };
}
