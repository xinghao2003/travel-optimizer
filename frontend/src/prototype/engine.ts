import type { Result, TripSpec } from "../lib/planner";
import { read, write } from "./storage";

export type Task = { key: string; kind: "road" | "transit" | "flight"; from_id?: string; to_id?: string; date?: string; request?: unknown; params?: Record<string, string>; nodes?: { id: string; latitude: number; longitude: number }[] };
export type Graph = { movements: unknown[]; offers: unknown[]; roads?: unknown; revision: number };
export type Session = {
  version: 1; spec: TripSpec; graph: Graph; tasks: Task[]; cursor: number;
  requests: number; cacheHits: number; failures: string[]; result?: Result;
  checkpoint?: string; rules: unknown[]; example: boolean;
};

class PythonWorker {
  private worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
  private sequence = 0;
  private pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  constructor(onStatus: (message: string) => void) {
    this.worker.onmessage = event => {
      const { id, result, error, status } = event.data;
      if (status) { onStatus(status); return; }
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);
      if (error) pending.reject(new Error(error)); else pending.resolve(result);
    };
    this.worker.onerror = event => {
      const error = new Error(event.message || "The Python worker stopped.");
      for (const pending of this.pending.values()) pending.reject(error);
      this.pending.clear();
    };
  }
  async call<T>(method: string, ...args: unknown[]): Promise<T> {
    const raw = await new Promise<unknown>((resolve, reject) => {
      const id = ++this.sequence;
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, method, args });
    });
    return (typeof raw === "string" && !["checkpoint", "resume_checkpoint"].includes(method) ? JSON.parse(raw) : raw) as T;
  }
  close() {
    this.worker.terminate();
    for (const pending of this.pending.values()) pending.reject(new Error("Worker closed."));
    this.pending.clear();
  }
}

