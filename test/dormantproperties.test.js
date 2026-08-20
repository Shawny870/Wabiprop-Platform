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

test('mode "either" (default): flagged if ANY signal exceeds the threshold', () => {
  const result = wh.dormantProperties(props(), { now: NOW, thresholdDays: 10 });
  const ids = result.map(r => r.propertyId).sort();
  assert.deepStrictEqual(ids, ['recBothStale', 'recNever', 'recStaleMsg', 'recStaleOpen'].sort());
});

test('mode "both": flagged only if BOTH signals exceed the threshold', () => {
  const result = wh.dormantProperties(props(), { now: NOW, thresholdDays: 10, mode: 'both' });
  const ids = result.map(r => r.propertyId).sort();
  assert.deepStrictEqual(ids, ['recBothStale', 'recNever'].sort());
});

test('a property that never recorded either timestamp is flagged (never seen = maximally dormant)', () => {
  const result = wh.dormantProperties(props(), { now: NOW, thresholdDays: 10 });
  const never = result.find(r => r.propertyId === 'recNever');
  assert.ok(never, 'flagged');
  assert.strictEqual(never.lastMessageReceived, null);
  assert.strictEqual(never.lastOwnerAppOpen, null);
});

test('threshold is configurable — a longer threshold un-flags a borderline property', () => {
  const result15 = wh.dormantProperties(props(), { now: NOW, thresholdDays: 20 });
  assert.ok(!result15.some(r => r.propertyId === 'recStaleMsg'), '15 days ago no longer exceeds a 20-day threshold');
});

test('defaults to DORMANT_THRESHOLD_DAYS_DEFAULT (10) when no thresholdDays is passed and env var is unset', () => {
  delete process.env.DORMANT_THRESHOLD_DAYS;
  assert.strictEqual(wh.DORMANT_THRESHOLD_DAYS_DEFAULT, 10);
  const result = wh.dormantProperties(props(), { now: NOW });
  assert.ok(result.some(r => r.propertyId === 'recStaleMsg'));
});

test('DORMANT_THRESHOLD_DAYS env var overrides the default when thresholdDays is not explicitly passed', () => {
  process.env.DORMANT_THRESHOLD_DAYS = '20';
  const result = wh.dormantProperties(props(), { now: NOW });
  assert.ok(!result.some(r => r.propertyId === 'recStaleMsg'), 'env-set 20-day threshold un-flags the 15-day-stale property');
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

test('dormant-report route: with a valid secret, returns the dormant list read-only', async () => {
  process.env.MANUAL_REPORT_SECRET = 'test-secret';
  const ctx = setup({ WS_Properties: props() });
  delete require.cache[require.resolve('../api/wabistay/dormant-report.js')];
  const route = require('../api/wabistay/dormant-report.js');
  const res = fakeRes();
  await route(fakeReq({ thresholdDays: '10' }, 'Bearer test-secret'), res);

  assert.strictEqual(res._status, 200);
  assert.strictEqual(res._json.ok, true);
  assert.strictEqual(res._json.totalProperties, 5);
  assert.ok(res._json.dormantCount >= 4);
  assert.strictEqual(ctx.airtable.log.length, 0, 'read-only — no writes');
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
