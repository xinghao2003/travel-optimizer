import type { SolverInput, SolverResult } from "./native/types";

export type Measurement = { result: SolverResult; solve_ms: number; validation_ms?: number; wall_ms: number; wasm_memory_bytes?: number };
export class SolverRunner {
  private worker: Worker;
  private sequence = 0;
  private pending = new Map<number, { resolve(value: Measurement): void; reject(error: Error): void; began: number }>();
  constructor(readonly kind: "native" | "python", onStatus: (message: string) => void = () => {}) {
    this.worker = kind === "native" ? new Worker(new URL("./native/worker.ts", import.meta.url), { type: "module" })
      : new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
    this.worker.onmessage = event => {
      const { id, result, error, status, ...metrics } = event.data;
      if (status) { onStatus(status); return; }
      const pending = this.pending.get(id); if (!pending) return;
      this.pending.delete(id);
      if (error) { pending.reject(new Error(error)); return; }
      const data = kind === "python" ? JSON.parse(result) : { result, ...metrics };
      pending.resolve({ ...data, ...metrics, wall_ms: performance.now() - pending.began });
    };
    this.worker.onerror = event => { for (const pending of this.pending.values()) pending.reject(new Error(event.message)); this.pending.clear(); };
  }
  run(input: SolverInput) {
    return new Promise<Measurement>((resolve, reject) => {
      const id = ++this.sequence;
      this.pending.set(id, { resolve, reject, began: performance.now() });
      this.worker.postMessage(this.kind === "native" ? { id, input, fresh: true } : { id, method: "reference_solve", args: [input] });
    });
  }
  close() { this.worker.terminate(); for (const pending of this.pending.values()) pending.reject(new Error("Comparison stopped.")); this.pending.clear(); }
}

export type Difference = { path: string; expected: unknown; actual: unknown };
export function firstDifference(expected: unknown, actual: unknown, path = ""): Difference | null {
  if (expected === actual) return null;
  if (typeof expected === "number" && typeof actual === "number" && Math.abs(expected - actual) < 1e-8 && !/cost|price|cents|\/(?:low|high|fare_amount)$/.test(path)) return null;
  if (Array.isArray(expected) !== Array.isArray(actual)) return { path, expected, actual };
  if (expected !== null && actual !== null && typeof expected === "object" && typeof actual === "object") {
    const a = expected as Record<string, unknown>, b = actual as Record<string, unknown>;
    for (const key of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
      const mismatch = firstDifference(a[key], b[key], `${path}/${key}`); if (mismatch) return mismatch;
    }
    return null;
  }
  return { path, expected, actual };
}
