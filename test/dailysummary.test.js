// test/dailysummary.test.js
// Stage 3 part 1 — daily mini-reconciliation summary skeleton.
// GitHub Actions calls api/wabistay/cron/daily-summary.js hourly (UTC,
// deliberately timezone-naive — see that file and .github/workflows/
// daily-summary.yml); the route's own CRON_SECRET check and the hour-matching
// logic in runDailySummary() are what makes it fire at the right SAST hour.
// Message content (today's paymentReconciliationLines/
// formatPaymentReconciliationMessage) is wired in a later step — this file
// covers the skeleton: auth, hour-matching, and the Rule 29 interaction
// surface with the existing Monday weekly cron.

const { test } = require('node:test');
const assert = require('node:assert');
const { installEnv, installFetch, MockAirtable } = require('./harness');

installEnv();
const wh = require('../api/wabistay/webhook.js');

function fakeReq(authHeader) {
  return { method: 'GET', headers: authHeader ? { authorization: authHeader } : {} };
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

// Owner links: sendDailySummary now resolves ownerName (via resolveOwnerName)
// and throws if it's missing — a property with no linked WS_Owners record is
// a real misconfiguration, not something these hour-matching tests are meant
// to exercise. Seeded here so 'fires successfully' tests represent a
// realistically-configured property; recUnconfigured deliberately has no
// Daily Summary Hour at all, so it never reaches sendDailySummary regardless.
const seed = {
  WS_Properties: [
    { id: 'recVL', fields: { 'Property Name': 'Villa Liza Guest Lodge', 'Notify Phone': '27732273477', 'Daily Summary Hour': 20, 'Owner': ['recOwnerVL'] } },
    { id: 'recOther', fields: { 'Property Name': 'Other Lodge', 'Daily Summary Hour': 9, 'Owner': ['recOwnerOther'] } },
    { id: 'recUnconfigured', fields: { 'Property Name': 'No Hour Set Lodge' } }
  ],
  WS_Rooms: [],
  WS_Bookings: [],
  WS_Guests: [],
  WS_Owners: [
    { id: 'recOwnerVL', fields: { 'Owner Name': 'Villa Liza Owner' } },
    { id: 'recOwnerOther', fields: { 'Owner Name': 'Other Lodge Owner' } }
  ]
};

// ── Route-level auth (api/wabistay/cron/daily-summary.js) ───────────────────
// NEW here, not a reuse — confirmed live/via grep before building that no
// CRON_SECRET pattern existed anywhere in this codebase yet.

test('daily-summary route: refuses with no CRON_SECRET configured in env', async () => {
  delete process.env.CRON_SECRET;
  setup({ WS_Properties: [] });
  delete require.cache[require.resolve('../api/wabistay/cron/daily-summary.js')];
  const route = require('../api/wabistay/cron/daily-summary.js');
  const res = fakeRes();
  await route(fakeReq('Bearer whatever'), res);
  assert.strictEqual(res._status, 401);
});

test('daily-summary route: refuses a wrong token', async () => {
  process.env.CRON_SECRET = 'test-secret';
  setup({ WS_Properties: [] });
  delete require.cache[require.resolve('../api/wabistay/cron/daily-summary.js')];
  const route = require('../api/wabistay/cron/daily-summary.js');
  const res = fakeRes();
  await route(fakeReq('Bearer wrong'), res);
  assert.strictEqual(res._status, 401);
});

test('daily-summary route: refuses a missing Authorization header', async () => {
  process.env.CRON_SECRET = 'test-secret';
  setup({ WS_Properties: [] });
  delete require.cache[require.resolve('../api/wabistay/cron/daily-summary.js')];
  const route = require('../api/wabistay/cron/daily-summary.js');
  const res = fakeRes();
  await route(fakeReq(null), res);
  assert.strictEqual(res._status, 401);
});

test('daily-summary route: correct token reaches the handler and returns 200', async () => {
  process.env.CRON_SECRET = 'test-secret';
  setup(seed);
  delete require.cache[require.resolve('../api/wabistay/cron/daily-summary.js')];
  const route = require('../api/wabistay/cron/daily-summary.js');
  const res = fakeRes();
  await route(fakeReq('Bearer test-secret'), res);
  assert.strictEqual(res._status, 200);
  assert.strictEqual(res._json.ok, true);
});

// ── Hour-matching logic (wh.runDailySummary) ─────────────────────────────────

test('runDailySummary: fires only the property whose Daily Summary Hour matches the current SAST hour', async () => {
  const ctx = setup(seed);
  const result = await wh.runDailySummary({ now: new Date('2026-08-10T18:00:00.000Z') }); // 20:00 SAST

  assert.deepStrictEqual(result.fired.map(f => f.propertyId), ['recVL']);
  assert.strictEqual(result.currentSastHour, 20);
  const otherSkip = result.skipped.find(s => s.propertyId === 'recOther');
  assert.deepStrictEqual(otherSkip, { propertyId: 'recOther', reason: 'hour_not_matched', configuredHour: 9 });
});

test('runDailySummary: a different SAST hour fires a different property', async () => {
  const ctx = setup(seed);
  const result = await wh.runDailySummary({ now: new Date('2026-08-10T07:00:00.000Z') }); // 09:00 SAST

  assert.deepStrictEqual(result.fired.map(f => f.propertyId), ['recOther']);
  assert.strictEqual(result.currentSastHour, 9);
});

test('runDailySummary: an unconfigured property (no Daily Summary Hour) is skipped, never guessed', async () => {
  const ctx = setup(seed);
  const result = await wh.runDailySummary({ now: new Date('2026-08-10T18:00:00.000Z') });

  const unconfigured = result.skipped.find(s => s.propertyId === 'recUnconfigured');
  assert.deepStrictEqual(unconfigured, { propertyId: 'recUnconfigured', reason: 'not_configured' });
  assert.ok(!result.fired.some(f => f.propertyId === 'recUnconfigured'));
});

test('runDailySummary: an hour nobody is configured for fires nothing, not an error', async () => {
  const ctx = setup(seed);
  const result = await wh.runDailySummary({ now: new Date('2026-08-10T01:00:00.000Z') }); // 03:00 SAST
  assert.deepStrictEqual(result.fired, []);
  assert.strictEqual(result.skipped.length, 3);
});

// ── Per-property isolation: one bad property must not block the rest ────────
// Before this fix, an uncaught throw anywhere in the per-property loop body
// (e.g. sendDailySummary's ownerName resolution, on a misconfigured property)
// propagated straight out of the for-loop and silently skipped every OTHER
// property still waiting in that same run. Two properties sharing the exact
// same configured hour is what actually exercises this — recVL and recOther
// don't share an hour in the base `seed`, so this uses its own seed.

test('runDailySummary: one property throwing (no linked owner) does not block a second property at the same hour', async () => {
  const ctx = setup({
    WS_Properties: [
      { id: 'recBroken', fields: { 'Property Name': 'Broken Lodge', 'Daily Summary Hour': 12 } }, // no Owner -> throws
      { id: 'recGood', fields: { 'Property Name': 'Good Lodge', 'Daily Summary Hour': 12, 'Owner': ['recOwnGood'] } }
    ],
    WS_Owners: [{ id: 'recOwnGood', fields: { 'Owner Name': 'Good Owner' } }],
    WS_Rooms: [
      { id: 'rBroken', fields: { 'Room Name': 'B1', Status: 'Available', Property: ['recBroken'] } },
      { id: 'rGood', fields: { 'Room Name': 'G1', Status: 'Available', Property: ['recGood'] } }
    ],
    WS_Bookings: [],
    WS_Guests: []
  });

  const now = new Date('2026-08-10T10:00:00.000Z'); // 12:00 SAST — both properties' configured hour
  const result = await wh.runDailySummary({ now });

  assert.deepStrictEqual(result.fired.map(f => f.propertyId), ['recGood'], 'the good property still fires despite the broken one running first');
  assert.strictEqual(result.failed.length, 1);
  assert.strictEqual(result.failed[0].propertyId, 'recBroken');
  assert.match(result.failed[0].error, /ownerName is missing/);

  const failLog = ctx.axiom.find(a => a.event === 'daily_summary_property_failed' && a.propertyId === 'recBroken');
  assert.ok(failLog, 'failure logged with enough detail to diagnose');
  assert.strictEqual(failLog.propertyName, 'Broken Lodge');
  assert.match(failLog.message, /ownerName is missing/);
});

// ── Rule 29: interaction surface with runOwnerSummary (Monday weekly cron) ──
// Declared surface: both runOwnerSummary and runDailySummary read
// WS_Properties (and, once message content is wired in, WS_Bookings);
// neither writes to either. Read-only reporting on both sides — no shared
// mutable state, no ordering dependence, no write contention. Both are
// designed to fire on the same Monday (weekly at 06:00 SAST regardless of
// any property's Daily Summary Hour; daily at whatever hour each property is
// configured for, which may coincide). Proven here by running both against
// the SAME MockAirtable instance for the same Monday and confirming neither
// mutates the store nor interferes with the other's result.

test('Rule 29: the weekly cron and the hourly daily-summary check can both fire on the same Monday with no conflict', async () => {
  const mondaySixAmSast = new Date('2026-08-10T04:00:00.000Z'); // Monday 06:00 SAST — weekly cron's own schedule
  const villaLizaHourSast = new Date('2026-08-10T18:00:00.000Z'); // same Monday, 20:00 SAST — Villa Liza's configured hour

  const ctx = setup(seed);
  const writesBefore = ctx.airtable.log.length;

  const weeklyResult = await wh.runOwnerSummary({ now: mondaySixAmSast });
  const dailyResult = await wh.runDailySummary({ now: villaLizaHourSast });

  // Both read-only: no Airtable write landed from either call.
  assert.strictEqual(ctx.airtable.log.length, writesBefore, 'both crons are read-only reporting — zero writes from either');

  // Both produced independent, uninterfered-with results for the same property.
  assert.ok(weeklyResult.some(s => s.propertyId === 'recVL'), 'weekly cron covers Villa Liza regardless of its Daily Summary Hour');
  assert.ok(dailyResult.fired.some(f => f.propertyId === 'recVL'), 'daily check independently fires for Villa Liza at its own configured hour');

  // Order independence: running them in the opposite order produces the same
  // shape — neither call's result depends on whether the other ran first.
  const dailyResult2 = await wh.runDailySummary({ now: villaLizaHourSast });
  const weeklyResult2 = await wh.runOwnerSummary({ now: mondaySixAmSast });
  assert.deepStrictEqual(dailyResult2.fired, dailyResult.fired);
  assert.strictEqual(weeklyResult2.length, weeklyResult.length);
});
