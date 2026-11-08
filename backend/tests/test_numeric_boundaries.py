"""Numeric cases shared with the independent native solver comparison."""
import unittest

from app.planner_models import Charge
from app.planner_optimizer import cents, optimize, price_path
from test_planner import HOME, A, dt, fare, movement, trip


class NumericPriceTests(unittest.TestCase):
    def test_large_fare_keeps_small_component_cents_and_correct_float_output(self):
        moves = [movement('out', HOME, A, dt(10), dt(10, 10)), movement('back', A, HOME, dt(12, 16), dt(12, 17))]
        for small in [.01, .02, .03, .07, .99]:
            with self.subTest(small=small):
                offers = [fare('out', 1e14), fare('back', small)]
                result = price_path(moves, offers, trip(), [])
                self.assertEqual(result['low_cents'], 10_000_000_000_000_000 + cents(small))
                self.assertEqual(result['total_cost_myr'], result['low_cents'] / 100)
                self.assertTrue(optimize(trip(), moves, offers, [])['routes'])

    def test_bundle_cover_compares_exact_cents_before_offer_id_ties(self):
        moves = [movement('out', HOME, A, dt(10), dt(10, 10)), movement('back', A, HOME, dt(12, 16), dt(12, 17))]
        # The bundle wins by one cent. Rounding the sum to a Number makes the
        # two covers appear tied and can select the smaller standalone IDs.
        offers = [fare('a-out', 1e14, ['out']), fare('a-back', .01, ['back']), fare('z-bundle', 1e14, ['out', 'back'])]
        result = price_path(moves, offers, trip(), [])
        self.assertEqual([offer['id'] for offer in result['purchases']], ['fare:z-bundle'])
        solved = optimize(trip(), moves, offers, [])
        self.assertEqual([offer['id'] for offer in solved['routes'][0]['purchases']], ['fare:z-bundle'])

    def test_large_lower_bound_and_unknown_upper_stay_distinct(self):
        moves = [movement('out', HOME, A, dt(10), dt(10, 10), charges=[Charge(id='access', kind='Access', low=.01, high=.01)]),
                 movement('back', A, HOME, dt(12, 16), dt(12, 17))]
        offers = [fare('out', 1e14), fare('back', None)]
        result = price_path(moves, offers, trip(), [])
        self.assertEqual(result['low_cents'], 10_000_000_000_000_001)
        self.assertIsNone(result['total_cost_myr'])
        self.assertTrue(result['missing'])
        self.assertTrue(optimize(trip(), moves, offers, [])['routes'])

    def test_large_float_display_does_not_change_decimal_cents(self):
        move = movement('out', HOME, A, dt(10), dt(10, 10))
        for value in [1.0000000000000001e18, 1.2345678901234568e21, 9.999999999999999e24]:
            with self.subTest(value=value):
                result = price_path([move], [fare('out', value)], trip(), [])
                self.assertEqual(result['low_cents'], cents(value))
                self.assertEqual(result['total_cost_myr'], cents(value) / 100)

    def test_budget_classification_uses_exact_sum_before_public_float_rounding(self):
        moves = [movement('out', HOME, A, dt(10), dt(10, 10)), movement('back', A, HOME, dt(12, 16), dt(12, 17))]
        for small in [.01, .02, .03]:
            with self.subTest(small=small):
                spec = trip(budget_myr=1e14)
                solved = optimize(spec, moves, [fare('out', 1e14), fare('back', small)], [])
                self.assertFalse(solved['routes'])
                self.assertEqual(solved['refinement_routes'][0]['budget_status'], 'over')
