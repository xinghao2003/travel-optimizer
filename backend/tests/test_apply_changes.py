import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import httpx

from app import planner_api as api
from app.main import app
from app.planner_discovery import DiscoveryManager
from app.planner_store import PlannerStore
from test_planner import HOME, A, dt, fare, movement, trip


class ApplyChangesTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.store = PlannerStore(Path(self.folder.name)/'planner.sqlite3')
        self.spec = trip(modes=['rail'])
        self.moves = [movement('best', HOME, A, dt(10), dt(10, 10), 'rail'),
                      movement('weaker', HOME, A, dt(10), dt(10, 10), 'rail'),
                      movement('return', A, HOME, dt(12, 16), dt(12, 17), 'rail')]
        self.record = self.store.new_trip(self.spec.model_dump(mode='json'))
        self.record['snapshot'] = {'revision': 1, 'movements': [m.model_dump(mode='json') for m in self.moves],
            'offers': [fare('best', 10).model_dump(mode='json'), fare('weaker', 100).model_dump(mode='json'),
                       fare('return', 10).model_dump(mode='json')], 'roads': {}, 'coverage': {}}
        self.store.put('trips', self.record['id'], self.record)
        self.manager = DiscoveryManager(self.store)
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test')
        self.addAsyncCleanup(self.client.aclose)

    async def apply(self, payload):
        with patch.object(api, 'store', self.store), patch.object(api, 'manager', self.manager):
            return await self.client.post(f'/api/v2/trips/{self.record["id"]}/apply', json=payload)

    async def test_previously_weaker_route_becomes_best_from_full_saved_graph(self):
        before = await self.manager.recalculate(self.record['id'])
        self.assertEqual([r['movements'][0]['id'] for r in before['routes']], ['best'])
        with patch.object(self.manager, 'recalculate', wraps=self.manager.recalculate) as recalculate:
            response = await self.apply({'expected_revision': 1, 'connections': [], 'transfers': [],
                'estimates': [{'component_ids': ['weaker'], 'low': 1, 'high': 1, 'label': 'Corrected train price'}]})
            self.assertEqual(response.status_code, 200, response.text)
            self.assertEqual(recalculate.await_count, 1)
        saved = self.store.get('trips', self.record['id'])
        self.assertEqual(saved['revision'], 2)
        self.assertEqual([r['movements'][0]['id'] for r in saved['result']['routes']], ['weaker'])
        self.assertEqual(saved['result']['routes'][0]['total_cost_myr'], 11)
        self.assertEqual({m['id'] for m in saved['snapshot']['movements']}, {m.id for m in self.moves})

    async def test_invalid_category_rolls_back_every_edit(self):
        before = self.store.get('trips', self.record['id'])
        response = await self.apply({'expected_revision': 1,
            'connections': [{'from_airport': 'GMP', 'to_airport': 'ICN', 'mode': 'rail', 'duration_minutes': 45}],
            'estimates': [{'component_ids': ['unknown'], 'low': 5}]})
        self.assertEqual(response.status_code, 422, response.text)
        self.assertEqual(self.store.get('trips', self.record['id']), before)
        response = await self.apply({'expected_revision': 2, 'connections': []})
        self.assertEqual(response.status_code, 409)
        self.assertEqual(self.store.get('trips', self.record['id']), before)

    async def test_all_categories_commit_one_revision(self):
        with patch.object(self.manager, 'recalculate', wraps=self.manager.recalculate) as recalculate:
            response = await self.apply({'expected_revision': 1,
                'connections': [{'from_airport': 'GMP', 'to_airport': 'ICN', 'mode': 'rail', 'duration_minutes': 45, 'fare_amount': 13.25}],
                'transfers': [], 'estimates': [{'component_ids': ['best', 'weaker'], 'low': 7, 'high': 7}]})
            self.assertEqual(response.status_code, 200, response.text)
            self.assertEqual(recalculate.await_count, 1)
        saved = PlannerStore(self.store.path).get('trips', self.record['id'])
        self.assertEqual(saved['revision'], 2)
        self.assertEqual(saved['airport_connections'][0]['fare_amount'], 13.25)
        self.assertEqual(len(saved['offers']), 2)
