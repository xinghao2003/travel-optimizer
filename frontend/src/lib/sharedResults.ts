import type { Charge, Movement, Offer, Result, Route } from "./planner";

type CompactRoute = Omit<Route, "movements" | "purchases" | "extra_charges"> & {
  movements: number[]; purchases: number[]; extra_charges: number[];
};
export type CompactResult = Omit<Result, "routes" | "dominated_routes" | "refinement_routes"> & {
  routes: CompactRoute[]; dominated_routes?: CompactRoute[]; refinement_routes?: CompactRoute[];
  _shared_route_data: { version: number; movements: Movement[]; purchases: Offer[]; extra_charges: Charge[] };
};

export function expandSharedResult(result: CompactResult): Result {
  const { _shared_route_data: pool, routes, dominated_routes, refinement_routes, ...rest } = result;
  if (pool.version !== 1) throw new Error("Unsupported shared route format");
  const expand = (route: CompactRoute): Route => ({ ...route,
    movements: route.movements.map(i => pool.movements[i]),
    purchases: route.purchases.map(i => pool.purchases[i]),
    extra_charges: route.extra_charges.map(i => pool.extra_charges[i]),
  });
  return { ...rest, routes: routes.map(expand),
    ...(dominated_routes ? { dominated_routes: dominated_routes.map(expand) } : {}),
    ...(refinement_routes ? { refinement_routes: refinement_routes.map(expand) } : {}),
  };
}
