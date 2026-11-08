import type { Charge } from "../../lib/planner";
import type { Fare, Journey, Missing, Price, Rule, Spec } from "./types";
import { normalizeFare } from "./types";
import { cents, compare, round } from "./time";
import { journeyPriceScope, sameJourneyScope } from "../../lib/journeyPricing";

type Choice = { offer: Fare; low: number; high: number };
type Entry = { choices: Choice[]; diagnostic: Missing | null; priced: Choice; unpriced: Choice; uncertain: string[] };
export type FareIndex = { direct: Map<string, Fare[]>; bundles: Fare[]; pairs: Map<string, number[]>; larger: Map<string, number[]>; pairIds: Set<string>; resolved: Map<string, Entry> };
const append = <T>(map: Map<string, T[]>, key: string, value: T) => { const list = map.get(key) ?? []; list.push(value); map.set(key, list); };

export function fareIndex(offers: Fare[], spec: Spec): FareIndex {
  const index: FareIndex = { direct: new Map(), bundles: [], pairs: new Map(), larger: new Map(), pairIds: new Set(), resolved: new Map() };
  for (const offer of offers) {
    if (!offer.validated || offer.adults != null && offer.adults !== spec.adults) continue;
    if (offer.movement_ids.length === 1) append(index.direct, offer.movement_ids[0], offer);
    else if (offer.movement_ids.length > 1) {
      const ids = [...new Set(offer.movement_ids)];
      if (ids.length === 2) { append(index.pairs, JSON.stringify(ids.sort()), index.bundles.length); ids.forEach(id => index.pairIds.add(id)); }
      else ids.forEach(id => append(index.larger, id, index.bundles.length));
      index.bundles.push(offer);
    }
  }
  return index;
}
function amount(offer: Fare, spec: Spec): Choice {
  const rate = spec.exchange_rates[offer.currency];
  return offer.low == null || rate === undefined ? { offer, low: 0, high: Infinity }
    : { offer, low: cents(offer.low * rate), high: offer.high == null ? Infinity : cents(offer.high * rate) };
}
function ruleOffer(id: string, journey: Journey, charge: Charge | null, spec: Spec, rules: Rule[]) {
  const movement = journey.raw;
  const names = new Set(movement.segments.flatMap(segment => [segment.service, segment.operator]));
  if (charge) names.add(charge.kind);
  const origin = charge?.from_id || movement.from_id, dest = charge?.to_id || movement.to_id;
  const place = [spec.home, ...spec.departures, ...spec.arrivals, ...spec.visits.map(v => v.place)].find(p => p.id === movement.from_id)!;
  const country = charge?.country_code || place.country_code;
  const distance = charge ? charge.distance_km : movement.distance_km, mode = charge ? charge.mode : movement.mode;
  const matches = rules.filter(rule => ["*", mode].includes(rule.mode) && (rule.from_id == null || rule.from_id === origin)
    && (rule.to_id == null || rule.to_id === dest) && (rule.service == null || names.has(rule.service))
    && (rule.country_code == null || rule.country_code === country)
    && (rule.journey_scope == null || !charge && sameJourneyScope(journeyPriceScope(movement, spec.adults, rule.journey_scope.group_by), rule.journey_scope))
    && (rule.kind !== "per-km" || distance != null));
  if (!matches.length) return null;
  const key = (rule: Rule) => [rule.priority, [rule.from_id, rule.to_id, rule.service, rule.country_code].filter(value => value != null).length, rule.mode !== "*", rule.id];
  const scoped = matches.filter(rule => rule.journey_scope != null);
  const scopeKey = (rule: Rule) => [rule.journey_scope!.group_by.length, rule.priority, rule.id];
  const rule = (scoped.length ? scoped : matches).reduce((best, item) => compare(scoped.length ? scopeKey(item) : key(item), scoped.length ? scopeKey(best) : key(best)) > 0 ? item : best);
  let multiplier = rule.unit === "person" ? spec.adults : rule.unit === "vehicle" ? Math.ceil(spec.adults / rule.capacity) : 1;
  if (rule.kind === "per-km") multiplier *= distance!;
  return normalizeFare({ id: `rule:${rule.id}:${id}`, movement_ids: [id], low: round(rule.low * multiplier), high: round((rule.high ?? rule.low) * multiplier),
    currency: rule.currency, source: "rule", estimated: true, label: rule.name });
}
function component(id: string, journey: Journey, charge: Charge | null, index: FareIndex, spec: Spec, rules: Rule[]): Entry {
  const movement = journey.raw;
  let direct = [...(index.direct.get(id) ?? [])];
  if (!charge && movement.template_id) direct.push(...(index.direct.get(movement.template_id) ?? []).map(offer => ({ ...offer, id: `${offer.id}:${id}`, movement_ids: [id] })));
  const overrides = direct.filter(offer => offer.source === "user");
  if (overrides.length) direct = overrides.slice(-1);
  else if (!direct.some(offer => offer.low != null)) {
    const rule = ruleOffer(id, journey, charge, spec, rules);
    if (charge?.source === "user" && charge.low != null) direct = [normalizeFare({ id: `charge:${id}`, movement_ids: [id], kind: "charge", low: charge.low, high: charge.high, currency: charge.currency, source: "user", estimated: true, label: charge.kind })];
    else if (rule) direct = [rule];
    else if (charge?.low != null) direct = [normalizeFare({ id: `charge:${id}`, movement_ids: [id], kind: "charge", low: charge.low, high: charge.high, currency: charge.currency, source: "rule", estimated: true, label: charge.kind })];
    else if (movement.mode === "car" && !charge) {
      const rate = movement.vehicle_kind === "own" ? spec.cars.own_cost_per_km : spec.cars.rental_cost_per_km;
      const count = movement.vehicle_kind === "own" ? 1 : Math.ceil(spec.adults / spec.cars.rental_capacity);
      if (rate != null && movement.distance_km != null) {
        const value = round(rate * movement.distance_km * count);
        direct = [normalizeFare({ id: `driving:${id}`, movement_ids: [id], low: value, high: value, source: "rule", estimated: true, label: "Configured driving cost" })];
      }
    }
  }
  if (!direct.length) direct = [normalizeFare({ id: `unknown:${id}`, movement_ids: [id], source: "unknown", label: charge?.kind ?? movement.mode })];
  const choices = direct.map(offer => amount(offer, spec));
  const diagnostic: Missing | null = choices.every(choice => choice.high === Infinity) ? { component_id: id, movement_id: movement.id, label: charge?.kind ?? movement.mode,
    from_id: movement.from_id, to_id: movement.to_id, currency: direct[0].currency, reason: direct[0].low != null && spec.exchange_rates[direct[0].currency] === undefined ? "exchange_rate" : "missing_fare" } : null;
  const best = (selector: (choice: Choice) => unknown[]) => choices.reduce((a, b) => compare(selector(a), selector(b)) <= 0 ? a : b);
  return { choices, diagnostic, priced: best(choice => [choice.high, choice.low, choice.offer.id]), unpriced: best(choice => [choice.low, choice.offer.id]), uncertain: choices.filter(choice => choice.low !== choice.high).map(choice => choice.offer.id) };
}

