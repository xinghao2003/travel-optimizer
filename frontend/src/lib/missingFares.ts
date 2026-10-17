import type { Result, Route } from "./planner";

export type MissingFare = Result["missing_fares"][number];
export type MissingFareGroup = {
  key: string; from_id: string; to_id: string; label: string; mode: string;
  currency: string; reason: string; affected_itineraries: number;
  components: (MissingFare & { departure: string | null })[];
};

export function groupMissingFares(missing: MissingFare[], routes: Route[]): MissingFareGroup[] {
  const contexts = new Map<string, { from: string; to: string; mode: string; departure: string | null; transfer: boolean }>();
  const affected = new Map<string, Set<string>>();
  const register = (id: string, routeId: string) => {
    if (!affected.has(id)) affected.set(id, new Set());
    affected.get(id)!.add(routeId);
  };
  for (const route of routes) {
    for (const movement of route.movements) {
      contexts.set(movement.id, { from: movement.from_id, to: movement.to_id, mode: movement.mode, departure: movement.departure, transfer: false });
      register(movement.id, route.id);
      for (const charge of movement.charges) {
        // Diagnostics historically use the whole flight's endpoints; use the
        // charge endpoints to identify the actual city-airport transfer.
        const scoped = charge as typeof charge & { from_id?: string; to_id?: string };
        contexts.set(charge.id, { from: scoped.from_id ?? movement.from_id, to: scoped.to_id ?? movement.to_id,
          mode: charge.mode, departure: movement.departure,
          transfer: charge.kind === "Airport access" || charge.kind === "Airport egress" });
        register(charge.id, route.id);
      }
    }
    for (const charge of route.extra_charges) register(charge.id, route.id);
  }
  const groups = new Map<string, MissingFareGroup & { routeIds: Set<string> }>();
  for (const fare of missing) {
    const context = contexts.get(fare.component_id);
    const from = context?.from ?? fare.from_id, to = context?.to ?? fare.to_id;
    const key = JSON.stringify([from, to, fare.label, context?.mode ?? "", fare.currency, fare.reason,
      context?.transfer ? null : fare.component_id]);
    if (!groups.has(key)) groups.set(key, { key, from_id: from, to_id: to, label: fare.label,
      mode: context?.mode ?? "", currency: fare.currency, reason: fare.reason,
      affected_itineraries: 0, components: [], routeIds: new Set() });
    const group = groups.get(key)!;
    if (group.components.some(c => c.component_id === fare.component_id)) continue;
    group.components.push({ ...fare, from_id: from, to_id: to, departure: context?.departure ?? null });
    for (const id of affected.get(fare.component_id) ?? []) group.routeIds.add(id);
  }
  return [...groups.values()].map(({ routeIds, ...group }) => ({ ...group, affected_itineraries: routeIds.size }))
    .sort((a, b) => b.affected_itineraries - a.affected_itineraries || a.key.localeCompare(b.key));
}
