import React, { useEffect, useRef, useState } from "react";
import ReactDOM from "react-dom/client";
import type { TripSpec } from "../lib/planner";
import { formatLocal } from "../lib/present";
import { BrowserPlanner, type Session } from "./engine";
import { example, initialSpec, places } from "./example";
import "../styles.css";
import "./prototype.css";

function App() {
  const engine = useRef<BrowserPlanner | null>(null);
  const [spec, setSpec] = useState(initialSpec);
  const [session, setSession] = useState<Session>();
  const [status, setStatus] = useState("Trips and collected data stay in this browser.");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const [budget, setBudget] = useState(4);
  const [changed, setChanged] = useState(false);
  useEffect(() => {
    let active = true;
    const planner = new BrowserPlanner(message => { if (active) setStatus(message); }, value => { if (active) setSession(value); });
    engine.current = planner;
    void planner.restore().then(restored => {
      if (active && restored && planner.session) { setSpec(planner.session.spec); setStatus("Saved browser trip restored. Continue when ready."); }
    }).catch(reason => { if (active) setError(String(reason)); }).finally(() => { if (active) setReady(true); });
    return () => { active = false; planner.close(); };
  }, []);
  function edit(value: TripSpec) { setSpec(value); setChanged(true); }
  async function run(action: (planner: BrowserPlanner) => Promise<void>) {
    if (!engine.current || busy) return;
    setBusy(true); setError("");
    try { await action(engine.current); }
    catch (reason) { setError(String(reason)); setStatus("The operation did not finish. Collected data remains available."); }
    finally { setBusy(false); }
  }
  async function loadExample() {
    await run(async planner => {
      await planner.importGraph(example()); setSpec(planner.session!.spec); setChanged(false);
      await planner.continueCalculation();
    });
  }
  async function importFile(file?: File) {
    if (!file) return;
    await run(async planner => {
      const data = JSON.parse(await file.text());
      await planner.importGraph(data); setSpec(planner.session!.spec); setChanged(false);
      await planner.continueCalculation();
    });
  }
  function download() {
    if (!session) return;
    const blob = new Blob([JSON.stringify({ spec: session.spec, graph: session.graph, rules: session.rules, example: session.example })], { type: "application/json" });
    const url = URL.createObjectURL(blob), link = document.createElement("a");
    link.href = url; link.download = "browser-trip.json"; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  const resultSpec = session?.spec ?? spec;
  const names = Object.fromEntries([resultSpec.home, ...resultSpec.visits.map(visit => visit.place)].map(place => [place.id, place.name]));
  const zones = Object.fromEntries([resultSpec.home, ...resultSpec.visits.map(visit => visit.place)].map(place => [place.id, place.timezone]));
  const result = session?.result;
  return <main className="browser-poc">
    <header><div><p className="eyebrow">Wayfinder · Prototype</p><h1>Plan in your browser</h1></div><a href="/solver-comparison.html">Compare solvers</a></header>
    <p>Search providers, compare routes, and save your trip on this device. Flights use a small server function.</p>
    <section aria-labelledby="setup-title">
      <div className="section-heading"><h2 id="setup-title">Trip</h2><button disabled={!ready || busy} onClick={() => void loadExample()}>Load example</button></div>
      <fieldset disabled={!ready || busy}>
        <div className="fields">
          <label>Home<select value={spec.home.id} onChange={event => {
            const home = places.find(place => place.id === event.target.value)!;
            edit({ ...spec, home, departures: [home], arrivals: [home], visits: spec.visits.filter(visit => visit.place.id !== home.id) });
          }}>{places.map(place => <option key={place.id} value={place.id}>{place.name}</option>)}</select></label>
          <label>Leave home<input type="date" value={spec.start_date} onChange={event => edit({ ...spec, start_date: event.target.value })} /></label>
          <label>Return home<input type="date" value={spec.end_date} onChange={event => edit({ ...spec, end_date: event.target.value })} /></label>
          <label>Adults<input type="number" min={1} max={9} value={spec.adults} onChange={event => edit({ ...spec, adults: Number(event.target.value) })} /></label>
        </div>
        <div className="visits"><span>Cities to visit · up to four</span><div className="checks">{places.filter(place => place.id !== spec.home.id).map(place => <label key={place.id}>
          <input type="checkbox" checked={spec.visits.some(visit => visit.place.id === place.id)} disabled={spec.visits.length >= 4 && !spec.visits.some(visit => visit.place.id === place.id)}
            onChange={event => edit({ ...spec, visits: event.target.checked ? [...spec.visits, { place, min_stay_hours: 12 }] : spec.visits.filter(visit => visit.place.id !== place.id) })} />{place.name}
        </label>)}</div></div>
        <div className="fields">{spec.visits.map((visit, index) => <label key={visit.place.id}>Minimum hours in {visit.place.name}<input type="number" min={0} max={336} value={visit.min_stay_hours}
          onChange={event => edit({ ...spec, visits: spec.visits.map((item, i) => i === index ? { ...item, min_stay_hours: Number(event.target.value) } : item) })} /></label>)}</div>
        <div className="checks" aria-label="Transport modes">{(["flight", "rail", "bus", "coach", "taxi"] as const).map(mode => <label key={mode}><input type="checkbox" checked={spec.modes.includes(mode)}
          onChange={event => edit({ ...spec, modes: event.target.checked ? [...spec.modes, mode] : spec.modes.filter(item => item !== mode) })} />{mode === "flight" ? "Flights" : mode === "rail" ? "Rail" : mode === "coach" ? "Coach" : mode === "bus" ? "Bus" : "Taxi"}</label>)}</div>
      </fieldset>
      <div className="actions"><label>Requests per batch<input type="number" min={1} max={50} value={budget} disabled={busy} onChange={event => setBudget(Number(event.target.value))} /></label>
        <button className="primary" disabled={!ready || busy || !Number.isInteger(budget) || budget < 1 || budget > 50} onClick={() => void run(async planner => {
          await planner.startSearch(spec, budget); setSpec(planner.session!.spec); setChanged(false);
        })}>Start new search</button>
        <button disabled={!session || changed || busy || session.cursor >= session.tasks.length} onClick={() => void run(planner => planner.search(budget))}>Search more</button>
        <button disabled={!session || busy || changed} onClick={() => void run(planner => planner.continueCalculation())}>Continue calculation</button>
        {busy && <button onClick={() => engine.current?.stop()}>Stop</button>}
      </div>
      {changed && session && <p className="hint">Settings changed. Start a new search to use them.</p>}
    </section>
    <p role="status" className="status">{status}</p>
    {error && <p role="alert" className="error">{error}</p>}
    {session && <section aria-labelledby="results-title">
      <div className="section-heading"><h2 id="results-title">Options {session.example && <span className="example">Example data</span>}</h2><button disabled={busy} onClick={download}>Export graph JSON</button></div>
      <p className="metrics">{session.cursor}/{session.tasks.length} queries processed · {session.requests} requests · {session.cacheHits} cache hits · {session.graph.movements.length} journeys</p>
      {result && <p className="metrics">{result.expanded_labels.toLocaleString()} combinations checked · {result.optimization_complete ? "Calculation complete for collected data" : "Calculation paused"}{session.cursor < session.tasks.length ? " · Discovery incomplete" : ""}</p>}
      {result && !result.routes.length && <p>No complete itinerary found in the collected data. Search more, change the settings, or inspect failures below.</p>}
      <ol className="routes">{result?.routes.map((route, index) => <li key={route.id}>
        <div className="route-heading"><h3>Option {index + 1}</h3><strong>{route.total_cost_myr === null ? `From RM ${route.cost_low_myr.toFixed(2)} · not fully priced` : `RM ${route.total_cost_myr.toFixed(2)}`}</strong><span>{route.stay_hours.toFixed(1)} hours in cities</span></div>
        <ol>{route.movements.map(movement => <li key={movement.id}><strong>{names[movement.from_id] ?? movement.from_id} → {names[movement.to_id] ?? movement.to_id}</strong> · {movement.mode}
          <span>{movement.departure && formatLocal(movement.departure, zones[movement.from_id] ?? "UTC")} → {movement.arrival && formatLocal(movement.arrival, zones[movement.to_id] ?? "UTC")}</span>
          {movement.assumptions.map(assumption => <small key={assumption}>{assumption}</small>)}
        </li>)}</ol>
      </li>)}</ol>
      {!!result?.missing_fares.length && <p className="warning">{result.missing_fares.length} fare components need prices. Missing fares are not treated as free travel.</p>}
      {session.failures.length > 0 && <details className="warning"><summary>Provider failures ({session.failures.length})</summary><ul>{session.failures.map((failure, index) => <li key={index}>{failure}</li>)}</ul></details>}
    </section>}
    <details><summary>Import an existing graph</summary><p>Import a graph exported here, or a saved trip JSON containing its full snapshot.</p><input aria-label="Import graph JSON" type="file" accept="application/json,.json" disabled={!ready || busy} onChange={event => void importFile(event.target.files?.[0])} /></details>
    <footer><p>Prototype: one-way discovery, date windows up to 14 days, and a small city list. The full editor and combined-ticket discovery are not migrated. Calculation covers the collected graph.</p>
      <p>Direct requests still use provider resources. Coordinate automated public Transitous use and respect provider limits. <a href="https://transitous.org/api/">Transitous API policy</a> · <a href="https://routing.openstreetmap.de/about.html">OSRM policy</a></p>
      <p>Sources: <a href="https://transitous.org/sources/">Transitous data</a>, <a href="https://project-osrm.org/">OSRM</a>, <a href="https://www.openstreetmap.org/copyright">OpenStreetMap contributors</a>, Google Flights / fast-flights. Contact: <a href="https://github.com/xinghao2003/travel-optimizer">project repository</a>.</p>
    </footer>
  </main>;
}

ReactDOM.createRoot(document.getElementById("root")!).render(<React.StrictMode><App /></React.StrictMode>);
