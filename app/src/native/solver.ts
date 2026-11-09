/** Route optimizer over the normalized event graph. No provider I/O. */
import type { Charge, Movement, Place, Route, Segment } from "../lib/planner";
import type { Fare, Journey, Label, SearchState, SolverInput, SolverResult, Spec } from "./types";
import { normalizeCharge, normalizeFare, normalizeJourney } from "./types";
import { pricePath, fareIndex, unpricedFlightIds } from "./pricing";
import { frontier, enqueue, dequeue, flightPricesComplete } from "./frontier";
import { DAY, HOUR, MINUTE, addDate, at, bisect, cents, compare, currency, datetimeString, duration, elapsed, fingerprint, iso, localDate, localTime, maxInstant, micros, round, stableId, timeKey } from "./time";
import type { CostBound } from "./time";

const SUPPLIED = "User-supplied positioning";
type Timed = { journey: Journey; dep: bigint | null; arr: bigint | null; homeDate: string | null };
type Prepared = { entries: Timed[]; departures: bigint[]; positions: Map<number, Timed[]> };
const placesOf = (spec: Spec) => new Map([spec.home, ...spec.departures, ...spec.arrivals, ...spec.visits.map(visit => visit.place)].map(place => [place.id, place]));

function supplied(spec: Spec): { movements: Journey[]; offers: Fare[] } {
  const places = placesOf(spec), movements: Journey[] = [], offers: Fare[] = [];
  for (const service of spec.positioning_services ?? []) {
    const a = service.direction === "outbound" ? spec.home.id : service.gateway_id;
    const b = service.direction === "outbound" ? service.gateway_id : spec.home.id;
    const segment = { mode: service.mode, from_id: a, to_id: b, from_name: places.get(a)!.name, to_name: places.get(b)!.name,
      from_timezone: places.get(a)!.timezone, to_timezone: places.get(b)!.timezone, departure: service.departure, arrival: service.arrival,
      service: service.label, source: SUPPLIED } as Segment;
    movements.push(normalizeJourney({ id: `positioning:${service.id}`, from_id: a, to_id: b, mode: service.mode, departure: service.departure,
      arrival: service.arrival, duration_minutes: elapsed(micros(service.arrival) - micros(service.departure), MINUTE), source: SUPPLIED,
      segments: [segment], assumptions: ["User supplied city-to-city schedule; onward airport access and flight buffers are separate."] } as Movement));
    if (service.fare_amount != null) offers.push(normalizeFare({ id: `positioning-fare:${service.id}`, movement_ids: [`positioning:${service.id}`], low: service.fare_amount,
      high: service.fare_amount, currency: service.currency, source: "user", adults: spec.adults, label: `${service.label} · whole party` }));
  }
  return { movements, offers };
}
function positioningAllowed(spec: Spec, movement: Movement, phase: number) {
  const direction = phase === 0 ? "outbound" : phase === 3 ? "return" : null;
  if (movement.source === SUPPLIED) {
    const service = spec.positioning_services?.find(item => movement.id === `positioning:${item.id}`);
    if (!service || service.direction !== direction) return false;
  }
  if (direction === null) return true;
  const modes = new Set([movement.mode as string, ...movement.segments.filter(segment => !["walk", "foot", "wait", "transfer"].includes(segment.mode)).map(segment => segment.mode)]);
  return !(spec.positioning_policies ?? []).some(policy => policy.direction === direction
    && (direction === "outbound" ? movement.from_id === spec.home.id && movement.to_id === policy.gateway_id : movement.to_id === spec.home.id && movement.from_id === policy.gateway_id)
    && modes.has(policy.mode) && (!policy.available || !policy.search_more && ![SUPPLIED, "User-defined connection"].includes(movement.source)));
}

