import { AirportTransferTable } from "./components/AirportTransferTable";
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { Compass, LoaderCircle, Play, Plus, Save, Square, ArrowRight, RefreshCw } from "lucide-react";
import { Button } from "./components/ui/button";
import { AdvancedSettings, FareEditor, Field, NumberField, PlaceChips, PlacePicker, RulesEditor } from "./components/PlannerForms";
import { PositioningSettings } from "./components/PositioningSettings";
import { MissingFaresTable, type SharedFare } from "./components/MissingFaresTable";
import { groupMissingFares } from "./lib/missingFares";
import { api, blankTrip, cityHourCost, localTime, modes, money, routeCost, type AirportConnection, type AirportConnectionRequirement, type AirportTransferMode, type Job, type Movement, type Offer, type Place, type PricingRule, type Result, type Route, type SavedSummary, type SavedTrip, type TripDraft, type TripSpec } from "./lib/planner";
import "./planner.css";

const LazyPareto = lazy(() => import("./components/ParetoExplorer").then(m => ({ default: m.ParetoExplorer })));
const LazyMap = lazy(() => import("./components/PlannerMap").then(m => ({ default: m.PlannerMap })));
function ParetoExplorer(props: { routes: Route[]; dominated?: Route[]; selected: string | null; onSelect: (id: string) => void }) {
  return <Suspense fallback={<div className="p-empty">Loading the frontier chart…</div>}><LazyPareto {...props} /></Suspense>;
}
function PlannerMap(props: { places: Place[]; route: Route | null }) {
  return <Suspense fallback={<div className="p-empty">Loading the itinerary map…</div>}><LazyMap {...props} /></Suspense>;
}

type AirportConnectionDraft = {
  from_airport: string;
  to_airport: string;
  from_name: string;
  to_name: string;
  journey_count: number;
  unresolved_journey_count: number;
  required: boolean;
  mode: AirportTransferMode | "";
  duration_minutes: number | null;
  fare_amount: number | null;
  currency: string;
};

const airportTransferModes: AirportTransferMode[] = modes.filter((mode): mode is AirportTransferMode => mode !== "flight");
const noAirportConnectionRequirements: AirportConnectionRequirement[] = [];
const noAirportConnections: AirportConnection[] = [];

function airportConnectionRows(requirements: AirportConnectionRequirement[], connections: AirportConnection[]): AirportConnectionDraft[] {
  const requiredByPair = new Map(requirements.map(item => [`${item.from_airport}>${item.to_airport}`, item]));
  const connectionByPair = new Map(connections.map(item => [`${item.from_airport}>${item.to_airport}`, item]));
  const keys = [...new Set([...requiredByPair.keys(), ...connectionByPair.keys()])].sort();
  return keys.map(key => {
    const requirement = requiredByPair.get(key);
    const connection = connectionByPair.get(key);
    const [from_airport, to_airport] = key.split(">");
    return {
      from_airport, to_airport,
      from_name: requirement?.from_name ?? from_airport,
      to_name: requirement?.to_name ?? to_airport,
      journey_count: requirement?.journey_count ?? 0,
      unresolved_journey_count: requirement?.unresolved_journey_count ?? 0,
      required: !!requirement,
      mode: connection?.mode ?? "",
      duration_minutes: connection?.duration_minutes ?? null,
      fare_amount: connection?.fare_amount ?? null,
      currency: connection?.currency ?? "MYR",
    };
  });
}

function AirportConnectionsTable({ tripId, requirements, connections, onSaved, report }: {
  tripId: string;
  requirements: AirportConnectionRequirement[];
  connections: AirportConnection[];
  onSaved: (record: SavedTrip, result: Result) => void;
  report: (message: string) => void;
}) {
  const requirementSignature = JSON.stringify(requirements);
  const connectionSignature = JSON.stringify(connections);
  const [rows, setRows] = useState<AirportConnectionDraft[]>(() => airportConnectionRows(requirements, connections));
  const [busy, setBusy] = useState(false);
  useEffect(() => setRows(airportConnectionRows(requirements, connections)), [tripId, requirementSignature, connectionSignature, requirements, connections]);

  if (!rows.length) return null;
  const requiredJourneys = requirements.reduce((sum, item) => sum + item.journey_count, 0);
  const pairKey = (row: Pick<AirportConnectionDraft, "from_airport" | "to_airport">) => `${row.from_airport}>${row.to_airport}`;
  function updateRow(key: string, change: Partial<AirportConnectionDraft>) {
    setRows(current => current.map(row => pairKey(row) === key ? { ...row, ...change } : row));
  }
  function clearOrRemove(row: AirportConnectionDraft) {
    if (row.required) updateRow(pairKey(row), { mode: "", duration_minutes: null, fare_amount: null, currency: "MYR" });
    else setRows(current => current.filter(item => pairKey(item) !== pairKey(row)));
  }
  async function save() {
    setBusy(true);
    try {
      const incomplete = rows.some(row => (row.mode || row.duration_minutes !== null || row.fare_amount !== null)
        && (!row.mode || row.duration_minutes === null || !Number.isFinite(row.duration_minutes) || row.duration_minutes <= 0));
      if (incomplete) throw new Error("Complete the mode and positive transfer time, or clear that row before saving.");
      if (rows.some(row => row.fare_amount !== null && (!Number.isFinite(row.fare_amount) || row.fare_amount < 0))) throw new Error("Enter a nonnegative party fare or leave it blank.");
      const configured = rows.filter(row => row.mode && row.duration_minutes !== null && row.duration_minutes > 0)
        .map(({ from_airport, to_airport, mode, duration_minutes, fare_amount, currency }) => ({
          from_airport, to_airport, mode, duration_minutes, fare_amount,
          currency: fare_amount === null ? "MYR" : (currency || "MYR").toUpperCase(),
        }));
      if (configured.some(row => row.fare_amount !== null && !/^[A-Z]{3}$/.test(row.currency))) throw new Error("Use a three-letter currency code for each fare.");
      const result = await api<Result>(`/trips/${tripId}/airport-connections`, "PUT", { connections: configured });
      const record = await api<SavedTrip>(`/trips/${tripId}`);
      onSaved(record, result);
    } catch (err) { report(err instanceof Error ? err.message : "Airport connections could not be saved."); }
    finally { setBusy(false); }
  }

  return <section className="p-panel" aria-labelledby="airport-connections-title">
    <div className="p-panel-heading"><div><span className="p-step">↔</span><h2 id="airport-connections-title">Airport connections</h2></div><span className="p-tag">{requirements.length} unique pairs · {requiredJourneys} journeys</span></div>
    <p>Enter a connection you have checked for each airport change. Its duration should include your transfer buffer and must fit the scheduled layover. One directed pair applies to every matching journey in this trip; the reverse direction is a separate row.</p>
    <div className="p-airport-table-wrap"><table className="p-airport-table"><thead><tr><th scope="col">Airport change</th><th scope="col">Journeys</th><th scope="col">Mode</th><th scope="col">Transfer time · min</th><th scope="col">Party fare</th><th scope="col">Currency</th><th scope="col"><span className="sr-only">Clear or remove</span></th></tr></thead>
      <tbody>{rows.map(row => <tr key={pairKey(row)}>
        <th scope="row"><strong>{row.from_airport} → {row.to_airport}</strong><small>{row.from_name} → {row.to_name}{!row.required && " · saved"}</small></th>
        <td>{row.required ? <>{row.journey_count}<small className={row.unresolved_journey_count > 0 ? "p-warning" : ""}>{row.unresolved_journey_count} unresolved</small></> : "—"}</td>
        <td><select aria-label={`${row.from_airport} to ${row.to_airport} transfer mode`} value={row.mode} onChange={event => updateRow(pairKey(row), { mode: event.target.value as AirportTransferMode | "" })}><option value="">Choose mode</option>{airportTransferModes.map(mode => <option value={mode} key={mode}>{mode}</option>)}</select></td>
        <td><input aria-label={`${row.from_airport} to ${row.to_airport} transfer time in minutes`} type="number" min="1" step="1" value={row.duration_minutes ?? ""} onChange={event => updateRow(pairKey(row), { duration_minutes: event.target.value === "" ? null : Number(event.target.value) })} /></td>
        <td><input aria-label={`${row.from_airport} to ${row.to_airport} total party fare`} type="number" min="0" step="0.01" placeholder="Unknown" value={row.fare_amount ?? ""} onChange={event => updateRow(pairKey(row), { fare_amount: event.target.value === "" ? null : Number(event.target.value) })} /></td>
        <td><input aria-label={`${row.from_airport} to ${row.to_airport} fare currency`} maxLength={3} value={row.currency} onChange={event => updateRow(pairKey(row), { currency: event.target.value.toUpperCase() })} /></td>
        <td><button className="p-airport-clear" type="button" onClick={() => clearOrRemove(row)} aria-label={row.required ? `Clear ${row.from_airport} to ${row.to_airport}` : `Remove saved ${row.from_airport} to ${row.to_airport}`}>×</button></td>
      </tr>)}</tbody>
    </table></div>
    <div className="p-actions"><Button type="button" size="sm" disabled={busy} onClick={() => void save()}>{busy ? "Saving…" : "Save connections"}</Button><span className="p-hint">Rows without both a mode and positive duration remain unresolved. Blank fare keeps transfer cost unknown.</span></div>
  </section>;
}

