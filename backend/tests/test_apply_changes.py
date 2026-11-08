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
from app.planner_models import Visit
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

    async def test_edit_on_existing_best_route_can_promote_another_route_through_bundle_pricing(self):
        self.record['spec'] = trip(modes=['flight']).model_dump(mode='json')
        moves = [movement('out', HOME, A, dt(10), dt(10, 10)),
                 movement('bundled-return', A, HOME, dt(12, 16), dt(12, 17)),
                 movement('other-return', A, HOME, dt(12, 16), dt(12, 17))]
        offers = [fare('out', 100), fare('bundled-return', 100), fare('other-return', 1),
                  fare('bundle', 50, ['out', 'bundled-return'], kind='round-trip')]
        self.record['snapshot'].update(movements=[m.model_dump(mode='json') for m in moves],
                                       offers=[o.model_dump(mode='json') for o in offers])
        self.store.put('trips', self.record['id'], self.record)
        before = await self.manager.recalculate(self.record['id'])
        self.assertEqual(len(before['routes']), 1)
        self.assertEqual(before['routes'][0]['movements'][-1]['id'], 'bundled-return')
        self.assertEqual(before['routes'][0]['total_cost_myr'], 50)
        # Edit a journey already visible in the best route. The unseen route
        # benefits differently because the earlier best used a bundled ticket.
        response = await self.apply({'expected_revision': 1,
            'estimates': [{'component_ids': ['out'], 'low': 1, 'high': 1}]})
        self.assertEqual(response.status_code, 200, response.text)
        result = self.store.get('trips', self.record['id'])['result']
        self.assertEqual(len(result['routes']), 1)
        self.assertEqual(result['routes'][0]['movements'][-1]['id'], 'other-return')
        self.assertEqual(result['routes'][0]['total_cost_myr'], 2)

    async def test_all_categories_commit_one_revision(self):
        with patch.object(self.manager, 'recalculate', wraps=self.manager.recalculate) as recalculate:
            response = await self.apply({'expected_revision': 1,
                'connections': [{'from_airport': 'GMP', 'to_airport': 'ICN', 'mode': 'rail', 'duration_minutes': 45, 'fare_amount': 13.25}],
                'transfers': [], 'exchange_rates': {'TWD': .15}, 'estimates': [{'component_ids': ['best', 'weaker'], 'low': 7, 'high': 7, 'currency': 'TWD'}]})
            self.assertEqual(response.status_code, 200, response.text)
            self.assertEqual(recalculate.await_count, 1)
        saved = PlannerStore(self.store.path).get('trips', self.record['id'])
        self.assertEqual(saved['revision'], 2)
        self.assertEqual(saved['airport_connections'][0]['fare_amount'], 13.25)
        self.assertEqual(saved['spec']['exchange_rates']['TWD'], .15)
        self.assertEqual(saved['result']['routes'][0]['total_cost_myr'], 11.05)
        self.assertEqual(len(saved['offers']), 2)

    async def test_rates_only_apply_and_invalid_rate_roll_back_the_batch(self):
        for rates in ({'USD': 0}, {'USD': -1}, {'USD': float('inf')}, {'MYR': 2}, {'usd': 4}, {'XX': 4}):
            if any(value == float('inf') for value in rates.values()):
                rates = {'USD': 'Infinity'}
            response = await self.apply({'expected_revision': 1, 'exchange_rates': rates,
                'connections': [{'from_airport': 'AAA', 'to_airport': 'BBB', 'mode': 'bus', 'duration_minutes': 40}]})
            self.assertEqual(response.status_code, 422, response.text)
            self.assertEqual(self.store.get('trips', self.record['id']), self.record)
        with patch.object(self.manager, 'recalculate', wraps=self.manager.recalculate) as recalculate:
            response = await self.apply({'expected_revision': 1, 'exchange_rates': {'USD': 4.5}})
            self.assertEqual(response.status_code, 200, response.text)
            self.assertEqual(recalculate.await_count, 1)
        saved = PlannerStore(self.store.path).get('trips', self.record['id'])
        self.assertEqual(saved['revision'], 2)
        self.assertEqual(saved['spec']['exchange_rates'], {'MYR': 1, 'USD': 4.5})

    async def test_airport_time_edit_recovers_a_previously_unusable_saved_journey(self):
        home = HOME.model_copy(update={'airport_codes': ['KUL'], 'flight_code': 'KUL'})
        city = A.model_copy(update={'airport_codes': ['PUS'], 'flight_code': 'PUS'})
        spec = trip().model_copy(update={'home': home, 'departures': [home], 'arrivals': [home],
                                        'visits': [Visit(place=city)]})
        segments = [dict(mode='flight', from_id='KUL', to_id='GMP', from_name='KUL', to_name='GMP',
                         departure=dt(10, 10).isoformat(), arrival=dt(10, 11).isoformat()),
                    dict(mode='flight', from_id='ICN', to_id='PUS', from_name='ICN', to_name='PUS',
                         departure=dt(10, 12).isoformat(), arrival=dt(10, 13).isoformat())]
        changing = discovery.flight_movement(home, city, segments, spec, {})
        self.assertFalse(changing.usable)
        moves = [self.moves[0], changing, self.moves[-1]]
        self.record.update(spec=spec.model_dump(mode='json'), airport_connections=[
            dict(from_airport='GMP', to_airport='ICN', mode='rail', duration_minutes=90, fare_amount=0)],
            airport_transfer_estimates=[dict(from_id=home.id, to_id='airport:KUL', adults=1, mode='taxi', duration_minutes=10, low=0, high=0, currency='MYR'),
                dict(from_id='airport:PUS', to_id=city.id, adults=1, mode='taxi', duration_minutes=10, low=0, high=0, currency='MYR')])
        self.record['snapshot'].update(movements=[m.model_dump(mode='json') for m in moves],
            offers=[fare(m.id, 1 if m.id != 'best' else 10).model_dump(mode='json') for m in moves])
        self.store.put('trips', self.record['id'], self.record)
        before = await self.manager.recalculate(self.record['id'])
        self.assertEqual(len(before['routes']), 1)
        self.assertEqual(before['routes'][0]['movements'][0]['id'], 'best')
        response = await self.apply({'expected_revision': 1, 'connections': [
            dict(from_airport='GMP', to_airport='ICN', mode='rail', duration_minutes=15, fare_amount=0)]})
        self.assertEqual(response.status_code, 200, response.text)
        result = self.store.get('trips', self.record['id'])['result']
        recovered = [r for r in result['routes'] if any((m.get('template_id') or m['id']) == changing.id for m in r['movements'])]
        self.assertTrue(recovered)
        self.assertEqual(recovered[0]['total_cost_myr'], 2)

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
