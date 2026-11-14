import type { Charge, Movement, Offer, Route } from "./planner";

// Common costs: items without a complete price that every best option has. They add the same amount to
// every option, so they cannot change the order of the options. Prices that only some options need decide
// between options. No React here: tests load this file directly.

/** A purchase without a complete price: not priced, in a currency without an exchange rate, or open-ended. */
export type OpenItem = { key: string; offer: Offer; movement: Movement | null; charge: Charge | null };
type PricedRoute = Pick<Route, "id" | "movements" | "purchases" | "extra_charges" | "total_cost_myr" | "cost_low_myr" | "cost_high_myr" | "stay_hours" | "common_offer_ids">;

const epsilon = 1e-6;
const cents = (value: number) => Math.round(value * 100) / 100;
const rateOf = (currency: string, rates: Record<string, number>): number | undefined => currency === "MYR" ? 1 : rates[currency];
const highest = (route: Pick<Route, "total_cost_myr" | "cost_high_myr">) => route.total_cost_myr ?? route.cost_high_myr;

/**
 * The purchases of an option without a complete price. Two items with the same `key` have the same price:
 * an airport transfer by its direction and way, an airport change by its airports, a journey by its template.
 */
export function openItems(route: Pick<Route, "movements" | "purchases" | "extra_charges">, rates: Record<string, number>): OpenItem[] {
  const slots = new Map<string, { movement: Movement | null; charge: Charge | null }>();
  for (const movement of route.movements) {
    slots.set(movement.id, { movement, charge: null });
    if (movement.template_id && !slots.has(movement.template_id)) slots.set(movement.template_id, { movement, charge: null });
    for (const charge of movement.charges) slots.set(charge.id, { movement, charge });
  }
  for (const charge of route.extra_charges) slots.set(charge.id, { movement: null, charge });
  const template = (id: string) => { const slot = slots.get(id); return slot && !slot.charge && slot.movement ? slot.movement.template_id ?? slot.movement.id : id; };
  return route.purchases.filter(offer => offer.low === null || offer.high === null || rateOf(offer.currency, rates) === undefined).map(offer => {
    const { movement = null, charge = null } = offer.movement_ids.length === 1 ? slots.get(offer.movement_ids[0]) ?? {} : {};
    const transfer = charge && (charge.kind === "Airport access" || charge.kind === "Airport egress") && charge.from_id && charge.to_id;
    const key = transfer ? `transfer:${charge.from_id}>${charge.to_id}:${charge.mode}`
      : charge ? charge.kind.startsWith("Airport transfer ") ? `change:${charge.kind}` : `charge:${charge.id}`
      : `journey:${offer.movement_ids.map(template).sort().join("+")}`;
    return { key, offer, movement, charge };
  });
}

/** The highest price of the priced part of an option: open items count with their lowest price, or 0. */
function knownHigh(route: Pick<Route, "purchases" | "cost_low_myr" | "cost_high_myr">, rates: Record<string, number>) {
  if (route.cost_high_myr !== null) return route.cost_high_myr;
  return cents(route.purchases.reduce((sum, offer) => {
    const rate = rateOf(offer.currency, rates);
    return offer.low !== null && offer.high !== null && rate !== undefined ? sum + (offer.high - offer.low) * rate : sum;
  }, route.cost_low_myr));
}

/**
 * The common costs of the best options, and `adjust`, which marks them on an option (`common_offer_ids`). An option
 * whose open items are all common costs gets the price of its priced part, so options compare by what differs.
 * An option without one of the common costs stays as it is: its total does not compare with the others.
 * One option alone has no common costs.
 */
export function commonCosts(best: Route[], rates: Record<string, number>) {
  const common = new Map<string, number>();
  const first = best.length > 1 ? openItems(best[0], rates) : [];
  const counts = best.slice(1).map(route => countKeys(openItems(route, rates)));
  for (const [key, count] of countKeys(first)) if (counts.every(other => other.get(key) === count)) common.set(key, count);
  // Takes the common costs from `items`; null when one is absent.
  function split(items: OpenItem[]) {
    const left = new Map(common), taken: OpenItem[] = [], own: OpenItem[] = [];
    for (const item of items) {
      const count = left.get(item.key) ?? 0;
      if (count > 0) { left.set(item.key, count - 1); taken.push(item); } else own.push(item);
    }
    return [...left.values()].some(count => count > 0) ? null : { taken, own };
  }
  function adjust<T extends Route>(route: T): T {
    const parts = common.size ? split(openItems(route, rates)) : null;
    if (!parts) return route;
    const common_offer_ids = parts.taken.map(item => item.offer.id);
    if (parts.own.length) return { ...route, common_offer_ids };
    const high = knownHigh(route, rates);
    return { ...route, common_offer_ids, cost_high_myr: high, total_cost_myr: high === route.cost_low_myr ? high : null };
  }
  return { items: split(first)?.taken ?? [], adjust };
}
function countKeys(items: OpenItem[]) {
  const counts = new Map<string, number>();
  for (const item of items) counts.set(item.key, (counts.get(item.key) ?? 0) + 1);
  return counts;
}

/**
 * A price that decides between two options: when the journey `item` of option `routeId` costs less than `under`,
 * that option costs less than `rivalId`, the cheapest option with at least as much time in cities.
 */
export type PriceQuestion = { item: OpenItem; routeId: string; rivalId: string; under: number };
/**
 * What the missing prices of the best options (after `adjust`) can still change. `questions`: one per journey
 * price that alone decides if its option is worth it. `beaten`: options that cost more than an option with at
 * least as much time in cities, whatever their missing prices are (option id → that option's id). `asked`: the
 * options that a question covers. `open`: other options that need prices before they compare.
 */
export function priceDecisions(routes: PricedRoute[], rates: Record<string, number>) {
  const comparable = routes.filter(route => highest(route) !== null);
  const questions = new Map<string, PriceQuestion>(), beaten = new Map<string, string>(), asked: string[] = [], open: string[] = [];
  for (const route of routes) {
    if (highest(route) !== null) continue;
    const rival = comparable.filter(other => other.stay_hours >= route.stay_hours - epsilon)
      .sort((a, b) => highest(a)! - highest(b)! || b.stay_hours - a.stay_hours)[0];
    if (rival && highest(rival)! <= route.cost_low_myr) { beaten.set(route.id, rival.id); continue; }
    const common = new Set(route.common_offer_ids ?? []);
    const own = openItems(route, rates).filter(item => !common.has(item.offer.id));
    const under = rival ? cents(highest(rival)! - knownHigh(route, rates)) : 0;
    // A yes or no answer is a price range or a lowest price, which only a single journey without a price can take.
    const [item] = own;
    if (own.length !== 1 || !item.movement || item.charge || item.offer.movement_ids.length !== 1 || item.offer.low !== null || under <= 0) { open.push(route.id); continue; }
    asked.push(route.id);
    if (under > (questions.get(item.key)?.under ?? 0)) questions.set(item.key, { item, routeId: route.id, rivalId: rival.id, under });
  }
  return { questions: [...questions.values()].sort((a, b) => b.under - a.under), beaten, asked, open };
}
