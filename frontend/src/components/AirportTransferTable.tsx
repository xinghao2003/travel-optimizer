import { Select, SelectItem } from "./ui/select";
import { useEffect, useRef, useState, type FocusEvent } from "react";
import { CircleAlert } from "lucide-react";
import { Field, MissingSection, PriceFields, Staged, focusNextPrice } from "./PlannerForms";
import { RateField } from "./MissingFaresTable";
import { blankTransferRow, nextTransferMode, sameTransferRows, savedTransferRows, storedOfferId, transferFieldId, transferKey, transferRateId, transferModes, transferProblems, type PriceValue, type SharedFare, type TransferRowDraft } from "../lib/drafts";
import { modeLabel, purchaseAmount, transferJourneyText, type OptionsTarget, type TransferDirection, type TransferJourney } from "../lib/present";
import type { AirportTransferEstimate } from "../lib/planner";
import type { TripDraftsApi } from "../lib/useTripDrafts";

const adultsText = (adults: number) => `${adults} adult${adults === 1 ? "" : "s"}`;
const sentence = (message: string) => message.charAt(0).toUpperCase() + message.slice(1);

type Props = {
  directions: TransferDirection[]; estimates: AirportTransferEstimate[]; adults: number; searched: boolean;
  drafts: TripDraftsApi;
  /** The trip's fare drafts on canonical ids: per-journey prices are "component:{charge id}". */
  fares: Record<string, SharedFare>;
  /** Next steps row 2 text when journeys can't be used because an airport transfer time is unknown. */
  accessNote: string | null;
  placeName: (id: string) => string; zoneOf: (id: string) => string; rates: Record<string, number>;
  /** The exchange rates as typed: a rate added here shows as added until the trip saves. */
  draftRates: Record<string, number>; addRate: (currency: string, rate: number) => void;
  stageComponent: (componentId: string, value: PriceValue, label: string) => void;
  removePrice: (offerId: string) => void; busy: boolean;
  onAction: (target: OptionsTarget) => void; onApply: () => void;
};

/** One journey of a direction (Show journeys): its price in use, a price for this journey only, and Remove my price. */
function Journey({ journey, label, adults, fares, rates, placeName, zoneOf, drafts, stageComponent, removePrice, busy, onApply }: Pick<Props, "adults" | "fares" | "rates" | "placeName" | "zoneOf" | "drafts" | "stageComponent" | "removePrice" | "busy" | "onApply"> & {
  journey: TransferJourney; label: string;
}) {
  const { charge, offer } = journey;
  const key = `component:${charge.id}`;
  const draft = fares[key];
  const own = offer?.source === "user" && offer.low !== null ? offer : null;
  const text = transferJourneyText(journey, placeName, zoneOf);
  const priced = !!offer && offer.low !== null;
  return <li>
    <div className="p-mi-item-head">
      <span className="p-mi-item-title">{text}</span>
      <span className="p-mi-item-status" data-tone={priced ? undefined : "warn"}>{offer ? purchaseAmount(offer, rates) : "Not priced"}{own && " · your price"}</span>
    </div>
    <PriceFields name={`${label} · ${text}`} adults={adults} value={draft ?? (own && { low: own.low!, high: own.high, currency: own.currency })} staged={!!draft}
      placeholder={priced ? "" : "Not priced"} onCommit={value => stageComponent(charge.id, value, charge.kind)} onUndo={() => drafts.unstage("fares", key)} onApply={onApply} />
    {own && <button type="button" className="p-link-button" disabled={busy} onClick={() => removePrice(storedOfferId(own))}>Remove my price<span className="sr-only">: {text}</span></button>}
  </li>;
}

/**
 * One airport transfer direction (F2 row 2): its status, its ways as drafts (TransferRowDraft, staged on every change),
 * "+ Add another way" and the journeys that use it. The field ids are transferFieldId(), which Next steps and
 * "Fix {k} values" focus. Esc restores a field's value from when it got focus; Enter in a price moves to the next price.
 */
