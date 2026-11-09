import type { Route } from "./planner";
import { hoursText, moneyShort, optionNumber, perCityHourText, priceEstimated, priceText, unpricedSummary } from "./present";

// Pure logic of the price vs. time chart (spec E2). No React and no ECharts here: tests load this file directly.

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

/** E1 price states: an exact total, a range with an upper limit, or a lower bound (some items not priced). */
export type PriceKind = "exact" | "range" | "lower";
export const priceKind = (route: Pick<Route, "total_cost_myr" | "cost_high_myr">): PriceKind =>
  route.total_cost_myr !== null ? "exact" : route.cost_high_myr !== null ? "range" : "lower";

/**
 * One mark on the chart. Options with the same class and position share one mark (a stack); `routeId` is the first of
 * them in list order, and a click selects it. `x` is the exact total, the middle of a range or the known part (lower bound).
 */
export type ChartPoint = {
  kind: PriceKind; weaker: boolean; estimated: boolean; hollow: boolean; symbol: "circle" | "diamond";
  x: number; y: number; low: number; high: number | null;
  routeId: string; routeIds: string[]; lines: string[];
};

/**
 * The tooltip lines of a mark (E2): option numbers, price, hours, not priced or per hour, estimates. A stack keeps a
 * line only when it reads the same for every option in it.
 */
export function tooltipLines(routes: Route[], numbers: Map<string, number>, rates: Record<string, number>): string[] {
  const listed = routes.map(route => numbers.has(route.id) ? optionNumber(numbers.get(route.id)!) : null).filter(n => n !== null);
  const title = listed.length > 1 ? `Options ${listed.join(", ")}` : listed.length ? `Option ${listed[0]}` : "";
  const same = (text: (route: Route) => string) => {
    const texts = routes.map(text);
    return texts.every(item => item === texts[0]) ? texts[0] : "";
  };
  const travel = same(route => `${hoursText(route.travel_hours)} h travel`);
  const lines = [
    title,
    same(route => priceKind(route) === "lower" ? `${priceText(route)} (at least)` : priceText(route)),
    `${hoursText(routes[0].stay_hours)} h in cities${travel ? ` · ${travel}` : ""}`,
    same(route => unpricedSummary(route, rates).chip || (perCityHourText(route) ?? "")),
    same(route => priceEstimated(route) ? "Includes estimates" : ""),
  ];
  return lines.filter(Boolean);
}

/**
 * Groups options into marks. Stack key: class|round(x)|round(y*10); ranges key on the low and the high. Options in a
 * stack are in list order (`numbers`).
 */
export function chartPoints(best: Route[], weaker: Route[], numbers: Map<string, number>, rates: Record<string, number>): ChartPoint[] {
  const order = (a: Route, b: Route) => (numbers.get(a.id) ?? Infinity) - (numbers.get(b.id) ?? Infinity) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const stacks = new Map<string, Route[]>();
  const entries = [...best.map(route => [route, false] as const), ...weaker.map(route => [route, true] as const)];
  const meta = new Map<string, { kind: PriceKind; weaker: boolean; estimated: boolean }>();
  for (const [route, isWeaker] of entries) {
    const kind = priceKind(route);
    const estimated = kind === "exact" && priceEstimated(route);
    const position = kind === "exact" ? `${Math.round(route.total_cost_myr!)}` : kind === "range" ? `${Math.round(route.cost_low_myr)}|${Math.round(route.cost_high_myr!)}` : `${Math.round(route.cost_low_myr)}`;
    const key = `${isWeaker ? "weaker" : "best"}-${kind}${estimated ? "-estimated" : ""}|${position}|${Math.round(route.stay_hours * 10)}`;
    stacks.set(key, [...stacks.get(key) ?? [], route]);
    meta.set(key, { kind, weaker: isWeaker, estimated });
  }
  return [...stacks].map(([key, routes]) => {
    const sorted = [...routes].sort(order);
    const first = sorted[0];
    const { kind, weaker: isWeaker, estimated } = meta.get(key)!;
    const high = first.cost_high_myr;
    return {
      kind, weaker: isWeaker, estimated, hollow: kind !== "exact", symbol: estimated ? "diamond" : "circle",
      x: kind === "exact" ? first.total_cost_myr! : kind === "range" ? (first.cost_low_myr + high!) / 2 : first.cost_low_myr,
      y: first.stay_hours, low: first.cost_low_myr, high: kind === "lower" ? null : high,
      routeId: first.id, routeIds: sorted.map(route => route.id), lines: tooltipLines(sorted, numbers, rates),
    };
  });
}

/**
 * The values the price axis must show (E2): every plotted low, every range high and every exact total, plus the budget
 * when it is at most 1.25 × the largest of the others. `budgetShown` says whether the budget line is drawn.
 */
