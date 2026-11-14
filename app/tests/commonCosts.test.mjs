import assert from "node:assert/strict";
import { test } from "node:test";
import { loadTs } from "./loadTs.mjs";
const { commonCosts, openItems, priceDecisions } = await loadTs("../src/lib/commonCosts.ts");

const rates = { MYR: 1, JPY: 0.03 };
const fare = (id, low, high = low, extra = {}) => ({ id: `fare:${id}`, movement_ids: [id], kind: "one-way", low, high, currency: "MYR", source: "provider", ...extra });
const noFare = id => fare(id, null, null, { id: `unknown:${id}`, source: "unknown" });
const charge = (id, kind, from_id, to_id) => ({ id, kind, mode: "taxi", from_id, to_id });
const journey = (id, from_id, to_id, extra = {}) => ({ id, from_id, to_id, mode: "flight", charges: [], ...extra });
const option = (id, stay_hours, movements, purchases, extra = {}) => {
  const low = purchases.reduce((sum, offer) => sum + (offer.low ?? 0) * (rates[offer.currency] ?? 0), 0);
  const open = purchases.some(offer => offer.low === null || offer.high === null);
  const high = open ? null : purchases.reduce((sum, offer) => sum + offer.high * rates[offer.currency], 0);
  return { id, stay_hours, movements, purchases, extra_charges: [], cost_low_myr: low, cost_high_myr: high, total_cost_myr: high === low ? low : null, ...extra };
};
// The flight home with its two airport taxis: every option below has it, each as its own variant of one template.
const home = variant => journey(`home:${variant}`, "SEL", "KUL", { template_id: "home", charges: [
  charge(`home:${variant}:access`, "Airport access", "SEL", "airport:ICN"), charge(`home:${variant}:egress`, "Airport egress", "airport:KUL", "KUL")] });
const homeFares = variant => [noFare(`home:${variant}`), noFare(`home:${variant}:access`), noFare(`home:${variant}:egress`)];

test("prices that every best option is missing are common costs and leave the options comparable", () => {
  const train = option("train", 44.6, [journey("rail", "KUL", "SEL", { mode: "rail" }), home(1)], [fare("rail", 3), ...homeFares(1)]);
  const flight = option("flight", 38.6, [journey("out", "KUL", "SEL"), home(2)], [noFare("out"), fare("x", 35), ...homeFares(2)]);
  const later = option("later", 38.6, [journey("out2", "KUL", "SEL"), home(3)], [noFare("out2"), fare("x", 50), ...homeFares(3)]);
  assert.deepEqual(openItems(train, rates).map(item => item.key), ["journey:home", "transfer:SEL>airport:ICN:taxi", "transfer:airport:KUL>KUL:taxi"]);

  const common = commonCosts([train, flight, later], rates);
  assert.deepEqual(common.items.map(item => item.offer.id), ["unknown:home:1", "unknown:home:1:access", "unknown:home:1:egress"]);
  const [a, b, c] = [train, flight, later].map(common.adjust);
  // Only common costs are open: the option has the price of its priced part.
  assert.deepEqual([a.total_cost_myr, a.cost_high_myr, a.common_offer_ids], [3, 3, ["unknown:home:1", "unknown:home:1:access", "unknown:home:1:egress"]]);
  // Its own flight has no price: the total stays unknown, with the common costs marked.
  assert.deepEqual([b.total_cost_myr, b.cost_high_myr, b.common_offer_ids], [null, null, ["unknown:home:2", "unknown:home:2:access", "unknown:home:2:egress"]]);
  assert.equal(train.common_offer_ids, undefined);

  // Both flight options already cost more than the train option, with less time in cities.
  const decisions = priceDecisions([a, b, c], rates);
  assert.deepEqual([...decisions.beaten], [["flight", "train"], ["later", "train"]]);
  assert.deepEqual([decisions.questions, decisions.asked, decisions.open], [[], [], []]);

  // One option alone has no common costs, and an option without one of them stays as it is.
  assert.deepEqual(commonCosts([train], rates).items, []);
  assert.equal(commonCosts([train], rates).adjust(train), train);
  const other = option("other", 40, [journey("rail", "KUL", "SEL", { mode: "rail" })], [fare("rail", 3)]);
  assert.equal(common.adjust(other), other);
});

test("a price range of the priced part stays a range", () => {
  const a = option("a", 100, [journey("out", "KUL", "SEL"), home(1)], [fare("out", 900, 1000), fare("y", 9000, 10000, { currency: "JPY" }), ...homeFares(1)]);
  const b = option("b", 110, [journey("out2", "KUL", "SEL"), home(2)], [fare("out2", 1500), ...homeFares(2)]);
  const [first] = [a, b].map(commonCosts([a, b], rates).adjust);
  assert.deepEqual([first.cost_low_myr, first.cost_high_myr, first.total_cost_myr], [1170, 1300, null]);
});

test("one journey price that decides between two options gives a question", () => {
  const priced = option("priced", 120, [journey("ktx", "SEL", "PUS", { mode: "rail" }), home(1)], [fare("ktx", 3180), ...homeFares(1)]);
  const bus = option("bus", 120, [journey("bus:v1", "SEL", "PUS", { mode: "bus", template_id: "bus" }), home(2)], [fare("z", 3085), noFare("bus:v1"), ...homeFares(2)]);
  // The same bus on a shorter option: the question with the higher amount covers both.
  const short = option("short", 100, [journey("bus:v2", "SEL", "PUS", { mode: "bus", template_id: "bus" }), home(3)], [fare("z", 3100), noFare("bus:v2"), ...homeFares(3)]);
  // More time in cities than every priced option: no amount decides it.
  const longest = option("longest", 150, [journey("late", "SEL", "PUS"), home(4)], [fare("z", 3000), noFare("late"), ...homeFares(4)]);
  const two = option("two", 110, [journey("p", "SEL", "PUS"), journey("q", "PUS", "SEL"), home(5)], [fare("z", 100), noFare("p"), noFare("q"), ...homeFares(5)]);
  const taxi = option("taxi", 110, [journey("r", "SEL", "PUS", { charges: [charge("r:access", "Airport access", "SEL", "airport:GMP")] }), home(6)], [fare("r", 100), noFare("r:access"), ...homeFares(6)]);
  const openEnded = option("open", 110, [journey("s", "SEL", "PUS"), home(7)], [fare("s", 100, null), ...homeFares(7)]);
  const routes = [priced, bus, short, longest, two, taxi, openEnded];
  const decisions = priceDecisions(routes.map(commonCosts(routes, rates).adjust), rates);
  assert.deepEqual(decisions.questions.map(question => [question.item.key, question.routeId, question.rivalId, question.under]), [["journey:bus", "bus", "priced", 95]]);
  assert.deepEqual(decisions.asked, ["bus", "short"]);
  assert.deepEqual(decisions.open, ["longest", "two", "taxi", "open"]);
  assert.deepEqual([...decisions.beaten], []);

  // Without a priced option there is nothing to compare with.
  const none = priceDecisions([bus, longest].map(commonCosts([bus, longest], rates).adjust), rates);
  assert.deepEqual([none.questions, none.open], [[], ["bus", "longest"]]);
  // The same bus in both options is a common cost of the two.
  assert.deepEqual([bus, short].map(commonCosts([bus, short], rates).adjust).map(route => route.total_cost_myr), [3085, 3100]);
});
