// test/weeklyvaluenudge.test.js
// Weekly value-nudge: a second weekly owner touchpoint, separate from the
// owner P&L summary, reusing aggregateOwnerSummary's data. Stubbed send
// (pending Meta template approval), per-property try/catch isolation,
// alertShawn() on failure — same pattern as runOwnerSummary/runDailySummary.

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

const NOW = new Date('2026-08-20T06:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;
const daysAgo = n => new Date(NOW.getTime() - n * DAY_MS).toISOString();

function seed() {
  return {
    WS_Properties: [
      { id: 'recP1', fields: { 'Property Name': 'Villa Liza Guest Lodge', 'Notify Phone': '27732273477' } },
      { id: 'recP2', fields: { 'Property Name': 'Second Lodge', 'Notify Phone': '27732273999' } }
    ],
    WS_Rooms: [
      { id: 'recR1', fields: { 'Room Name': 'Room 01', 'Status': 'Available', 'Property': ['recP1'] } },
      { id: 'recR2', fields: { 'Room Name': 'Room A', 'Status': 'Available', 'Property': ['recP2'] } }
    ],
    WS_Bookings: [
      {
        id: 'recB1',
        fields: {
          'Status': 'Checked Out', 'Room': ['recR1'], 'Amount Due': 400, 'Amount Paid': 400,
          'Check In': daysAgo(2), 'Check Out': daysAgo(1)
        }
      }
    ],
    WS_Guests: []
  };
}

test('runWeeklyValueNudge produces one stubbed payload per property, read-only', async () => {
  const ctx = setup(seed());
  const results = await wh.runWeeklyValueNudge({ now: NOW });

  assert.strictEqual(results.length, 2);
  assert.strictEqual(results.failed.length, 0);
  assert.strictEqual(ctx.sends.length, 0, 'still stubbed — no live WhatsApp send yet');
  assert.strictEqual(ctx.airtable.log.length, 0, 'read-only, no Airtable writes');

  const vl = results.find(r => r.propertyId === 'recP1');
  assert.strictEqual(vl.totalBookings, 1);

  const payloadEvent = ctx.axiom.find(e => e.event === 'weekly_value_nudge_payload' && e.propertyId === 'recP1');
  assert.ok(payloadEvent, 'payload logged to Axiom for verifiability while stubbed');
  assert.strictEqual(payloadEvent.template, wh.VALUE_NUDGE_TEMPLATE);
});

test('valueNudgeTemplateParams shape: property, bookings, occupancy%, upcoming, attention line', () => {
  const summary = {
    propertyName: 'Villa Liza Guest Lodge', totalBookings: 3, occupancyRate: 0.5,
    upcomingBookings: 2, paymentDeltaTotal: 150
  };
  const params = wh.valueNudgeTemplateParams(summary);
  assert.deepStrictEqual(params, ['Villa Liza Guest Lodge', '3', '50%', '2', 'R150.00 outstanding from this week']);
});

test('valueNudgeTemplateParams reports "all payments settled" when nothing is outstanding', () => {
  const summary = { propertyName: 'X', totalBookings: 0, occupancyRate: 0, upcomingBookings: 0, paymentDeltaTotal: 0 };
  const params = wh.valueNudgeTemplateParams(summary);
  assert.strictEqual(params[4], 'all payments settled');
});

test('a property that throws mid-run does not abort the others, and alertShawn fires for it', async () => {
  const ctx = setup({
    WS_Config: [{ id: 'recCFG1', fields: { 'Alert Phone': '27811110000' } }],
    WS_Properties: [
      { id: 'recBad', fields: { 'Property Name': 'Broken Lodge', 'Notify Phone': '27700000001' } },
      { id: 'recGood', fields: { 'Property Name': 'Good Lodge', 'Notify Phone': '27700000002' } }
    ],
    WS_Rooms: [{ id: 'recR2', fields: { 'Room Name': 'Room A', 'Status': 'Available', 'Property': ['recGood'] } }],
    WS_Bookings: [],
    WS_Guests: []
  });

  // Force aggregateOwnerSummary (or its downstream send) to blow up for one
  // property by making that property's own rooms filter throw — simplest
  // reliable way without a real sabotage hook: monkey-patch sendWeeklyValueNudge
  // is not exported for override, so instead seed a room with a non-array
  // Property field, which the (r.fields['Property'] || []).includes() guard
  // in webhook.js already handles gracefully — so instead directly assert the
  // try/catch contract via a property with a malformed Notify Phone type that
  // breaks the .replace() call in sendWeeklyValueNudge.
  ctx.airtable.tables.WS_Properties[0].fields['Notify Phone'] = 12345; // not a string — .replace() throws

  const results = await wh.runWeeklyValueNudge({ now: NOW });

  assert.strictEqual(results.length, 1, 'the good property still got a result');
  assert.strictEqual(results[0].propertyId, 'recGood');
  assert.strictEqual(results.failed.length, 1);
  assert.strictEqual(results.failed[0].propertyId, 'recBad');

  const alert = ctx.sends.find(s => s.to === '27811110000');
  assert.ok(alert, 'alertShawn sent a WhatsApp alert for the failing property');
  assert.ok(alert.body.includes('weekly_value_nudge'));
  assert.ok(alert.body.includes('Broken Lodge'));
});
