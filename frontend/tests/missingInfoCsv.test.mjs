import assert from "node:assert/strict";
import { test } from "node:test";
import { loadTs } from "./loadTs.mjs";
const { csvColumns, exportMissingInfoCsv, missingInfoCsvTargets, parseDelimited, previewMissingInfoCsv, stageMissingInfoCsv } = await loadTs("../src/lib/missingInfoCsv.ts");
const { transferKey, buildAirportConnections, buildTransferEstimates } = await loadTs("../src/lib/drafts.ts");

function context() {
  const scope = { from_id: "A", to_id: "B", mode: "rail", vehicle_kind: null, adults: 2, group_by: [], values: {} };
  return {
    trip: { id: "trip", revision: 3, spec: { name: 'Taiwan', adults: 2, exchange_rates: { MYR: 1, TWD: .14 } }, offers: [],
      airport_transfer_rows: [{ from_id: "A", to_id: "airport:AAA", label: "City to airport" }],
      airport_transfer_estimates: [], airport_connections: [] },
    groups: [{ key: "group", from_id: "A", to_id: "B", label: "rail", mode: "rail", currency: "MYR", reason: "missing_fare", affected_itineraries: 2, scope,
      components: [{ component_id: "m1:variant", departure: "2027-01-01T08:00:00Z", service: 'Fast, "Train"\nExpress', search_url: null }, { component_id: "m2", departure: null, service: null, search_url: null }] }],
    appliedGroups: [], airportChanges: [{ from_airport: "AAA", to_airport: "BBB", from_name: "First", to_name: "Second" }],
    drafts: { fares: {}, transfers: {}, airportChanges: {} }, canonical: id => id === "m1:variant" ? "m1" : id,
    offerFor: () => undefined, placeName: id => ({ A: "Kaohsiung, City", B: "Taipei", "airport:AAA": "AAA airport" }[id] ?? id),
  };
}
const edited = (ctx, predicate, changes) => {
  const target = missingInfoCsvTargets(ctx).find(predicate);
  assert.ok(target, "CSV target exists");
  return { ...target, values: { ...target.values, ...changes } };
};
const csv = rows => exportMissingInfoCsv(rows);

test("CSV and spreadsheet TSV handle quotes, multiline text, BOM and line endings", () => {
  assert.deepEqual(parseDelimited('\uFEFFa,b\r\n"one, two","a ""quote""\nnext"\r\n'), [["a", "b"], ["one, two", 'a "quote"\nnext']]);
  assert.deepEqual(parseDelimited('a\tb\nc\t"d\te"\n'), [["a", "b"], ["c", "d\te"]]);
  for (const text of ['a,b\n"open,quote', 'a,b\n"closed"junk,x', 'a,b\nhello"there,x']) assert.throws(() => parseDelimited(text));
  assert.throws(() => parseDelimited('x'.repeat(8_000_001)), /8 MB/);
});

test("unmodified export round-trips without staging any changes", () => {
  const ctx = context();
  const targets = missingInfoCsvTargets(ctx);
  const preview = previewMissingInfoCsv(csv(targets), ctx);
  assert.deepEqual(preview.errors, []);
  assert.equal(preview.changes.length, 0);
  assert.equal(preview.unchanged, targets.length);
  assert.equal(targets.filter(t => t.binding.kind === 'transfer').length, 7);
  assert.deepEqual(targets.find(t => t.binding.key === 'component:m1').binding.component_ids, ['m1']);
});

test("one batch stages all four types; blank cells preserve values and unrelated drafts", () => {
  const ctx = context();
  const rows = [
    edited(ctx, t => t.binding.key === 'group', { price: '200', currency: 'TWD' }),
    edited(ctx, t => t.binding.kind === 'transfer' && t.binding.mode === 'rail', { price: '20', minutes: '35' }),
    edited(ctx, t => t.binding.kind === 'change', { mode: 'bus', price: '0', minutes: '60' }),
    edited(ctx, t => t.values.row_id === 'rate:TWD', { myr_per_unit: '.15' }),
  ];
  const preview = previewMissingInfoCsv(csv(rows), ctx);
  assert.deepEqual(preview.errors, []);
  assert.deepEqual(preview.warnings, []);
  assert.equal(preview.changes.length, 4);
  const existing = { ...ctx.drafts, fares: { unrelated: { component_ids: ['other'], low: 9 } } };
  const next = stageMissingInfoCsv(preview.changes, existing, ctx.trip);
  assert.equal(next.fares.group.low, 200);
  assert.equal(next.fares.group.high, 200);
  assert.deepEqual(next.fares.group.scope, ctx.groups[0].scope);
  assert.equal(next.fares.unrelated.low, 9);
  assert.deepEqual(next.exchangeRates, { TWD: .15 });
  const transfers = buildTransferEstimates(ctx.trip.airport_transfer_rows, [], next.transfers, 2);
  assert.equal(transfers.length, 1); assert.equal(transfers[0].mode, 'rail');
  assert.equal(buildAirportConnections([], next.airportChanges)[0].fare_amount, 0);
  assert.deepEqual(ctx.drafts, { fares: {}, transfers: {}, airportChanges: {} });
});

