import { AirportTransferTable } from "./components/AirportTransferTable";
import { AppHeader } from "./components/AppHeader";
import { InfoTip } from "./components/InfoTip";
import { OptionsPanel } from "./components/OptionsPanel";
import { ErrorBanner } from "./components/ErrorBanner";
import { StatusStrip } from "./components/StatusStrip";
import { Tabs, type TabItem } from "./components/Tabs";
import { TripBar } from "./components/TripBar";
import { TripSettings } from "./components/TripSettings";
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, CircleCheck, LoaderCircle } from "lucide-react";
import { Button } from "./components/ui/button";
import { FareEditor, Field, RulesEditor } from "./components/PlannerForms";
import { MissingFaresTable, type AppliedSharedFareGroup } from "./components/MissingFaresTable";
import { groupMissingFares } from "./lib/missingFares";
import { storedOfferId, type SharedFare } from "./lib/drafts";
import { airportChangeRows, appError, assumedConnections, buildNextSteps, cityGaps, needsInputCount, optionNumber, optionsEmptyState, partySizeNotice, routeSignature, searchDetails, searchState, settingsFooter, sortRoutes, splitGroups, staySumWarning, transferDirections, transitSearchModes, unresolvedAccessJourneys, validateDraft, type AirportChangeRow, type AppError, type OptionsTarget } from "./lib/present";
import { api, blankTrip, defaultBatchSize, localTime, modes, money, routeCost, type AirportTransferMode, type Job, type Movement, type Offer, type Place, type PricingRule, type Result, type Route, type SavedSummary, type SavedTrip, type TripDraft } from "./lib/planner";
import { useMediaQuery } from "./lib/useMediaQuery";
import "./planner.css";

const LazyMap = lazy(() => import("./components/PlannerMap").then(m => ({ default: m.PlannerMap })));
function PlannerMap(props: { places: Place[]; route: Route | null }) {
  return <Suspense fallback={<div className="p-empty">Loading the itinerary map…</div>}><LazyMap {...props} /></Suspense>;
}

const airportTransferModes: AirportTransferMode[] = modes.filter((mode): mode is AirportTransferMode => mode !== "flight");
/** A failed poll of the search status (C2). The next successful poll removes this error, so it is compared by identity. */
const pollError: AppError = { text: "Can't get the search status. Retrying…", action: null };
/** The workspace panels (C5). Wide screens always show the options, and the side panel shows "itinerary" or "missing". */
type Panel = "options" | "itinerary" | "missing";
/** Option rows shown at first, and added by each "Show more" (C6). */
const pageSize = 40;