function BundleEntry({ route, placeName, save, report }: { route: Route; placeName: (id: string) => string; save: (offer: Offer) => Promise<void>; report: (s: string) => void }) {
  const flights = route.movements.filter(m => m.mode === "flight");
  const [selected, setSelected] = useState<string[]>(flights.map(m => m.id));
  const [kind, setKind] = useState<"round-trip" | "multi-city">("multi-city");
  const [low, setLow] = useState("");
  const [high, setHigh] = useState("");
  const [currency, setCurrency] = useState("MYR");
  const [busy, setBusy] = useState(false);
  useEffect(() => { setSelected(route.movements.filter(m => m.mode === "flight").map(m => m.id)); }, [route.id]);
  if (flights.length < 2) return null;
  async function submit() {
    setBusy(true);
    try {
      if (selected.length < 2 || low === "" || Number(low) < 0 || (high !== "" && Number(high) < Number(low))) throw new Error("Choose at least two flights and a valid combined fare.");
      await save({ id: `bundle:${crypto.randomUUID()}`, movement_ids: selected, kind, low: Number(low), high: high === "" ? Number(low) : Number(high), currency, source: "user", estimated: true, label: "Manually entered whole-ticket party fare", validated: true });
      setLow(""); setHigh("");
    } catch (err) { report(err instanceof Error ? err.message : "Bundle could not be saved."); }
    finally { setBusy(false); }
  }
  return <details className="p-details"><summary>Enter a combined flight ticket price</summary><p>Choose the exact journeys covered by your quote. Enter the total for the whole party; airport transfers remain separate. The optimizer compares this purchase with separate tickets.</p>
    <div>{flights.map(m => <label className="p-check" key={m.id}><input type="checkbox" checked={selected.includes(m.id)} onChange={e => setSelected(ids => e.target.checked ? [...ids, m.id] : ids.filter(id => id !== m.id))} />{placeName(m.from_id)} → {placeName(m.to_id)} · {m.departure?.slice(0, 10)}</label>)}</div>
    <div className="p-inline"><Field label="Ticket type"><select value={kind} onChange={e => setKind(e.target.value as typeof kind)}><option value="multi-city">Multi-city / open-jaw</option><option value="round-trip">Round trip</option></select></Field><Field label="Combined party fare"><input type="number" min="0" step="0.01" value={low} onChange={e => setLow(e.target.value)} /></Field><Field label="Maximum (blank = fixed)"><input type="number" min={low || 0} step="0.01" value={high} onChange={e => setHigh(e.target.value)} /></Field><Field label="Bundle currency"><input maxLength={3} value={currency} onChange={e => setCurrency(e.target.value.toUpperCase())} /></Field><Button type="button" size="sm" disabled={busy} onClick={() => void submit()}>Save bundle</Button></div>
  </details>;
}