export function priceAxisValues(points: ChartPoint[], budget: number | null) {
  const values = points.flatMap(point => point.kind === "exact" ? [point.low, point.x] : point.kind === "range" ? [point.low, point.high!] : [point.low]);
  const budgetShown = budget !== null && values.length > 0 && budget <= 1.25 * Math.max(...values);
  return { values: budgetShown ? [...values, budget] : values, budgetShown };
}

/** The price axis range used for the tail length: the axis bounds, or [0, max × 1.08] on a linear axis that is not fitted. */
export function priceRange(values: number[], logarithmic: boolean, fit: boolean): [number, number] {
  const bounds = axisBounds(values, logarithmic, fit);
  return [bounds.min, bounds.max ?? Math.max(0, ...values.filter(Number.isFinite)) * 1.08];
}

/** Where the arrow of a lower bound ends (E2): 6 % of the axis span to the right (log: 6 % of the log span), at most the axis end. */
export function tailEnd(low: number, [min, max]: [number, number], logarithmic: boolean) {
  const end = logarithmic ? low * (max / min) ** 0.06 : low + 0.06 * (max - min);
  return Math.min(end, max);
}

type Gap = [null, null];
/** The data of each chart series (E2 table). `tail` gives the arrow end of a lower bound. */
export function chartSeries(points: ChartPoint[], tail: (low: number) => number) {
  const best = points.filter(point => !point.weaker), weaker = points.filter(point => point.weaker);
  const band = (list: ChartPoint[]) => list.filter(point => point.kind === "range").flatMap((point): ([number, number] | Gap)[] => [[point.low, point.y], [point.high!, point.y], [null, null]]);
  const lower = best.filter(point => point.kind === "lower");
  return {
    weakerBand: band(weaker),
    weaker,
    frontier: best.filter(point => point.kind === "exact").map(point => [point.x, point.y] as [number, number]).sort((a, b) => a[0] - b[0] || a[1] - b[1]),
    exact: best.filter(point => point.kind === "exact"),
    rangeBand: band(best),
    rangeMid: best.filter(point => point.kind === "range"),
    lowerTail: lower.flatMap((point): ([number, number] | Gap)[] => [[point.low, point.y], [tail(point.low), point.y], [null, null]]),
    lowerHead: lower.map(point => ({ point, value: [tail(point.low), point.y] as [number, number] })),
    lowerPoint: lower,
  };
}

/** The legend items present (E2), in legend order. */
export type LegendItem = "priced" | "estimated" | "range" | "lower" | "weaker" | "budget" | "selected" | "compared";
export function legendItems(points: ChartPoint[], { budgetShown, selectedId, comparedId }: { budgetShown: boolean; selectedId: string | null; comparedId: string | null }): LegendItem[] {
  const best = points.filter(point => !point.weaker);
  const plotted = (id: string | null) => id !== null && points.some(point => point.routeIds.includes(id));
  const present: Record<LegendItem, boolean> = {
    priced: best.some(point => point.kind === "exact" && !point.estimated),
    estimated: best.some(point => point.estimated),
    range: best.some(point => point.kind === "range"),
    lower: best.some(point => point.kind === "lower"),
    weaker: points.some(point => point.weaker),
    budget: budgetShown,
    selected: plotted(selectedId),
    compared: comparedId !== selectedId && plotted(comparedId),
  };
  return (Object.keys(present) as LegendItem[]).filter(item => present[item]);
}

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
/**
 * The chart's text alternative (E2, I8): "Price versus time in cities for 9 options: 0 fully priced, 0 price ranges,
 * 9 not fully priced. Known prices RM 2,480 to RM 5,710. Time in cities 218 to 221 hours. The option list has every option."
 */
export function chartLabel(routes: Route[]) {
  const kinds = routes.map(priceKind);
  const prices = routes.flatMap(route => [route.cost_low_myr, route.total_cost_myr ?? route.cost_high_myr ?? route.cost_low_myr]);
  const hours = routes.map(route => route.stay_hours);
  const range = (low: number, high: number, text: (value: number) => string) => low === high ? text(low) : `${text(low)} to ${text(high)}`;
  const hourText = (value: number) => `${Math.round(value)}`;
  return `Price versus time in cities for ${count(routes.length, "option", "options")}: ${kinds.filter(kind => kind === "exact").length} fully priced, `
    + `${count(kinds.filter(kind => kind === "range").length, "price range", "price ranges")}, ${kinds.filter(kind => kind === "lower").length} not fully priced. `
    + (routes.length ? `Known prices ${range(Math.min(...prices), Math.max(...prices), moneyShort)}. Time in cities ${range(Math.round(Math.min(...hours)), Math.round(Math.max(...hours)), hourText)} hours. ` : "")
    + "The option list has every option.";
}
