import asyncio
import pickle
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

import httpx

from app import planner_api, planner_discovery as discovery
from app.main import app
from app.planner_discovery import DiscoveryManager
from app.planner_models import Visit
from app.planner_optimizer import CHECKPOINT_VERSION, SearchCheckpoint, optimize
from app.planner_store import PlannerStore
from test_optimizer_checkpoint import inputs
from test_planner import HOME, A, dt, fare, movement, trip


class ContinuousOptimizationTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.folder = tempfile.TemporaryDirectory()
        self.addCleanup(self.folder.cleanup)
        self.store = PlannerStore(Path(self.folder.name) / 'planner.sqlite3')
        spec, moves, offers, _ = inputs()
        self.record = self.store.new_trip(spec.model_dump(mode='json'))
        self.record['snapshot'] = {'revision': 1, 'label_limit': 1, 'roads': {}, 'coverage': {},
            'movements': [m.model_dump(mode='json') for m in moves], 'offers': [o.model_dump(mode='json') for o in offers]}
        self.store.put('trips', self.record['id'], self.record)
        self.manager = DiscoveryManager(self.store)
        self.manager.fetch = AsyncMock(side_effect=AssertionError('Continuous checking must not call providers'))
        self.addAsyncCleanup(self.manager.close)

    async def finish(self, job):
        task = self.manager.continuous_running[job['id']]
        await asyncio.wait_for(asyncio.shield(task), timeout=10)
        return self.manager.continuous_status(job['id'])

    async def test_repeated_batches_resume_and_match_uninterrupted_solver(self):
        with patch.dict('os.environ', {'PLANNER_SOLVE_BATCH': '10'}), patch.object(discovery, 'optimize', wraps=optimize) as solver:
            job = self.manager.start_continuous(self.record['id'])
            self.assertEqual(job['status'], 'queued')
            final = await self.finish(job)
        self.assertEqual(final['status'], 'complete')
        self.assertGreater(final['batches'], 1)
        self.assertEqual(solver.call_args_list[1].kwargs['checkpoint'].resumed_from, 10)
        for call in solver.call_args_list:
            self.assertIsNone(call.args[7])  # Request-mode state allowance does not stop continuous batches.
        result = self.store.get('trips', self.record['id'])['result']
        self.assertEqual(result['routes'], optimize(*inputs())['routes'])
        self.assertEqual(result['expanded_labels'], optimize(*inputs())['expanded_labels'])
        self.assertEqual(final['checkpoint_bytes'], 0)
        self.manager.fetch.assert_not_awaited()

    async def test_start_and_stop_api_remain_responsive_while_solver_runs(self):
        started, release = threading.Event(), threading.Event()
        self.addCleanup(release.set)
        def held(*args, **kwargs):
            started.set()
            if not release.wait(4):
                raise AssertionError('Test did not release solver')
            return optimize(*args, **kwargs)
        with patch.object(planner_api, 'store', self.store), patch.object(planner_api, 'manager', self.manager), patch.object(discovery, 'optimize', side_effect=held):
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as client:
                response = await client.post(f'/api/v2/trips/{self.record["id"]}/optimizations')
                self.assertEqual(response.status_code, 202)
                job = response.json()
                self.assertTrue(await asyncio.to_thread(started.wait, 2))
                response = await asyncio.wait_for(client.post(f'/api/v2/optimizations/{job["id"]}/stop'), timeout=1)
                self.assertEqual(response.json()['status'], 'stopping')
                self.assertEqual((await client.get(f'/api/v2/optimizations/{job["id"]}')).json()['status'], 'stopping')
                release.set()
                final = await self.finish(job)
        self.assertEqual(final['status'], 'cancelled')
        self.assertIsNotNone(self.store.load_optimizer_checkpoint(self.record['id'], CHECKPOINT_VERSION))
        self.manager.fetch.assert_not_awaited()

    async def test_large_saved_checkpoints_do_not_pause_before_or_after_a_batch(self):
        with patch.dict('os.environ', {'PLANNER_SOLVE_BATCH': '10'}), patch.object(self.store, 'optimizer_checkpoint_size', return_value=600 * 1024 * 1024):
            job = self.manager.start_continuous(self.record['id'])
            self.assertNotIn('checkpoint_limit_bytes', job)
            final = await self.finish(job)
        self.assertEqual((final['status'], final['pause_reason']), ('complete', None))
        self.assertGreater(final['batches'], 1)
        self.assertEqual(final['checkpoint_bytes'], 600 * 1024 * 1024)
        self.manager.fetch.assert_not_awaited()

    async def test_single_slot_idempotent_start_and_stop_before_first_batch(self):
        job = self.manager.start_continuous(self.record['id'])
        self.assertEqual(self.manager.start_continuous(self.record['id'])['id'], job['id'])
        other = self.store.new_trip(self.record['spec'])
        with self.assertRaisesRegex(ValueError, 'other continuous'):
            self.manager.start_continuous(other['id'])
        self.manager.stop_continuous(job['id'])
        final = await self.finish(job)
        self.assertEqual(final['status'], 'cancelled')
        self.assertEqual(final['batches'], 0)

    async def test_discovery_cannot_overlap_continuous_checking(self):
        self.store.put('jobs', 'discovery', {'id': 'discovery', 'trip_id': self.record['id'], 'status': 'running'})
        with self.assertRaisesRegex(ValueError, 'transport search'):
            self.manager.start_continuous(self.record['id'])
        self.store.delete('jobs', 'discovery')
        job = self.manager.start_continuous(self.record['id'])
        with self.assertRaisesRegex(ValueError, 'Stop checking'):
            self.manager.start(self.record['id'])
        self.manager.stop_continuous(job['id'])
        await self.finish(job)

    async def test_restart_recovers_interrupted_job_and_reuses_saved_checkpoint(self):
        checkpoint = SearchCheckpoint()
        optimize(*inputs(), checkpoint=checkpoint, expansion_budget=10)
        self.store.save_optimizer_checkpoint(self.record['id'], CHECKPOINT_VERSION, pickle.dumps(checkpoint, protocol=5))
        self.store.put('optimizations', 'old', {'id': 'old', 'trip_id': self.record['id'], 'status': 'running'})
        self.store.recover()
        self.assertEqual(self.store.get('optimizations', 'old')['status'], 'interrupted')
        with patch.object(discovery, 'optimize', wraps=optimize) as solver:
            job = self.manager.start_continuous(self.record['id'])
            self.assertEqual((await self.finish(job))['status'], 'complete')
        self.assertEqual(solver.call_args.kwargs['checkpoint'].resumed_from, 10)

    async def test_apply_stops_checker_before_saving_edits(self):
        started, release = threading.Event(), threading.Event()
        self.addCleanup(release.set)
        def held(*args, **kwargs):
            started.set()
            if not release.wait(4):
                raise AssertionError('Test did not release solver')
            return optimize(*args, **kwargs)
        with patch.object(discovery, 'optimize', side_effect=held):
            job = self.manager.start_continuous(self.record['id'])
            self.assertTrue(await asyncio.to_thread(started.wait, 2))
            apply = asyncio.create_task(self.manager.apply_changes(self.record['id'], lambda t: {**t, 'revision': t['revision'] + 1}))
            await asyncio.sleep(.01)
            self.assertEqual(self.manager.continuous_status(job['id'])['status'], 'stopping')
            release.set()
            await asyncio.wait_for(apply, timeout=5)
        final = self.manager.continuous_status(job['id'])
        self.assertEqual((final['status'], final['pause_reason']), ('paused', 'changes'))
        self.assertEqual(self.store.get('trips', self.record['id'])['revision'], 2)


class HiddenFlightPriceTests(unittest.TestCase):
    def test_flight_without_a_present_bundle_partner_is_excluded_before_exploration(self):
        spec = trip(visits=[Visit(place=A, min_stay_hours=1)], modes=['flight'], exclude_unpriced_flights=True)
        out = movement('out', HOME, A, dt(10), dt(10, 10))
        back = movement('back', A, HOME, dt(12, 16), dt(12, 17))
        offers = [fare('different-round-trip', 50, ['out', 'different-return'], kind='round-trip'), fare('back', 10)]
        result = optimize(spec, [out, back], offers, [])
        self.assertEqual(result['feasible_count'], 0)
        self.assertEqual(result['routes'], [])
        self.assertEqual(result['hidden_unpriced_flight_count'], 0)
        self.assertEqual(result['excluded_unpriced_flight_count'], 1)
        shown = optimize(spec.model_copy(update={'exclude_unpriced_flights': False}), [out, back], offers, [])
        self.assertTrue(shown['routes'])
        self.assertEqual(shown['hidden_unpriced_flight_count'], 0)
        self.assertEqual(shown['excluded_unpriced_flight_count'], 0)