test("a spreadsheet clipboard subset can stage zero price and an exact journey override", () => {
  const ctx = context();
  const row = edited(ctx, t => t.binding.key === 'component:m1', { price: '0' });
  const columns = ['trip_id', 'revision', 'adults', 'row_id', 'type', 'price'];
  const source = [columns.join('\t'), columns.map(c => row.values[c]).join('\t')].join('\n');
  const preview = previewMissingInfoCsv(source, ctx);
  assert.deepEqual(preview.errors, []);
  const next = stageMissingInfoCsv(preview.changes, ctx.drafts, ctx.trip);
  assert.equal(next.fares['component:m1'].low, 0);
  assert.deepEqual(next.fares['component:m1'].component_ids, ['m1']);
});

test("new exchange-rate row can be copied for multiple currencies", () => {
  const ctx = context();
  const base = t => t.values.row_id === 'rate:new';
  const preview = previewMissingInfoCsv(csv([edited(ctx, base, { currency: 'USD', myr_per_unit: '4.5' }), edited(ctx, base, { currency: 'JPY', myr_per_unit: '.03' })]), ctx);
  assert.deepEqual(preview.errors, []);
  assert.deepEqual(stageMissingInfoCsv(preview.changes, ctx.drafts, ctx.trip).exchangeRates, { USD: 4.5, JPY: .03 });
  const bad = previewMissingInfoCsv(csv([edited(ctx, base, { currency: 'MYR', myr_per_unit: '4' })]), ctx);
  assert.match(bad.errors[0], /other than MYR/);
});

test("duplicates, unknown IDs, stale trips, party changes and scope changes are errors", () => {
  const ctx = context();
  const row = edited(ctx, t => t.binding.key === 'group', { price: '20' });
  assert.equal(previewMissingInfoCsv(csv([row, row]), ctx).changes.length, 1);
  assert.match(previewMissingInfoCsv(csv([row, { ...row, values: { ...row.values, price: '21' } }]), ctx).errors[0], /Conflicting duplicate/);
  for (const [field, value, pattern] of [['trip_id', 'other', /another trip/], ['revision', '2', /changed since/], ['adults', '3', /party size/], ['row_id', 'unknown', /Unknown row/], ['scope', 'all journeys worldwide', /Do not change scope/], ['mode', 'bus', /Do not change mode/]]) {
    const invalid = { ...row, values: { ...row.values, [field]: value } };
    assert.match(previewMissingInfoCsv(csv([invalid]), ctx).errors[0], pattern);
  }
  assert.ok(previewMissingInfoCsv('trip_id,type\ntrip,journey_price', ctx).errors.length);
});

test("invalid values report row errors and foreign prices without rates get a warning", () => {
  const ctx = context();
  for (const patch of [{ price: '-1' }, { price: 'abc' }, { price: '12', max_price: '2' }, { price: '12', currency: 'XX' }]) {
    assert.ok(previewMissingInfoCsv(csv([edited(ctx, t => t.binding.key === 'group', patch)]), ctx).errors.length);
  }
  const rail = previewMissingInfoCsv(csv([edited(ctx, t => t.binding.kind === 'transfer' && t.binding.mode === 'rail', { price: '20' })]), ctx);
  assert.match(rail.errors[0], /time above 0/);
  const partialChange = previewMissingInfoCsv(csv([edited(ctx, t => t.binding.kind === 'change', { price: '20' })]), ctx);
  assert.ok(partialChange.errors.length);
  const missingRate = previewMissingInfoCsv(csv([edited(ctx, t => t.binding.key === 'group', { price: '20', currency: 'USD' })]), ctx);
  assert.deepEqual(missingRate.errors, []); assert.match(missingRate.warnings[0], /USD/);
});

