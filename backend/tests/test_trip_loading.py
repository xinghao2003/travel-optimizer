import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import httpx

from app import planner_api
from app.main import app
from app.planner_models import Visit
from app.planner_store import PlannerStore
from test_planner import A, trip


class TripLoadingTests(unittest.IsolatedAsyncioTestCase):
    async def test_required_stays_block_writes_and_search_but_legacy_trip_can_open(self):
        with tempfile.TemporaryDirectory() as folder:
            store = PlannerStore(Path(folder) / 'test.sqlite3')
            record = store.new_trip(trip().model_dump(mode='json'))
            store.put('jobs', 'old', {'id': 'old', 'trip_id': record['id']})
            with patch.object(planner_api, 'store', store):
                async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as client:
                    for path, payload, method in [
                        ('/trips', record['spec'], 'POST'),
                        (f'/trips/{record["id"]}', {'spec': record['spec'], 'expected_revision': 1}, 'PUT'),
                        (f'/trips/{record["id"]}/searches', {}, 'POST'),
                        ('/searches/old/continue', {}, 'POST'),
                    ]:
                        response = await client.request(method, '/api/v2' + path, json=payload)
                        self.assertEqual(response.status_code, 422, response.text)
                        self.assertIn('minimum stay', response.json()['detail'])
                    self.assertEqual((await client.get(f'/api/v2/trips/{record["id"]}?compact=true')).status_code, 200)
                    good = trip(visits=[Visit(place=A, min_stay_hours=.5)]).model_dump(mode='json')
                    self.assertEqual((await client.post('/api/v2/trips', json=good)).status_code, 201)

    async def test_trip_list_uses_summaries_in_a_worker_without_expanding_results(self):
        import threading
        with tempfile.TemporaryDirectory() as folder:
            store = PlannerStore(Path(folder) / 'test.sqlite3')
            record = store.new_trip(trip().model_dump(mode='json'))
            # A result whose route data cannot be expanded: the list needs none of it.
            record['result'] = {'_shared_route_data': {'version': 999}, 'routes': []}
            store.put('trips', record['id'], record)
            thread_ids = []
            original = store.trip_summaries
            def read():
                thread_ids.append(threading.get_ident())
                return original()
            with patch.object(planner_api, 'store', store), patch.object(store, 'trip_summaries', side_effect=read), patch.object(store, 'list', side_effect=AssertionError('Expanded full trips')):
                result = await planner_api.list_trips()
            self.assertEqual(result['trips'][0]['id'], record['id'])
            self.assertNotEqual(thread_ids[0], threading.get_ident())