function AssumedConnection({ places, add, report }: { places: Place[]; add: (m: Movement) => Promise<void>; report: (s: string) => void }) {
  const [form, setForm] = useState({ from: "", to: "", mode: "bus", hours: "", distance: "", departure: "", arrival: "" });
  const [busy, setBusy] = useState(false);
  async function submit() {
    setBusy(true);
    try {
      if (!form.from || !form.to || form.from === form.to || Number(form.hours) <= 0) throw new Error("Choose different endpoints and a positive duration.");
      await add({ id: `assumed:${crypto.randomUUID()}`, from_id: form.from, to_id: form.to, mode: form.mode as Movement["mode"], duration_minutes: Number(form.hours) * 60, distance_km: form.distance === "" ? null : Number(form.distance), departure: form.departure ? new Date(form.departure).toISOString() : null, arrival: form.arrival ? new Date(form.arrival).toISOString() : null, source: "User-defined connection", assumptions: ["User supplied connectivity and timing"], segments: [], charges: [], transfers: 0, vehicle_kind: form.mode === "car" ? "rental" : null, search_url: null });
    } catch (err) { report(err instanceof Error ? err.message : "Connection could not be saved."); }
    finally { setBusy(false); }
  }
  return <details className="p-details"><summary>Add a connection missing from the providers</summary><p>This explicitly assumes that the connection exists. Flexible connections use the duration; scheduled connections need both timestamps (shown in your browser timezone).</p><div className="p-grid">
    {(["from", "to"] as const).map(key => <Field key={key} label={`Assumed connection ${key}`}><select value={form[key]} onChange={e => setForm(f => ({ ...f, [key]: e.target.value }))}><option value="">Choose place</option>{places.map(p => <option value={p.id} key={p.id}>{p.name}</option>)}</select></Field>)}
    <Field label="Assumed mode"><select value={form.mode} onChange={e => setForm(f => ({ ...f, mode: e.target.value }))}>{modes.map(m => <option key={m}>{m}</option>)}</select></Field>
    <Field label="Assumed duration · hours"><input type="number" min="0.01" step="any" value={form.hours} onChange={e => setForm(f => ({ ...f, hours: e.target.value }))} /></Field><Field label="Assumed distance · km (optional)"><input type="number" min="0" value={form.distance} onChange={e => setForm(f => ({ ...f, distance: e.target.value }))} /></Field>
    <Field label="Optional departure · browser local"><input type="datetime-local" value={form.departure} onChange={e => setForm(f => ({ ...f, departure: e.target.value }))} /></Field><Field label="Optional arrival · browser local"><input type="datetime-local" value={form.arrival} onChange={e => setForm(f => ({ ...f, arrival: e.target.value }))} /></Field><Button type="button" size="sm" variant="secondary" disabled={busy} onClick={() => void submit()}>Add assumed connection</Button>
  </div></details>;
}

