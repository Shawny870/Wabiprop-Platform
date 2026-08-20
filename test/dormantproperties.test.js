// test/dormantproperties.test.js
// Dormant-property flagging: pure dormantProperties() helper in
// api/wabistay/webhook.js, plus the on-demand api/wabistay/dormant-report.js
// endpoint. Read-only — no Airtable writes, no WhatsApp sends.

const { test } = require('node:test');
const assert = require('node:assert');
const { installEnv, installFetch, MockAirtable } = require('./harness');

installEnv();
const wh = require('../api/wabistay/webhook.js');

const NOW = new Date('2026-08-20T00:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;
const daysAgo = n => new Date(NOW.getTime() - n * DAY_MS).toISOString();

function props(overrides) {
  return [
    { id: 'recFresh', fields: { 'Property Name': 'Fresh Lodge', 'Last Message Received': daysAgo(1), 'Last Owner App Open': daysAgo(1) } },
    { id: 'recStaleMsg', fields: { 'Property Name': 'Stale Message Lodge', 'Last Message Received': daysAgo(15), 'Last Owner App Open': daysAgo(1) } },
    { id: 'recStaleOpen', fields: { 'Property Name': 'Stale Open Lodge', 'Last Message Received': daysAgo(1), 'Last Owner App Open': daysAgo(15) } },
    { id: 'recBothStale', fields: { 'Property Name': 'Both Stale Lodge', 'Last Message Received': daysAgo(20), 'Last Owner App Open': daysAgo(20) } },
    { id: 'recNever', fields: { 'Property Name': 'Never Seen Lodge' } }, // neither field ever set
    ...(overrides || [])
  ];
}

// CEO decision (follow-up batch): Last Owner App Open is the actual
// disconnect-risk signal and must not be diluted by guest message activity —
// see the header comment above dormantProperties() in webhook.js.
test('mode "owner_open_only" (CEO-confirmed default): flagged ONLY when Last Owner App Open is stale, guest activity is irrelevant', () => {
  const result = wh.dormantProperties(props(), { now: NOW, thresholdDays: 10 });
  const ids = result.map(r => r.propertyId).sort();
  // recStaleMsg has a STALE message signal but a FRESH owner-open signal —
  // must NOT be flagged under the new default, unlike the old "either" default.
  assert.deepStrictEqual(ids, ['recBothStale', 'recNever', 'recStaleOpen'].sort());
  assert.ok(!ids.includes('recStaleMsg'), 'stale guest messaging alone is not disconnect risk');
});

test('mode "either": flagged if ANY signal exceeds the threshold (available, not default)', () => {
  const result = wh.dormantProperties(props(), { now: NOW, thresholdDays: 10, mode: 'either' });
  const ids = result.map(r => r.propertyId).sort();
  assert.deepStrictEqual(ids, ['recBothStale', 'recNever', 'recStaleMsg', 'recStaleOpen'].sort());
});

test('mode "both": flagged only if BOTH signals exceed the threshold (available, not default)', () => {
  const result = wh.dormantProperties(props(), { now: NOW, thresholdDays: 10, mode: 'both' });
  const ids = result.map(r => r.propertyId).sort();
  assert.deepStrictEqual(ids, ['recBothStale', 'recNever'].sort());
});

test('a property that never recorded Last Owner App Open is flagged under the default mode (never seen = maximally dormant)', () => {
  const result = wh.dormantProperties(props(), { now: NOW, thresholdDays: 10 });
  const never = result.find(r => r.propertyId === 'recNever');
  assert.ok(never, 'flagged');
  assert.strictEqual(never.lastMessageReceived, null);
  assert.strictEqual(never.lastOwnerAppOpen, null);
});

// ── The separate, distinct message-activity view (not conflated into dormantProperties) ──

test('inactiveByMessageActivity flags on Last Message Received alone, independent of Last Owner App Open', () => {
  const result = wh.inactiveByMessageActivity(props(), { now: NOW, thresholdDays: 10 });
  const ids = result.map(r => r.propertyId).sort();
  // recStaleMsg (stale message, fresh open) and recBothStale and recNever
  // should show up here — recStaleOpen (fresh message, stale open) must NOT,
  // proving the two views are genuinely independent, not just relabeled.
  assert.deepStrictEqual(ids, ['recBothStale', 'recNever', 'recStaleMsg'].sort());
  assert.ok(!ids.includes('recStaleOpen'), 'a property with fresh guest activity is not "inactive" just because owner-open is stale');
});

test('inactiveByMessageActivity result shape carries only the message-activity field, not owner-open data', () => {
  const result = wh.inactiveByMessageActivity(props(), { now: NOW, thresholdDays: 10 });
  const entry = result.find(r => r.propertyId === 'recStaleMsg');
  assert.deepStrictEqual(Object.keys(entry).sort(), ['lastMessageReceived', 'propertyId', 'propertyName'].sort());
});

test('threshold is configurable — a longer threshold un-flags a borderline property', () => {
  const result15 = wh.dormantProperties(props(), { now: NOW, thresholdDays: 20 });
  assert.ok(!result15.some(r => r.propertyId === 'recStaleMsg'), '15 days ago no longer exceeds a 20-day threshold');
});

test('defaults to DORMANT_THRESHOLD_DAYS_DEFAULT (10) when no thresholdDays is passed and env var is unset', () => {
  delete process.env.DORMANT_THRESHOLD_DAYS;
  assert.strictEqual(wh.DORMANT_THRESHOLD_DAYS_DEFAULT, 10);
  const result = wh.dormantProperties(props(), { now: NOW });
  assert.ok(result.some(r => r.propertyId === 'recStaleOpen'), 'stale Last Owner App Open is what the default mode actually keys on');
});

test('DORMANT_THRESHOLD_DAYS env var overrides the default when thresholdDays is not explicitly passed', () => {
  process.env.DORMANT_THRESHOLD_DAYS = '20';
  const result = wh.dormantProperties(props(), { now: NOW });
  assert.ok(!result.some(r => r.propertyId === 'recStaleOpen'), 'env-set 20-day threshold un-flags the 15-day-stale property');
  delete process.env.DORMANT_THRESHOLD_DAYS;
});

// ── On-demand endpoint ──────────────────────────────────────────────────────

function fakeReq(query, authHeader) {
  return { method: 'GET', query, headers: authHeader ? { authorization: authHeader } : {} };
}
function fakeRes() {
  const res = { _status: null, _json: null };
  res.status = code => { res._status = code; return res; };
  res.json = body => { res._json = body; return res; };
  return res;
}
function setup(seed) {
  const ctx = { airtable: new MockAirtable(seed), sends: [], axiom: [] };
  installFetch(ctx);
  return ctx;
}

test('dormant-report route: refuses with no MANUAL_REPORT_SECRET configured', async () => {
  delete process.env.MANUAL_REPORT_SECRET;
  setup({ WS_Properties: [] });
  delete require.cache[require.resolve('../api/wabistay/dormant-report.js')];
  const route = require('../api/wabistay/dormant-report.js');
  const res = fakeRes();
  await route(fakeReq({}, 'Bearer whatever'), res);
  assert.strictEqual(res._status, 401);
});

test('dormant-report route: with a valid secret, returns BOTH distinct views read-only, defaulting to owner_open_only', async () => {
  process.env.MANUAL_REPORT_SECRET = 'test-secret';
  const ctx = setup({ WS_Properties: props() });
  delete require.cache[require.resolve('../api/wabistay/dormant-report.js')];
  const route = require('../api/wabistay/dormant-report.js');
  const res = fakeRes();
  await route(fakeReq({ thresholdDays: '10' }, 'Bearer test-secret'), res);

  assert.strictEqual(res._status, 200);
  assert.strictEqual(res._json.ok, true);
  assert.strictEqual(res._json.mode, 'owner_open_only', 'defaults to the CEO-confirmed disconnect-risk mode');
  assert.strictEqual(res._json.totalProperties, 5);
  // Default mode excludes recStaleMsg (stale message, fresh open) — 3 flagged, not 4.
  assert.strictEqual(res._json.dormantCount, 3);
  assert.ok(!res._json.dormant.some(d => d.propertyId === 'recStaleMsg'));
  // The separate message-activity view is present and distinct — includes
  // recStaleMsg, excludes recStaleOpen, proving the two lists don't collapse
  // into each other.
  assert.ok(Array.isArray(res._json.messageInactive));
  assert.strictEqual(res._json.messageInactiveCount, 3);
  assert.ok(res._json.messageInactive.some(d => d.propertyId === 'recStaleMsg'));
  assert.ok(!res._json.messageInactive.some(d => d.propertyId === 'recStaleOpen'));
  assert.strictEqual(ctx.airtable.log.length, 0, 'read-only — no writes');
});

test('dormant-report route: mode=either still works as a non-default option', async () => {
  process.env.MANUAL_REPORT_SECRET = 'test-secret';
  setup({ WS_Properties: props() });
  delete require.cache[require.resolve('../api/wabistay/dormant-report.js')];
  const route = require('../api/wabistay/dormant-report.js');
  const res = fakeRes();
  await route(fakeReq({ thresholdDays: '10', mode: 'either' }, 'Bearer test-secret'), res);
  assert.strictEqual(res._status, 200);
  assert.strictEqual(res._json.dormantCount, 4, 'either mode still flags the stale-message property too');
});

test('dormant-report route: rejects an invalid mode', async () => {
  process.env.MANUAL_REPORT_SECRET = 'test-secret';
  setup({ WS_Properties: [] });
  delete require.cache[require.resolve('../api/wabistay/dormant-report.js')];
  const route = require('../api/wabistay/dormant-report.js');
  const res = fakeRes();
  await route(fakeReq({ mode: 'sometimes' }, 'Bearer test-secret'), res);
  assert.strictEqual(res._status, 400);
});
