import { useEffect, useMemo, useState, type FormEvent } from "react";
import {
  ArrowDownUp,
  ArrowRight,
  CalendarDays,
  Check,
  CircleHelp,
  Compass,
  ExternalLink,
  LoaderCircle,
  MapPinned,
  Plane,
  Plus,
  Route,
  Settings2,
  Trash2,
} from "lucide-react";
import { RouteMap } from "./components/RouteMap";
import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "./components/ui/card";
import type { AppConfig, Preference, TripCity, TripPlanResponse, TripRoute, TransportSettings } from "./lib/types";

const fallbackSettings: TransportSettings = {
  average_speed_kmh: 80,
  fare_myr_per_km: 0.27,
  ground_overhead_minutes: 30,
  flight_airport_buffer_minutes: 90,
};

function localDateString(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function addDays(value: string, count: number) {
  const date = new Date(`${value}T12:00:00`);
  date.setDate(date.getDate() + count);
  return localDateString(date);
}

function formatDate(value: string) {
  return new Date(`${value}T12:00:00`).toLocaleDateString("en-MY", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

function money(value: number) {
  return new Intl.NumberFormat("en-MY", { style: "currency", currency: "MYR", maximumFractionDigits: 0 }).format(value);
}

function estimateSearchCount(destinationCount: number, returnToOrigin: boolean) {
  if (destinationCount < 1) return 0;
  if (destinationCount === 1) return destinationCount + Number(returnToOrigin);
  const boundarySearches = destinationCount * (returnToOrigin ? 2 : 1);
  return boundarySearches + (destinationCount - 1) * destinationCount * (destinationCount - 1);
}

function CityPicker({
  label,
  placeholder,
  disabledCodes,
  onSelect,
  disabled,
}: {
  label: string;
  placeholder: string;
  disabledCodes: string[];
  onSelect: (city: TripCity) => void;
  disabled?: boolean;
}) {
  const [query, setQuery] = useState("");
  const [suggestions, setSuggestions] = useState<TripCity[]>([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const disabledKey = disabledCodes.join("|");

  useEffect(() => {
    const search = query.trim();
    if (search.length < 2) {
      setSuggestions([]);
      setLoading(false);
      setError(null);
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      setLoading(true);
      setError(null);
      try {
        const response = await fetch(`/api/cities?search=${encodeURIComponent(search)}`, { signal: controller.signal });
        const payload = await response.json() as { cities?: TripCity[]; detail?: string };
        if (!response.ok) throw new Error(payload.detail ?? `City search failed (${response.status}).`);
        setSuggestions((payload.cities ?? []).filter((city) => !disabledKey.split("|").includes(city.code)));
        setOpen(true);
      } catch (searchError) {
        if (searchError instanceof DOMException && searchError.name === "AbortError") return;
        setError(searchError instanceof Error ? searchError.message : "City search failed.");
        setSuggestions([]);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }, 180);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [disabledKey, query]);

  return (
    <div className="city-picker">
      <label className="field-label" htmlFor={`city-${label.replaceAll(" ", "-").toLowerCase()}`}>{label}</label>
      <div className="city-picker-input-wrap">
        <input
          id={`city-${label.replaceAll(" ", "-").toLowerCase()}`}
          value={query}
          disabled={disabled}
          placeholder={placeholder}
          autoComplete="off"
          aria-autocomplete="list"
          aria-expanded={open && suggestions.length > 0}
          onChange={(event) => { setQuery(event.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onBlur={() => window.setTimeout(() => setOpen(false), 140)}
        />
        {loading && <LoaderCircle className="picker-spinner spin" size={15} />}
        {open && suggestions.length > 0 && (
          <div className="city-suggestions" role="listbox">
            {suggestions.map((city) => (
              <button
                type="button"
                role="option"
                key={city.code}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => { onSelect(city); setQuery(""); setSuggestions([]); setOpen(false); }}
              >
                <span><strong>{city.name}</strong><small>{city.country_code} · {city.flight_code}</small></span>
                <span className="airport-count">{city.airport_codes?.length ?? 1} airport{(city.airport_codes?.length ?? 1) === 1 ? "" : "s"}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      {error && <span className="picker-error">{error}</span>}
      {!error && query.trim().length === 1 && <span className="picker-hint">Type at least 2 characters.</span>}
    </div>
  );
}

function CityChip({ city, remove }: { city: TripCity; remove: () => void }) {
  return (
    <span className="city-chip">
      <span className="chip-dot" />
      <strong>{city.name}</strong><small>{city.country_code} · {city.flight_code}</small>
      <button type="button" onClick={remove} aria-label={`Remove ${city.name}`}><Trash2 size={13} /></button>
    </span>
  );
}

function SettingField({ label, suffix, value, min, max, step, onChange }: {
  label: string;
  suffix: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="setting-field">
      <span>{label}</span>
      <span className="setting-number">
        <input type="number" min={min} max={max} step={step} value={value} onChange={(event) => {
          const parsed = Number(event.target.value);
          if (Number.isFinite(parsed)) onChange(Math.max(min, Math.min(max, parsed)));
        }} />
        <small>{suffix}</small>
      </span>
    </label>
  );
}

function RouteSummary({ route, selected, onClick }: { route: TripRoute; selected: boolean; onClick: () => void }) {
  const routeLabel = route.stops.map((city) => city.name).join(" → ");
  return (
    <button type="button" className={`route-option ${selected ? "active" : ""}`} onClick={onClick}>
      <span className="route-rank">{String(route.rank).padStart(2, "0")}</span>
      <span className="route-option-main">
        <strong>{routeLabel}</strong>
        <small>{route.legs.map((leg) => leg.mode === "flight" ? "Flight" : "Ground").join(" · ")}</small>
      </span>
      <span className="route-option-cost">
        <strong>{money(route.total_cost_myr)}</strong>
        <small>{route.total_time_hours.toFixed(1)} h</small>
      </span>
    </button>
  );
}

function App() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [origin, setOrigin] = useState<TripCity | null>(null);
  const [destinations, setDestinations] = useState<TripCity[]>([]);
  const [today] = useState(() => localDateString(new Date()));
  const [startDate, setStartDate] = useState(() => addDays(localDateString(new Date()), 30));
  const [endDate, setEndDate] = useState(() => addDays(localDateString(new Date()), 38));
  const [returnToOrigin, setReturnToOrigin] = useState(true);
  const [settings, setSettings] = useState<TransportSettings>(fallbackSettings);
  const [preference, setPreference] = useState<Preference>("cheapest");
  const [result, setResult] = useState<TripPlanResponse | null>(null);
  const [selectedRouteId, setSelectedRouteId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [configError, setConfigError] = useState<string | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/data", { signal: controller.signal })
      .then(async (response) => {
        const payload = await response.json() as AppConfig & { detail?: string };
        if (!response.ok) throw new Error(payload.detail ?? "Planner configuration could not be loaded.");
        setConfig(payload);
        setSettings(payload.defaults);
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setConfigError(error instanceof Error ? error.message : "The local API could not be reached.");
      });
    return () => controller.abort();
  }, []);

  const selectedRoute = useMemo(
    () => result?.routes.find((route) => route.id === selectedRouteId) ?? result?.routes[0] ?? null,
    [result, selectedRouteId],
  );

  const minDays = Math.max(0, destinations.length + Number(returnToOrigin) - 1);
  const dateSpan = Math.floor((new Date(`${endDate}T12:00:00`).getTime() - new Date(`${startDate}T12:00:00`).getTime()) / 86_400_000);
  const tooShort = dateSpan < minDays;
  const estimatedSearches = estimateSearchCount(destinations.length, returnToOrigin);
  const preferenceOptions: { id: Preference; label: string; icon: typeof ArrowDownUp }[] = [
    { id: "cheapest", label: "Lowest total", icon: ArrowDownUp },
    { id: "shortest", label: "Shortest", icon: Route },
    { id: "balanced", label: "Balanced", icon: Compass },
  ];

  const updateSetting = <K extends keyof TransportSettings>(key: K, value: TransportSettings[K]) => {
    setSettings((current) => ({ ...current, [key]: value }));
    setResult(null);
  };

  const runSearch = async () => {
    if (!origin) {
      setSearchError("Choose a start city first.");
      return;
    }
    if (!destinations.length) {
      setSearchError("Add at least one destination city.");
      return;
    }
    if (tooShort) {
      setSearchError("Extend the date range to allow at least one day between travel legs.");
      return;
    }
    setLoading(true);
    setSearchError(null);
    setResult(null);
    try {
      const response = await fetch("/api/routes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          origin_code: origin.code,
          destination_codes: destinations.map((city) => city.code),
          start_date: startDate,
          end_date: endDate,
          return_to_origin: returnToOrigin,
          settings,
          preference,
        }),
      });
      const payload = await response.json() as TripPlanResponse & { detail?: string | { msg?: string }[] };
      if (!response.ok) {
        const detail = Array.isArray(payload.detail) ? payload.detail.map((item) => item.msg).filter(Boolean).join(" ") : payload.detail;
        throw new Error(typeof detail === "string" ? detail : `Route search failed (${response.status}).`);
      }
      setResult(payload);
      setSelectedRouteId(payload.routes[0]?.id ?? null);
    } catch (error) {
      setSearchError(error instanceof Error ? error.message : "Route search failed.");
    } finally {
      setLoading(false);
    }
  };

  const submitTrip = async (event: FormEvent) => {
    event.preventDefault();
    await runSearch();
  };

  const chooseDestination = (city: TripCity) => {
    setDestinations((current) => current.length >= (config?.max_destinations ?? 4) || current.some((item) => item.code === city.code)
      ? current
      : [...current, city]);
    setResult(null);
  };

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-lockup">
          <div className="brand-icon"><Compass size={21} strokeWidth={2.1} /></div>
          <div>
            <div className="brand-title">Wayfinder <span>Routes</span></div>
            <div className="brand-caption">Live flights · ground route estimates</div>
          </div>
        </div>
        <Badge className="live-badge"><span className="live-dot" /> Google Flights search</Badge>
      </header>

      <section className="intro-row">
        <div>
          <div className="eyebrow">PLAN A MULTI-CITY TRIP</div>
          <h1>Choose the places. We’ll compare the route.</h1>
          <p>Search live flight fares, reorder your destinations, and compare flights with estimated ground legs.</p>
        </div>
        <div className="intro-note"><CalendarDays size={16} /> Choose a date window; travel legs are spaced across it.</div>
      </section>

      {configError && <div className="inline-alert error-alert">{configError}</div>}

      <form className="planner-form" onSubmit={(event) => void submitTrip(event)}>
        <Card className="trip-card">
          <CardHeader className="trip-card-header">
            <div className="form-heading-icon"><Route size={17} /></div>
            <div><CardTitle>Your trip</CardTitle><p>Every selected destination is visited once. The planner chooses the order.</p></div>
          </CardHeader>
          <CardContent className="trip-card-content">
            <section className="place-section">
              <div className="place-grid">
                <div className="place-entry">
                  <CityPicker
                    label="Start city"
                    placeholder="Search by city or airport code"
                    disabledCodes={destinations.map((city) => city.code)}
                    onSelect={(city) => { setOrigin(city); setResult(null); setSearchError(null); }}
                  />
                  {origin && <CityChip city={origin} remove={() => { setOrigin(null); setResult(null); }} />}
                </div>
                <div className="place-entry">
                  <CityPicker
                    label={`Destinations (${destinations.length}/${config?.max_destinations ?? 4})`}
                    placeholder={destinations.length >= (config?.max_destinations ?? 4) ? "Destination limit reached" : "Add a city to visit"}
                    disabledCodes={[origin?.code ?? "", ...destinations.map((city) => city.code)]}
                    disabled={destinations.length >= (config?.max_destinations ?? 4)}
                    onSelect={chooseDestination}
                  />
                  {destinations.length > 0 && (
                    <div className="destination-chips">
                      {destinations.map((city) => (
                        <CityChip key={city.code} city={city} remove={() => {
                          setDestinations((current) => current.filter((item) => item.code !== city.code));
                          setResult(null);
                        }} />
                      ))}
                    </div>
                  )}
                </div>
              </div>
              {destinations.length >= (config?.max_destinations ?? 4) && (
                <p className="field-hint limit-hint">Up to 4 destinations per search so the app can compare every order without sending an unbounded number of flight searches.</p>
              )}
            </section>

            <div className="form-divider" />
            <section className="trip-options-row">
              <div className="date-fields">
                <label className="field-wrap">
                  <span className="field-label">Start date</span>
                  <input type="date" min={today} value={startDate} onChange={(event) => { setStartDate(event.target.value); setResult(null); }} />
                </label>
                <ArrowRight className="date-arrow" size={17} />
                <label className="field-wrap">
                  <span className="field-label">End date</span>
                  <input type="date" min={startDate} value={endDate} onChange={(event) => { setEndDate(event.target.value); setResult(null); }} />
                </label>
              </div>
              <label className="return-toggle">
                <input type="checkbox" checked={returnToOrigin} onChange={(event) => { setReturnToOrigin(event.target.checked); setResult(null); }} />
                <span className="toggle-check"><Check size={13} /></span>
                <span><strong>Return to start city</strong><small>Search a final flight home</small></span>
              </label>
            </section>
            {tooShort && <p className="field-hint warning-text">Allow at least {minDays} days for the {destinations.length + Number(returnToOrigin)} travel legs.</p>}

            <div className="form-divider" />
            <section className="form-bottom-grid">
              <div>
                <div className="settings-title"><Settings2 size={15} /><strong>Compare route costs</strong><span>One adult · economy · MYR</span></div>
                <div className="settings-grid">
                  <SettingField label="Ground speed" suffix="km/h" value={settings.average_speed_kmh} min={10} max={500} step={5} onChange={(value) => updateSetting("average_speed_kmh", value)} />
                  <SettingField label="Ground cost" suffix="MYR/km" value={settings.fare_myr_per_km} min={0} max={100} step={0.01} onChange={(value) => updateSetting("fare_myr_per_km", value)} />
                  <SettingField label="Ground overhead" suffix="min" value={settings.ground_overhead_minutes} min={0} max={360} step={5} onChange={(value) => updateSetting("ground_overhead_minutes", value)} />
                  <SettingField label="Airport buffer" suffix="min" value={settings.flight_airport_buffer_minutes} min={0} max={360} step={15} onChange={(value) => updateSetting("flight_airport_buffer_minutes", value)} />
                </div>
              </div>
              <div className="rank-block">
                <div className="settings-title"><ArrowDownUp size={15} /><strong>Rank by</strong></div>
                <div className="preference-group" role="group" aria-label="Route ranking preference">
                  {preferenceOptions.map(({ id, label, icon: Icon }) => (
                    <Button key={id} type="button" variant={preference === id ? "default" : "secondary"} size="sm" className="preference-button" onClick={() => { setPreference(id); setResult(null); }}>
                      <Icon size={14} />{label}
                    </Button>
                  ))}
                </div>
                <p className="field-hint">All destination orders are checked (up to 24). Up to {estimatedSearches} one-way flight searches for this trip.</p>
              </div>
            </section>

            {searchError && <div className="inline-alert error-alert"><CircleHelp size={15} />{searchError}</div>}
            <div className="form-submit-row">
              <p>Flight prices are live search results and may change before booking.</p>
              <Button type="submit" className="search-button" disabled={loading || !origin || !destinations.length || tooShort}>
                {loading ? <LoaderCircle size={17} className="spin" /> : <Plus size={17} />}
                {loading ? `Searching ${estimatedSearches} city/date pairs…` : "Find the best routes"}
              </Button>
            </div>
          </CardContent>
        </Card>
      </form>

      {loading && (
        <div className="search-progress"><LoaderCircle className="spin" size={16} /> Searching live fares and road distances. Google may take a few seconds to respond.</div>
      )}

      {result && (
        <section className="results-section">
          <div className="results-heading">
            <div>
              <div className="section-kicker">{result.candidate_count} ROUTE ORDERS COMPARED · {result.searches_attempted} FLIGHT SEARCHES</div>
              <h2>Best ways to make this trip <span>{result.routes.length} options</span></h2>
              <p>Dates searched: {result.date_schedule.map(formatDate).join(" · ")} · Ranked by {preference === "cheapest" ? "estimated total cost" : preference === "shortest" ? "estimated travel time" : "balanced cost and time"}.</p>
            </div>
            <Button type="button" variant="secondary" className="refresh-button" disabled={loading} onClick={() => void runSearch()}>
              {loading ? <LoaderCircle size={15} className="spin" /> : <ArrowDownUp size={15} />} Re-search
            </Button>
          </div>

          {result.search_message && <div className="inline-alert warning-alert"><CircleHelp size={15} />{result.search_message}</div>}
          {result.routing_message && <div className="inline-alert warning-alert"><MapPinned size={15} />{result.routing_message}</div>}
          <div className="result-stat-row">
            <span><i className="stat-dot flight-dot" />{result.searches_with_priced_results}/{result.searches_attempted} city/date searches had priced flights</span>
            {result.unpriced_rows_skipped > 0 && <span><i className="stat-dot warning-dot" />{result.unpriced_rows_skipped} unpriced Google rows skipped</span>}
            <span><i className="stat-dot ground-dot" />Ground legs are estimates, not confirmed services</span>
          </div>

          <div className="results-grid">
            <Card className="map-card">
              <div className="map-card-head">
                <div><div className="section-kicker">ROUTE MAP</div><h2>Selected combination</h2></div>
                <div className="map-legends"><span><i className="legend-line flight-line" /> Flight</span><span><i className="legend-line ground-line" /> Ground</span></div>
              </div>
              <div className="map-frame"><RouteMap origin={origin} destinations={destinations} route={selectedRoute} /></div>
              <div className="map-footnote"><span><MapPinned size={14} /> Airport locations</span><span>Ground route may use a direct-distance proxy</span></div>
            </Card>

            <Card className="route-list-card">
              <div className="route-list-heading"><div><div className="section-kicker">ROUTE OPTIONS</div><h2>Choose a route</h2></div><Badge>{result.routes.length} ranked</Badge></div>
              <div className="route-list">
                {result.routes.map((route) => (
                  <RouteSummary key={route.id} route={route} selected={route.id === selectedRoute?.id} onClick={() => setSelectedRouteId(route.id)} />
                ))}
                {result.routes.length === 0 && <div className="empty-routes">No complete route could be estimated for these cities.</div>}
              </div>
            </Card>
          </div>

          {selectedRoute && (
            <Card className="detail-card">
              <div className="detail-heading">
                <div><div className="section-kicker">ROUTE {String(selectedRoute.rank).padStart(2, "0")}</div><h2>{selectedRoute.stops.map((city) => city.name).join(" → ")}</h2></div>
                <div className="detail-total"><span>Estimated trip total</span><strong>{money(selectedRoute.total_cost_myr)}</strong></div>
              </div>
              <div className="detail-metrics">
                <div><Plane size={16} /><span>Flight fares</span><strong>{money(selectedRoute.flight_cost_myr)}</strong></div>
                <div><Route size={16} /><span>Ground estimate</span><strong>{money(selectedRoute.ground_cost_myr)}</strong></div>
                <div><CalendarDays size={16} /><span>Travel time</span><strong>{selectedRoute.total_time_hours.toFixed(1)} h</strong></div>
                <div><MapPinned size={16} /><span>Ground distance</span><strong>{selectedRoute.ground_distance_km.toLocaleString("en-MY", { maximumFractionDigits: 0 })} km</strong></div>
              </div>
              <div className="leg-list">
                {selectedRoute.legs.map((leg, index) => (
                  <div className="leg-row" key={`${leg.from_city.code}-${leg.to_city.code}-${leg.departure_date}`}>
                    <span className="leg-number">{String(index + 1).padStart(2, "0")}</span>
                    <div className="leg-main">
                      <strong>{leg.from_city.name}<ArrowRight size={14} />{leg.to_city.name}</strong>
                      <small>{formatDate(leg.departure_date)} · {leg.mode === "flight" ? (leg.airlines.join(", ") || "Flight") : leg.distance_source === "assumed_connection" ? "Assumed ground connection" : "OSRM road estimate"}</small>
                    </div>
                    <Badge className={leg.mode === "flight" ? "flight-mode" : "ground-mode"}>{leg.mode === "flight" ? `${leg.segment_count > 1 ? `${leg.segment_count} flight segments` : "Flight"}` : "Ground"}</Badge>
                    <strong className="leg-cost">{money(leg.cost_myr)}</strong>
                    <span className="leg-time">{(leg.duration_minutes / 60).toFixed(1)} h</span>
                    {leg.search_url && <a className="leg-search-link" href={leg.search_url} target="_blank" rel="noopener noreferrer" aria-label={`Open Google Flights search from ${leg.from_city.name} to ${leg.to_city.name}`}><ExternalLink size={14} /></a>}
                  </div>
                ))}
              </div>
              <p className="detail-disclaimer">Google Flights links reopen each one-way search; prices are not booking guarantees. Ground cost and time use your assumptions. A direct-distance proxy does not confirm a road, ferry, bus, or train service.</p>
            </Card>
          )}

          <div className="limits-note"><CircleHelp size={15} /><div><strong>Search boundaries</strong><span>Every selected city order is compared, with up to {result.maximum_searches} one-way searches for this input. {result.limitations.join(" ")}</span></div></div>
        </section>
      )}

      <footer className="page-footer">
        <span>Wayfinder Routes · Live flight search by fast-flights</span>
        <span>Airport data © airportsdata contributors · Map © OpenStreetMap contributors</span>
      </footer>
    </main>
  );
}

export default App;
