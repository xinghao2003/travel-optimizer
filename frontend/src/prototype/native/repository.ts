/** Persistent browser records, with synchronous transforms inside IDB requests. */
import type { PricingRule, Result, SavedSummary, TripSpec } from "../../lib/planner";
import { parseRule, parseSpec } from "./contracts";
import { discoveryKey } from "./discovery-key";
import { PlannerError, requireMinimumStays, requireRevision } from "./edits";
import type { PlannerTrip, Snapshot } from "./preparation";
import type { SearchState } from "./types";
import { parseBackup } from "./backup";
import type { PlannerBackup } from "./backup";
import type { SearchRecord } from "./search-state";
import { shareableSnapshot } from "./preparation";

export const DATABASE_VERSION = 1;
export const CHECKPOINT_VERSION = 4;
export type Collection = "trips" | "rules" | "graphs" | "jobs" | "optimizations" | "meta";
export type StoredRecord<T = unknown> = { schema_version: 1; collection: Collection; id: string; updated: number; payload: T };
type Checkpoint = { trip_id: string; version: number; state: SearchState };
type CacheEntry = { key: string; expires: number; payload: unknown };
type Transaction<T> = { tx: IDBTransaction; result(value: T): void; read<U>(request: IDBRequest<U>, consume: (value: U) => void): void };
const range = (collection: Collection) => IDBKeyRange.bound([collection], [collection, []]);
const row = (collection: Collection, id: string, payload: unknown): StoredRecord => ({ schema_version: 1, collection, id, updated: Date.now(), payload });
function payload<T>(value: StoredRecord<T> | undefined): T | undefined {
  if (value && value.schema_version !== 1) throw new Error("Unsupported saved browser record version.");
  return value?.payload;
}

export class PlannerRepository {
  private opening?: Promise<IDBDatabase>;
  constructor(readonly name = "wayfinder-planner") {}

