import pickle
import unittest
from collections import Counter, deque

from app.planner_models import Charge, PricingRule, Visit, stable_id
from app.planner_optimizer import CHECKPOINT_VERSION, INF, Label, SearchCheckpoint, SearchFrontier, optimize, price_path
from test_optimizer_checkpoint import inputs
from test_planner import HOME, A, B, dt, fare, movement, trip


def state(branch, tier):
    move = movement(branch, HOME, A, dt(10), dt(10, 10))
    price = {'high_cents': 10 if tier == 0 else INF,
             'purchases': [fare(branch, 10)] if tier != 2 else []}
    return Label(A.id, 1, 1, move.arrival, [move], [], departure_gateway=HOME.id, price=price)


class FairFrontierTests(unittest.TestCase):
    def test_replenishing_a_deep_branch_cannot_starve_another_branch_or_price_tier(self):
        frontier = SearchFrontier({'MYR': 1})
        for branch, tier in [('deep', 0), ('other', 0), ('flight-priced', 1), ('unpriced', 2)]:
            frontier.appendleft(state(branch, tier))
        visits = Counter()
        for _ in range(len(frontier.schedule) * frontier.quantum * 2):
            label = frontier.popleft()
            visits[label.path[0].id] += 1
            frontier.appendleft(label)
        self.assertEqual(set(visits), {'deep', 'other', 'flight-priced', 'unpriced'})
        self.assertGreater(visits['deep'] + visits['other'], visits['unpriced'])
        self.assertEqual(len(frontier), 4)

    def test_newly_priced_children_move_to_the_higher_priority_tier(self):
        frontier = SearchFrontier({'MYR': 1})
        original = state('bundle-out', 2)
        frontier.appendleft(original)
        self.assertIs(frontier.popleft(), original)
        back = movement('bundle-back', A, HOME, dt(12, 16), dt(12, 17))
        child = original.but(path=[*original.path, back], price={
            'high_cents': 500, 'purchases': [fare('round-trip', 5, ['bundle-out', 'bundle-back'])]})
        frontier.appendleft(child)
        self.assertIn((HOME.id, 'bundle-out'), frontier.buckets[0])
        self.assertIs(frontier.popleft(), child)

    def test_priced_options_appear_before_large_unpriced_subtrees_are_exhausted(self):
        spec = trip(visits=[Visit(place=A, min_stay_hours=6), Visit(place=B, min_stay_hours=6)],
                    ordered_visits=True, exclude_unpriced_flights=True)
        moves = [movement('priced-out', HOME, A, dt(10), dt(10, 10)),
                 movement('unpriced-out', HOME, A, dt(10), dt(10, 10))]
        offers = [fare('priced-out', 10)]
        for i in range(100):
            moves.append(movement(f'train-{i}', A, B, dt(11), dt(11, 10), 'rail'))
            offers.append(fare(f'train-{i}', 1).model_copy(update={'high': 2}))
        moves.append(movement('back', B, HOME, dt(12, 16), dt(12, 17)))
        offers.append(fare('back', 10))
        result = optimize(spec, moves, offers, [], expansion_budget=100)
        self.assertFalse(result['optimization_complete'])
        self.assertTrue(result['routes'])
        self.assertTrue(all(r['cost_high_myr'] is not None for r in result['routes']))
        self.assertTrue(all(r['movements'][0]['id'] == 'priced-out' for r in result['routes']))

    def test_matching_legacy_deque_preserves_completed_and_explored_work(self):
        args = inputs()
        checkpoint = SearchCheckpoint()
        optimize(*args, checkpoint=checkpoint, expansion_budget=30)
        expanded, completed = checkpoint.expanded, len(checkpoint.completed)
        spec, moves, offers, rules = args
        checkpoint.signature = stable_id(1, spec.model_dump(mode='json'),
            [m.model_dump(mode='json') for m in moves], [o.model_dump(mode='json') for o in offers],
            [r.model_dump(mode='json') for r in rules], True)
        checkpoint.queue = deque(checkpoint.queue)
        checkpoint = pickle.loads(pickle.dumps(checkpoint, protocol=5))
        result = optimize(*args, checkpoint=checkpoint, expansion_budget=10)
        self.assertEqual(checkpoint.resumed_from, expanded)
        self.assertEqual(checkpoint.expanded, expanded + 10)
        self.assertGreaterEqual(len(checkpoint.completed), completed)
        self.assertIsInstance(checkpoint.queue, SearchFrontier)
        result = optimize(*args, checkpoint=checkpoint)
        self.assertEqual(result['routes'], optimize(*args)['routes'])


