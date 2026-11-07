import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadTs } from './loadTs.mjs';
const { journeyPriceScope, sameJourneyScope, defaultJourneyGrouping } = await loadTs('../src/lib/journeyPricing.ts');
const { groupMissingFares } = await loadTs('../src/lib/missingFares.ts');
const { activeFares, removeComponent, stageFare } = await loadTs('../src/lib/drafts.ts');

const movement = (id, date = '2027-02-10', extra = {}) => ({ id, from_id: 'home', to_id: 'a', mode: 'rail', vehicle_kind: null,
  departure: `${date}T09:00:00Z`, arrival: `${date}T10:00:00Z`, duration_minutes: 60, transfers: 0, charges: [],
  segments: [{ mode: 'highspeed_rail', from_id: 'feed:central', to_id: 'feed:north', from_name: 'Central', to_name: 'North',
    departure: `${date}T09:00:00Z`, arrival: `${date}T10:00:00Z`, from_timezone: 'UTC', operator: 'Example Transit', service: 'ICE 100', ...extra }] });
const fare = id => ({ component_id: id, movement_id: id, from_id: 'home', to_id: 'a', label: 'rail', currency: 'MYR', reason: 'missing_fare' });
const route = (id, movements) => ({ id, movements, extra_charges: [] });

test('scope representation matches Python and ignores dates unless selected', () => {
  const fields = ['stations', 'category', 'connections', 'service', 'operator', 'date', 'time'];
  const scope = journeyPriceScope(movement('first'), 1, fields);
  assert.deepEqual(scope.values, { stations: '["feed:central","feed:north"]', category: '["highspeed_rail"]', connections: '[]',
    service: '["ICE 100"]', operator: '["Example Transit"]', date: '"2027-02-10"', time: '"09:00"' });
  assert.ok(sameJourneyScope(journeyPriceScope(movement('first'), 1, ['service', ...defaultJourneyGrouping]), journeyPriceScope(movement('later', '2027-02-11'), 1, [...defaultJourneyGrouping, 'service'])));
  assert.ok(!sameJourneyScope(scope, journeyPriceScope(movement('later', '2027-02-11'), 1, fields)));
});

test('missing service identifiers remain separate and high-speed train numbers are visible', () => {
  const moves = [movement('first'), movement('later', '2027-02-11'), movement('unknown1', undefined, { service: null }), movement('unknown2', undefined, { service: null })];
  const groups = groupMissingFares(moves.map(m => fare(m.id)), [route('r', moves)], [...defaultJourneyGrouping, 'service']);
  assert.equal(groups.length, 3);
  const known = groups.find(g => g.components.length === 2);
  assert.equal(known.components[0].service, 'ICE 100');
  assert.equal(known.components[0].journey.duration_minutes, 60);
});

test('bus routes and station pairs use the same generic matching', () => {
  const bus = movement('bus', undefined, { mode: 'bus', service: '18' }); bus.mode = 'bus';
  assert.equal(journeyPriceScope(bus, 1, ['category', 'service']).values.service, '["18"]');
  const other = movement('other', undefined, { to_id: 'feed:other' });
  assert.ok(!sameJourneyScope(journeyPriceScope(bus, 1, defaultJourneyGrouping), journeyPriceScope(other, 1, defaultJourneyGrouping)));
});

test('saved scopes suppress stale missing rows even after display regrouping, but require a currency rate', () => {
  const move = movement('later', '2027-02-11');
  const scope = journeyPriceScope(movement('first'), 1, defaultJourneyGrouping);
  const rules = [{ journey_scope: scope, currency: 'MYR' }];
  assert.equal(groupMissingFares([fare(move.id)], [route('r', [move])], ['service'], 1, rules).length, 0);
  assert.equal(groupMissingFares([fare(move.id)], [route('r', [move])], ['service'], 2, rules).length, 1);
  assert.equal(groupMissingFares([fare(move.id)], [route('r', [move])], ['service'], 1, [{ ...rules[0], currency: 'EUR' }]).length, 1);
});

test('a saved-scope edit remains sendable with no visible component IDs and keeps other-party drafts', () => {
  const scope = journeyPriceScope(movement('first'), 1, defaultJourneyGrouping);
  const estimate = { component_ids: [], low: 95, high: 95, currency: 'MYR', label: 'Estimate', scope };
  const staged = stageFare({}, 'estimate', estimate);
  assert.deepEqual(activeFares(staged, new Set(), 1), [estimate]);
  assert.deepEqual(activeFares(staged, new Set(), 2), []);
  assert.ok(removeComponent(staged, 'first').estimate);
});

test('regrouping and individual overrides preserve the reusable estimate scope and seed journeys', () => {
  const scope = journeyPriceScope(movement('first'), 1, defaultJourneyGrouping);
  const estimate = { component_ids: ['first'], low: 95, high: 95, currency: 'MYR', label: 'Estimate', scope };
  const individual = { component_ids: ['first'], low: 70, high: 70, currency: 'MYR', label: 'One journey' };
  const staged = stageFare(stageFare({}, 'estimate', estimate), 'individual', individual);
  assert.deepEqual(staged.estimate, estimate);
  assert.deepEqual(staged.individual, individual);
  assert.deepEqual(stageFare(staged, 'estimate', estimate).individual, individual);
});