export function solveNative(input: SolverInput, previous?: SearchState, seconds = Infinity): { result: SolverResult; state: SearchState } {
  const began = performance.now(), deadline = began + seconds * 1000;
  const spec = structuredClone(input.spec);
  spec.departures = spec.departures.length ? spec.departures : [spec.home];
  spec.arrivals = spec.arrivals.length ? spec.arrivals : [spec.home];
  const additions = supplied(spec), places = placesOf(spec);
  const movements = [...input.movements.filter(movement => movement.source !== SUPPLIED).map(normalizeJourney), ...additions.movements];
  const offers = [...additions.offers, ...input.offers.map(normalizeFare)], rules = input.rules;
  const finishAtHome = input.finish_at_home ?? true, limit = input.label_limit ?? null;
  const signature = fingerprint([4, spec, movements.map(journey => journey.raw), offers, rules, finishAtHome, ...(spec.exclude_unpriced_flights ? ["flight-cover-v2"] : [])]);
  const start = at(spec.start_date, spec.home_departure_earliest ?? "00:00", spec.home.timezone);
  const end = spec.home_arrival_latest != null ? at(spec.end_date, spec.home_arrival_latest, spec.home.timezone) : at(addDate(spec.end_date, 1), "00:00", spec.home.timezone) - 1n;
  const lowerTime = timeKey(spec.departure_start), upperTime = timeKey(spec.departure_end);
  const required = new Map(spec.visits.map((visit, index) => [visit.place.id, { index, hours: visit.min_stay_hours }]));
  const bitOf = (id: string) => required.has(id) ? 1 << required.get(id)!.index : 0;
  const fullMask = (1 << required.size) - 1, fares = fareIndex(offers, spec);
  const skippedFlights = spec.exclude_unpriced_flights ? unpricedFlightIds(movements, fares, spec, rules, start, end) : new Set<string>();
  const edges = new Map<string, Journey[]>(), events = new Map<string, Set<bigint>>();
  const edgeKey = (a: string, b: string) => JSON.stringify([a, b]);
  function eventSet(id: string) { let values = events.get(id); if (!values) { values = new Set(); events.set(id, values); } return values; }
  function connectionsTooShort(segments: Segment[], transit = false) {
    return segments.slice(1).some((segment, index) => !(transit && (segment as Segment & { interline_with_previous?: boolean }).interline_with_previous)
      && segment.departure != null && segments[index].arrival != null && micros(segment.departure) - micros(segments[index].arrival!) < duration(spec.timing.connection_minutes, MINUTE));
  }
  for (const journey of movements) {
    const m = journey.raw;
    if (!skippedFlights.has(m.id) && m.usable && places.has(m.from_id) && places.has(m.to_id) && spec.modes.includes(m.mode) && (spec.max_transfers == null || m.transfers <= spec.max_transfers)) {
      const flights = m.segments.filter(segment => segment.mode === "flight");
      const riding = m.segments.filter(segment => !["walk", "foot", "wait", "transfer"].includes(segment.mode));
      if (!connectionsTooShort(flights) && !(m.source === "Transitous / MOTIS" && connectionsTooShort(riding, true))) {
        const key = edgeKey(m.from_id, m.to_id), group = edges.get(key) ?? []; group.push(journey); edges.set(key, group);
      }
    }
    if (journey.dep !== null) eventSet(m.from_id).add(journey.dep);
  }
  const commitments = spec.commitments.map(item => ({ place_id: item.place_id, start: micros(item.start), end: micros(item.end) }));
  for (const item of commitments) { eventSet(item.place_id).add(item.start); eventSet(item.place_id).add(item.end); }
  eventSet(spec.home.id).add(end);
  for (let iteration = 0; iteration < 2; iteration++) {
    const added = new Map<string, Set<bigint>>();
    for (const journey of movements) if (journey.dep === null) {
      const values = added.get(journey.raw.from_id) ?? new Set<bigint>();
      for (const value of eventSet(journey.raw.to_id)) values.add(value - duration(journey.raw.duration_minutes, MINUTE, [required.get(journey.raw.to_id)?.hours ?? 0, HOUR]));
      added.set(journey.raw.from_id, values);
    }
    for (const [id, values] of added) for (const value of values) eventSet(id).add(value);
  }
  const bundleIds = new Set(offers.filter(offer => offer.validated && offer.movement_ids.length > 1).flatMap(offer => offer.movement_ids));
  const initial: Label[] = spec.departures.map(gateway => ({ city: spec.home.id, phase: 0, mask: required.has(gateway.id) && gateway.id === spec.home.id ? bitOf(gateway.id) : 0,
    arrival: start, path: [], stays: [], reward: false, own_location: spec.home.id, own_used: false, rental_pickup: null, rental_start: null,
    charges: [], departure_gateway: gateway.id, arrival_gateway: "", price: null, return_mask: 0, revisiting: false, history: [], stay_hours: 0 }));
  const state: SearchState = previous?.signature === signature ? previous : { signature, queue: frontier(), labels: new Map(), completed: [], expanded: 0, pruned: 0 };
  if (state !== previous) for (const label of initial) enqueue(state.queue, label, spec.exchange_rates);
  const roundStartExpanded = state.expanded, expansionBudget = input.expansion_budget ?? null;
  const prepared = new Map<string, Prepared>(), timingCache = new Map<Journey, Omit<Timed, "journey">>(), historyCache = new Map<string, unknown[]>();
  function timing(journey: Journey) {
    const m = journey.raw, dep = journey.dep!, arr = journey.arr!;
    const service = m.segments.find(segment => !["transfer", "walk", "foot", "wait"].includes(segment.mode) && !(segment.source ?? "").startsWith("User-estimated airport") && segment.departure != null);
    const local = localTime(service?.departure ? micros(service.departure) : dep, places.get(m.from_id)!.timezone);
    const overnight = !spec.allow_overnight && localDate(dep, places.get(m.from_id)!.timezone) !== localDate(arr, places.get(m.from_id)!.timezone);
    return { dep, arr, usable: !overnight && (m.source === SUPPLIED || lowerTime <= local && local <= upperTime), homeDate: localDate(dep, spec.home.timezone) };
  }
  function prepare(city: string, target: string, phase: number): Prepared {
    const key = JSON.stringify([city, target, phase]), known = prepared.get(key); if (known) return known;
    const entries: Timed[] = [];
    for (const journey of edges.get(edgeKey(city, target)) ?? []) {
      if (!positioningAllowed(spec, journey.raw, phase) || journey.raw.vehicle_kind === "rental" && !spec.cars.rental_enabled) continue;
      if (journey.dep === null) { entries.push({ journey, dep: null, arr: null, homeDate: null }); continue; }
      let values = timingCache.get(journey) as ReturnType<typeof timing> | undefined;
      if (!values) { values = timing(journey); timingCache.set(journey, values); }
      if (values.usable && values.dep >= start && values.arr <= end) entries.push({ journey, ...values });
    }
    const value = { entries, departures: entries.filter(entry => entry.dep !== null).map(entry => entry.dep!).sort(compare), positions: new Map<number, Timed[]>() };
    prepared.set(key, value); return value;
  }
  function readyEntries(city: string, target: string, phase: number, ready: bigint) {
    const edge = prepare(city, target, phase), position = bisect(edge.departures, ready);
    let entries = edge.positions.get(position);
    if (!entries) { const threshold = edge.departures[position]; entries = edge.entries.filter(entry => entry.dep === null || threshold !== undefined && entry.dep >= threshold); edge.positions.set(position, entries); }
    return entries;
  }
  function targets(city: string, phase: number, mask: number, departureGateway: string, arrivalGateway: string, returnMask: number, ownLocation?: string) {
    if (phase === 0) return [departureGateway];
    if (phase === 1) { const ids = [...required.keys()].filter(id => !(mask & bitOf(id))); return spec.ordered_visits ? ids.slice(0, 1) : ids; }
    if (phase === 2) return [...new Set([arrivalGateway, ...[...required.keys()].filter(id => !(returnMask & bitOf(id)))])];
    return [...new Set([spec.home.id, ...(ownLocation ? [ownLocation] : [])])].filter(id => id !== city);
  }
  const latestCache = new Map<string, bigint | null>();
  function latest(city: string, phase: number, mask: number, reward: boolean, departureGateway: string, arrivalGateway: string, returnMask: number, revisiting: boolean): bigint | null {
    const key = JSON.stringify([city, phase, mask, reward, departureGateway, arrivalGateway, returnMask, revisiting]);
    if (latestCache.has(key)) return latestCache.get(key)!;
    const minimum = reward && !revisiting ? required.get(city)!.hours : 0;
    let best: bigint | null = null;
    if (phase === 0 && city === departureGateway) best = latest(city, 1, mask | bitOf(city), required.has(city), departureGateway, arrivalGateway, returnMask, revisiting);
    else if (phase === 1 && mask === fullMask) {
      if (!finishAtHome) best = end - duration(minimum, HOUR);
      else for (const gateway of spec.arrivals) { const value = latest(city, 2, mask, reward, departureGateway, gateway.id, bitOf(city), revisiting); if (value !== null && (best === null || value > best)) best = value; }
    } else if (phase === 2 && city === arrivalGateway) best = latest(city, 3, mask, reward, departureGateway, arrivalGateway, returnMask, revisiting);
    else if (phase === 3 && city === spec.home.id) best = end;
    else {
      for (const target of targets(city, phase, mask, departureGateway, arrivalGateway, returnMask)) {
        const nextReward = [1, 2].includes(phase) && required.has(target);
        const nextMask = mask | (nextReward ? bitOf(target) : 0), nextReturn = returnMask | (phase === 2 ? bitOf(target) : 0);
        const limit = latest(target, phase, nextMask, nextReward, departureGateway, arrivalGateway, nextReturn, phase === 2 && required.has(target));
        if (limit === null) continue;
        for (const entry of prepare(city, target, phase).entries) {
          const dep = entry.dep === null ? limit - duration(entry.journey.raw.duration_minutes, MINUTE) : entry.dep;
          if (entry.dep !== null && entry.arr! > limit) continue;
          if (best === null || dep > best) best = dep;
        }
      }
      if (best !== null) best -= duration(minimum, HOUR);
    }
    latestCache.set(key, best); return best;
  }
  function flightEntry(journey: Journey) {
    let value = historyCache.get(journey.raw.id);
    if (!value) {
      const segment = journey.raw.segments.find(segment => segment.mode === "flight" && segment.departure != null);
      const id = journey.raw.template_id ?? journey.raw.id;
      value = [journey.raw.from_id, journey.raw.to_id, localDate(segment?.departure ? micros(segment.departure) : journey.dep!, places.get(journey.raw.from_id)!.timezone), bundleIds.has(id) ? id : null];
      historyCache.set(journey.raw.id, value);
    }
    return value;
  }
  function rentalClose(label: Label, instant: bigint): Label | null {
    if (label.rental_pickup === null) return label;
    if (!spec.cars.rental_dropoffs.includes(label.city)) return null;
    const days = Math.max(1, Math.ceil(elapsed(instant - label.rental_start!, DAY))), cars = Math.ceil(spec.adults / spec.cars.rental_capacity);
    const daily = spec.cars.rental_daily_myr, drop = label.city === label.rental_pickup ? 0 : spec.cars.rental_one_way_myr;
    const value = daily === null || drop === null ? null : round((daily * days + spec.cars.rental_pickup_myr + drop) * cars);
    const charge = normalizeCharge({ id: `rental:${stableId(label.rental_pickup, datetimeString(label.rental_start!), label.city, datetimeString(instant))}`,
      kind: `Rental: ${days} day(s), pickup and drop-off`, mode: "rental", low: value, high: value, source: "rule",
      from_id: label.rental_pickup, to_id: label.city, country_code: places.get(label.rental_pickup)!.country_code } as Charge);
    return { ...label, rental_pickup: null, rental_start: null, charges: [...label.charges, charge], price: null };
  }
  function quote(label: Label) { label.price ??= pricePath(label.path, offers, spec, rules, label.charges, fares); return label.price; }
  function dominates(a: Label, b: Label) {
    if (a.arrival > b.arrival) return false;
    const sa = a.stay_hours + elapsed(b.arrival - a.arrival, HOUR) * Number(a.reward);
    const same = a.price!.uncertainty_key.length > 0 && compare(a.price!.uncertainty_key, b.price!.uncertainty_key) === 0;
    const cost = same ? a.price!.low_cents <= b.price!.low_cents && a.price!.high_cents <= b.price!.high_cents : a.price!.high_cents <= b.price!.low_cents;
    return cost && sa >= b.stay_hours - 1e-8;
  }
  function add(label: Label) {
    if (!spec.cars.own_enabled) {
      const limit = latest(label.city, label.phase, label.mask, label.reward, label.departure_gateway, label.arrival_gateway, label.return_mask, label.revisiting);
      if (limit === null || label.arrival > limit) { state.pruned++; return; }
    }
    quote(label);
    if (!spec.modes.includes("flight") && !bundleIds.size && spec.budget_myr !== null && label.price!.low_cents > cents(spec.budget_myr)) return;
    const key = JSON.stringify([label.city, label.phase, label.mask, label.reward, label.own_location, label.own_used, label.rental_pickup, label.rental_start?.toString() ?? null,
      label.departure_gateway, label.arrival_gateway, label.history, label.price!.uncertainty_key, label.return_mask, label.revisiting]);
    const bucket = state.labels.get(key) ?? [];
    if (bucket.some(old => dominates(old, label))) { state.pruned++; return; }
    state.labels.set(key, [...bucket.filter(old => !dominates(label, old)), label]); enqueue(state.queue, label, spec.exchange_rates);
  }
  function expand(initial: Label, target: string, journey: Journey, dep: bigint, arr: bigint, homeDate: string) {
    let current = initial;
    if (!current.path.length && spec.date_mode === "fixed" && homeDate !== spec.start_date) return;
    if (current.rental_pickup !== null && journey.raw.vehicle_kind !== "rental") { const closed = rentalClose(current, dep); if (!closed) return; current = closed; }
    let rentalPickup = current.rental_pickup, rentalStart = current.rental_start;
    if (journey.raw.vehicle_kind === "rental" && rentalPickup === null) { if (!spec.cars.rental_pickups.includes(current.city)) return; rentalPickup = current.city; rentalStart = dep; }
    let stays = current.stays, hours = current.stay_hours;
    if (current.reward) { const value = elapsed(dep - current.arrival, HOUR); stays = [...stays, { place_id: current.city, arrival: current.arrival, departure: dep, hours: value }]; hours += value; }
    const reward = [1, 2].includes(current.phase) && required.has(target);
    add({ ...current, city: target, mask: current.mask | (reward ? bitOf(target) : 0), arrival: arr, path: [...current.path, journey], stays, reward,
      own_location: journey.raw.vehicle_kind === "own" ? target : current.own_location, own_used: current.own_used || journey.raw.vehicle_kind === "own",
      rental_pickup: rentalPickup, rental_start: rentalStart, price: null,
      return_mask: current.return_mask | (current.phase === 2 ? bitOf(target) : 0), revisiting: current.phase === 2 && required.has(target),
      history: journey.raw.mode === "flight" ? [...current.history, flightEntry(journey)] : current.history, stay_hours: hours });
  }
  function window(value: bigint, place: Place, backwards = false) {
    const day = localDate(value, place.timezone), local = localTime(value, place.timezone);
    if (backwards) return local > upperTime ? at(day, spec.departure_end, place.timezone) : local < lowerTime ? at(addDate(day, -1), spec.departure_end, place.timezone) : value;
    return local < lowerTime ? at(day, spec.departure_start, place.timezone) : local > upperTime ? at(addDate(day, 1), spec.departure_start, place.timezone) : value;
  }
  while (state.queue.size && (limit === null || state.expanded < limit) && (expansionBudget === null || state.expanded - roundStartExpanded < expansionBudget) && performance.now() < deadline) {
    const label = dequeue(state.queue); state.expanded++;
    if (label.phase === 0 && label.city === label.departure_gateway) { add({ ...label, phase: 1, mask: label.mask | bitOf(label.city), reward: required.has(label.city) }); continue; }
    if (label.phase === 1 && label.mask === fullMask) {
      if (!finishAtHome) {
        const minimum = label.reward ? required.get(label.city)!.hours : 0, fixed = commitments.filter(item => item.place_id === label.city);
        if (label.arrival + duration(minimum, HOUR) > end || fixed.some(item => label.arrival > item.start || end < item.end)) continue;
        const stays = [...label.stays, { place_id: label.city, arrival: label.arrival, departure: end, hours: elapsed(end - label.arrival, HOUR) }];
        const closed = rentalClose({ ...label, stays, reward: false, arrival: end }, end);
        if (closed && (!closed.own_used || closed.own_location === spec.home.id)) { quote(closed); state.completed.push(closed); }
      } else for (const gateway of spec.arrivals) add({ ...label, phase: 2, arrival_gateway: gateway.id, return_mask: bitOf(label.city) });
      continue;
    }
    if (label.phase === 2 && label.city === label.arrival_gateway) { add({ ...label, phase: 3 }); continue; }
    if (label.phase === 3 && label.city === spec.home.id && (!label.own_used || label.own_location === spec.home.id)) {
      if (!label.path.length) continue;
      const closed = rentalClose(label, label.arrival); if (!closed) continue;
      if (spec.date_mode === "fixed" && localDate(closed.arrival, spec.home.timezone) !== spec.end_date) continue;
      quote(closed); state.completed.push(closed); continue;
    }
    const minimum = label.reward && !label.revisiting ? required.get(label.city)!.hours : 0;
    const fixed = label.reward && !label.revisiting ? commitments.filter(item => item.place_id === label.city) : [];
    if (fixed.some(item => label.arrival > item.start)) continue;
    const ready = maxInstant(label.arrival + duration(minimum, HOUR), ...fixed.map(item => item.end));
    for (const target of targets(label.city, label.phase, label.mask, label.departure_gateway, label.arrival_gateway, label.return_mask, label.own_used ? label.own_location : undefined)) {
      for (const entry of readyEntries(label.city, target, label.phase, ready)) {
        const template = entry.journey, m = template.raw;
        if (label.phase === 3 && label.own_used && label.own_location === label.city && label.city !== spec.home.id && target === spec.home.id && m.vehicle_kind !== "own") continue;
        if (m.vehicle_kind === "own" && (!spec.cars.own_enabled || label.own_location !== label.city || spec.adults > spec.cars.own_capacity)) continue;
        if (entry.dep !== null) { expand(label, target, template, entry.dep, entry.arr!, entry.homeDate!); continue; }
        const travel = duration(m.duration_minutes, MINUTE), place = places.get(label.city)!;
        const times = new Set([window(ready, place), window(end - travel, place, true)]);
        for (const event of eventSet(target)) times.add(window(event - travel - duration(required.get(target)?.hours ?? 0, HOUR), place, true));
        for (const instant of [...times].sort(compare)) {
          if (instant < ready) continue;
          const journey = normalizeJourney({ ...m, id: `${m.id}@${stableId(datetimeString(instant))}`, template_id: m.id, departure: iso(instant, true), arrival: iso(instant + travel, true) });
          const values = timing(journey);
          if (values.usable && values.dep >= ready && values.arr <= end && values.dep >= start) expand(label, target, journey, values.dep, values.arr, values.homeDate);
        }
      }
    }
  }
  const result = serialize(input, spec, state, places);
  result.excluded_unpriced_flight_count = skippedFlights.size;
  if (expansionBudget !== null) result.safety_limit_reached = state.queue.size > 0 && state.expanded - roundStartExpanded >= expansionBudget;
  return { result, state };
}

