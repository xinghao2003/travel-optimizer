/** Weighted fair exploration across price tiers and starting branches.
 * Plain data keeps the active branch and quantum intact through structuredClone.
 */
import type { Frontier, Label, Spec } from "./types";

const schedule = [0, 0, 1, 0, 1, 2];
const quantum = 16;

export function flightPricesComplete(label: Label, rates: Spec["exchange_rates"]): boolean {
  const covered = new Set(label.price!.purchases.filter(offer => offer.low != null && offer.high != null && rates[offer.currency] !== undefined).flatMap(offer => offer.movement_ids));
  return label.path.every(journey => journey.raw.mode !== "flight" || covered.has(journey.raw.id));
}

export function frontier(): Frontier {
  return { buckets: [new Map(), new Map(), new Map()], turns: [[], [], []], active: null, remaining: 0, slot: 0, size: 0 };
}

export function enqueue(queue: Frontier, label: Label, rates: Spec["exchange_rates"]) {
  const priority = label.price === null || label.price.high_cents !== Infinity ? 0 : flightPricesComplete(label, rates) ? 1 : 2;
  const first = label.path.find(journey => journey.raw.mode === "flight") ?? label.path[0];
  const key = JSON.stringify([label.departure_gateway, first ? first.raw.template_id || first.raw.id : null]);
  const tier = queue.buckets[priority];
  if (!tier.has(key)) { tier.set(key, []); queue.turns[priority].push(key); }
  // The last element is popped next (depth first within a branch).
  tier.get(key)!.push(label);
  queue.size++;
}

export function dequeue(queue: Frontier): Label {
  if (queue.size === 0) throw new Error("pop from an empty frontier");
  if (queue.active) {
    const { priority, key } = queue.active, bucket = queue.buckets[priority].get(key)!;
    if (queue.remaining && bucket.length) { queue.remaining--; queue.size--; return bucket.pop()!; }
    if (bucket.length) queue.turns[priority].push(key);
    else queue.buckets[priority].delete(key);
  }
  for (;;) {
    const priority = schedule[queue.slot];
    queue.slot = (queue.slot + 1) % schedule.length;
    if (queue.turns[priority].length) {
      const key = queue.turns[priority].shift()!;
      queue.active = { priority, key };
      queue.remaining = quantum - 1;
      queue.size--;
      return queue.buckets[priority].get(key)!.pop()!;
    }
  }
}