test("ranges, open journey prices and blank preservation follow existing price semantics", () => {
  const ctx = context();
  ctx.drafts.fares.group = { component_ids: ['m1'], scope: ctx.groups[0].scope, low: 20, high: 40, currency: 'MYR', label: 'Existing' };
  let row = edited(ctx, t => t.binding.key === 'group', { price: '30', max_price: '', currency: '' });
  let next = stageMissingInfoCsv(previewMissingInfoCsv(csv([row]), ctx).changes, ctx.drafts, ctx.trip);
  assert.equal(next.fares.group.high, 40); assert.equal(next.fares.group.currency, 'MYR');
  row = edited(ctx, t => t.binding.key === 'group', { price: '30', max_price: 'open' });
  next = stageMissingInfoCsv(previewMissingInfoCsv(csv([row]), ctx).changes, ctx.drafts, ctx.trip);
  assert.equal(next.fares.group.high, null);
  row = edited(ctx, t => t.binding.key === 'group', { price: '30', max_price: '30' });
  next = stageMissingInfoCsv(previewMissingInfoCsv(csv([row]), ctx).changes, ctx.drafts, ctx.trip);
  assert.equal(next.fares.group.high, 30);
});

test("group import followed by individual override is independent of CSV row order", () => {
  const ctx = context();
  const group = edited(ctx, t => t.binding.key === 'group', { price: '20' });
  const single = edited(ctx, t => t.binding.key === 'component:m1', { price: '7' });
  const first = stageMissingInfoCsv(previewMissingInfoCsv(csv([single, group]), ctx).changes, ctx.drafts, ctx.trip);
  const second = stageMissingInfoCsv(previewMissingInfoCsv(csv([group, single]), ctx).changes, ctx.drafts, ctx.trip);
  assert.deepEqual(first, second);
  assert.equal(first.fares['component:m1'].low, 7);
  assert.equal(first.fares.group.low, 20);
});

test("saved transfer methods survive import and matching saved values remove drafts", () => {
  const ctx = context();
  ctx.trip.airport_transfer_estimates = [{ from_id: 'A', to_id: 'airport:AAA', adults: 2, mode: 'taxi', low: 10, high: 10, currency: 'MYR', duration_minutes: 20 }];
  const key = transferKey('A', 'airport:AAA', 2);
  const row = edited(ctx, t => t.binding.kind === 'transfer' && t.binding.mode === 'rail', { price: '5', minutes: '30' });
  const next = stageMissingInfoCsv(previewMissingInfoCsv(csv([row]), ctx).changes, ctx.drafts, ctx.trip);
  assert.deepEqual(next.transfers[key].map(w => w.mode), ['taxi', 'rail']);
  ctx.drafts.exchangeRates = { TWD: .2 };
  const revert = edited(ctx, t => t.values.row_id === 'rate:TWD', { myr_per_unit: '.14' });
  assert.deepEqual(stageMissingInfoCsv(previewMissingInfoCsv(csv([revert]), ctx).changes, ctx.drafts, ctx.trip).exchangeRates, {});
});

test("export guards spreadsheet formulas and retains Unicode context", () => {
  const ctx = context(); ctx.placeName = () => '=Danger,"高雄"';
  const targets = missingInfoCsvTargets(ctx);
  const exported = csv(targets);
  assert.ok(exported.includes("'=Danger")); assert.ok(exported.includes('高雄'));
  assert.deepEqual(previewMissingInfoCsv(exported, ctx).errors, []);
  assert.equal(parseDelimited(exported)[0].length, csvColumns.length);
});

