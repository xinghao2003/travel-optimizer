import tempfile
import unittest
from datetime import timedelta
from pathlib import Path
from unittest.mock import patch

import httpx

from app import planner_api as api
from app.main import app
from app.planner_discovery import DiscoveryManager
from app.planner_models import FareOffer, Movement, PricingRule, Segment, journey_price_scope
from app.planner_optimizer import price_path
from app.planner_store import PlannerStore
from test_planner import HOME, A, dt, fare, trip


FIELDS = ['stations', 'category', 'connections']


def journey(id='first', day=10, mode='highspeed_rail', service='ICE 100', via=False):
    segments = [Segment(mode=mode, from_name='Central', to_name='East' if via else 'North',
                        from_id='feed:central', to_id='feed:east' if via else 'feed:north',
                        departure=dt(day), arrival=dt(day, 10), from_timezone='UTC', to_timezone='UTC',
                        operator='Example Transit', service=service)]
    if via:
        segments.append(segments[0].model_copy(update={'from_name': 'East', 'from_id': 'feed:east',
                         'to_name': 'North', 'to_id': 'feed:north', 'service': 'RE 2',
                         'departure': dt(day, 11), 'arrival': dt(day, 12)}))
    return Movement(id=id, from_id=HOME.id, to_id=A.id, mode='bus' if mode == 'bus' else 'rail',
                    departure=segments[0].departure, arrival=segments[-1].arrival, duration_minutes=60,
                    segments=segments, transfers=int(via), source='Transitous / MOTIS')


def rule(movement, amount=95, fields=FIELDS, adults=1, id='estimate', priority=1):
    return PricingRule(id=id, name='Reusable estimate', mode=movement.mode, from_id=movement.from_id,
                       to_id=movement.to_id, unit='party', low=amount, high=amount,
                       priority=priority, journey_scope=journey_price_scope(movement, adults, fields))


class JourneyPricingTests(unittest.TestCase):
    def test_service_reuses_across_ids_dates_and_times(self):
        first = journey()
        later = journey('later', 11)
        later.segments[0].departure += timedelta(minutes=20)
        self.assertEqual(journey_price_scope(first, 1, ['service', *FIELDS]),
                         journey_price_scope(later, 1, [*FIELDS, 'service']))
        self.assertNotEqual(journey_price_scope(first, 1, [*FIELDS, 'date']),
                            journey_price_scope(later, 1, [*FIELDS, 'date']))
        scope = journey_price_scope(first, 1, [*FIELDS, 'service', 'operator', 'date', 'time'])
        self.assertEqual(scope.values, {'stations': '["feed:central","feed:north"]',
            'category': '["highspeed_rail"]', 'connections': '[]', 'service': '["ICE 100"]',
            'operator': '["Example Transit"]', 'date': '"2027-02-10"', 'time': '"09:00"'})

    def test_stations_connections_service_and_unknowns_do_not_merge(self):
        first = journey()
        self.assertNotEqual(journey_price_scope(first, 1, FIELDS), journey_price_scope(journey(via=True), 1, FIELDS))
        self.assertEqual(journey_price_scope(first, 1, ['operator']), journey_price_scope(journey(via=True), 1, ['operator']))
        other_station = journey('other')
        other_station.segments[0].to_id = 'feed:other'
        self.assertNotEqual(journey_price_scope(first, 1, FIELDS), journey_price_scope(other_station, 1, FIELDS))
        for field, attribute in [('service', 'service'), ('stations', 'from_id'), ('operator', 'operator')]:
            left, right = journey('left'), journey('right')
            setattr(left.segments[0], attribute, None)
            setattr(right.segments[0], attribute, None)
            self.assertNotEqual(journey_price_scope(left, 1, [field]), journey_price_scope(right, 1, [field]))
        self.assertEqual(journey_price_scope(journey(mode='bus', service='18'), 1, ['category']).values['category'], '["bus"]')

    def test_manual_then_provider_then_specific_reusable_estimate(self):
        spec, movement = trip(adults=2), journey()
        general = rule(movement, 90, adults=2)
        specific = rule(movement, 95, [*FIELDS, 'service'], adults=2, id='specific')
        price = lambda offers, rules: price_path([movement], offers, spec, rules)['cost_low_myr']
        self.assertEqual(price([], [general, specific]), 95)  # Whole-party price; not multiplied again.
        self.assertEqual(price([fare(movement.id, 120)], [specific]), 120)
        self.assertEqual(price([fare(movement.id, 120), fare('manual', 70, [movement.id], source='user')], [specific]), 70)
        self.assertIsNone(price_path([movement], [], trip(), [specific])['cost_high_myr'])
        self.assertIsNone(price_path([journey(via=True)], [], spec, [specific])['cost_high_myr'])


class ReusableJourneyApiTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.store = PlannerStore(Path(self.folder.name)/'planner.sqlite3')
        self.spec, self.movement = trip(), journey()
        self.record = self.store.new_trip(self.spec.model_dump(mode='json'))
        self.record['snapshot'] = {'revision': 1, 'movements': [self.movement.model_dump(mode='json')],
                                   'offers': [], 'roads': {}, 'coverage': {}}
        self.store.put('trips', self.record['id'], self.record)
        self.manager = DiscoveryManager(self.store)
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test')
        self.addAsyncCleanup(self.client.aclose)

    async def apply(self, estimate, revision=1):
        with patch.object(api, 'store', self.store), patch.object(api, 'manager', self.manager):
            return await self.client.post(f'/api/v2/trips/{self.record["id"]}/apply',
                json={'expected_revision': revision, 'estimates': [estimate]})

    async def test_persist_reuse_update_without_visible_journeys_and_remove(self):
        estimate = {'component_ids': ['first'], 'low': 95, 'high': 95, 'label': 'Train estimate',
                    'scope': journey_price_scope(self.movement, 1, FIELDS).model_dump(mode='json')}
        response = await self.apply(estimate)
        self.assertEqual(response.status_code, 200, response.text)
        saved = PlannerStore(self.store.path).get('trips', self.record['id'])
        self.assertEqual(saved['offers'], [])  # A reusable rule, not dated overrides.
        stored_rule = PricingRule.model_validate(saved['journey_pricing_rules'][0])
        self.assertEqual(price_path([journey('new-provider-result', 11)], [], self.spec, [stored_rule])['cost_low_myr'], 95)
        response = await self.apply(estimate | {'component_ids': [], 'low': 99, 'high': 99}, revision=2)
        self.assertEqual(response.status_code, 200, response.text)
        saved = self.store.get('trips', self.record['id'])
        self.assertEqual(len(saved['journey_pricing_rules']), 1)
        self.assertEqual(saved['journey_pricing_rules'][0]['low'], 99)
        with patch.object(api, 'store', self.store), patch.object(api, 'manager', self.manager):
            response = await self.client.delete(f'/api/v2/trips/{self.record["id"]}/journey-pricing-rules/{stored_rule.id}?expected_revision=3')
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(self.store.get('trips', self.record['id'])['journey_pricing_rules'], [])

    async def test_mismatched_scope_and_unseeded_rule_are_rejected_atomically(self):
        scope = journey_price_scope(self.movement, 1, FIELDS).model_dump(mode='json')
        for estimate in [
            {'component_ids': ['first'], 'scope': scope | {'adults': 2}},
            {'component_ids': ['first'], 'scope': scope | {'to_id': HOME.id}},
            {'component_ids': [], 'scope': scope},
        ]:
            response = await self.apply(estimate | {'low': 95, 'high': 95})
            self.assertEqual(response.status_code, 422, response.text)
            saved = self.store.get('trips', self.record['id'])
            self.assertEqual(saved['revision'], 1)
            self.assertFalse(saved.get('journey_pricing_rules'))

    async def test_individual_override_and_reusable_scope_can_be_applied_together(self):
        estimate = {'component_ids': ['first'], 'low': 95, 'high': 95,
                    'scope': journey_price_scope(self.movement, 1, FIELDS).model_dump(mode='json')}
        with patch.object(api, 'store', self.store), patch.object(api, 'manager', self.manager):
            response = await self.client.post(f'/api/v2/trips/{self.record["id"]}/apply', json={
                'expected_revision': 1, 'estimates': [estimate, {'component_ids': ['first'], 'low': 70, 'high': 70}]})
        self.assertEqual(response.status_code, 200, response.text)
        saved = self.store.get('trips', self.record['id'])
        rules = [PricingRule.model_validate(r) for r in saved['journey_pricing_rules']]
        offers = [FareOffer.model_validate(o) for o in saved['offers']]
        self.assertEqual(price_path([self.movement], offers, self.spec, rules)['cost_low_myr'], 70)
        self.assertEqual(price_path([journey('later', 11)], offers, self.spec, rules)['cost_low_myr'], 95)

    async def test_reuse_older_amount_without_retyping_splits_connection_patterns(self):
        via = journey('connecting', via=True)
        label = 'Shared estimate: original group'
        record = self.store.get('trips', self.record['id'])
        record['snapshot']['movements'].append(via.model_dump(mode='json'))
        record['offers'] = [FareOffer(id='user:'+m.id, movement_ids=[m.id], low=95, high=95,
                                     source='user', adults=1, label=label).model_dump(mode='json') for m in [self.movement, via]]
        self.store.put('trips', record['id'], record)
        with patch.object(api, 'store', self.store), patch.object(api, 'manager', self.manager):
            response = await self.client.post(f'/api/v2/trips/{record["id"]}/journey-pricing-rules/reuse', json={
                'expected_revision': 1, 'component_ids': ['first', 'connecting'], 'low': 95, 'high': 95,
                'currency': 'MYR', 'label': label, 'group_by': FIELDS})
        self.assertEqual(response.status_code, 200, response.text)
        saved = self.store.get('trips', record['id'])
        self.assertEqual(saved['offers'], [])
        rules = [PricingRule.model_validate(r) for r in saved['journey_pricing_rules']]
        self.assertEqual(len(rules), 2)
        self.assertEqual(price_path([journey('new-direct', 11)], [], self.spec, rules)['cost_low_myr'], 95)
        self.assertEqual(price_path([journey('new-connection', 11, via=True)], [], self.spec, rules)['cost_low_myr'], 95)
