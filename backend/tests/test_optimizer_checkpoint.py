import pickle
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from app.planner_discovery import DiscoveryManager
from app.planner_models import Visit
from app.planner_optimizer import CHECKPOINT_VERSION, SearchCheckpoint, optimize
from app.planner_store import PlannerStore
from test_planner import HOME, A, B, dt, fare, movement, trip


def inputs():
    spec = trip(visits=[Visit(place=A, min_stay_hours=6), Visit(place=B, min_stay_hours=6)])
    moves = []
    for a, b in [(HOME, A), (HOME, B), (A, B), (B, A), (A, HOME), (B, HOME)]:
        for day in (10, 11, 12):
            for mode, duration in [('flight', 1), ('rail', 2)]:
                moves.append(movement(f'{a.id}-{b.id}-{day}-{mode}', a, b, dt(day), dt(day, 9+duration), mode))
    offers = [fare(m.id, 30 if m.mode == 'flight' else 10) for m in moves]
    offers.append(fare('bundle', 5, [moves[0].id, moves[-6].id], kind='round-trip'))
    return spec, moves, offers, []


class CheckpointTests(unittest.TestCase):
    def test_pickled_rounds_match_fresh_prefixes_and_complete_search(self):
        args = inputs()
        checkpoint = SearchCheckpoint()
        result = optimize(*args, label_limit=10, checkpoint=checkpoint)
        self.assertFalse(result['optimization_complete'])
        for limit in (20, 40, 80, 160, 320, 640):
            previous = result['expanded_labels']
            checkpoint = pickle.loads(pickle.dumps(checkpoint, protocol=5))
            result = optimize(*args, label_limit=limit, checkpoint=checkpoint)
            self.assertEqual(checkpoint.resumed_from, previous)
            self.assertEqual(result, optimize(*args, label_limit=limit))
            if result['optimization_complete']:
                break
        result = optimize(*args, checkpoint=checkpoint, include_dominated=True)
        self.assertEqual(result, optimize(*args, include_dominated=True))

    def test_changed_inputs_restart_instead_of_reusing_old_states(self):
        for changed in ('fare', 'schedule', 'constraint', 'rules', 'open_end'):
            with self.subTest(changed=changed):
                args = list(inputs())
                checkpoint = SearchCheckpoint()
                optimize(*args, label_limit=10, checkpoint=checkpoint)
                kwargs = {}
                if changed == 'fare':
                    args[2][0] = args[2][0].model_copy(update={'low': 999, 'high': 999})
                elif changed == 'schedule':
                    args[1] = args[1][1:]
                elif changed == 'constraint':
                    args[0] = args[0].model_copy(update={'budget_myr': 20})
                elif changed == 'rules':
                    from app.planner_models import PricingRule
                    args[3] = [PricingRule(id='new', name='Estimate', mode='rail', low=7)]
                else:
                    kwargs['finish_at_home'] = False
                result = optimize(*args, checkpoint=checkpoint, **kwargs)
                self.assertEqual(checkpoint.resumed_from, 0)
                self.assertEqual(result, optimize(*args, **kwargs))

    def test_deadline_stops_mid_search_and_resume_reaches_same_result(self):
        now = [0.0]
        def monotonic():
            now[0] += .001
            return now[0]
        checkpoint = SearchCheckpoint()
        with patch('app.planner_optimizer.clock', SimpleNamespace(monotonic=monotonic)):
            result = optimize(*inputs(), checkpoint=checkpoint, deadline=.02)
        self.assertFalse(result['optimization_complete'])
        self.assertGreater(result['expanded_labels'], 0)
        previous = result['expanded_labels']
        result = optimize(*inputs(), checkpoint=checkpoint)
        self.assertEqual(checkpoint.resumed_from, previous)
        self.assertEqual(result, optimize(*inputs()))


class DurableCheckpointTests(unittest.IsolatedAsyncioTestCase):
    async def test_restart_resumes_and_completion_removes_checkpoint(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'planner.sqlite3'
            store = PlannerStore(path)
            spec, moves, offers, _ = inputs()
            record = store.new_trip(spec.model_dump(mode='json'))
            record['snapshot'] = {'revision': 1, 'label_limit': 10, 'roads': {}, 'coverage': {},
                                  'movements': [m.model_dump(mode='json') for m in moves],
                                  'offers': [o.model_dump(mode='json') for o in offers]}
            store.put('trips', record['id'], record)
            first = await DiscoveryManager(store).recalculate(record['id'])
            self.assertFalse(first['optimization_complete'])
            self.assertIsNotNone(store.load_optimizer_checkpoint(record['id'], CHECKPOINT_VERSION))
            restarted = DiscoveryManager(PlannerStore(path))
            from app import planner_discovery
            with patch.object(planner_discovery, 'optimize', wraps=optimize) as solver:
                result = await restarted.recalculate(record['id'], expand=True)
                self.assertEqual(solver.call_args.kwargs['checkpoint'].resumed_from, first['expanded_labels'])
            self.assertTrue(result['optimization_complete'])
            self.assertIsNone(store.load_optimizer_checkpoint(record['id'], CHECKPOINT_VERSION))
            self.assertEqual(result['routes'], optimize(spec, moves, offers, [])['routes'])
            store.save_optimizer_checkpoint(record['id'], CHECKPOINT_VERSION, b'local state')
            self.assertIsNone(store.load_optimizer_checkpoint(record['id'], CHECKPOINT_VERSION+1))
            store.delete('trips', record['id'])
            self.assertIsNone(store.load_optimizer_checkpoint(record['id'], CHECKPOINT_VERSION))
