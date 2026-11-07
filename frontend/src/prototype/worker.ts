// Python remains inside a module worker; each solve slice yields to host messages.
const INDEX_URL = "https://cdn.jsdelivr.net/pyodide/v314.0.7/full/";
const MODULES = ["__init__", "planner_models", "planner_positioning", "planner_optimizer", "planner_windows", "planner_journeys", "browser_runtime"];
type Runtime = {
  loadPackage(names: string[]): Promise<void>;
  FS: { mkdir(path: string): void; writeFile(path: string, data: string): void };
  runPython(code: string): unknown;
  globals: { set(name: string, value: string): void; delete(name: string): void };
};
let ready: Promise<Runtime> | undefined;

function initialize() {
  ready ??= (async () => {
    self.postMessage({ status: "Loading Python runtime…" });
    const { loadPyodide } = await import(/* @vite-ignore */ `${INDEX_URL}pyodide.mjs`);
    const py: Runtime = await loadPyodide({ indexURL: INDEX_URL });
    await py.loadPackage(["pydantic", "tzdata"]);
    py.FS.mkdir("/planner");
    py.FS.mkdir("/planner/app");
    for (const name of MODULES) {
      const response = await fetch(`/browser-python/${name}.py`);
      if (!response.ok) throw new Error(`Python source ${name} is missing. Run prepare_browser_poc.py.`);
      py.FS.writeFile(`/planner/app/${name}.py`, await response.text());
    }
    const response = await fetch("/browser-python/airports.json");
    if (!response.ok) throw new Error("Airport coordinates are missing. Run prepare_browser_poc.py.");
    py.globals.set("catalog_json", await response.text());
    py.runPython("import sys; sys.path.insert(0, '/planner'); from app import browser_runtime as planner; planner.configure(catalog_json)");
    py.globals.delete("catalog_json");
    return py;
  })();
  return ready;
}

// Serialize requests: the graph and checkpoint belong to one browser session.
let queue = Promise.resolve();
self.onmessage = event => {
  queue = queue.then(async () => {
    const { id, method, args = [] } = event.data as { id: number; method: string; args?: unknown[] };
    try {
      const py = await initialize();
      if (!["prepare", "ingest", "solve", "snapshot", "restore", "checkpoint", "resume_checkpoint", "reference_solve"].includes(method)) throw new Error("Unknown worker operation.");
      args.forEach((value, index) => py.globals.set(`arg${index}`, typeof value === "string" ? value : JSON.stringify(value)));
      try {
        const value = py.runPython(`planner.${method}(${args.map((_, index) => `arg${index}`).join(",")})`);
        self.postMessage({ id, result: value, wasm_memory_bytes: (py as Runtime & { _module?: { HEAPU8: Uint8Array } })._module?.HEAPU8.buffer.byteLength });
      } finally { args.forEach((_, index) => py.globals.delete(`arg${index}`)); }
    } catch (error) { self.postMessage({ id, error: String(error) }); }
  });
};