function Direction({ direction, estimates, draftRates, addRate, ...props }: Omit<Props, "directions" | "searched" | "accessNote" | "onAction"> & { direction: TransferDirection }) {
  const { adults, drafts } = props;
  const { from_id, to_id, label } = direction;
  const [showJourneys, setShowJourneys] = useState(false);
  const [focusId, setFocusId] = useState<string | null>(null);
  useEffect(() => { if (focusId) { document.getElementById(focusId)?.focus(); setFocusId(null); } }, [focusId]);
  const started = useRef<{ index: number; field: keyof TransferRowDraft; value: string } | null>(null);
  const key = transferKey(from_id, to_id, adults);
  const saved = savedTransferRows(estimates, from_id, to_id, adults);
  const staged = key in drafts.drafts.transfers;
  const rows = drafts.drafts.transfers[key] ?? saved;
  const problems = staged ? transferProblems(rows) : [];
  const errorOf = (index: number, field: keyof TransferRowDraft) => {
    const problem = problems.find(item => item.index === index && item.field === field);
    return problem && sentence(problem.message);
  };
  const id = (index: number, field: keyof TransferRowDraft) => transferFieldId(from_id, to_id, index, field);
  const addId = `transfer-add-${from_id}>${to_id}`;
  // Changes build on the latest drafts: a keystroke can follow a change in the same event loop turn.
  const latest = () => drafts.read().transfers[key] ?? saved;
  const stage = (next: TransferRowDraft[]) => drafts.stageTransfer(key, next, saved);
  const change = (index: number, field: keyof TransferRowDraft, value: string) => stage(latest().map((row, i) => i === index ? { ...row, [field]: value } : row));
  const next = nextTransferMode(rows);
  function add() {
    if (!next) return;
    stage([...latest(), blankTransferRow(next)]);
    setFocusId(id(rows.length, "mode"));
  }
  function remove(index: number) { stage(latest().filter((_, i) => i !== index)); setFocusId(addId); }
  function undo() { drafts.unstage("transfers", key); setFocusId(addId); }
  const way = (row: TransferRowDraft) => `${label} ${modeLabel(row.mode)}`;
  const fieldProps = (index: number, field: keyof TransferRowDraft) => ({
    id: id(index, field), name: field, "data-index": index,
    onFocus: (event: FocusEvent<HTMLInputElement | HTMLButtonElement>) => { started.current = { index, field, value: event.target.value }; },
  });

  return <div className="p-mi-item" onKeyDown={event => {
    // Keys that a control inside already handled (a price editor under Show journeys).
    if (event.defaultPrevented) return;
    const target = event.target as HTMLElement;
    if (event.key === "Escape" && started.current && target.getAttribute("name") === started.current.field && Number(target.dataset.index) === started.current.index) {
      event.preventDefault();
      change(started.current.index, started.current.field, started.current.value);
    } else if (event.key === "Enter" && !event.ctrlKey && !event.metaKey && target.hasAttribute("data-price-input")) {
      event.preventDefault();
      focusNextPrice(target, event.shiftKey);
    }
  }}>
    <div className="p-mi-item-head">
      <span className="p-mi-item-title">{label}</span>
      <span className="p-mi-item-status" data-tone={direction.state === "missing" ? "warn" : undefined}>{direction.status}</span>
    </div>
    {direction.rateCurrencies.map(currency => <RateField key={currency} currency={currency} id={transferRateId(from_id, to_id, currency)} added={draftRates[currency] !== undefined} addRate={addRate} />)}
    {rows.map((row, index) => <div className="p-mi-fields" role="group" aria-label={way(row)} key={index}>
      <Field label="Way" error={errorOf(index, "mode")}>
        <Select {...fieldProps(index, "mode")} value={row.mode} onValueChange={value => change(index, "mode", value)}>
          {transferModes.map(mode => <SelectItem value={mode} key={mode}>{modeLabel(mode)}</SelectItem>)}
        </Select>
      </Field>
      <Field label="Time (min)" error={errorOf(index, "duration")}>
        <input {...fieldProps(index, "duration")} type="text" inputMode="numeric" placeholder={row.mode === "taxi" ? "Road time" : "Required"} value={row.duration} onChange={event => change(index, "duration", event.target.value)} />
      </Field>
      <Field label={`Price for ${adultsText(adults)}`} error={errorOf(index, "low")}>
        <input {...fieldProps(index, "low")} type="text" inputMode="decimal" data-price-input placeholder="Not priced" value={row.low} onChange={event => change(index, "low", event.target.value)} />
      </Field>
      <Field label="Highest price (optional)" error={errorOf(index, "high")}>
        <input {...fieldProps(index, "high")} type="text" inputMode="decimal" data-price-input data-price-optional value={row.high} onChange={event => change(index, "high", event.target.value)} />
      </Field>
      <Field label="Currency" error={errorOf(index, "currency")} className="p-price-currency">
        <input {...fieldProps(index, "currency")} maxLength={3} value={row.currency} onChange={event => change(index, "currency", event.target.value.toUpperCase())} />
      </Field>
      {/* Removing the only blank taxi row changes nothing: it is the default way. */}
      {!sameTransferRows(rows.filter((_, i) => i !== index), rows) && <button type="button" className="p-mi-remove" aria-label={`Remove ${way(row)}`} onClick={() => remove(index)}>×</button>}
    </div>)}
    {staged && <Staged label={label} onUndo={undo} />}
    <div className="p-mi-links">
      <button id={addId} type="button" className="p-link-button" disabled={!next} onClick={add}>+ Add another way<span className="sr-only">: {label}</span></button>
      {!next && <span>All ways added.</span>}
      {direction.journeys.length > 0 && <button type="button" className="p-link-button" aria-expanded={showJourneys} onClick={() => setShowJourneys(!showJourneys)}>
        {showJourneys ? "Hide journeys" : `Show journeys (${direction.journeys.length})`}<span className="sr-only">: {label}</span>
      </button>}
      {direction.ownPrices > 0 && <span>{direction.ownPrices} {direction.ownPrices === 1 ? "journey uses its" : "journeys use their"} own price</span>}
    </div>
    {showJourneys && <ul className="p-mi-journeys">{direction.journeys.map(journey => <Journey key={journey.charge.id} journey={journey} label={label} {...props} />)}</ul>}
  </div>;
}

