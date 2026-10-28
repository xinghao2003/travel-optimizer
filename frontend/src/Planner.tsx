import { ThemeToggle } from "./components/theme-provider";
import { AirportTransferTable } from "./components/AirportTransferTable";
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { Compass, LoaderCircle, Play, Plus, Save, Square, ArrowRight, RefreshCw, Copy, MapPin, CalendarDays, Users, Wallet, Check, SlidersHorizontal, Route as RouteIcon, CircleHelp, ChevronRight } from "lucide-react";
import { Button } from "./components/ui/button";
import { AdvancedSettings, FareEditor, Field, NumberField, PlaceChips, PlacePicker, RulesEditor } from "./components/PlannerForms";
import { PositioningSettings } from "./components/PositioningSettings";
import { MissingFaresTable, type AppliedSharedFareGroup, type SharedFare } from "./components/MissingFaresTable";
import { groupMissingFares } from "./lib/missingFares";
import { api, blankTrip, cityHourCost, localTime, modes, money, routeCost, type AirportConnection, type AirportConnectionRequirement, type AirportTransferMode, type Job, type Movement, type Offer, type Place, type PricingRule, type Result, type Route, type SavedSummary, type SavedTrip, type TripDraft, type TripSpec } from "./lib/planner";
import { tripSetupIssues, workspaceFromHash, type Workspace } from "./lib/workspace";
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

function AssumedConnection({ places, gaps, add, report }: { gaps: { from_id: string; to_id: string }[]; places: Place[]; add: (m: Movement) => Promise<void>; report: (s: string) => void }) {
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
  return <><div aria-live="polite">{gaps.length > 0 && <><h3>Missing city connections</h3><p>No direct connection was collected in either direction for these cities. If your route needs one, enter a verified schedule or an assumed duration below. Connecting routes or enabled road transport may still provide alternatives.</p>{gaps.map(gap => <Button key={`${gap.from_id}:${gap.to_id}`} type="button" variant="secondary" onClick={() => { setForm(f => ({ ...f, from: gap.from_id, to: gap.to_id })); const panel = document.getElementById("assumed-city-connection") as HTMLDetailsElement | null; if (panel) { panel.open = true; panel.scrollIntoView({ block: "center" }); } }}>Add {places.find(p => p.id === gap.from_id)?.name} → {places.find(p => p.id === gap.to_id)?.name}</Button>)}</>}</div><details id="assumed-city-connection" className="p-details"><summary>Add a connection missing from the providers</summary><p>This explicitly assumes that the connection exists. Flexible connections use the duration; scheduled connections need both timestamps (shown in your browser timezone).</p><div className="p-grid">
    {(["from", "to"] as const).map(key => <Field key={key} label={`Assumed connection ${key}`}><select value={form[key]} onChange={e => setForm(f => ({ ...f, [key]: e.target.value }))}><option value="">Choose place</option>{places.map(p => <option value={p.id} key={p.id}>{p.name}</option>)}</select></Field>)}
    <Field label="Assumed mode"><select value={form.mode} onChange={e => setForm(f => ({ ...f, mode: e.target.value }))}>{modes.map(m => <option key={m}>{m}</option>)}</select></Field>
    <Field label="Assumed duration · hours"><input type="number" min="0.01" step="any" value={form.hours} onChange={e => setForm(f => ({ ...f, hours: e.target.value }))} /></Field><Field label="Assumed distance · km (optional)"><input type="number" min="0" value={form.distance} onChange={e => setForm(f => ({ ...f, distance: e.target.value }))} /></Field>
    <Field label="Optional departure · browser local"><input type="datetime-local" value={form.departure} onChange={e => setForm(f => ({ ...f, departure: e.target.value }))} /></Field><Field label="Optional arrival · browser local"><input type="datetime-local" value={form.arrival} onChange={e => setForm(f => ({ ...f, arrival: e.target.value }))} /></Field><Button type="button" size="sm" variant="secondary" disabled={busy} onClick={() => void submit()}>Add assumed connection</Button>
  </div></details></>;
}

