/** Browser discovery rounds, including in-flight Apply and durable continuation. */
import type { Job, OptimizationJob, PricingRule, TripSpec } from "../../lib/planner";
import { BrowserCalculator } from "./calculation";
import { parseSpec } from "./contracts";
import { tasksFor } from "./discovery";
import { discoveryKey } from "./discovery-key";
import { PlannerError, requireMinimumStays } from "./edits";
import type { ProviderOutcome } from "./ingestion";
import type { AirportCatalog, PlannerTrip, Snapshot } from "./preparation";
import { refreshQuoteFreshness } from "./preparation";
import type { SearchProvider } from "./providers";
import { RAIL_FALLBACK_SOURCE } from "./rail";
import { PlannerRepository } from "./repository";
import type { BundleCandidate, SearchRecord } from "./search-state";
import { enqueueTickets, publicSearch, recordOutcome, separateManualQuotes, TRANSIT_DISABLED, TRANSIT_MODES, updateCoverage } from "./search-state";
import { fingerprint } from "./time";

type Active = { job: SearchRecord; promise: Promise<void>; applying: boolean };
type Clock = { monotonic(): number; wall(): number };
type Options = { labelBatch?: number; expansionBudget?: number; clock?: Clock };
const terminal = (job: SearchRecord) => ["cancelled", "superseded", "interrupted", "failed"].includes(job.status);
const yieldBrowser = () => new Promise<void>(resolve => setTimeout(resolve, 0));

