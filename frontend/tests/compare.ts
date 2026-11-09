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
