import { parseSolverInput } from "./contracts";
import { prepareSolverInput } from "./preparation";
import type { PlannerTrip, Snapshot } from "./preparation";
import type { SolverInput } from "./types";

/** A prepared input is explicit; a saved trip must replay all its overlays. */
export function importSolverInput(value: unknown, now = Date.now() * 1000): SolverInput {
  if (!value || typeof value !== "object") throw new Error("Import solver input or a full trip graph JSON.");
  const data = value as Record<string, unknown>;
  if (data.input) return importSolverInput(data.input, now);
  if (!data.spec) throw new Error("Import solver input or a full trip graph JSON.");
  if (!Object.hasOwn(data, "snapshot") && !Object.hasOwn(data, "graph")) return parseSolverInput(data);
  const graph = (data.graph ?? data.snapshot ?? { revision: 0, movements: [], offers: [] }) as Partial<Snapshot>;
  if (!Array.isArray(graph.movements) || !Array.isArray(graph.offers)) throw new Error("A saved graph needs movements and offers.");
  const trip = { ...data, id: data.id ?? "comparison-import", revision: data.revision ?? data.trip_revision ?? 0, latest_job_id: data.latest_job_id ?? null,
    offers: data.offers ?? [], snapshot: { ...graph, revision: graph.revision ?? 0, coverage: graph.coverage ?? {} } } as unknown as PlannerTrip;
  const rules = parseSolverInput({ spec: data.spec, movements: [], offers: [], rules: data.rules ?? [] }).rules;
  const prepared = prepareSolverInput(trip, rules, { now, unlimited: true });
  // Comparison requests run to completion unless the imported input explicitly
  // limits it. Production browser search chooses its own resumable allowances.
  return parseSolverInput({ ...prepared.input, snapshot_revision: data.snapshot_revision ?? prepared.input.snapshot_revision,
    finish_at_home: data.finish_at_home ?? true, include_dominated: data.include_dominated ?? false,
    label_limit: data.label_limit ?? null, expansion_budget: data.expansion_budget ?? null });
}
