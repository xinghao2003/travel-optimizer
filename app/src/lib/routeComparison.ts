import type { Route } from "./planner";
import { hoursText, moneyShort, stayLength } from "./present";

type ComparedRoute = Pick<Route, "id" | "total_cost_myr" | "cost_low_myr" | "cost_high_myr" | "stay_hours" | "travel_hours" | "common_offer_ids">;
export type RouteComparison = { summary: string; rate: string | null; details: string[] };
const epsilon = 1e-6;
const cents = (value: number) => Math.round(value * 100) / 100;
const signedMoney = (value: number) => value === 0 ? moneyShort(0) : `${value > 0 ? "+" : "−"}${moneyShort(Math.abs(value))}`;
const interval = (low: number, high: number, format: (value: number) => string) => low === high ? format(low) : `${format(low)} to ${format(high)}`;
// Time in cities from a day up reads in days ("+1 day 3 h in cities"); travel time stays in hours.
const signedHours = (value: number, unit: string) => Math.abs(value) < epsilon ? `same ${unit === "h in cities" ? "time in cities" : "travel time"}`
  : unit === "h in cities" && Math.abs(value) >= 24 ? `${value > 0 ? "+" : "−"}${stayLength(Math.abs(value))} in cities`
  : `${value > 0 ? "+" : "−"}${Math.abs(value) < .1 ? "<0.1" : hoursText(Math.abs(value))} ${unit}`;

/**
 * Differences use full stored precision, never the rounded row labels. Missing prices are not treated as zero:
 * when one option has a missing price, only the side of the difference that is certain shows ("+RM 32 or more").
 * Prices compare only on the same basis: both options with the common costs left out (lib/commonCosts), or neither.
 */
export function compareRoute(route: ComparedRoute, baseline: ComparedRoute): RouteComparison {
  const hours = route.stay_hours - baseline.stay_hours;
  const sameBasis = (route.common_offer_ids?.length ?? 0) === (baseline.common_offer_ids?.length ?? 0);
  const routeHigh = sameBasis ? route.total_cost_myr ?? route.cost_high_myr : null;
  const baseHigh = sameBasis ? baseline.total_cost_myr ?? baseline.cost_high_myr : null;
  const least = sameBasis && baseHigh !== null ? cents(route.cost_low_myr - baseHigh) : null;
  const most = sameBasis && routeHigh !== null ? cents(routeHigh - baseline.cost_low_myr) : null;
  const low = routeHigh === null ? null : least, high = baseHigh === null ? null : most;
  const price = low !== null && high !== null ? low === 0 && high === 0 ? "Same price" : interval(low, high, signedMoney)
    : least !== null && least > 0 ? `${signedMoney(least)} or more` : most !== null && most < 0 ? `${signedMoney(most)} or more` : "Price difference unknown";
  const details = [`Price: ${price}.`, `Time in cities: ${signedHours(hours, "h in cities")}.`,
    `Travel time: ${signedHours(route.travel_hours - baseline.travel_hours, "travel h")}.`];
  let rate: string | null = null;
  if (price !== "Price difference unknown" && (low === null || high === null)) {
    if (least !== null && hours < epsilon) details.push(hours < -epsilon ? "Costs more and gives less city time." : "Costs more for the same city time.");
    else if (most !== null && hours > -epsilon) details.push(hours > epsilon ? "Cheaper and more city time." : "Cheaper for the same city time.");
  } else if (low !== null && high !== null) {
    if (hours > epsilon && low >= 0) {
      if (high === 0) details.push("More city time at no extra cost.");
      else {
        rate = `${interval(low / hours, high / hours, moneyShort)}/extra hour in cities`;
        details.push(`Extra cost: ${rate}.`, `${interval(low / hours * 24, high / hours * 24, moneyShort)} per extra city day (24 hours).`);
      }
    } else if (hours < -epsilon && high <= 0) {
      details.push(`Savings per hour in cities given up: ${interval(-high / -hours, -low / -hours, moneyShort)}.`);
    } else if (hours > epsilon && high < 0) details.push("Cheaper and more city time.");
    else if (hours < -epsilon && low > 0) details.push("Costs more and gives less city time.");
  } else details.push("Fill in missing prices before comparing upgrade costs.");
  return { summary: `${price} · ${signedHours(hours, "h in cities")}`, rate, details };
}

/** Adjacent exact-price frontier steps reveal expensive final increments that a selected-baseline average hides. */
export function marginalComparisons(routes: ComparedRoute[]) {
  const sorted = routes.filter(route => route.total_cost_myr !== null).sort((a, b) =>
    a.total_cost_myr! - b.total_cost_myr! || b.stay_hours - a.stay_hours || a.id.localeCompare(b.id));
  const points: { route: ComparedRoute; ids: string[] }[] = [];
  for (const route of sorted) {
    const last = points.at(-1);
    if (last && route.total_cost_myr === last.route.total_cost_myr && Math.abs(route.stay_hours - last.route.stay_hours) < epsilon) last.ids.push(route.id);
    else if (!last || route.stay_hours > last.route.stay_hours + epsilon) points.push({ route, ids: [route.id] });
  }
  const result = new Map<string, { baselineId: string; comparison: RouteComparison }>();
  for (let index = 1; index < points.length; index++) {
    const previous = points[index - 1].route;
    const comparison = compareRoute(points[index].route, previous);
    for (const id of points[index].ids) result.set(id, { baselineId: previous.id, comparison });
  }
  return result;
}