export function pricePath(path: Journey[], offers: Fare[], spec: Spec, rules: Rule[], extra: Charge[] = [], existing?: FareIndex): Price {
  const index = existing ?? fareIndex(offers, spec);
  const components = new Map<string, [Journey, Charge | null]>(), extraIds = new Set<string>();
  for (const journey of path) { components.set(journey.raw.id, [journey, null]); for (const charge of journey.raw.charges) components.set(charge.id, [journey, charge]); }
  if (path.length) for (const charge of extra) { components.set(charge.id, [path[path.length - 1], charge]); extraIds.add(charge.id); }
  const keys = [...components.keys()], entries: Entry[] = [], diagnostics: Missing[] = [];
  for (const [id, [journey, charge]] of components) {
    const key = JSON.stringify(extraIds.has(id) ? [id, journey.raw.id] : id);
    let entry = index.resolved.get(key);
    if (!entry) { entry = component(id, journey, charge, index, spec, rules); index.resolved.set(key, entry); }
    entries.push(entry); if (entry.diagnostic) diagnostics.push(entry.diagnostic);
  }
  const aliases = new Map(path.filter(journey => journey.raw.template_id).map(journey => [journey.raw.template_id!, journey.raw.id]));
  const positions = new Set<number>(), available = [...new Set([...keys, ...aliases.keys()])].filter(id => index.pairIds.has(id)).sort();
  for (let i = 0; i < available.length; i++) for (let j = i + 1; j < available.length; j++) (index.pairs.get(JSON.stringify([available[i], available[j]])) ?? []).forEach(position => positions.add(position));
  for (const id of [...keys, ...aliases.keys()]) (index.larger.get(id) ?? []).forEach(position => positions.add(position));
  const bundled: Fare[] = [];
  for (const position of [...positions].sort((a, b) => a - b)) {
    let offer = index.bundles[position];
    if (aliases.size && offer.movement_ids.some(id => aliases.has(id))) offer = { ...offer, movement_ids: offer.movement_ids.map(id => aliases.get(id) ?? id) };
    if (offer.movement_ids.every(id => components.has(id))) bundled.push(offer);
  }
  let lower = 0, upper = 0, chosen: Fare[], uncertain = new Set<string>();
  if (!bundled.length) {
    const selected: Fare[] = []; let single = true;
    for (const entry of [...entries].reverse()) {
      const choice = upper === Infinity ? entry.unpriced : entry.priced;
      lower += choice.low; upper += choice.high; selected.push(choice.offer);
      single &&= entry.choices.length === 1; entry.uncertain.forEach(id => uncertain.add(id));
    }
    const ids = new Set(selected.map(offer => offer.id));
    chosen = single ? selected.reverse() : entries.flatMap(entry => entry.choices.filter(choice => ids.has(choice.offer.id)).map(choice => choice.offer));
  } else {
    type Covered = Choice & { mask: bigint };
    const indexes = new Map(keys.map((key, index) => [key, index]));
    const byBit: Covered[][] = entries.map((entry, i) => entry.choices.map(choice => ({ ...choice, mask: 1n << BigInt(i) })));
    const choices = byBit.flat();
    for (const offer of bundled) {
      const mask = offer.movement_ids.reduce((value, id) => value | 1n << BigInt(indexes.get(id)!), 0n);
      const choice: Covered = { ...amount(offer, spec), mask }; choices.push(choice);
      for (let i = 0; i < keys.length; i++) if (mask & 1n << BigInt(i)) byBit[i].push(choice);
    }
    const full = (1n << BigInt(keys.length)) - 1n;
    let flightMask = 0n;
    if (spec.exclude_unpriced_flights) for (const [id, [journey, charge]] of components) if (!charge && journey.raw.mode === "flight") flightMask |= 1n << BigInt(indexes.get(id)!);
    const memo = new Map<bigint, [number, number, string[], number]>();
    function cover(mask: bigint): [number, number, string[], number] {
      if (mask === full) return [0, 0, [], 0];
      const known = memo.get(mask); if (known) return known;
      let bit = 0; while (mask & 1n << BigInt(bit)) bit++;
      let best: [number, number, string[], number] | undefined;
      for (const choice of byBit[bit]) {
        if (mask & choice.mask) continue;
        const rest = cover(mask | choice.mask);
        let unpriced = rest[3], bits = choice.high === Infinity ? choice.mask & flightMask : 0n;
        while (bits) { unpriced++; bits &= bits - 1n; }
        const candidate: [number, number, string[], number] = [choice.low + rest[0], choice.high + rest[1], [choice.offer.id, ...rest[2]], unpriced];
        if (!best || compare([candidate[3], candidate[1], candidate[0], candidate[2]], [best[3], best[1], best[0], best[2]]) < 0) best = candidate;
      }
      memo.set(mask, best!); return best!;
    }
    const selection = cover(0n); lower = selection[0]; upper = selection[1];
    const ids = new Set(selection[2]); chosen = choices.filter(choice => ids.has(choice.offer.id)).map(choice => choice.offer);
    uncertain = new Set(choices.filter(choice => choice.low !== choice.high).map(choice => choice.offer.id));
  }
  if (spec.exclude_unpriced_flights) {
    const covered = new Set(chosen.filter(offer => amount(offer, spec).high !== Infinity).flatMap(offer => offer.movement_ids));
    for (let i = diagnostics.length - 1; i >= 0; i--) if (covered.has(diagnostics[i].component_id)) diagnostics.splice(i, 1);
  }
  return { low_cents: lower, high_cents: upper, total_cost_myr: lower === upper ? lower / 100 : null, cost_low_myr: lower / 100, cost_high_myr: upper === Infinity ? null : upper / 100,
    estimated: chosen.some(offer => offer.estimated || offer.source === "rule" || offer.currency !== "MYR"), purchases: chosen,
    missing: upper === Infinity ? diagnostics : [], uncertainty_key: [...new Set([...diagnostics.map(item => item.component_id), ...uncertain])].sort() };
}

/** Keep a flight if a finite standalone fare or a complete ticket can price it. */
export function unpricedFlightIds(movements: Journey[], index: FareIndex, spec: Spec, rules: Rule[], start: number, end: number): Set<string> {
  const available = new Set<string>();
  for (const journey of movements) {
    const m = journey.raw;
    if (m.usable && spec.modes.includes(m.mode) && (journey.dep === null || start <= journey.dep && journey.arr! <= end)) {
      available.add(m.id);
      if (m.template_id) available.add(m.template_id);
      for (const charge of m.charges) available.add(charge.id);
    }
  }
  const covered = new Set(index.bundles.filter(offer => amount(offer, spec).high !== Infinity && offer.movement_ids.every(id => available.has(id))).flatMap(offer => offer.movement_ids));
  const skipped = new Set<string>();
  for (const journey of movements) {
    const m = journey.raw;
    if (m.mode !== "flight") continue;
    const entry = component(m.id, journey, null, index, spec, rules);
    index.resolved.set(JSON.stringify(m.id), entry);
    if (entry.choices.every(choice => choice.high === Infinity) && !covered.has(m.id) && !(m.template_id && covered.has(m.template_id))) skipped.add(m.id);
  }
  return skipped;
}
