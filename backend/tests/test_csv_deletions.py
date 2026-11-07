import copy
import json
import tempfile
import unittest
from pathlib import Path

from fastapi import HTTPException

from app.planner_api import ApplyChangesRequest, apply_missing_info
from app.planner_models import FareOffer, TripSpec
from app.planner_optimizer import price_path
from app.planner_store import PlannerStore
from test_planner import HOME, A, dt, movement, trip


class CsvDeletionTests(unittest.TestCase):
    def setUp(self):
        self.move = movement('out', HOME, A, dt(10), dt(10, 10), 'rail')
        self.provider = FareOffer(id='provider', movement_ids=['out'], low=20, high=20).model_dump(mode='json')
        self.manual = FareOffer(id='manual', movement_ids=['out'], low=7, high=7, source='user').model_dump(mode='json')
        self.record = {'id': 'trip', 'revision': 3, 'spec': trip().model_dump(mode='json'),
                       'snapshot': {'revision': 1, 'movements': [self.move.model_dump(mode='json')], 'offers': [self.provider]},
                       'offers': [self.manual], 'journey_pricing_rules': [{'id': 'rule'}],
                       'airport_connections': [{'from_airport': 'AAA', 'to_airport': 'BBB', 'mode': 'bus', 'duration_minutes': 30}],
                       'airport_transfer_estimates': [{'from_id': 'home', 'to_id': 'airport:AAA', 'adults': 1, 'mode': 'taxi'}]}
        self.record['spec']['exchange_rates']['TWD'] = .15

    def test_all_deletions_commit_once_and_preserve_provider_schedules(self):
        request = ApplyChangesRequest(expected_revision=3, deletions=[
            {'kind': 'offer', 'id': 'manual'}, {'kind': 'journey_rule', 'id': 'rule'},
            {'kind': 'exchange_rate', 'id': 'TWD'}, {'kind': 'airport_change', 'id': 'AAA>BBB'},
            {'kind': 'airport_transfer', 'id': json.dumps(['home', 'airport:AAA', 1, 'taxi'], separators=(',', ':'))}])
        before = copy.deepcopy(self.record)
        with tempfile.TemporaryDirectory() as folder:
            store = PlannerStore(Path(folder)/'test.sqlite3')
            store.put('trips', 'trip', self.record)
            store.update('trips', 'trip', lambda t: apply_missing_info(t, request))
            saved = store.get('trips', 'trip')
        self.assertEqual(saved['revision'], 4)
        for field in ('offers', 'journey_pricing_rules', 'airport_connections', 'airport_transfer_estimates'):
            self.assertEqual(saved[field], [])
        self.assertEqual(saved['spec']['exchange_rates'], {'MYR': 1})
        self.assertEqual(saved['snapshot'], before['snapshot'])
        self.assertEqual(self.record, before)

    def test_deleting_manual_price_restores_provider_fare(self):
        spec = TripSpec.model_validate(self.record['spec'])
        offers = [FareOffer.model_validate(self.provider), FareOffer.model_validate(self.manual)]
        self.assertEqual(price_path([self.move], offers, spec, [])['total_cost_myr'], 7)
        saved = apply_missing_info(self.record, ApplyChangesRequest(expected_revision=3, deletions=[{'kind': 'offer', 'id': 'manual'}]))
        offers = [FareOffer.model_validate(o) for o in saved['snapshot']['offers']+saved['offers']]
        self.assertEqual(price_path([self.move], offers, spec, [])['total_cost_myr'], 20)

    def test_invalid_deletion_rolls_back_updates_and_valid_deletions(self):
        for kind, id in [('offer', 'provider'), ('offer', 'missing'), ('exchange_rate', 'MYR'), ('airport_change', 'BBB>AAA')]:
            with self.subTest(kind=kind, id=id), tempfile.TemporaryDirectory() as folder:
                store = PlannerStore(Path(folder)/'test.sqlite3')
                store.put('trips', 'trip', self.record)
                request = ApplyChangesRequest(expected_revision=3, exchange_rates={'USD': 4}, deletions=[{'kind': 'offer', 'id': 'manual'}, {'kind': kind, 'id': id}])
                with self.assertRaises(HTTPException) as error:
                    store.update('trips', 'trip', lambda t: apply_missing_info(t, request))
                self.assertEqual(error.exception.status_code, 422)
                self.assertEqual(store.get('trips', 'trip'), self.record)

    def test_rate_update_delete_conflict_and_stale_revision_are_rejected(self):
        with self.assertRaises(HTTPException) as error:
            apply_missing_info(self.record, ApplyChangesRequest(expected_revision=3, exchange_rates={'TWD': .2}, deletions=[{'kind': 'exchange_rate', 'id': 'TWD'}]))
        self.assertEqual(error.exception.status_code, 422)
        with self.assertRaises(HTTPException) as error:
            apply_missing_info(self.record, ApplyChangesRequest(expected_revision=2, deletions=[{'kind': 'offer', 'id': 'manual'}]))
        self.assertEqual(error.exception.status_code, 409)