class FlightEligibilityTests(unittest.TestCase):
    def setUp(self):
        self.spec = trip(visits=[Visit(place=A, min_stay_hours=1)], exclude_unpriced_flights=True)
        self.out = movement('out', HOME, A, dt(10), dt(10, 10))
        self.back = movement('back', A, HOME, dt(12, 16), dt(12, 17))

    def test_combined_ticket_without_one_way_fares_remains_eligible(self):
        result = optimize(self.spec, [self.out, self.back], [fare('bundle', 40, ['out', 'back'])], [])
        self.assertEqual(result['excluded_unpriced_flight_count'], 0)
        self.assertEqual(result['routes'][0]['total_cost_myr'], 40)

    def test_combined_ticket_covers_airport_transfer_variants_by_template(self):
        moves = [self.out.model_copy(update={'id': 'out:variant', 'template_id': 'out'}),
                 self.back.model_copy(update={'id': 'back:variant', 'template_id': 'back'})]
        result = optimize(self.spec, moves, [fare('bundle', 40, ['out', 'back'])], [])
        self.assertEqual(result['excluded_unpriced_flight_count'], 0)
        self.assertEqual(result['routes'][0]['total_cost_myr'], 40)

    def test_invalid_or_incomplete_fares_do_not_admit_an_unpriced_flight(self):
        for changes in [{'validated': False}, {'adults': 2}, {'currency': 'USD'}, {'high': None}]:
            with self.subTest(changes=changes):
                offers = [fare('bundle', 40, ['out', 'back']).model_copy(update=changes), fare('back', 10)]
                result = optimize(self.spec, [self.out, self.back], offers, [])
                self.assertEqual(result['excluded_unpriced_flight_count'], 1)
                self.assertEqual(result['feasible_count'], 0)
                self.assertEqual(result['routes'], [])

    def test_bundle_partner_outside_the_trip_cannot_keep_an_unpriced_flight(self):
        late_back = self.back.model_copy(update={'departure': dt(13, 16), 'arrival': dt(13, 17)})
        result = optimize(self.spec, [self.out, late_back], [fare('bundle', 40, ['out', 'back'])], [])
        self.assertEqual(result['excluded_unpriced_flight_count'], 2)
        self.assertEqual(result['feasible_count'], 0)

    def test_priced_bundle_survives_unknown_airport_costs(self):
        outward = self.out.model_copy(update={"charges": [Charge(id="access", kind="Airport access")]})
        offers = [fare("bundle", 40, ["out", "back"], kind="round-trip")]
        result = optimize(self.spec, [outward, self.back], offers, [])
        self.assertEqual(result["hidden_unpriced_flight_count"], 0)
        route = result["routes"][0]
        self.assertEqual((route["cost_low_myr"], route["cost_high_myr"]), (40, None))
        self.assertEqual([o["id"] for o in route["purchases"] if o["kind"] == "round-trip"], ["fare:bundle"])
        self.assertEqual({d["component_id"] for d in result["missing_fares"]}, {"access"})
        # An incomplete ticket still cannot pass the price filter.
        self.assertEqual(optimize(self.spec, [outward, self.back], offers[:0], [])["routes"], [])

    def test_bundle_pricing_change_invalidates_old_filtered_checkpoints(self):
        outward = self.out.model_copy(update={"charges": [Charge(id="access", kind="Airport access")]})
        moves = [outward, self.back]; offers = [fare("bundle", 40, ["out", "back"], kind="round-trip")]
        checkpoint = SearchCheckpoint()
        optimize(self.spec, moves, offers, [], checkpoint=checkpoint)
        checkpoint.signature = stable_id(CHECKPOINT_VERSION, self.spec.model_dump(mode="json"),
            [m.model_dump(mode="json") for m in moves], [o.model_dump(mode="json") for o in offers], [], True)
        checkpoint.completed = []; checkpoint.expanded = 999
        result = optimize(self.spec, moves, offers, [], checkpoint=checkpoint)
        self.assertEqual(checkpoint.resumed_from, 0)
        self.assertTrue(result["routes"])

    def test_other_unknown_charges_do_not_change_unfiltered_pricing_policy(self):
        outward = self.out.model_copy(update={"charges": [Charge(id="access", kind="Airport access")]})
        spec = self.spec.model_copy(update={"exclude_unpriced_flights": False})
        price = price_path([outward, self.back], [fare("bundle", 40, ["out", "back"], kind="round-trip")], spec, [])
        self.assertEqual(price["cost_low_myr"], 0)

    def test_user_estimate_rule_can_price_a_flight_before_exploration(self):
        rule = PricingRule(id='out-estimate', name='Outward estimate', from_id=HOME.id, to_id=A.id,
                           mode='flight', low=20, currency='MYR')
        result = optimize(self.spec, [self.out, self.back], [fare('back', 10)], [rule])
        self.assertEqual(result['excluded_unpriced_flight_count'], 0)
        self.assertEqual(result['routes'][0]['total_cost_myr'], 30)


if __name__ == '__main__':
    unittest.main()
