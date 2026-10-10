import { useEffect, useMemo, useState } from "react";
import {
  ArrowDownUp,
  ArrowRight,
  ArrowUpRight,
  CalendarDays,
  Check,
  CircleHelp,
  Compass,
  ExternalLink,
  LoaderCircle,
  MapPinned,
  Plane,
  RefreshCw,
  Settings2,
  Route,
} from "lucide-react";
import { RouteMap } from "./components/RouteMap";
import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "./components/ui/card";
import type { ImportedFlight, InputFileStatus, PlannerData, TransportSettings, RouteFilters, RouteResult, RoutesResponse } from "./lib/types";
import { dateLabel, money, shortMoney } from "./lib/utils";

type Preference = "cheapest" | "shortest" | "balanced";

const preferenceOptions: { id: Preference; label: string; icon: typeof ArrowDownUp }[] = [
  { id: "cheapest", label: "Lowest cost", icon: ArrowDownUp },
  { id: "shortest", label: "Shortest transport", icon: Route },
  { id: "balanced", label: "Balanced", icon: Compass },
];

function Field({ label, suffix, value, onChange, min, max, step = 1 }: {
  label: string;
  suffix?: string;
  value: number;
  onChange: (value: number) => void;
  min: number;
  max: number;
  step?: number;
}) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  const commit = () => {
    if (draft.trim() === "") {
      setDraft(String(value));
      return;
    }
    const parsed = Number(draft);
    if (!Number.isFinite(parsed)) {
      setDraft(String(value));
      return;
    }
    const normalized = Math.max(min, Math.min(max, parsed));
    setDraft(String(normalized));
    onChange(normalized);
  };
  return (
    <label className="field-wrap">
      <span className="field-label">{label}</span>
      <span className="number-field">
        <input
          type="number"
          min={min}
          max={max}
          step={step}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
        />
        {suffix && <span>{suffix}</span>}
      </span>
    </label>
  );
}

function FilterField({ label, suffix, value, onChange, min, max, step = 1 }: {
  label: string;
  suffix: string;
  value: number | null;
  onChange: (value: number | null) => void;
  min: number;
  max: number;
  step?: number;
}) {
  const [draft, setDraft] = useState(value == null ? "" : String(value));
  useEffect(() => setDraft(value == null ? "" : String(value)), [value]);
  const commit = () => {
    if (draft.trim() === "") {
      onChange(null);
      return;
    }
    const parsed = Number(draft);
    if (!Number.isFinite(parsed)) {
      setDraft(value == null ? "" : String(value));
      return;
    }
    const normalized = Math.max(min, Math.min(max, parsed));
    setDraft(String(normalized));
    onChange(normalized);
  };
  return (
    <label className="field-wrap">
      <span className="field-label">{label}</span>
      <span className="number-field">
        <input
          type="number"
          min={min}
          max={max}
          step={step}
          placeholder="Any"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
        />
        <span>{suffix}</span>
      </span>
    </label>
  );
}

