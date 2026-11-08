"""Numeric cases shared with the independent native solver comparison."""
import unittest
from datetime import date, datetime, timedelta, timezone

from app.planner_models import Charge, Commitment, Movement, Segment, TripSpec, Visit
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


class NumericTimeTests(unittest.TestCase):
    def test_microsecond_schedules_across_the_supported_years(self):
        for year in [1, 1680, 2255, 2500, 9998]:
            with self.subTest(year=year):
                first = datetime(year, 2, 10, 9, microsecond=1, tzinfo=timezone.utc)
                last = datetime(year, 2, 12, 16, microsecond=3, tzinfo=timezone.utc)
                spec = TripSpec(home=HOME, visits=[Visit(place=A, min_stay_hours=0)], start_date=first.date(), end_date=last.date())
                moves = [movement('out', HOME, A, first, first + timedelta(microseconds=1)),
                         movement('back', A, HOME, last, last + timedelta(microseconds=1))]
                solved = optimize(spec, moves, [fare('out', 1), fare('back', 1)], [])
                self.assertTrue(solved['routes'])
                self.assertEqual(solved['routes'][0]['movements'][0]['arrival'], moves[0].arrival.isoformat().replace('+00:00', 'Z'))

    def test_a_connection_short_by_one_microsecond_is_rejected(self):
        first = datetime(2500, 2, 10, 9, tzinfo=timezone.utc)
        moves, offers = [], []
        for name, short in [('short', 1), ('valid', 0)]:
            segments = [Segment(mode='flight', from_name='Home', to_name='Hub', departure=first, arrival=first + timedelta(hours=1)),
                        Segment(mode='flight', from_name='Hub', to_name='A', departure=first + timedelta(minutes=90, microseconds=-short), arrival=first + timedelta(hours=2))]
            moves.append(movement(name, HOME, A, first, first + timedelta(hours=2), segments=segments))
            offers.append(fare(name, 1 if short else 10))
        moves.append(movement('back', A, HOME, first + timedelta(days=2), first + timedelta(days=2, hours=1)))
        offers.append(fare('back', 1))
        spec = TripSpec(home=HOME, visits=[Visit(place=A)], start_date=date(2500, 2, 10), end_date=date(2500, 2, 12))
        solved = optimize(spec, moves, offers, [])
        self.assertEqual({route['movements'][0]['id'] for route in solved['routes']}, {'valid'})

    def test_road_events_keep_microseconds_in_generated_timestamps_and_ids(self):
        spec = TripSpec(home=HOME, visits=[Visit(place=A, min_stay_hours=1)], start_date=date(2500, 2, 10), end_date=date(2500, 2, 12),
                        modes=['taxi'], home_departure_earliest='07:00:00.000001', departure_start='00:00')
        moves = [Movement(id='out', from_id=HOME.id, to_id=A.id, mode='taxi', duration_minutes=1.0000000166666667, source='fixture'),
                 Movement(id='back', from_id=A.id, to_id=HOME.id, mode='taxi', duration_minutes=2.00000005, source='fixture')]
        solved = optimize(spec, moves, [fare('out', 1), fare('back', 1)], [])
        self.assertTrue(solved['routes'])
        self.assertTrue(all('@' in route['movements'][0]['id'] for route in solved['routes']))

    def test_arriving_one_microsecond_after_a_commitment_is_rejected(self):
        first = datetime(2500, 2, 10, 9, tzinfo=timezone.utc)
        start = first + timedelta(hours=1, microseconds=1)
        spec = TripSpec(home=HOME, visits=[Visit(place=A)], start_date=first.date(), end_date=date(2500, 2, 12),
                        commitments=[Commitment(place_id=A.id, start=start, end=start + timedelta(hours=1))])
        moves = [movement('on-time', HOME, A, first, start), movement('late', HOME, A, first, start + timedelta(microseconds=1)),
                 movement('back', A, HOME, first + timedelta(days=2), first + timedelta(days=2, hours=1))]
        solved = optimize(spec, moves, [fare('on-time', 10), fare('late', 1), fare('back', 1)], [])
        self.assertEqual({route['movements'][0]['id'] for route in solved['routes']}, {'on-time'})

    def test_end_of_day_includes_last_microsecond_and_excludes_next_midnight(self):
        first = datetime(2500, 2, 10, 9, tzinfo=timezone.utc)
        midnight = datetime(2500, 2, 13, tzinfo=timezone.utc)
        spec = TripSpec(home=HOME, visits=[Visit(place=A)], start_date=first.date(), end_date=date(2500, 2, 12),
                        departure_start='00:00', departure_end='23:59:59.999999')
        moves = [movement('out', HOME, A, first, first + timedelta(hours=1)),
                 movement('valid', A, HOME, midnight - timedelta(hours=1), midnight - timedelta(microseconds=1)),
                 movement('late', A, HOME, midnight - timedelta(hours=1), midnight)]
        solved = optimize(spec, moves, [fare('out', 1), fare('valid', 10), fare('late', 1)], [])
        self.assertEqual({route['movements'][-1]['id'] for route in solved['routes']}, {'valid'})
