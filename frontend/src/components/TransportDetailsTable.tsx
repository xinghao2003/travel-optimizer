import { Fragment, useEffect, useState } from "react";
import { Button } from "./ui/button";
import { Field } from "./PlannerForms";
import { localInputToISO, modes, money, type SavedTrip, type TransportOption, type TransportConnectionRow } from "../lib/planner";

type Draft = Omit<TransportOption, "duration_minutes" | "before_minutes" | "after_minutes" | "low" | "high" | "departure" | "capacity"> & {
  duration_minutes: string; before_minutes: string; after_minutes: string; low: string; high: string;
  departure: string; capacity: string; schedule: "flexible" | "scheduled";
};
type Pending = { signature: string; options: Draft[] };
const pairKey = (row: { from_id: string; to_id: string }) => JSON.stringify([row.from_id, row.to_id]);
const localInput = (value: string, zone: string) => new Intl.DateTimeFormat("sv-SE", {
  timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
}).format(new Date(value)).replace(" ", "T");

function asDraft(option: TransportOption, row?: TransportConnectionRow): Draft {
  return { ...option, duration_minutes: option.duration_minutes?.toString() ?? "", before_minutes: String(option.before_minutes),
    after_minutes: String(option.after_minutes), low: option.low?.toString() ?? "", high: option.high?.toString() ?? "",
    capacity: String(option.capacity), schedule: option.departure ? "scheduled" : "flexible",
    departure: option.departure ? localInput(option.departure, row?.from_timezone ?? "UTC") : "" };
}

