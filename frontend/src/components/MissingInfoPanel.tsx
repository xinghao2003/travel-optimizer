import { TemporalInput } from "./ui/temporal-input";
import { Select, SelectItem } from "./ui/select";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { CircleCheck } from "lucide-react";
import { Button } from "./ui/button";
import { AirportTransfers } from "./AirportTransferTable";
import { InfoTip } from "./InfoTip";
import { GroupPrices, JourneyPrices, type AppliedSharedFareGroup } from "./MissingFaresTable";
import { Field, MissingSection, RulesEditor, Staged, focusNextPrice } from "./PlannerForms";
import { airportChangeFieldId, airportChangeProblems, savedAirportChange, transferModes, type AirportChangeDraft, type PriceValue, type SharedFare } from "../lib/drafts";
import { blankConnectionForm, bundleStatusLabel, connectionFromForm, connectionText, modeLabel, quoteLinkText, type AirportChangeRow, type ConnectionErrors, type ConnectionForm, type OptionsTarget, type TransferDirection } from "../lib/present";
import type { MissingFareGroup } from "../lib/missingFares";
import { modes, type AirportConnection, type AirportTransferEstimate, type Coverage, type Mode, type Movement, type Offer, type Place, type PricingRule } from "../lib/planner";
import type { TripDraftsApi } from "../lib/useTripDrafts";
import type { JourneyGroupField } from "../lib/planner";

const count = (n: number, word: string) => `${n} ${n === 1 ? word : `${word}s`}`;
const sentence = (message: string) => message.charAt(0).toUpperCase() + message.slice(1);
const blankChange: AirportChangeDraft = { mode: "", duration: "", fare: "", currency: "MYR" };
// "Gimpo International Airport" → "Gimpo International" (F2 row 1).
const airportName = (name: string) => name.replace(/ Airport$/, "");
type BundleLink = NonNullable<Coverage["bundle_links"]>[number];

/**
 * One airport change (F2 row 1): the pair, its journeys, and a draft of the transfer between the two airports, staged on
 * every change. Clear (a required pair) and Remove (a saved pair that no journey needs now) are drafts too. The field ids
 * are airportChangeFieldId(), which Next steps, the itinerary and "Fix {k} values" focus.
 */
