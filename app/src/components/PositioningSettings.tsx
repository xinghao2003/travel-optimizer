import { TemporalInput } from "./ui/temporal-input";
import { Select, SelectItem } from "./ui/select";
import { useId, useState } from "react";
import { ChevronDown } from "lucide-react";
import { Field, NumberField, PlacePicker } from "./PlannerForms";
import { InfoTip } from "./InfoTip";
import { Button } from "./ui/button";
import { formatLocal, modeLabel, moneyShort } from "../lib/present";
import { localInputToISO, modes, type Mode, type Place, type PositioningPattern, type PositioningPolicy, type TripDraft } from "../lib/planner";

type Direction = PositioningPolicy["direction"];
type PolicyValue = "search" | "supplied" | "unavailable";
const policyLabels: Record<PolicyValue, string> = { search: "Search", supplied: "Your journeys only", unavailable: "Don't use" };
const count = (n: number, word: string) => `${n} ${n === 1 ? word : `${word}s`}`;

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

type Way = "search" | "regular" | "anytime" | "tickets" | "custom";
const wayLabels: Record<Way, string> = { search: "Find it for me", regular: "Runs regularly", anytime: "Any time (car, lift, taxi)", tickets: "I have tickets", custom: "Per transport type" };
const anyTime = { first: "00:00", last: "23:59", every_minutes: 30 };
const clockOf = (time: string) => time.slice(0, 5);

/**
 * One other city and direction (G): how the user gets between home and the city. Find it for me searches it. Runs
 * regularly and Any time are a regular service the solver expands into timed journeys; I have tickets uses the
 * journeys added below. The last three turn off searching for this pair. "Per transport type" shows the policy of
 * each mode, for trips whose modes differ.
 */