export default function Planner() {
  const [workspace, setWorkspace] = useState<Workspace>(() => workspaceFromHash(window.location.hash));
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
  const [chartOpen, setChartOpen] = useState(false);
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
  const errorAlert = useRef<HTMLDivElement>(null);
  const places = useMemo(() => [...new Map([...(draft.home ? [draft.home] : []), ...draft.departures, ...draft.arrivals, ...draft.visits.map(v => v.place)].map(p => [p.id, p])).values()], [draft]);
  const byId = useMemo(() => new Map(places.map(p => [p.id, p])), [places]);
  const placeName = (id: string) => byId.get(id)?.name ?? (id.startsWith("airport:") ? `${id.slice(8)} airport` : id);

  function navigateWorkspace(next: Workspace, target?: string) {
    setWorkspace(next);
    window.history.replaceState(null, "", `#${target ?? next}`);
    requestAnimationFrame(() => {
      const element = document.getElementById(target ?? "workspace-content");
      element?.focus({ preventScroll: true });
      element?.scrollIntoView({ block: "start" });
    });
  }
  useEffect(() => {
    const update = () => setWorkspace(workspaceFromHash(window.location.hash));
    window.addEventListener("hashchange", update);
    return () => window.removeEventListener("hashchange", update);
  }, []);
  useEffect(() => { if (error) errorAlert.current?.focus(); }, [error]);

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
  async function openTrip(id: string, restore = false) {
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
    if (!restore || !window.location.hash) {
      const next = record.snapshot ? "compare" : "setup";
      setWorkspace(next);
      window.history.replaceState(null, "", `#${next}`);
      if (!restore) window.scrollTo({ top: 0 });
    }
    if (record.latest_job_id) { const status = await api<Job>(`/searches/${record.latest_job_id}`); if (token === session.current) setJob(status); }
    if (record.snapshot && (!record.result || record.result.trip_revision !== record.revision || record.result.snapshot_revision !== record.snapshot.revision)) { const r = await api<Result>(`/trips/${id}/optimize`, "POST"); if (token === session.current) acceptResult(r, id); }
    } finally { if (token === session.current) setLoadingTrip(false); }
  }
  async function duplicateTrip() {
    if (pendingSave.current) await pendingSave.current;
    if (dirtyRef.current) {
      if (!draftRef.current.home || !draftRef.current.visits.length) throw new Error("Finish the current trip setup before copying it.");
      await saveSpec();
    }
    const source = savedRef.current;
    if (!source) throw new Error("Choose a saved trip to copy.");
    const token = ++session.current;
    version.current++;
    setLoadingTrip(true);
    setResult(null); setJob(null); setSelectedId(null); setComparisonId(null);
    try {
      const record = await api<SavedTrip>(`/trips/${source.id}/duplicate`, "POST");
      if (token !== session.current) return;
      accept(record, true);
      setWorkspace("setup");
      window.history.replaceState(null, "", "#setup");
      window.scrollTo({ top: 0 });
      setResult(null); setJob(null); setSaveStatus("Copied trip settings · ready to edit");
      await refreshList();
    } finally { if (token === session.current) setLoadingTrip(false); }
  }
  useEffect(() => {
    let active = true;
    void Promise.all([api<{ trips: SavedSummary[] }>("/trips"), api<{ rules: PricingRule[] }>("/pricing-rules"), fetch("/api/data").then(r => r.json())]).then(async ([trips, data, config]) => {
      if (!active) return;
      setSummaries(trips.trips); setRules(data.rules); setTransitConfigured(config.transit_routing_configured);
      const id = localStorage.getItem("wayfinder:last-trip");
      if (id && trips.trips.some(t => t.id === id)) await openTrip(id, true);
    }).catch(err => { if (active) setError(err.message); }).finally(() => { if (active) setLoadingTrip(false); });
    return () => { active = false; };
    // Initial restore only; subsequent navigation is explicit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function saveSpec(): Promise<SavedTrip> {
    if (pendingSave.current) await pendingSave.current;
    const spec = draftRef.current;
    const issues = tripSetupIssues(spec);
    if (issues.length) throw new Error(issues.join(" · "));
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
    if (!dirty || !saved || tripSetupIssues(draft).length) return;
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
      navigateWorkspace("compare");
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
  const appliedSharedGroups = useMemo(() => {
    const offers = new Map<string, Offer>(allOffers.map(offer => [offer.id, offer] as const));
    const grouped = new Map<string, Offer[]>();
    const resultRoutes = [...(result?.routes ?? []), ...(result?.dominated_routes ?? []), ...(result?.refinement_routes ?? [])];
    const knownComponents = new Set(saved?.fare_component_ids ?? [
      ...(saved?.snapshot?.movements ?? []).flatMap(movement => [movement.id, ...movement.charges.map(charge => charge.id)]),
      ...resultRoutes.flatMap(route => [
        ...route.movements.flatMap(movement => [movement.id, ...movement.charges.map(charge => charge.id)]),
        ...route.extra_charges.map(charge => charge.id),
      ]),
    ]);
    for (const offer of offers.values()) {
      if (offer.source !== "user" || !offer.label.startsWith("Shared estimate:") || offer.movement_ids.length !== 1 || !knownComponents.has(offer.movement_ids[0]) || offer.low === null) continue;
      const entries = grouped.get(offer.label) ?? [];
      entries.push(offer);
      grouped.set(offer.label, entries);
    }
    return [...grouped].map(([label, entries]): AppliedSharedFareGroup => {
      const amounts = new Set(entries.map(offer => JSON.stringify([offer.low, offer.high])));
      const currencies = new Set(entries.map(offer => offer.currency));
      const first = entries[0];
      const mixed_amounts = amounts.size > 1;
      return {
        key: label,
        component_ids: [...new Set(entries.flatMap(offer => offer.movement_ids))],
        low: mixed_amounts ? null : first.low,
        high: mixed_amounts ? null : first.high,
        currency: first.currency,
        mixed_amounts,
        mixed_currency: currencies.size > 1,
        label,
      };
    }).sort((a, b) => a.label.localeCompare(b.label));
  }, [saved?.fare_component_ids, saved?.snapshot?.offers, saved?.offers, saved?.snapshot?.movements, result?.routes, result?.dominated_routes, result?.refinement_routes]);
  async function removeAssumedConnection(movementId: string) {
    if (!saved) return;
    const tripId = saved.id;
    await act(async () => {
      const updated = await api<Result>(`/trips/${tripId}/movements/${encodeURIComponent(movementId)}?expected_revision=${saved.revision}`, "DELETE");
      accept(await api<SavedTrip>(`/trips/${tripId}`));
      acceptResult(updated, tripId);
      setSaveStatus("Assumed connection removed · frontier recalculated");
    });
  }
  const coverage = result?.coverage;
  const unresolvedAccess = (coverage?.unresolved_movements ?? []).map(movement => ({
    ...movement,
    assumptions: movement.assumptions.filter(assumption => !assumption.startsWith("Airport change ") && !assumption.startsWith("Airport connection ")),
  })).filter(movement => movement.assumptions.length > 0);
  const extras = selected?.extra_charges ?? [];
  const setupNeeds = tripSetupIssues(draft);
  const ready = setupNeeds.length === 0;
  const needsDiscovery = !result || result.discovery_required;
  const canContinue = !active && !needsDiscovery && !!job && !["superseded", "complete"].includes(job.status) && (job.pending > 0 || job.failed_queries > 0);
  const needsFares = missingFareGroups.length > 0;
  const guidance = !ready ? { title: "Start with the essentials", text: setupNeeds.join(" · "), action: "Complete trip setup", run: () => navigateWorkspace("setup") }
    : dirty ? { title: saved ? saveStatus === "Changes not saved" ? "Your changes need attention" : "Saving your trip changes" : "Your trip is ready to save", text: saved ? saveStatus === "Changes not saved" ? "Check the error below, then save again from Trip setup." : "Results will update after your changes are saved." : "Save your plan, then search for transport options.", action: "Review setup", run: () => navigateWorkspace("setup") }
    : active ? { title: "Finding transport options", text: "You can compare results as they arrive. Collected work is saved.", action: "View live results", run: () => navigateWorkspace("compare") }
    : needsDiscovery ? { title: saved?.snapshot ? "Search needed for these trip settings" : "Ready to find your routes", text: "Search flights and ground transport, including the journey home.", action: "Search transport", run: () => void search() }
    : canContinue ? { title: "There are more options to search", text: `${job!.pending.toLocaleString()} queries remaining${job!.failed_queries ? ` · ${job!.failed_queries} failed queries can be retried` : ""}. Continue with another batch using saved results.`, action: "Continue search", run: () => void search(true) }
    : result?.optimization_complete === false && saved ? { title: "More route options may be available", text: "The calculation reached its current limit. Continue using saved transport data, or compare the routes already found.", action: "Continue calculating", run: () => void act(async () => { const record = await saveSpec(); acceptResult(await api<Result>(`/trips/${record.id}/optimize`, "POST", { expand: true }), record.id); }) }
    : needsFares ? { title: "Some costs still need your input", text: `${missingFareGroups.length} fare groups are missing prices. Add estimates to make costs and budget checks more useful.`, action: "Review missing fares", run: () => navigateWorkspace("pricing", "missing-fares-title") }
    : !routes.length ? { title: "No matching route found yet", text: "Review your dates, minimum stays, and missing connections, or start a new search.", action: "Review trip setup", run: () => navigateWorkspace("setup") }
    : { title: "Your routes are ready to compare", text: "Choose an option to see its journey, city stays, and ticket costs.", action: "Compare routes", run: () => navigateWorkspace("compare") };
  const dateLabel = (value: string) => value ? new Intl.DateTimeFormat("en-MY", { day: "numeric", month: "short", year: "numeric" }).format(new Date(`${value}T12:00:00`)) : "Choose a date";

  if (loadingTrip) return <main className="optimizer app-shell" aria-busy="true"><div className="p-empty" role="status">Loading your saved trip…</div></main>;

  return <main className="optimizer app-shell">
    <header className="p-topbar"><div className="brand-lockup"><div className="brand-icon"><Compass size={22} /></div><div><div className="brand-title">Wayfinder <span>Routes</span></div><div className="brand-caption">Trip planning workspace</div></div></div><div className="p-saved-controls"><ThemeToggle /><label className="sr-only" htmlFor="saved-trip">Saved trip</label><select id="saved-trip" value={saved?.id ?? ""} onChange={e => { if (e.target.value) void act(() => openTrip(e.target.value)); }}><option value="">Saved trips</option>{summaries.map(t => <option key={t.id} value={t.id}>{t.name} · {t.start_date}</option>)}</select><Button type="button" variant="secondary" size="sm" disabled={busy || !saved} title="Copy the selected trip settings into a new trip" onClick={() => void act(duplicateTrip)}><Copy size={14} />New from existing</Button><Button type="button" variant="secondary" size="sm" disabled={busy} onClick={() => { void act(async () => { if (pendingSave.current) await pendingSave.current; if (dirtyRef.current && draftRef.current.home && draftRef.current.visits.length) await saveSpec(); session.current++; const next = blankTrip(); draftRef.current = next; savedRef.current = null; setDraft(next); setSaved(null); setResult(null); setJob(null); setDirty(false); dirtyRef.current = false; setSaveStatus("New trip"); navigateWorkspace("setup"); localStorage.removeItem("wayfinder:last-trip"); }); }}><Plus size={14} />New</Button></div></header>
    <a href={`#${workspace}`} className="p-skip-link" onClick={event => { event.preventDefault(); navigateWorkspace(workspace); }}>Skip to workspace</a>
    <section className="p-intro"><div><span className="p-eyebrow">YOUR NEXT JOURNEY</span><h1>{saved ? draft.name : "Where would you like to go?"}</h1><p>{saved ? "Find the right balance between your transport budget and time away." : "Choose your cities. We’ll connect the journey and compare your options."}</p></div><span className="p-save-indicator" aria-live="polite">{dirty ? <span className="p-unsaved-dot" /> : saved ? <Check size={14} /> : null}{saveStatus}</span></section>
    <div className="p-trip-facts" aria-label="Trip summary"><span><CalendarDays size={15} />{dateLabel(draft.start_date)} <ArrowRight size={12} /> {dateLabel(draft.end_date)}</span><span><Users size={15} />{draft.adults} {draft.adults === 1 ? "adult" : "adults"}</span><span><MapPin size={15} />{draft.visits.length} {draft.visits.length === 1 ? "city" : "cities"} to visit</span><span><Wallet size={15} />{draft.budget_myr === null ? "No budget limit" : `${money(draft.budget_myr)} party budget`}</span></div>
    <nav className="p-workspace-nav" aria-label="Planning workspace">{([{ id: "setup", label: "Trip setup", icon: SlidersHorizontal }, { id: "compare", label: "Compare routes", icon: RouteIcon }, { id: "pricing", label: "Fares & connections", icon: Wallet }] as const).map(({ id, label, icon: Icon }) => <a key={id} href={`#${id}`} aria-current={workspace === id ? "page" : undefined} onClick={event => { event.preventDefault(); navigateWorkspace(id); }}><Icon size={16} />{label}{id === "compare" && !!routes.length && <span className="p-nav-count">{routes.length}</span>}{id === "pricing" && needsFares && <span className="p-nav-count p-warning">{missingFareGroups.length}</span>}</a>)}</nav>
    <div className={`p-guidance ${active ? "is-searching" : ""}`}><div className="p-guidance-icon">{active ? <LoaderCircle size={20} className="spin" /> : !ready ? <Compass size={20} /> : needsFares && !needsDiscovery ? <CircleHelp size={20} /> : <ArrowRight size={20} />}</div><div><strong>{guidance.title}</strong><p>{guidance.text}</p></div><Button type="button" variant="secondary" size="sm" disabled={busy} onClick={guidance.run}>{guidance.action}<ArrowRight size={14} /></Button></div>
    {error && <div className="p-alert p-error" role="alert" tabIndex={-1} ref={errorAlert}>{error}<button type="button" aria-label="Dismiss error" onClick={() => setError("")}>×</button></div>}
    {job && <details className="p-panel p-job" open={active}><summary><div><span className="p-step"><Compass size={15} /></span><h2>Transport search</h2><span className="p-job-label">{active && <LoaderCircle size={15} className="spin" />}{job.status === "cancelled" ? "Stopped · progress saved" : job.status}</span></div><small>{job.processed.toLocaleString()} processed · {job.pending.toLocaleString()} pending<ChevronRight size={14} /></small></summary><p>{job.processed} queries processed · {job.requests} provider requests · {job.cache_hits} cache hits{job.manual_quote_queries ? ` · ${job.manual_quote_queries} manual quotes (no request)` : ""} · {job.pending} pending</p><div className="p-actions">{active ? <Button type="button" size="sm" variant="secondary" onClick={() => void act(async () => { setJob(await api<Job>(`/searches/${job.id}/cancel`, "POST")); })}><Square size={13} />Stop search</Button> : job.status !== "superseded" && (job.pending > 0 || job.failed_queries > 0 || result?.optimization_complete === false) && <Button type="button" size="sm" disabled={busy} onClick={() => void search(true)}><RefreshCw size={13} />{job.pending > 0 ? "Continue searching" : job.failed_queries > 0 ? "Retry failed searches" : "Continue optimizing"}</Button>}<span className="p-hint">Collected data and fare edits are retained.</span></div>{job.messages.length > 0 && <details><summary>Provider status and coverage</summary>{job.messages.map((m, i) => <p key={i}>{m}</p>)}</details>}</details>}

    <div className="p-workspace-layout"><div id="workspace-content" className="p-workspace-content" tabIndex={-1}>
    <div id="setup" hidden={workspace !== "setup"}>
    <section className="p-panel" aria-labelledby="setup-title"><div className="p-panel-heading"><div><span className="p-step"><SlidersHorizontal size={16} /></span><h2 id="setup-title" tabIndex={-1}>Trip essentials</h2></div><span className="p-tag">{ready ? "Ready to search" : `${setupNeeds.length} to complete`}</span></div>
      <p className="p-section-intro">Set your dates and places. The planner finds the visit order that gives you the best cost–time options.</p><div className="p-grid p-main-fields"><Field label="Trip name"><input value={draft.name} maxLength={120} onChange={e => edit({ ...draft, name: e.target.value })} /></Field><Field label="Leave home"><input type="date" value={draft.start_date} onChange={e => edit({ ...draft, start_date: e.target.value })} /></Field><Field label="Arrive home"><input type="date" min={draft.start_date} value={draft.end_date} onChange={e => edit({ ...draft, end_date: e.target.value })} /></Field><Field label="Date mode"><select value={draft.date_mode} onChange={e => edit({ ...draft, date_mode: e.target.value as TripSpec["date_mode"] })}><option value="fixed">Fixed outward and return dates</option><option value="flexible">Optimize within this date window</option></select></Field></div>
      <p className="p-hint">{draft.date_mode === "fixed" ? "Leave home on the start date and arrive back on the end date, including positioning journeys." : "The optimizer can choose outward and return days anywhere inside this window."}</p>
      <div className="p-destination-layout"><div><PlacePicker label="Home city" onSelect={p => edit({ ...draft, home: p, visits: draft.visits.filter(v => v.place.id !== p.id) })} />{draft.home && <PlaceChips places={[draft.home]} remove={() => edit({ ...draft, home: null })} />}</div>      <div className="p-visits"><PlacePicker disabled={draft.visits.length >= 4} label={`Cities to visit · ${draft.visits.length} of 4`} disabledIds={[draft.home?.id ?? "", ...draft.visits.map(v => v.place.id)]} onSelect={p => { if (draft.visits.length < 4) edit({ ...draft, visits: [...draft.visits, { place: p, min_stay_hours: 0 }] }); }} />
        {!draft.visits.length && <p className="p-hint">Add at least one destination. You do not need to choose a visit order.</p>}<div className="p-visit-list">{draft.visits.map((v, i) => <div key={v.place.id}><strong>{v.place.name}<small>{v.place.timezone}</small></strong><NumberField label={`Minimum stay in ${v.place.name} · hours`} value={v.min_stay_hours} onChange={n => edit({ ...draft, visits: draft.visits.map((x, j) => j === i ? { ...x, min_stay_hours: n ?? 0 } : x) })} /><button type="button" aria-label={`Remove required city ${v.place.name}`} onClick={() => edit({ ...draft, visits: draft.visits.filter(x => x.place.id !== v.place.id), commitments: draft.commitments.filter(c => c.place_id !== v.place.id) })}>×</button></div>)}</div>
        {draft.visits.length > 1 && <button type="button" className="p-text-button" onClick={() => edit({ ...draft, visits: draft.visits.map(v => ({ ...v, min_stay_hours: draft.visits[0].min_stay_hours })) })}>Apply the first city's minimum to all cities</button>}</div>
</div>
      <details className="p-details p-gateways"><summary>Travel via another city <span>{draft.departures.length + draft.arrivals.length ? `${draft.departures.length} outbound · ${draft.arrivals.length} return` : "Optional gateways"}</span></summary><p className="p-hint">For example, take a bus from home to a city with cheaper flights. Add up to 3 choices each way; travel from and back to home is included.</p><div className="p-grid p-gateway-fields">
        <div><PlacePicker disabled={draft.departures.length >= 3} label={`Outbound gateways (${draft.departures.length}/3)`} disabledIds={draft.departures.map(p => p.id)} onSelect={p => { if (draft.departures.length < 3) edit({ ...draft, departures: [...draft.departures, p] }); }} /><PlaceChips places={draft.departures} remove={id => edit({ ...draft, departures: draft.departures.filter(p => p.id !== id) })} /><small>Leave empty to use home.</small></div>
        <div><PlacePicker disabled={draft.arrivals.length >= 3} label={`Return gateways (${draft.arrivals.length}/3)`} disabledIds={draft.arrivals.map(p => p.id)} onSelect={p => { if (draft.arrivals.length < 3) edit({ ...draft, arrivals: [...draft.arrivals, p] }); }} /><PlaceChips places={draft.arrivals} remove={id => edit({ ...draft, arrivals: draft.arrivals.filter(p => p.id !== id) })} /><small>Leave empty to return directly to home.</small></div></div>
</details>
      <div className="p-grid"><NumberField label="Adult travelers" value={draft.adults} min={1} max={9} step={1} onChange={n => edit({ ...draft, adults: n ?? 1 })} /><NumberField label="Party budget · MYR" value={draft.budget_myr} optional placeholder="No limit" hint="Transport total for everyone" onChange={n => edit({ ...draft, budget_myr: n })} /></div>
      <fieldset className="p-modes"><legend>Allowed intercity transportation</legend>{modes.map(mode => <label className="p-check" key={mode}><input type="checkbox" checked={draft.modes.includes(mode)} onChange={e => edit({ ...draft, modes: e.target.checked ? [...draft.modes, mode] : draft.modes.filter(m => m !== mode) })} />{mode}</label>)}<label className="p-check"><input type="checkbox" checked={draft.allow_overnight} onChange={e => edit({ ...draft, allow_overnight: e.target.checked })} />Allow overnight travel</label></fieldset>
      <details className="p-details"><summary>Search preferences <span>Departure times, transfers & estimates</span></summary><div className="p-grid"><NumberField label="Maximum transfers per journey" value={draft.max_transfers} optional step={1} max={10} onChange={n => edit({ ...draft, max_transfers: n })} /><Field label="Local departure window starts"><input type="time" value={draft.departure_start} onChange={e => edit({ ...draft, departure_start: e.target.value })} /></Field><Field label="Local departure window ends"><input type="time" value={draft.departure_end} onChange={e => edit({ ...draft, departure_end: e.target.value })} /></Field></div><p className="p-hint">Departure windows use each journey’s local time and apply to automatic searches. Supplied services keep their entered times.</p>
      <label className="p-check"><input type="checkbox" checked={draft.rail_fallback?.enabled ?? false} onChange={e => edit({ ...draft, rail_fallback: { reference_date: null, max_shift_days: 180, station_radius_km: 25, ...draft.rail_fallback, enabled: e.target.checked } })} />Allow estimated rail timetables when actual-date searches find no journey</label>
      {draft.rail_fallback?.enabled && <div className="p-grid"><p className="p-hint">Search nearby stations, then sample up to three matching weekdays for trips more than two weeks away. Copied timetables are estimates; holidays, fares and seat availability need verification. Station access uses walking times. Start a new discovery after changing these settings.</p><Field label="Reference week starting · blank uses today"><input type="date" value={draft.rail_fallback.reference_date ?? ""} onChange={e => edit({ ...draft, rail_fallback: { ...draft.rail_fallback!, reference_date: e.target.value || null } })} /></Field><Field label="Maximum timetable shift · days"><input type="number" min="7" max="365" value={draft.rail_fallback.max_shift_days} onChange={e => edit({ ...draft, rail_fallback: { ...draft.rail_fallback!, max_shift_days: Number(e.target.value) } })} /></Field><Field label="Station search radius · km"><input type="number" min="1" max="50" value={draft.rail_fallback.station_radius_km} onChange={e => edit({ ...draft, rail_fallback: { ...draft.rail_fallback!, station_radius_km: Number(e.target.value) } })} /></Field></div>}
      <label className="p-check"><input type="checkbox" checked={draft.exclude_unpriced_flights ?? false} onChange={e => edit({ ...draft, exclude_unpriced_flights: e.target.checked })} />Ignore flights with unknown fares</label>
      <p className="p-hint">Excludes itineraries with unpriced flights after applying ticket bundles, manual fares, and pricing rules. Saved flight schedules are retained; other transport and transfer fares may still be unknown.</p>
      </details>
      {!transitConfigured && draft.modes.some(m => ["rail", "bus", "coach", "subway", "tram"].includes(m)) && <p className="p-notice">Scheduled transit is currently disabled. Configure the Transitous contact URL and coordinate routing use to enable it.</p>}
      <PositioningSettings draft={draft} edit={edit} report={setError} />
      <AdvancedSettings draft={draft} edit={edit} places={places} report={setError} />
      <div className="p-search-settings"><details className="p-details"><summary>Search batch size <span>{budget} requests</span></summary><NumberField label="Provider requests per batch" value={budget} min={1} max={500} step={1} onChange={n => setBudget(n ?? 100)} /><p className="p-hint">A batch limits new provider requests. You can continue later using collected data.</p></details></div>{!ready && <p className="p-hint" role="status">{setupNeeds.join(" · ")}</p>}<div className="p-actions p-search-actions"><span className="p-hint">{saved ? "Edits save automatically. Recalculate uses collected transport." : "Save your plan or search to save and find transport."}</span><Button type="button" variant="secondary" disabled={busy || !ready} onClick={() => void act(async () => { const changed = dirtyRef.current; const record = await saveSpec(); if (!changed) acceptResult(await api<Result>(`/trips/${record.id}/optimize`, "POST"), record.id); })}><Save size={15} />Save & recalculate</Button><Button type="button" disabled={busy || active || !ready} onClick={() => void search()}>{busy ? <LoaderCircle size={15} className="spin" /> : <Play size={15} />}{active ? "Searching…" : saved?.snapshot ? "Start new search" : "Search transport"}</Button></div>
    </section>

    </div>
    <div id="pricing" hidden={workspace !== "pricing"}>
      <div className="p-view-heading"><h2>Fill the gaps in your trip</h2><p>Add missing fares and connections here. Each price is for your whole party.</p></div>
    {result && <>
      {saved && <AirportConnectionsTable key={`airport-connections:${saved.id}`} tripId={saved.id} requirements={saved.airport_connections_required ?? coverage?.airport_connections_required ?? noAirportConnectionRequirements} connections={saved.airport_connections ?? noAirportConnections} report={setError} onSaved={(record, updated) => { accept(record); acceptResult(updated, record.id); setSaveStatus("Airport connections saved · frontier recalculated"); }} />}
      {(missingFareGroups.length > 0 || appliedSharedGroups.length > 0) && <MissingFaresTable key={`missing-fares:${saved?.id}`} storageKey={`wayfinder:pending-estimates:${saved?.id}`} groups={missingFareGroups} appliedGroups={appliedSharedGroups} placeName={placeName} offerFor={offerFor} onApply={applySharedFares} onSave={updatePrice} onRemove={removePrice} />}
      {!!unresolvedAccess.length && <details className="p-panel"><summary>{unresolvedAccess.length} retrieved journeys need airport access timing</summary>{unresolvedAccess.map(m => <p key={m.id}>{placeName(m.from_id)} → {placeName(m.to_id)}: {m.assumptions.join(" · ")}</p>)}</details>}
    </>}
    {saved && <details className="p-panel p-transfer-disclosure"><summary>Airport ↔ city transfers <span>Travel times and party fares</span></summary>{saved && <AirportTransferTable key={saved.id} trip={saved} save={async estimates => {
      const record = await saveSpec();
      const updated = await api<SavedTrip>(`/trips/${record.id}/airport-transfer-estimates`, "PUT", { estimates, expected_revision: record.revision });
      accept(updated);
      if (updated.result) acceptResult(updated.result, updated.id);
      setSaveStatus("Airport transfer estimates saved");
    }} report={setError} />}

    </details>}
    <section className="p-panel p-pricing-tools"><h2>Pricing rules & custom connections</h2>{saved && (saved.assumed_connections?.length ?? 0) > 0 && <div><h3>Saved assumed connections</h3>{saved.assumed_connections!.map(m => <div className="p-actions" key={m.id}><span>{placeName(m.from_id)} → {placeName(m.to_id)} · {m.mode} · {m.duration_minutes} min{m.departure ? ` · ${localTime(m.departure, places.find(p => p.id === m.from_id)?.timezone ?? "UTC")}` : " · Flexible departure"}</span><Button type="button" size="sm" variant="secondary" disabled={busy} onClick={() => void removeAssumedConnection(m.id)}>Remove</Button></div>)}</div>}<RulesEditor rules={rules} places={places} changed={rulesChanged} report={setError} />{saved && <AssumedConnection gaps={saved.city_connection_gaps ?? []} places={places} report={setError} add={async m => { const record = await saveSpec(); const next = await api<Result>(`/trips/${record.id}/movements`, "POST", m); accept(await api<SavedTrip>(`/trips/${record.id}`)); acceptResult(next, record.id); }} />}</section>

    </div>
    <div id="compare" hidden={workspace !== "compare"}>
    {!result && <section className="p-panel p-first-search"><RouteIcon size={36} /><h2>{active ? "Your search is under way" : "Your journey starts here"}</h2><p>{active ? "Routes will appear as transport options are collected. You can leave this page and return to your saved trip." : "Set your home, destinations, and dates, then search for transport to see routes here."}</p><Button type="button" variant="secondary" onClick={() => navigateWorkspace("setup")}>Review trip setup<ArrowRight size={14} /></Button></section>}
    {result && <>

      {(result.discovery_required || dirty) && <div className="p-notice">{dirty ? "Trip changes are being saved; displayed results belong to the previous revision." : "Transport discovery is needed for these trip inputs. Saved fare edits remain available."}</div>}

      <section className="p-panel" aria-labelledby="frontier-title"><div className="p-panel-heading"><div><span className="p-step"><RouteIcon size={16} /></span><h2 id="frontier-title" tabIndex={-1}>Compare your routes</h2></div><span className="p-tag">{result.routes.length} route options{showDominated && result.dominated_routes ? ` + ${result.dominated_routes.length} dominated` : ""}</span></div><div className="p-results-status"><span className={`p-tag ${!coverage?.discovery_complete ? "uncertain" : ""}`}>{coverage?.discovery_complete ? "Search complete" : "Partial search coverage"}</span><span className={`p-tag ${!result.optimization_complete ? "uncertain" : ""}`}>{result.optimization_complete ? "Routes calculated" : "More routes may be found"}</span></div><p className="p-section-intro">Spend less or stay longer. Select a route, then open its itinerary to review the journey and fares.</p>        {!result.optimization_complete && !active && !job && saved && <Button type="button" size="sm" onClick={() => void act(async () => { acceptResult(await api<Result>(`/trips/${saved.id}/optimize`, "POST", { expand: true }), saved.id); })}>Continue optimizing</Button>}
        <div className="p-inline p-route-sort"><Field label={showDominated ? "Sort all routes" : "Sort routes"}><select value={ranking} onChange={e => setRanking(e.target.value)}><option value="cheapest">Lowest known total</option><option value="stay">Most city-stay hours</option><option value="balanced">Balanced · equal cost/time weights</option></select></Field><small>Ordering does not change frontier membership.</small></div>
        {!routes.length && <div className="p-empty">No route matches your trip in the collected transport data. {job?.pending ? "Continue discovery or add a missing connection." : "Check coverage, dates, minimum stays, and transport assumptions."}</div>}
        {!routes.length && !!result.refinement_routes?.length && <details className="p-details"><summary>Review an over-budget candidate to add a ticket quote</summary><p>These are up to ten fare-refinement examples, outside your current budget. They are not plotted as feasible frontier options.</p>{result.refinement_routes.map(r => <Button key={r.id} type="button" size="sm" variant="secondary" onClick={() => setSelectedId(r.id)}>{routeCost(r)} · {r.stay_hours.toFixed(1)} city hours</Button>)}</details>}
        <div className="p-selection-toolbar"><span className="p-hint">{selected ? `Selected: ${routeCost(selected)} · ${selected.stay_hours.toFixed(1)} city hours` : "Choose a route below"}</span>{selected && <Button type="button" size="sm" variant="secondary" onClick={() => navigateWorkspace("compare", "details-title")}>View itinerary<ArrowRight size={14} /></Button>}</div><div className="p-route-grid">{routes.slice(Math.min(routePage, Math.max(0, Math.ceil(routes.length / 40) - 1)) * 40, (Math.min(routePage, Math.max(0, Math.ceil(routes.length / 40) - 1)) + 1) * 40).map((r, i) => <button type="button" key={r.id} className={`p-route-card ${selected?.id === r.id ? "selected" : ""}`} aria-pressed={selected?.id === r.id} onClick={() => setSelectedId(r.id)}><span className="p-route-number">{String(i + Math.min(routePage, Math.max(0, Math.ceil(routes.length / 40) - 1)) * 40 + 1).padStart(2, "0")}</span><div><strong>{routeCost(r)}</strong><small className="p-route-path">{[r.movements[0]?.from_id, ...r.movements.map(m => m.to_id)].filter((id): id is string => !!id).map(placeName).join(" → ")}</small><span>{r.stay_hours.toFixed(1)} city hours · {r.travel_hours.toFixed(1)} h travel · <span title="Total party fare divided by city-stay hours">{cityHourCost(r)}</span></span><small>{placeName(r.departure_gateway)} outward · {placeName(r.arrival_gateway)} return</small><small>{r.movements.map(m => m.mode).join(" → ")}</small>{r.movements.some(m => m.schedule_estimated) && <small className="p-warning">Estimated rail timetable</small>}</div><span className={`p-tag ${r.provisional ? "uncertain" : ""}`}>{result.dominated_routes?.some(other => other.id === r.id) ? "Dominated" : r.provisional ? "Provisional" : r.estimated ? "Includes estimates" : "Priced"}</span>{r.budget_status === "uncertain" && <small className="p-warning">Budget compliance uncertain</small>}</button>)}</div>
        {routes.length > 40 && <div className="p-actions"><Button type="button" size="sm" variant="secondary" disabled={routePage === 0} onClick={() => setRoutePage(p => Math.max(0, p - 1))}>Previous alternatives</Button><span>Page {Math.min(routePage + 1, Math.ceil(routes.length / 40))} / {Math.ceil(routes.length / 40)}</span><Button type="button" size="sm" variant="secondary" disabled={(routePage + 1) * 40 >= routes.length} onClick={() => setRoutePage(p => p + 1)}>Next alternatives</Button></div>}
        <details className="p-details p-route-chart" onToggle={event => setChartOpen(event.currentTarget.open)}><summary>Explore the cost–time chart <span>Compare the tradeoffs visually</span></summary><details className="p-details p-chart-options"><summary>How to read this comparison & show other alternatives</summary><p className="p-hint">Circles: priced offers. Diamonds: estimates. Horizontal bands: fare ranges; their selection marker is the midpoint, not an expected price. Unknown totals stay in the list below. Optimality covers retrieved options and stated assumptions.</p>
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
</details>
        {workspace === "compare" && chartOpen && <ParetoExplorer routes={result.routes} dominated={showDominated ? result.dominated_routes : undefined} selected={selected?.id ?? null} onSelect={setSelectedId} />}
</details>
        {selected && routes.length > 1 && <div className="p-comparison"><Field label="Compare selected itinerary with"><select value={comparisonId ?? ""} onChange={e => setComparisonId(e.target.value || null)}><option value="">Choose another alternative</option>{routes.filter(r => r.id !== selected.id).map(r => <option value={r.id} key={r.id}>{routeCost(r)} · {r.stay_hours.toFixed(1)} city hours</option>)}</select></Field>{compare && compare.id !== selected.id && <p>Selected itinerary: <strong>{Math.abs(selected.stay_hours - compare.stay_hours).toFixed(1)} {selected.stay_hours >= compare.stay_hours ? "more" : "fewer"} city hours</strong>{selected.total_cost_myr !== null && compare.total_cost_myr !== null && <> for <strong>{money(Math.abs(selected.total_cost_myr - compare.total_cost_myr))} {selected.total_cost_myr >= compare.total_cost_myr ? "more" : "less"}</strong>{selected.stay_hours > compare.stay_hours && ` · ${money((selected.total_cost_myr - compare.total_cost_myr) / (selected.stay_hours - compare.stay_hours))} per additional hour`}</>}{(selected.provisional || compare.provisional) && " · resolve fare ranges to compare an exact additional cost"}.</p>}</div>}
      </section>

      {selected && <section className="p-panel" aria-labelledby="details-title"><div className="p-panel-heading"><div><span className="p-step"><MapPin size={16} /></span><h2 id="details-title" tabIndex={-1}>Selected itinerary</h2>{selected.budget_status === "over" && <span className="p-tag uncertain">Outside budget · fare refinement only</span>}</div><strong>{routeCost(selected)}</strong></div><div className="p-detail-layout"><div>{workspace === "compare" && <PlannerMap places={places} route={selected} />}<p className="p-hint">City reference points and schematic connections; lines do not show road or track geometry.</p></div><div className="p-timeline"><h3>Time in each required city</h3>{selected.stays.map((s, i) => <div key={`${s.place_id}:${i}`}><span className="p-timeline-dot" /><strong>{placeName(s.place_id)} <span>{s.hours.toFixed(1)} h</span></strong><small>{localTime(s.arrival, byId.get(s.place_id)?.timezone ?? "UTC")}<ArrowRight size={13} />{localTime(s.departure, byId.get(s.place_id)?.timezone ?? "UTC")}</small><progress max={selected.stay_hours || 1} value={s.hours} /></div>)}<p className="p-hint">City-stay hours include nights, exclude all transportation and terminal overhead, and do not count time at home or other positioning cities.</p></div></div>
        <div className="p-leg-details">{selected.movements.map((m, i) => <details key={`${m.id}:${i}`} open={i === 0}><summary><span className="p-leg-index">{i + 1}</span><strong>{placeName(m.from_id)} → {placeName(m.to_id)}</strong><span className="p-tag">{m.mode}{m.vehicle_kind ? ` · ${m.vehicle_kind}` : ""}</span><span>{(m.duration_minutes / 60).toFixed(1)} h</span></summary><div className="p-leg-content"><p>{localTime(m.departure, byId.get(m.from_id)?.timezone ?? "UTC")} → {localTime(m.arrival, byId.get(m.to_id)?.timezone ?? "UTC")}<br /><small>{m.source} · {m.transfers} transfers{m.distance_km !== null ? ` · ${m.distance_km.toFixed(1)} km` : ""}</small></p>{m.assumptions.map(a => <p className="p-notice" key={a}>{a}</p>)}
          {m.schedule_estimated && <p className="p-notice">Estimated rail timetable{m.schedule_reference_date ? ` · based on ${m.schedule_reference_date}` : " · provider extended calendar"}. Verify the actual travel date before booking.</p>}
          {m.segments.length > 0 && <ul className="p-segments">{m.segments.map((s, j) => <li key={j}><strong>{s.mode}: {s.from_name} → {s.to_name}</strong><small>{s.departure && `${localTime(s.departure, s.from_timezone ?? "UTC")} (${s.from_timezone ?? "UTC"}) → ${localTime(s.arrival, s.to_timezone ?? "UTC")} (${s.to_timezone ?? "UTC"}) · `}{s.service} {s.operator}{s.source ? ` · ${s.source}` : ""}{s.assumed ? " · assumed" : ""}{s.duration_minutes !== null ? ` · ${s.duration_minutes.toFixed(0)} min` : ""}</small></li>)}</ul>}
          <FareEditor componentId={m.id} label={`Standalone ${m.mode} fare`} offer={offerFor(m.id)} onSave={updatePrice} onRemove={removePrice} />{m.charges.filter(c => !c.kind.startsWith("Airport transfer ")).map(c => <FareEditor key={c.id} componentId={c.id} label={c.kind} offer={offerFor(c.id)} onSave={updatePrice} onRemove={removePrice} />)}{m.search_url && <a href={m.search_url} target="_blank" rel="noreferrer">Open flight search ↗</a>}</div></details>)}</div>
        {extras.map(c => <FareEditor key={c.id} componentId={c.id} label={c.kind} offer={offerFor(c.id)} onSave={updatePrice} onRemove={removePrice} />)}
        <h3>Ticket purchases and cost breakdown</h3><div className="p-purchases">{selected.purchases.map(o => <div key={o.id}><strong>{o.label || o.kind}<small>{o.kind} · {o.movement_ids.length} component(s) · {o.source}{o.estimated ? " estimate" : ""}</small></strong><span>{o.low === o.high ? money(o.low, o.currency) : `${money(o.low, o.currency)} – ${money(o.high, o.currency)}`}</span>{o.source === "user" && <button type="button" aria-label={`Remove fare ${o.label}`} onClick={() => void act(() => removePrice(o.id))}>×</button>}</div>)}</div>
        <p className="p-hint">Each ticket is charged once. Combined flight tickets do not include separately listed airport transfers. Average fare per stay hour: {money(selected.cost_per_stay_hour_myr)}. Prices are quotes or assumptions, not booking guarantees.</p>
        <BundleEntry route={selected} placeName={placeName} save={updatePrice} report={setError} />
      </section>}
      {!!(coverage?.bundle_links?.length || job?.bundle_links?.length) && <section className="p-panel"><details><summary>Round-trip and multi-city quote searches</summary><p>An automatic quote is usable only when all journeys and the combined fare are verified. Otherwise open the search and enter a complete ticket price above.</p>{(job?.bundle_links ?? coverage?.bundle_links ?? []).map((b, i) => <p key={i}><a href={b.url} target="_blank" rel="noreferrer">{b.kind}: {b.legs.map(l => `${placeName(l.from_id)} → ${placeName(l.to_id)} (${l.date})`).join(" · ")} ↗</a><small> · {b.status}</small></p>)}</details></section>}
    </>}
    </div>
    </div><aside className="p-trip-sidebar" aria-label="Trip overview"><div className="p-sidebar-content"><span className="p-eyebrow">THE PLAN AT A GLANCE</span><h2>Your round trip</h2><ol className="p-journey-preview"><li className="p-home-stop"><span className="p-stop-dot" /><div><small>Start from home</small><strong>{draft.home?.name ?? "Choose your home"}</strong></div></li>{draft.visits.length ? draft.visits.map(visit => <li key={visit.place.id}><span className="p-stop-dot" /><div><strong>{visit.place.name}</strong><small>{visit.min_stay_hours > 0 ? `At least ${visit.min_stay_hours} hours` : "No minimum stay"}</small></div></li>) : <li><span className="p-stop-dot" /><div><strong>Add your destinations</strong><small>Up to 4 cities, in any order</small></div></li>}<li className="p-home-stop"><span className="p-stop-dot" /><div><small>Return home</small><strong>{draft.home?.name ?? "Your home city"}</strong></div></li></ol><p className="p-hint">The planner chooses the visit order and gateways. Nights count toward city stays.</p><div className="p-sidebar-checklist"><h3>Planning progress</h3>{[{ done: ready, label: "Trip essentials", view: "setup" }, { done: !!result && !result.discovery_required && !!coverage?.discovery_complete, label: "Transport search", view: "compare" }, { done: !!routes.length && !needsFares && !routes.some(route => route.provisional), label: "Fares reviewed", view: "pricing" }].map(item => <button key={item.label} type="button" onClick={() => navigateWorkspace(item.view as Workspace)}><span className={`p-check-dot ${item.done ? "is-done" : ""}`}>{item.done && <Check size={12} />}</span>{item.label}<ChevronRight size={14} /></button>)}</div><div className="p-sidebar-note"><Save size={16} /><p>{saved ? "Changes save automatically. Reopening this trip keeps its collected schedules and fare edits." : "Save your trip to keep your settings and return to them later."}</p></div></div></aside></div>
    <footer className="p-footer">Wayfinder Routes · Flights via fast-flights · Scheduled transit via <a href="https://transitous.org/sources/" target="_blank" rel="noreferrer">Transitous sources</a> · Road estimates via OSRM · Cities © GeoNames · Airports © airportsdata · Map © OpenStreetMap contributors</footer>
  </main>;
}
