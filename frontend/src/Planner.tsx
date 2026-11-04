import { AppHeader } from "./components/AppHeader";
import { ApplyBar } from "./components/ApplyBar";
import { ItineraryPanel } from "./components/ItineraryPanel";
import { MissingInfoPanel } from "./components/MissingInfoPanel";
import { OptionsPanel } from "./components/OptionsPanel";
import { ErrorBanner } from "./components/ErrorBanner";
import { StatusStrip } from "./components/StatusStrip";
import { Tabs, type TabItem } from "./components/Tabs";
import { TripBar } from "./components/TripBar";
import { TripSettings } from "./components/TripSettings";
import { useEffect, useMemo, useRef, useState } from "react";
import { CircleCheck, LoaderCircle } from "lucide-react";
import type { AppliedSharedFareGroup } from "./components/MissingFaresTable";
import { groupMissingFares } from "./lib/missingFares";
import { activeFares, airportChangeFieldId, buildAirportConnections, buildTransferEstimates, canonicalFares, canonicalIds, countDrafts, invalidDraftFields, knownComponentIds, savedTransferRows, sameTransferRows, transferFieldId, transferKey, transferRateId, type DraftPrice, type DraftState, type DraftTarget, type PriceValue, type SharedFare } from "./lib/drafts";
import { useTripDrafts, type DraftKind } from "./lib/useTripDrafts";
import { airportChangeRows, appError, assumedConnections, buildNextSteps, cityGaps, needsInputCount, optionNumber, optionsEmptyState, partySizeNotice, purchaseAmount, routeSignature, searchDetails, searchState, settingsFooter, sortRoutes, splitGroups, staySumWarning, transferDirections, transitSearchModes, unresolvedAccessJourneys, validateDraft, type AppError, type OptionsTarget } from "./lib/present";
import { api, blankTrip, defaultBatchSize, modes, type AirportTransferMode, type Charge, type Job, type Movement, type Offer, type PricingRule, type Result, type Route, type SavedSummary, type SavedTrip, type TripDraft } from "./lib/planner";
import { useMediaQuery } from "./lib/useMediaQuery";
import "./planner.css";

const airportTransferModes: AirportTransferMode[] = modes.filter((mode): mode is AirportTransferMode => mode !== "flight");
/** A failed poll of the search status (C2). The next successful poll removes this error, so it is compared by identity. */
const pollError: AppError = { text: "Can't get the search status. Retrying…", action: null };
/** The workspace panels (C5). Wide screens always show the options, and the side panel shows "itinerary" or "missing". */
type Panel = "options" | "itinerary" | "missing";
/** Option rows shown at first, and added by each "Show more" (C6). */
const pageSize = 40;
/** Best, weaker and over-budget options of a result. */
const resultRoutes = (result: Result | null) => [...(result?.routes ?? []), ...(result?.dominated_routes ?? []), ...(result?.refinement_routes ?? [])];
/**
 * Route movement id → template id. Transfer estimates give flights variant ids ("{template}:transfer:{hash}")
 * that change with every estimate edit; prices are staged and saved on template ids.
 */
