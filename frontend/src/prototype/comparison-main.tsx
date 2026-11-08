import React, { useRef, useState } from "react";
import ReactDOM from "react-dom/client";
import { example } from "./example";
import { firstDifference, SolverRunner, type Measurement } from "./comparison";
import type { SolverInput } from "./native/types";
import { importSolverInput } from "./native/import-input";
import "../styles.css";
import "./prototype.css";

function exampleInput(): SolverInput {
  const data = example();
  return { spec: data.spec, movements: data.graph.movements, offers: data.graph.offers, rules: [], snapshot_revision: data.graph.revision };
}
function App() {
  const [input, setInput] = useState<SolverInput>(exampleInput);
  const [name, setName] = useState("Built-in example");
  const [status, setStatus] = useState("Both solvers receive the same normalized graph. No provider searches are made.");
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [results, setResults] = useState<Partial<Record<"native" | "python", Measurement>>>({});
  const runners = useRef<Partial<Record<"native" | "python", SolverRunner>>>({});
  const stopped = useRef(false);
  function runner(kind: "native" | "python") { return runners.current[kind] ??= new SolverRunner(kind, setStatus); }
  async function run(kinds: ("native" | "python")[]) {
    if (busy) return;
    stopped.current = false; setBusy(true); setError("");
    try {
      for (const kind of kinds) {
        setStatus(`Running ${kind === "native" ? "native TypeScript" : "Python / Pyodide"}…`);
        const measurement = await runner(kind).run(input);
        setResults(previous => ({ ...previous, [kind]: measurement }));
      }
      setStatus("Comparison finished.");
    } catch (reason) { if (stopped.current) setStatus("Comparison stopped."); else setError(String(reason)); }
    finally { setBusy(false); }
  }
  async function importFile(file?: File) {
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      setInput(importSolverInput(data));
      setName(file.name); setResults({}); setError("");
    } catch (reason) { setError(String(reason)); }
  }
  const mismatch = results.native && results.python ? firstDifference(results.python.result, results.native.result) : undefined;
  return <main className="browser-poc">
    <header><div><p className="eyebrow">Wayfinder · Solver experiment</p><h1>Compare Python and TypeScript</h1></div><a href="/prototype.html">Search prototype</a></header>
    <p>No runtime translation: TypeScript runs directly in its own worker. Python remains the reference in a separate Pyodide worker.</p>
    <section><h2>{name}</h2><p>{input.movements.length.toLocaleString()} journeys · {input.offers.length.toLocaleString()} fares · {input.spec.visits.length} required cities</p>
      <div className="actions"><button className="primary" disabled={busy} onClick={() => void run(["native", "python"])}>Run both solvers</button>
        <button disabled={busy} onClick={() => void run(["native"])}>Run TypeScript only</button><button disabled={busy} onClick={() => void run(["python"])}>Run Python only</button>
        {busy && <button onClick={() => { stopped.current = true; Object.values(runners.current).forEach(value => value.close()); runners.current = {}; }}>Stop</button>}
      </div>
      <label>Import graph or solver input <input aria-label="Comparison input JSON" type="file" accept=".json,application/json" disabled={busy} onChange={event => void importFile(event.target.files?.[0])} /></label>
    </section>
    <p role="status">{status}</p>{error && <p role="alert" className="error">{error}</p>}
    <section><h2>Results</h2><table><thead><tr><th>Solver</th><th>Solver time</th><th>Request elapsed</th><th>Options</th><th>Expanded states</th></tr></thead>
      <tbody>{(["native", "python"] as const).map(kind => <tr key={kind}><th>{kind === "native" ? "TypeScript" : "Python / Pyodide"}</th><td>{results[kind] ? `${results[kind]!.solve_ms.toFixed(1)} ms` : "—"}</td><td>{results[kind] ? `${results[kind]!.wall_ms.toFixed(1)} ms` : "—"}</td><td>{results[kind]?.result.routes.length ?? "—"}</td><td>{results[kind]?.result.expanded_labels.toLocaleString() ?? "—"}</td></tr>)}</tbody></table>
      {mismatch === null && <p className="status">Results match, including route IDs, fares, diagnostics, and search counters.</p>}
      {mismatch && <div className="error"><strong>Difference at {mismatch.path}</strong><pre>{JSON.stringify(mismatch, null, 2)}</pre></div>}
      <p className="hint">Solver time includes preprocessing and result construction. Request elapsed also includes worker startup, runtime loading on first use, messages, and input validation. Runtime downloads depend on caching and network speed.</p>
      {!!Object.keys(results).length && <details><summary>Inspect results</summary><pre>{JSON.stringify(Object.fromEntries(Object.entries(results).map(([kind, value]) => [kind, value?.result])), null, 2)}</pre></details>}
    </section>
    <footer>Experimental port based on main commit 9571a88, including fair exploration and flight-price eligibility. Full equality on a graph is evidence for that input, not proof for every possible trip.</footer>
  </main>;
}
ReactDOM.createRoot(document.getElementById("root")!).render(<React.StrictMode><App /></React.StrictMode>);
