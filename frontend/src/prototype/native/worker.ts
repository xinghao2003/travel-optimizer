import { solveNative } from "./solver";
import type { SearchState, SolverInput } from "./types";

let state: SearchState | undefined;
self.onmessage = event => {
  const { id, input, seconds = Infinity, fresh = true, checkpoint, exportCheckpoint } = event.data as {
    id: number; input: SolverInput; seconds?: number; fresh?: boolean; checkpoint?: SearchState; exportCheckpoint?: boolean;
  };
  try {
    if (fresh) state = undefined;
    if (checkpoint) state = checkpoint;
    const began = performance.now();
    const solved = solveNative(input, state, seconds);
    state = solved.state;
    self.postMessage({ id, result: solved.result, solve_ms: performance.now() - began, ...(exportCheckpoint ? { checkpoint: state } : {}) });
  } catch (error) { self.postMessage({ id, error: String(error) }); }
};
