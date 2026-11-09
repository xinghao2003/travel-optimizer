/** Preserve Python's persisted discovery keys while migrating saved graphs. */
import type { Place, TripSpec } from "../lib/planner";
import { pythonFloat, stableId } from "./time";

function repr(value: string): string {
  const quote = value.includes("'") && !value.includes('"') ? '"' : "'";
  let result = quote;
  for (const char of value) {
    const point = char.codePointAt(0)!;
    result += char === "\\" ? "\\\\" : char === quote ? "\\" + char : char === "\n" ? "\\n" : char === "\r" ? "\\r" : char === "\t" ? "\\t"
      : /[\p{C}\p{Z}]/u.test(char) && char !== " " ? point <= 255 ? "\\x" + point.toString(16).padStart(2, "0")
        : point <= 65535 ? "\\u" + point.toString(16).padStart(4, "0") : "\\U" + point.toString(16).padStart(8, "0") : char;
  }
  return result + quote;
}
const optional = (value: string | null) => value === null ? "None" : repr(value);
function placeString(place: Place) {
  return `id=${repr(place.id)} name=${repr(place.name)} latitude=${pythonFloat(place.latitude)} longitude=${pythonFloat(place.longitude)} timezone=${repr(place.timezone)} country_code=${repr(place.country_code)} airport_codes=[${place.airport_codes.map(repr).join(", ")}] flight_code=${optional(place.flight_code)}`;
}
export function discoveryKey(spec: TripSpec): string {
  const parts: unknown[] = ["independent-round-trips-v2", placeString(spec.home), spec.departures.map(placeString), spec.arrivals.map(placeString), spec.visits.map(v => placeString(v.place)),
    spec.start_date, spec.end_date, spec.adults, [...spec.modes].sort(), spec.departure_start, spec.departure_end];
  if (spec.rail_fallback?.enabled) {
    const settings = spec.rail_fallback, reference = settings.reference_date ? `datetime.date(${settings.reference_date.split("-").map(Number).join(", ")})` : "None";
    parts.push("rail-fallback-v1", `enabled=True reference_date=${reference} max_shift_days=${settings.max_shift_days} station_radius_km=${pythonFloat(settings.station_radius_km)}`);
  }
  if (spec.ordered_visits && spec.visits.length > 1) parts.push("ordered-visits-v1");
  if (spec.home_departure_earliest != null || spec.home_arrival_latest != null || spec.positioning_policies?.length) {
    const policies = (spec.positioning_policies ?? []).map(p => `direction=${repr(p.direction)} gateway_id=${repr(p.gateway_id)} mode=${repr(p.mode)} search_more=${p.search_more ? "True" : "False"} available=${p.available ? "True" : "False"}`);
    parts.push(spec.home_departure_earliest ?? null, spec.home_arrival_latest ?? null, policies);
  }
  return stableId(...parts);
}
