import { Select, SelectItem } from "./ui/select";
import { lazy, Suspense, useId, useRef, useState, type ComponentProps } from "react";
import { ArrowLeft, ChevronDown, CircleAlert } from "lucide-react";
import { Button } from "./ui/button";
import { ComparisonPicker } from "./ComparisonPicker";
import { InfoTip } from "./InfoTip";
import { ModeIcon } from "./ModeIcon";
import { Field, FixedPriceFields, Staged } from "./PlannerForms";
import { storedOfferId, type DraftPrice, type DraftTarget, type PriceValue } from "../lib/drafts";
import { assumptionNotes, bundleStatusLabel, compareText, dateRange, dayByDay, formatDuration, formatLocal, hoursText, journeyChips, journeySource, journeyWhen, mainService, matchingQuoteLinks, moneyShort, optionChips, optionNumber, perCityHourText, priceInputErrors, priceText, quoteLinkText, stepLabel, ticketJourney, ticketRows, unpricedSummary, type OptionChip, type OptionsTarget, type TicketRow } from "../lib/present";
import type { Charge, Coverage, Movement, Offer, Place, Route } from "../lib/planner";

type BundleLink = NonNullable<Coverage["bundle_links"]>[number];
const adultsText = (adults: number) => `${adults} adult${adults === 1 ? "" : "s"}`;
const newTab = <span className="sr-only"> (opens in a new tab)</span>;

const LazyMap = lazy(() => import("./PlannerMap").then(m => ({ default: m.PlannerMap })));
function PlannerMap(props: ComponentProps<typeof LazyMap>) {
  return <Suspense fallback={<div className="p-map-loading" role="status">Loading map…</div>}><LazyMap {...props} /></Suspense>;
}

function Chips({ chips }: { chips: OptionChip[] }) {
  return <>{chips.map(chip => <span className="p-chip" data-tone={chip.tone} key={chip.text}>{chip.tone === "warn" && <CircleAlert size={12} aria-hidden="true" />}{chip.text}</span>)}</>;
}

/** One journey of Day by day (E9.3): a summary line, then its steps, the timetable notice, the source and Search fare. */
function Journey({ movement, route, open, zoneOf, placeName, rates }: {
  movement: Movement; route: Route; open: boolean; zoneOf: (id: string) => string; placeName: (id: string) => string; rates: Record<string, number>;
}) {
  const service = mainService(movement);
  return <details className="p-journey" open={open}>
    <summary>
      <ChevronDown size={16} className="p-chevron" aria-hidden="true" />
      <span className="p-journey-head">
        <span className="p-journey-line"><span className="p-journey-when">{journeyWhen(movement, zoneOf(movement.from_id), zoneOf(movement.to_id))}</span><span className="p-journey-duration">{formatDuration(movement.duration_minutes)}</span></span>
        <span className="p-journey-line">
          <span className="p-journey-route">{placeName(movement.from_id)} → {placeName(movement.to_id)}</span>
          <span className="p-journey-service"><ModeIcon mode={movement.mode} />{service}</span>
          <Chips chips={journeyChips(route, movement, rates)} />
        </span>
      </span>
    </summary>
    <div className="p-journey-body">
      {movement.segments.length > 0 && <ol className="p-steps">{movement.segments.map((segment, index) => {
        const step = stepLabel(segment, movement);
        return <li key={index} data-warning={step.warning || undefined}>
          <span className="p-step-time">{segment.departure && formatLocal(segment.departure, segment.from_timezone ?? zoneOf(movement.from_id), "time")}</span>
          <span>{step.warning && <CircleAlert size={13} className="p-step-icon" aria-hidden="true" />}{step.text}</span>
        </li>;
      })}</ol>}
      {movement.schedule_estimated && <p className="p-notice">Estimated timetable · {movement.schedule_reference_date ? `copied from ${dateRange(movement.schedule_reference_date, movement.schedule_reference_date)}` : "from an extended provider calendar"}. Check the real timetable before you book.</p>}
      <p className="p-journey-source">{journeySource(movement)}{movement.search_url && <> · <a href={movement.search_url} target="_blank" rel="noreferrer">Search fare<span className="sr-only"> (opens in a new tab)</span></a></>}</p>
    </div>
  </details>;
}

