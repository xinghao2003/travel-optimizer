/** The existing Planner's request contract, executed against browser-owned data. */
import type { Job, JourneyGroupField, OptimizationJob, PlannerConfig, PricingRule } from "../../lib/planner";
import { BrowserCalculator } from "./calculation";
import type { CalculationOptions } from "./calculation";
import { parseInteger, parseFiniteNumber, parseConnection, parseTransfer } from "./contracts";
import { addAssumedMovement, applyMissingInfo, connectionPayload, editFare, expectedRevision, parseApplyChanges, parseSharedFare,
  PlannerError, removeAssumedMovement, removeJourneyRule, requireMinimumStays, requireRevision, reuseJourneyEstimate, saveSharedEstimates, transferPayload } from "./edits";
import { loadAirportCatalog } from "./catalog";
import { loadPlaces } from "./places";
import type { AirportCatalog, PlannerTrip } from "./preparation";
import { refreshQuoteFreshness, tripMetadata } from "./preparation";
import { PlannerRepository } from "./repository";
import { BrowserDiscovery } from "./search";
import { BrowserProviders } from "./providers";
import type { SearchProvider } from "./providers";
import { NATIVE_SOLVER_REVISION } from "./types";

type Continuous = { job: OptimizationJob; promise: Promise<void> };
function object(value: unknown): Record<string, unknown> {
  if (value == null || typeof value !== "object" || Array.isArray(value)) throw new PlannerError("Enter a JSON object.");
  return value as Record<string, unknown>;
}
function list(value: unknown, maximum: number): unknown[] {
  if (!Array.isArray(value) || value.length > maximum) throw new PlannerError("Invalid list or too many items.");
  return value;
}

