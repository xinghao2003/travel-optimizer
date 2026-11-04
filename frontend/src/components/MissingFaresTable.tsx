import { useId, useState } from "react";
import { Button } from "./ui/button";
import { MissingSection, PriceFields, Staged } from "./PlannerForms";
import type { Offer } from "../lib/planner";
import type { MissingFareGroup } from "../lib/missingFares";
import { componentWhen, journeyGroupTitle, journeyGroupWhen, purchaseAmount } from "../lib/present";
import type { PriceValue, SharedFare } from "../lib/drafts";

const newTab = <span className="sr-only"> (opens in a new tab)</span>;
const count = (n: number, word: string) => `${n} ${n === 1 ? word : `${word}s`}`;
/** Groups shown at first, and added by each "Show more" (F2). */
const pageSize = 25;

type JourneyProps = {
  /** The trip's fare drafts on canonical ids; a group's draft is keyed by its group key, a journey's by "component:{canonical id}". */
  fares: Record<string, SharedFare>;
  adults: number; rates: Record<string, number>;
  /** Exchange rates of the trip as typed: a rate added here shows at once, before the options update. */
  draftRates: Record<string, number>;
  canonical: (id: string) => string; offerFor: (id: string) => Offer | undefined;
  placeName: (id: string) => string; zoneOf: (id: string) => string;
  stagePrice: (key: string, fare: SharedFare) => void;
  stageComponent: (componentId: string, value: PriceValue, label: string) => void;
  unstage: (key: string) => void; removePrice: (offerId: string) => void; addRate: (currency: string, rate: number) => void;
  busy: boolean; onApply: () => void;
};

export type AppliedSharedFareGroup = { key: string; component_ids: string[]; low: number | null; high: number | null; currency: string; mixed_amounts: boolean; mixed_currency: boolean; label: string };

/**
 * Missing info › Group prices you set (F2 row 6): one row per group price saved on this trip's journeys. A new price is a
 * fare draft under the group's label (F4), sent by Apply. When the journeys of a group have different prices, the fields
 * start blank ("Mixed") and a new price sets one value for all.
 */
export function GroupPrices({ groups, fares, adults, stagePrice, unstage, onApply }: {
  groups: AppliedSharedFareGroup[]; fares: Record<string, SharedFare>; adults: number;
  stagePrice: (key: string, fare: SharedFare, saved?: PriceValue | null) => void; unstage: (key: string) => void; onApply: () => void;
}) {
  if (!groups.length) return null;
  return <MissingSection id="group-prices-title" title="Group prices you set" status={String(groups.length)} collapsed tip="Prices you set for a group of journeys.">
    <ul className="p-mi-list">{groups.map(group => {
      const label = group.label.replace(/^Shared estimate:\s*/, "");
      const draft = fares[group.key];
      const mixed = group.mixed_amounts || group.mixed_currency;
      const saved = mixed || group.low === null ? null : { low: group.low, high: group.high, currency: group.currency };
      return <li key={group.key} className="p-mi-item">
        <div className="p-mi-item-head"><span className="p-mi-item-title">{label}</span><span className="p-mi-item-status">{count(group.component_ids.length, "journey")}</span></div>
        {mixed && <p className="p-mi-meta">Values differ. A new price sets one value for all.</p>}
        <PriceFields name={label} adults={adults} value={draft ?? saved} currency={group.currency} staged={!!draft} placeholder={mixed ? "Mixed" : "Not priced"}
          onCommit={value => stagePrice(group.key, { component_ids: group.component_ids, ...value, label: group.label }, saved)}
          onUndo={() => unstage(group.key)} onApply={onApply} />
      </li>;
    })}</ul>
  </MissingSection>;
}

/** "Price is in {JPY}. 1 {JPY} = [ ] MYR Add rate or enter the price in MYR." Add rate writes the trip's exchange rates (autosave). */
export function RateField({ currency, id, added, addRate }: { currency: string; id?: string; added: boolean; addRate: (currency: string, rate: number) => void }) {
  const generated = useId();
  const inputId = id ?? generated, errorId = `${inputId}-error`;
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  if (added) return <p className="p-mi-meta" role="status">Rate for {currency} added. The options update after the trip saves.</p>;
  function add() {
    const rate = Number(text);
    if (text.trim() === "" || !Number.isFinite(rate) || rate <= 0) { setError("Enter a rate above 0."); return; }
    setError(""); addRate(currency, rate); setText("");
  }
  return <div className="p-mi-rate">
    <span>Price is in {currency}.</span>
    <label htmlFor={inputId}>1 {currency} =</label>
    <input id={inputId} type="text" inputMode="decimal" value={text} aria-invalid={error ? true : undefined} aria-describedby={error ? errorId : undefined}
      onChange={event => setText(event.target.value)} onKeyDown={event => { if (event.key === "Enter" && !event.ctrlKey && !event.metaKey) { event.preventDefault(); add(); } }} />
    <span>MYR</span>
    <Button type="button" size="sm" variant="secondary" onClick={add}>Add rate</Button>
    <span>or enter the price in MYR.</span>
    {error && <span id={errorId} className="p-field-error">{error}</span>}
  </div>;
}

/**
 * One Journey prices row (F2 row 3): title, options, journeys, Search fare, the group price (a draft on every journey of
 * the row) and Show journeys with a price for each journey. `first` gives the price input the id that Add prices focuses.
 */