  private open(): Promise<IDBDatabase> {
    return this.opening ??= new Promise((resolve, reject) => {
      const request = indexedDB.open(this.name, DATABASE_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        db.createObjectStore("records", { keyPath: ["collection", "id"] });
        db.createObjectStore("checkpoints", { keyPath: "trip_id" });
        db.createObjectStore("provider_cache", { keyPath: "key" }).createIndex("expires", "expires");
      };
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error("Close older planner tabs, then reload to update browser storage."));
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => db.close();
        // Provider expiry cannot remove saved graphs, user edits, or checkpoints.
        const tx = db.transaction("provider_cache", "readwrite");
        const cursor = tx.objectStore("provider_cache").index("expires").openCursor(IDBKeyRange.upperBound(Date.now()));
        cursor.onsuccess = () => { if (cursor.result) { cursor.result.delete(); cursor.result.continue(); } };
        tx.oncomplete = () => resolve(db);
        tx.onabort = () => { db.close(); reject(tx.error ?? new Error("Could not open browser storage.")); };
      };
    });
  }
  async ready(): Promise<void> { await this.open(); }
  async close(): Promise<void> { const db = this.opening && await this.opening; db?.close(); this.opening = undefined; }

  private async transaction<T>(stores: string[], mode: IDBTransactionMode, start: (context: Transaction<T>) => void): Promise<T> {
    const db = await this.open();
    return new Promise<T>((resolve, reject) => {
      const tx = db.transaction(stores, mode);
      let value: T, failure: unknown;
      const abort = (error: unknown) => { failure = error; tx.abort(); };
      tx.oncomplete = () => resolve(value);
      tx.onabort = () => reject(failure ?? tx.error ?? new Error("Browser storage transaction was aborted."));
      const context: Transaction<T> = { tx, result: result => { value = result; }, read: (request, consume) => {
        request.onsuccess = () => { try { consume(request.result); } catch (error) { abort(error); } };
      } };
      try { start(context); } catch (error) { abort(error); }
    });
  }
  get<T>(collection: Collection, id: string): Promise<T | undefined> {
    return this.transaction(["records"], "readonly", c => c.read(c.tx.objectStore("records").get([collection, id]), value => c.result(payload<T>(value))));
  }
  list<T>(collection: Collection): Promise<T[]> {
    return this.transaction(["records"], "readonly", c => c.read(c.tx.objectStore("records").getAll(range(collection)), values => {
      c.result((values as StoredRecord<T>[]).sort((a, b) => b.updated - a.updated).map(value => payload(value)!));
    }));
  }
  put<T>(collection: Collection, id: string, value: T): Promise<T> {
    return this.transaction(["records"], "readwrite", c => { c.tx.objectStore("records").put(row(collection, id, value)); c.result(value); });
  }
  remove(collection: Collection, id: string): Promise<void> {
    return this.transaction(["records"], "readwrite", c => { c.tx.objectStore("records").delete([collection, id]); });
  }
  summaries(): Promise<SavedSummary[]> {
    return this.list<PlannerTrip>("trips").then(trips => trips.map(t => ({ id: t.id, revision: t.revision, name: t.spec.name, start_date: t.spec.start_date, end_date: t.spec.end_date })));
  }
  async requireTrip(id: string): Promise<PlannerTrip> {
    const trip = await this.get<PlannerTrip>("trips", id);
    if (!trip) throw new PlannerError("Trip not found.", 404);
    return trip;
  }
  createTrip(raw: unknown): Promise<PlannerTrip> {
    const spec = parseSpec(raw); requireMinimumStays(spec);
    const id = crypto.randomUUID().replaceAll("-", "");
    return this.put("trips", id, { id, revision: 1, spec, snapshot: null, latest_job_id: null, offers: [], airport_connections: [] });
  }
  async duplicateTrip(id: string): Promise<PlannerTrip> {
    const source = await this.requireTrip(id), spec = parseSpec(source.spec), suffix = " (copy)";
    spec.name = [...spec.name].slice(0, 120 - suffix.length).join("").trimEnd() + suffix;
    const copyId = crypto.randomUUID().replaceAll("-", "");
    return this.put("trips", copyId, { id: copyId, revision: 1, spec, snapshot: null, latest_job_id: null, offers: [],
      airport_connections: source.airport_connections ?? [], airport_transfer_estimates: source.airport_transfer_estimates ?? [] });
  }
  updateTrip(id: string, transform: (trip: PlannerTrip) => PlannerTrip, shareGraph = false): Promise<PlannerTrip> {
    return this.transaction(["records", "checkpoints"], "readwrite", c => {
      const records = c.tx.objectStore("records");
      c.read(records.get(["trips", id]), raw => {
        const current = payload<PlannerTrip>(raw);
        if (!current) throw new PlannerError("Trip not found.", 404);
        const next = transform(current);
        if (next.id !== id) throw new Error("A trip update cannot change its ID.");
        records.put(row("trips", id, next));
        if (shareGraph && next.snapshot) records.put(row("graphs", discoveryKey(parseSpec(next.spec)), next.snapshot));
        c.tx.objectStore("checkpoints").delete(id);
        c.result(next);
      });
    });
  }
  setLatestJob(id: string, field: "latest_job_id" | "latest_optimization_id", jobId: string): Promise<void> {
    return this.transaction(["records"], "readwrite", c => {
      const records = c.tx.objectStore("records");
      c.read(records.get(["trips", id]), value => {
        const trip = payload<PlannerTrip>(value);
        if (!trip) throw new PlannerError("Trip not found.", 404);
        trip[field] = jobId; records.put(row("trips", id, trip));
      });
    });
  }
  updateSpec(id: string, raw: unknown, revision: number): Promise<PlannerTrip> {
    const spec = parseSpec(raw); requireMinimumStays(spec);
    return this.transaction(["records", "checkpoints"], "readwrite", c => {
      const records = c.tx.objectStore("records");
      c.read(records.get(["trips", id]), value => {
        const trip = payload<PlannerTrip>(value);
        if (!trip) throw new PlannerError("Trip not found.", 404);
        requireRevision(trip, revision);
        const changed = discoveryKey(parseSpec(trip.spec)) !== discoveryKey(spec);
        c.read(records.get(["graphs", discoveryKey(spec)]), cached => {
          if (changed) {
            trip.snapshot = payload<Snapshot>(cached) ?? trip.snapshot;
            if (trip.snapshot) { trip.snapshot.coverage ??= {}; trip.snapshot.coverage.discovery_complete = false; }
          }
          trip.spec = spec; trip.revision++; delete trip.result;
          records.put(row("trips", id, trip)); c.tx.objectStore("checkpoints").delete(id); c.result(trip);
        });
      });
    });
  }
  deleteTrip(id: string): Promise<void> {
    return this.transaction(["records", "checkpoints"], "readwrite", c => {
      const records = c.tx.objectStore("records");
      c.read(records.get(["trips", id]), trip => {
        if (!trip) throw new PlannerError("Trip not found.", 404);
        c.read(records.getAll(range("jobs")), jobs => c.read(records.getAll(range("optimizations")), optimizations => {
          const related = ([...jobs, ...optimizations] as StoredRecord<Record<string, unknown>>[]).filter(item => item.payload.trip_id === id);
          for (const item of related) if (["running", "queued", "stopping"].includes(String(item.payload.status))) throw new PlannerError(item.collection === "jobs" ? "Cancel discovery before deleting this trip." : "Stop checking combinations before deleting this trip.", 409);
          c.read(records.get(["meta", "selected-trip"]), selected => {
            for (const item of related) records.delete([item.collection, item.id]);
            if (payload<string>(selected) === id) records.put(row("meta", "selected-trip", null));
            records.delete(["trips", id]); c.tx.objectStore("checkpoints").delete(id);
          });
        }));
      });
    });
  }
  editRule(id: string, raw: unknown | null): Promise<PricingRule | null> {
    const rule = raw === null ? null : { ...parseRule(raw), id };
    return this.transaction(["records", "checkpoints"], "readwrite", c => {
      const records = c.tx.objectStore("records");
      if (rule) records.put(row("rules", id, rule)); else records.delete(["rules", id]);
      c.read(records.getAll(range("trips")), values => {
        for (const value of values as StoredRecord<PlannerTrip>[]) {
          const trip = payload(value)!; trip.revision++;
          records.put(row("trips", trip.id, trip)); c.tx.objectStore("checkpoints").delete(trip.id);
        }
        c.result(rule);
      });
    });
  }
  checkpoint(tripId: string): Promise<SearchState | undefined> {
    return this.transaction(["checkpoints"], "readonly", c => c.read(c.tx.objectStore("checkpoints").get(tripId), (value: Checkpoint | undefined) => c.result(value?.version === CHECKPOINT_VERSION ? value.state : undefined)));
  }
  saveDiscovery(job: SearchRecord, spec: TripSpec): Promise<boolean> {
    return this.transaction(["records"], "readwrite", c => {
      const records = c.tx.objectStore("records");
      c.read(records.get(["trips", job.trip_id]), value => {
        const trip = payload<PlannerTrip>(value);
        if (!trip) { job.status = "cancelled"; records.put(row("jobs", job.id, job)); c.result(false); return; }
        const manual = trip.snapshot?.movements.filter(m => m.source === "User-defined connection") ?? [];
        const merged = new Map(job.snapshot.movements.map(m => [m.id, m]));
        for (const m of manual) merged.set(m.id, m);
        const movements = [...merged.values()];
        if (JSON.stringify(movements) !== JSON.stringify(job.snapshot.movements)) job.snapshot.revision++;
        job.snapshot.movements = movements;
        job.snapshot.coverage.unresolved_movements = movements.filter(m => m.usable === false).map(m => ({ id: m.id, from_id: m.from_id, to_id: m.to_id, assumptions: m.assumptions }));
        records.put(row("graphs", job.discovery_key, shareableSnapshot(job.snapshot, spec)));
        const matches = discoveryKey(parseSpec(trip.spec)) === job.discovery_key;
        if (matches) { trip.snapshot = job.snapshot; records.put(row("trips", trip.id, trip)); }
        else job.status = "superseded";
        records.put(row("jobs", job.id, job)); c.result(matches);
      });
    });
  }
  saveDiscoveryCoverage(job: SearchRecord): Promise<void> {
    return this.transaction(["records"], "readwrite", c => {
      const records = c.tx.objectStore("records");
      c.read(records.get(["graphs", job.discovery_key]), value => {
        const graph = payload<Snapshot>(value);
        if (graph) { graph.coverage = { ...job.snapshot.coverage, unresolved_movements: graph.coverage.unresolved_movements }; records.put(row("graphs", job.discovery_key, graph)); }
      });
      c.read(records.get(["trips", job.trip_id]), value => {
        const trip = payload<PlannerTrip>(value);
        if (trip?.snapshot && discoveryKey(parseSpec(trip.spec)) === job.discovery_key) {
          trip.snapshot.coverage = { ...trip.snapshot.coverage, ...Object.fromEntries(Object.entries(job.snapshot.coverage).filter(([key]) => !["unresolved_movements", "airport_connections_required"].includes(key))) };
          if (trip.result) trip.result.coverage = trip.snapshot.coverage;
          records.put(row("trips", trip.id, trip));
        }
        records.put(row("jobs", job.id, job));
      });
    });
  }
  saveCalculation(id: string, revision: number, sourceSnapshotRevision: number, snapshot: Snapshot, result: Result, state?: SearchState): Promise<boolean> {
    return this.transaction(["records", "checkpoints"], "readwrite", c => {
      const records = c.tx.objectStore("records");
      c.read(records.get(["trips", id]), value => {
        const trip = payload<PlannerTrip>(value);
        if (!trip || trip.revision !== revision || (trip.snapshot?.revision ?? 0) !== sourceSnapshotRevision) { c.result(false); return; }
        trip.result = result;
        if (trip.snapshot) trip.snapshot = snapshot;
        records.put(row("trips", id, trip));
        const checkpoints = c.tx.objectStore("checkpoints");
        if (state && !result.optimization_complete) checkpoints.put({ trip_id: id, version: CHECKPOINT_VERSION, state } satisfies Checkpoint);
        else checkpoints.delete(id);
        c.result(true);
      });
    });
  }
  getCache<T>(key: string, now = Date.now()): Promise<T | undefined> {
    return this.transaction(["provider_cache"], "readonly", c => c.read(c.tx.objectStore("provider_cache").get(key), (value: CacheEntry | undefined) => c.result(value && value.expires > now ? value.payload as T : undefined)));
  }
  putCache(key: string, value: unknown, ttlSeconds: number, now = Date.now()): Promise<void> {
    return this.transaction(["provider_cache"], "readwrite", c => {
      const store = c.tx.objectStore("provider_cache");
      store.put({ key, payload: value, expires: now + ttlSeconds * 1000 });
      c.read(store.index("expires").openCursor(IDBKeyRange.upperBound(now)), cursor => { if (cursor) { cursor.delete(); cursor.continue(); } });
    });
  }
  pruneCache(now = Date.now()): Promise<number> {
    return this.transaction(["provider_cache"], "readwrite", c => {
      let removed = 0;
      c.read(c.tx.objectStore("provider_cache").index("expires").openCursor(IDBKeyRange.upperBound(now)), cursor => {
        if (cursor) { cursor.delete(); removed++; cursor.continue(); }
        c.result(removed);
      });
    });
  }
  exportBackup(): Promise<PlannerBackup> {
    return this.transaction(["records"], "readonly", c => c.read(c.tx.objectStore("records").getAll(), records => {
      c.result({ format: "wayfinder-browser-backup", schema_version: 1, exported_at: new Date().toISOString(), records });
    }));
  }
  importBackup(raw: unknown, overwrite = false): Promise<number> {
    // Validate every record before opening a write transaction.
    const backup = parseBackup(raw);
    return this.transaction(["records", "checkpoints"], "readwrite", c => {
      const records = c.tx.objectStore("records"), checkpoints = c.tx.objectStore("checkpoints");
      c.read(records.getAll(), existing => {
        const old = existing as StoredRecord[], keys = new Set(old.map(r => JSON.stringify([r.collection, r.id])));
        const tripIds = new Set(backup.records.filter(r => r.collection === "trips").map(r => r.id));
        const importedKeys = new Set(backup.records.map(r => JSON.stringify([r.collection, r.id])));
        if (!overwrite && [...importedKeys].some(key => keys.has(key))) throw new PlannerError("A backup record already exists. Choose replacement explicitly to overwrite it.", 409);
        for (const item of old) if (["jobs", "optimizations"].includes(item.collection)) {
          const job = item.payload as Record<string, unknown>;
          if ((tripIds.has(String(job.trip_id)) || importedKeys.has(JSON.stringify([item.collection, item.id]))) && ["running", "queued", "stopping"].includes(String(job.status))) throw new PlannerError("Stop active searches and calculations before replacing their records.", 409);
          if (tripIds.has(String(job.trip_id)) && !importedKeys.has(JSON.stringify([item.collection, item.id]))) records.delete([item.collection, item.id]);
        }
        const changesRules = backup.records.some(r => r.collection === "rules");
        if (changesRules) for (const item of old) if (item.collection === "trips" && !tripIds.has(item.id)) {
          const trip = item.payload as PlannerTrip;
          records.put(row("trips", item.id, { ...trip, revision: trip.revision + 1 })); checkpoints.delete(item.id);
        }
        const oldTrips = new Map(old.filter(r => r.collection === "trips").map(r => [r.id, r.payload as PlannerTrip]));
        const extraRules = old.some(r => r.collection === "rules" && !importedKeys.has(JSON.stringify([r.collection, r.id])));
        for (const item of backup.records) {
          if (item.collection === "trips") {
            const trip = item.payload as PlannerTrip, previous = oldTrips.get(item.id);
            if (previous || extraRules) item.payload = { ...trip, revision: Math.max(trip.revision + Number(extraRules), (previous?.revision ?? -1) + 1) };
            checkpoints.delete(item.id);
          }
          records.put(item);
        }
        c.result(backup.records.length);
      });
    });
  }
}