export class BrowserPlannerApi {
  readonly calculator: BrowserCalculator;
  readonly discovery: BrowserDiscovery;
  readonly providers: SearchProvider;
  private continuous = new Map<string, Continuous>();
  private opening?: Promise<void>;
  constructor(readonly repository = new PlannerRepository(), readonly airports: () => Promise<AirportCatalog> = loadAirportCatalog, provider?: SearchProvider) {
    this.calculator = new BrowserCalculator(repository);
    this.providers = provider ?? new BrowserProviders(repository, airports);
    this.discovery = new BrowserDiscovery(repository, this.calculator, this.providers, airports);
  }
  ready(): Promise<void> {
    return this.opening ??= (async () => {
      // One owner may recover jobs and write calculation frontiers. Navigation
      // releases this lock automatically, including when the tab is closed.
      await new Promise<void>((resolve, reject) => {
        if (!navigator.locks) { reject(new Error("Open the planner in a browser with Web Locks support over HTTPS or localhost.")); return; }
        void navigator.locks.request("wayfinder-planner:" + this.repository.name, { ifAvailable: true }, async lock => {
          if (!lock) { reject(new PlannerError("The planner is already open in another tab. Close that tab and reload this one.", 409)); return; }
          resolve();
          await new Promise<void>(() => {});
        }).catch(reject);
      });
      await this.repository.ready();
      // Persisted jobs cannot retain workers or requests across a page reload.
      for (const collection of ["jobs", "optimizations"] as const) for (const job of await this.repository.list<Job | OptimizationJob>(collection)) {
        if (["queued", "running", "stopping"].includes(job.status)) await this.repository.put(collection, job.id,
          { ...job, status: "interrupted", ...(collection === "optimizations" ? { pause_reason: "shutdown" } : { updating_options: false }) });
      }
    })();
  }
  async config(): Promise<PlannerConfig> { return { transit_routing_configured: (await this.providers.settings()).transit_enabled }; }
  async readTrip(id: string) {
    const trip = await this.repository.requireTrip(id);
    if (trip.result) {
      trip.result = refreshQuoteFreshness(trip.result, Date.now() * 1000);
      if (trip.native_solver_revision !== NATIVE_SOLVER_REVISION) trip.result.trip_revision = -1;
    }
    return { ...trip, ...tripMetadata(trip, await this.airports()) };
  }
  private async stopForEdit(id: string) {
    for (const active of this.continuous.values()) if (active.job.trip_id === id) { await this.stopContinuous(active.job.id, "changes"); await active.promise; }
    if (!this.discovery.isRunning(id)) await this.calculator.stop(id);
  }
  private async calculate(id: string, options: CalculationOptions = {}) {
    const { bundle_candidates: _candidates, ...result } = await this.calculator.calculate(id, options); return result;
  }
  private async edit(id: string, transform: (trip: PlannerTrip) => PlannerTrip, shareGraph = false) {
    await this.stopForEdit(id);
    await this.discovery.change(id, () => this.repository.updateTrip(id, transform, shareGraph), false);
    return this.calculate(id);
  }
  private async applied(id: string, transform: (trip: PlannerTrip) => PlannerTrip) {
    await this.stopForEdit(id);
    const job = await this.discovery.applyChanges(id, transform);
    return { trip: await this.readTrip(id), job, updating: !!job?.updating_options };
  }
  async startContinuous(id: string): Promise<OptimizationJob> {
    for (const active of this.continuous.values()) {
      if (active.job.trip_id === id) return structuredClone(active.job);
      throw new PlannerError("Stop the other continuous calculation before starting this one.", 409);
    }
    const trip = await this.repository.requireTrip(id); requireMinimumStays(trip.spec);
    if (!trip.snapshot) throw new PlannerError("Search transport before checking saved combinations.", 409);
    if ((await this.repository.list<Job>("jobs")).some(j => j.trip_id === id && ["queued", "running"].includes(j.status))) throw new PlannerError("Stop the transport search before checking combinations continuously.", 409);
    if (this.discovery.isRunning(id)) throw new PlannerError("Wait for the in-flight transport request to finish before checking combinations.", 409);
    const job: OptimizationJob = { id: crypto.randomUUID().replaceAll("-", ""), trip_id: id, trip_revision: trip.revision, status: "queued", batches: 0,
      expanded_labels: trip.result?.expanded_labels ?? 0, checkpoint_bytes: 0, pause_reason: null };
    await this.repository.put("optimizations", job.id, job);
    await this.repository.setLatestJob(id, "latest_optimization_id", job.id);
    const active = { job, promise: Promise.resolve() };
    this.continuous.set(job.id, active);
    active.promise = this.runContinuous(job).finally(() => { this.continuous.delete(job.id); });
    return structuredClone(job);
  }
  private async runContinuous(job: OptimizationJob) {
    try {
      if (job.status !== "stopping") job.status = "running";
      await this.repository.put("optimizations", job.id, job);
      const stopping = () => job.status === "stopping";
      while (!stopping()) {
        const trip = await this.repository.requireTrip(job.trip_id);
        if (trip.revision !== job.trip_revision) { job.status = "paused"; job.pause_reason = "changes"; break; }
        if (stopping()) break;
        if (trip.native_solver_revision === NATIVE_SOLVER_REVISION && trip.result?.optimization_complete && trip.result.trip_revision === trip.revision && trip.result.snapshot_revision === trip.snapshot?.revision
          && (!trip.spec.exclude_unpriced_flights || trip.result.flight_price_revision === 2)) { job.status = "complete"; break; }
        const result = await this.calculator.calculate(job.trip_id, { expand: true, unlimited: true });
        job.batches++; job.expanded_labels = result.expanded_labels;
        const checkpoint = await this.repository.checkpoint(job.trip_id);
        // Browser checkpoint size is its portable representation, not Python pickle bytes.
        job.checkpoint_bytes = checkpoint ? new Blob([JSON.stringify(checkpoint, (_key, value) => typeof value === "bigint" ? value.toString() : value instanceof Map ? [...value] : value)]).size : 0;
        if ((await this.repository.requireTrip(job.trip_id)).revision !== job.trip_revision) { job.status = "paused"; job.pause_reason = "changes"; break; }
        if (stopping()) break;
        if (result.optimization_complete) { job.status = "complete"; break; }
        await this.repository.put("optimizations", job.id, job);
      }
      if (job.status === "stopping") job.status = job.pause_reason === "changes" ? "paused" : "cancelled";
    } catch (error) { job.status = "failed"; job.message = String(error); }
    await this.repository.put("optimizations", job.id, job);
  }
  async stopContinuous(id: string, reason: "changes" | "user" = "user"): Promise<OptimizationJob> {
    const active = this.continuous.get(id), job = active?.job ?? await this.repository.get<OptimizationJob>("optimizations", id);
    if (!job) throw new PlannerError("Calculation not found.", 404);
    if (active) {
      job.status = "stopping"; job.pause_reason = reason;
      await this.repository.put("optimizations", id, job);
      await this.calculator.stop(job.trip_id);
    }
    return structuredClone(job);
  }
  async request(path: string, method = "GET", raw?: unknown): Promise<unknown> {
    await this.ready();
    const url = new URL(path, "https://planner.local"), parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    const [collection, id, action, key] = parts, body = raw === undefined ? {} : object(raw);
    if (collection === "places" && method === "GET") {
      const places = await loadPlaces();
      if (id === "nearest" && (!url.searchParams.has("latitude") || !url.searchParams.has("longitude"))) throw new PlannerError("Latitude and longitude are required.");
      return { places: id === "nearest" ? places.nearest(Number(url.searchParams.get("latitude")), Number(url.searchParams.get("longitude")), url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : 5)
        : places.search(url.searchParams.get("search") ?? "", url.searchParams.has("limit") ? Number(url.searchParams.get("limit")) : 16) };
    }
    if (collection === "pricing-rules") {
      if (!id && method === "GET") return { rules: await this.repository.list<PricingRule>("rules") };
      if (id && ["PUT", "DELETE"].includes(method)) {
        for (const trip of await this.repository.list<PlannerTrip>("trips")) await this.stopForEdit(trip.id);
        const rule = await this.repository.editRule(id, method === "DELETE" ? null : body);
        return method === "DELETE" ? { deleted: true } : rule;
      }
    }
    if (collection === "optimizations" && id) {
      if (method === "POST" && action === "stop") return this.stopContinuous(id);
      if (method === "GET") {
        const job = this.continuous.get(id)?.job ?? await this.repository.get<OptimizationJob>("optimizations", id);
        if (!job) throw new PlannerError("Calculation not found.", 404);
        return structuredClone(job);
      }
    }
    if (collection === "searches" && id) {
      if (method === "GET") return this.discovery.status(id);
      if (method === "POST" && action === "cancel") return this.discovery.cancel(id);
      if (method === "POST" && action === "continue") {
        const job = await this.discovery.status(id);
        return this.discovery.start(job.trip_id, body.budget === undefined ? 100 : parseInteger(body.budget), id, body.minutes == null ? null : parseFiniteNumber(body.minutes));
      }
    }
    if (collection === "trips") {
      if (!id && method === "GET") return { trips: await this.repository.summaries() };
      if (!id && method === "POST") return this.repository.createTrip(raw);
      if (id && !action) {
        if (method === "GET") return this.readTrip(id);
        if (method === "DELETE") { await this.repository.deleteTrip(id); return { deleted: true }; }
        if (method === "PUT") { await this.stopForEdit(id); await this.discovery.change(id, () => this.repository.updateSpec(id, body.spec, expectedRevision(body.expected_revision)), false); return this.readTrip(id); }
      }
      if (method === "POST" && action === "duplicate") return this.repository.duplicateTrip(id);
      if (method === "POST" && action === "searches") return this.discovery.start(id, body.budget === undefined ? 100 : parseInteger(body.budget), undefined, body.minutes == null ? null : parseFiniteNumber(body.minutes));
      if (method === "POST" && action === "optimize") {
        for (const flag of ["expand", "include_dominated"] as const) if (body[flag] !== undefined && typeof body[flag] !== "boolean") throw new PlannerError("Invalid calculation flag.");
        const options: CalculationOptions = { expand: body.expand as boolean | undefined, include_dominated: body.include_dominated as boolean | undefined,
          minutes: body.minutes == null ? null : parseFiniteNumber(body.minutes) };
        return this.calculate(id, options);
      }
      if (method === "POST" && action === "optimizations") return this.startContinuous(id);
      if (method === "POST" && action === "apply") { const changes = parseApplyChanges(body), catalog = await this.airports(); return this.applied(id, trip => applyMissingInfo(trip, changes, catalog)); }
      if (action === "journey-pricing-rules") {
        if (method === "DELETE" && key) return this.applied(id, trip => removeJourneyRule(trip, key, expectedRevision(url.searchParams.get("expected_revision"))));
        if (method === "POST" && key === "reuse") {
          const request = { ...parseSharedFare(body), expected_revision: expectedRevision(body.expected_revision), group_by: list(body.group_by, 7) as JourneyGroupField[] }, catalog = await this.airports();
          return this.applied(id, trip => reuseJourneyEstimate(trip, request, catalog));
        }
      }
      if (action === "fares") {
        if (method === "PUT" && key) return this.edit(id, trip => editFare(trip, key, body));
        if (method === "DELETE" && key) return this.edit(id, trip => ({ ...trip, offers: trip.offers.filter(o => o.id !== key), revision: trip.revision + 1 }));
        if (method === "POST" && (key === "batch" || key === "estimates")) {
          const estimates = (key === "batch" ? [body] : list(body.estimates, 5000)).map(parseSharedFare);
          return this.edit(id, trip => saveSharedEstimates(trip, estimates, expectedRevision(body.expected_revision)));
        }
      }
      if (method === "PUT" && action === "airport-connections") {
        const connections = connectionPayload(list(body.connections, 120).map(parseConnection));
        return this.edit(id, trip => ({ ...trip, airport_connections: connections, revision: trip.revision + 1 }));
      }
      if (method === "PUT" && action === "airport-transfer-estimates") {
        const estimates = list(body.estimates, 240).map(parseTransfer), catalog = await this.airports();
        await this.applied(id, trip => { requireRevision(trip, expectedRevision(body.expected_revision)); const next = { ...trip, airport_transfer_estimates: transferPayload(trip, estimates, catalog), revision: trip.revision + 1 }; delete next.result; return next; });
        return this.readTrip(id);
      }
      if (action === "movements") {
        if (method === "POST") return this.edit(id, trip => addAssumedMovement(trip, body), true);
        if (method === "DELETE" && key) return this.edit(id, trip => removeAssumedMovement(trip, key, parseInteger(url.searchParams.get("expected_revision"))), true);
      }
    }
    throw new PlannerError("Planner operation not found.", 404);
  }
}