export class BrowserDiscovery {
  private active = new Map<string, Active>();
  private deadlines = new Map<string, number>();
  private cancelled = new Set<string>();
  private edits = new Map<string, Promise<unknown>>();
  private published = new Map<string, string>();
  private cadence = new Map<string, { cursor: number; seconds: number; controls: string; finished: number }>();
  private clock: Clock;
  constructor(readonly repository: PlannerRepository, readonly calculator: BrowserCalculator, readonly provider: SearchProvider,
    readonly airports: () => Promise<AirportCatalog>, readonly options: Options = {}) {
    this.clock = options.clock ?? { monotonic: () => performance.now(), wall: () => Date.now() };
  }
  private serial<T>(id: string, work: () => Promise<T>): Promise<T> {
    const prior = this.edits.get(id) ?? Promise.resolve(), task = prior.catch(() => {}).then(work);
    this.edits.set(id, task);
    void task.finally(() => { if (this.edits.get(id) === task) this.edits.delete(id); }).catch(() => {});
    return task;
  }
  isRunning(tripId: string) { return [...this.active.values()].some(a => a.job.trip_id === tripId); }
  async wait(id: string): Promise<void> { await this.active.get(id)?.promise; }
  private expired(job: SearchRecord) { const deadline = this.deadlines.get(job.id); return deadline !== undefined && this.clock.monotonic() >= deadline; }
  private public(job: SearchRecord): Job { return publicSearch(job, this.deadlines.get(job.id), this.clock.monotonic()); }
  private async saved(id: string): Promise<SearchRecord> {
    const job = this.active.get(id)?.job ?? await this.repository.get<SearchRecord>("jobs", id);
    if (!job) throw new PlannerError("Search not found.", 404);
    // Older Python records predate some optional progress fields.
    job.outcomes ??= {}; job.bundle_links ??= []; job.manual_quote_queries ??= 0; job.messages ??= [];
    return job;
  }
  async status(id: string): Promise<Job> { return this.public(await this.saved(id)); }
  start(tripId: string, budget = 100, jobId?: string, minutes: number | null = null): Promise<Job> {
    return this.serial(tripId, () => this.startRound(tripId, budget, jobId, minutes));
  }
  private async startRound(tripId: string, budget: number, jobId?: string, minutes: number | null = null): Promise<Job> {
    if (!Number.isInteger(budget) || budget < 1 || budget > 500 || minutes !== null && (!Number.isFinite(minutes) || minutes <= 0 || minutes > 1440)) throw new PlannerError("Choose 1 to 500 requests, or a round longer than 0 and no more than 1440 minutes.");
    const started = this.clock.monotonic(), trip = await this.repository.requireTrip(tripId), spec = parseSpec(trip.spec);
    requireMinimumStays(spec);
    if ((await this.repository.list<OptimizationJob>("optimizations")).some(j => j.trip_id === tripId && ["queued", "running", "stopping"].includes(j.status))) throw new PlannerError("Stop checking combinations before starting a transport search.", 409);
    if ((await this.repository.list<SearchRecord>("jobs")).some(j => j.trip_id === tripId && ["queued", "running"].includes(j.status))) throw new PlannerError("This trip already has an active discovery job.", 409);
    if (this.isRunning(tripId)) throw new PlannerError("An in-flight request is finishing. Continue after it stops.", 409);
    const settings = await this.provider.settings(), catalog = await this.airports(), key = discoveryKey(spec);
    let job: SearchRecord;
    if (jobId) {
      job = await this.saved(jobId);
      if (job.trip_id !== tripId || job.discovery_key !== key) throw new PlannerError("Start a new search after changing discovery inputs.", 409);
      if (minutes === null) job.snapshot.label_limit = Math.max(job.snapshot.label_limit || 25000, trip.result?.expanded_labels ?? 0) + Math.max(1000, this.options.labelBatch ?? 25000);
      if (job.cursor === job.queue.length) {
        const latest = new Map(job.queue.slice(0, job.cursor).map(t => [t.key, t]));
        job.queue.push(...[...latest.values()].filter(t => t.outcome === "failed").map(({ outcome: _outcome, ...task }) => task));
      }
      if (settings.transit_enabled && !job.transit_configured) {
        const known = new Set(job.queue.map(t => t.key));
        job.queue.push(...tasksFor(spec, catalog.metros, true).filter(t => t.kind === "transit" && !known.has(t.key)));
      }
    } else {
      const snapshot = await this.repository.get<Snapshot>("graphs", key) ?? trip.snapshot ?? { revision: 0, movements: [], offers: [], roads: {}, coverage: {} };
      const retained = snapshot.movements.filter(m => m.source !== RAIL_FALLBACK_SOURCE);
      if (retained.length !== snapshot.movements.length) { snapshot.movements = retained; snapshot.revision++; }
      snapshot.discovery_key = key;
      job = { id: crypto.randomUUID().replaceAll("-", ""), trip_id: tripId, discovery_key: key, status: "queued", queue: tasksFor(spec, catalog.metros, settings.transit_enabled), cursor: 0,
        snapshot, requests: 0, cache_hits: 0, outcomes: {}, messages: [], bundle_links: [], created: this.clock.wall() / 1000, manual_quote_queries: 0,
        batch_budget: budget, batch_requests: 0, transit_configured: settings.transit_enabled, round_started_at: this.clock.wall() / 1000 };
    }
    separateManualQuotes(job, spec);
    Object.assign(job, { status: "queued", batch_budget: budget, batch_requests: 0, time_budget_seconds: minutes === null ? null : minutes * 60,
      round_started_at: this.clock.wall() / 1000, round_elapsed_seconds: 0, pause_reason: null, transit_configured: settings.transit_enabled });
    if (minutes !== null) this.deadlines.set(job.id, started + minutes * 60_000);
    if (!settings.transit_enabled && spec.modes.some(m => m in TRANSIT_MODES)) { if (!job.messages.includes(TRANSIT_DISABLED)) job.messages.push(TRANSIT_DISABLED); }
    else job.messages = job.messages.filter(m => m !== TRANSIT_DISABLED);
    this.cancelled.delete(job.id);
    await this.repository.put("jobs", job.id, job);
    await this.repository.setLatestJob(tripId, "latest_job_id", job.id);
    this.launch(job, spec); return this.public(job);
  }
  private launch(job: SearchRecord, spec: TripSpec) {
    const active: Active = { job, promise: Promise.resolve(), applying: false };
    this.active.set(job.id, active);
    active.promise = this.run(active, spec);
  }
  async cancel(id: string): Promise<Job> {
    const job = await this.saved(id); this.cancelled.add(id); job.status = "cancelled";
    if (job.phase === "optimization") { job.optimization_pending = true; void this.calculator.stop(job.trip_id).catch(() => {}); }
    await this.repository.put("jobs", id, job); return this.public(job);
  }
  applyChanges(tripId: string, transform: (trip: PlannerTrip) => PlannerTrip): Promise<Job | null> {
    return this.change(tripId, () => this.repository.updateTrip(tripId, transform));
  }
  change(tripId: string, mutate: () => Promise<PlannerTrip>, calculateWhenIdle = true): Promise<Job | null> {
    return this.serial(tripId, () => this.changeRound(tripId, mutate, calculateWhenIdle));
  }
  private async changeRound(tripId: string, mutate: () => Promise<PlannerTrip>, calculateWhenIdle: boolean): Promise<Job | null> {
    const active = [...this.active.values()].find(a => a.job.trip_id === tripId), wasActive = !!active;
    let job = active?.job;
    const deadline = job ? this.deadlines.get(job.id) : undefined;
    if (active) {
      active.applying = true;
      if (active.job.phase === "optimization") active.job.optimization_pending = true;
      active.job.phase = "applying";
      await this.calculator.stop(tripId);
      await active.promise; // An in-flight response is ingested and saved first.
    } else await this.calculator.stop(tripId);
    try {
      const trip = await mutate();
      if (!job && trip.latest_job_id) {
        const candidate = await this.repository.get<SearchRecord>("jobs", trip.latest_job_id);
        if (candidate?.discovery_key === discoveryKey(parseSpec(trip.spec))) job = candidate;
      }
      if (job) {
        const manual = trip.snapshot?.movements.filter(m => m.source === "User-defined connection") ?? [];
        const ids = new Set(manual.map(m => m.id));
        const merged = new Map(job.snapshot.movements.filter(m => m.source !== "User-defined connection" || ids.has(m.id)).map(m => [m.id, m]));
        for (const movement of manual) merged.set(movement.id, movement);
        const movements = [...merged.values()];
        if (JSON.stringify(movements) !== JSON.stringify(job.snapshot.movements)) { job.snapshot.movements = movements; job.snapshot.revision++; }
        job.optimization_pending = true; job.updating_options = true;
        if (!wasActive && job.time_budget_seconds != null && job.status === "complete") { job.status = "paused"; job.pause_reason = "changes"; }
        await this.repository.put("jobs", job.id, job);
      }
    } finally {
      if (active && job) { active.applying = false; await this.resumeEdited(job, deadline); }
    }
    if (calculateWhenIdle && !wasActive && (!job || job.time_budget_seconds == null)) {
      const result = await this.calculator.calculate(tripId, { label_batch: this.options.labelBatch, expansion_budget: this.options.expansionBudget, now: this.clock.wall() * 1000 });
      if (job) { job.optimization_pending = !result.optimization_complete; job.updating_options = false; await this.repository.put("jobs", job.id, job); }
    }
    return job ? this.public(job) : null;
  }
  private async resumeEdited(job: SearchRecord, deadline?: number) {
    if (terminal(job)) return;
    const spec = parseSpec((await this.repository.requireTrip(job.trip_id)).spec);
    if (discoveryKey(spec) !== job.discovery_key) job.status = "superseded";
    else if (deadline !== undefined && this.clock.monotonic() >= deadline) {
      job.status = "paused"; job.pause_reason = "time";
      job.round_elapsed_seconds = Math.max(0, (job.time_budget_seconds ?? 0) + (this.clock.monotonic() - deadline) / 1000);
    } else {
      if (deadline !== undefined) this.deadlines.set(job.id, deadline);
      job.status = "queued"; job.pause_reason = null;
      await this.repository.put("jobs", job.id, job); this.launch(job, spec); return;
    }
    await this.repository.put("jobs", job.id, job);
  }
  private async publish(active: Active, spec: TripSpec, final = false) {
    const job = active.job, catalog = await this.airports(), settings = await this.provider.settings();
    separateManualQuotes(job, spec); updateCoverage(job, spec, settings.transit_enabled);
    await this.calculator.stop(job.trip_id);
    if (!await this.repository.saveDiscovery(job, spec) || this.cancelled.has(job.id) || active.applying) return;
    const trip = await this.repository.requireTrip(job.trip_id), rules = await this.repository.list<PricingRule>("rules"), snapshot = job.snapshot;
    const inputs = fingerprint([trip.revision, trip.spec, trip.offers, trip.airport_connections ?? [], rules, snapshot.movements, snapshot.offers, snapshot.roads ?? {}, snapshot.label_limit]);
    if (this.expired(job)) { job.optimization_pending = this.published.get(job.id) !== inputs || !trip.result?.optimization_complete; return; }
    const controls = fingerprint([trip.revision, rules, snapshot.label_limit]), cadence = this.cadence.get(job.id);
    if (!final && job.status === "running" && cadence && cadence.seconds >= 1 && this.clock.monotonic() - cadence.finished < cadence.seconds * 1000
      && cadence.controls === controls && trip.result && this.published.get(job.id) !== inputs && job.cursor - cadence.cursor < 16) return;
    let result, candidates: BundleCandidate[] = [];
    if (this.published.get(job.id) === inputs && trip.result && (job.time_budget_seconds == null || trip.result.optimization_complete)) {
      result = { ...refreshQuoteFreshness(trip.result, this.clock.wall() * 1000), snapshot_revision: snapshot.revision, coverage: snapshot.coverage };
      await this.repository.saveCalculation(trip.id, trip.revision, trip.snapshot?.revision ?? 0, snapshot, result, await this.repository.checkpoint(trip.id));
    } else {
      const started = this.clock.monotonic(); job.phase = "optimization"; job.optimization_pending = true;
      await this.repository.put("jobs", job.id, job);
      result = await this.calculator.calculate(trip.id, { snapshot, unlimited: this.deadlines.has(job.id), deadline: this.deadlines.get(job.id), label_batch: this.options.labelBatch, expansion_budget: this.options.expansionBudget, now: this.clock.wall() * 1000 });
      candidates = result.bundle_candidates;
      this.cadence.set(job.id, { cursor: job.cursor, seconds: (this.clock.monotonic() - started) / 1000, controls, finished: this.clock.monotonic() });
    }
    job.optimization_pending = !result.optimization_complete;
    if (result.safety_limit_reached) { job.status = "paused"; job.pause_reason = "calculation"; }
    job.updating_options = false;
    enqueueTickets(job, candidates, spec, catalog.metros);
    await this.repository.saveDiscoveryCoverage(job);
    this.published.set(job.id, inputs);
  }
  private async run(active: Active, spec: TripSpec) {
    const job = active.job;
    try {
      if (this.cancelled.has(job.id)) return;
      separateManualQuotes(job, spec); job.status = "running"; await this.repository.put("jobs", job.id, job);
      if (job.optimization_pending || job.updating_options) await this.publish(active, spec, true);
      let publishedFinal = false;
      while (job.status === "running" && !this.expired(job) && (job.time_budget_seconds != null || job.batch_requests < job.batch_budget)) {
        if (job.cursor === job.queue.length) {
          if (job.time_budget_seconds == null) break;
          await this.publish(active, spec, true); publishedFinal = true;
          if (job.cursor === job.queue.length || this.expired(job) || job.status !== "running") break;
        }
        if (this.cancelled.has(job.id)) { job.status = "cancelled"; break; }
        if (active.applying) break;
        const latest = await this.repository.requireTrip(job.trip_id);
        if (discoveryKey(parseSpec(latest.spec)) !== job.discovery_key) { job.status = "superseded"; break; }
        if (this.expired(job)) break;
        const task = job.queue[job.cursor]; publishedFinal = false; job.phase = "discovery";
        let outcome: ProviderOutcome, usedRequest: boolean;
        try { ({ outcome, usedRequest } = await this.provider.fetch(task, spec, job.snapshot)); }
        catch (error) { outcome = { status: "failed", message: String(error).slice(0, 190) }; usedRequest = true; }
        recordOutcome(job, task, outcome, usedRequest, spec, (await this.airports()).metros, this.clock.wall() * 1000);
        if (this.cancelled.has(job.id)) job.status = "cancelled";
        await this.repository.put("jobs", job.id, job);
        if (job.cursor % 4 === 0 || task.kind === "road") { await this.publish(active, spec); await this.repository.put("jobs", job.id, job); }
        if (job.status !== "running") break;
        await yieldBrowser();
      }
      if (!publishedFinal && job.pause_reason !== "calculation") await this.publish(active, spec, true);
      if (job.status === "running") {
        job.status = job.cursor === job.queue.length && (job.time_budget_seconds == null || !job.optimization_pending) ? "complete" : "paused";
        if (job.status === "paused") job.pause_reason = this.expired(job) ? "time" : "requests";
        if (active.applying) { job.status = "paused"; job.pause_reason = "applying"; }
      }
    } catch (error) {
      job.status = "failed"; job.messages.push("Planner: " + String(error).slice(0, 190));
    } finally {
      if (this.deadlines.has(job.id)) job.round_elapsed_seconds = this.public(job).round_elapsed_seconds;
      await this.repository.put("jobs", job.id, job);
      this.deadlines.delete(job.id);
      if (this.active.get(job.id) === active) this.active.delete(job.id);
      this.published.delete(job.id); this.cadence.delete(job.id);
    }
  }
}