test("explicit delete stages each saved user-entry kind; omitted rows stay unchanged", () => {
  const ctx = context();
  ctx.trip.offers = [{ id: 'manual', source: 'user', adults: 2, movement_ids: ['m1'], low: 10, high: 10, currency: 'MYR', label: 'My price' }];
  ctx.trip.airport_transfer_estimates = [{ from_id: 'A', to_id: 'airport:AAA', adults: 2, mode: 'rail', low: 10, high: 10, currency: 'MYR', duration_minutes: 30 }];
  ctx.trip.airport_connections = [{ from_airport: 'AAA', to_airport: 'BBB', mode: 'bus', duration_minutes: 45, fare_amount: 10, currency: 'MYR' }];
  ctx.appliedGroups = [{ key: 'reusable:rule', ruleId: 'rule', component_ids: ['m1'], low: 20, high: 20, currency: 'MYR', label: 'Reusable', scope: ctx.groups[0].scope }];
  const rows = [
    edited(ctx, t => t.binding.key === 'component:m1', { action: 'delete' }),
    edited(ctx, t => t.binding.key === 'reusable:rule', { action: 'delete' }),
    edited(ctx, t => t.binding.kind === 'transfer' && t.binding.mode === 'rail', { action: 'delete' }),
    edited(ctx, t => t.binding.kind === 'change', { action: 'delete' }),
    edited(ctx, t => t.values.row_id === 'rate:TWD', { action: 'delete' }),
  ];
  const preview = previewMissingInfoCsv(csv(rows), ctx);
  assert.deepEqual(preview.errors, []);
  assert.equal(preview.changes.filter(c => c.operation === 'delete').length, 5);
  const next = stageMissingInfoCsv(preview.changes, ctx.drafts, ctx.trip);
  assert.deepEqual(Object.values(next.deletions).map(d => d.kind).sort(), ['offer', 'journey_rule', 'airport_transfer', 'airport_change', 'exchange_rate'].sort());
  assert.equal(ctx.trip.offers.length, 1); // Preview/staging never mutate saved data.
  const partial = previewMissingInfoCsv(csv([edited(ctx, t => t.binding.kind === 'transfer' && t.binding.mode === 'taxi', { price: '12' })]), ctx);
  assert.deepEqual(stageMissingInfoCsv(partial.changes, ctx.drafts, ctx.trip).deletions, {});
});

test("delete refuses provider prices and blank placeholders; delete/update duplicates conflict", () => {
  const ctx = context();
  ctx.trip.offers = [{ id: 'provider', source: 'provider', movement_ids: ['m1'], low: 10, high: 10, currency: 'MYR', label: 'Provider' }];
  const provider = edited(ctx, t => t.binding.key === 'component:m1', { action: 'delete' });
  assert.match(previewMissingInfoCsv(csv([provider]), ctx).errors[0], /no user-entered value/);
  assert.match(previewMissingInfoCsv(csv([edited(ctx, t => t.binding.kind === 'transfer' && t.binding.mode === 'rail', { action: 'delete' })]), ctx).errors[0], /no user-entered value/);
  const rateDelete = edited(ctx, t => t.values.row_id === 'rate:TWD', { action: 'delete' });
  const rateUpdate = edited(ctx, t => t.values.row_id === 'rate:TWD', { myr_per_unit: '.2' });
  assert.match(previewMissingInfoCsv(csv([rateDelete, rateUpdate]), ctx).errors[0], /Conflicting duplicate/);
  assert.match(previewMissingInfoCsv(csv([edited(ctx, t => t.values.row_id === 'rate:TWD', { action: 'delete', currency: 'USD' })]), ctx).errors[0], /Keep the existing currency/);
  assert.match(previewMissingInfoCsv(csv([edited(ctx, t => t.values.row_id === 'rate:TWD', { action: 'erase' })]), ctx).errors[0], /blank action/);
});

test("delete can discard an unsaved CSV price; older CSV without action still imports", () => {
  const ctx = context();
  ctx.drafts.fares['component:m1'] = { component_ids: ['m1'], low: 5, high: 5, currency: 'MYR', label: 'Draft' };
  const preview = previewMissingInfoCsv(csv([edited(ctx, t => t.binding.key === 'component:m1', { action: 'delete' })]), ctx);
  assert.deepEqual(preview.errors, []);
  const next = stageMissingInfoCsv(preview.changes, ctx.drafts, ctx.trip);
  assert.deepEqual(next.fares, {}); assert.deepEqual(next.deletions, {});
  const target = edited(ctx, t => t.binding.key === 'group', { price: '20' });
  const columns = ['trip_id', 'revision', 'adults', 'row_id', 'type', 'price'];
  const oldCsv = [columns.join(','), columns.map(c => `"${target.values[c]}"`).join(',')].join('\n');
  assert.deepEqual(previewMissingInfoCsv(oldCsv, ctx).errors, []);
});
