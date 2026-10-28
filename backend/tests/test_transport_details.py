from __future__ import annotations

import tempfile
import unittest
from datetime import date, datetime, timezone
from pathlib import Path
from unittest.mock import patch

import httpx

from app.planner_models import FareOffer, Place, PositioningService, TransportOption, TripSpec, Visit
from app.planner_transport import city_options, party_fare, transport_movements, transport_options, transport_rows
from app.planner_discovery import DiscoveryManager, flight_movement
from app.planner_optimizer import optimize, price_path
from app.planner_store import PlannerStore

UTC = timezone.utc


def at(day, hour, minute=0):
    return datetime(2027, 2, day, hour, minute, tzinfo=UTC)


class TransportTests(unittest.TestCase):
    def setUp(self):
        self.home = Place(id="home", name="Home", latitude=3, longitude=101, timezone="UTC", airport_codes=["KUL"], flight_code="KUL")
        self.city = Place(id="city", name="City", latitude=37, longitude=127, timezone="UTC", airport_codes=["ICN"], flight_code="ICN")
        self.spec = TripSpec(home=self.home, visits=[Visit(place=self.city)], start_date=date(2027, 2, 10), end_date=date(2027, 2, 12),
            modes=["flight", "taxi", "bus", "ferry"], departure_start="00:00", departure_end="23:59")
        self.flight = flight_movement(self.home, self.city, [dict(mode="flight", from_id="KUL", to_id="ICN", from_name="KUL", to_name="ICN",
            departure=at(10, 10).isoformat(), arrival=at(10, 16).isoformat())], self.spec, {})

    def option(self, **changes):
        return TransportOption.model_validate(dict(id="manual", from_id="home", to_id="city", mode="ferry", adults=1,
            availability="available", duration_minutes=60, before_minutes=20, after_minutes=10, low=10, **changes))

    def test_unknown_and_unavailable_do_not_invent_services(self):
        for status in ("unknown", "unavailable"):
            option = self.option().model_copy(update={"availability": status})
            self.assertEqual(city_options({"transport_options": [option.model_dump(mode="json")]}, self.spec), ([], []))
        with self.assertRaises(ValueError):
            TransportOption(id="x", from_id="home", to_id="city", mode="ferry", adults=1, availability="available")

    def test_scheduled_ferry_buffers_and_party_pricing(self):
        option = self.option().model_copy(update={"departure": at(10, 9), "unit": "person"})
        spec = self.spec.model_copy(update={"adults": 3})
        option.adults = 3
        movements, fares = city_options({"transport_options": [option.model_dump(mode="json")]}, spec)
        self.assertEqual((movements[0].departure, movements[0].arrival), (at(10, 8, 40), at(10, 10, 10)))
        self.assertEqual([s.duration_minutes for s in movements[0].segments], [20, 60, 10])
        self.assertEqual(price_path(movements, fares, spec, [])['total_cost_myr'], 30)
        option.unit, option.capacity = "vehicle", 2
        self.assertEqual(party_fare(option, spec), (20, 20))

    def test_unknown_and_unbounded_fares_remain_unknown(self):
        option = self.option().model_copy(update={"low": None, "high": None})
        movements, fares = city_options({"transport_options": [option.model_dump(mode="json")]}, self.spec)
        self.assertIsNone(price_path(movements, fares, self.spec, [])['total_cost_myr'])
        option.low, option.fare_kind = 10, "range"
        self.assertEqual(party_fare(option, self.spec), (10, None))

    def test_airport_access_buffers_and_ticket_coverage(self):
        option = self.option().model_copy(update={"to_id": "airport:KUL", "mode": "taxi", "duration_minutes": 30})
        trip = {"transport_options": [option.model_dump(mode="json")]}
        variants = transport_movements([self.flight.model_dump(mode="json")], trip, self.spec, {}, {})
        self.assertEqual(len(variants), 1)
        variant = variants[0]
        self.assertEqual(variant.departure, at(10, 7, 30))
        self.assertEqual(variant.template_id, self.flight.id)
        self.assertEqual([s.duration_minutes for s in variant.segments[:3]], [20, 30, 10])
        ticket = FareOffer(id="ticket", movement_ids=[self.flight.id], low=100, high=100)
        priced = price_path([variant], [ticket], self.spec, [])
        self.assertEqual(priced['cost_low_myr'], 110)
        self.assertIsNone(priced['cost_high_myr'])  # Unpriced egress remains unknown.

    def test_scheduled_airport_service_cannot_miss_a_flight(self):
        option = self.option().model_copy(update={"to_id": "airport:KUL", "mode": "taxi", "departure": at(10, 8), "duration_minutes": 60})
        trip = {"transport_options": [option.model_dump(mode="json")]}
        # Arrival and after-arrival time exceed the 08:30 readiness deadline.
        self.assertEqual(transport_movements([self.flight.model_dump(mode="json")], trip, self.spec, {}, {}), [])
        option.departure = at(10, 7)
        trip["transport_options"] = [option.model_dump(mode="json")]
        variant = transport_movements([self.flight.model_dump(mode="json")], trip, self.spec, {}, {})[0]
        self.assertEqual(variant.departure, at(10, 6, 40))
        self.assertTrue(any(s.source == "Wait before flight readiness" and s.duration_minutes == 20 for s in variant.segments))

    def test_airport_change_includes_wait_and_buffers(self):
        segments = [dict(mode="flight", from_id="KUL", to_id="HND", from_name="KUL", to_name="HND", departure=at(10, 10).isoformat(), arrival=at(10, 16).isoformat()),
            dict(mode="flight", from_id="NRT", to_id="ICN", from_name="NRT", to_name="ICN", departure=at(10, 19).isoformat(), arrival=at(10, 21).isoformat())]
        flight = flight_movement(self.home, self.city, segments, self.spec, {})
        option = self.option().model_copy(update={"from_id": "airport:HND", "to_id": "airport:NRT", "mode": "bus", "departure": at(10, 17)})
        variants = transport_movements([flight.model_dump(mode="json")], {"transport_options": [option.model_dump(mode="json")]}, self.spec, {}, {})
        self.assertEqual(len(variants), 1)
        self.assertTrue(variants[0].usable)
        self.assertEqual(sum((s.arrival-s.departure).total_seconds()/60 for s in variants[0].segments), variants[0].duration_minutes)
        self.assertTrue(any(s.source == "Wait for supplied service" and s.duration_minutes == 40 for s in variants[0].segments))

    def test_legacy_inputs_are_preserved_without_mutation(self):
        trip = {"airport_connections": [dict(from_airport="CTU", to_airport="TFU", mode="rail", duration_minutes=30, fare_amount=30)],
            "airport_transfer_estimates": [dict(from_id="home", to_id="airport:KUL", adults=1, mode="taxi", duration_minutes=35, low=20, high=30, currency="MYR")]}
        options = transport_options(trip, self.spec)
        self.assertEqual(len(options), 2)
        self.assertEqual(next(o for o in options if o.mode == "taxi").fare_kind, "range")
        self.assertNotIn('transport_options', trip)
        self.assertTrue(any(r['kind'] == 'saved' and r['from_id'] == 'airport:CTU' for r in transport_rows(trip, self.spec)))
        trip['transport_options'] = [o.model_dump(mode='json') for o in options]
        variants = transport_movements([self.flight.model_dump(mode='json')], trip, self.spec, {}, {})
        self.assertEqual(next(c for c in variants[0].charges if c.kind == 'Airport access').id, self.flight.id+':access')

    def test_flexible_service_timeline_and_buffers_affect_feasibility(self):
        outbound = self.option().model_copy(update={"mode": "ferry", "before_minutes": 0, "after_minutes": 0})
        inbound = outbound.model_copy(update={"id": "return", "from_id": "city", "to_id": "home"})
        trip = {'transport_options': [o.model_dump(mode='json') for o in [outbound, inbound]]}
        movements, fares = city_options(trip, self.spec)
        result = optimize(self.spec, movements, fares, [], label_limit=1000)
        self.assertTrue(result['routes'])
        first = result['routes'][0]['movements'][0]
        self.assertEqual(first['segments'][0]['departure'], first['departure'])
        self.assertEqual(result['routes'][0]['total_cost_myr'], 20)

    def test_entered_night_services_ignore_automatic_search_window(self):
        spec = self.spec.model_copy(update={'departure_start': datetime.min.time().replace(hour=9), 'departure_end': datetime.min.time().replace(hour=17)})
        outbound = self.option().model_copy(update={'departure': at(10, 22), 'before_minutes': 15, 'after_minutes': 0})
        inbound = outbound.model_copy(update={'id': 'return', 'from_id': 'city', 'to_id': 'home', 'departure': at(12, 3)})
        movements, fares = city_options({'transport_options': [o.model_dump(mode='json') for o in [outbound, inbound]]}, spec)
        result = optimize(spec, movements, fares, [], label_limit=1000)
        self.assertTrue(result['routes'])
        self.assertEqual(result['routes'][0]['total_cost_myr'], 20)


