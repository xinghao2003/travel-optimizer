import { Field } from "./PlannerForms";
import { modes, type Mode, type Place, type PositioningPolicy, type TripDraft } from "../lib/planner";

function GatewayPositioning({ draft, gateway, direction, edit }: {
  draft: TripDraft; gateway: Place; direction: PositioningPolicy["direction"];
  edit: (value: TripDraft) => void;
}) {
  const home = draft.home!;
  const origin = direction === "outbound" ? home : gateway;
  const destination = direction === "outbound" ? gateway : home;
  const policies = draft.positioning_policies ?? [];
  const policyFor = (mode: Mode) => policies.find(p => p.direction === direction && p.gateway_id === gateway.id && p.mode === mode);
  function changePolicy(mode: Mode, value: string) {
    edit({ ...draft, positioning_policies: [
      ...policies.filter(p => !(p.direction === direction && p.gateway_id === gateway.id && p.mode === mode)),
      { direction, gateway_id: gateway.id, mode, available: value !== "unavailable", search_more: value === "search" },
    ] });
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
    <p className="p-hint">Enter schedules, prices and preparation times under Transport &amp; fares → Transport details. These settings control automatic search and which modes can be used for positioning.</p>
  </details>;
}

export function PositioningSettings({ draft, edit }: { draft: TripDraft; edit: (value: TripDraft) => void }) {
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
    <p className="p-hint">Blank uses the full boundary day, also with flexible dates. Search settings are independent for each gateway, direction, and mode.</p>
    {home ? (["outbound", "return"] as const).flatMap(direction => (direction === "outbound" ? draft.departures : draft.arrivals)
      .filter(gateway => gateway.id !== home.id)
      .map(gateway => <GatewayPositioning key={`${home.id}:${direction}:${gateway.id}`} draft={draft} gateway={gateway} direction={direction} edit={edit}  />)) : <p>Choose home and candidate gateways to configure positioning.</p>}
  </details>;
}