export class BrowserPlanner {
  private python: PythonWorker;
  private controller?: AbortController;
  private stopped = false;
  private lastRequestAt = 0;
  session?: Session;
  constructor(private status: (message: string) => void, private update: (session: Session) => void) {
    this.python = new PythonWorker(status);
  }
  async restore(): Promise<boolean> {
    const saved = await read<Session>("session");
    if (!saved || saved.version !== 1) return false;
    this.session = saved;
    // Initialize Python lazily when the user continues, rather than on page load.
    this.update(structuredClone(saved));
    return true;
  }
  private loaded = false;
  private async ensureLoaded() {
    if (this.loaded || !this.session) return;
    await this.python.call("restore", this.session);
    if (this.session.checkpoint) await this.python.call("resume_checkpoint", this.session.checkpoint);
    this.loaded = true;
  }
  async prepare(spec: TripSpec) {
    const prepared = await this.python.call<{ spec: TripSpec; tasks: Task[] }>("prepare", spec);
    this.session = { version: 1, spec: prepared.spec, graph: { movements: [], offers: [], revision: 0 }, tasks: prepared.tasks,
      cursor: 0, requests: 0, cacheHits: 0, failures: [], rules: [], example: false };
    this.loaded = true;
    await this.save(false);
  }
  async startSearch(spec: TripSpec, budget: number) {
    this.stopped = false;
    await this.prepare(spec);
    if (this.stopped) { this.status("Stopped. Collected data is saved in this browser."); return; }
    await this.search(budget);
  }
  async importGraph(input: { spec: TripSpec; graph?: Graph; snapshot?: Graph; offers?: unknown[]; rules?: unknown[]; example?: boolean }) {
    // File imports restore validated JSON only, never uploaded pickle bytes.
    const restored = await this.python.call<{ spec: TripSpec }>("restore", input);
    const snapshot = await this.python.call<{ graph: Graph }>("snapshot");
    this.session = { version: 1, spec: restored.spec, graph: snapshot.graph, tasks: [], cursor: 0,
      requests: 0, cacheHits: 0, failures: [], rules: input.rules ?? [], example: !!input.example };
    this.loaded = true;
    await this.save(false);
  }
  stop() { this.stopped = true; this.controller?.abort(); }
  close() { this.stop(); this.python.close(); }
  private async save(includeCheckpoint: boolean) {
    if (!this.session) return;
    const state = await this.python.call<{ graph: Graph }>("snapshot");
    this.session.graph = state.graph;
    this.session.checkpoint = includeCheckpoint && !this.session.result?.optimization_complete ? await this.python.call<string>("checkpoint") : undefined;
    await write("session", this.session);
    this.update(structuredClone(this.session));
  }
  async solve(seconds = 2) {
    await this.ensureLoaded();
    if (!this.session) return;
    const deadline = performance.now() + seconds * 1000;
    this.status("Calculating options in this browser…");
    do {
      this.session.result = await this.python.call<Result>("solve", { seconds: .15, rules: this.session.rules });
    } while (!this.stopped && !this.session.result.optimization_complete && performance.now() < deadline);
    await this.save(true);
  }
  async continueCalculation() {
    this.stopped = false;
    await this.solve(5);
    this.status(this.session?.result?.optimization_complete ? "Calculation complete." : "Calculation paused. Continue to check more combinations.");
  }
  async search(budget: number) {
    if (!Number.isInteger(budget) || budget < 1 || budget > 50) throw new Error("Choose 1 to 50 requests per batch.");
    this.stopped = false;
    await this.ensureLoaded();
    if (!this.session) return;
    this.controller = new AbortController();
    let requested = 0;
    while (this.session.cursor < this.session.tasks.length && requested < budget && !this.stopped) {
      const task = this.session.tasks[this.session.cursor];
      this.status(`Searching ${task.kind === "road" ? "road distances" : task.kind === "flight" ? "flights through the proxy" : "transit directly"} (${this.session.cursor + 1}/${this.session.tasks.length})…`);
      try {
        const cached = await read<{ expires: number; payload: unknown }>(`provider:${task.key}`);
        let payload: unknown;
        if (cached && cached.expires > Date.now()) { payload = cached.payload; this.session.cacheHits++; }
        else {
          const wait = 1000 - (performance.now() - this.lastRequestAt);
          if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
          if (this.stopped) break;
          this.lastRequestAt = performance.now();
          requested++; this.session.requests++;
          payload = await fetchProvider(task, this.controller.signal);
          const ttl = task.kind === "road" ? 7 * 86400 : task.kind === "flight" ? 900 : 21600;
          await write(`provider:${task.key}`, { expires: Date.now() + ttl * 1000, payload });
        }
        await this.python.call("ingest", task, payload);
      } catch (error) {
        if (this.stopped) break; // Resume this task; an aborted call is not an empty result.
        this.session.failures.push(`${task.kind} ${task.date ?? ""}: ${String(error)}`);
      }
      this.session.cursor++;
      if (this.session.cursor % 4 === 0) await this.solve(.4);
      else await this.save(false);
    }
    await this.solve(2);
    this.controller = undefined;
    this.status(this.stopped ? "Stopped. Collected data is saved in this browser."
      : this.session.cursor < this.session.tasks.length ? "Search paused. Search more to continue." : "Discovery queue complete. Check coverage and missing prices.");
  }
}

export async function fetchProvider(task: Task, signal: AbortSignal): Promise<unknown> {
  let url: string, init: RequestInit = {};
  if (task.kind === "road") {
    const coordinates = task.nodes!.map(node => `${node.longitude},${node.latitude}`).join(";");
    url = `https://router.project-osrm.org/table/v1/driving/${coordinates}?annotations=distance,duration`;
  } else if (task.kind === "transit") url = `https://api.transitous.org/api/v6/plan?${new URLSearchParams(task.params)}`;
  else {
    url = "/api/flights";
    init = { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(task.request) };
  }
  const response = await fetch(url, { ...init, signal: AbortSignal.any([signal, AbortSignal.timeout(45000)]) });
  if (!response.ok) throw new Error(`${task.kind} returned HTTP ${response.status}.`);
  const payload = await response.json();
  if (task.kind === "flight" && payload.status === "failed") throw new Error(payload.message || "Flight retrieval failed.");
  return payload;
}