class TransportApiTests(unittest.IsolatedAsyncioTestCase):
    async def test_save_revision_validation_and_restart(self):
        import app.planner_api as endpoints
        from app.main import app
        fixture = TransportTests(); fixture.setUp()
        with tempfile.TemporaryDirectory() as folder:
            db = PlannerStore(Path(folder)/'api.sqlite')
            manager = DiscoveryManager(db)
            with patch.object(endpoints, 'store', db), patch.object(endpoints, 'manager', manager):
                async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as client:
                    created = await client.post('/api/v2/trips', json=fixture.spec.model_dump(mode='json'))
                    trip = created.json()
                    self.assertTrue(trip['transport_connection_rows'])
                    url = f"/api/v2/trips/{trip['id']}/transport-options"
                    option = fixture.option().model_dump(mode='json')
                    payload = {'expected_revision': 1, 'options': [option]}
                    response = await client.put(url, json=payload)
                    self.assertEqual(response.status_code, 200, response.text)
                    self.assertEqual(response.json()['revision'], 2)
                    self.assertEqual(PlannerStore(db.path).get('trips', trip['id'])['transport_options'][0]['mode'], 'ferry')
                    self.assertEqual((await client.put(url, json=payload)).status_code, 409)
                    duplicate = {**payload, 'expected_revision': 2, 'options': [option, option]}
                    self.assertEqual((await client.put(url, json=duplicate)).status_code, 422)
                    wrong = {**payload, 'expected_revision': 2, 'options': [{**option, 'to_id': 'elsewhere'}]}
                    self.assertEqual((await client.put(url, json=wrong)).status_code, 422)
                    self.assertEqual(db.get('trips', trip['id'])['revision'], 2)

    async def test_legacy_positioning_can_be_disabled_in_unified_table(self):
        fixture = TransportTests(); fixture.setUp()
        gateway = fixture.city.model_copy(update={'id': 'gateway'})
        spec = fixture.spec.model_copy(update={'departures': [gateway], 'arrivals': [gateway], 'positioning_services': [
            PositioningService(id='bus', direction='outbound', gateway_id='gateway', mode='bus', departure=at(10, 9), arrival=at(10, 10))]})
        with tempfile.TemporaryDirectory() as folder:
            db = PlannerStore(Path(folder)/'test.sqlite')
            trip = db.new_trip(spec.model_dump(mode='json'))
            imported = transport_options(trip, spec)
            self.assertEqual(imported[0].positioning_direction, 'outbound')
            imported[0].availability = 'unavailable'
            trip['transport_options'] = [o.model_dump(mode='json') for o in imported]
            db.put('trips', trip['id'], trip)
            result = await DiscoveryManager(db).recalculate(trip['id'])
            self.assertFalse(result['routes'])


if __name__ == '__main__':
    unittest.main()