function RouteDetail({ route, preference, originName }: { route: RouteResult; preference: Preference; originName: string }) {
  const saving = route.savings_myr;
  return (
    <div className="route-detail">
      <div className="detail-heading">
        <div>
          <div className="eyebrow">Selected itinerary</div>
          <h3>{route.arrival_city.name}<ArrowRight size={17} />{route.departure_city.name}</h3>
        </div>
        <div className="detail-total">
          <span>Total estimated cost</span>
          <strong>{money(route.total_cost_myr)}</strong>
        </div>
      </div>
      <div className="breakdown-grid">
        <div className="breakdown-item"><Plane size={16} /><span>Flights</span><strong>{money(route.flight_cost_myr)}</strong></div>
        <div className="breakdown-item"><Route size={16} /><span>Estimated transport</span><strong>{money(route.estimated_transport_cost_myr)}</strong></div>
        <div className="breakdown-item"><MapPinned size={16} /><span>Transport distance</span><strong>{route.estimated_transport_distance_km.toLocaleString("en-MY", { maximumFractionDigits: 0 })} km</strong></div>
        <div className="breakdown-item"><CircleHelp size={16} /><span>Transport time</span><strong>{route.estimated_transport_time_hours.toFixed(1)} h</strong></div>
      </div>
      <div className="detail-footer">
        <span className={saving != null && saving >= 0 ? "saving positive" : "saving negative"}>
          {saving == null ? "Same-city comparison unavailable" : saving >= 0 ? `${money(saving)} below same-city flights` : `${money(Math.abs(saving))} above same-city flights`}
        </span>
        <span className="baseline-note">Compared with {originName} ↔ {route.arrival_city.name}{route.same_city_baseline_myr == null ? "" : ` (${money(route.same_city_baseline_myr)})`}</span>
        <div className="booking-links">
          <a href={route.outbound_booking_url} target="_blank" rel="noopener noreferrer">Outbound search <ExternalLink size={13} /></a>
          <a href={route.return_booking_url} target="_blank" rel="noopener noreferrer">Return search <ExternalLink size={13} /></a>
        </div>
      </div>
      <p className="detail-disclaimer">
        {route.distance_source === "osrm_road"
          ? "Distance basis: OSRM road route."
          : route.distance_source === "assumed_connection"
            ? "Distance basis: direct-distance proxy because OSRM had no road route; a connection is assumed."
            : "Same-city route; no ground-transport leg."} Ground-transport time and cost use your speed and fare assumptions and do not confirm a real service.
      </p>
      {preference === "balanced" && route.balanced_score != null && (
        <div className="balance-note">Balanced score {Math.round(route.balanced_score * 100)} / 100 · cost and transport time weighted equally</div>
      )}
    </div>
  );
}

function ImportedSnapshots({ flights, files }: { flights: ImportedFlight[]; files: InputFileStatus[] }) {
  const skippedCount = files.filter((file) => file.status !== "loaded").length;
  return (
    <section className="results-section imported-section">
      <div className="results-heading">
        <div>
          <div className="section-kicker">INPUT FILES</div>
          <h2>Parsed flight snapshots <span>{flights.length} results</span></h2>
          <p>All supported files are scanned by content. Origins found in their routes can be selected as the trip start; the optimizer combines one-way fares and keeps round-trip snapshots listed here.</p>
        </div>
      </div>
      <Card className="table-card">
        <div className="table-scroll">
          <table>
            <thead>
              <tr><th>File</th><th>Route</th><th>Travel date</th><th>Trip</th><th>Fare</th><th>Stops</th><th>Search</th></tr>
            </thead>
            <tbody>
              {flights.map((flight, index) => (
                <tr key={[flight.source_file, flight.origin_code, flight.destination_code, flight.departure_date, index].join("-")}>
                  <td>{flight.source_file}</td>
                  <td>{flight.origin_name} ({flight.origin_code.toUpperCase()}) <ArrowRight size={13} /> {flight.destination_name} ({flight.destination_code.toUpperCase()})</td>
                  <td>{dateLabel(flight.departure_date)}{flight.return_date ? " → " + dateLabel(flight.return_date) : ""}</td>
                  <td>{flight.journey_type === "round_trip" ? "Round trip" : "One way"}</td>
                  <td className="numeric-cell">{money(flight.price_myr)}</td>
                  <td>{flight.direct == null ? "Not shown" : flight.direct ? "Direct" : "Non-direct" + (flight.stops_label ? " · " + flight.stops_label : "")}</td>
                  <td><a href={flight.booking_url} target="_blank" rel="noopener noreferrer">Open <ExternalLink size={12} /></a></td>
                </tr>
              ))}
              {flights.length === 0 && <tr><td colSpan={7} className="empty-table">No supported Skyscanner result links were parsed.</td></tr>}
            </tbody>
          </table>
        </div>
        <div className="table-footer">
          <span><i className="footer-dot" />Scanned {files.length} input file(s)</span>
          <span>{skippedCount} skipped or failed · prices and stop details remain blank when absent</span>
        </div>
      </Card>
      <div className="input-file-statuses">
        {files.map((file) => (
          <span key={file.source_file} className={file.status === "loaded" ? "input-status loaded" : "input-status skipped"}>
            <strong>{file.source_file}</strong> · {file.status} · {file.parsed_count} result(s){file.reason ? " · " + file.reason : ""}
          </span>
        ))}
      </div>
    </section>
  );
}

