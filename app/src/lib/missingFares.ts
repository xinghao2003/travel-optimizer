import type { JourneyGroupField, JourneyPriceScope, Movement, PricingRule, Result, Route } from "./planner";
import { journeyPriceScope, ridingSegments, sameJourneyScope } from "./journeyPricing";

export type MissingFare = Result["missing_fares"][number];
export type MissingFareGroup = {
  key: string; from_id: string; to_id: string; label: string; mode: string;
  currency: string; reason: string; affected_itineraries: number;
  scope?: JourneyPriceScope;
  /** `search_url` and `template_id` come from the journey (null for charges): Search fare and canonical ids. */
  components: (MissingFare & { departure: string | null; service: string | null; search_url: string | null; template_id: string | null; journey?: Movement })[];
};
type Context = { from: string; to: string; mode: string; departure: string | null; service: string | null; search_url: string | null; template_id: string | null; journey?: Movement };

export function groupMissingFares(missing: MissingFare[], routes: Route[], groupBy?: JourneyGroupField[], adults = 1, rules: PricingRule[] = [], rates: Record<string, number> = { MYR: 1 }): MissingFareGroup[] {
  const contexts = new Map<string, Context>();
  const affected = new Map<string, Set<string>>();
  const register = (id: string, routeId: string) => {
    if (!affected.has(id)) affected.set(id, new Set());
    affected.get(id)!.add(routeId);
  };
  for (const route of routes) {
    for (const movement of route.movements) {
      const services = [...new Set(ridingSegments(movement)
        .map(segment => segment.service || segment.operator).filter((service): service is string => !!service))];
      contexts.set(movement.id, { from: movement.from_id, to: movement.to_id, mode: movement.mode,
        departure: movement.departure, service: services.join(" / ") || null, search_url: movement.search_url ?? null, template_id: movement.template_id ?? null, journey: movement });
      register(movement.id, route.id);
      for (const charge of movement.charges) {
        // Diagnostics historically use the whole flight's endpoints; use the
        // charge endpoints to identify the actual city-airport transfer.
        const scoped = charge as typeof charge & { from_id?: string; to_id?: string };
        contexts.set(charge.id, { from: scoped.from_id ?? movement.from_id, to: scoped.to_id ?? movement.to_id,
          mode: charge.mode, departure: movement.departure, service: null, search_url: null, template_id: null });
        register(charge.id, route.id);
      }
    }
    for (const charge of route.extra_charges) register(charge.id, route.id);
  }
  const groups = new Map<string, MissingFareGroup & { routeIds: Set<string> }>();
  for (const fare of missing) {
    const context = contexts.get(fare.component_id);
    // A paused timed round retains its old results. Already-saved reusable prices need no second entry.
    if (fare.reason === "missing_fare" && context?.journey && rules.some(rule => rule.journey_scope && rates[rule.currency] &&
      sameJourneyScope(journeyPriceScope(context.journey!, adults, rule.journey_scope.group_by), rule.journey_scope))) continue;
    const from = context?.from ?? fare.from_id, to = context?.to ?? fare.to_id;
    const scope = groupBy && context?.journey ? journeyPriceScope(context.journey, adults, groupBy) : undefined;
    const key = JSON.stringify([from, to, fare.label, context?.mode ?? "", fare.currency, fare.reason, ...(scope ? [scope] : [])]);
    if (!groups.has(key)) groups.set(key, { key, from_id: from, to_id: to, label: fare.label,
      mode: context?.mode ?? "", currency: fare.currency, reason: fare.reason,
      affected_itineraries: 0, components: [], routeIds: new Set(), ...(scope ? { scope } : {}) });
    const group = groups.get(key)!;
    if (group.components.some(c => c.component_id === fare.component_id)) continue;
    group.components.push({ ...fare, from_id: from, to_id: to, departure: context?.departure ?? null, service: context?.service ?? null,
      search_url: context?.search_url ?? null, template_id: context?.template_id ?? null, ...(context?.journey ? { journey: context.journey } : {}) });
    for (const id of affected.get(fare.component_id) ?? []) group.routeIds.add(id);
  }
  return [...groups.values()].map(({ routeIds, ...group }) => ({ ...group, affected_itineraries: routeIds.size }))
    .sort((a, b) => b.affected_itineraries - a.affected_itineraries || a.key.localeCompare(b.key));
}