const templatesOf = (result: Result | null) => new Map(resultRoutes(result).flatMap(route => route.movements.map(movement => [movement.id, movement.template_id ?? movement.id] as const)));
/** The kinds of drafts in the order Apply sends them (F4), with their names in the Apply bar's failure text. */
const applyOrder: [DraftKind, string][] = [["airportChanges", "Airport changes"], ["transfers", "Airport transfers"], ["fares", "Prices"]];

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
  // Typed prices, airport transfers and airport changes of the open trip, kept in this browser until Apply (F4).
  const tripDrafts = useTripDrafts(saved?.id ?? null);
  // Apply bar (C9): the step that Apply runs, and why the last Apply stopped.
  const [applyState, setApplyState] = useState<{ step: number; steps: number } | null>(null);
  const [applyError, setApplyError] = useState<{ text: string; reload: boolean } | null>(null);
  const draftRef = useRef(draft);
  const savedRef = useRef(saved);
  const version = useRef(0);
  const dirtyRef = useRef(false);
  const pendingSave = useRef<Promise<SavedTrip> | null>(null);
  const session = useRef(0);
  const places = useMemo(() => [...new Map([...(draft.home ? [draft.home] : []), ...draft.departures, ...draft.arrivals, ...draft.visits.map(v => v.place)].map(p => [p.id, p])).values()], [draft]);
  const byId = useMemo(() => new Map(places.map(p => [p.id, p])), [places]);
  const placeName = (id: string) => byId.get(id)?.name ?? (id.startsWith("airport:") ? `${id.slice(8)} airport` : id);
  const zoneOf = (id: string) => byId.get(id)?.timezone ?? "UTC";
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
  /** Like act(), for a form that shows its own errors inline (C2): the error goes back to the caller. */
  async function actInline(action: () => Promise<void>, name: string) {
    setBusyAction(name); setError(null);
    try { await action(); }
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
    // Another tab can have renamed the trip: the Trip select reads the trip list.
    void act(async () => { await Promise.all([openTrip(tripId, { discard: true }), refreshList()]); }, "open");
  }
  // Strip › Stop search. Found options and saved data stay.
  function stopSearch() {
    void act(async () => { if (job) setJob(await api<Job>(`/searches/${job.id}/cancel`, "POST")); }, "stop");
  }
  async function updatePrice(offer: Offer) {
    const record = await saveSpec();
    const updated = await api<Result>(`/trips/${record.id}/fares/${encodeURIComponent(offer.id)}`, "PUT", offer);
    const next = await api<SavedTrip>(`/trips/${record.id}`);
    if (savedRef.current?.id === record.id) { accept(next); acceptResult(updated, record.id); setSaveStatus("Combined ticket saved · options updated"); }
  }
  async function applySharedFares(estimates: SharedFare[]) {
    const record = await saveSpec();
    const updated = await api<Result>(`/trips/${record.id}/fares/estimates`, "POST", { estimates, expected_revision: record.revision });
    const next = await api<SavedTrip>(`/trips/${record.id}`);
    if (savedRef.current?.id === record.id) { accept(next); acceptResult(updated, record.id); setSaveStatus("Shared estimates saved · frontier recalculated"); }
    return updated;
  }
  async function removePrice(id: string) {
    if (!savedRef.current) return;
    const tripId = savedRef.current.id;
    const updated = await api<Result>(`/trips/${tripId}/fares/${encodeURIComponent(id)}`, "DELETE");
    accept(await api<SavedTrip>(`/trips/${tripId}`)); acceptResult(updated, tripId);
    if (savedRef.current?.id === tripId) setSaveStatus("Price removed · options updated");
  }
  async function rulesChanged() {
    setRules((await api<{ rules: PricingRule[] }>("/pricing-rules")).rules);
    if (savedRef.current) { const id = savedRef.current.id; accept(await api<SavedTrip>(`/trips/${id}`)); acceptResult(await api<Result>(`/trips/${id}/optimize`, "POST"), id); }
  }
  // Missing info › Price rules (F2 row 7, F6): saved at once for all trips; the open trip recalculates.
  function saveRule(rule: PricingRule) {
    return actInline(async () => {
      await api(`/pricing-rules/${encodeURIComponent(rule.id)}`, "PUT", rule);
      await rulesChanged();
      setSaveStatus("Rule saved · options updated");
    }, "rule");
  }
  function deleteRule(rule: PricingRule) {
    return actInline(async () => {
      await api(`/pricing-rules/${encodeURIComponent(rule.id)}`, "DELETE");
      await rulesChanged();
      setSaveStatus("Rule deleted · options updated");
    }, "rule");
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
  const templateOf = useMemo(() => templatesOf(result), [result]);
  // The fare components that Apply can price (F4); drafts on other components wait under "Other drafts".
  const knownComponents = useMemo(() => knownComponentIds(saved, resultRoutes(result)), [saved, result]);
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
  }, [knownComponents, saved?.snapshot?.offers, saved?.offers]);
  // Missing info › Add a connection (F2 row 4, F6): saved at once after a trip save; the trip and its options reload.
  function addConnection(movement: Movement) {
    return actInline(async () => {
      const record = await saveSpec();
      const next = await api<Result>(`/trips/${record.id}/movements`, "POST", movement);
      const updated = await api<SavedTrip>(`/trips/${record.id}`);
      if (savedRef.current?.id !== record.id) return;
      accept(updated); acceptResult(next, record.id);
      setSaveStatus("Connection added · options updated");
    }, "connection");
  }
  async function removeAssumedConnection(movementId: string) {
    if (!saved) return;
    const tripId = saved.id;
    await act(async () => {
      const updated = await api<Result>(`/trips/${tripId}/movements/${encodeURIComponent(movementId)}?expected_revision=${saved.revision}`, "DELETE");
      accept(await api<SavedTrip>(`/trips/${tripId}`));
      acceptResult(updated, tripId);
      setSaveStatus("Connection removed · options updated");
      // The removed row held the focus.
      setFocusTarget("connections-title");
    }, "connection");
  }
  const coverage = result?.coverage;
  // Combined tickets to check: the search's links, else those of the stored result.
  const bundleLinks = job?.bundle_links?.length ? job.bundle_links : coverage?.bundle_links ?? [];
  const unresolvedAccess = unresolvedAccessJourneys(coverage?.unresolved_movements ?? []).map(movement => ({
    ...movement,
    assumptions: movement.assumptions.filter(assumption => !assumption.startsWith("Airport change ") && !assumption.startsWith("Airport connection ")),
  }));
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
    // An option is not compared with itself: the itinerary's Compare with shows None.
    if (id === comparisonId) setComparisonId(null);
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
    if (!show) { setShowDominated(false); setSaveStatus(current => current === "Weaker options loaded" ? "Saved" : current); return; }
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
    if (target === "airport-changes") {
      const first = airportChanges.find(row => row.unresolved_journey_count > 0);
      showMissing([...(first ? [airportChangeFieldId(`${first.from_airport}>${first.to_airport}`, "mode")] : []), "airport-changes-title"]);
    }
    else if (target === "prices") {
      // Airport transfers first (F3): one price there covers every matching journey.
      const direction = directions.find(item => item.state === "missing");
      showMissing([...(direction ? [transferFieldId(direction.from_id, direction.to_id, 0, "low")] : []), "missing-fare-first"]);
    }
    else if (target === "exchange-rate") {
      // The rate field of the first Journey prices row in that currency, else of the first airport transfer direction with one.
      const group = groups.journeys.find(item => item.reason === "exchange_rate");
      const direction = directions.find(item => item.rateCurrencies.length > 0);
      showMissing([...(group ? [`rate-input-${group.currency}`] : []), ...(direction ? [transferRateId(direction.from_id, direction.to_id, direction.rateCurrencies[0])] : []),
        "journey-prices-title", "airport-transfers-title"]);
    }
    else if (target === "add-connection") showMissing(["add-connection"]);
    else if (target === "transfer-times") showMissing(["airport-transfers-title"]);
    else if (target === "airport-fallback") { setSettingsOpen(true); setFocusTarget("setting-airport-fallback"); }
    else if (target === "edit-trip") { setSettingsOpen(true); setFocusTarget("settings-title"); }
    else if (target === "over-budget") setFocusTarget("over-budget-summary");
    else edit({ ...draft, exclude_unpriced_flights: false });
  }

  // Drafts (F4). Fare drafts use canonical ids; stored drafts from before template ids are mapped here.
  const fareDrafts = useMemo(() => canonicalFares(tripDrafts.drafts.fares, templateOf), [tripDrafts.drafts.fares, templateOf]);
  // Transfer drafts are kept per party size; those for the saved adults and the trip's directions apply. Others wait,
  // unseen and not counted, until the party size is the same again.
  const adults = saved?.spec.adults ?? draft.adults;
  const transferKeys = (drafts: DraftState, rows = saved?.airport_transfer_rows ?? [], count = adults) =>
    rows.map(row => transferKey(row.from_id, row.to_id, count)).filter(key => key in drafts.transfers);
  const draftCounts = countDrafts({ ...tripDrafts.drafts, fares: fareDrafts, transfers: Object.fromEntries(transferKeys(tripDrafts.drafts).map(key => [key, tripDrafts.drafts.transfers[key]])) });
  const draftTotal = draftCounts.airportChanges + draftCounts.transfers + draftCounts.prices;
  const invalidFields = (drafts: DraftState) => invalidDraftFields(drafts, directions, adults);
  const invalidCount = invalidFields(tripDrafts.drafts).length;
  /** Stages a fare draft on canonical ids (Journey prices, group prices). `saved` is the user price in use now. */
  function stagePrice(key: string, fare: SharedFare, savedPrice?: PriceValue | null) {
    tripDrafts.stageFare(key, { ...fare, component_ids: canonicalIds(fare.component_ids, templateOf), currency: fare.currency.toUpperCase() }, savedPrice);
  }
  /** Undo of one journey's price: removes the component, and stored variant ids of it, from every fare draft. */
  function unstageComponent(id: string) {
    const ids = new Set([id, ...Object.values(tripDrafts.read().fares).flatMap(fare => fare.component_ids).filter(item => (templateOf.get(item) ?? item) === id)]);
    ids.forEach(tripDrafts.unstageComponent);
  }
  /** Set price › Only this journey (E9.4): a fare draft "component:{template_id ?? id}". */
  function stageComponent(componentId: string, value: PriceValue, label: string) {
    const id = templateOf.get(componentId) ?? componentId;
    const own = offerFor(componentId);
    stagePrice(`component:${id}`, { component_ids: [id], ...value, label }, own?.source === "user" && own.low !== null ? { low: own.low, high: own.high, currency: own.currency } : null);
  }
  // The airport transfer row of an access or egress charge, and its saved ways for the saved adults.
  function transferDirection(charge: Charge) {
    if (!saved || !charge.from_id || !charge.to_id || !airportTransferModes.includes(charge.mode as AirportTransferMode)) return null;
    const row = saved.airport_transfer_rows?.find(item => item.from_id === charge.from_id && item.to_id === charge.to_id);
    if (!row) return null;
    return { row, key: transferKey(row.from_id, row.to_id, adults), saved: savedTransferRows(saved.airport_transfer_estimates ?? [], row.from_id, row.to_id, adults) };
  }
  /**
   * Set price › All {direction} transfers (E9.4): sets the price of the direction's way with the charge's mode, or adds
   * that way. A blank highest price is a fixed price for a transfer. A draft for this journey alone is removed.
   */
  function stageDirection(charge: Charge, value: PriceValue) {
    const direction = transferDirection(charge);
    if (!direction) return;
    const mode = charge.mode as AirportTransferMode;
    const base = tripDrafts.read().transfers[direction.key] ?? direction.saved;
    const price = { low: String(value.low), high: value.high === null || value.high === value.low ? "" : String(value.high), currency: value.currency.toUpperCase() };
    const rows = base.some(row => row.mode === mode) ? base.map(row => row.mode === mode ? { ...row, ...price } : row) : [...base, { mode, duration: "", ...price }];
    tripDrafts.stageTransfer(direction.key, rows, direction.saved);
    unstageComponent(charge.id);
  }
  /**
   * The draft that changes an itinerary ticket row (E9.4), in price precedence order (F5): a price for this journey,
   * else the price of its transfer direction (not when the journey has your own price), or its airport change.
   */
  function draftFor({ componentId, charge, ownPrice }: DraftTarget): DraftPrice | null {
    const pair = charge && /^Airport transfer (\S+) → (\S+)$/.exec(charge.kind);
    if (pair) {
      const key = `${pair[1]}>${pair[2]}`;
      if (!(key in tripDrafts.drafts.airportChanges)) return null;
      const change = tripDrafts.drafts.airportChanges[key];
      const fare = change?.fare.trim() ? Number(change.fare) : null;
      const value = fare !== null && Number.isFinite(fare) ? { low: fare, high: fare, currency: (change!.currency || "MYR").toUpperCase() } : null;
      return { scope: "change", value, amount: !change?.mode ? "Cleared" : value ? purchaseAmount(value, rates) : "Not priced", undo: () => tripDrafts.unstage("airportChanges", key) };
    }
    if (!componentId) return null;
    const id = templateOf.get(componentId) ?? componentId;
    const fare = Object.values(fareDrafts).find(item => item.component_ids.includes(id));
    if (fare) return { scope: "journey", value: fare, amount: purchaseAmount(fare, rates), undo: () => unstageComponent(id) };
    const direction = charge && !ownPrice ? transferDirection(charge) : null;
    const rows = direction && tripDrafts.drafts.transfers[direction.key];
    const way = rows?.find(row => row.mode === charge!.mode);
    const savedWay = direction?.saved.find(row => row.mode === charge!.mode);
    if (!direction || !rows || !way || (savedWay && sameTransferRows([way], [savedWay]))) return null;
    const low = way.low.trim() ? Number(way.low) : null;
    const high = way.high.trim() ? Number(way.high) : low;
    const value = low !== null && high !== null && Number.isFinite(low) && Number.isFinite(high) ? { low, high, currency: way.currency.toUpperCase() } : null;
    return { scope: "direction", value, amount: value ? purchaseAmount(value, rates) : low === null ? "Not priced" : `${way.low} (not valid)`,
      undo: () => tripDrafts.stageTransfer(direction.key, savedWay ? rows.map(row => row.mode === way.mode ? savedWay : row) : rows.filter(row => row !== way), direction.saved) };
  }
  // The label of the charge's airport transfer row, for Set price › All {label} transfers; null without one.
  const directionLabel = (charge: Charge) => transferDirection(charge)?.row.label ?? null;
  // The heading of the panel in view: the side panel's on a wide screen.
  const panelHeading = () => tab === "itinerary" ? "itinerary-title" : tab === "missing" ? "missing-title" : "options-title";
  // Apply bar › Fix {k} values, and an Apply with invalid drafts: the first field to fix in Missing info.
  function focusInvalid(drafts = tripDrafts.read()) {
    chooseTab("missing");
    setFocusTarget([...invalidFields(drafts).slice(0, 1), "missing-title"]);
  }
  /**
   * Apply (F4, C9): sends the drafts in the order airport changes → transfers → fares, each kind after a trip save, and
   * removes the drafts that the server took. Drafts it can't send now (transfers for another party size, fares on
   * components outside the options) stay. The first failure stops the run and keeps the drafts not sent.
   * The session token is checked after every request, so a trip opened meanwhile is never changed.
   */
  function applyDrafts() {
    const tripId = savedRef.current?.id;
    const drafts = tripDrafts.read();
    const fares = canonicalFares(drafts.fares, templateOf);
    // Only drafts that Apply can send: fare drafts on components of the current options ("Other drafts" stay).
    const sendable: Record<DraftKind, boolean> = { airportChanges: Object.keys(drafts.airportChanges).length > 0, transfers: transferKeys(drafts).length > 0,
      fares: activeFares(fares, knownComponents).length > 0 };
    const kinds = applyOrder.filter(([kind]) => sendable[kind]);
    if (!tripId || busy) return;
    if (!kinds.length) {
      // The Apply bar counts every fare draft, so it shows while only "Other drafts" are left.
      if (Object.keys(fares).length) setApplyError({ text: "No change matches the current options. Undo the drafts under Missing info › Other drafts, or change the trip back.", reload: false });
      return;
    }
    if (invalidFields(drafts).length) { focusInvalid(drafts); return; }
    // A trip with marked settings can't save, and every step saves the trip first.
    if (invalid) {
      setApplyError({ text: "Fix the marked trip settings first.", reload: false });
      setSettingsOpen(true); setFocusTarget("settings-title");
      return;
    }
    const before = result?.routes.length ?? 0;
    // Focus after Apply: the itinerary heading when Apply started there, else the panel in view (C9).
    const focus = document.activeElement?.closest("#panel-itinerary") ? "itinerary-title" : panelHeading();
    setApplyError(null);
    void act(async () => {
      const token = session.current;
      const current = () => token === session.current && savedRef.current?.id === tripId;
      let latest: Result | null = null, done = 0;
      try {
        for (const [kind] of kinds) {
          setApplyState({ step: done + 1, steps: kinds.length });
          if (kind === "airportChanges") {
            const record = await saveSpec();
            if (!current()) return;
            const connections = buildAirportConnections(record.airport_connections ?? [], drafts.airportChanges);
            const updated = await api<Result>(`/trips/${tripId}/airport-connections`, "PUT", { connections });
            if (!current()) return;
            const next = await api<SavedTrip>(`/trips/${tripId}`);
            if (!current()) return;
            accept(next); acceptResult(updated, tripId); latest = updated;
            tripDrafts.clear(kind);
          } else if (kind === "transfers") {
            const record = await saveSpec();
            if (!current()) return;
            // The drafts for the saved party size and directions; drafts for other party sizes stay.
            const sent = transferKeys(drafts, record.airport_transfer_rows ?? [], record.spec.adults);
            if (sent.length) {
              const estimates = buildTransferEstimates(record.airport_transfer_rows ?? [], record.airport_transfer_estimates ?? [], drafts.transfers, record.spec.adults);
              const updated = await api<SavedTrip>(`/trips/${tripId}/airport-transfer-estimates`, "PUT", { estimates, expected_revision: record.revision });
              if (!current()) return;
              accept(updated);
              if (updated.result) { acceptResult(updated.result, tripId); latest = updated.result; }
              sent.forEach(key => tripDrafts.unstage("transfers", key));
            }
          } else {
            // The earlier steps can change the options, so the known components come from the latest data.
            const active = activeFares(fares, knownComponentIds(savedRef.current, resultRoutes(latest ?? result)));
            if (active.length) {
              latest = await applySharedFares(active);
              if (!current()) return;
              // Only the sent components leave the drafts; drafts on other components stay under "Other drafts".
              active.flatMap(fare => fare.component_ids).forEach(unstageComponent);
            }
          }
          done++;
        }
        // Before a search there are no options to count.
        setSaveStatus(savedRef.current?.snapshot ? `Applied · ${before} → ${latest?.routes.length ?? before} best options` : "Applied");
        setFocusTarget([focus, "options-title"]);
      } catch (err) {
        if (!current()) return;
        const message = (err instanceof Error ? err.message : String(err)).replace(/\.$/, "");
        const text = kinds.map(([, name], index) => index < done ? `${name} applied.` : index === done ? `${name} not applied: ${message}.` : `${name} not applied.`).join(" ");
        setApplyError({ text, reload: (err as { status?: number }).status === 409 });
      } finally { setApplyState(null); }
    }, "apply");
  }
  // Journey prices › Add rate (F2): writes the trip's exchange rates; autosave saves and recalculates.
  function addRate(currency: string, rate: number) {
    edit({ ...draftRef.current, exchange_rates: { ...draftRef.current.exchange_rates, [currency]: rate } });
  }
  // Apply bar › Discard: removes every draft of this trip after a confirm. The bar closes, so focus goes to the panel in view.
  function discardDrafts() {
    if (!window.confirm(`Discard ${draftTotal} ${draftTotal === 1 ? "change that is" : "changes that are"} not applied?`)) return;
    tripDrafts.clear();
    setApplyError(null);
    setFocusTarget([panelHeading(), "options-title"]);
  }
  useEffect(() => { setApplyError(null); }, [saved?.id]);
  // Ctrl/Cmd+Enter applies from Missing info, an itinerary ticket row (its price editor, or its Set price button, which
  // has the focus after a price is set) or the Apply bar (F4). An editor that handles the keys itself (it stages its
  // typed price first) prevents the default.
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key !== "Enter" || !(event.ctrlKey || event.metaKey) || event.defaultPrevented) return;
      if (!(event.target as Element | null)?.closest?.("#panel-missing, .p-ticket, .p-price-editor, .p-apply-bar")) return;
      event.preventDefault();
      applyDrafts();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });
  // The Apply bar and the sticky settings footer never cover the focused element: after the browser has scrolled it into
  // view, the page scrolls on until the element is above them.
  useEffect(() => {
    function reveal(event: FocusEvent) {
      const target = event.target as HTMLElement;
      requestAnimationFrame(() => {
        if (document.activeElement !== target) return;
        const box = target.getBoundingClientRect();
        const tops = [...document.querySelectorAll<HTMLElement>(".p-apply-bar, .p-settings-footer")].filter(cover => !cover.contains(target))
          .map(cover => cover.getBoundingClientRect()).filter(cover => box.bottom > cover.top && box.top < cover.bottom).map(cover => cover.top);
        if (tops.length) window.scrollBy({ top: box.bottom - Math.min(...tops) + 8 });
      });
    }
    document.addEventListener("focusin", reveal);
    return () => document.removeEventListener("focusin", reveal);
  }, []);

  const best = result?.routes.length ?? 0;
  const optionsTab: TabItem<Panel> = { id: "options", label: "Options", ...(searched && result ? { badge: best, badgeText: `${best} best option${best === 1 ? "" : "s"}` } : {}) };
  const itineraryTab: TabItem<Panel> = { id: "itinerary", label: "Itinerary" };
  const missingTab: TabItem<Panel> = { id: "missing", label: "Missing info",
    ...(searched && needs ? { badge: needs, badgeText: needsText } : allClear ? { badge: <CircleCheck size={14} />, badgeText: "nothing missing" } : {}) };

  if (initialLoad) return <div className="optimizer"><main className="p-page-loading" aria-busy="true"><p role="status"><LoaderCircle size={18} className="p-spin" aria-hidden="true" />Opening your trips…</p></main></div>;

  // The Apply bar shows in every tab while the open trip has drafts (C9).
  const showApplyBar = !!saved && !loadingTrip && draftTotal > 0;
  return <div className="optimizer" data-drafts={showApplyBar || undefined}>
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
        <div id="panel-itinerary" className="p-side-panel" role="tabpanel" aria-labelledby="tab-itinerary" tabIndex={0} hidden={tab !== "itinerary"}>{visited.includes("itinerary") &&
          <ItineraryPanel isWide={isWide} searched={searched} route={selected} displayRoutes={displayRoutes} numbers={numbers} refinement={refinement}
            weaker={showDominated && !!selected && !!result?.dominated_routes?.some(route => route.id === selected.id)}
            comparedId={compare?.id ?? null} onCompare={setComparisonId} places={places} zoneOf={zoneOf} placeName={placeName}
            minStays={Object.fromEntries(saved.spec.visits.map(visit => [visit.place.id, visit.min_stay_hours]))}
            budget={budget} adults={saved.spec.adults} rates={rates} offerFor={offerFor} onSaveBundle={updatePrice}
            draftFor={draftFor} directionLabel={directionLabel} stageComponent={stageComponent} stageDirection={stageDirection}
            applying={!!applyState} onApply={applyDrafts}
            onRemovePrice={id => void act(() => removePrice(id), "price")} busy={busy} bundleLinks={bundleLinks}
            onAction={runAction} onEditAirportChange={key => { chooseTab("missing"); setFocusTarget([airportChangeFieldId(key, "mode"), "missing-title"]); }} onBack={backToOptions} />}</div>
        <div id="panel-missing" className="p-side-panel" role="tabpanel" aria-labelledby="tab-missing" tabIndex={0} hidden={tab !== "missing"} inert={!!applyState}>{visited.includes("missing") &&
          <MissingInfoPanel searched={searched} allClear={allClear} needs={needs} needsText={needsText} airportChanges={airportChanges} connections={saved.airport_connections ?? []}
            directions={directions} estimates={saved.airport_transfer_estimates ?? []} accessNote={nextSteps.find(step => step.id === "access-time")?.text ?? null}
            journeyGroups={groups.journeys} appliedGroups={appliedSharedGroups} adults={adults} rates={rates} draftRates={draft.exchange_rates}
            drafts={tripDrafts} fares={fareDrafts} canonical={id => templateOf.get(id) ?? id} offerFor={offerFor} places={places} placeName={placeName} zoneOf={zoneOf}
            stagePrice={stagePrice} stageComponent={stageComponent} removePrice={id => void act(() => removePrice(id), "price")} addRate={addRate}
            gaps={gaps} assumed={assumed} addConnection={addConnection} removeConnection={id => void removeAssumedConnection(id)} bundleLinks={bundleLinks}
            rules={rules} saveRule={saveRule} deleteRule={deleteRule} busy={busy} onAction={runAction} onApply={applyDrafts} />}</div>
      </div>
    </div>}
    </>}
    <footer className="p-footer">Wayfinder Routes · Flights via fast-flights · Scheduled transit via <a href="https://transitous.org/sources/" target="_blank" rel="noreferrer">Transitous sources</a> · Road estimates via OSRM · Cities © GeoNames · Airports © airportsdata · Map © OpenStreetMap contributors</footer></main>
    </div>
    {showApplyBar && <ApplyBar counts={draftCounts} invalid={invalidCount} applying={applyState} error={applyError} busy={busy}
      onApply={applyDrafts} onDiscard={discardDrafts} onReload={() => { setApplyError(null); reloadTrip(); }} onFocusInvalid={() => focusInvalid()} />}
  </div>;
}
