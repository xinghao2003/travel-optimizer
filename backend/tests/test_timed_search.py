import pickle
import asyncio
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

from pydantic import ValidationError

from app import planner_discovery as discovery
from app.planner_api import OptimizationRequest, SearchRequest
from app.planner_discovery import DiscoveryManager
from app.planner_optimizer import CHECKPOINT_VERSION, optimize
from app.planner_store import PlannerStore
from test_planner import HOME, A, dt, fare, movement, trip


class Clock:
    value = 0.0
    def monotonic(self): return self.value
    def time(self): return 1000+self.value


def query(key):
    return {'kind': 'flight', 'key': key, 'from_id': HOME.id, 'to_id': A.id, 'date': '2027-02-10'}


class TimedSearchTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.store = PlannerStore(Path(self.directory.name) / 'planner.sqlite3')
        self.spec = trip(modes=['rail'])
        self.record = self.store.new_trip(self.spec.model_dump(mode='json'))
        self.manager = DiscoveryManager(self.store)

    async def test_time_replaces_requests_and_continue_uses_new_round_deadline(self):
        clock = Clock()
        tasks = [query(str(i)) for i in range(6)]
        async def fetch(*args):
            clock.value += 3
            return {'status': 'empty', 'options': []}, True
        self.manager.fetch = AsyncMock(side_effect=fetch)
        self.manager.publish = AsyncMock()
        with patch.object(discovery, 'clock', clock), patch.object(discovery, 'tasks_for', return_value=tasks):
            first = self.manager.start(self.record['id'], budget=1, minutes=10/60)
            await self.manager.running[first['id']]
            paused = self.store.get('jobs', first['id'])
            self.assertEqual((paused['status'], paused['pause_reason'], paused['cursor']), ('paused', 'time', 4))
            self.assertEqual(paused['batch_requests'], 4)
            self.assertEqual(paused['round_elapsed_seconds'], 12)  # Finish the in-flight task.
            self.manager.start(self.record['id'], budget=1, job_id=first['id'], minutes=10/60)
            await self.manager.running[first['id']]
            final = self.store.get('jobs', first['id'])
            self.assertEqual((final['status'], final['cursor'], final['batch_requests']), ('complete', 6, 2))
            self.assertEqual(final['round_elapsed_seconds'], 6)
            self.assertEqual([call.args[0]['key'] for call in self.manager.fetch.call_args_list], list(map(str, range(6))))

    async def test_timed_solve_ignores_state_allowance(self):
        moves = [movement('out', HOME, A, dt(10), dt(10, 10), 'rail'),
                 movement('back', A, HOME, dt(12, 16), dt(12, 17), 'rail')]
        self.record['snapshot'] = {'revision': 1, 'label_limit': 1, 'roads': {}, 'coverage': {},
                                  'movements': [m.model_dump(mode='json') for m in moves],
                                  'offers': [fare(m.id, 10).model_dump(mode='json') for m in moves]}
        self.store.put('trips', self.record['id'], self.record)
        with patch.object(discovery, 'tasks_for', return_value=[]):
            job = self.manager.start(self.record['id'], budget=1, minutes=1)
            await self.manager.running[job['id']]
        result = self.store.get('trips', self.record['id'])['result']
        self.assertTrue(result['optimization_complete'])
        self.assertGreater(result['expanded_labels'], 1)
        self.assertIsNone(result['label_limit'])
        self.assertEqual(self.store.get('jobs', job['id'])['status'], 'complete')
        self.assertIsNone(self.store.load_optimizer_checkpoint(self.record['id'], CHECKPOINT_VERSION))

    async def test_expired_round_saves_data_without_starting_another_solver(self):
        clock = Clock()
        async def fetch(*args):
            clock.value = 11
            return {'status': 'empty', 'options': []}, True
        self.manager.fetch = AsyncMock(side_effect=fetch)
        self.manager.recalculate = AsyncMock(side_effect=AssertionError('solver started after deadline'))
        with patch.object(discovery, 'clock', clock), patch.object(discovery, 'tasks_for', return_value=[query('one')]):
            job = self.manager.start(self.record['id'], minutes=10/60)
            await self.manager.running[job['id']]
        saved = self.store.get('jobs', job['id'])
        self.assertEqual(saved['status'], 'paused')
        self.assertTrue(saved['optimization_pending'])
        self.assertEqual(saved['cursor'], 1)
        self.manager.recalculate.assert_not_awaited()

    async def test_continuation_finishes_pending_optimizer_before_new_provider_data(self):
        clock = Clock()
        tasks = [query(str(i)) for i in range(2)]
        self.manager.publish = AsyncMock()
        self.manager.fetch = AsyncMock(return_value=({'status': 'empty', 'options': []}, True))
        with patch.object(discovery, 'clock', clock), patch.object(discovery, 'tasks_for', return_value=tasks):
            job = self.manager.start(self.record['id'], budget=1)
            await self.manager.running[job['id']]
            self.store.update('jobs', job['id'], lambda j: {**j, 'optimization_pending': True})
            order = []
            async def publish(job, spec, final=False):
                order.append('solve')
                job['optimization_pending'] = False
            async def fetch(*args):
                order.append('fetch')
                return {'status': 'empty', 'options': []}, True
            self.manager.publish.side_effect = publish
            self.manager.fetch.side_effect = fetch
            self.manager.start(self.record['id'], job_id=job['id'], minutes=1)
            await self.manager.running[job['id']]
        self.assertEqual(order[:2], ['solve', 'fetch'])

    async def test_timed_round_processes_queries_added_by_final_publication(self):
        calls = []
        async def publish(job, spec, final=False):
            if not calls:
                calls.append('added')
                job['queue'].append(query('follow-up'))
        self.manager.publish = AsyncMock(side_effect=publish)
        self.manager.fetch = AsyncMock(return_value=({'status': 'empty', 'options': []}, True))
        with patch.object(discovery, 'tasks_for', return_value=[]):
            job = self.manager.start(self.record['id'], minutes=1)
            await self.manager.running[job['id']]
        self.manager.fetch.assert_awaited_once()
        self.assertEqual(self.store.get('jobs', job['id'])['status'], 'complete')

    async def test_time_paused_optimizer_resumes_after_restart_with_no_queries_pending(self):
        from test_optimizer_checkpoint import inputs
        spec, moves, offers, rules = inputs()
        self.record.update(spec=spec.model_dump(mode='json'), snapshot={
            'revision': 1, 'label_limit': 1, 'roads': {}, 'coverage': {},
            'movements': [m.model_dump(mode='json') for m in moves],
            'offers': [o.model_dump(mode='json') for o in offers]})
        self.store.put('trips', self.record['id'], self.record)
        self.manager.fetch = AsyncMock(return_value=({'status': 'empty', 'options': []}, True))
        clock = Clock()
        def tick():
            clock.value += .001
            return clock.value
        clock.monotonic = tick
        with patch.object(discovery, 'clock', clock), patch('app.planner_optimizer.clock', clock), patch.object(discovery, 'tasks_for', return_value=[]):
            job = self.manager.start(self.record['id'], minutes=.05/60)
            await self.manager.running[job['id']]
            paused = self.store.get('jobs', job['id'])
            self.assertEqual((paused['status'], paused['pause_reason']), ('paused', 'time'))
            self.assertEqual(paused['cursor'], len(paused['queue']))
            checkpoint = pickle.loads(self.store.load_optimizer_checkpoint(self.record['id'], CHECKPOINT_VERSION))
            self.assertGreater(checkpoint.expanded, 0)
            restarted = DiscoveryManager(PlannerStore(self.store.path))
            restarted.fetch = AsyncMock(return_value=({'status': 'empty', 'options': []}, True))
            with patch.object(discovery, 'optimize', wraps=optimize) as solver:
                restarted.start(self.record['id'], job_id=job['id'], minutes=1)
                await restarted.running[job['id']]
                self.assertEqual(solver.call_args.kwargs['checkpoint'].resumed_from, checkpoint.expanded)
        result = self.store.get('trips', self.record['id'])['result']
        expected = optimize(spec, moves, offers, rules)
        for field in ('routes', 'expanded_labels', 'feasible_count', 'optimization_complete'):
            self.assertEqual(result[field], expected[field])
        self.assertEqual(self.store.get('jobs', job['id'])['status'], 'complete')

    async def test_search_api_accepts_time_and_rejects_invalid_minutes(self):
        import httpx
        from app import main, planner_api
        self.manager.publish = AsyncMock()
        with patch.object(planner_api, 'store', self.store), patch.object(planner_api, 'manager', self.manager), patch.object(discovery, 'tasks_for', return_value=[]):
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app), base_url='http://test') as client:
                response = await client.post(f'/api/v2/trips/{self.record["id"]}/searches', json={'budget': 1, 'minutes': 10})
                self.assertEqual(response.status_code, 202)
                job = response.json()
                self.assertEqual(job['time_budget_seconds'], 600)
                await self.manager.running[job['id']]
                response = await client.post(f'/api/v2/searches/{job["id"]}/continue', json={'minutes': 5})
                self.assertEqual(response.status_code, 202)
                self.assertEqual(response.json()['time_budget_seconds'], 300)
                await self.manager.running[job['id']]
                for minutes in (0, -1, 1441):
                    response = await client.post(f'/api/v2/trips/{self.record["id"]}/searches', json={'minutes': minutes})
                    self.assertEqual(response.status_code, 422)

    async def test_stop_during_optimization_immediately_exposes_resumable_work(self):
        started, release = threading.Event(), threading.Event()
        def held_solver(*args, **kwargs):
            started.set()
            if not release.wait(2):
                raise AssertionError('test did not release solver')
            return optimize(*args, **kwargs)
        with patch.object(discovery, 'tasks_for', return_value=[]), patch.object(discovery, 'optimize', side_effect=held_solver):
            job = self.manager.start(self.record['id'], minutes=1)
            self.assertTrue(await asyncio.to_thread(started.wait, 2))
            stopped = self.manager.cancel(job['id'])
            self.assertTrue(stopped['optimization_pending'])
            release.set()
            await self.manager.running[job['id']]
        self.assertEqual(self.store.get('jobs', job['id'])['status'], 'cancelled')
        self.assertIsNotNone(self.store.load_optimizer_checkpoint(self.record['id'], CHECKPOINT_VERSION))

    def test_minutes_validation(self):
        for model in (SearchRequest, OptimizationRequest):
            self.assertEqual(model(minutes=10).minutes, 10)
            for minutes in (0, -1, float('inf'), float('nan'), 1441):
                with self.subTest(model=model.__name__, minutes=minutes), self.assertRaises(ValidationError):
                    model(minutes=minutes)
