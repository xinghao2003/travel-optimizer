from __future__ import annotations
import tempfile
import unittest
from pathlib import Path
from datetime import date, datetime, timezone
from app.planner_models import Place, Visit, TripSpec, Segment, FareOffer, AirportTransferEstimate
from app.planner_discovery import flight_movement, airport_transfer_variants, airport_transfer_rules, airport_transfer_rows
from app.planner_optimizer import price_path
from app.planner_store import PlannerStore

class AirportTransferTests(unittest.TestCase):
    def setUp(self):
        self.home = Place(id="kul", name="Kuala Lumpur", latitude=3, longitude=101, timezone="UTC", airport_codes=["KUL"], flight_code="KUL")
        self.city = Place(id="seoul", name="Seoul", latitude=37, longitude=127, timezone="UTC", airport_codes=["ICN", "GMP"], flight_code="SEL")
        self.spec = TripSpec(home=self.home, visits=[Visit(place=self.city)], start_date=date(2027, 2, 10), end_date=date(2027, 2, 12))
        self.segment = Segment(mode="flight", from_id="KUL", to_id="ICN", from_name="KUL", to_name="ICN", departure=datetime(2027, 2, 10, 10, tzinfo=timezone.utc), arrival=datetime(2027, 2, 10, 16, tzinfo=timezone.utc))
        self.roads = {"kul->airport:KUL": {"duration_minutes": 60, "distance_km": 50}, "airport:ICN->seoul": {"duration_minutes": 70, "distance_km": 60}}
        self.flight = flight_movement(self.home, self.city, [self.segment.model_dump(mode="json")], self.spec, self.roads)
        self.estimates = [dict(from_id="kul", to_id="airport:KUL", mode="rail", adults=1, duration_minutes=30, low=10, high=None, currency="MYR"), dict(from_id="airport:ICN", to_id="seoul", mode="taxi", adults=1, duration_minutes=40, low=20, high=None, currency="MYR")]

    def test_configured_rows_include_each_airport_and_both_directions(self):
        pairs = {(r['from_id'], r['to_id']) for r in airport_transfer_rows(self.spec)}
        self.assertTrue({('seoul','airport:GMP'), ('airport:GMP','seoul'), ('seoul','airport:ICN'), ('airport:KUL','kul')} <= pairs)

    def test_variants_keep_ticket_bundle_and_change_timing_and_fare(self):
        trip = {'airport_transfer_estimates': self.estimates}
        variants = airport_transfer_variants([self.flight.model_dump(mode='json')], trip, self.spec, self.roads, {})
        self.assertEqual(len(variants), 2)
        rail = next(m for m in variants if any(c.mode == 'rail' for c in m.charges))
        self.assertEqual((self.flight.departure - rail.departure).total_seconds()/60, -30)
        self.assertEqual((self.flight.arrival - rail.arrival).total_seconds()/60, 30)
        base = FareOffer(id='ticket', movement_ids=[self.flight.id], low=100, high=100)
        priced = price_path([rail], [base], self.spec, airport_transfer_rules(trip, self.spec))
        self.assertEqual(priced['cost_low_myr'], 130)
        self.assertEqual(priced['cost_high_myr'], 130)
        access = next(c for c in rail.charges if c.kind == 'Airport access')
        override = FareOffer(id='manual', movement_ids=[access.id], low=7, high=7, source='user')
        self.assertEqual(price_path([rail], [base, override], self.spec, airport_transfer_rules(trip, self.spec))['cost_low_myr'], 127)
        # A multi-leg provider ticket retains coverage through transfer variants.
        other = self.flight.model_copy(deep=True, update={'id': 'other', 'charges': []})
        bundle = FareOffer(id='return-ticket', movement_ids=[self.flight.id, 'other'], kind='round-trip', low=90, high=90)
        self.assertEqual(price_path([rail, other], [bundle], self.spec, airport_transfer_rules(trip, self.spec))['cost_high_myr'], 120)

    def test_restart_future_movements_party_and_direction(self):
        with tempfile.TemporaryDirectory() as folder:
            store = PlannerStore(Path(folder)/'test.sqlite')
            saved = store.new_trip(self.spec.model_dump(mode='json'))
            saved['airport_transfer_estimates'] = self.estimates
            store.put('trips', saved['id'], saved)
            restored = PlannerStore(Path(folder)/'test.sqlite').get('trips', saved['id'])
            rules = airport_transfer_rules(restored, self.spec)
            future = self.flight.model_copy(deep=True, update={'id': 'new-discovery'})
            future.charges[1].id = 'new-egress'
            offers = [FareOffer(id='ticket', movement_ids=[future.id], low=100, high=100)]
            priced = price_path([future], offers, self.spec, rules)
            self.assertTrue(any(p['low'] == 20 for p in priced['purchases']))
            self.assertFalse(airport_transfer_rules(restored, self.spec.model_copy(update={'adults': 2})))
            self.assertTrue(all(r.from_id != 'seoul' for r in rules))

    def test_alternative_needs_duration_and_allows_unknown_fare(self):
        with self.assertRaises(ValueError):
            AirportTransferEstimate(from_id='kul', to_id='airport:KUL', adults=1, mode='rail', low=10)
        estimate = AirportTransferEstimate(from_id='kul', to_id='airport:KUL', adults=1, mode='tram', duration_minutes=45)
        self.assertIsNone(estimate.low)

class AirportTransferApiTests(unittest.IsolatedAsyncioTestCase):
    async def test_upfront_save_validation_revision_and_restart(self):
        import httpx
        from unittest.mock import patch
        import app.planner_api as endpoints
        from app.main import app
        fixture = AirportTransferTests()
        fixture.setUp()
        with tempfile.TemporaryDirectory() as folder:
            db = PlannerStore(Path(folder)/'api.sqlite')
            with patch.object(endpoints, 'store', db):
                async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as client:
                    response = await client.post('/api/v2/trips', json=fixture.spec.model_dump(mode='json'))
                    self.assertEqual(response.status_code, 201)
                    record = response.json()
                    self.assertTrue(record['airport_transfer_rows'])
                    url = f"/api/v2/trips/{record['id']}/airport-transfer-estimates"
                    payload = {'expected_revision': 1, 'estimates': fixture.estimates}
                    response = await client.put(url, json=payload)
                    self.assertEqual(response.status_code, 200, response.text)
                    self.assertEqual(response.json()['revision'], 2)
                    self.assertEqual(PlannerStore(db.path).get('trips', record['id'])['airport_transfer_estimates'][0]['mode'], 'rail')
                    self.assertEqual((await client.put(url, json=payload)).status_code, 409)
                    duplicate = {**payload, 'expected_revision': 2, 'estimates': [fixture.estimates[0], fixture.estimates[0]]}
                    self.assertEqual((await client.put(url, json=duplicate)).status_code, 422)
                    invalid = {**payload, 'expected_revision': 2, 'estimates': [{**fixture.estimates[0], 'to_id': 'airport:BOG'}]}
                    self.assertEqual((await client.put(url, json=invalid)).status_code, 422)
                    self.assertEqual(db.get('trips', record['id'])['revision'], 2)
