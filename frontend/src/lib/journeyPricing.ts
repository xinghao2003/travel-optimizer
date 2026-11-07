import type { JourneyGroupField, JourneyPriceScope, Movement, Segment } from "./planner";

export const journeyGroupFields: { key: JourneyGroupField; label: string }[] = [
  { key: "stations", label: "Boarding and alighting stations" }, { key: "category", label: "Transport category" },
  { key: "connections", label: "Connection pattern" }, { key: "service", label: "Service / route" },
  { key: "operator", label: "Operator" }, { key: "date", label: "Travel date" }, { key: "time", label: "Departure time" },
];
export const defaultJourneyGrouping: JourneyGroupField[] = ["stations", "category", "connections"];
export const sameJourneyScope = (a: JourneyPriceScope, b: JourneyPriceScope) => a.from_id === b.from_id && a.to_id === b.to_id && a.mode === b.mode && a.vehicle_kind === b.vehicle_kind && a.adults === b.adults &&
  a.group_by.length === b.group_by.length && a.group_by.every(field => b.group_by.includes(field) && a.values[field] === b.values[field]);
export const ridingSegments = (movement: Pick<Movement, "segments"> & Partial<Pick<Movement, "mode">>) => movement.segments.filter(segment => !["walk", "foot", "wait", "transfer"].includes(segment.mode.toLowerCase()) && (movement.mode !== "flight" || segment.mode.toLowerCase() === "flight"));

/** Keep this representation aligned with planner_models.journey_price_scope. Missing identifiers stay journey-specific. */
export function journeyPriceScope(movement: Movement, adults: number, fields: JourneyGroupField[]): JourneyPriceScope {
  const rides = ridingSegments(movement), unknown = `unknown:${movement.template_id || movement.id}`;
  const station = (segment: Segment, end: "from" | "to") => segment[`${end}_id`] || unknown;
  const departure = rides.length ? rides[0].departure : movement.departure;
  const local = departure && (fields.includes("date") || fields.includes("time")) ? new Intl.DateTimeFormat("sv-SE", { timeZone: rides[0]?.from_timezone || "UTC", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(departure)) : null;
  const values: Record<JourneyGroupField, unknown> = {
    stations: rides.length ? [station(rides[0], "from"), station(rides.at(-1)!, "to")] : [unknown],
    category: rides.length ? [...new Set(rides.map(segment => segment.mode.toLowerCase()))].sort() : [movement.mode],
    connections: rides.slice(1).map((segment, index) => [station(rides[index], "to"), station(segment, "from")]),
    service: rides.length ? rides.map(segment => segment.service || unknown) : [unknown],
    operator: rides.length ? [...new Set(rides.map(segment => segment.operator || unknown))].sort() : [unknown],
    date: local ? local.slice(0, 10) : unknown, time: local ? local.slice(11, 16) : unknown,
  };
  const group_by = journeyGroupFields.map(field => field.key).filter(field => fields.includes(field));
  return { from_id: movement.from_id, to_id: movement.to_id, mode: movement.mode, vehicle_kind: movement.vehicle_kind ?? null, adults,
    group_by, values: Object.fromEntries(group_by.map(field => [field, JSON.stringify(values[field])])) };
}

export function journeyScopeLabel(scope: JourneyPriceScope, movement?: Movement): string {
  const rides = movement ? ridingSegments(movement) : [];
  const value = (key: string): unknown => JSON.parse(scope.values[key] ?? "null");
  const text = (key: string) => { const raw = value(key); return Array.isArray(raw) ? raw.flat().map(String).filter(item => !item.startsWith("unknown:")).join(" → ") : typeof raw === "string" && !raw.startsWith("unknown:") ? raw : ""; };
  return [scope.group_by.includes("stations") ? (rides.length ? `${rides[0].from_name} → ${rides.at(-1)!.to_name}` : "Same stations") : "Any stations",
    scope.group_by.includes("service") && (text("service") || "Service unknown"),
    scope.group_by.includes("category") && text("category").replaceAll("_", " "),
    scope.group_by.includes("connections") && (rides.length > 1 ? `Via ${rides.slice(0, -1).map(segment => segment.to_name).join(" → ")}` : Array.isArray(value("connections")) && (value("connections") as unknown[]).length ? `${(value("connections") as unknown[]).length} transfer(s)` : "Direct"),
    scope.group_by.includes("operator") && (text("operator") || "Operator unknown"),
    scope.group_by.includes("date") ? text("date") || "Date unknown" : "All dates in this trip",
    scope.group_by.includes("time") && (text("time") || "Time unknown"),
  ].filter(Boolean).join(" · ");
}
