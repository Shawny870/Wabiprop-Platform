// test/reporttestmodegate.test.js
// REPORT_TEST_MODE_PHONE — the entire safety mechanism gating live report
// sends (weekly recap + monthly report). When set, every send is redirected
// to that one number regardless of which property/owner it's actually for,
// with the real intended recipient logged to Axiom so "this would have gone
// to Chris" is verifiable without Chris ever receiving it. When unset, sends
// go to the real owner as normal (covered by each report's own E2E tests).
//
// Never set in any committed file — this test sets/restores it directly on
// process.env for the duration of each test, exactly how the CEO would set
// it in Vercel.

const { test } = require('node:test');
const assert = require('node:assert');
const { installEnv, installFetch, MockAirtable } = require('./harness');

installEnv();
const wh = require('../api/wabistay/webhook.js');

function setup(seed) {
  const ctx = { airtable: new MockAirtable(seed), sends: [], axiom: [] };
  installFetch(ctx);
  return ctx;
}

function withTestModePhone(phone, fn) {
  const original = process.env.REPORT_TEST_MODE_PHONE;
  process.env.REPORT_TEST_MODE_PHONE = phone;
  return Promise.resolve(fn()).finally(() => {
    if (original === undefined) delete process.env.REPORT_TEST_MODE_PHONE;
    else process.env.REPORT_TEST_MODE_PHONE = original;
  });
}

const NOW = new Date('2026-08-20T06:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;
const daysAgo = n => new Date(NOW.getTime() - n * DAY_MS).toISOString();

const rooms = [{ id: 'recR1', fields: { 'Room Name': 'Room 01', 'Status': 'Available', 'Property': ['recP1'] } }];
const property = { id: 'recP1', fields: { 'Property Name': 'Villa Liza Guest Lodge', 'Notify Phone': '27732273477', 'Owner': ['recOwnerVL'] } };
const ownerRecord = { id: 'recOwnerVL', fields: { 'Owner Name': 'Villa Liza Owner' } };

// ── resolveSendRecipient: the gate function itself ──────────────────────────

test('resolveSendRecipient: unset REPORT_TEST_MODE_PHONE passes the real recipient through unchanged', () => {
  setup({});
  delete process.env.REPORT_TEST_MODE_PHONE;
  const recipient = wh.resolveSendRecipient('27732273477', 'monthly_report', { propertyId: 'recP1' });
  assert.strictEqual(recipient, '27732273477');
});

test('resolveSendRecipient: set REPORT_TEST_MODE_PHONE redirects to the test number, regardless of the real recipient', async () => {
  setup({});
  await withTestModePhone('27899999999', () => {
    const recipient = wh.resolveSendRecipient('27732273477', 'monthly_report', { propertyId: 'recP1' });
    assert.strictEqual(recipient, '27899999999');
  });
});

test('resolveSendRecipient: logs the real intended recipient to Axiom when redirecting, without sending to them', async () => {
  const ctx = setup({});
  await withTestModePhone('27899999999', () => {
    wh.resolveSendRecipient('27732273477', 'monthly_report', { propertyId: 'recP1' });
  });
  const redirectLog = ctx.axiom.find(e => e.event === 'report_test_mode_redirect');
  assert.ok(redirectLog, 'a redirect event is logged for CEO to verify "this would have gone to X"');
  assert.strictEqual(redirectLog.intendedRecipient, '27732273477');
  assert.strictEqual(redirectLog.redirectedTo, '27899999999');
  assert.strictEqual(redirectLog.site, 'monthly_report');
  assert.strictEqual(redirectLog.propertyId, 'recP1');
});

// ── End-to-end: both real send paths actually honor the gate ────────────────

test('E2E monthly: REPORT_TEST_MODE_PHONE set redirects the live monthly send away from the real owner', async () => {
  const ctx = setup({
    WS_Properties: [property],
    WS_Owners: [ownerRecord],
    WS_Rooms: rooms,
    WS_Bookings: [{ id: 'recB1', fields: { 'Guest': ['recG1'], 'Room': ['recR1'], 'Booking Type': 'Overnight', 'Amount Due': 400, 'Check In': daysAgo(5), 'Check Out': daysAgo(3) } }],
    WS_Guests: []
  });

  await withTestModePhone('27899999999', () => wh.runMonthlyReport({ now: NOW }));

  assert.strictEqual(ctx.sends.length, 1);
  assert.strictEqual(ctx.sends[0].to, '27899999999', 'redirected — never reached the real owner number');
  assert.notStrictEqual(ctx.sends[0].to, '27732273477');

  const redirectLog = ctx.axiom.find(e => e.event === 'report_test_mode_redirect' && e.site === 'monthly_report');
  assert.ok(redirectLog);
  assert.strictEqual(redirectLog.intendedRecipient, '27732273477', 'the real owner\'s number is still logged, verifiably, just never sent to');
});

test('E2E weekly: REPORT_TEST_MODE_PHONE set redirects the live weekly-recap send away from the real owner', async () => {
  const ctx = setup({
    WS_Properties: [property],
    WS_Owners: [ownerRecord],
    WS_Rooms: rooms,
    WS_Bookings: [{ id: 'recB1', fields: { 'Guest': ['recG1'], 'Room': ['recR1'], 'Booking Type': 'Overnight', 'Amount Due': 400, 'Check In': daysAgo(3), 'Check Out': daysAgo(1) } }],
    WS_Guests: []
  });

  await withTestModePhone('27899999999', () => wh.runWeeklyRecap({ now: NOW }));

  assert.strictEqual(ctx.sends.length, 1);
  assert.strictEqual(ctx.sends[0].to, '27899999999', 'redirected — never reached the real owner number');

  const redirectLog = ctx.axiom.find(e => e.event === 'report_test_mode_redirect' && e.site === 'weekly_recap');
  assert.ok(redirectLog);
  assert.strictEqual(redirectLog.intendedRecipient, '27732273477');
});

test('E2E monthly: REPORT_TEST_MODE_PHONE unset sends live to the real owner, as normal', async () => {
  delete process.env.REPORT_TEST_MODE_PHONE;
  const ctx = setup({
    WS_Properties: [property],
    WS_Owners: [ownerRecord],
    WS_Rooms: rooms,
    WS_Bookings: [{ id: 'recB1', fields: { 'Guest': ['recG1'], 'Room': ['recR1'], 'Booking Type': 'Overnight', 'Amount Due': 400, 'Check In': daysAgo(5), 'Check Out': daysAgo(3) } }],
    WS_Guests: []
  });

  await wh.runMonthlyReport({ now: NOW });

  assert.strictEqual(ctx.sends.length, 1);
  assert.strictEqual(ctx.sends[0].to, '27732273477');
  assert.strictEqual(ctx.axiom.filter(e => e.event === 'report_test_mode_redirect').length, 0, 'no redirect event when the gate is unset');
});