function App() {
  const [data, setData] = useState<PlannerData | null>(null);
  const [dataError, setDataError] = useState<string | null>(null);
  const [settings, setSettings] = useState<TransportSettings>({
    average_speed_kmh: 200,
    distance_factor: 1,
    fare_myr_per_km: 0.27,
    connection_overhead_minutes: 30,
  });
  const [filters, setFilters] = useState<RouteFilters>({
    max_transport_hours: null,
    max_budget_myr: null,
    arrival_cities: [],
    departure_cities: [],
  });
  const [preference, setPreference] = useState<Preference>("cheapest");
  const [routeData, setRouteData] = useState<RoutesResponse | null>(null);
  const [routesLoading, setRoutesLoading] = useState(false);
  const [routesError, setRoutesError] = useState<string | null>(null);
  const [selectedRouteId, setSelectedRouteId] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/data", { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Flight data could not be loaded (${response.status}).`);
        return (await response.json()) as PlannerData;
      })
      .then((payload) => {
        setData(payload);
        setSettings(payload.defaults);
        setDataError(null);
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setDataError(error instanceof Error ? error.message : "The local API could not be reached.");
      });
    return () => controller.abort();
  }, []);

  const selectOrigin = async (originCode: string) => {
    setData(null);
    setDataError(null);
    setRouteData(null);
    setSelectedRouteId(null);
    setFilters((current) => ({ ...current, arrival_cities: [], departure_cities: [] }));
    try {
      const response = await fetch(`/api/data?origin_code=${encodeURIComponent(originCode)}`);
      if (!response.ok) throw new Error(`Flight data could not be loaded (${response.status}).`);
      setData((await response.json()) as PlannerData);
    } catch (error) {
      setDataError(error instanceof Error ? error.message : "The local API could not be reached.");
    }
  };

  useEffect(() => {
    if (!data) return;
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setRoutesLoading(true);
      setRoutesError(null);
      try {
        const response = await fetch("/api/routes", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ origin_code: data.origin?.code, settings, filters, preference }),
          signal: controller.signal,
        });
        if (!response.ok) {
          const message = await response.text();
          throw new Error(message || `Route calculation failed (${response.status}).`);
        }
        const payload = (await response.json()) as RoutesResponse;
        setRouteData(payload);
        setSelectedRouteId((current) => payload.routes.some((route) => route.id === current) ? current : payload.routes[0]?.id ?? null);
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setRoutesError(error instanceof Error ? error.message : "Route calculation failed.");
        setRouteData(null);
      } finally {
        if (!controller.signal.aborted) setRoutesLoading(false);
      }
    }, 220);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [data, filters, preference, settings]);

  const selectedRoute = useMemo(
    () => routeData?.routes.find((route) => route.id === selectedRouteId) ?? null,
    [routeData, selectedRouteId],
  );

  const updateSetting = <K extends keyof TransportSettings>(key: K, value: TransportSettings[K]) => {
    setSettings((current) => ({ ...current, [key]: value }));
  };

  const updateFilter = <K extends keyof RouteFilters>(key: K, value: RouteFilters[K]) => {
    setFilters((current) => ({ ...current, [key]: value }));
  };

  const chooseCity = (code: string, kind: "arrival" | "departure") => {
    if (kind === "arrival") updateFilter("arrival_cities", [code]);
    else updateFilter("departure_cities", [code]);
  };

  if (!data) {
    return (
      <main className="loading-shell">
        <div className="loading-card">
          {dataError ? <div className="error-icon">!</div> : <LoaderCircle className="spin" size={26} />}
          <h1>{dataError ? "Local planner API not connected" : "Loading your flight snapshots"}</h1>
          <p>{dataError ?? "Reading the saved Skyscanner results and city coordinates."}</p>
          {dataError && <code>uvicorn app.main:app --reload --app-dir backend</code>}
        </div>
      </main>
    );
  }

  const routeCount = routeData?.routes.length ?? 0;
  const cityLabel = (code: string) => data.cities.find((city) => city.code === code)?.name ?? "All cities";

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-lockup">
          <div className="brand-icon"><Compass size={21} strokeWidth={2.1} /></div>
          <div>
            <div className="brand-title">Wayfinder <span>Routes</span></div>
            <div className="brand-caption">Flight + ground transport planner</div>
          </div>
        </div>
        <div className="trip-snapshot">
          <label className="origin-picker">
            <span>Start city</span>
            <select
              aria-label="Trip origin"
              value={data.origin?.code ?? ""}
              disabled={data.origins.length === 0}
              onChange={(event) => void selectOrigin(event.target.value)}
            >
              {data.origins.length === 0 && <option value="">No loaded origins</option>}
              {data.origins.map((origin) => <option key={origin.code} value={origin.code}>{origin.name} ({origin.code.toUpperCase()})</option>)}
            </select>
          </label>
          <span><CalendarDays size={15} /> {dateLabel(data.snapshot_dates.outbound)}</span>
          <ArrowRight size={14} className="snapshot-arrow" />
          <span>{dateLabel(data.snapshot_dates.return)}</span>
          <Badge className="snapshot-badge">Saved prices</Badge>
        </div>
      </header>

      <section className="intro-row">
        <div>
          <div className="eyebrow">{data.origin?.name.toUpperCase() ?? "LOADED ORIGIN"} <ArrowRight size={12} /> DESTINATIONS <ArrowRight size={12} /> {data.origin?.name.toUpperCase() ?? "LOADED ORIGIN"}</div>
          <h1>Find a better way across your trip.</h1>
          <p>Pair saved flight fares with a configurable ground-transport estimate.</p>
        </div>
        <div className="intro-stats">
          <div><strong>{data.summary.city_count}</strong><span>cities found</span></div>
          <div><strong>{data.summary.priced_outbound_listings + data.summary.priced_return_listings}</strong><span>priced flights</span></div>
          <div><strong>{routeCount || "—"}</strong><span>routes in view</span></div>
        </div>
      </section>

      <div className="snapshot-note">
        <span className="note-dot" />
        Fares are saved Skyscanner snapshots, not live quotes. Ground-transport costs and times are estimates only.
        {routesLoading && <span className="calculating"><LoaderCircle size={13} className="spin" /> Recalculating</span>}
      </div>
      {data.coordinate_resolution.unresolved_cities.length > 0 && (
        <div className="inline-alert warning-alert import-scope-alert">
          Coordinates were not found for {data.coordinate_resolution.unresolved_cities.map((city) => city.name).join(", ")}. {data.coordinate_resolution.dataset_available ? "Add these places to the local coordinate cache to include them." : "Install GeoNames city data with `python backend/app/geonames.py --download`, then restart the API."}
        </div>
      )}

      <section className="workspace-grid">
        <Card className="map-card">
          <div className="map-card-head">
            <div>
              <div className="section-kicker">ROUTE OVERVIEW</div>
              <h2>Destinations at a glance</h2>
            </div>
            <div className="map-legends">
              <span><i className="legend-line flight-line" /> Flight</span>
              <span><i className="legend-line transport-line" /> Estimated transport</span>
            </div>
          </div>
          <div className="map-frame">
            <RouteMap data={data} route={selectedRoute} onChooseCity={chooseCity} />
            <div className="map-price-legend">
              <span>Lowest flight fare</span>
              <i style={{ background: "#167e78" }} />
              <i style={{ background: "#47977c" }} />
              <i style={{ background: "#d08b43" }} />
              <i style={{ background: "#b65d50" }} />
              <span>Higher</span>
            </div>
          </div>
          <div className="map-footnote">
            <span><MapPinned size={14} /> City-center markers</span>
            <span>Click a city to set arrival or departure</span>
          </div>
        </Card>

        <Card className="settings-card">
          <CardHeader className="settings-header">
            <div className="settings-title-row">
              <div className="settings-icon"><Settings2 size={17} /></div>
              <div><CardTitle>Trip settings</CardTitle><p>Adjust the estimates and narrow your options.</p></div>
            </div>
          </CardHeader>
          <CardContent className="settings-content">
            <div className="settings-section">
              <div className="settings-section-title">Ground-transport estimate <span>Editable assumptions</span></div>
              <div className="field-grid">
                <Field label="Average speed" suffix="km/h" value={settings.average_speed_kmh} min={1} max={500} step={10} onChange={(value) => updateSetting("average_speed_kmh", value)} />
                <Field label="Distance factor" suffix="×" value={settings.distance_factor} min={0.1} max={5} step={0.05} onChange={(value) => updateSetting("distance_factor", value)} />
                <Field label="Estimated fare per km" suffix="MYR" value={settings.fare_myr_per_km} min={0} max={100} step={0.01} onChange={(value) => updateSetting("fare_myr_per_km", value)} />
                <Field label="Connection overhead" suffix="min" value={settings.connection_overhead_minutes} min={0} max={360} step={5} onChange={(value) => updateSetting("connection_overhead_minutes", value)} />
              </div>
            </div>

            <div className="settings-divider" />
            <div className="settings-section">
              <div className="settings-section-title">Your limits <span>Optional</span></div>
              <div className="field-grid">
                <FilterField label="Max transport time" suffix="hours" value={filters.max_transport_hours} min={0.1} max={100} step={0.5} onChange={(value) => updateFilter("max_transport_hours", value)} />
                <FilterField label="Max total budget" suffix="MYR" value={filters.max_budget_myr} min={1} max={100000} step={50} onChange={(value) => updateFilter("max_budget_myr", value)} />
              </div>
              <div className="field-grid city-filter-grid">
                <label className="field-wrap">
                  <span className="field-label">Arrive in</span>
                  <select value={filters.arrival_cities[0] ?? ""} onChange={(event) => updateFilter("arrival_cities", event.target.value ? [event.target.value] : [])}>
                    <option value="">Any city</option>
                    {data.cities.filter((city) => city.outbound?.price_myr != null).map((city) => <option key={city.code} value={city.code}>{city.name}</option>)}
                  </select>
                </label>
                <label className="field-wrap">
                  <span className="field-label">Fly home from</span>
                  <select value={filters.departure_cities[0] ?? ""} onChange={(event) => updateFilter("departure_cities", event.target.value ? [event.target.value] : [])}>
                    <option value="">Any city</option>
                    {data.cities.filter((city) => city.return_flight?.price_myr != null).map((city) => <option key={city.code} value={city.code}>{city.name}</option>)}
                  </select>
                </label>
              </div>
            </div>

            <div className="settings-divider" />
            <div className="settings-section">
              <div className="settings-section-title">Rank routes <span>Sort by</span></div>
              <div className="preference-group" role="group" aria-label="Optimization preference">
                {preferenceOptions.map(({ id, label, icon: Icon }) => (
                  <Button key={id} variant={preference === id ? "default" : "secondary"} size="sm" className="preference-button" onClick={() => setPreference(id)}>
                    <Icon size={14} />{label}
                  </Button>
                ))}
              </div>
              {preference === "balanced" && <p className="balance-hint"><Check size={13} /> Equal weighting for normalized cost and transport time.</p>}
            </div>

            <div className="settings-footnote">
              <Route size={15} />
              <span>Transport estimates use OSRM roads or a labeled direct-distance proxy when OSRM has no route. Connections remain hypothetical.</span>
            </div>
          </CardContent>
        </Card>
      </section>

      <section className="results-section">
        <div className="results-heading">
          <div>
            <div className="section-kicker">FLIGHT + TRANSPORT COMBINATIONS</div>
            <h2>Compare your routes <span>{routeCount} options</span></h2>
          <p>{filters.arrival_cities.length ? `Arriving in ${cityLabel(filters.arrival_cities[0])}` : "Any arrival"} · {filters.departure_cities.length ? `flying home from ${cityLabel(filters.departure_cities[0])}` : "any departure"} · {preference === "balanced" ? "balanced ranking uses 50/50 cost and transport time" : preference === "shortest" ? "ranked by estimated transport time" : "ranked by estimated total cost"}</p>
          </div>
          <Button variant="secondary" className="refresh-button" disabled={routesLoading} onClick={() => {
            setSettings((current) => ({ ...current }));
          }}>
            {routesLoading ? <LoaderCircle size={15} className="spin" /> : <RefreshCw size={15} />} Refresh results
          </Button>
        </div>

        {routesError && <div className="inline-alert error-alert">{routesError}</div>}
        {routeData?.routing_message && (
          <div className={`inline-alert ${routeData.routing_status === "ready" ? "" : "warning-alert"}`}>
            <CircleHelp size={15} /> {routeData.routing_message}
          </div>
        )}

        <Card className="table-card">
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>#</th><th>Arrive</th><th>Fly home</th><th>Flights</th><th>Est. transport</th><th>Total</th><th>Transport time</th><th aria-label="Select route" />
                </tr>
              </thead>
              <tbody>
                {routeData?.routes.map((route) => (
                  <tr key={route.id} className={route.id === selectedRouteId ? "selected-row" : ""} onClick={() => setSelectedRouteId(route.id)} tabIndex={0} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") setSelectedRouteId(route.id); }}>
                    <td className="rank-cell">{route.rank.toString().padStart(2, "0")}</td>
                    <td><span className="city-cell"><span className="city-dot arrival-dot" />{route.arrival_city.name}</span></td>
                    <td><span className="city-cell"><span className="city-dot departure-dot" />{route.departure_city.name}{route.is_same_city && <Badge className="same-city-badge">Same city</Badge>}</span></td>
                    <td className="numeric-cell">{shortMoney(route.flight_cost_myr)}</td>
                    <td className="numeric-cell">{shortMoney(route.estimated_transport_cost_myr)}</td>
                    <td className="total-cell">{shortMoney(route.total_cost_myr)}</td>
                    <td className="numeric-cell">{route.estimated_transport_time_hours.toFixed(1)} h</td>
                    <td><button className="row-arrow" aria-label={`Select route ${route.arrival_city.name} to ${route.departure_city.name}`}><ArrowUpRight size={16} /></button></td>
                  </tr>
                ))}
                {routesLoading && !routeData && <tr><td colSpan={8} className="empty-table"><LoaderCircle size={18} className="spin" /> Checking OSRM distances and ranking options…</td></tr>}
                {routeData && routeData.routes.length === 0 && <tr><td colSpan={8} className="empty-table">{routeData.candidate_count === 0 ? `No saved one-way fares are available both from and back to ${data.origin?.name ?? "this origin"}. Add matching flight snapshots under data/inputs.` : routeData.unavailable_pair_count ? "No road-distance estimates are available for these city pairs from OSRM." : "No routes match these limits. Clear a filter or increase your budget or maximum transport time."}</td></tr>}
                {!routeData && !routesLoading && routesError && <tr><td colSpan={8} className="empty-table">Route calculations could not be loaded.</td></tr>}
              </tbody>
            </table>
          </div>
          <div className="table-footer">
            <span><i className="footer-dot" />Showing {routeCount} of up to {routeData?.candidate_count ?? 0} priced flight pairings</span>
            <span>Snapshot fares · estimates in MYR</span>
          </div>
        </Card>

        {selectedRoute && <Card className="detail-card"><RouteDetail route={selectedRoute} preference={preference} originName={data.origin?.name ?? "selected origin"} /></Card>}
      </section>

      {data.input_files.length > 0 && <ImportedSnapshots flights={data.imported_flights} files={data.input_files} />}

      <footer className="page-footer">
        <span>Wayfinder Routes · Local trip planner</span>
        <span><span className="footer-separator">·</span> City data © GeoNames · Map tiles © OpenStreetMap contributors</span>
        <span className="footer-disclaimer">Ground-transport estimates are not confirmed services or connections.</span>
      </footer>
    </main>
  );
}

export default App;