export function TransportDetailsTable({ trip, save }: { trip: SavedTrip; save: (options: TransportOption[]) => Promise<void> }) {
  const rows = trip.transport_connection_rows ?? [];
  const stored = trip.transport_options ?? [];
  const current = stored.filter(o => o.adults === trip.spec.adults);
  const signature = JSON.stringify(current);
  const storageKey = `wayfinder:transport-details:${trip.id}:${trip.spec.adults}`;
  const [pending, setPending] = useState<Pending | null>(() => {
    try {
      const value = JSON.parse(localStorage.getItem(storageKey) ?? "null");
      return value && typeof value.signature === "string" && Array.isArray(value.options) ? value : null;
    } catch { return null; }
  });
  const [expanded, setExpanded] = useState<string[]>([]);
  const [filter, setFilter] = useState("all");
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  useEffect(() => {
    try {
      if (pending) localStorage.setItem(storageKey, JSON.stringify(pending));
      else localStorage.removeItem(storageKey);
    } catch { /* The in-memory draft remains editable. */ }
  }, [pending, storageKey]);
  const options = pending?.options ?? current.map(o => asDraft(o, rows.find(r => pairKey(r) === pairKey(o))));
  const stale = pending !== null && pending.signature !== signature;
  const rowOptions = (row: TransportConnectionRow) => options.filter(o => pairKey(o) === pairKey(row));
  function change(id: string, values: Partial<Draft>) {
    setPending({ signature: pending?.signature ?? signature, options: options.map(o => o.id === id ? { ...o, ...values } : o) });
    setNotice("");
  }
  function add(row: TransportConnectionRow) {
    const option: Draft = { id: `transport:${crypto.randomUUID()}`, from_id: row.from_id, to_id: row.to_id,
      mode: "taxi", adults: trip.spec.adults, availability: "unknown", duration_minutes: row.suggested_minutes ? String(Math.round(row.suggested_minutes)) : "",
      before_minutes: "0", after_minutes: "0", departure: "", schedule: "flexible", low: "", high: "", currency: "MYR",
      fare_kind: "fixed", unit: "party", capacity: "4", label: "User-supplied transport" };
    setPending({ signature: pending?.signature ?? signature, options: [...options, option] });
    setExpanded(values => [...new Set([...values, pairKey(row)])]);
    setNotice("");
  }
  async function apply() {
    setBusy(true); setError(""); setNotice("");
    try {
      const number = (value: string, label: string, optional = false) => {
        if (optional && !value.trim()) return null;
        if (!value.trim() || !Number.isFinite(Number(value)) || Number(value) < 0) throw new Error(`Enter a nonnegative ${label}.`);
        return Number(value);
      };
      const parsed = options.map((draft): TransportOption => {
        const { schedule, ...option } = draft;
        const row = rows.find(r => pairKey(r) === pairKey(draft));
        if (!row) throw new Error("Trip connections changed. Discard this draft and review the current connections.");
        const duration = number(draft.duration_minutes, "travel duration", true);
        if (draft.availability === "available" && (!duration || duration <= 0)) throw new Error(`${row.label}: enter a positive travel duration.`);
        if (duration === 0) throw new Error(`${row.label}: travel duration must be positive or blank.`);
        if (draft.availability === "available" && schedule === "scheduled" && !draft.departure) throw new Error(`${row.label}: enter the service departure date and time.`);
        const low = number(draft.low, "fare", true);
        const high = draft.fare_kind === "fixed" ? low : number(draft.high, "maximum fare", true);
        if (high !== null && (low === null || high < low)) throw new Error(`${row.label}: maximum fare must be at least the minimum.`);
        if (!/^[A-Z]{3}$/.test(draft.currency)) throw new Error(`${row.label}: enter a three-letter currency code.`);
        const capacity = number(draft.capacity, "vehicle capacity")!;
        if (!Number.isInteger(capacity) || capacity < 1 || capacity > 9) throw new Error("Vehicle capacity must be between 1 and 9.");
        return { ...option, duration_minutes: duration, before_minutes: number(draft.before_minutes, "preparation time")!,
          after_minutes: number(draft.after_minutes, "arrival time")!, capacity, low, high,
          departure: schedule === "scheduled" && draft.departure ? localInputToISO(draft.departure, row.from_timezone) : null };
      });
      await save([...stored.filter(o => o.adults !== trip.spec.adults), ...parsed]);
      localStorage.removeItem(storageKey);
      setPending(null); setNotice("Transport details applied. Routes recalculated.");
    } catch (err) { setError(err instanceof Error ? err.message : "Transport details could not be applied."); }
    finally { setBusy(false); }
  }
  const visible = rows.filter(row => (filter === "all" || row.kind === filter || (filter === "entered" && rowOptions(row).length > 0))
    && row.label.toLowerCase().includes(query.toLowerCase()));
  const confirmed = options.filter(o => o.availability === "available").length;
  return <section className="p-panel" aria-labelledby="transport-details-title">
    <div className="p-panel-heading"><h2 id="transport-details-title" tabIndex={-1}>Transport details</h2><span className="p-tag">{confirmed} confirmed options · {trip.spec.adults} {trip.spec.adults === 1 ? "traveler" : "travelers"}</span></div>
    <p>Add missing services, fares, and travel times here. Confirm each service before using it; suggested connections do not establish availability. Each direction is separate.</p>
    <div className="p-actions p-transport-toolbar">
      <Field label="Connections"><select value={filter} onChange={e => setFilter(e.target.value)}><option value="all">All connections</option><option value="airport-city">Airport ↔ city</option><option value="airport-airport">Airport changes</option><option value="city-city">City ↔ city</option><option value="entered">Entered options</option><option value="saved">Saved, outside current connections</option></select></Field>
      <Field label="Find connection"><input type="search" placeholder="City or airport" value={query} onChange={e => setQuery(e.target.value)} /></Field>
      <Button type="button" disabled={busy || !pending || stale} onClick={() => void apply()}>{busy ? "Applying…" : "Apply transport details"}</Button>
      {pending && <Button type="button" variant="ghost" disabled={busy} onClick={() => { setPending(null); setError(""); }}>Discard changes</Button>}
      <span className="p-hint" role="status">{pending ? "Draft saved in this browser · apply to recalculate" : notice || "Changes apply together and recalculate once"}</span>
    </div>
    {stale && <p className="p-notice">Saved transport details changed while this draft was open. Discard changes to load the current values.</p>}
    {error && <p role="alert" className="p-error">{error}</p>}
    <div className="p-airport-table-wrap"><table className="p-airport-table p-transport-table"><caption className="sr-only">Transport options for airport access, airport changes and city connections</caption>
      <thead><tr><th scope="col">Connection</th><th scope="col">Entered options</th><th scope="col">Status</th><th scope="col">Details</th></tr></thead>
      <tbody>{visible.map(row => {
        const key = pairKey(row), entries = rowOptions(row), open = expanded.includes(key);
        const available = entries.filter(o => o.availability === "available");
        return <Fragment key={key}><tr>
          <th scope="row">{row.label}<small>{row.kind === "saved" ? "Saved only · no current journey requires this pair" : row.kind === "airport-airport" ? `${row.journey_count} collected journeys change airports` : row.kind === "city-city" ? `${row.journey_count} collected journeys` : "Airport access / egress"}</small></th>
          <td>{entries.length ? entries.map(o => <small key={o.id}>{o.mode} · {o.availability}{o.availability === "available" && <> · {o.duration_minutes} min travel · {o.low === "" ? "Fare unknown" : `${money(Number(o.low), /^[A-Z]{3}$/.test(o.currency) ? o.currency : "MYR")}${o.fare_kind === "range" ? "+ range" : ""} / ${o.unit}`}{o.schedule === "scheduled" && o.departure && <> · {o.departure.replace("T", " ")} ({row.from_timezone})</>}</>}</small>) : "None entered"}</td>
          <td>{available.length ? "Confirmed" : entries.length ? "Not in use" : row.kind === "airport-airport" ? "Needs transfer" : row.journey_count > 0 ? "Using collected data" : row.kind === "airport-city" ? "Using trip timing" : "Optional connection"}</td>
          <td><Button type="button" size="sm" variant="secondary" aria-expanded={open} onClick={() => setExpanded(items => open ? items.filter(k => k !== key) : [...items, key])}>{open ? "Close" : entries.length ? "Edit options" : "Add options"}<span className="sr-only"> · {row.label}</span></Button></td>
        </tr>{open && <tr className="p-transport-expanded"><td colSpan={4}>
          {entries.map((option, index) => <fieldset key={option.id} className="p-transport-option" disabled={busy}>
            <legend>Option {index + 1} · {row.label}</legend>
            <div className="p-grid">
              <Field label="Transport mode"><select value={option.mode} onChange={e => { const mode = e.target.value as TransportOption["mode"]; change(option.id, { mode, schedule: ["taxi", "car"].includes(mode) ? "flexible" : "scheduled", duration_minutes: "" }); }}>{modes.filter(mode => mode !== "flight" || row.kind === "city-city").map(mode => <option key={mode}>{mode}</option>)}</select></Field>
              <Field label="Availability"><select value={option.availability} onChange={e => change(option.id, { availability: e.target.value as TransportOption["availability"] })}><option value="unknown">Unknown · do not use</option><option value="available">Confirmed available</option><option value="unavailable">Unavailable · do not use</option></select></Field>
              <Field label="Service name (optional)"><input maxLength={160} value={option.label} onChange={e => change(option.id, { label: e.target.value })} /></Field>
              <Field label="Travel time · min"><input type="number" min="0.1" step="any" value={option.duration_minutes} onChange={e => change(option.id, { duration_minutes: e.target.value })} /></Field>
              <Field label="Preparation before · min" hint="Pickup, walking to boarding, check-in or waiting allowance."><input type="number" min="0" step="any" value={option.before_minutes} onChange={e => change(option.id, { before_minutes: e.target.value })} /></Field>
              <Field label="After arrival · min" hint="Disembarking or reaching the connection endpoint."><input type="number" min="0" step="any" value={option.after_minutes} onChange={e => change(option.id, { after_minutes: e.target.value })} /></Field>
              <Field label="Departure availability"><select value={option.schedule} onChange={e => change(option.id, { schedule: e.target.value as Draft["schedule"] })}><option value="flexible">Flexible · assumes available when needed</option><option value="scheduled">Specific departure</option></select></Field>
              {option.schedule === "scheduled" && <Field label={`Departs · ${row.from_timezone}`}><input type="datetime-local" value={option.departure} onChange={e => change(option.id, { departure: e.target.value })} /></Field>}
              <Field label={option.fare_kind === "range" ? "Minimum fare (optional)" : "Fare (optional)"}><input type="number" min="0" step="0.01" placeholder="Unknown" value={option.low} onChange={e => change(option.id, { low: e.target.value })} /></Field>
              <Field label="Fare type"><select value={option.fare_kind} onChange={e => change(option.id, { fare_kind: e.target.value as TransportOption["fare_kind"] })}><option value="fixed">Fixed amount</option><option value="range">Range</option></select></Field>
              {option.fare_kind === "range" && <Field label="Maximum fare (optional)"><input type="number" min={option.low || 0} step="0.01" placeholder="Unbounded" value={option.high} onChange={e => change(option.id, { high: e.target.value })} /></Field>}
              <Field label="Fare basis"><select value={option.unit} onChange={e => change(option.id, { unit: e.target.value as TransportOption["unit"] })}><option value="party">Whole party</option><option value="person">Per person</option><option value="vehicle">Per vehicle</option></select></Field>
              {option.unit === "vehicle" && <Field label="Travelers per vehicle"><input type="number" min="1" max="9" step="1" value={option.capacity} onChange={e => change(option.id, { capacity: e.target.value })} /></Field>}
              <Field label="Currency"><input maxLength={3} value={option.currency} onChange={e => change(option.id, { currency: e.target.value.toUpperCase() })} /></Field>
            </div>
            {!trip.spec.modes.includes(option.mode) && row.kind === "city-city" && <p className="p-notice">Enable {option.mode} in Trip setup to use this intercity option.</p>}
            <p className="p-hint">{option.schedule === "scheduled" ? "Preparation ends at the entered departure. Add another option for another departure." : "Flexible availability is your assumption; include expected waiting in preparation time."} Flight readiness and arrival buffers remain separate.</p>
            <Button type="button" size="sm" variant="ghost" onClick={() => change(option.id, { availability: "unknown", duration_minutes: "", before_minutes: "0", after_minutes: "0", low: "", high: "", departure: "", schedule: "flexible" })}>Clear option</Button>
          </fieldset>)}
          {!entries.length && <p>No service is assumed for this connection. Add a method you have checked.</p>}
          <Button type="button" size="sm" variant="secondary" disabled={busy} onClick={() => add(row)}>Add transport option</Button>
          {row.suggested_minutes !== null && <p className="p-hint">{row.timing_source}: {Math.round(row.suggested_minutes)} min by road. Check travel time for the chosen mode.</p>}
        </td></tr>}</Fragment>;
      })}{!visible.length && <tr><td colSpan={4}>No connections match this filter.</td></tr>}</tbody>
    </table></div>
    <p className="p-hint">Collected services remain available. Existing airport road/fallback timing stays until replaced or the taxi method is marked unavailable. Journey-specific fare overrides take priority.</p>
  </section>;
}
