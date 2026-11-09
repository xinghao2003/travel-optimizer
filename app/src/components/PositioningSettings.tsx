import { TemporalInput } from "./ui/temporal-input";
import { Select, SelectItem } from "./ui/select";
import { useId, useState } from "react";
import { ChevronDown } from "lucide-react";
import { Field, PlacePicker } from "./PlannerForms";
import { InfoTip } from "./InfoTip";
import { Button } from "./ui/button";
import { formatLocal, modeLabel, moneyShort } from "../lib/present";
import { localInputToISO, modes, type Mode, type Place, type PositioningPolicy, type TripDraft } from "../lib/planner";

type Direction = PositioningPolicy["direction"];
type PolicyValue = "search" | "supplied" | "unavailable";
const policyLabels: Record<PolicyValue, string> = { search: "Search", supplied: "Your journeys only", unavailable: "Don't use" };
const count = (n: number, word: string) => `${n} ${n === 1 ? word : `${word}s`}`;
/** A trip date (YYYY-MM-DD) as "4 Dec"; blank while the date input is cleared or holds an invalid date (a 5-digit year). */
const tripDay = (date: string) => date && !Number.isNaN(Date.parse(`${date}T00:00:00Z`)) ? formatLocal(`${date}T00:00:00Z`, "UTC", "day") : "";

/**
 * "Start the trip from" or "End the trip at" (G). An empty list means home only. Home is checked when the list is
 * empty or holds home; adding a city keeps home's state (I6 item 5). The list holds at most 3 places, home included.
 */
function EndpointList({ draft, edit, direction }: { draft: TripDraft; edit: (value: TripDraft) => void; direction: Direction }) {
  const hintId = useId();
  const key = direction === "outbound" ? "departures" : "arrivals";
  const word = direction === "outbound" ? "start" : "end";
  const home = draft.home;
  const list = draft[key];
  const homeChecked = !list.length || list.some(place => place.id === home?.id);
  const others = list.filter(place => place.id !== home?.id);
  const used = others.length + (homeChecked ? 1 : 0);
  const full = used >= 3;
  // Home only is stored as [] (the planner reads it as home).
  const set = (places: Place[]) => edit({ ...draft, [key]: places.some(place => place.id !== home?.id) ? places : [] });
  const homeHint = homeChecked && !others.length ? `Add another ${word} city first.` : "";
  return <fieldset className="p-endpoints">
    <legend>{direction === "outbound" ? "Start the trip from" : "End the trip at"}</legend>
    {home && <label className="p-check">
      <input type="checkbox" checked={homeChecked} disabled={homeChecked ? !others.length : full} aria-describedby={homeHint ? hintId : undefined}
        onChange={e => set(e.target.checked ? [home, ...others] : others)} />{home.name} (home)
    </label>}
    {homeHint && <small id={hintId} className="p-endpoint-hint">{homeHint}</small>}
    {others.length > 0 && <div className="p-chips">{others.map(place => <span key={place.id}>{place.name}
      <button type="button" aria-label={`Remove ${place.name} from ${word} cities`} onClick={() => set(list.filter(item => item.id !== place.id))}>×</button>
    </span>)}</div>}
    <PlacePicker label={`Add a${word === "end" ? "n" : ""} ${word} city`} limitText={home ? `${used} of 3` : undefined} disabled={!home || full}
      hint={!home ? "Add your home city first." : full ? `Up to 3 ${word} cities, including home.` : undefined}
      disabledIds={[home?.id ?? "", ...list.map(place => place.id)]}
      onSelect={place => { if (home && !full) set(homeChecked ? [home, ...others, place] : [...others, place]); }} />
  </fieldset>;
}