function AirportChange({ row, connection, adults, drafts }: { row: AirportChangeRow; connection: AirportConnection | undefined; adults: number; drafts: TripDraftsApi }) {
  const key = `${row.from_airport}>${row.to_airport}`;
  const saved = savedAirportChange(connection);
  const staged = key in drafts.drafts.airportChanges;
  const current = staged ? drafts.drafts.airportChanges[key] : saved;
  const shown = current ?? blankChange;
  const problems = staged ? airportChangeProblems(current) : [];
  const errorOf = (field: keyof AirportChangeDraft) => {
    const problem = problems.find(item => item.field === field);
    return problem && sentence(problem.message);
  };
  const id = (field: keyof AirportChangeDraft) => airportChangeFieldId(key, field);
  // Changes build on the latest drafts: a keystroke can follow a change in the same event loop turn.
  const latest = () => {
    const changes = drafts.read().airportChanges;
    return (key in changes ? changes[key] : saved) ?? blankChange;
  };
  const change = (field: keyof AirportChangeDraft, value: string) => drafts.stageAirportChange(key, { ...latest(), [field]: value }, saved);
  const empty = !current || (!current.mode && !current.duration.trim() && !current.fare.trim());
  const focusWay = () => document.getElementById(id("mode"))?.focus();
  function clear() { drafts.stageAirportChange(key, null, saved); focusWay(); }
  function undo() { drafts.unstage("airportChanges", key); focusWay(); }
  // Esc restores a field's value from when it got focus.
  const started = useRef<{ field: keyof AirportChangeDraft; value: string } | null>(null);
  const fieldProps = (field: keyof AirportChangeDraft) => ({
    id: id(field), name: field,
    onFocus: (event: { target: { value: string } }) => { started.current = { field, value: event.target.value }; },
  });
  const pair = `${row.from_airport} → ${row.to_airport}`;
  const names = airportName(row.from_name) === row.from_airport ? "" : ` · ${airportName(row.from_name)} → ${airportName(row.to_name)}`;
  return <li className="p-mi-item" onKeyDown={event => {
    // Keys that a control inside already handled.
    if (event.defaultPrevented) return;
    const target = event.target as HTMLElement;
    if (event.key === "Escape" && started.current && target.getAttribute("name") === started.current.field) {
      event.preventDefault();
      change(started.current.field, started.current.value);
    } else if (event.key === "Enter" && !event.ctrlKey && !event.metaKey && target.hasAttribute("data-price-input")) {
      event.preventDefault();
      focusNextPrice(target, event.shiftKey);
    }
  }}>
    <div className="p-mi-item-head">
      <span className="p-mi-item-title">{pair}{names}</span>
      {row.required
        ? <span className="p-mi-item-status" data-tone={row.unresolved_journey_count > 0 ? "warn" : undefined}>{count(row.journey_count, "journey")} · {row.unresolved_journey_count} can't be used</span>
        : <span className="p-mi-item-status">Saved · not used now</span>}
    </div>
    <div className="p-mi-fields" role="group" aria-label={`Airport change ${pair}`}>
      <Field label="Way" error={errorOf("mode")}>
        <Select {...fieldProps("mode")} value={shown.mode} onValueChange={value => change("mode", value)}>
          <SelectItem value="">Choose</SelectItem>
          {transferModes.map(mode => <SelectItem value={mode} key={mode}>{modeLabel(mode)}</SelectItem>)}
        </Select>
      </Field>
      <Field label="Time (min)" error={errorOf("duration")}>
        <input {...fieldProps("duration")} type="text" inputMode="numeric" value={shown.duration} onChange={event => change("duration", event.target.value)} />
      </Field>
      <Field label={`Price for ${count(adults, "adult")} (optional)`} error={errorOf("fare")}>
        <input {...fieldProps("fare")} type="text" inputMode="decimal" data-price-input placeholder="Not priced" value={shown.fare} onChange={event => change("fare", event.target.value)} />
      </Field>
      <Field label="Currency" error={errorOf("currency")} className="p-price-currency">
        <input {...fieldProps("currency")} maxLength={3} value={shown.currency} onChange={event => change("currency", event.target.value.toUpperCase())} />
      </Field>
      <Button type="button" size="sm" variant="secondary" className="p-mi-clear" disabled={empty} onClick={clear}>{row.required ? "Clear" : "Remove"}<span className="sr-only">: {pair}</span></Button>
    </div>
    {staged && <Staged label={pair} what={current === null && saved ? row.required ? "Cleared" : "Removed" : undefined} onUndo={undo} />}
  </li>;
}

/** Missing info › Airport changes (F2 row 1): pairs that journeys need, then saved pairs that no journey needs now. */
function AirportChanges({ rows, connections, adults, drafts }: { rows: AirportChangeRow[]; connections: AirportConnection[]; adults: number; drafts: TripDraftsApi }) {
  if (!rows.length) return null;
  const toConfirm = rows.filter(row => row.unresolved_journey_count > 0).length;
  const list = (items: AirportChangeRow[]) => <ul className="p-mi-list">{items.map(row => <AirportChange key={`${row.from_airport}>${row.to_airport}`} row={row} adults={adults} drafts={drafts}
    connection={connections.find(item => item.from_airport === row.from_airport && item.to_airport === row.to_airport)} />)}</ul>;
  const required = rows.filter(row => row.required), others = rows.filter(row => !row.required);
  return <MissingSection id="airport-changes-title" title="Airport changes" status={toConfirm ? `${toConfirm} to confirm` : "Done"} warn={toConfirm > 0}
    tip="Some flights land at one airport and continue from another. Enter a transfer you checked. Its time must include your own buffer and fit the layover. One entry applies to every journey with this change. The other direction is a separate entry. A blank price stays not priced.">
    {required.length > 0 && list(required)}
    {others.length > 0 && <details className="p-mi-more"><summary>Other saved airport changes ({others.length})</summary>{list(others)}</details>}
  </MissingSection>;
}