type PriceErrors = Partial<Record<"flights" | "low" | "high" | "currency" | "save", string>>;
/** What Set price stages: a price for every transfer of the journey's airport transfer direction, or for this journey. */
type Scope = "all" | "journey";

/**
 * Set price for one journey or charge (E9.4, C11 PriceEditor). It stages a draft that the Apply bar sends; nothing is
 * saved here. "Range" with a blank highest price is an open-ended price, which only a single journey can have.
 * `direction` is the airport transfer row of an access or egress charge: the editor then asks whether the price is
 * for all transfers of that direction or only this journey (`date`). Enter sets the price, Ctrl/Cmd+Enter sets it and
 * applies, Esc cancels (without `onClose`, it restores the values). `name` is the row it prices, for screen readers.
 */
function PriceEditor({ name, initial, adults, direction, date, defaultScope, ownPrice, applying, onSet, onApply, onClose, autoFocus = false }: {
  name: string; initial: PriceValue | null; adults: number; direction: string | null; date: string | null; defaultScope: Scope; ownPrice: boolean;
  applying: boolean; onSet: (value: PriceValue, scope: Scope) => void; onApply: () => void; onClose?: () => void; autoFocus?: boolean;
}) {
  const start = () => {
    const range = !!initial && initial.high !== initial.low;
    return { low: initial?.low.toString() ?? "", range, high: range ? initial?.high?.toString() ?? "" : "", currency: initial?.currency ?? "MYR" };
  };
  const [values, setValues] = useState(start);
  const [scope, setScope] = useState<Scope>(direction ? defaultScope : "journey");
  const [errors, setErrors] = useState<PriceErrors>({});
  const scopeName = useId();
  const { low, range, high, currency } = values;
  const set = (change: Partial<typeof values>) => setValues(current => ({ ...current, ...change }));
  function stage() {
    const found: PriceErrors = priceInputErrors(low, range ? high : "", currency);
    // A price for all transfers of a direction is fixed or a range: a blank highest price there means a fixed price.
    if (!found.low && scope === "all" && range && high.trim() === "") found.high = "Enter the highest price, or choose Only this journey.";
    setErrors(found);
    if (Object.keys(found).length) return false;
    const value = Number(low);
    onSet({ low: value, high: !range ? value : high.trim() === "" ? null : Number(high), currency: currency.trim().toUpperCase() }, scope);
    onClose?.();
    return true;
  }
  function cancel() {
    if (onClose) onClose();
    else { setValues(start()); setErrors({}); }
  }
  return <div className="p-price-editor" role="group" aria-label={name} inert={applying} onKeyDown={event => {
    if (event.key === "Escape") { event.preventDefault(); cancel(); }
    else if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); if (stage()) onApply(); }
    else if (event.key === "Enter" && event.target instanceof HTMLInputElement && event.target.type === "text") { event.preventDefault(); stage(); }
  }}>
    {direction && <fieldset className="p-price-scope">
      <legend>Applies to</legend>
      <label className="p-check"><input type="radio" name={scopeName} checked={scope === "all"} onChange={() => setScope("all")} />All {direction} transfers in this trip</label>
      <label className="p-check"><input type="radio" name={scopeName} checked={scope === "journey"} onChange={() => setScope("journey")} />Only this journey{date && ` (${date})`}</label>
      {scope === "all" && ownPrice && <small>Your price for this journey still applies to it. Remove my price to use the price for all transfers.</small>}
    </fieldset>}
    <Field label={`Price for ${adultsText(adults)}`} error={errors.low}>
      <input type="text" inputMode="decimal" placeholder="Not priced" value={low} autoFocus={autoFocus} onChange={event => set({ low: event.target.value })} />
    </Field>
    <label className="p-check"><input type="checkbox" checked={range} onChange={event => set({ range: event.target.checked })} />Range</label>
    {range && <Field label="Highest price" error={errors.high} hint={high.trim() === "" && scope === "journey" ? "No upper limit: the total stays incomplete." : undefined}>
      <input type="text" inputMode="decimal" placeholder={scope === "journey" ? "No limit" : undefined} value={high} onChange={event => set({ high: event.target.value })} />
    </Field>}
    <Field label="Currency" error={errors.currency} className="p-price-currency">
      <input maxLength={3} value={currency} onChange={event => set({ currency: event.target.value.toUpperCase() })} />
    </Field>
    <div className="p-price-actions">
      <Button type="button" size="sm" onClick={stage}>Set price</Button>
      {onClose && <Button type="button" size="sm" variant="ghost" onClick={onClose}>Cancel</Button>}
    </div>
  </div>;
}