/** One city and direction (G): how to travel by each mode turned on, your journeys, and the form to add one. */
function GatewayPositioning({ draft, gateway, direction, edit }: {
  draft: TripDraft; gateway: Place; direction: Direction; edit: (value: TripDraft) => void;
}) {
  const home = draft.home!;
  const origin = direction === "outbound" ? home : gateway;
  const destination = direction === "outbound" ? gateway : home;
  const [form, setForm] = useState({ mode: "" as Mode | "", departure: "", arrival: "", fare: "", currency: "MYR", label: "" });
  const [error, setError] = useState("");
  const policies = draft.positioning_policies ?? [];
  const services = draft.positioning_services ?? [];
  const group = services.filter(s => s.direction === direction && s.gateway_id === gateway.id);
  const allowed = modes.filter(mode => draft.modes.includes(mode));
  const policyFor = (mode: Mode) => policies.find(p => p.direction === direction && p.gateway_id === gateway.id && p.mode === mode);
  const valueOf = (mode: Mode): PolicyValue => policyFor(mode)?.available === false ? "unavailable" : policyFor(mode)?.search_more === false ? "supplied" : "search";
  const formMode = form.mode && allowed.includes(form.mode) ? form.mode : allowed[0];
  const adults = count(draft.adults, "adult");

  // Policies of modes that are turned off stay as they are.
  function changePolicy(mode: Mode, value: PolicyValue) {
    edit({ ...draft, positioning_policies: [
      ...policies.filter(p => !(p.direction === direction && p.gateway_id === gateway.id && p.mode === mode)),
      { direction, gateway_id: gateway.id, mode, available: value !== "unavailable", search_more: value === "search" },
    ] });
  }
  function add() {
    try {
      if (!formMode) throw new Error("Turn on a type of transport in Transport first.");
      if (!form.departure || !form.arrival) throw new Error("Enter both departure and arrival dates and times.");
      const departure = localInputToISO(form.departure, origin.timezone);
      const arrival = localInputToISO(form.arrival, destination.timezone);
      if (new Date(arrival) <= new Date(departure)) throw new Error("Arrival must follow departure.");
      const fare = form.fare.trim() === "" ? null : Number(form.fare);
      if (fare !== null && (!Number.isFinite(fare) || fare < 0)) throw new Error("Enter a price of 0 or more, or leave it blank.");
      if (!/^[A-Z]{3}$/.test(form.currency)) throw new Error("Enter a 3-letter currency code.");
      if (valueOf(formMode) === "unavailable") throw new Error(`${modeLabel(formMode)} is set to Don't use here. Change How to travel first.`);
      edit({ ...draft, positioning_services: [...services, {
        id: crypto.randomUUID(), direction, gateway_id: gateway.id, mode: formMode,
        departure, arrival, fare_amount: fare, currency: form.currency,
        label: form.label.trim() || `${modeLabel(formMode)} ${origin.name} → ${destination.name}`,
      }] });
      setForm(f => ({ ...f, departure: "", arrival: "", fare: "", label: "" }));
      setError("");
    } catch (err) { setError(err instanceof Error ? err.message : "This journey can't be added."); }
  }

  const values = allowed.map(valueOf);
  const policySummary = new Set(values).size <= 1 ? policyLabels[values[0] ?? "search"]
    : allowed.filter(mode => valueOf(mode) !== "search").map(mode => `${modeLabel(mode)}: ${policyLabels[valueOf(mode)].toLowerCase()}`).join(" · ");
  const sameDay = (a: string, aZone: string, b: string, bZone: string) => formatLocal(a, aZone, "date") === formatLocal(b, bZone, "date");

  return <details className="p-subgroup">
    <summary>
      <span className="p-subgroup-title">Travel from {origin.name} to {destination.name} ({direction === "outbound" ? "before" : "after"} the trip)</span>
      <span className="p-group-summary">{[policySummary, group.length ? count(group.length, "journey") : ""].filter(Boolean).join(" · ")}</span>
      <ChevronDown size={16} className="p-chevron" aria-hidden="true" />
    </summary>
    <div className="p-subgroup-body">
      <h4>How to travel</h4>
      <p className="p-hint">Only transport types turned on for this trip are listed.</p>
      <div className="p-group-fields">{allowed.map(mode => <Field key={mode} label={modeLabel(mode)}>
        <Select value={valueOf(mode)} onValueChange={value => changePolicy(mode, value as PolicyValue)}>
          {(Object.keys(policyLabels) as PolicyValue[]).map(value => <SelectItem key={value} value={value}>{policyLabels[value]}</SelectItem>)}
        </Select>
      </Field>)}</div>
      {allowed.filter(mode => valueOf(mode) === "supplied" && !group.some(s => s.mode === mode)).map(mode =>
        <p className="p-notice" key={mode}>{modeLabel(mode)}: only your journeys are allowed here, but you have not added one. It gives no options.</p>)}

      <div className="p-subhead"><h4>Your journeys</h4><InfoTip topic="your journeys" align="end">Enter city-to-city times, including station access. Airport time before onward flights is added separately. Your journeys are used even outside the departure times. To change a journey, remove it and add it again.</InfoTip></div>
      {group.length ? <ul className="p-item-rows">{group.map(service => {
        const unused = !draft.modes.includes(service.mode) ? `${modeLabel(service.mode)} is off for this trip` : valueOf(service.mode) === "unavailable" ? "set to Don't use" : "";
        return <li key={service.id}>
          <span>{service.label} · {modeLabel(service.mode)} · {formatLocal(service.departure, origin.timezone)} → {formatLocal(service.arrival, destination.timezone, sameDay(service.departure, origin.timezone, service.arrival, destination.timezone) ? "time" : "datetime")} · {service.fare_amount === null ? "Not priced" : moneyShort(service.fare_amount, service.currency)} for {adults}
            {unused && <span className="p-warning"> · not used: {unused}</span>}</span>
          <button type="button" className="p-text-button" aria-label={`Remove ${service.label}`} onClick={() => edit({ ...draft, positioning_services: services.filter(s => s.id !== service.id) })}>Remove</button>
        </li>;
      })}</ul> : <p className="p-hint">None.</p>}

      <details className="p-add-form">
        <summary>Add your journey</summary>
        <div className="p-group-fields">
          <Field label="Transport"><Select value={formMode ?? ""} onValueChange={value => setForm(f => ({ ...f, mode: value as Mode }))}>{allowed.map(mode => <SelectItem key={mode} value={mode}>{modeLabel(mode)}</SelectItem>)}</Select></Field>
          <Field label="Name (optional)"><input maxLength={160} value={form.label} onChange={e => setForm(f => ({ ...f, label: e.target.value }))} /></Field>
          <Field label={`Departs (${origin.name} time)`}><TemporalInput type="datetime-local" value={form.departure} onValueChange={value => setForm(f => ({ ...f, departure: value }))} /></Field>
          <Field label={`Arrives (${destination.name} time)`}><TemporalInput type="datetime-local" value={form.arrival} onValueChange={value => setForm(f => ({ ...f, arrival: value }))} /></Field>
          <Field label={`Price for ${adults} (optional)`}><input inputMode="decimal" placeholder="Not priced" value={form.fare} onChange={e => setForm(f => ({ ...f, fare: e.target.value }))} /></Field>
          <Field label="Currency"><input maxLength={3} value={form.currency} onChange={e => setForm(f => ({ ...f, currency: e.target.value.toUpperCase() }))} /></Field>
        </div>
        <div className="p-form-actions">
          <Button type="button" size="sm" variant="secondary" onClick={add}>Add journey</Button>
          {error && <p className="p-field-error" role="alert">{error}</p>}
        </div>
      </details>
    </div>
  </details>;
}

