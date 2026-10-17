import { useState } from "react";
import { Field } from "./PlannerForms";
import { Button } from "./ui/button";
import { localInputToISO, localTime, money, modes, type Mode, type Place, type PositioningPolicy, type TripDraft } from "../lib/planner";

function GatewayPositioning({ draft, gateway, direction, edit, report }: {
  draft: TripDraft; gateway: Place; direction: PositioningPolicy["direction"];
  edit: (value: TripDraft) => void; report: (message: string) => void;
}) {
  const home = draft.home!;
  const origin = direction === "outbound" ? home : gateway;
  const destination = direction === "outbound" ? gateway : home;
  const [form, setForm] = useState({ mode: "rail" as Mode, departure: "", arrival: "", fare: "", currency: "MYR", label: "" });
  const policies = draft.positioning_policies ?? [];
  const services = draft.positioning_services ?? [];
  const group = services.filter(s => s.direction === direction && s.gateway_id === gateway.id);
  const policyFor = (mode: Mode) => policies.find(p => p.direction === direction && p.gateway_id === gateway.id && p.mode === mode);
  function changePolicy(mode: Mode, value: string) {
    edit({ ...draft, positioning_policies: [
      ...policies.filter(p => !(p.direction === direction && p.gateway_id === gateway.id && p.mode === mode)),
      { direction, gateway_id: gateway.id, mode, available: value !== "unavailable", search_more: value === "search" },
    ] });
  }
  function add() {
    try {
      if (!form.departure || !form.arrival) throw new Error("Enter both departure and arrival dates and times.");
      const departure = localInputToISO(form.departure, origin.timezone);
      const arrival = localInputToISO(form.arrival, destination.timezone);
      if (new Date(arrival) <= new Date(departure)) throw new Error("Arrival must follow departure.");
      const fare = form.fare.trim() === "" ? null : Number(form.fare);
      if (fare !== null && (!Number.isFinite(fare) || fare < 0)) throw new Error("Enter a non-negative party fare or leave it blank.");
      if (!/^[A-Z]{3}$/.test(form.currency)) throw new Error("Enter a three-letter currency code.");
      if (!draft.modes.includes(form.mode)) throw new Error("Enable this mode under Allowed intercity transportation first.");
      if (policyFor(form.mode)?.available === false) throw new Error("This mode is unavailable for this direction. Change its setting before adding a service.");
      edit({ ...draft, positioning_services: [...services, {
        id: crypto.randomUUID(), direction, gateway_id: gateway.id, mode: form.mode,
        departure, arrival, fare_amount: fare, currency: form.currency,
        label: form.label.trim() || `${form.mode} ${origin.name} → ${destination.name}`,
      }] });
      setForm(f => ({ ...f, departure: "", arrival: "", fare: "", label: "" }));
      report("");
    } catch (err) { report(err instanceof Error ? err.message : "Invalid positioning service."); }
  }
  return <details className="p-details">
    <summary>{direction === "outbound" ? "Outbound" : "Return"}: {origin.name} → {destination.name}</summary>
    <div className="p-grid">{modes.map(mode => {
      const policy = policyFor(mode);
      const value = policy?.available === false ? "unavailable" : policy?.search_more === false ? "supplied" : "search";
      return <Field key={mode} label={`${mode} options`} hint={!draft.modes.includes(mode) ? "Also disabled by the trip's allowed modes." : undefined}>
        <select value={value} onChange={e => changePolicy(mode, e.target.value)}>
          <option value="search">Search + supplied services</option>
          <option value="supplied">Supplied services only</option>
          <option value="unavailable">Unavailable</option>
        </select>
      </Field>;
    })}</div>
    {modes.some(mode => policyFor(mode)?.available !== false && policyFor(mode)?.search_more === false && !group.some(s => s.mode === mode) && draft.modes.includes(mode)) &&
      <p className="p-notice">A mode set to supplied services only has no entered services yet. It contributes no options until you add one.</p>}
    {group.map(service => <div className="p-inline" key={service.id}>
      <span><strong>{service.label}</strong> · {service.mode}<br />
        {localTime(service.departure, origin.timezone)} → {localTime(service.arrival, destination.timezone)} · {money(service.fare_amount, service.currency)} for the party
        {(!draft.modes.includes(service.mode) || policyFor(service.mode)?.available === false) && " · disabled"}
      </span>
      <button type="button" aria-label={`Remove ${service.label}`} onClick={() => edit({ ...draft, positioning_services: services.filter(s => s.id !== service.id) })}>×</button>
    </div>)}
    <div className="p-grid">
      <Field label="Service mode"><select value={form.mode} onChange={e => setForm(f => ({ ...f, mode: e.target.value as Mode }))}>{modes.map(mode => <option key={mode}>{mode}</option>)}</select></Field>
      <Field label="Service name (optional)"><input maxLength={160} value={form.label} onChange={e => setForm(f => ({ ...f, label: e.target.value }))} /></Field>
      <Field label={`Departs · ${origin.timezone}`}><input type="datetime-local" value={form.departure} onChange={e => setForm(f => ({ ...f, departure: e.target.value }))} /></Field>
      <Field label={`Arrives · ${destination.timezone}`}><input type="datetime-local" value={form.arrival} onChange={e => setForm(f => ({ ...f, arrival: e.target.value }))} /></Field>
      <Field label="Total party fare (optional)"><input type="number" min="0" step="0.01" placeholder="Unknown" value={form.fare} onChange={e => setForm(f => ({ ...f, fare: e.target.value }))} /></Field>
      <Field label="Fare currency"><input maxLength={3} value={form.currency} onChange={e => setForm(f => ({ ...f, currency: e.target.value.toUpperCase() }))} /></Field>
    </div>
    <Button type="button" size="sm" variant="secondary" onClick={add}>Add supplied service</Button>
    <p className="p-hint">Enter city-to-city times, including station access if needed. Onward airport access and flight readiness buffers remain separate. Supplied services use their entered times even outside the automatic search departure window. Remove and re-add a service to change it.</p>
  </details>;
}

export function PositioningSettings({ draft, edit, report }: { draft: TripDraft; edit: (value: TripDraft) => void; report: (message: string) => void }) {
  const home = draft.home;
  return <details className="p-details"><summary>Home time limits and positioning services · optional</summary>
    <div className="p-grid">
      <Field label={`Earliest departure from home · ${draft.start_date}`} hint={home?.timezone ?? "Choose home first"}>
        <input type="time" value={draft.home_departure_earliest ?? ""} onChange={e => edit({ ...draft, home_departure_earliest: e.target.value || null })} />
      </Field>
      <Field label={`Latest arrival home · ${draft.end_date}`} hint={home?.timezone ?? "Choose home first"}>
        <input type="time" value={draft.home_arrival_latest ?? ""} onChange={e => edit({ ...draft, home_arrival_latest: e.target.value || null })} />
      </Field>
    </div>
    <p className="p-hint">Blank uses the full boundary day. These limits also apply with flexible dates. Supplied schedules and fares are saved with this trip. Search settings are independent for each gateway, direction, and mode; existing provider options are excluded when a mode is unavailable or supplied only.</p>
    {home ? (["outbound", "return"] as const).flatMap(direction => (direction === "outbound" ? draft.departures : draft.arrivals)
      .filter(gateway => gateway.id !== home.id)
      .map(gateway => <GatewayPositioning key={`${home.id}:${direction}:${gateway.id}`} draft={draft} gateway={gateway} direction={direction} edit={edit} report={report} />)) : <p>Choose home and candidate gateways to configure positioning.</p>}
  </details>;
}