/** The draft functions of the trip (Planner): what changes a row, and how Set price stages a price. */
type DraftProps = {
  draftFor: (target: DraftTarget) => DraftPrice | null; directionLabel: (charge: Charge) => string | null;
  stageComponent: (componentId: string, value: PriceValue, label: string) => void; stageDirection: (charge: Charge, value: PriceValue) => void;
  applying: boolean; onApply: () => void;
};
const changePair = (charge: Charge | null) => charge ? /^Airport transfer (\S+) → (\S+)$/.exec(charge.kind) : null;

/**
 * One row of Tickets and prices (E9.4): label, amount, source and the row's actions. Rows that are not priced carry
 * `data-unpriced`. A draft that changes the row shows its amount with "Not applied · Undo".
 */
function TicketItem({ row, draft, adults, busy, placeName, zoneOf, offerFor, drafts, onRemove, onAction, onEditAirportChange }: {
  row: TicketRow; draft: DraftPrice | null; adults: number; busy: boolean; placeName: (id: string) => string; zoneOf: (id: string) => string;
  offerFor: (id: string) => Offer | undefined; drafts: DraftProps; onRemove: (offerId: string) => void; onAction: (target: OptionsTarget) => void;
  onEditAirportChange: (key: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const toggle = useRef<HTMLButtonElement>(null);
  const { movement, charge } = row;
  const searchUrl = row.kind === "journey" ? movement?.search_url : null;
  const about = <span className="sr-only">: {row.label}</span>;
  const ownPrice = row.offer.source === "user";
  const direction = row.kind === "transfer" && charge ? drafts.directionLabel(charge) : null;
  const pair = row.kind === "change" ? changePair(charge) : null;
  // The editor opens with the draft, else the price in use (a rule or provider price too).
  const inUse = row.offer.low !== null ? { low: row.offer.low, high: row.offer.high, currency: row.offer.currency } : null;
  function close() { setEditing(false); toggle.current?.focus(); }
  // The Undo button goes away with the draft, so focus moves to the row's Set price (or Edit in Missing info).
  function undo() { draft?.undo(); toggle.current?.focus(); }
  return <li className="p-ticket" data-unpriced={!row.priced || undefined} tabIndex={row.priced ? undefined : -1}>
    <div className="p-ticket-line">
      <span className="p-ticket-label">{row.label}</span>
      <span className="p-ticket-amount" data-tone={draft ? "draft" : row.priced ? undefined : "warn"}>{draft ? draft.amount : row.amount}</span>
    </div>
    {row.kind === "combined" && <small className="p-ticket-flights">{row.flights.map(flight => ticketJourney(flight, placeName, zoneOf)).join("; ")}</small>}
    {draft && <Staged label={row.label} onUndo={undo} />}
    <div className="p-ticket-meta">
      {row.source && <span className="p-ticket-source">{row.source}</span>}
      {row.componentId && <button ref={toggle} type="button" className="p-link-button" aria-expanded={editing} onClick={() => setEditing(!editing)}>Set price{about}</button>}
      {searchUrl && <a href={searchUrl} target="_blank" rel="noreferrer">Search fare{newTab}</a>}
      {row.removable && <button type="button" className="p-link-button" disabled={busy} onClick={() => onRemove(storedOfferId(row.offer))}>{row.kind === "combined" ? "Remove" : "Remove my price"}{about}</button>}
      {row.kind === "change" && <button ref={toggle} type="button" className="p-link-button" onClick={() => pair ? onEditAirportChange(`${pair[1]}>${pair[2]}`) : onAction("airport-changes")}>Edit in Prices to add{about}</button>}
    </div>
    {editing && row.componentId && <PriceEditor name={row.label} adults={adults} autoFocus applying={drafts.applying} onApply={drafts.onApply} onClose={close}
      initial={draft?.value ?? inUse}
      direction={direction} date={movement?.departure ? formatLocal(movement.departure, zoneOf(movement.from_id), "date") : null}
      defaultScope={ownPrice || draft?.scope === "journey" ? "journey" : "all"} ownPrice={ownPrice}
      onSet={(value, scope) => scope === "all" && charge ? drafts.stageDirection(charge, value)
        : drafts.stageComponent(row.componentId!, value, charge ? charge.kind : `Standalone ${movement?.mode ?? "journey"} fare`)} />}
    {row.kind === "combined" && <details className="p-ticket-separate">
      <summary><ChevronDown size={16} className="p-chevron" aria-hidden="true" />Separate prices</summary>
      {row.flights.map(flight => {
        const name = `Flight ${ticketJourney(flight, placeName, zoneOf)}`;
        const componentId = flight.template_id ?? flight.id;
        const flightDraft = drafts.draftFor({ componentId, charge: null, ownPrice: false });
        const offer = offerFor(flight.id);
        return <div key={flight.id}>
          <p>{name}{flightDraft && ` · ${flightDraft.amount}`}</p>
          {flightDraft && <Staged label={name} onUndo={flightDraft.undo} />}
          <PriceEditor name={name} adults={adults} applying={drafts.applying} onApply={drafts.onApply} direction={null} date={null} defaultScope="journey" ownPrice={false}
            initial={flightDraft?.value ?? (offer && offer.low !== null ? { low: offer.low, high: offer.high, currency: offer.currency } : null)}
            onSet={value => drafts.stageComponent(componentId, value, "Standalone flight fare")} />
        </div>;
      })}
    </details>}
  </li>;
}

/**
 * Add a combined ticket price (E9.5), with the combined-ticket searches that match this option's flights. Its flights
 * are template ids: the planner checks a combined ticket against the saved flights. The parent resets it per option.
 */
function CombinedTicket({ route, adults, placeName, zoneOf, links, onSave }: {
  route: Route; adults: number; placeName: (id: string) => string; zoneOf: (id: string) => string; links: BundleLink[]; onSave: (offer: Offer) => Promise<void>;
}) {
  const flights = route.movements.filter(movement => movement.mode === "flight");
  const ticketId = (movement: Movement) => movement.template_id ?? movement.id;
  const [selected, setSelected] = useState(() => flights.map(ticketId));
  const [kind, setKind] = useState<"multi-city" | "round-trip">("multi-city");
  const [price, setPrice] = useState({ low: "", high: "", currency: "MYR" });
  const [errors, setErrors] = useState<PriceErrors>({});
  const [busy, setBusy] = useState(false);
  const flightsError = useId();
  if (flights.length < 2) return null;
  const matching = matchingQuoteLinks(links, route, zoneOf);

  async function save() {
    const chosen = flights.filter(flight => selected.includes(ticketId(flight)));
    const found: PriceErrors = priceInputErrors(price.low, price.high, price.currency);
    if (chosen.length < 2) found.flights = "Choose at least 2 flights.";
    else if (kind === "round-trip" && (chosen.length !== 2 || chosen[0].from_id !== chosen[1].to_id || chosen[0].to_id !== chosen[1].from_id)) found.flights = "A round trip covers 2 flights in opposite directions.";
    setErrors(found);
    if (Object.keys(found).length) return;
    setBusy(true);
    try {
      await onSave({ id: `bundle:${crypto.randomUUID()}`, movement_ids: chosen.map(ticketId), kind, low: Number(price.low), high: price.high.trim() === "" ? Number(price.low) : Number(price.high),
        currency: price.currency.trim().toUpperCase(), source: "user", estimated: true, label: "Manually entered whole-ticket party fare", validated: true });
      setPrice(current => ({ ...current, low: "", high: "" }));
    } catch (err) { setErrors({ save: err instanceof Error ? err.message : "The combined ticket could not be saved." }); }
    finally { setBusy(false); }
  }

  return <details className="p-combined">
    <summary><ChevronDown size={16} className="p-chevron" aria-hidden="true" />Add a combined ticket price</summary>
    <div className="p-combined-body">
      <p>Choose the flights your ticket covers and enter the total for all adults. Airport transfers stay separate.</p>
      <fieldset aria-describedby={errors.flights ? flightsError : undefined}>
        <legend className="sr-only">Flights on the ticket</legend>
        {flights.map(flight => <label className="p-check" key={flight.id}>
          <input type="checkbox" checked={selected.includes(ticketId(flight))} aria-invalid={errors.flights ? true : undefined}
            onChange={event => setSelected(ids => event.target.checked ? [...ids, ticketId(flight)] : ids.filter(id => id !== ticketId(flight)))} />
          {ticketJourney(flight, placeName, zoneOf)}
        </label>)}
        {errors.flights && <span id={flightsError} className="p-field-error">{errors.flights}</span>}
      </fieldset>
      <div className="p-combined-fields">
        <Field label="Ticket type"><Select value={kind} onValueChange={value => setKind(value as typeof kind)}><SelectItem value="multi-city">Multi-city</SelectItem><SelectItem value="round-trip">Round trip</SelectItem></Select></Field>
        <FixedPriceFields label={`Price for ${adultsText(adults)}`} value={price} errors={errors} onChange={setPrice} />
      </div>
      <Button type="button" size="sm" disabled={busy} onClick={() => void save()}>{busy ? "Saving…" : "Save combined ticket"}</Button>
      {errors.save && <p className="p-field-error" role="alert">{errors.save}</p>}
      {matching.length > 0 && <div className="p-quote-links">
        <h4>Combined tickets to check</h4>
        <ul>{matching.map((link, index) => <li key={index}>
          {quoteLinkText(link, placeName)} · {bundleStatusLabel(link.status)} · <a href={link.url} target="_blank" rel="noreferrer">Open search{newTab}</a>
        </li>)}</ul>
      </div>}
    </div>
  </details>;
}

/**
 * The Itinerary panel (C7, E9): the selected option's header with Compare, the map, Day by day, Tickets and prices
 * with Add a combined ticket price, and Check before booking. "See prices" goes to the first row that is not priced.
 * Set price stages a draft (F4) through the draft functions; Apply sends it. `onSaveBundle` saves a combined ticket at
 * once and `onRemovePrice` deletes a stored offer (F6).
 */
export function ItineraryPanel({ isWide, searched, route, displayRoutes, numbers, refinement, weaker, comparedId, onCompare, places, zoneOf, placeName, minStays, budget, adults, rates,
  offerFor, onSaveBundle, onRemovePrice, busy, bundleLinks, onAction, onEditAirportChange, onBack, ...drafts }: {
  isWide: boolean; searched: boolean; route: Route | null;
  displayRoutes: Route[]; numbers: Map<string, number>; refinement: Route[]; weaker: boolean;
  comparedId: string | null; onCompare: (id: string | null) => void;
  places: Place[]; zoneOf: (id: string) => string; placeName: (id: string) => string; minStays: Record<string, number>;
  budget: number | null; adults: number; rates: Record<string, number>;
  offerFor: (id: string) => Offer | undefined; onSaveBundle: (offer: Offer) => Promise<void>; onRemovePrice: (offerId: string) => void; busy: boolean;
  bundleLinks: BundleLink[];
  onAction: (target: OptionsTarget) => void; onEditAirportChange: (key: string) => void; onBack: () => void;
} & DraftProps) {
  const compareId = useId();
  const root = useRef<HTMLDivElement>(null);
  // Open by default on a wide screen (B2). The map chunk loads only while the disclosure is open.
  const [mapOpen, setMapOpen] = useState(isWide);
  if (!searched) return <p className="p-empty">Options appear here after a search.</p>;
  if (!route) return <p className="p-empty">No option to show.</p>;

  const number = numbers.get(route.id);
  const overBudget = number === undefined;
  const title = overBudget ? `Over-budget option ${optionNumber(refinement.indexOf(route) + 1)} of ${refinement.length}` : `Option ${optionNumber(number)} of ${displayRoutes.length}`;
  const unpriced = unpricedSummary(route, rates);
  // The not-priced line states the items (E9.1) and the budget line the bounded excess (E6), so the chips leave them out.
  const chips = optionChips(route, { budget: null, rates, estimatedOnce: false, weaker, overBudget: false, compared: false }).filter(chip => chip.text !== unpriced.chip);
  const high = route.total_cost_myr ?? route.cost_high_myr;
  const perHour = perCityHourText(route);
  const compared = displayRoutes.find(item => item.id === comparedId && item.id !== route.id);
  const others = displayRoutes.filter(item => item.id !== route.id);
  const notes = assumptionNotes(route, placeName);
  const tickets = ticketRows(route, rates, placeName, zoneOf).map(row => ({ row, draft: drafts.draftFor({ componentId: row.componentId, charge: row.charge, ownPrice: row.offer.source === "user" }) }));

  function seePrices() {
    const row = root.current?.querySelector<HTMLElement>("[data-unpriced]");
    if (!row) return;
    row.scrollIntoView({ block: "center" });
    (row.querySelector<HTMLElement>("button, input, select, a") ?? row).focus({ preventScroll: true });
  }

  return <div ref={root} className="p-itinerary">
    {!isWide && <Button type="button" variant="ghost" size="sm" className="p-back" onClick={onBack}><ArrowLeft size={15} aria-hidden="true" /><span className="sr-only">Back to </span>Options</Button>}
    <div className="p-itin-head">
      <h2 id="itinerary-title" tabIndex={-1}>{title}</h2>
      {others.length > 0 && <div className="p-itin-compare">
        <label htmlFor={compareId}>Compare with</label>
        <ComparisonPicker id={compareId} routes={others} numbers={numbers} value={compared?.id ?? ""} onChange={onCompare} />
      </div>}
    </div>
    <div className="p-itin-price"><span className="p-itin-total">{priceText(route)}</span><Chips chips={chips} /></div>
    {unpriced.text && <p className="p-itin-warning"><CircleAlert size={14} aria-hidden="true" /><span>
      {unpriced.text}{budget !== null && !overBudget && route.cost_high_myr === null && " · may exceed your budget"}{" "}
      <button type="button" className="p-link-button" onClick={seePrices}>See prices</button>
    </span></p>}
    <div className="p-itin-metrics">
      <span>{hoursText(route.stay_hours)} h in cities · {hoursText(route.travel_hours)} h travel{perHour && ` · ${perHour}`}</span>
      <InfoTip topic="time in cities" align="end">Hours in your cities from arrival to departure, nights included. Travel, airport and station time do not count. Time at home and in start or end cities does not count.</InfoTip>
    </div>
    {overBudget && budget !== null && <p className="p-itin-warning"><CircleAlert size={14} aria-hidden="true" /><span>Over budget: costs more than your {moneyShort(budget)} budget even at its lowest price. A lower combined ticket price can bring it within budget.</span></p>}
    {!overBudget && budget !== null && high !== null && high > budget && <p className="p-itin-warning"><CircleAlert size={14} aria-hidden="true" /><span>May exceed your budget (up to {moneyShort(high)})</span></p>}
    {compared && <p className="p-itin-compare-text">{compareText(route, compared, numbers.get(compared.id) ?? 0)}</p>}

    <div className="p-itin-map">
      <details open={mapOpen} onToggle={event => setMapOpen(event.currentTarget.open)}>
        <summary><ChevronDown size={16} className="p-chevron" aria-hidden="true" />Map</summary>
        {mapOpen && <PlannerMap places={places} route={route} />}
      </details>
      <InfoTip topic="the map" align="end">City points with straight lines between them. Lines do not show the real road or track. Blue: flight; brown: car or taxi; green: other transport.</InfoTip>
    </div>

    <div className="p-itin-section-head">
      <h3>Day by day</h3>
      <InfoTip topic="Day by day">Times are local to each place. Journey times are door to door.</InfoTip>
    </div>
    <ol className="p-day-list">{dayByDay(route, minStays).map((entry, index) => {
      if (entry.kind === "journey") return <li key={`${route.id}:${index}`}>
        <Journey movement={entry.movement} route={route} open={isWide && route.movements[0] === entry.movement} zoneOf={zoneOf} placeName={placeName} rates={rates} />
      </li>;
      if (entry.kind === "gap") return <li key={`${route.id}:${index}`} className="p-day-gap">Time in {placeName(entry.placeId)} · {formatDuration(entry.minutes)} · not counted in time in cities</li>;
      const { stay, minimum } = entry, zone = zoneOf(stay.place_id);
      return <li key={`${route.id}:${index}`} className="p-day-stay">
        <span><strong>{placeName(stay.place_id)}</strong> · {hoursText(stay.hours)} h{minimum !== null && ` (at least ${minimum} h)`}</span>
        <span className="p-day-times">{formatLocal(stay.arrival, zone)} → {formatLocal(stay.departure, zone)}</span>
        <progress max={route.stay_hours || 1} value={stay.hours} aria-label={`${placeName(stay.place_id)}: share of time in cities`} />
      </li>;
    })}</ol>

    <section className="p-itin-tickets" aria-labelledby="tickets-title">
      <div className="p-itin-section-head">
        <h3 id="tickets-title">Tickets and prices</h3>
        <InfoTip topic="Tickets and prices">Each ticket is counted once. A combined flight ticket does not include airport transfers. Prices are quotes or estimates, not booking guarantees.</InfoTip>
        <span className="p-tickets-total">Total {priceText(route)}{tickets.some(ticket => ticket.draft) && " · Totals update when your changes save."}</span>
      </div>
      <ul className="p-tickets">{tickets.map(({ row, draft }) => <TicketItem key={row.key} row={row} draft={draft} adults={adults} busy={busy} placeName={placeName} zoneOf={zoneOf}
        offerFor={offerFor} drafts={drafts} onRemove={onRemovePrice} onAction={onAction} onEditAirportChange={onEditAirportChange} />)}</ul>
      <CombinedTicket key={route.id} route={route} adults={adults} placeName={placeName} zoneOf={zoneOf} links={bundleLinks} onSave={onSaveBundle} />
    </section>

    {notes.length > 0 && <>
      <h3 className="p-itin-section-title">Check before booking</h3>
      <ul className="p-check-list">{notes.map(note => <li key={note.text}>
        <p>{note.text}</p>
        {note.action === "transfer-times" && <Button type="button" size="sm" variant="secondary" onClick={() => onAction("transfer-times")}>Set transfer times</Button>}
      </li>)}</ul>
    </>}
  </div>;
}