function AirportConnectionsTable({ tripId, rows: savedRows, onSaved, report }: {
  tripId: string;
  rows: AirportChangeRow[];
  onSaved: (record: SavedTrip, result: Result) => void;
  report: (message: string) => void;
}) {
  // Typed rows reset only when the trip or the server's pairs change. Polling and
  // autosave replace the records with new objects that hold the same rows.
  const signature = JSON.stringify(savedRows);
  const [rows, setRows] = useState<AirportChangeRow[]>(savedRows);
  const [busy, setBusy] = useState(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => setRows(savedRows), [tripId, signature]);

  if (!rows.length) return null;
  const requirements = savedRows.filter(row => row.required);
  const requiredJourneys = requirements.reduce((sum, item) => sum + item.journey_count, 0);
  const pairKey = (row: Pick<AirportChangeRow, "from_airport" | "to_airport">) => `${row.from_airport}>${row.to_airport}`;
  // Next steps › Add airport transfer focuses this row's mode.
  const firstUnresolved = rows.find(row => row.unresolved_journey_count > 0);
  function updateRow(key: string, change: Partial<AirportChangeRow>) {
    setRows(current => current.map(row => pairKey(row) === key ? { ...row, ...change } : row));
  }
  function clearOrRemove(row: AirportChangeRow) {
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
        <td><select id={row === firstUnresolved ? "airport-change-unresolved" : undefined} aria-label={`${row.from_airport} to ${row.to_airport} transfer mode`} value={row.mode} onChange={event => updateRow(pairKey(row), { mode: event.target.value as AirportTransferMode | "" })}><option value="">Choose mode</option>{airportTransferModes.map(mode => <option value={mode} key={mode}>{mode}</option>)}</select></td>
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
  // A combined ticket covers template ids: the server checks it against the saved flights,
  // and transfer estimates give route flights variant ids.
  const ticketId = (m: Movement) => m.template_id ?? m.id;
  const [selected, setSelected] = useState<string[]>(flights.map(ticketId));
  const [kind, setKind] = useState<"round-trip" | "multi-city">("multi-city");
  const [low, setLow] = useState("");
  const [high, setHigh] = useState("");
  const [currency, setCurrency] = useState("MYR");
  const [busy, setBusy] = useState(false);
  useEffect(() => { setSelected(route.movements.filter(m => m.mode === "flight").map(ticketId)); }, [route.id]);
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
    <div>{flights.map(m => <label className="p-check" key={m.id}><input type="checkbox" checked={selected.includes(ticketId(m))} onChange={e => setSelected(ids => e.target.checked ? [...ids, ticketId(m)] : ids.filter(id => id !== ticketId(m)))} />{placeName(m.from_id)} → {placeName(m.to_id)} · {m.departure?.slice(0, 10)}</label>)}</div>
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
  return <><div aria-live="polite">{gaps.length > 0 && <><h3>Missing city connections</h3><p>No direct connection was collected in either direction for these cities. If your route needs one, enter a verified schedule or an assumed duration below. Connecting routes or enabled road transport may still provide alternatives.</p>{gaps.map(gap => <Button key={`${gap.from_id}:${gap.to_id}`} type="button" variant="secondary" onClick={() => { setForm(f => ({ ...f, from: gap.from_id, to: gap.to_id })); const panel = document.getElementById("assumed-city-connection") as HTMLDetailsElement | null; if (panel) { panel.open = true; panel.scrollIntoView({ block: "center" }); } }}>Add {places.find(p => p.id === gap.from_id)?.name} → {places.find(p => p.id === gap.to_id)?.name}</Button>)}</>}</div><details id="assumed-city-connection" className="p-details"><summary id="add-connection">Add a connection missing from the providers</summary><p>This explicitly assumes that the connection exists. Flexible connections use the duration; scheduled connections need both timestamps (shown in your browser timezone).</p><div className="p-grid">
    {(["from", "to"] as const).map(key => <Field key={key} label={`Assumed connection ${key}`}><select value={form[key]} onChange={e => setForm(f => ({ ...f, [key]: e.target.value }))}><option value="">Choose place</option>{places.map(p => <option value={p.id} key={p.id}>{p.name}</option>)}</select></Field>)}
    <Field label="Assumed mode"><select value={form.mode} onChange={e => setForm(f => ({ ...f, mode: e.target.value }))}>{modes.map(m => <option key={m}>{m}</option>)}</select></Field>
    <Field label="Assumed duration · hours"><input type="number" min="0.01" step="any" value={form.hours} onChange={e => setForm(f => ({ ...f, hours: e.target.value }))} /></Field><Field label="Assumed distance · km (optional)"><input type="number" min="0" value={form.distance} onChange={e => setForm(f => ({ ...f, distance: e.target.value }))} /></Field>
    <Field label="Optional departure · browser local"><input type="datetime-local" value={form.departure} onChange={e => setForm(f => ({ ...f, departure: e.target.value }))} /></Field><Field label="Optional arrival · browser local"><input type="datetime-local" value={form.arrival} onChange={e => setForm(f => ({ ...f, arrival: e.target.value }))} /></Field><Button type="button" size="sm" variant="secondary" disabled={busy} onClick={() => void submit()}>Add assumed connection</Button>
  </div></details></>;
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
  // Option rows shown (C6): 40, reset when the sort changes, clamped when the list gets shorter.
  const [visibleCount, setVisibleCount] = useState(pageSize);
  const [showDominated, setShowDominated] = useState(false);
  // Requests per search batch (G › Search size): memory only, sent as the search request's budget.
  const [batchSize, setBatchSize] = useState(defaultBatchSize);
  // The action that act() runs. Its button shows the spinner; the other action buttons wait.
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const busy = busyAction !== null;
  // The first load replaces the whole page. Opening or copying a trip replaces only <main>.
  const [initialLoad, setInitialLoad] = useState(true);
  const [loadingTrip, setLoadingTrip] = useState(false);
  const [loadingName, setLoadingName] = useState("");
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<AppError | null>(null);
  const [saveStatus, setSaveStatus] = useState("Not saved yet");
  const [transitConfigured, setTransitConfigured] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(true);
  // The selected workspace tab. "options" on a wide screen shows the itinerary in the side panel.
  const [panel, setPanel] = useState<Panel>("options");
  // Panels mount when first shown, then stay mounted while hidden, so typed values survive a tab change.
  const [visited, setVisited] = useState<Panel[]>([]);
  const isWide = useMediaQuery("(min-width: 1100px)");
  // The id of the element to focus after the next render; with a list, the first element that exists.
  const [focusTarget, setFocusTarget] = useState<string | string[] | null>(null);
  // A chart click scrolls the selected row into view after the render (E8).
  const [revealRow, setRevealRow] = useState(0);
  const draftRef = useRef(draft);
  const savedRef = useRef(saved);
  const version = useRef(0);
  const dirtyRef = useRef(false);
  const pendingSave = useRef<Promise<SavedTrip> | null>(null);
  const session = useRef(0);
  const places = useMemo(() => [...new Map([...(draft.home ? [draft.home] : []), ...draft.departures, ...draft.arrivals, ...draft.visits.map(v => v.place)].map(p => [p.id, p])).values()], [draft]);
  const byId = useMemo(() => new Map(places.map(p => [p.id, p])), [places]);
  const placeName = (id: string) => byId.get(id)?.name ?? (id.startsWith("airport:") ? `${id.slice(8)} airport` : id);
  // Errors that keep the draft from saving (C4). They show at their fields; autosave waits until they are fixed (I6 item 7).
  const errors = useMemo(() => validateDraft(draft), [draft]);
  const invalid = Object.keys(errors).length > 0;

  function edit(value: TripDraft) {
    const validPositioning = (item: { direction: "outbound" | "return"; gateway_id: string }) =>
      item.gateway_id !== value.home?.id && (item.direction === "outbound" ? value.departures : value.arrivals).some(p => p.id === item.gateway_id);
    value = { ...value,
      positioning_policies: (value.positioning_policies ?? []).filter(validPositioning),
      positioning_services: value.home?.id === draftRef.current.home?.id ? (value.positioning_services ?? []).filter(validPositioning) : [],
    };
    draftRef.current = value; setDraft(value); version.current++; dirtyRef.current = true; setDirty(true); setSaveStatus("Unsaved changes"); setError(null);
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
  async function openTrip(id: string, { discard = false } = {}) {
    if (pendingSave.current) await pendingSave.current;
    // Reload trip drops the changes that the server refused.
    if (discard) dirtyRef.current = false;
    else if (dirtyRef.current && draftRef.current.home && draftRef.current.visits.length) await saveSpec();
    const token = ++session.current;
    version.current++;
    setLoadingTrip(true); setLoadingName(summaries.find(trip => trip.id === id)?.name ?? "");
    setError(null); setResult(null); setJob(null); setSelectedId(null); setComparisonId(null); setPanel("options");
    try {
    const record = await api<SavedTrip>(`/trips/${id}`);
    if (token !== session.current) return;
    accept(record, true); setSaveStatus("Saved");
    // Settings open for a trip that was never searched; otherwise the trip bar shows their summary.
    setSettingsOpen(!record.snapshot && !record.latest_job_id);
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
    setLoadingTrip(true); setLoadingName(`${source.spec.name} (copy)`);
    setResult(null); setJob(null); setSelectedId(null); setComparisonId(null); setPanel("options");
    try {
      const record = await api<SavedTrip>(`/trips/${source.id}/duplicate`, "POST");
      if (token !== session.current) return;
      accept(record, true);
      setResult(null); setJob(null); setSaveStatus("Copied. Change it, then search."); setSettingsOpen(true);
      await refreshList();
    } finally { if (token === session.current) setLoadingTrip(false); }
  }
  useEffect(() => {
    let active = true;
    void Promise.all([api<{ trips: SavedSummary[] }>("/trips"), api<{ rules: PricingRule[] }>("/pricing-rules"), fetch("/api/data").then(r => r.json())]).then(async ([trips, data, config]) => {
      if (!active) return;
      setSummaries(trips.trips); setRules(data.rules); setTransitConfigured(config.transit_routing_configured);
      const id = localStorage.getItem("wayfinder:last-trip");
      if (id && trips.trips.some(t => t.id === id)) await openTrip(id);
    }).catch(err => { if (active) setError(appError(err)); }).finally(() => { if (active) setInitialLoad(false); });
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
      // A refused save leaves the changes unsaved; the caller shows why.
      const record = await request.catch(err => { if (token === session.current) setSaveStatus("Not saved"); throw err; });
      if (token !== session.current) return record;
      if (stamp === version.current) { dirtyRef.current = false; setDirty(false); setSaveStatus("Saved"); }
      accept(record);
      if (stamp === version.current) {
        const optimized = await api<Result>(`/trips/${record.id}/optimize`, "POST");
        if (token === session.current && stamp === version.current) acceptResult(optimized, record.id);
      }
      await refreshList();
      return record;
    } finally { if (pendingSave.current === request) pendingSave.current = null; }
  }
  // Autosave and Retry save. A refused save keeps the changes and offers Retry save. A request that fails after
  // the save (the recalculation or the trip list) is a plain error, and the status stays "Saved".
  function autosave() {
    void saveSpec().catch(err => {
      const unsaved = dirtyRef.current;
      setError(appError(err, unsaved));
      if (unsaved) setSaveStatus("Not saved");
    });
  }
  useEffect(() => {
    if (!dirty || !saved || invalid) return;
    const timer = setTimeout(autosave, 650);
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
        setError(current => current === pollError ? null : current);
        if (status.graph_revision > (savedRef.current?.snapshot?.revision ?? -1) || !["running", "queued"].includes(status.status)) {
          const record = await api<SavedTrip>(`/trips/${job!.trip_id}`);
          if (active && token === session.current && !pendingSave.current && (!savedRef.current || record.revision >= savedRef.current.revision)) accept(record);
        }
      } catch { if (active) setError(current => current ?? pollError); }
      finally { fetching = false; }
    }
    const timer = setInterval(() => void poll(), 1000);
    void poll();
    return () => { active = false; clearInterval(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job?.id, job?.status]);

  useEffect(() => {
    if (!focusTarget) return;
    const element = (typeof focusTarget === "string" ? [focusTarget] : focusTarget).map(id => document.getElementById(id)).find(item => item !== null);
    // focus() does nothing inside a closed <details>, so open every one around the element first.
    for (let group = element?.closest("details"); group; group = group.parentElement?.closest("details")) group.open = true;
    element?.focus();
    setFocusTarget(null);
  }, [focusTarget]);
  useEffect(() => {
    if (revealRow) document.getElementById("selected-option")?.scrollIntoView({ block: "nearest" });
  }, [revealRow]);

  async function act(action: () => Promise<void>, name = "action") {
    setBusyAction(name); setError(null);
    try { await action(); }
    catch (err) { setError(appError(err)); }
    finally { setBusyAction(null); }
  }
  async function search(continuation = false) {
    await act(async () => {
      const record = await saveSpec();
      const status = await api<Job>(continuation && job ? `/searches/${job.id}/continue` : `/trips/${record.id}/searches`, "POST", { budget: batchSize });
      setJob(status);
      // The status strip follows the search, and the options update while it runs (B3, C4).
      setSettingsOpen(false);
      if (!isWide) setPanel("options");
      setFocusTarget("options-title");
    }, continuation ? "continue" : "search");
  }
  // Settings footer › Save without searching (new trip). Once saved, the trip has the workspace and its options heading.
  function saveOnly() {
    void act(async () => { await saveSpec(); setFocusTarget("options-title"); }, "save");
  }
  // Header › New trip: saves pending changes of the current trip, then starts a blank trip that is not saved.
  async function newTrip() {
    if (pendingSave.current) await pendingSave.current;
    if (dirtyRef.current && draftRef.current.home && draftRef.current.visits.length) await saveSpec();
    session.current++;
    const next = blankTrip();
    draftRef.current = next; savedRef.current = null;
    setDraft(next); setSaved(null); setResult(null); setJob(null); setSelectedId(null); setComparisonId(null); setPanel("options"); setDirty(false); dirtyRef.current = false;
    setSaveStatus("Not saved yet");
    localStorage.removeItem("wayfinder:last-trip");
    setSettingsOpen(true); setFocusTarget("home-city");
  }
  // ⋯ › Recalculate options (formerly Save & recalculate): saves pending changes, otherwise recalculates from saved data.
  function recalculate() {
    void act(async () => {
      const changed = dirtyRef.current;
      const record = await saveSpec();
      if (!changed) acceptResult(await api<Result>(`/trips/${record.id}/optimize`, "POST"), record.id);
      if (savedRef.current?.id === record.id) setSaveStatus("Options updated");
    }, "recalculate");
  }
  // Strip › Check more combinations when it can't continue the search: a higher limit on saved data, no provider requests.
  // Its strip line goes away when every combination is checked, so focus moves to the options, as when a search starts.
  function checkMore() {
    const tripId = savedRef.current?.id;
    if (!tripId) return;
    void act(async () => {
      acceptResult(await api<Result>(`/trips/${tripId}/optimize`, "POST", { expand: true }), tripId);
      if (savedRef.current?.id !== tripId) return;
      setSaveStatus("Options updated");
      if (!isWide) setPanel("options");
      setFocusTarget("options-title");
    }, "optimize");
  }
  // Error banner › Reload trip after a conflict: opens the trip again from the server and drops unsaved changes.
  function reloadTrip() {
    const tripId = savedRef.current?.id;
    if (!tripId || (dirtyRef.current && !window.confirm("Reload the trip? Your unsaved changes will be lost."))) return;
    void act(() => openTrip(tripId, { discard: true }), "open");
  }
  // Strip › Stop search. Found options and saved data stay.
  function stopSearch() {
    void act(async () => { if (job) setJob(await api<Job>(`/searches/${job.id}/cancel`, "POST")); }, "stop");
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

  // The option list in the current order (E3), with weaker options when shown. Numbers are positions in this order.
  const displayRoutes = useMemo(() => sortRoutes([...(result?.routes ?? []), ...(showDominated ? result?.dominated_routes ?? [] : [])], ranking), [result, ranking, showDominated]);
  const numbers = useMemo(() => new Map(displayRoutes.map((route, index) => [route.id, index + 1])), [displayRoutes]);
  const refinement = useMemo(() => sortRoutes(result?.refinement_routes ?? [], ranking), [result, ranking]);
  useEffect(() => {
    if (!busy && result?.dominated_routes === undefined) setShowDominated(false);
  }, [result, busy]);
  const missingFareGroups = useMemo(() => groupMissingFares(
    (result?.missing_fares ?? []).filter(fare => !fare.label.startsWith("Airport transfer ")),
    [...(result?.routes ?? []), ...(result?.dominated_routes ?? []), ...(result?.refinement_routes ?? [])],
  ), [result]);
  // Route movement id → template id. Transfer estimates give flights variant ids
  // ("{template}:transfer:{hash}") that change with every estimate edit.
  const templateOf = useMemo(() => new Map([...(result?.routes ?? []), ...(result?.dominated_routes ?? []), ...(result?.refinement_routes ?? [])]
    .flatMap(route => route.movements.map(movement => [movement.id, movement.template_id ?? movement.id] as const))), [result]);
  // Autosave (PUT /trips/{id}) returns the trip with snapshot.movements and airport_transfer_rows, but
  // without the other fields that GET adds; these helpers derive them from the snapshot.
  const assumed = useMemo(() => saved ? assumedConnections(saved) : [], [saved]);
  const gaps = useMemo(() => saved ? cityGaps(saved) : [], [saved]);
  const airportChanges = useMemo(() => saved ? airportChangeRows(saved, result?.coverage) : [], [saved, result?.coverage]);
  useEffect(() => { setVisibleCount(count => Math.max(pageSize, Math.min(count, displayRoutes.length))); }, [displayRoutes.length]);
  const selected = displayRoutes.find(r => r.id === selectedId) ?? refinement.find(r => r.id === selectedId) ?? displayRoutes[0] ?? null;
  const compare = displayRoutes.find(r => r.id === comparisonId) ?? null;
  // E8: route ids change when airport transfer prices change. When the selected or compared option is gone after a new
  // result, the option with the same signature takes its place; otherwise the selection falls back and the status says so.
  type Remembered = { id: string; signature: string; name: string } | null;
  const lastSelected = useRef<Remembered>(null), lastCompared = useRef<Remembered>(null);
  const remember = (route: Route | null): Remembered => route && {
    id: route.id, signature: routeSignature(route),
    name: numbers.has(route.id) ? `Option ${optionNumber(numbers.get(route.id)!)}` : `Over-budget option ${optionNumber(refinement.indexOf(route) + 1)}`,
  };
  useEffect(() => {
    const shown = [...displayRoutes, ...refinement];
    const lost: string[] = [];
    const follow = (id: string | null, last: Remembered, set: (id: string | null) => void) => {
      if (!id || shown.some(route => route.id === id)) return;
      const match = last?.id === id ? shown.find(route => routeSignature(route) === last.signature) : undefined;
      set(match?.id ?? null);
      if (!match && last?.id === id) lost.push(`${last.name} is no longer shown`);
    };
    follow(selectedId, lastSelected.current, setSelectedId);
    follow(comparisonId, lastCompared.current, setComparisonId);
    if (lost.length) setSaveStatus(current => [current, ...lost].join(" · "));
    // Runs when the options change; the ids are read from this render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [displayRoutes, refinement]);
  // After the effect above, so it still sees the options from before a new result.
  useEffect(() => { lastSelected.current = remember(selected); lastCompared.current = remember(compare); },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selected, compare, numbers, refinement]);
  const active = !!job && ["running", "queued"].includes(job.status);
  const allOffers = [...(saved?.snapshot?.offers ?? []), ...(saved?.offers ?? [])];
  const newestOffers = [...allOffers].reverse();
  const latestOffer = (id: string, user = false) => newestOffers.find(o => o.movement_ids.length === 1 && o.movement_ids[0] === id && (!user || o.source === "user"));
  // The offer that prices the component, in price_path's order: a user price wins over other offers, and one on
  // the template id wins over one on the variant id. Prices are saved on template ids now; older ones can sit on a variant id.
  const offerFor = (id: string) => {
    const template = templateOf.get(id) ?? id;
    return latestOffer(template, true) ?? latestOffer(id, true) ?? latestOffer(template) ?? latestOffer(id);
  };
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
      setSaveStatus("Connection removed · options updated");
    }, "connection");
  }
  const coverage = result?.coverage;
  const unresolvedAccess = unresolvedAccessJourneys(coverage?.unresolved_movements ?? []).map(movement => ({
    ...movement,
    assumptions: movement.assumptions.filter(assumption => !assumption.startsWith("Airport change ") && !assumption.startsWith("Airport connection ")),
  }));
  const extras = selected?.extra_charges ?? [];
  // The result was calculated with the saved trip's adults and exchange rates.
  const directions = useMemo(() => saved ? transferDirections(saved.airport_transfer_rows ?? [],
    [...(result?.routes ?? []), ...(result?.dominated_routes ?? []), ...(result?.refinement_routes ?? [])], saved.spec.adults, saved.spec.exchange_rates) : [], [saved, result]);
  // Missing info (C8, F2): items that need input, for the tab badge and the panel status.
  const groups = useMemo(() => splitGroups(missingFareGroups, saved?.airport_transfer_rows ?? []), [missingFareGroups, saved?.airport_transfer_rows]);
  const needs = needsInputCount({ routes: result?.routes ?? [], airportChanges, unresolvedAccess, directions, groups, gaps });
  const needsText = `${needs} ${needs === 1 ? "item needs" : "items need"} input`;
  const searched = !!saved?.snapshot || !!job;
  // "Nothing missing" needs search data: until the first search stores some, there is nothing to check yet.
  const allClear = !!saved?.snapshot && !needs;
  // The options were calculated with the saved trip's budget and exchange rates.
  const budget = saved?.spec.budget_myr ?? null;
  const rates = saved?.spec.exchange_rates ?? {};
  // Next steps (F1). "Show them" and the transit row follow the trip settings as typed.
  const nextSteps = buildNextSteps({ routes: result?.routes ?? [], airportChanges, unresolvedAccess, directions, groups, gaps, searched, budget, rates,
    excludeUnpricedFlights: !!draft.exclude_unpriced_flights, transitOff: !transitConfigured && draft.modes.some(mode => transitSearchModes.includes(mode)) });
  const emptyState = optionsEmptyState({ searched, active, pending: job?.pending ?? 0, hasResult: !!result, best: result?.routes.length ?? 0, refinement, budget,
    staySum: staySumWarning(draft), gaps, excludeUnpricedFlights: !!draft.exclude_unpriced_flights, steps: nextSteps, placeName });

  // C3.1 row 2 ("Updating options…") is for a save in progress. After a refused save nothing runs until the next
  // edit or Retry save, so the strip shows the search state; the header ("Not saved") and the banner report it (C13).
  const strip = searchState({ invalid, dirty: dirty && saveStatus !== "Not saved", saved, result, job });
  const details = searchDetails({ saved, job, result });
  // A saved trip with marked fields does not save until they are fixed. A new trip saves only with
  // Save without searching or Search transport, so its edits keep "Not saved yet" (C13).
  const status = saved && invalid ? "Fix the marked fields to save" : !saved && saveStatus === "Unsaved changes" ? "Not saved yet" : saveStatus;
  // A saved, valid trip saves itself 650 ms after an edit, so its unsaved changes are pending, not at risk.
  const statusTone = status === "Saving…" || (status === "Unsaved changes" && saved) ? "busy"
    : ["Not saved", "Not saved yet", "Unsaved changes", "Fix the marked fields to save"].includes(status) ? "warn" : "ok";
  const footer = settingsFooter({ errors, isNew: !saved, searched, active, stale: !!result?.discovery_required || job?.status === "superseded" });
  // A new trip is missing from the trip list until its first save finishes.
  const trips = saved && !summaries.some(trip => trip.id === saved.id) ? [...summaries, { id: saved.id, name: saved.spec.name, revision: saved.revision, start_date: saved.spec.start_date, end_date: saved.spec.end_date }] : summaries;
  // Trip settings are always open for a trip that is not saved.
  const settingsShown = settingsOpen || !saved;
  // A saved trip has the workspace (B3), with #options-title.
  const workspace = !!saved;
  const report = (message: string) => setError(message ? { text: message, action: null } : null);

  // The tab shown in the side panel (wide) or in the one tab bar (narrow).
  const tab: Panel = isWide && panel === "options" ? "itinerary" : panel;
  const shown: Panel[] = isWide ? ["options", tab] : [tab];
  if (workspace && shown.some(item => !visited.includes(item))) setVisited([...new Set([...visited, ...shown])]);
  // A tab shows its panel from the top. On a narrow screen the page scrolls back to the tab bar that sticks under the header.
  function chooseTab(next: Panel) {
    if (isWide) document.getElementById("side-panel")?.scrollTo({ top: 0 });
    else {
      const bar = document.getElementById("workspace-tabs")?.getBoundingClientRect().top;
      const top = document.getElementById("workspace")?.getBoundingClientRect().top;
      if (bar !== undefined && top !== undefined && top < bar) window.scrollBy({ top: top - bar });
    }
    setPanel(next);
  }
  // Selecting an option shows its itinerary (C5, E8): beside the options on a wide screen; on a narrow screen a row opens the Itinerary tab.
  function selectOption(id: string, source: "row" | "chart") {
    setSelectedId(id);
    // A chart click shows the option's row, also beyond the rows shown so far (C6, E8); focus stays on the chart.
    if (source === "chart") {
      const index = displayRoutes.findIndex(route => route.id === id);
      if (index >= visibleCount) setVisibleCount(Math.ceil((index + 1) / pageSize) * pageSize);
      setRevealRow(count => count + 1);
    }
    if (isWide) chooseTab("itinerary");
    else if (source === "row") { chooseTab("itinerary"); setFocusTarget("itinerary-title"); }
  }
  // Itinerary › "← Options" (narrow screens): back to the list, on the selected option.
  function backToOptions() {
    chooseTab("options");
    setFocusTarget(document.getElementById("selected-option") ? "selected-option" : "options-title");
  }
  // Show weaker options (E4): the first time, the saved trip is recalculated with them; it turns off again on failure.
  function toggleDominated(show: boolean) {
    if (!show) { setShowDominated(false); return; }
    if (result?.dominated_routes !== undefined) { setShowDominated(true); return; }
    setShowDominated(true);
    void act(async () => {
      try {
        const record = await saveSpec();
        const updated = await api<Result>(`/trips/${record.id}/optimize`, "POST", { include_dominated: true });
        accept(await api<SavedTrip>(`/trips/${record.id}`)); acceptResult(updated, record.id);
        setSaveStatus("Weaker options loaded");
      } catch (err) { setShowDominated(false); throw err; }
    }, "weaker");
  }
  // The buttons of Next steps and of the empty states. Missing info targets fall back to its heading while
  // their section has no such field.
  function runAction(target: OptionsTarget) {
    const showMissing = (ids: string[]) => { chooseTab("missing"); setFocusTarget([...ids, "missing-title"]); };
    if (target === "airport-changes") showMissing(["airport-change-unresolved"]);
    else if (target === "prices") {
      // Airport transfers first (F3): one price there covers every matching journey.
      const direction = directions.find(item => item.state === "missing");
      showMissing([...(direction ? [`transfer-price-${direction.from_id}>${direction.to_id}`] : []), "missing-fare-first"]);
    }
    else if (target === "exchange-rate") showMissing(["missing-fares-title"]);
    else if (target === "add-connection") showMissing(["add-connection"]);
    else if (target === "airport-fallback") { setSettingsOpen(true); setFocusTarget("setting-airport-fallback"); }
    else if (target === "edit-trip") { setSettingsOpen(true); setFocusTarget("settings-title"); }
    else if (target === "over-budget") setFocusTarget("over-budget-summary");
    else edit({ ...draft, exclude_unpriced_flights: false });
  }
  const best = result?.routes.length ?? 0;
  const optionsTab: TabItem<Panel> = { id: "options", label: "Options", ...(searched && result ? { badge: best, badgeText: `${best} best option${best === 1 ? "" : "s"}` } : {}) };
  const itineraryTab: TabItem<Panel> = { id: "itinerary", label: "Itinerary" };
  const missingTab: TabItem<Panel> = { id: "missing", label: "Missing info",
    ...(searched && needs ? { badge: needs, badgeText: needsText } : allClear ? { badge: <CircleCheck size={14} />, badgeText: "nothing missing" } : {}) };

  if (initialLoad) return <div className="optimizer"><main className="p-page-loading" aria-busy="true"><p role="status"><LoaderCircle size={18} className="p-spin" aria-hidden="true" />Opening your trips…</p></main></div>;

  return <div className="optimizer">
    <a href={workspace ? "#options-title" : "#settings-title"} className="p-skip-link" onClick={event => {
      // On a narrow screen the options can be in a hidden tab: show them first.
      if (!workspace) return;
      event.preventDefault();
      if (!isWide) setPanel("options");
      setFocusTarget("options-title");
    }}>{workspace ? "Skip to options" : "Skip to trip settings"}</a>
    <AppHeader trips={trips} currentId={saved?.id ?? null} unsaved={!saved} status={status} statusTone={statusTone} disabled={busy} menuBusy={busyAction === "recalculate" || busyAction === "copy"}
      onOpen={id => void act(() => openTrip(id), "open")} onNew={() => void act(newTrip, "new")} onCopy={() => void act(duplicateTrip, "copy")} onRecalculate={recalculate}
      canCopy={!!saved && !busy} canRecalculate={!!saved && !busy} />
    <div className="p-container">
    <ErrorBanner error={error} onDismiss={() => setError(null)} onReload={reloadTrip} onRetrySave={() => { setError(null); autosave(); }} onSearchAgain={() => void search()} />
    <main id="main" aria-busy={loadingTrip || undefined}>{loadingTrip ? <p className="p-main-loading" role="status"><LoaderCircle size={18} className="p-spin" aria-hidden="true" />Opening {loadingName || "the trip"}…</p> : <>
    <TripBar draft={draft} edit={edit} saved={saved} settingsOpen={settingsShown} onToggleSettings={() => setSettingsOpen(open => !open)}>
      {saved && <StatusStrip state={strip} details={details} busyAction={busyAction} settingsOpen={settingsShown} onStop={stopSearch} onSearch={continuation => void search(continuation)} onCheckMore={checkMore} />}
    </TripBar>
    {settingsShown && <TripSettings draft={draft} edit={edit} places={places} errors={errors} transitConfigured={transitConfigured} searchActive={active}
      partyNotice={partySizeNotice(saved, draft.adults)} isNew={!saved} footer={footer} busyAction={busyAction}
      batchSize={batchSize} onBatchSize={setBatchSize} onSearch={() => void search()} onSaveOnly={saveOnly} />}

    {saved && <div id="workspace" className="p-workspace" aria-busy={strip.id === "updating" || undefined}>
      {!isWide && <Tabs id="workspace-tabs" className="p-tabs p-tabs-bar" label="Workspace" tabs={[optionsTab, itineraryTab, missingTab]} selected={tab} onSelect={chooseTab} />}
      <section id="panel-options" className="p-panel p-options-pane" role={isWide ? undefined : "tabpanel"} aria-labelledby={isWide ? "options-title" : "tab-options"} tabIndex={isWide ? undefined : 0} hidden={!shown.includes("options")}>
        {visited.includes("options") && <OptionsPanel result={result} displayRoutes={displayRoutes} numbers={numbers} refinement={refinement}
          selectedId={selected?.id ?? null} comparedId={compare?.id ?? null}
          ranking={ranking} onRanking={value => { setRanking(value); setVisibleCount(pageSize); }}
          showDominated={showDominated} onToggleDominated={toggleDominated} loadingWeaker={busyAction === "weaker"} busy={busy}
          visibleCount={visibleCount} onShowMore={() => setVisibleCount(count => count + pageSize)} onSelect={selectOption}
          nextSteps={nextSteps} emptyState={emptyState} onAction={runAction} budget={budget} adults={saved.spec.adults} rates={rates} placeName={placeName} />}
      </section>
      <div id="side-panel" className="p-side">
        {isWide && <Tabs className="p-tabs p-tabs-side" label="Workspace" tabs={[itineraryTab, missingTab]} selected={tab} onSelect={chooseTab} />}
        <div id="panel-itinerary" className="p-side-panel" role="tabpanel" aria-labelledby="tab-itinerary" tabIndex={0} hidden={tab !== "itinerary"}>{visited.includes("itinerary") && <>
          {!isWide && searched && selected && <Button type="button" variant="ghost" size="sm" className="p-back" onClick={backToOptions}><ArrowLeft size={15} aria-hidden="true" /><span className="sr-only">Back to </span>Options</Button>}
          {selected && displayRoutes.length > 1 && <div className="p-comparison"><Field label="Compare selected itinerary with"><select value={comparisonId ?? ""} onChange={e => setComparisonId(e.target.value || null)}><option value="">Choose another alternative</option>{displayRoutes.filter(r => r.id !== selected.id).map(r => <option value={r.id} key={r.id}>{routeCost(r)} · {r.stay_hours.toFixed(1)} city hours</option>)}</select></Field>{compare && compare.id !== selected.id && <p>Selected itinerary: <strong>{(selected.stay_hours - compare.stay_hours).toFixed(1)} additional city hours</strong>{selected.total_cost_myr !== null && compare.total_cost_myr !== null && <> for <strong>{money(selected.total_cost_myr - compare.total_cost_myr)} additional cost</strong>{selected.stay_hours > compare.stay_hours && ` · ${money((selected.total_cost_myr - compare.total_cost_myr) / (selected.stay_hours - compare.stay_hours))} per additional hour`}</>}{(selected.provisional || compare.provisional) && " · resolve fare ranges to compare an exact additional cost"}.</p>}</div>}
          {!searched ? <p className="p-empty">Options appear here after a search.</p> : !selected ? <p className="p-empty">No option to show.</p> : <section className="p-panel" aria-labelledby="itinerary-title"><div className="p-panel-heading"><div><span className="p-step">05</span><h2 id="itinerary-title" tabIndex={-1}>Itinerary details</h2>{selected.budget_status === "over" && <span className="p-tag uncertain">Outside budget · fare refinement only</span>}</div><strong>{routeCost(selected)}</strong></div><div className="p-detail-layout"><div><PlannerMap places={places} route={selected} /><p className="p-hint">City reference points and schematic connections; lines do not show road or track geometry.</p></div><div className="p-timeline"><h3>Time in each required city</h3>{selected.stays.map((s, i) => <div key={`${s.place_id}:${i}`}><span className="p-timeline-dot" /><strong>{placeName(s.place_id)} <span>{s.hours.toFixed(1)} h</span></strong><small>{localTime(s.arrival, byId.get(s.place_id)?.timezone ?? "UTC")}<ArrowRight size={13} />{localTime(s.departure, byId.get(s.place_id)?.timezone ?? "UTC")}</small><progress max={selected.stay_hours || 1} value={s.hours} /></div>)}<p className="p-hint">City-stay hours include nights, exclude all transportation and terminal overhead, and do not count time at home or other positioning cities.</p></div></div>
            <div className="p-leg-details">{selected.movements.map((m, i) => <details key={`${m.id}:${i}`} open={i === 0}><summary><span className="p-leg-index">{i + 1}</span><strong>{placeName(m.from_id)} → {placeName(m.to_id)}</strong><span className="p-tag">{m.mode}{m.vehicle_kind ? ` · ${m.vehicle_kind}` : ""}</span><span>{(m.duration_minutes / 60).toFixed(1)} h</span></summary><div className="p-leg-content"><p>{localTime(m.departure, byId.get(m.from_id)?.timezone ?? "UTC", "Flexible departure")} → {localTime(m.arrival, byId.get(m.to_id)?.timezone ?? "UTC", "Flexible departure")}<br /><small>{m.source} · {m.transfers} transfers{m.distance_km !== null ? ` · ${m.distance_km.toFixed(1)} km` : ""}</small></p>{m.assumptions.map(a => <p className="p-notice" key={a}>{a}</p>)}
              {m.schedule_estimated && <p className="p-notice">Estimated rail timetable{m.schedule_reference_date ? ` · based on ${m.schedule_reference_date}` : " · provider extended calendar"}. Verify the actual travel date before booking.</p>}
              {m.segments.length > 0 && <ul className="p-segments">{m.segments.map((s, j) => <li key={j}><strong>{s.mode}: {s.from_name} → {s.to_name}</strong><small>{s.departure && `${localTime(s.departure, s.from_timezone ?? "UTC")} (${s.from_timezone ?? "UTC"}) → ${localTime(s.arrival, s.to_timezone ?? "UTC", "Flexible departure")} (${s.to_timezone ?? "UTC"}) · `}{s.service} {s.operator}{s.source ? ` · ${s.source}` : ""}{s.assumed ? " · assumed" : ""}{s.duration_minutes !== null ? ` · ${s.duration_minutes.toFixed(0)} min` : ""}</small></li>)}</ul>}
              <FareEditor componentId={m.template_id ?? m.id} label={`Standalone ${m.mode} fare`} offer={offerFor(m.id)} onSave={updatePrice} onRemove={removePrice} />{m.charges.filter(c => !c.kind.startsWith("Airport transfer ")).map(c => <FareEditor key={c.id} componentId={c.id} label={c.kind} offer={offerFor(c.id)} onSave={updatePrice} onRemove={removePrice} />)}{m.search_url && <a href={m.search_url} target="_blank" rel="noreferrer">Open flight search ↗</a>}</div></details>)}</div>
            {extras.map(c => <FareEditor key={c.id} componentId={c.id} label={c.kind} offer={offerFor(c.id)} onSave={updatePrice} onRemove={removePrice} />)}
            <h3>Ticket purchases and cost breakdown</h3><div className="p-purchases">{selected.purchases.map(o => <div key={o.id}><strong>{o.label || o.kind}<small>{o.kind} · {o.movement_ids.length} component(s) · {o.source}{o.estimated ? " estimate" : ""}</small></strong><span>{o.low === o.high ? money(o.low, o.currency) : `${money(o.low, o.currency)} – ${money(o.high, o.currency)}`}</span>{o.source === "user" && <button type="button" aria-label={`Remove fare ${o.label}`} onClick={() => void act(() => removePrice(storedOfferId(o)), "price")}>×</button>}</div>)}</div>
            <p className="p-hint">Each ticket is charged once. Combined flight tickets do not include separately listed airport transfers. Average fare per stay hour: {money(selected.cost_per_stay_hour_myr)}. Prices are quotes or assumptions, not booking guarantees.</p>
            <BundleEntry route={selected} placeName={placeName} save={updatePrice} report={report} />
          </section>}
        </>}</div>
        <div id="panel-missing" className="p-side-panel" role="tabpanel" aria-labelledby="tab-missing" tabIndex={0} hidden={tab !== "missing"}>{visited.includes("missing") && <>
          <div className="p-panel-heading"><div><h2 id="missing-title" tabIndex={-1}>Missing info</h2><InfoTip topic="Missing info">Information the search could not find.</InfoTip></div><span className="p-missing-status">{allClear && <CircleCheck size={15} aria-hidden="true" />}{searched && needs ? needsText : allClear ? "Nothing missing" : "Nothing to check yet"}</span></div>
          {!searched && <p>Unknown prices and gaps appear here after a search. You can enter airport transfers now.</p>}
          {searched && result && <AirportConnectionsTable key={`airport-connections:${saved.id}`} tripId={saved.id} rows={airportChanges} report={report} onSaved={(record, updated) => { accept(record); acceptResult(updated, record.id); setSaveStatus("Airport connections saved · frontier recalculated"); }} />}
          <AirportTransferTable key={saved.id} trip={saved} save={async estimates => {
            const record = await saveSpec();
            const updated = await api<SavedTrip>(`/trips/${record.id}/airport-transfer-estimates`, "PUT", { estimates, expected_revision: record.revision });
            accept(updated);
            if (updated.result) acceptResult(updated.result, updated.id);
            setSaveStatus("Airport transfer estimates saved");
          }} report={report} />
          {searched && result && (missingFareGroups.length > 0 || appliedSharedGroups.length > 0) && <MissingFaresTable key={`missing-fares:${saved?.id}`} storageKey={`wayfinder:pending-estimates:${saved?.id}`} groups={missingFareGroups} appliedGroups={appliedSharedGroups} placeName={placeName} templateOf={templateOf} offerFor={offerFor} onApply={applySharedFares} onSave={updatePrice} onRemove={removePrice} />}
          {searched && result && !!unresolvedAccess.length && <details className="p-panel"><summary>{unresolvedAccess.length} retrieved journeys need airport access timing</summary>{unresolvedAccess.map(m => <p key={m.id}>{placeName(m.from_id)} → {placeName(m.to_id)}: {m.assumptions.join(" · ")}</p>)}</details>}
          {searched && <section className="p-panel">{assumed.length > 0 && <div><h3>Saved assumed connections</h3>{assumed.map(m => <div className="p-actions" key={m.id}><span>{placeName(m.from_id)} → {placeName(m.to_id)} · {m.mode} · {m.duration_minutes} min{m.departure ? ` · ${localTime(m.departure, places.find(p => p.id === m.from_id)?.timezone ?? "UTC")}` : " · Flexible departure"}</span><Button type="button" size="sm" variant="secondary" disabled={busy} onClick={() => void removeAssumedConnection(m.id)}>Remove</Button></div>)}</div>}<AssumedConnection gaps={gaps} places={places} report={report} add={async m => { const record = await saveSpec(); const next = await api<Result>(`/trips/${record.id}/movements`, "POST", m); accept(await api<SavedTrip>(`/trips/${record.id}`)); acceptResult(next, record.id); setSaveStatus("Connection added · options updated"); }} /></section>}
          {searched && result && !!(coverage?.bundle_links?.length || job?.bundle_links?.length) && <section className="p-panel"><details><summary>Round-trip and multi-city quote searches</summary><p>An automatic quote is usable only when all journeys and the combined fare are verified. Otherwise open the search and enter a complete ticket price above.</p>{(job?.bundle_links ?? coverage?.bundle_links ?? []).map((b, i) => <p key={i}><a href={b.url} target="_blank" rel="noreferrer">{b.kind}: {b.legs.map(l => `${placeName(l.from_id)} → ${placeName(l.to_id)} (${l.date})`).join(" · ")} ↗</a><small> · {b.status}</small></p>)}</details></section>}
          <section className="p-panel"><RulesEditor rules={rules} places={places} changed={rulesChanged} report={report} /></section>
        </>}</div>
      </div>
    </div>}
    </>}
    <footer className="p-footer">Wayfinder Routes · Flights via fast-flights · Scheduled transit via <a href="https://transitous.org/sources/" target="_blank" rel="noreferrer">Transitous sources</a> · Road estimates via OSRM · Cities © GeoNames · Airports © airportsdata · Map © OpenStreetMap contributors</footer></main>
    </div>
  </div>;
}