/**
 * The body of More settings › Start and end cities (G): the start and end lists, the home times and one
 * disclosure per start or end city and direction. `homeTimesError` is validateDraft's homeTimes error.
 */
export function PositioningSettings({ draft, edit, homeTimesError }: { draft: TripDraft; edit: (value: TripDraft) => void; homeTimesError?: string }) {
  const home = draft.home;
  const start = tripDay(draft.start_date), end = tripDay(draft.end_date);
  return <>
    <div className="p-group-columns">
      <EndpointList draft={draft} edit={edit} direction="outbound" />
      <EndpointList draft={draft} edit={edit} direction="return" />
    </div>
    <div className="p-subhead"><h3>Home times{home ? ` (${home.timezone})` : ""}</h3><InfoTip topic="home times">Blank means any time on that day. Also applies with flexible dates.</InfoTip></div>
    <div className="p-group-fields">
      <Field label={<>Leave home after{start && <span className="sr-only"> on {start}</span>}</>} unit={start ? `on ${start}` : undefined}>
        <TemporalInput type="time" value={draft.home_departure_earliest ?? ""} onValueChange={value => edit({ ...draft, home_departure_earliest: value || null })} />
      </Field>
      <Field label={<>Be home by{end && <span className="sr-only"> on {end}</span>}</>} unit={end ? `on ${end}` : undefined} error={homeTimesError}>
        <TemporalInput type="time" value={draft.home_arrival_latest ?? ""} onValueChange={value => edit({ ...draft, home_arrival_latest: value || null })} />
      </Field>
    </div>
    {home && (["outbound", "return"] as const).flatMap(direction => (direction === "outbound" ? draft.departures : draft.arrivals)
      .filter(gateway => gateway.id !== home.id)
      .map(gateway => <GatewayPositioning key={`${home.id}:${direction}:${gateway.id}`} draft={draft} gateway={gateway} direction={direction} edit={edit} />))}
  </>;
}