/**
 * Missing info › Connections between cities (F2 row 4): city pairs with no journey in either direction, the connections
 * you added (Remove), and Add a connection. Add and Remove are immediate (F6). Fixed times are read in each city's own
 * time zone (I6 item 6). "Add {A → B}" fills the form, opens it and focuses Transport. Its summary is #add-connection.
 */
function Connections({ places, gaps, assumed, placeName, zoneOf, busy, onAdd, onRemove }: {
  places: Place[]; gaps: { from_id: string; to_id: string }[]; assumed: Movement[];
  placeName: (id: string) => string; zoneOf: (id: string) => string; busy: boolean;
  onAdd: (movement: Movement) => Promise<void>; onRemove: (movementId: string) => void;
}) {
  const [form, setForm] = useState<ConnectionForm>(blankConnectionForm);
  const [errors, setErrors] = useState<ConnectionErrors & { save?: string }>({});
  const [saving, setSaving] = useState(false);
  const [focusId, setFocusId] = useState<string | null>(null);
  const details = useRef<HTMLDetailsElement>(null);
  useEffect(() => { if (focusId) { document.getElementById(focusId)?.focus(); setFocusId(null); } }, [focusId]);
  const set = (change: Partial<ConnectionForm>) => setForm(current => ({ ...current, ...change }));
  function prefill(from_id: string, to_id: string) {
    set({ from: from_id, to: to_id }); setErrors({});
    if (details.current) details.current.open = true;
    setFocusId("connection-mode");
  }
  async function add() {
    const found = connectionFromForm(form, zoneOf, `assumed:${crypto.randomUUID()}`);
    if (found.errors) { setErrors(found.errors); return; }
    setErrors({}); setSaving(true);
    try { await onAdd(found.movement); setForm(blankConnectionForm()); }
    catch (err) { setErrors({ save: err instanceof Error ? err.message : "The connection could not be added." }); }
    finally { setSaving(false); }
  }
  const from = places.find(place => place.id === form.from), to = places.find(place => place.id === form.to);
  const placeSelect = (key: "from" | "to") => <Select id={`connection-${key}`} value={form[key]} onValueChange={value => set({ [key]: value })}>
    <SelectItem value="">Choose a place</SelectItem>
    {places.map(place => <SelectItem key={place.id} value={place.id}>{place.name}</SelectItem>)}
  </Select>;
  const dateField = (key: "departure" | "arrival", label: string) => <Field label={label} error={errors[key]}>
    <TemporalInput type="datetime-local" value={form[key]} onValueChange={value => set({ [key]: value })} />
  </Field>;
  return <MissingSection id="connections-title" title="Connections between cities" status={gaps.length ? count(gaps.length, "gap") : undefined}
    tip="No direct journey was found in either direction. Routes through other places can still connect these cities. A connection you add is assumed to exist.">
    {gaps.length > 0 && <ul className="p-mi-list">{gaps.map(gap => {
      const a = placeName(gap.from_id), b = placeName(gap.to_id);
      return <li key={`${gap.from_id}>${gap.to_id}`} className="p-mi-item">
        <span className="p-mi-item-title">{a} and {b}: no direct journey found.</span>
        <div className="p-mi-actions">
          <Button type="button" size="sm" variant="secondary" onClick={() => prefill(gap.from_id, gap.to_id)}>Add {a} → {b}</Button>
          <Button type="button" size="sm" variant="secondary" onClick={() => prefill(gap.to_id, gap.from_id)}>Add {b} → {a}</Button>
        </div>
      </li>;
    })}</ul>}
    {assumed.length > 0 && <div className="p-mi-added">
      <h4>Connections you added</h4>
      <ul className="p-item-rows">{assumed.map(movement => {
        const text = connectionText(movement, placeName, zoneOf);
        return <li key={movement.id}><span>{text}</span>
          <button type="button" className="p-text-button" aria-label={`Remove connection ${text}`} disabled={busy} onClick={() => onRemove(movement.id)}>Remove</button>
        </li>;
      })}</ul>
    </div>}
    <details ref={details} className="p-mi-more">
      <summary id="add-connection">Add a connection</summary>
      <div className="p-group-fields">
        <Field label="From">{placeSelect("from")}</Field>
        <Field label="To" error={errors.places}>{placeSelect("to")}</Field>
        <Field label="Transport"><Select id="connection-mode" value={form.mode} onValueChange={value => set({ mode: value as Mode })}>
          {modes.map(mode => <SelectItem key={mode} value={mode}>{modeLabel(mode)}</SelectItem>)}
        </Select></Field>
        <fieldset className="p-mi-radios">
          <legend className="sr-only">Times</legend>
          <label className="p-check"><input type="radio" name="connection-times" checked={!form.fixed} onChange={() => set({ fixed: false })} />Any time</label>
          <label className="p-check"><input type="radio" name="connection-times" checked={form.fixed} onChange={() => set({ fixed: true })} />Fixed times</label>
        </fieldset>
        {form.fixed ? <>
          {dateField("departure", `Departs (${from?.name ?? "origin"} time)`)}
          {dateField("arrival", `Arrives (${to?.name ?? "destination"} time)`)}
        </> : <Field label="Travel time (hours)" error={errors.hours}>
          <input type="text" inputMode="decimal" value={form.hours} onChange={event => set({ hours: event.target.value })} />
        </Field>}
        <Field label="Distance in km (optional)" error={errors.distance}>
          <input type="text" inputMode="decimal" value={form.distance} onChange={event => set({ distance: event.target.value })} />
        </Field>
      </div>
      <div className="p-form-actions">
        <Button type="button" size="sm" variant="secondary" disabled={busy || saving} onClick={() => void add()}>{saving ? "Adding…" : "Add connection"}</Button>
        {errors.save && <p className="p-field-error" role="alert">{errors.save}</p>}
      </div>
    </details>
  </MissingSection>;
}

