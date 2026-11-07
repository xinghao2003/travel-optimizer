import asyncio
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

import httpx

from app import planner_api as api
from app import planner_discovery as discovery, planner_optimizer as optimizer
from app.main import app
from app.planner_discovery import DiscoveryManager
from app.planner_store import PlannerStore
from test_planner import HOME, A, dt, fare, movement, trip
from test_timed_search import Clock, query


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

    async def wait_for_job(self, id):
        while task := self.manager.running.get(id):
            await asyncio.shield(task)

    async def test_active_apply_stops_old_solver_and_keeps_original_time_allowance(self):
        started = threading.Event()
        clock = Clock()
        deadlines = []
        def held(*args, **kwargs):
            deadlines.append(kwargs['deadline'])
            if len(deadlines) == 1:
                started.set()
                stop = time.monotonic()+2
                while not args[6]() and time.monotonic() < stop:
                    threading.Event().wait(.001)
                self.assertTrue(args[6]())
            return optimizer.optimize(*args, **kwargs)
        self.manager.fetch = AsyncMock(side_effect=AssertionError('no provider query expected'))
        with patch.object(discovery, 'clock', clock), patch.object(optimizer, 'clock', clock), patch.object(discovery, 'tasks_for', return_value=[]), patch.object(discovery, 'optimize', side_effect=held):
            job = self.manager.start(self.record['id'], minutes=10/60)
            self.assertTrue(await asyncio.to_thread(started.wait, 2))
            clock.value = 4
            response = await self.apply({'expected_revision': 1, 'estimates': [{'component_ids': ['weaker'], 'low': 1, 'high': 1}]})
            self.assertEqual(response.status_code, 202, response.text)
            await self.wait_for_job(job['id'])
        self.assertEqual(deadlines, [10, 10])
        saved_job = self.store.get('jobs', job['id'])
        self.assertEqual((saved_job['requests'], saved_job['batch_requests'], saved_job['round_elapsed_seconds']), (0, 0, 4))
        result = self.store.get('trips', self.record['id'])['result']
        self.assertEqual(result['trip_revision'], 2)
        self.assertEqual(result['routes'][0]['movements'][0]['id'], 'weaker')
        self.assertEqual(result['routes'][0]['total_cost_myr'], 11)

    async def test_expiry_during_apply_saves_changes_without_starting_extra_time(self):
        started = threading.Event()
        clock = Clock()
        def held(*args, **kwargs):
            started.set()
            stop = time.monotonic()+2
            while not args[6]() and time.monotonic() < stop:
                threading.Event().wait(.001)
            clock.value = 11
            return optimizer.optimize(*args, **kwargs)
        with patch.object(discovery, 'clock', clock), patch.object(optimizer, 'clock', clock), patch.object(discovery, 'tasks_for', return_value=[]), patch.object(discovery, 'optimize', side_effect=held) as solver:
            job = self.manager.start(self.record['id'], minutes=10/60)
            self.assertTrue(await asyncio.to_thread(started.wait, 2))
            response = await self.apply({'expected_revision': 1, 'estimates': [{'component_ids': ['weaker'], 'low': 1, 'high': 1}]})
            self.assertEqual(response.status_code, 200, response.text)
            self.assertEqual(solver.call_count, 1)
            self.assertNotIn(job['id'], self.manager.running)
        paused = self.store.get('jobs', job['id'])
        self.assertEqual((paused['status'], paused['pause_reason']), ('paused', 'time'))
        self.assertTrue(paused['updating_options'])
        self.assertEqual(self.store.get('trips', self.record['id'])['revision'], 2)
        with patch.object(discovery, 'clock', clock), patch.object(optimizer, 'clock', clock):
            self.manager.start(self.record['id'], job_id=job['id'], minutes=10/60)
            await self.wait_for_job(job['id'])
        self.assertEqual(self.store.get('trips', self.record['id'])['result']['routes'][0]['movements'][0]['id'], 'weaker')

    async def test_in_flight_response_is_saved_and_request_budget_is_not_reset(self):
        started, release = asyncio.Event(), asyncio.Event()
        tasks = [{'kind': 'road', 'key': 'matrix'}, query('next')]
        calls = []
        async def fetch(task, *args):
            calls.append(task['key'])
            if task['kind'] == 'road':
                started.set()
                await release.wait()
                return {'status': 'success', 'roads': {'home->a': {'duration_minutes': 30, 'distance_km': 10}}}, True
            return {'status': 'empty', 'options': []}, True
        self.manager.fetch = fetch
        with patch.object(discovery, 'tasks_for', return_value=tasks):
            job = self.manager.start(self.record['id'], budget=1)
            await started.wait()
            applied = asyncio.create_task(self.apply({'expected_revision': 1, 'estimates': [{'component_ids': ['weaker'], 'low': 1, 'high': 1}]}))
            for _ in range(100):
                if job['id'] in self.manager.applying_jobs:
                    break
                await asyncio.sleep(0)
            self.assertIn(job['id'], self.manager.applying_jobs)
            self.assertFalse(applied.done())
            release.set()
            response = await applied
            self.assertEqual(response.status_code, 202, response.text)
            await self.wait_for_job(job['id'])
        saved = self.store.get('trips', self.record['id'])
        self.assertEqual(calls, ['matrix'])
        self.assertEqual(saved['snapshot']['roads']['home->a']['distance_km'], 10)
        paused = self.store.get('jobs', job['id'])
        self.assertEqual((paused['cursor'], paused['requests'], paused['batch_requests']), (1, 1, 1))
        self.assertEqual(paused['status'], 'paused')
        self.assertEqual(saved['result']['routes'][0]['movements'][0]['id'], 'weaker')

    async def test_apply_to_paused_timed_job_waits_for_explicit_continuation(self):
        with patch.object(discovery, 'tasks_for', return_value=[]):
            job = self.manager.start(self.record['id'], minutes=1)
            await self.wait_for_job(job['id'])
        with patch.object(self.manager, 'recalculate', wraps=self.manager.recalculate) as solver:
            response = await self.apply({'expected_revision': 1, 'estimates': [{'component_ids': ['weaker'], 'low': 1}]})
            self.assertEqual(response.status_code, 200, response.text)
            solver.assert_not_awaited()
        self.assertEqual(response.json()['job']['status'], 'paused')
        self.assertTrue(response.json()['updating'])
        self.assertNotIn(job['id'], self.manager.running)

    async def test_rejected_active_apply_resumes_original_search_without_editing(self):
        started, release = asyncio.Event(), asyncio.Event()
        async def fetch(*args):
            started.set()
            await release.wait()
            return {'status': 'empty', 'options': []}, True
        self.manager.fetch = fetch
        with patch.object(discovery, 'tasks_for', return_value=[query('one')]):
            job = self.manager.start(self.record['id'], budget=1)
            await started.wait()
            applied = asyncio.create_task(self.apply({'expected_revision': 1, 'connections': [],
                'estimates': [{'component_ids': ['missing'], 'low': 1}]}))
            for _ in range(100):
                if job['id'] in self.manager.applying_jobs:
                    break
                await asyncio.sleep(0)
            release.set()
            response = await applied
            self.assertEqual(response.status_code, 422, response.text)
            await self.wait_for_job(job['id'])
        saved = self.store.get('trips', self.record['id'])
        self.assertEqual(saved['revision'], 1)
        self.assertEqual(saved['offers'], [])
        self.assertEqual(saved['result']['routes'][0]['movements'][0]['id'], 'best')
        self.assertNotIn(job['id'], self.manager.applying_jobs)