function GatewayPositioning({ draft, gateway, direction, edit }: {
  draft: TripDraft; gateway: Place; direction: Direction; edit: (value: TripDraft) => void;
}) {
  const home = draft.home!;
  const origin = direction === "outbound" ? home : gateway;
  const destination = direction === "outbound" ? gateway : home;
  const [form, setForm] = useState({ mode: "" as Mode | "", departure: "", arrival: "", fare: "", currency: "MYR", label: "" });
  const [error, setError] = useState("");
  const [customOpen, setCustomOpen] = useState(false);
  const policies = draft.positioning_policies ?? [];
  const services = draft.positioning_services ?? [];
  const patterns = draft.positioning_patterns ?? [];
  const mine = <T extends { direction: Direction; gateway_id: string }>(item: T) => item.direction === direction && item.gateway_id === gateway.id;
  const group = services.filter(mine);
  const pattern = patterns.find(mine);
  const allowed = modes.filter(mode => draft.modes.includes(mode));
  const policyFor = (mode: Mode) => policies.find(p => mine(p) && p.mode === mode);
  const valueOf = (mode: Mode): PolicyValue => policyFor(mode)?.available === false ? "unavailable" : policyFor(mode)?.search_more === false ? "supplied" : "search";
  const formMode = form.mode && allowed.includes(form.mode) ? form.mode : allowed[0];
  const adults = count(draft.adults, "adult");
  const values = new Set(allowed.map(valueOf));
  const way: Way = customOpen || values.size > 1 || values.has("unavailable") ? "custom"
    : pattern ? (clockOf(pattern.first) === anyTime.first && clockOf(pattern.last) === anyTime.last ? "anytime" : "regular")
    : values.has("supplied") ? "tickets" : "search";

  // Policies of modes that are turned off stay as they are.
  function changePolicy(mode: Mode, value: PolicyValue) {
    edit({ ...draft, positioning_policies: [
      ...policies.filter(p => !(mine(p) && p.mode === mode)),
      { direction, gateway_id: gateway.id, mode, available: value !== "unavailable", search_more: value === "search" },
    ] });
  }
  function chooseWay(next: Way) {
    setCustomOpen(next === "custom");
    if (next === "custom") return;
    const others = policies.filter(p => !mine(p)), rest = patterns.filter(p => !mine(p));
    // Searching uses no policy; the other ways use only your journeys for every mode.
    const own = next === "search" ? [] : allowed.map(mode => ({ direction, gateway_id: gateway.id, mode, available: true, search_more: false }));
    const road = allowed.find(mode => mode === "car" || mode === "taxi"), scheduled = allowed.find(mode => mode !== "flight") ?? allowed[0];
    const base = pattern ?? { id: crypto.randomUUID(), direction, gateway_id: gateway.id, duration_minutes: 60, fare_amount: null, currency: "MYR",
      label: `${origin.name} → ${destination.name}`, mode: scheduled };
    const kept = next === "regular" ? [{ ...base, mode: base.mode, ...(way === "anytime" || !pattern ? { first: "06:00", last: "22:00", every_minutes: 30 } : {}) }]
      : next === "anytime" ? [{ ...base, mode: road ?? base.mode, ...anyTime }] : [];
    edit({ ...draft, positioning_policies: [...others, ...own], positioning_patterns: [...rest, ...kept] as PositioningPattern[] });
  }
  function setPattern(change: Partial<PositioningPattern>) {
    if (pattern) edit({ ...draft, positioning_patterns: patterns.map(item => item === pattern ? { ...item, ...change } : item) });
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

  const summary = way === "regular" && pattern ? `${modeLabel(pattern.mode)} ${clockOf(pattern.first)}–${clockOf(pattern.last)}, every ${pattern.every_minutes} min`
    : way === "anytime" && pattern ? `${modeLabel(pattern.mode)}, any time` : wayLabels[way];
  const sameDay = (a: string, aZone: string, b: string, bZone: string) => formatLocal(a, aZone, "date") === formatLocal(b, bZone, "date");

  return <details className="p-subgroup">
    <summary>
      <span className="p-subgroup-title">{origin.name} → {destination.name} ({direction === "outbound" ? "before" : "after"} the trip)</span>
      <span className="p-group-summary">{[summary, group.length ? count(group.length, "journey") : ""].filter(Boolean).join(" · ")}</span>
      <ChevronDown size={16} className="p-chevron" aria-hidden="true" />
    </summary>
    <div className="p-subgroup-body">
      <div className="p-group-fields">
        <Field label="How do you get there?">
          <Select value={way} onValueChange={value => chooseWay(value as Way)}>
            {(Object.keys(wayLabels) as Way[]).map(value => <SelectItem key={value} value={value}>{wayLabels[value]}</SelectItem>)}
          </Select>
        </Field>
      </div>

      {(way === "regular" || way === "anytime") && pattern && <>
        <div className="p-group-fields">
          <Field label="Transport"><Select value={allowed.includes(pattern.mode) ? pattern.mode : ""} onValueChange={value => setPattern({ mode: value as Mode })}>
            {allowed.map(mode => <SelectItem key={mode} value={mode}>{modeLabel(mode)}</SelectItem>)}
          </Select></Field>
          {way === "regular" && <>
            <Field label={`First (${origin.name} time)`}><TemporalInput type="time" value={clockOf(pattern.first)} onValueChange={value => { if (value) setPattern({ first: value }); }} /></Field>
            <Field label="Last"><TemporalInput type="time" value={clockOf(pattern.last)} onValueChange={value => { if (value) setPattern({ last: value }); }} /></Field>
            <NumberField label="Every (min)" value={pattern.every_minutes} min={10} max={1440} integer onChange={n => { if (n !== null) setPattern({ every_minutes: n }); }} />
          </>}
          <NumberField label="Takes (min)" value={pattern.duration_minutes} min={1} max={2880} integer onChange={n => { if (n !== null) setPattern({ duration_minutes: n }); }} />
          <NumberField label={`Price for ${adults} (optional)`} value={pattern.fare_amount} optional placeholder="Not priced" onChange={n => setPattern({ fare_amount: n })} />
          <Field label="Currency"><input maxLength={3} value={pattern.currency} onChange={e => { const code = e.target.value.toUpperCase(); if (/^[A-Z]{0,3}$/.test(code)) setPattern({ currency: code }); }} /></Field>
        </div>
        {clockOf(pattern.last) < clockOf(pattern.first) && <p className="p-field-error">The last departure must not be before the first.</p>}
        {!allowed.includes(pattern.mode) && <p className="p-notice">{modeLabel(pattern.mode)} is off in Transport. Choose another type or turn it on.</p>}
        <p className="p-hint">{way === "regular" ? "Your schedule is used on every day of the trip. Check holiday timetables before you book." : "Leaves when you are ready. Use the time it usually takes."}</p>
      </>}

      {way === "custom" && <>
        <p className="p-hint">Only transport types turned on for this trip are listed.</p>
        <div className="p-group-fields">{allowed.map(mode => <Field key={mode} label={modeLabel(mode)}>
          <Select value={valueOf(mode)} onValueChange={value => changePolicy(mode, value as PolicyValue)}>
            {(Object.keys(policyLabels) as PolicyValue[]).map(value => <SelectItem key={value} value={value}>{policyLabels[value]}</SelectItem>)}
          </Select>
        </Field>)}</div>
      </>}
      {way === "tickets" && !group.length && <p className="p-notice">Add your journey below. Without one, there are no options through {gateway.name}.</p>}
      {way === "custom" && allowed.filter(mode => valueOf(mode) === "supplied" && !group.some(s => s.mode === mode)).map(mode =>
        <p className="p-notice" key={mode}>{modeLabel(mode)}: only your journeys are allowed here, but you have not added one. It gives no options.</p>)}

      {(way === "tickets" || way === "custom" || group.length > 0) && <>
        <div className="p-subhead"><h4>Your journeys</h4><InfoTip topic="your journeys" align="end">Enter city-to-city times, including station access. Airport time before onward flights is added separately. Your journeys are used even outside the departure times. To change a journey, remove it and add it again.</InfoTip></div>
        {group.length ? <ul className="p-item-rows">{group.map(service => {
          const unused = !draft.modes.includes(service.mode) ? `${modeLabel(service.mode)} is off for this trip` : valueOf(service.mode) === "unavailable" ? "set to Don't use" : "";
          return <li key={service.id}>
            <span>{service.label} · {modeLabel(service.mode)} · {formatLocal(service.departure, origin.timezone)} → {formatLocal(service.arrival, destination.timezone, sameDay(service.departure, origin.timezone, service.arrival, destination.timezone) ? "time" : "datetime")} · {service.fare_amount === null ? "Not priced" : moneyShort(service.fare_amount, service.currency)} for {adults}
              {unused && <span className="p-warning"> · not used: {unused}</span>}</span>
            <button type="button" className="p-text-button" aria-label={`Remove ${service.label}`} onClick={() => edit({ ...draft, positioning_services: services.filter(s => s.id !== service.id) })}>Remove</button>
          </li>;
        })}</ul> : <p className="p-hint">None.</p>}

        <details className="p-add-form" open={way === "tickets" && !group.length ? true : undefined}>
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
      </>}
    </div>
  </details>;
}

/**
 * Where's home › other start and end cities. On a round trip one list covers both directions until the user
 * chooses "Different on the way back", which shows the separate start and end lists (with home as a choice).
 * Each other city has its travel settings to and from home.
 */
export function StartCities({ draft, edit }: { draft: TripDraft; edit: (value: TripDraft) => void }) {
  const home = draft.home;
  const used: Direction[] = draft.one_way === "from_home" ? ["outbound"] : draft.one_way === "to_home" ? ["return"] : ["outbound", "return"];
  const others = (list: Place[]) => list.filter(place => place.id !== home?.id);
  const homeIn = (list: Place[]) => !list.length || list.some(place => place.id === home?.id);
  const ids = (list: Place[]) => others(list).map(place => place.id).sort().join("|");
  const same = used.length === 1 || (ids(draft.departures) === ids(draft.arrivals) && homeIn(draft.departures) && homeIn(draft.arrivals));
  const [split, setSplit] = useState(!same);
  if (!home) return null;
  const separate = split && used.length === 2;
  const key = (direction: Direction) => direction === "outbound" ? "departures" as const : "arrivals" as const;
  const shared = others(draft[key(used[0])]);
  const full = shared.length >= 2;
  // Home stays a choice; the engine reads a list with only home as [].
  const setShared = (places: Place[]) => edit({ ...draft, ...Object.fromEntries(used.map(direction => [key(direction), places.length ? [home, ...places] : []])) });
  const label = used.length === 2 ? "Also leave from and return to" : used[0] === "outbound" ? "Also leave from" : "Also return to";
  return <div className="p-start-cities">
    {separate ? <div className="p-group-columns">{used.map(direction => <EndpointList key={direction} draft={draft} edit={edit} direction={direction} />)}</div> : <>
      <PlacePicker label={label} placeholder="Another city, e.g. one with more flights" disabled={full} limitText={`${shared.length} of 2`}
        hint={full ? "Up to 2 other cities." : undefined} disabledIds={[home.id, ...shared.map(place => place.id)]}
        onSelect={place => { if (!full) setShared([...shared, place]); }} />
      {shared.length > 0 && <div className="p-chips">{shared.map(place => <span key={place.id}>{place.name}
        <button type="button" aria-label={`Remove ${place.name}`} onClick={() => setShared(shared.filter(item => item.id !== place.id))}>×</button>
      </span>)}</div>}
    </>}
    {used.length === 2 && <button type="button" className="p-text-button" onClick={() => {
      if (separate) { const list = others(draft.departures); edit({ ...draft, departures: list.length ? [home, ...list] : [], arrivals: list.length ? [home, ...list] : [] }); }
      setSplit(!separate);
    }}>{separate ? "Same cities on the way back" : "Different on the way back"}</button>}
    {used.flatMap(direction => draft[key(direction)].filter(gateway => gateway.id !== home.id)
      .map(gateway => <GatewayPositioning key={`${home.id}:${direction}:${gateway.id}`} draft={draft} gateway={gateway} direction={direction} edit={edit} />))}
  </div>;
}
