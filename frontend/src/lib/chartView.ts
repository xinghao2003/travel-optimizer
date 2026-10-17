export function axisBounds(values: number[], logarithmic: boolean, fit: boolean) {
  const finite = values.filter(Number.isFinite);
  if (!finite.length) return { min: logarithmic ? 1 : 0, max: logarithmic ? 10 : 1 };
  const low = Math.min(...finite), high = Math.max(...finite);
  if (logarithmic) {
    // Log axes cannot include zero. Callers disable this view if any plotted
    // value is non-positive, rather than silently dropping those alternatives.
    if (low <= 0) throw new Error("Log axes require positive values.");
    const span = Math.max(Math.log(high)-Math.log(low), .1);
    return { min: Math.exp(Math.log(low)-span*.08), max: Math.exp(Math.log(high)+span*.08) };
  }
  if (!fit) return { min: 0, max: undefined };
  const padding = Math.max((high-low)*.08, Math.abs(low)*.01, .1);
  return { min: Math.max(0, low-padding), max: high+padding };
}