/**
 * Missing info › Airport transfers (F2 row 2): the access-time callout, then one block per direction in
 * transferDirections() order: missing, priced, then "Other airports". Before any search every direction is in
 * one closed group. Ways are transfer drafts and journeys' own prices are fare drafts; Apply sends them (F4).
 */
export function AirportTransfers({ directions, searched, accessNote, onAction, ...props }: Props) {
  const missing = directions.filter(direction => direction.state === "missing").length;
  const used = directions.filter(direction => direction.state !== "unused"), other = directions.filter(direction => direction.state === "unused");
  const list = (items: TransferDirection[]) => <ul className="p-mi-list">{items.map(direction => <li key={`${direction.from_id}>${direction.to_id}`}><Direction direction={direction} {...props} /></li>)}</ul>;
  return <MissingSection id="airport-transfers-title" title="Airport transfers" status={searched ? missing ? `${missing} without a price` : "Done" : undefined} warn={missing > 0}
    tip={`Travel between each city and its airports, for ${adultsText(props.adults)}. A price or time here applies to every matching journey in this trip, also after new searches. A price you set for one journey overrides it. Only the ways listed are used: to keep the taxi beside another way, keep a Taxi row. A blank taxi time uses the road time, or the default airport transfer time. Times are your estimates, without timetables.`}>
    {accessNote && <div className="p-notice"><CircleAlert size={15} aria-hidden="true" /><p>
      {accessNote} Enter a time below, or <button type="button" className="p-link-button" onClick={() => onAction("airport-fallback")}>set a default airport transfer time</button>.
    </p></div>}
    {!directions.length ? <p>No airport transfers in this trip.</p>
      : !searched ? <details className="p-mi-more"><summary>All directions ({directions.length})</summary>{list(directions)}</details>
      : <>
        {used.length > 0 && list(used)}
        {other.length > 0 && <details className="p-mi-more"><summary>Other airports ({other.length})</summary>{list(other)}</details>}
      </>}
  </MissingSection>;
}
