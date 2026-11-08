/** Browser-owned calculation, with native checkpoints persisted between batches. */
import type { PricingRule, Result } from "../../lib/planner";
import { completeResult, prepareSolverInput } from "./preparation";
import type { PreparationOptions } from "./preparation";
import { PlannerRepository } from "./repository";
import type { SearchState, SolverInput, SolverResult } from "./types";
import type { BundleCandidate } from "./search-state";
import { PlannerError } from "./edits";

export type CalculationOptions = PreparationOptions & { minutes?: number | null; deadline?: number };
export type CalculationResult = Result & { bundle_candidates: BundleCandidate[] };
type Active = { stop(): void; includeDominated: boolean; promise: Promise<CalculationResult> };
type Reply = { result: SolverResult; checkpoint: SearchState };
class WorkerSolver {
  private worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
  private sequence = 0;
  private pending = new Map<number, { resolve(reply: Reply): void; reject(error: Error): void }>();
  constructor() {
    this.worker.onmessage = event => {
      const reply = event.data, pending = this.pending.get(reply.id);
      if (!pending) return;
      this.pending.delete(reply.id);
      if (reply.error) pending.reject(new Error(reply.error)); else pending.resolve(reply);
    };
    this.worker.onerror = event => {
      for (const pending of this.pending.values()) pending.reject(new Error(event.message || "The native solver stopped."));
      this.pending.clear();
    };
  }
  solve(input: SolverInput, seconds: number, checkpoint?: SearchState): Promise<Reply> {
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, input, seconds, fresh: false, checkpoint, exportCheckpoint: true });
    });
  }
  close() { this.worker.terminate(); }
}

export class BrowserCalculator {
  private active = new Map<string, Active>();
  constructor(readonly repository: PlannerRepository, private updated: (id: string, result: Result) => void = () => {}) {}
  isRunning(id: string) { return this.active.has(id); }
  async stop(id: string): Promise<Result | undefined> {
    const active = this.active.get(id);
    if (!active) return undefined;
    active.stop();
    return active.promise;
  }
  async calculate(id: string, options: CalculationOptions = {}): Promise<CalculationResult> {
    const prior = this.active.get(id);
    if (prior) {
      if (!options.expand && (!options.include_dominated || prior.includeDominated)) return prior.promise;
      await prior.promise;
      return this.calculate(id, options);
    }
    let stop = false;
    const active: Active = { stop: () => { stop = true; }, includeDominated: options.include_dominated ?? false,
      promise: this.run(id, options, () => stop).finally(() => { if (this.active.get(id) === active) this.active.delete(id); }) };
    this.active.set(id, active);
    return active.promise;
  }
  private async run(id: string, options: CalculationOptions, stopped: () => boolean): Promise<CalculationResult> {
    if (options.minutes != null && (!Number.isFinite(options.minutes) || options.minutes <= 0 || options.minutes > 1440)) throw new PlannerError("Choose a calculation round longer than 0 and no more than 1440 minutes.");
    const deadline = options.deadline ?? (options.minutes == null ? Infinity : performance.now() + options.minutes * 60_000);
    const [trip, rules, checkpoint] = await Promise.all([this.repository.requireTrip(id), this.repository.list<PricingRule>("rules"), this.repository.checkpoint(id)]);
    const prepared = prepareSolverInput(trip, rules, options), input = prepared.input;
    let sourceRevision = trip.snapshot?.revision ?? 0, first = true, roundStart = 0, expanded = 0;
    const budget = input.expansion_budget ?? Infinity;
    const solver = new WorkerSolver();
    try {
      for (;;) {
        // Small batches let Stop finish and persist a real frontier without
        // terminating the worker midway through an expansion.
        const remaining = budget - expanded;
        const reply = await solver.solve({ ...input, expansion_budget: Math.max(0, Math.min(2000, remaining)) }, Math.max(0, (deadline - performance.now()) / 1000), first ? checkpoint : undefined);
        const state = reply.checkpoint;
        if (first) { roundStart = checkpoint?.signature === state.signature ? checkpoint.expanded : 0; first = false; }
        expanded = state.expanded - roundStart;
        if (input.expansion_budget == null) delete reply.result.safety_limit_reached;
        else reply.result.safety_limit_reached = reply.result.remaining_labels > 0 && expanded >= input.expansion_budget;
        const result = completeResult(reply.result, prepared.snapshot, trip) as CalculationResult;
        const { bundle_candidates: _candidates, ...persisted } = result;
        const saved = await this.repository.saveCalculation(id, trip.revision, sourceRevision, prepared.snapshot, persisted, state);
        if (!saved) return result; // Its revision keeps the caller from accepting stale results.
        if (trip.snapshot) sourceRevision = prepared.snapshot.revision;
        this.updated(id, result);
        if (stopped() || result.optimization_complete || input.label_limit != null && state.expanded >= input.label_limit
            || expanded >= budget || performance.now() >= deadline) return result;
      }
    } finally { solver.close(); }
  }
}