function serialize(input: SolverInput, spec: Spec, state: SearchState, places: Map<string, Place>): SolverResult {
  const stay = (label: Label) => label.stays.reduce((sum, value) => sum + value.hours, 0);
  let selectable = state.completed;
  if (spec.exclude_unpriced_flights) selectable = selectable.filter(label => flightPricesComplete(label, spec.exchange_rates));
  const eligible = selectable.filter(label => spec.budget_myr === null || label.price!.low_cents <= cents(spec.budget_myr));
  const over = selectable.filter(label => spec.budget_myr !== null && label.price!.low_cents > cents(spec.budget_myr))
    .sort((a, b) => compare([a.price!.low_cents, -stay(a)], [b.price!.low_cents, -stay(b)])).slice(0, 10);
  const finite = eligible.filter(label => label.price!.high_cents !== Infinity).sort((a, b) => compare(a.price!.high_cents, b.price!.high_cents));
  const highs: CostBound[] = [], bestStays: number[] = [], bestPrices: CostBound[] = [];
  let bestStay = -Infinity, bestPrice: CostBound = Infinity;
  for (const label of finite) { if (stay(label) > bestStay) { bestStay = stay(label); bestPrice = label.price!.high_cents; } highs.push(label.price!.high_cents); bestStays.push(bestStay); bestPrices.push(bestPrice); }
  const frontier = eligible.filter(label => {
    const i = bisect(highs, label.price!.low_cents, true) - 1;
    return !(i >= 0 && (bestStays[i] > stay(label) + 1e-8 || bestStays[i] >= stay(label) - 1e-8 && bestPrices[i] < label.price!.low_cents));
  });
  const routeId = (label: Label) => stableId(label.path.map(journey => [journey.raw.id, datetimeString(journey.dep!)]), label.departure_gateway, label.arrival_gateway);
  const unique = new Map<string, Label>();
  for (const label of [...frontier, ...over]) unique.set(routeId(label), label);
  const frontierIds = new Set(frontier.map(routeId));
  if (input.include_dominated) for (const label of eligible) unique.set(routeId(label), label);
  const thresholds = frontier.filter(label => label.price!.high_cents !== Infinity).map(label => [stay(label), currency(label.price!.high_cents)]).sort(compare);
  const thresholdStays: number[] = [], thresholdPrices: number[] = []; let maximum = -Infinity;
  for (const [hours, price] of thresholds) { maximum = Math.max(maximum, price); thresholdStays.push(hours); thresholdPrices.push(maximum); }
  const missing = new Map<string, SolverResult["missing_fares"][number]>(), routes: Route[] = [];
  for (const [id, label] of unique) {
    const price = label.price!, hours = stay(label), i = bisect(thresholdStays, hours + 1e-8, true) - 1;
    const breakEven = i >= 0 ? round(thresholdPrices[i] - price.cost_low_myr) : null;
    for (const item of price.missing) {
      const entry = missing.get(item.component_id) ?? { ...item, affected_itineraries: 0, break_even_myr: null };
      entry.affected_itineraries++; if (breakEven !== null) entry.break_even_myr = breakEven; missing.set(item.component_id, entry);
    }
    routes.push({ id, departure_gateway: label.departure_gateway, arrival_gateway: label.arrival_gateway,
      movements: label.path.map(journey => journey.raw), stays: label.stays.map(value => ({ ...value, arrival: iso(value.arrival), departure: iso(value.departure) })),
      stay_hours: round(hours, 4), travel_hours: round(label.path.reduce((sum, journey) => sum + journey.raw.duration_minutes, 0) / 60, 4),
      total_cost_myr: price.total_cost_myr, cost_low_myr: price.cost_low_myr, cost_high_myr: price.cost_high_myr,
      estimated: price.estimated || label.path.some(journey => journey.raw.schedule_estimated), schedule_estimated: label.path.some(journey => journey.raw.schedule_estimated),
      purchases: price.purchases, extra_charges: label.charges,
      budget_status: spec.budget_myr !== null && price.low_cents > cents(spec.budget_myr) ? "over" : spec.budget_myr !== null && (price.high_cents === Infinity || price.high_cents > cents(spec.budget_myr)) ? "uncertain" : "within",
      provisional: price.total_cost_myr === null, cost_per_stay_hour_myr: price.total_cost_myr !== null && hours > 0 ? round(price.total_cost_myr / hours) : null } as Route);
  }
  routes.sort((a, b) => compare([a.provisional, a.cost_low_myr, -a.stay_hours, a.id], [b.provisional, b.cost_low_myr, -b.stay_hours, b.id]));
  const candidates = new Map<string, unknown[]>(), ticketLegs = new Map<string, { key: string[]; leg: unknown }>();
  for (const label of state.completed) {
    const flights = label.path.filter(journey => journey.raw.mode === "flight");
    if (flights.length < 2) continue;
    const signature: string[][] = [], legs: unknown[] = [];
    for (const journey of flights) {
      let ticket = ticketLegs.get(journey.raw.id);
      if (!ticket) {
        const segment = journey.raw.segments.find(segment => segment.mode === "flight" && segment.departure != null), raw = segment?.departure;
        const departure = raw ? micros(raw) : journey.dep!;
        const date = localDate(departure, places.get(journey.raw.from_id)!.timezone);
        const departureText = raw ? raw.replace(/Z$/, "+00:00") : iso(departure);
        ticket = { key: [journey.raw.from_id, journey.raw.to_id, date], leg: { from_id: journey.raw.from_id, to_id: journey.raw.to_id, segments: [{ mode: "flight", departure: departureText }] } };
        ticketLegs.set(journey.raw.id, ticket);
      }
      signature.push(ticket.key); legs.push(ticket.leg);
    }
    const key = JSON.stringify(signature); if (!candidates.has(key)) candidates.set(key, legs);
  }
  const result: SolverResult = { routes: routes.filter(route => route.budget_status !== "over" && frontierIds.has(route.id)), refinement_routes: routes.filter(route => route.budget_status === "over"),
    bundle_candidates: [...candidates.values()], missing_fares: [...missing.values()].sort((a, b) => compare([-a.affected_itineraries, -(a.break_even_myr || 0), a.component_id], [-b.affected_itineraries, -(b.break_even_myr || 0), b.component_id])),
    expanded_labels: state.expanded, pruned_labels: state.pruned, feasible_count: state.completed.length, hidden_unpriced_flight_count: state.completed.length - selectable.length,
    excluded_unpriced_flight_count: 0, optimization_complete: !state.queue.size, remaining_labels: state.queue.size,
    label_limit: input.label_limit ?? null, snapshot_revision: input.snapshot_revision ?? 0, trip_revision: input.trip_revision ?? 0,
    optimality_scope: "Retrieved schedules, fare offers, and road departures at readiness / connection / return-boundary events" };
  if (input.include_dominated) result.dominated_routes = routes.filter(route => route.budget_status !== "over" && !frontierIds.has(route.id));
  if (spec.exclude_unpriced_flights) Object.assign(result, { flight_price_revision: 2 });
  return result;
}
