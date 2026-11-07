from __future__ import annotations
import tempfile
import unittest
from pathlib import Path
from datetime import date, datetime, timezone
from app.planner_models import Place, Visit, TripSpec, Segment, FareOffer, AirportTransferEstimate, AirportConnection
from app.planner_discovery import flight_movement, airport_transfer_variants, airport_transfer_rules, airport_transfer_rows, required_airport_connections
from app.planner_optimizer import optimize, price_path
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
        # The rail way replaces the default taxi to KUL: one variant, with no unpriced default access.
        self.assertEqual(len(variants), 1)
        rail = variants[0]
        self.assertEqual(next(c for c in rail.charges if c.kind == 'Airport access').mode, 'rail')
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

    def test_blocked_airport_changes_use_the_current_connections(self):
        # A journey found during a search is built without the trip's connections; its count must not depend on that.
        legs = [Segment(mode="flight", from_id="KUL", to_id="GMP", from_name="KUL", to_name="GMP", departure=datetime(2027, 2, 10, 1, tzinfo=timezone.utc), arrival=datetime(2027, 2, 10, 7, tzinfo=timezone.utc)),
                Segment(mode="flight", from_id="ICN", to_id="PUS", from_name="ICN", to_name="PUS", departure=datetime(2027, 2, 10, 9, tzinfo=timezone.utc), arrival=datetime(2027, 2, 10, 10, tzinfo=timezone.utc))]
        busan = Place(id="pus", name="Busan", latitude=35, longitude=129, timezone="UTC", airport_codes=["PUS"], flight_code="PUS")
        raw = flight_movement(self.home, busan, [leg.model_dump(mode="json") for leg in legs], self.spec, self.roads).model_dump(mode="json")
        def blocked(minutes):
            connections = {} if minutes is None else {("GMP", "ICN"): AirportConnection(from_airport="GMP", to_airport="ICN", mode="rail", duration_minutes=minutes)}
            [pair] = required_airport_connections([raw], connections)
            return pair["journey_count"], pair["unresolved_journey_count"]
        self.assertEqual(blocked(None), (1, 1))
        self.assertEqual(blocked(45), (1, 0))  # The layover is 120 minutes.
        self.assertEqual(blocked(150), (1, 1))

    def test_ways_set_replace_the_default_taxi_unless_a_taxi_is_set(self):
        rail = dict(from_id="airport:ICN", to_id="seoul", mode="rail", adults=1, duration_minutes=59, low=14.5, high=None, currency="MYR")
        taxi = dict(from_id="airport:ICN", to_id="seoul", mode="taxi", adults=1, duration_minutes=None, low=None, high=None, currency="MYR")
        def egress_modes(estimates):
            variants = airport_transfer_variants([self.flight.model_dump(mode='json')], {'airport_transfer_estimates': estimates}, self.spec, self.roads, {})
            return sorted(next(c for c in m.charges if c.kind == 'Airport egress').mode for m in variants)
        self.assertEqual(egress_modes([]), ['taxi'])  # The default taxi
        self.assertEqual(egress_modes([rail]), ['rail'])
        # A taxi set beside the rail keeps the taxi, with the road time.
        self.assertEqual(egress_modes([rail, taxi]), ['rail', 'taxi'])

    def test_transfer_estimate_keeps_flight_departure_window(self):
        # The 09:00-17:00 window applies to the 10:00 flight, not the earlier taxi to the airport.
        back = Segment(mode="flight", from_id="ICN", to_id="KUL", from_name="ICN", to_name="KUL", departure=datetime(2027, 2, 12, 10, tzinfo=timezone.utc), arrival=datetime(2027, 2, 12, 16, tzinfo=timezone.utc))
        home = flight_movement(self.city, self.home, [back.model_dump(mode="json")], self.spec, self.roads)
        trip = {'airport_transfer_estimates': [dict(from_id="kul", to_id="airport:KUL", mode="taxi", adults=1, duration_minutes=None, low=10, high=None, currency="MYR")]}
        variants = airport_transfer_variants([m.model_dump(mode='json') for m in (self.flight, home)], trip, self.spec, self.roads, {})
        self.assertTrue(optimize(self.spec, variants, [], airport_transfer_rules(trip, self.spec))['routes'])

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
                    spec = fixture.spec.model_dump(mode='json')
                    spec['visits'][0]['min_stay_hours'] = 1
                    response = await client.post('/api/v2/trips', json=spec)
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