/** Missing info › Combined tickets to check (F2 row 5): combined-ticket searches whose price the search can't read. */
function CombinedTickets({ links, placeName }: { links: BundleLink[]; placeName: (id: string) => string }) {
  if (!links.length) return null;
  return <MissingSection id="combined-tickets-title" title="Combined tickets to check" status={String(links.length)} collapsed
    tip="The search can't read these prices. Open the search, then enter the total on an option: Tickets and prices › Add a combined ticket price.">
    <ul className="p-mi-list">{links.map((link, index) => <li key={index} className="p-mi-item p-mi-link">
      {quoteLinkText(link, placeName)} · {bundleStatusLabel(link.status)} · <a href={link.url} target="_blank" rel="noreferrer">Open search<span className="sr-only"> (opens in a new tab)</span></a>
    </li>)}</ul>
  </MissingSection>;
}

/**
 * The Missing info panel (C8, F2): its heading and status, then the sections in priority order (F3). Airport changes,
 * airport transfers and prices are drafts in this browser until Apply (F4); connections and price rules save at once (F6).
 * Before a search, only Airport transfers and Price rules show (C12).
 */
export function MissingInfoPanel({ searched, allClear, needs, needsText, airportChanges, connections, directions, estimates, accessNote, journeyGroups, appliedGroups,
  adults, rates, draftRates, drafts, fares, canonical, offerFor, places, placeName, zoneOf, stagePrice, stageComponent, removePrice, addRate,
  gaps, assumed, addConnection, removeConnection, bundleLinks, rules, saveRule, deleteRule, busy, onAction, onApply, grouping, onGrouping, removeJourneyRule, reuseJourneyEstimate, csvActions }: {
  csvActions?: ReactNode;
  searched: boolean; allClear: boolean; needs: number; needsText: string;
  airportChanges: AirportChangeRow[]; connections: AirportConnection[];
  directions: TransferDirection[]; estimates: AirportTransferEstimate[]; accessNote: string | null;
  /** splitGroups().journeys, and the group prices saved on this trip. */
  journeyGroups: MissingFareGroup[]; appliedGroups: AppliedSharedFareGroup[];
  grouping: JourneyGroupField[]; onGrouping: (fields: JourneyGroupField[]) => void; removeJourneyRule: (id: string) => void;
  reuseJourneyEstimate: (group: AppliedSharedFareGroup) => void;
  adults: number; rates: Record<string, number>; draftRates: Record<string, number>;
  drafts: TripDraftsApi; fares: Record<string, SharedFare>; canonical: (id: string) => string; offerFor: (id: string) => Offer | undefined;
  places: Place[]; placeName: (id: string) => string; zoneOf: (id: string) => string;
  stagePrice: (key: string, fare: SharedFare, saved?: PriceValue | null) => void; stageComponent: (componentId: string, value: PriceValue, label: string) => void;
  removePrice: (offerId: string) => void; addRate: (currency: string, rate: number) => void;
  gaps: { from_id: string; to_id: string }[]; assumed: Movement[];
  addConnection: (movement: Movement) => Promise<void>; removeConnection: (movementId: string) => void;
  bundleLinks: BundleLink[];
  rules: PricingRule[]; saveRule: (rule: PricingRule) => Promise<void>; deleteRule: (rule: PricingRule) => Promise<void>;
  busy: boolean; onAction: (target: OptionsTarget) => void; onApply: () => void;
}) {
  // Fare drafts that no row shows: rows of Journey prices, journeys of airport transfers, and group prices.
  const shownKeys = new Set([
    ...journeyGroups.flatMap(group => [group.key, ...group.components.map(component => `component:${canonical(component.component_id)}`)]),
    ...directions.flatMap(direction => direction.journeys.map(journey => `component:${journey.charge.id}`)),
    ...appliedGroups.map(group => group.key),
  ]);
  const others = Object.entries(fares).filter(([key]) => !shownKeys.has(key));
  const unstageFare = (key: string) => drafts.unstage("fares", key);
  return <>
    <div className="p-panel-heading">
      <div><h2 id="missing-title" tabIndex={-1}>Missing info</h2><InfoTip topic="Missing info">Information the search could not find. What you enter here is a draft in this browser until you select Apply. Apply updates your options once.</InfoTip></div>
      <span className="p-missing-status">{allClear && <CircleCheck size={15} aria-hidden="true" />}{searched && needs ? needsText : allClear ? "Nothing missing" : "Nothing to check yet"}</span>
    </div>
    {csvActions}
    {!searched && <p className="p-mi-intro">Unknown prices and gaps appear here after a search. You can enter airport transfers now.</p>}
    {allClear && <p className="p-mi-intro">Every option has a complete price and every journey can be used.</p>}
    <AirportChanges rows={airportChanges} connections={connections} adults={adults} drafts={drafts} />
    <AirportTransfers directions={directions} estimates={estimates} adults={adults} searched={searched} drafts={drafts} fares={fares} accessNote={accessNote}
      placeName={placeName} zoneOf={zoneOf} rates={rates} draftRates={draftRates} addRate={addRate} stageComponent={stageComponent} removePrice={removePrice} busy={busy} onAction={onAction} onApply={onApply} />
    {(searched || others.length > 0) && <JourneyPrices groups={journeyGroups} others={others} fares={fares} adults={adults} rates={rates} draftRates={draftRates} grouping={grouping} onGrouping={onGrouping}
      canonical={canonical} offerFor={offerFor} placeName={placeName} zoneOf={zoneOf} stagePrice={stagePrice} stageComponent={stageComponent}
      unstage={unstageFare} removePrice={removePrice} addRate={addRate} busy={busy} onApply={onApply} />}
    {searched && <Connections places={places} gaps={gaps} assumed={assumed} placeName={placeName} zoneOf={zoneOf} busy={busy} onAdd={addConnection} onRemove={removeConnection} />}
    <CombinedTickets links={bundleLinks} placeName={placeName} />
    <GroupPrices groups={appliedGroups} fares={fares} adults={adults} stagePrice={stagePrice} unstage={unstageFare} onApply={onApply} removeRule={removeJourneyRule} reuseEstimate={reuseJourneyEstimate} grouping={grouping} busy={busy} />
    <RulesEditor rules={rules} places={places} placeName={placeName} busy={busy} onSave={saveRule} onDelete={deleteRule} />
  </>;
}