function JourneyGroup({ group, first, rateId, ...props }: JourneyProps & { group: MissingFareGroup; first: boolean; rateId?: string }) {
  const { fares, adults, canonical, offerFor, placeName, zoneOf, unstage, busy, onApply } = props;
  const [showJourneys, setShowJourneys] = useState(false);
  const title = journeyGroupTitle(group, placeName);
  const name = `${placeName(group.from_id)} → ${placeName(group.to_id)}`;
  const zone = zoneOf(group.from_id);
  const url = group.components[0]?.search_url;
  const draft = fares[group.key];
  const componentKey = (id: string) => `component:${canonical(id)}`;
  const ownDrafts = group.components.filter(component => componentKey(component.component_id) in fares).length;
  // A price in another currency needs its rate; MYR is the default for a new price.
  const currency = group.reason === "exchange_rate" ? "MYR" : group.currency;
  return <li className="p-mi-item">
    <div className="p-mi-item-head">
      <span className="p-mi-item-title">{title}</span>
      <span className="p-mi-item-status">in {count(group.affected_itineraries, "option")}</span>
    </div>
    <p className="p-mi-meta">{journeyGroupWhen(group, zone)}{url && <> · <a href={url} target="_blank" rel="noreferrer">Search fare{newTab}</a></>}</p>
    {group.reason === "exchange_rate" && <RateField currency={group.currency} id={rateId} added={props.draftRates[group.currency] !== undefined} addRate={props.addRate} />}
    <PriceFields id={first ? "missing-fare-first" : undefined} name={title} adults={adults} value={draft ?? null} currency={currency} staged={!!draft}
      onCommit={value => props.stagePrice(group.key, { component_ids: group.components.map(component => component.component_id), ...value, label: `Shared estimate: ${name} · ${group.label}`.slice(0, 200) })}
      onUndo={() => unstage(group.key)} onApply={onApply} />
    {ownDrafts > 0 && <p className="p-mi-meta">{ownDrafts === 1 ? "1 journey has its" : `${ownDrafts} journeys have their`} own draft price. A group price replaces them.</p>}
    <div className="p-mi-links">
      <button type="button" className="p-link-button" aria-expanded={showJourneys} onClick={() => setShowJourneys(!showJourneys)}>
        {showJourneys ? "Hide journeys" : `Show journeys (${group.components.length})`}<span className="sr-only">: {title}</span>
      </button>
    </div>
    {showJourneys && <ul className="p-mi-journeys">{group.components.map((component, index) => {
      const key = componentKey(component.component_id);
      const offer = offerFor(component.component_id);
      const own = offer?.source === "user" && offer.low !== null ? offer : null;
      const when = componentWhen(component, zone) || `Journey ${index + 1}`;
      return <li key={component.component_id}>
        <div className="p-mi-item-head"><span className="p-mi-item-title">{when}</span>
          {component.search_url && component.search_url !== url && <a href={component.search_url} target="_blank" rel="noreferrer">Search fare{newTab}</a>}</div>
        <PriceFields name={`${title} · ${when}`} adults={adults} value={fares[key] ?? (own && { low: own.low!, high: own.high, currency: own.currency })} currency={currency} staged={key in fares}
          onCommit={value => props.stageComponent(component.component_id, value, `${name} · ${group.label}`)} onUndo={() => unstage(key)} onApply={onApply} />
        {own && <button type="button" className="p-link-button" disabled={busy} onClick={() => props.removePrice(own.id)}>Remove my price<span className="sr-only">: {when}</span></button>}
      </li>;
    })}</ul>}
  </li>;
}

/**
 * Missing info › Journey prices (F2 row 3): one row per missing-price group (splitGroups().journeys), 25 at a time,
 * then "Other drafts": fare drafts that match no row (`others`), each with Undo. Prices are fare drafts; Apply sends them.
 */
export function JourneyPrices({ groups, others, ...props }: JourneyProps & { groups: MissingFareGroup[]; others: [string, SharedFare][] }) {
  const [shown, setShown] = useState(pageSize);
  const left = groups.length - shown;
  // Next steps › Add rate focuses the rate field of the first row in each currency.
  const rateRows = new Map<string, string>();
  for (const group of groups) if (group.reason === "exchange_rate" && !rateRows.has(group.currency)) rateRows.set(group.currency, group.key);
  return <MissingSection id="journey-prices-title" title="Journey prices" status={groups.length ? `${groups.length} without a price` : "Done"} warn={groups.length > 0}
    tip="Journeys with the same route, type, transport, currency and reason share one row, also on different dates. A row price applies to each journey in the row. New searches can add journeys without a price.">
    {groups.length > 0 && <ul className="p-mi-list">{groups.slice(0, shown).map((group, index) => <JourneyGroup key={group.key} group={group} first={index === 0}
      rateId={rateRows.get(group.currency) === group.key ? `rate-input-${group.currency}` : undefined} {...props} />)}</ul>}
    {left > 0 && <button type="button" className="p-show-more" onClick={() => setShown(shown + pageSize)}>{left > pageSize ? `Show ${pageSize} more (${left} left)` : `Show ${left} more`}</button>}
    {others.length > 0 && <details className="p-mi-more"><summary>Other drafts ({others.length})</summary>
      <ul className="p-mi-list">{others.map(([key, fare]) => {
        const label = fare.label.replace(/^Shared estimate:\s*/, "");
        return <li key={key} className="p-mi-item">
          <div className="p-mi-item-head"><span className="p-mi-item-title">{label}</span><span className="p-mi-item-status">{purchaseAmount(fare, props.rates)}</span></div>
          <p className="p-mi-meta">{count(fare.component_ids.length, "journey")}</p>
          <Staged label={label} onUndo={() => props.unstage(key)} />
        </li>;
      })}</ul>
    </details>}
  </MissingSection>;
}