export default function Planner() {
  const [draft, setDraft] = useState<TripDraft>(blankTrip);
  const [saved, setSaved] = useState<SavedTrip | null>(null);
  const [summaries, setSummaries] = useState<SavedSummary[]>([]);
  const [rules, setRules] = useState<PricingRule[]>([]);
  const [result, setResult] = useState<Result | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [comparisonId, setComparisonId] = useState<string | null>(null);
  const [ranking, setRanking] = useState("cheapest");
  const [routePage, setRoutePage] = useState(0);
  const [showDominated, setShowDominated] = useState(false);
  const [budget, setBudget] = useState(100);
  const [busy, setBusy] = useState(false);
  const [loadingTrip, setLoadingTrip] = useState(true);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState("");
  const [saveStatus, setSaveStatus] = useState("Choose your trip");
  const [transitConfigured, setTransitConfigured] = useState(true);
  const draftRef = useRef(draft);
  const savedRef = useRef(saved);
  const version = useRef(0);
  const dirtyRef = useRef(false);
  const pendingSave = useRef<Promise<SavedTrip> | null>(null);
  const session = useRef(0);
  const places = useMemo(() => [...new Map([...(draft.home ? [draft.home] : []), ...draft.departures, ...draft.arrivals, ...draft.visits.map(v => v.place)].map(p => [p.id, p])).values()], [draft]);
  const byId = useMemo(() => new Map(places.map(p => [p.id, p])), [places]);
  const placeName = (id: string) => byId.get(id)?.name ?? (id.startsWith("airport:") ? `${id.slice(8)} airport` : id);

  function edit(value: TripDraft) {
    const validPositioning = (item: { direction: "outbound" | "return"; gateway_id: string }) =>
      item.gateway_id !== value.home?.id && (item.direction === "outbound" ? value.departures : value.arrivals).some(p => p.id === item.gateway_id);
    value = { ...value,
      positioning_policies: (value.positioning_policies ?? []).filter(validPositioning),
      positioning_services: value.home?.id === draftRef.current.home?.id ? (value.positioning_services ?? []).filter(validPositioning) : [],
    };
    draftRef.current = value; setDraft(value); version.current++; dirtyRef.current = true; setDirty(true); setSaveStatus("Unsaved changes"); setError("");
  }
  function accept(record: SavedTrip, replaceDraft = false) {
    const current = savedRef.current;
    if (!replaceDraft && current?.id === record.id && (record.revision < current.revision || (record.revision === current.revision && (record.snapshot?.revision ?? 0) < (current.snapshot?.revision ?? 0)))) return;
    savedRef.current = record; setSaved(record);
    localStorage.setItem("wayfinder:last-trip", record.id);
    if (replaceDraft) { const restored = { ...record.spec, timing: { ...blankTrip().timing, ...record.spec.timing }, cars: { ...blankTrip().cars, ...record.spec.cars } }; draftRef.current = restored; setDraft(restored); dirtyRef.current = false; setDirty(false); }
    if (record.result) acceptResult(record.result, record.id);
  }
  function acceptResult(value: Result, tripId: string) {
    if (dirtyRef.current || savedRef.current?.id !== tripId || savedRef.current.revision !== value.trip_revision || (savedRef.current.snapshot?.revision ?? 0) > value.snapshot_revision) return;
    setResult(value);
  }
  async function refreshList() { const data = await api<{ trips: SavedSummary[] }>("/trips"); setSummaries(data.trips); }
  async function openTrip(id: string) {
    if (pendingSave.current) await pendingSave.current;
    if (dirtyRef.current && draftRef.current.home && draftRef.current.visits.length) await saveSpec();
    const token = ++session.current;
    version.current++;
    setLoadingTrip(true);
    setError(""); setResult(null); setJob(null); setSelectedId(null); setComparisonId(null);
    try {
    const record = await api<SavedTrip>(`/trips/${id}`);
    if (token !== session.current) return;
    accept(record, true); setSaveStatus("Saved locally");
    if (record.latest_job_id) { const status = await api<Job>(`/searches/${record.latest_job_id}`); if (token === session.current) setJob(status); }
    if (record.snapshot && (!record.result || record.result.trip_revision !== record.revision || record.result.snapshot_revision !== record.snapshot.revision)) { const r = await api<Result>(`/trips/${id}/optimize`, "POST"); if (token === session.current) acceptResult(r, id); }
    } finally { if (token === session.current) setLoadingTrip(false); }
  }
  useEffect(() => {
    let active = true;
    void Promise.all([api<{ trips: SavedSummary[] }>("/trips"), api<{ rules: PricingRule[] }>("/pricing-rules"), fetch("/api/data").then(r => r.json())]).then(async ([trips, data, config]) => {
      if (!active) return;
      setSummaries(trips.trips); setRules(data.rules); setTransitConfigured(config.transit_routing_configured);
      const id = localStorage.getItem("wayfinder:last-trip");
      if (id && trips.trips.some(t => t.id === id)) await openTrip(id);
    }).catch(err => { if (active) setError(err.message); }).finally(() => { if (active) setLoadingTrip(false); });
    return () => { active = false; };
    // Initial restore only; subsequent navigation is explicit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function saveSpec(): Promise<SavedTrip> {
    if (pendingSave.current) await pendingSave.current;
    const spec = draftRef.current;
    if (!spec.home || !spec.visits.length) throw new Error("Choose a home/base and at least one required destination.");
    if (!spec.modes.length) throw new Error("Select at least one mode.");
    const stamp = version.current, token = session.current;
    const current = savedRef.current;
    if (current && !dirtyRef.current) return current;
    const request = current ? api<SavedTrip>(`/trips/${current.id}`, "PUT", { spec, expected_revision: current.revision }) : api<SavedTrip>("/trips", "POST", spec);
    pendingSave.current = request;
    setSaveStatus("Saving…");
    try {
      const record = await request;
      if (token !== session.current) return record;
      if (stamp === version.current) { dirtyRef.current = false; setDirty(false); setSaveStatus("Saved locally"); }
      accept(record);
      if (stamp === version.current) {
        const optimized = await api<Result>(`/trips/${record.id}/optimize`, "POST");
        if (token === session.current && stamp === version.current) acceptResult(optimized, record.id);
      }
      await refreshList();
      return record;
    } finally { if (pendingSave.current === request) pendingSave.current = null; }
  }
  useEffect(() => {
    if (!dirty || !saved || !draft.home || !draft.visits.length) return;
    const timer = setTimeout(() => { void saveSpec().catch(err => { setError(err.message); setSaveStatus("Changes not saved"); }); }, 650);
    return () => clearTimeout(timer);
    // The draft change starts the debounce; saveSpec reads current refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft, dirty, saved?.id]);

  useEffect(() => {
    if (!job || !["running", "queued"].includes(job.status)) return;
    let active = true, fetching = false;
    const token = session.current;
    async function poll() {
      if (fetching) return;
      fetching = true;
      try {
        const status = await api<Job & { graph_revision: number }>(`/searches/${job!.id}`);
        if (!active || token !== session.current) return;
        setJob(status);
        if (status.graph_revision > (savedRef.current?.snapshot?.revision ?? -1) || !["running", "queued"].includes(status.status)) {
          const record = await api<SavedTrip>(`/trips/${job!.trip_id}`);
          if (active && token === session.current && !pendingSave.current && (!savedRef.current || record.revision >= savedRef.current.revision)) accept(record);
        }
      } catch (err) { if (active) setError(err instanceof Error ? err.message : "Search status unavailable."); }
      finally { fetching = false; }
    }
    const timer = setInterval(() => void poll(), 1000);
    void poll();
    return () => { active = false; clearInterval(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job?.id, job?.status]);

  async function act(action: () => Promise<void>) {
    setBusy(true); setError("");
    try { await action(); }
    catch (err) { setError(err instanceof Error ? err.message : "The operation failed."); }
    finally { setBusy(false); }
  }
  async function search(continuation = false) {
    await act(async () => {
      const record = await saveSpec();
      const status = await api<Job>(continuation && job ? `/searches/${job.id}/continue` : `/trips/${record.id}/searches`, "POST", { budget });
      setJob(status);
    });
  }
  async function updatePrice(offer: Offer) {
    const record = await saveSpec();
    const updated = await api<Result>(`/trips/${record.id}/fares/${encodeURIComponent(offer.id)}`, "PUT", offer);
    const next = await api<SavedTrip>(`/trips/${record.id}`);
    if (savedRef.current?.id === record.id) { accept(next); acceptResult(updated, record.id); setSaveStatus("Fare saved · frontier recalculated"); }
  }
  async function applySharedFares(estimates: SharedFare[]) {
    const record = await saveSpec();
    const updated = await api<Result>(`/trips/${record.id}/fares/estimates`, "POST", { estimates, expected_revision: record.revision });
    const next = await api<SavedTrip>(`/trips/${record.id}`);
    if (savedRef.current?.id === record.id) { accept(next); acceptResult(updated, record.id); setSaveStatus("Shared estimates saved · frontier recalculated"); }
  }
  async function removePrice(id: string) {
    if (!savedRef.current) return;
    const tripId = savedRef.current.id;
    const updated = await api<Result>(`/trips/${tripId}/fares/${encodeURIComponent(id)}`, "DELETE");
    accept(await api<SavedTrip>(`/trips/${tripId}`)); acceptResult(updated, tripId);
  }
  async function rulesChanged() {
    setRules((await api<{ rules: PricingRule[] }>("/pricing-rules")).rules);
    if (savedRef.current) { const id = savedRef.current.id; accept(await api<SavedTrip>(`/trips/${id}`)); acceptResult(await api<Result>(`/trips/${id}/optimize`, "POST"), id); }
  }

  const routes = useMemo(() => {
    const items = [...(result?.routes ?? []), ...(showDominated ? result?.dominated_routes ?? [] : [])];
    const finite = items.filter(r => r.total_cost_myr !== null);
    const costs = finite.map(r => r.total_cost_myr as number), stays = finite.map(r => r.stay_hours);
    const minCost = Math.min(...costs), maxCost = Math.max(...costs), minStay = Math.min(...stays), maxStay = Math.max(...stays);
    const score = (r: Route) => r.total_cost_myr === null ? Infinity : (maxCost > minCost ? (r.total_cost_myr - minCost) / (maxCost - minCost) : 0) + (maxStay > minStay ? (maxStay - r.stay_hours) / (maxStay - minStay) : 0);
    return items.sort((a, b) => ranking === "stay" ? b.stay_hours - a.stay_hours || a.cost_low_myr - b.cost_low_myr : ranking === "balanced" ? score(a) - score(b) || a.cost_low_myr - b.cost_low_myr : Number(a.provisional) - Number(b.provisional) || a.cost_low_myr - b.cost_low_myr || b.stay_hours - a.stay_hours);
  }, [result, ranking, showDominated]);
  useEffect(() => {
    if (!busy && result?.dominated_routes === undefined) setShowDominated(false);
  }, [result, busy]);
  const missingFareGroups = useMemo(() => groupMissingFares(
    (result?.missing_fares ?? []).filter(fare => !fare.label.startsWith("Airport transfer ")),
    [...(result?.routes ?? []), ...(result?.dominated_routes ?? []), ...(result?.refinement_routes ?? [])],
  ), [result]);
  useEffect(() => { setRoutePage(p => Math.min(p, Math.max(0, Math.ceil(routes.length / 40) - 1))); }, [routes.length]);
  const selected = routes.find(r => r.id === selectedId) ?? result?.refinement_routes?.find(r => r.id === selectedId) ?? routes[0] ?? null;
  const compare = routes.find(r => r.id === comparisonId) ?? null;
  const active = !!job && ["running", "queued"].includes(job.status);
  const allOffers = [...(saved?.snapshot?.offers ?? []), ...(saved?.offers ?? [])];
  const offerFor = (id: string) => [...allOffers].reverse().find(o => o.movement_ids.length === 1 && o.movement_ids[0] === id);
  const coverage = result?.coverage;
  const unresolvedAccess = (coverage?.unresolved_movements ?? []).map(movement => ({
    ...movement,
    assumptions: movement.assumptions.filter(assumption => !assumption.startsWith("Airport change ") && !assumption.startsWith("Airport connection ")),
  })).filter(movement => movement.assumptions.length > 0);
  const extras = selected?.extra_charges ?? [];

  if (loadingTrip) return <main className="optimizer app-shell" aria-busy="true"><div className="p-empty" role="status">Loading your saved trip…</div></main>;

  return <main className="optimizer app-shell">
    <header className="p-topbar"><div className="brand-lockup"><div className="brand-icon"><Compass size={22} /></div><div><div className="brand-title">Wayfinder <span>Routes</span></div><div className="brand-caption">The cost of more time in your cities</div></div></div><div className="p-saved-controls"><label className="sr-only" htmlFor="saved-trip">Saved trip</label><select id="saved-trip" value={saved?.id ?? ""} onChange={e => { if (e.target.value) void act(() => openTrip(e.target.value)); }}><option value="">Saved trips</option>{summaries.map(t => <option key={t.id} value={t.id}>{t.name} · {t.start_date}</option>)}</select><Button type="button" variant="secondary" size="sm" onClick={() => { void act(async () => { if (pendingSave.current) await pendingSave.current; if (dirtyRef.current && draftRef.current.home && draftRef.current.visits.length) await saveSpec(); session.current++; const next = blankTrip(); draftRef.current = next; savedRef.current = null; setDraft(next); setSaved(null); setResult(null); setJob(null); setDirty(false); dirtyRef.current = false; setSaveStatus("New trip"); localStorage.removeItem("wayfinder:last-trip"); }); }}><Plus size={14} />New</Button></div></header>
    <section className="p-intro"><div className="eyebrow">MULTIMODAL MULTI-CITY TRIPS</div><h1>Choose what to spend.<br /><span>See how much time you gain.</span></h1><p>Explore the trade-offs between transportation cost and hours in your required cities, including your journey from home and back.</p></section>
    {error && <div className="p-alert p-error" role="alert">{error}<button type="button" aria-label="Dismiss error" onClick={() => setError("")}>×</button></div>}
    <section className="p-panel" aria-labelledby="setup-title"><div className="p-panel-heading"><div><span className="p-step">01</span><h2 id="setup-title">Your trip</h2></div><span className="p-status" aria-live="polite">{saveStatus}</span></div>
      <div className="p-grid p-main-fields"><Field label="Trip name"><input value={draft.name} maxLength={120} onChange={e => edit({ ...draft, name: e.target.value })} /></Field><Field label="Start date"><input type="date" value={draft.start_date} onChange={e => edit({ ...draft, start_date: e.target.value })} /></Field><Field label="End date"><input type="date" min={draft.start_date} value={draft.end_date} onChange={e => edit({ ...draft, end_date: e.target.value })} /></Field><Field label="Date mode"><select value={draft.date_mode} onChange={e => edit({ ...draft, date_mode: e.target.value as TripSpec["date_mode"] })}><option value="fixed">Fixed outward and return dates</option><option value="flexible">Optimize within this date window</option></select></Field></div>
      <p className="p-hint">{draft.date_mode === "fixed" ? "Leave home on the start date and arrive back on the end date, including positioning journeys." : "The optimizer can choose outward and return days anywhere inside this window."}</p>
      <div className="p-grid p-places-grid"><div><PlacePicker label="Home / base city" onSelect={p => edit({ ...draft, home: p, visits: draft.visits.filter(v => v.place.id !== p.id) })} />{draft.home && <PlaceChips places={[draft.home]} remove={() => edit({ ...draft, home: null })} />}</div>
        <div><PlacePicker label={`Possible departure cities (${draft.departures.length}/3)`} disabledIds={draft.departures.map(p => p.id)} onSelect={p => { if (draft.departures.length < 3) edit({ ...draft, departures: [...draft.departures, p] }); }} /><PlaceChips places={draft.departures} remove={id => edit({ ...draft, departures: draft.departures.filter(p => p.id !== id) })} /><small>Leave empty to use home.</small></div>
        <div><PlacePicker label={`Possible arrival cities (${draft.arrivals.length}/3)`} disabledIds={draft.arrivals.map(p => p.id)} onSelect={p => { if (draft.arrivals.length < 3) edit({ ...draft, arrivals: [...draft.arrivals, p] }); }} /><PlaceChips places={draft.arrivals} remove={id => edit({ ...draft, arrivals: draft.arrivals.filter(p => p.id !== id) })} /><small>Leave empty to return directly to home.</small></div></div>
      <div className="p-visits"><PlacePicker label={`Required cities (${draft.visits.length}/4) · visit order is flexible`} disabledIds={[draft.home?.id ?? "", ...draft.visits.map(v => v.place.id)]} onSelect={p => { if (draft.visits.length < 4) edit({ ...draft, visits: [...draft.visits, { place: p, min_stay_hours: 0 }] }); }} />
        <div className="p-visit-list">{draft.visits.map((v, i) => <div key={v.place.id}><strong>{v.place.name}<small>{v.place.timezone}</small></strong><NumberField label={`Minimum stay in ${v.place.name} · hours`} value={v.min_stay_hours} onChange={n => edit({ ...draft, visits: draft.visits.map((x, j) => j === i ? { ...x, min_stay_hours: n ?? 0 } : x) })} /><button type="button" aria-label={`Remove required city ${v.place.name}`} onClick={() => edit({ ...draft, visits: draft.visits.filter(x => x.place.id !== v.place.id), commitments: draft.commitments.filter(c => c.place_id !== v.place.id) })}>×</button></div>)}</div>
        {draft.visits.length > 1 && <button type="button" className="p-text-button" onClick={() => edit({ ...draft, visits: draft.visits.map(v => ({ ...v, min_stay_hours: draft.visits[0].min_stay_hours })) })}>Apply the first city's minimum to all cities</button>}</div>
      <div className="p-grid"><NumberField label="Adult travelers" value={draft.adults} min={1} max={9} step={1} onChange={n => edit({ ...draft, adults: n ?? 1 })} /><NumberField label="Total party budget · MYR" value={draft.budget_myr} optional onChange={n => edit({ ...draft, budget_myr: n })} /><NumberField label="Maximum transfers per intercity journey" value={draft.max_transfers} optional step={1} max={10} onChange={n => edit({ ...draft, max_transfers: n })} /><Field label="Local departure window starts"><input type="time" value={draft.departure_start} onChange={e => edit({ ...draft, departure_start: e.target.value })} /></Field><Field label="Local departure window ends"><input type="time" value={draft.departure_end} onChange={e => edit({ ...draft, departure_end: e.target.value })} /></Field></div>
      <fieldset className="p-modes"><legend>Allowed intercity transportation</legend>{modes.map(mode => <label className="p-check" key={mode}><input type="checkbox" checked={draft.modes.includes(mode)} onChange={e => edit({ ...draft, modes: e.target.checked ? [...draft.modes, mode] : draft.modes.filter(m => m !== mode) })} />{mode}</label>)}<label className="p-check"><input type="checkbox" checked={draft.allow_overnight} onChange={e => edit({ ...draft, allow_overnight: e.target.checked })} />Allow overnight travel</label></fieldset>
      <label className="p-check"><input type="checkbox" checked={draft.exclude_unpriced_flights ?? false} onChange={e => edit({ ...draft, exclude_unpriced_flights: e.target.checked })} />Ignore flights with unknown fares</label>
      <p className="p-hint">Excludes itineraries with unpriced flights after applying ticket bundles, manual fares, and pricing rules. Saved flight schedules are retained; other transport and transfer fares may still be unknown.</p>
      {!transitConfigured && draft.modes.some(m => ["rail", "bus", "coach", "subway", "tram"].includes(m)) && <p className="p-notice">Scheduled transit is currently disabled. Configure the Transitous contact URL and coordinate routing use to enable it.</p>}
      <PositioningSettings draft={draft} edit={edit} report={setError} />
      <AdvancedSettings draft={draft} edit={edit} places={places} report={setError} />
      <div className="p-actions p-search-actions"><NumberField label="Provider requests per batch" value={budget} min={1} max={500} step={1} onChange={n => setBudget(n ?? 100)} /><Button type="button" variant="secondary" disabled={busy || !draft.home || !draft.visits.length} onClick={() => void act(async () => { const changed = dirtyRef.current; const record = await saveSpec(); if (!changed) acceptResult(await api<Result>(`/trips/${record.id}/optimize`, "POST"), record.id); })}><Save size={15} />Save & recalculate</Button><Button type="button" disabled={busy || active || !draft.home || !draft.visits.length} onClick={() => void search()}>{busy ? <LoaderCircle size={15} className="spin" /> : <Play size={15} />}Discover transport</Button></div>
    </section>

    {saved && <AirportTransferTable key={saved.id} trip={saved} save={async estimates => {
      const record = await saveSpec();
      const updated = await api<SavedTrip>(`/trips/${record.id}/airport-transfer-estimates`, "PUT", { estimates, expected_revision: record.revision });
      accept(updated);
      if (updated.result) acceptResult(updated.result, updated.id);
      setSaveStatus("Airport transfer estimates saved");
    }} report={setError} />}

    {job && <section className="p-panel p-job" aria-live="polite"><div><span className="p-step">02</span><h2>Transport discovery</h2><strong>{active && <LoaderCircle size={15} className="spin" />}{job.status}</strong></div><p>{job.processed} queries processed · {job.requests} provider requests · {job.cache_hits} cache hits{job.manual_quote_queries ? ` · ${job.manual_quote_queries} manual quotes (no request)` : ""} · {job.pending} pending</p><div className="p-actions">{active ? <Button type="button" size="sm" variant="secondary" onClick={() => void act(async () => { setJob(await api<Job>(`/searches/${job.id}/cancel`, "POST")); })}><Square size={13} />Cancel discovery</Button> : job.status !== "superseded" && (job.pending > 0 || job.failed_queries > 0 || result?.optimization_complete === false) && <Button type="button" size="sm" disabled={busy} onClick={() => void search(true)}><RefreshCw size={13} />{job.pending > 0 ? "Continue searching" : job.failed_queries > 0 ? "Retry failed searches" : "Continue optimizing"}</Button>}<span className="p-hint">Collected data and fare edits are retained.</span></div>{job.messages.length > 0 && <details><summary>Provider status and coverage</summary>{job.messages.map((m, i) => <p key={i}>{m}</p>)}</details>}</section>}

    <section className="p-panel"><RulesEditor rules={rules} places={places} changed={rulesChanged} report={setError} />{saved && <AssumedConnection places={places} report={setError} add={async m => { const record = await saveSpec(); const next = await api<Result>(`/trips/${record.id}/movements`, "POST", m); accept(await api<SavedTrip>(`/trips/${record.id}`)); acceptResult(next, record.id); }} />}</section>

    {result && <>
      {(result.discovery_required || dirty) && <div className="p-notice">{dirty ? "Trip changes are being saved; displayed results belong to the previous revision." : "Transport discovery is needed for these trip inputs. Saved fare edits remain available."}</div>}

      {saved && <AirportConnectionsTable key={`airport-connections:${saved.id}`} tripId={saved.id} requirements={saved.airport_connections_required ?? coverage?.airport_connections_required ?? noAirportConnectionRequirements} connections={saved.airport_connections ?? noAirportConnections} report={setError} onSaved={(record, updated) => { accept(record); acceptResult(updated, record.id); setSaveStatus("Airport connections saved · frontier recalculated"); }} />}
      {missingFareGroups.length > 0 && <MissingFaresTable key={`missing-fares:${saved?.id}`} storageKey={`wayfinder:pending-estimates:${saved?.id}`} groups={missingFareGroups} placeName={placeName} offerFor={offerFor} onApply={applySharedFares} onSave={updatePrice} onRemove={removePrice} />}
      {!!unresolvedAccess.length && <details className="p-panel"><summary>{unresolvedAccess.length} retrieved journeys need airport access timing</summary>{unresolvedAccess.map(m => <p key={m.id}>{placeName(m.from_id)} → {placeName(m.to_id)}: {m.assumptions.join(" · ")}</p>)}</details>}
      <section className="p-panel" aria-labelledby="frontier-title"><div className="p-panel-heading"><div><span className="p-step">04</span><h2 id="frontier-title">Your cost–time frontier</h2></div><span className="p-tag">{result.routes.length} frontier alternatives{showDominated && result.dominated_routes ? ` + ${result.dominated_routes.length} dominated` : ""}</span></div><p>{coverage?.discovery_complete ? "Discovery queue exhausted" : "Preliminary discovery"} · {result.optimization_complete ? "Optimization complete for this snapshot" : "Optimization incomplete"} · snapshot {result.snapshot_revision}</p><p className="p-hint">Circles: priced offers. Diamonds: estimates. Horizontal bands: fare ranges; their selection marker is the midpoint, not an expected price. Unknown totals stay in the list below. Optimality covers retrieved options and stated assumptions.</p>
        <p className="p-hint">{result.feasible_count.toLocaleString()} completed histories evaluated. The frontier keeps cost/city-time tradeoffs under your fare and budget settings. Other histories are hidden by default; source schedules and fares remain saved.</p>
        <div className="p-inline"><label className="p-check"><input type="checkbox" checked={showDominated} disabled={busy} onChange={e => {
          if (!e.target.checked) { setShowDominated(false); return; }
          if (result.dominated_routes !== undefined) { setShowDominated(true); return; }
          setShowDominated(true);
          void act(async () => {
            try {
              const record = await saveSpec();
              const updated = await api<Result>(`/trips/${record.id}/optimize`, "POST", { include_dominated: true });
              accept(await api<SavedTrip>(`/trips/${record.id}`)); acceptResult(updated, record.id);
            } catch (err) { setShowDominated(false); throw err; }
          });
        }} />Show dominated alternatives</label>{busy && <span className="p-hint">Calculating…</span>}</div>
        <p className="p-hint">Grey points are other completed alternatives from this search, usually below/right of the frontier. First loading them recalculates saved data without provider requests. Earlier pruning may have removed other histories.</p>
        <ParetoExplorer routes={result.routes} dominated={showDominated ? result.dominated_routes : undefined} selected={selected?.id ?? null} onSelect={setSelectedId} />
        {!result.optimization_complete && !active && !job && saved && <Button type="button" size="sm" onClick={() => void act(async () => { acceptResult(await api<Result>(`/trips/${saved.id}/optimize`, "POST", { expand: true }), saved.id); })}>Continue optimizing</Button>}
        <div className="p-inline p-route-sort"><Field label={showDominated ? "Order displayed alternatives" : "Order frontier alternatives"}><select value={ranking} onChange={e => setRanking(e.target.value)}><option value="cheapest">Lowest known total</option><option value="stay">Most city-stay hours</option><option value="balanced">Balanced · equal cost/time weights</option></select></Field><small>Ordering does not change frontier membership.</small></div>
        {!routes.length && <div className="p-empty">No feasible itinerary has been found in the collected data. {job?.pending ? "Continue discovery or add a missing connection." : "Check coverage, dates, minimum stays, and transport assumptions."}</div>}
        {!routes.length && !!result.refinement_routes?.length && <details className="p-details"><summary>Review an over-budget candidate to add a ticket quote</summary><p>These are up to ten fare-refinement examples, outside your current budget. They are not plotted as feasible frontier options.</p>{result.refinement_routes.map(r => <Button key={r.id} type="button" size="sm" variant="secondary" onClick={() => setSelectedId(r.id)}>{routeCost(r)} · {r.stay_hours.toFixed(1)} city hours</Button>)}</details>}
        <div className="p-route-grid">{routes.slice(Math.min(routePage, Math.max(0, Math.ceil(routes.length / 40) - 1)) * 40, (Math.min(routePage, Math.max(0, Math.ceil(routes.length / 40) - 1)) + 1) * 40).map((r, i) => <button type="button" key={r.id} className={`p-route-card ${selected?.id === r.id ? "selected" : ""}`} aria-pressed={selected?.id === r.id} onClick={() => setSelectedId(r.id)}><span className="p-route-number">{String(i + Math.min(routePage, Math.max(0, Math.ceil(routes.length / 40) - 1)) * 40 + 1).padStart(2, "0")}</span><div><strong>{routeCost(r)}</strong><span>{r.stay_hours.toFixed(1)} city hours · {r.travel_hours.toFixed(1)} h travel · <span title="Total party fare divided by city-stay hours">{cityHourCost(r)}</span></span><small>{placeName(r.departure_gateway)} outward · {placeName(r.arrival_gateway)} return</small><small>{r.movements.map(m => m.mode).join(" → ")}</small></div><span className={`p-tag ${r.provisional ? "uncertain" : ""}`}>{result.dominated_routes?.some(other => other.id === r.id) ? "Dominated" : r.provisional ? "Provisional" : r.estimated ? "Includes estimates" : "Priced"}</span>{r.budget_status === "uncertain" && <small className="p-warning">Budget compliance uncertain</small>}</button>)}</div>
        {routes.length > 40 && <div className="p-actions"><Button type="button" size="sm" variant="secondary" disabled={routePage === 0} onClick={() => setRoutePage(p => Math.max(0, p - 1))}>Previous alternatives</Button><span>Page {Math.min(routePage + 1, Math.ceil(routes.length / 40))} / {Math.ceil(routes.length / 40)}</span><Button type="button" size="sm" variant="secondary" disabled={(routePage + 1) * 40 >= routes.length} onClick={() => setRoutePage(p => p + 1)}>Next alternatives</Button></div>}
        {selected && routes.length > 1 && <div className="p-comparison"><Field label="Compare selected itinerary with"><select value={comparisonId ?? ""} onChange={e => setComparisonId(e.target.value || null)}><option value="">Choose another alternative</option>{routes.filter(r => r.id !== selected.id).map(r => <option value={r.id} key={r.id}>{routeCost(r)} · {r.stay_hours.toFixed(1)} city hours</option>)}</select></Field>{compare && compare.id !== selected.id && <p>Selected itinerary: <strong>{(selected.stay_hours - compare.stay_hours).toFixed(1)} additional city hours</strong>{selected.total_cost_myr !== null && compare.total_cost_myr !== null && <> for <strong>{money(selected.total_cost_myr - compare.total_cost_myr)} additional cost</strong>{selected.stay_hours > compare.stay_hours && ` · ${money((selected.total_cost_myr - compare.total_cost_myr) / (selected.stay_hours - compare.stay_hours))} per additional hour`}</>}{(selected.provisional || compare.provisional) && " · resolve fare ranges to compare an exact additional cost"}.</p>}</div>}
      </section>

      {selected && <section className="p-panel" aria-labelledby="details-title"><div className="p-panel-heading"><div><span className="p-step">05</span><h2 id="details-title">Itinerary details</h2>{selected.budget_status === "over" && <span className="p-tag uncertain">Outside budget · fare refinement only</span>}</div><strong>{routeCost(selected)}</strong></div><div className="p-detail-layout"><div><PlannerMap places={places} route={selected} /><p className="p-hint">City reference points and schematic connections; lines do not show road or track geometry.</p></div><div className="p-timeline"><h3>Time in each required city</h3>{selected.stays.map((s, i) => <div key={`${s.place_id}:${i}`}><span className="p-timeline-dot" /><strong>{placeName(s.place_id)} <span>{s.hours.toFixed(1)} h</span></strong><small>{localTime(s.arrival, byId.get(s.place_id)?.timezone ?? "UTC")}<ArrowRight size={13} />{localTime(s.departure, byId.get(s.place_id)?.timezone ?? "UTC")}</small><progress max={selected.stay_hours || 1} value={s.hours} /></div>)}<p className="p-hint">City-stay hours include nights, exclude all transportation and terminal overhead, and do not count time at home or other positioning cities.</p></div></div>
        <div className="p-leg-details">{selected.movements.map((m, i) => <details key={`${m.id}:${i}`} open={i === 0}><summary><span className="p-leg-index">{i + 1}</span><strong>{placeName(m.from_id)} → {placeName(m.to_id)}</strong><span className="p-tag">{m.mode}{m.vehicle_kind ? ` · ${m.vehicle_kind}` : ""}</span><span>{(m.duration_minutes / 60).toFixed(1)} h</span></summary><div className="p-leg-content"><p>{localTime(m.departure, byId.get(m.from_id)?.timezone ?? "UTC")} → {localTime(m.arrival, byId.get(m.to_id)?.timezone ?? "UTC")}<br /><small>{m.source} · {m.transfers} transfers{m.distance_km !== null ? ` · ${m.distance_km.toFixed(1)} km` : ""}</small></p>{m.assumptions.map(a => <p className="p-notice" key={a}>{a}</p>)}
          {m.segments.length > 0 && <ul className="p-segments">{m.segments.map((s, j) => <li key={j}><strong>{s.mode}: {s.from_name} → {s.to_name}</strong><small>{s.departure && `${localTime(s.departure, s.from_timezone ?? "UTC")} (${s.from_timezone ?? "UTC"}) → ${localTime(s.arrival, s.to_timezone ?? "UTC")} (${s.to_timezone ?? "UTC"}) · `}{s.service} {s.operator}{s.source ? ` · ${s.source}` : ""}{s.assumed ? " · assumed" : ""}{s.duration_minutes !== null ? ` · ${s.duration_minutes.toFixed(0)} min` : ""}</small></li>)}</ul>}
          <FareEditor componentId={m.id} label={`Standalone ${m.mode} fare`} offer={offerFor(m.id)} onSave={updatePrice} onRemove={removePrice} />{m.charges.filter(c => !c.kind.startsWith("Airport transfer ")).map(c => <FareEditor key={c.id} componentId={c.id} label={c.kind} offer={offerFor(c.id)} onSave={updatePrice} onRemove={removePrice} />)}{m.search_url && <a href={m.search_url} target="_blank" rel="noreferrer">Open flight search ↗</a>}</div></details>)}</div>
        {extras.map(c => <FareEditor key={c.id} componentId={c.id} label={c.kind} offer={offerFor(c.id)} onSave={updatePrice} onRemove={removePrice} />)}
        <h3>Ticket purchases and cost breakdown</h3><div className="p-purchases">{selected.purchases.map(o => <div key={o.id}><strong>{o.label || o.kind}<small>{o.kind} · {o.movement_ids.length} component(s) · {o.source}{o.estimated ? " estimate" : ""}</small></strong><span>{o.low === o.high ? money(o.low, o.currency) : `${money(o.low, o.currency)} – ${money(o.high, o.currency)}`}</span>{o.source === "user" && <button type="button" aria-label={`Remove fare ${o.label}`} onClick={() => void act(() => removePrice(o.id))}>×</button>}</div>)}</div>
        <p className="p-hint">Each ticket is charged once. Combined flight tickets do not include separately listed airport transfers. Average fare per stay hour: {money(selected.cost_per_stay_hour_myr)}. Prices are quotes or assumptions, not booking guarantees.</p>
        <BundleEntry route={selected} placeName={placeName} save={updatePrice} report={setError} />
      </section>}
      {!!(coverage?.bundle_links?.length || job?.bundle_links?.length) && <section className="p-panel"><details><summary>Round-trip and multi-city quote searches</summary><p>An automatic quote is usable only when all journeys and the combined fare are verified. Otherwise open the search and enter a complete ticket price above.</p>{(job?.bundle_links ?? coverage?.bundle_links ?? []).map((b, i) => <p key={i}><a href={b.url} target="_blank" rel="noreferrer">{b.kind}: {b.legs.map(l => `${placeName(l.from_id)} → ${placeName(l.to_id)} (${l.date})`).join(" · ")} ↗</a><small> · {b.status}</small></p>)}</details></section>}
    </>}
    <footer className="p-footer">Wayfinder Routes · Flights via fast-flights · Scheduled transit via <a href="https://transitous.org/sources/" target="_blank" rel="noreferrer">Transitous sources</a> · Road estimates via OSRM · Cities © GeoNames · Airports © airportsdata · Map © OpenStreetMap contributors</footer>
  </main>;
}
