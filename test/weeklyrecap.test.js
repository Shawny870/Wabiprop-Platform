// test/weeklyrecap.test.js
// Weekly recap: implements the Meta-approved wabistay_owner_weekly_recap
// template (7 params). Replaces the retired runWeeklyValueNudge (5
// wrong-shape params, never matched any approved template) — runOwnerSummary
// (separate P&L reconciliation feature, own pending template) is untouched
// and not covered here. LIVE as of Meta approval, routed through the
// REPORT_TEST_MODE_PHONE gate (see resolveSendRecipient in webhook.js).

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

const NOW = new Date('2026-08-20T06:00:00.000Z'); // Thursday — matches the weekly-recap cron slot
const DAY_MS = 24 * 60 * 60 * 1000;
const daysAgo = n => new Date(NOW.getTime() - n * DAY_MS).toISOString();
const daysFromNow = n => new Date(NOW.getTime() + n * DAY_MS).toISOString();

function windowFor(now) {
  const periodEndMs = now.getTime();
  return {
    periodDays: 7,
    periodStartMs: periodEndMs - 7 * DAY_MS,
    periodEndMs,
    upcomingEndMs: periodEndMs + 7 * DAY_MS
  };
}

const rooms = [
  { id: 'recR1', fields: { 'Room Name': 'Room 01', 'Status': 'Available', 'Property': ['recP1'] } },
  { id: 'recR2', fields: { 'Room Name': 'Room 02', 'Status': 'Available', 'Property': ['recP1'] } }
];
const property = { id: 'recP1', fields: { 'Property Name': 'Villa Liza Guest Lodge', 'Notify Phone': '27732273477', 'Owner': ['recOwnerVL'] } };
const ownerRecord = { id: 'recOwnerVL', fields: { 'Owner Name': 'Villa Liza Owner' } };

function withOwner(report, ownerName = 'Villa Liza Owner') {
  return { ...report, ownerName };
}

// ── aggregateWeeklyRecap: reuses aggregateOwnerSummary + adds overnight/ ───
// ── short-stay split and completed-this-week payment reconciliation ───────

test('aggregateWeeklyRecap: overnight/short-stay split counts bookings by Check-In this week, by type', () => {
  const bookings = [
    { id: 'recB1', fields: { 'Guest': ['recG1'], 'Room': ['recR1'], 'Booking Type': 'Overnight', 'Amount Due': 400, 'Amount Paid': 400, 'Check In': daysAgo(3), 'Check Out': daysAgo(1) } },
    { id: 'recB2', fields: { 'Guest': ['recG2'], 'Room': ['recR2'], 'Booking Type': 'Hourly', 'Amount Due': 100, 'Amount Paid': 100, 'Check In': daysAgo(2), 'Check Out': new Date(new Date(daysAgo(2)).getTime() + 2 * 3600000).toISOString() } },
    { id: 'recB3', fields: { 'Guest': ['recG3'], 'Room': ['recR1'], 'Booking Type': 'Overnight', 'Amount Due': 300, 'Amount Paid': 100, 'Check In': daysAgo(5), 'Check Out': daysAgo(1) } }
  ];
  const report = wh.aggregateWeeklyRecap(property, rooms, bookings, windowFor(NOW));
  assert.strictEqual(report.overnightBookingsCount, 2);
  assert.strictEqual(report.shortStayBookingsCount, 1);
});

test('aggregateWeeklyRecap: outstanding payment is scoped to stays COMPLETED this week (Check Out), not started this week (Check In)', () => {
  const bookings = [
    // Started (Check In) 10 days ago, outside the window — but COMPLETES (Check Out) this week.
    { id: 'recB1', fields: { 'Guest': ['recG1'], 'Room': ['recR1'], 'Booking Type': 'Overnight', 'Amount Due': 300, 'Amount Paid': 100, 'Check In': daysAgo(10), 'Check Out': daysAgo(1) } },
    // Starts AND completes this week, fully settled.
    { id: 'recB2', fields: { 'Guest': ['recG2'], 'Room': ['recR2'], 'Booking Type': 'Overnight', 'Amount Due': 200, 'Amount Paid': 200, 'Check In': daysAgo(3), 'Check Out': daysAgo(2) } },
    // Starts this week but does NOT complete this week (Check Out in the future) — must not count toward outstanding.
    { id: 'recB3', fields: { 'Guest': ['recG3'], 'Room': ['recR1'], 'Booking Type': 'Overnight', 'Amount Due': 500, 'Amount Paid': 0, 'Check In': daysAgo(1), 'Check Out': daysFromNow(2) } }
  ];
  const report = wh.aggregateWeeklyRecap(property, rooms, bookings, windowFor(NOW));
  assert.strictEqual(report.outstandingFromCompletedStays, 200, 'only recB1 (300-100=200) completed this week; recB2 settled; recB3 has not completed yet');
});

test('aggregateWeeklyRecap: reuses aggregateOwnerSummary for occupancy and upcoming arrivals unchanged', () => {
  const bookings = [
    { id: 'recB1', fields: { 'Guest': ['recG1'], 'Room': ['recR1'], 'Booking Type': 'Overnight', 'Amount Due': 400, 'Amount Paid': 400, 'Check In': daysAgo(3), 'Check Out': daysAgo(1) } },
    { id: 'recB2', fields: { 'Guest': ['recG2'], 'Room': ['recR2'], 'Booking Type': 'Overnight', 'Amount Due': 400, 'Amount Paid': 400, 'Check In': daysFromNow(3), 'Check Out': daysFromNow(5) } }
  ];
  const report = wh.aggregateWeeklyRecap(property, rooms, bookings, windowFor(NOW));
  const compare = wh.aggregateOwnerSummary(property, rooms, bookings, windowFor(NOW));
  assert.strictEqual(report.occupancyRate, compare.occupancyRate);
  assert.strictEqual(report.upcomingBookings, compare.upcomingBookings);
  assert.strictEqual(report.upcomingBookings, 1, 'recB2 checks in 3 days from now, within the next-7-days window');
});

test('aggregateWeeklyRecap: zero bookings this week produces zeroed fields, no crash', () => {
  const report = wh.aggregateWeeklyRecap(property, rooms, [], windowFor(NOW));
  assert.strictEqual(report.overnightBookingsCount, 0);
  assert.strictEqual(report.shortStayBookingsCount, 0);
  assert.strictEqual(report.outstandingFromCompletedStays, 0);
  assert.strictEqual(report.totalBookings, 0);
});

// ── weeklyRecapTemplateParams: 7 params, Meta-approved order ────────────────

test('weeklyRecapTemplateParams: returns exactly 7 params in the locked order, correctly sourced', () => {
  const bookings = [
    { id: 'recB1', fields: { 'Guest': ['recG1'], 'Room': ['recR1'], 'Booking Type': 'Overnight', 'Amount Due': 400, 'Amount Paid': 400, 'Check In': daysAgo(3), 'Check Out': daysAgo(1) } },
    { id: 'recB2', fields: { 'Guest': ['recG2'], 'Room': ['recR2'], 'Booking Type': 'Hourly', 'Amount Due': 100, 'Amount Paid': 100, 'Check In': daysAgo(2), 'Check Out': new Date(new Date(daysAgo(2)).getTime() + 2 * 3600000).toISOString() } },
    { id: 'recB3', fields: { 'Guest': ['recG3'], 'Room': ['recR1'], 'Booking Type': 'Overnight', 'Amount Due': 300, 'Amount Paid': 100, 'Check In': daysAgo(5), 'Check Out': daysAgo(1) } },
    { id: 'recB4', fields: { 'Guest': ['recG4'], 'Room': ['recR2'], 'Booking Type': 'Overnight', 'Amount Due': 400, 'Amount Paid': 0, 'Check In': daysFromNow(3), 'Check Out': daysFromNow(5) } }
  ];
  const report = withOwner(wh.aggregateWeeklyRecap(property, rooms, bookings, windowFor(NOW)));
  const params = wh.weeklyRecapTemplateParams(report);

  assert.strictEqual(params.length, 7);
  assert.deepStrictEqual(params, [
    'Villa Liza Owner',                                 // {{1}} owner name
    'Villa Liza Guest Lodge',                           // {{2}} property name
    String(report.overnightBookingsCount),              // {{3}} overnight booking count — 2
    String(report.shortStayBookingsCount),              // {{4}} short-stay booking count — 1
    `${Math.round(report.occupancyRate * 100)}%`,       // {{5}} occupancy % this week
    String(report.upcomingBookings),                    // {{6}} upcoming arrivals next 7 days — 1
    'R200'                                              // {{7}} outstanding from stays completed this week
  ]);
  assert.strictEqual(report.overnightBookingsCount, 2);
  assert.strictEqual(report.shortStayBookingsCount, 1);
  assert.strictEqual(report.upcomingBookings, 1);
});

test('weeklyRecapTemplateParams: zero bookings produces "R0" outstanding, not null/blank', () => {
  const report = withOwner(wh.aggregateWeeklyRecap(property, rooms, [], windowFor(NOW)));
  const params = wh.weeklyRecapTemplateParams(report);
  assert.strictEqual(params[6], 'R0');
  assert.strictEqual(params[2], '0');
  assert.strictEqual(params[3], '0');
});

test('weeklyRecapTemplateParams: outstanding never shows negative, even if completed stays net-overpaid', () => {
  const bookings = [
    { id: 'recB1', fields: { 'Guest': ['recG1'], 'Room': ['recR1'], 'Booking Type': 'Overnight', 'Amount Due': 200, 'Amount Paid': 250, 'Check In': daysAgo(3), 'Check Out': daysAgo(1) } }
  ];
  const report = withOwner(wh.aggregateWeeklyRecap(property, rooms, bookings, windowFor(NOW)));
  const params = wh.weeklyRecapTemplateParams(report);
  assert.strictEqual(params[6], 'R0', 'an overpayment must not render as a negative "owed" amount');
});

test('weeklyRecapTemplateParams: throws if ownerName is missing (undefined) — no silent placeholder', () => {
  const report = wh.aggregateWeeklyRecap(property, rooms, [], windowFor(NOW));
  assert.throws(() => wh.weeklyRecapTemplateParams(report), /ownerName is missing/);
});

test('weeklyRecapTemplateParams: throws if ownerName is null (property has no linked owner)', () => {
  const report = withOwner(wh.aggregateWeeklyRecap(property, rooms, [], windowFor(NOW)), null);
  assert.throws(() => wh.weeklyRecapTemplateParams(report), /ownerName is missing/);
});

// ── END-TO-END: runWeeklyRecap resolves ownerName, sends live, isolates failures ──

test('E2E: runWeeklyRecap resolves a real linked owner and sends a live template with correct 7-param payload', async () => {
  const ctx = setup({
    WS_Properties: [property],
    WS_Owners: [ownerRecord],
    WS_Rooms: rooms,
    WS_Bookings: [
      { id: 'recB1', fields: { 'Guest': ['recG1'], 'Room': ['recR1'], 'Booking Type': 'Overnight', 'Amount Due': 400, 'Amount Paid': 400, 'Check In': daysAgo(3), 'Check Out': daysAgo(1) } }
    ],
    WS_Guests: []
  });

  const sent = await wh.runWeeklyRecap({ now: NOW });
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent.failed.length, 0);

  assert.strictEqual(ctx.sends.length, 1, 'the send is now LIVE, not stubbed');
  assert.strictEqual(ctx.sends[0].to, '27732273477', 'goes to the real Notify Phone — no REPORT_TEST_MODE_PHONE set in this test');
  assert.strictEqual(ctx.sends[0].template, wh.WEEKLY_RECAP_TEMPLATE);
  assert.strictEqual(ctx.sends[0].params.length, 7);
  assert.strictEqual(ctx.sends[0].params[0], 'Villa Liza Owner');

  const payloadEvent = ctx.axiom.find(e => e.event === 'weekly_recap_payload');
  assert.ok(payloadEvent);
  assert.strictEqual(payloadEvent.ownerName, 'Villa Liza Owner');
});

test('E2E: a property with NO linked owner throws inside sendWeeklyRecap, is logged loudly, and is excluded from `sent`', async () => {
  const ctx = setup({
    WS_Config: [{ id: 'recCFG1', fields: { 'Alert Phone': '27811110000' } }],
    WS_Properties: [{ id: 'recNoOwner', fields: { 'Property Name': 'No Owner Lodge', 'Notify Phone': '27700000003' } }],
    WS_Owners: [],
    WS_Rooms: [{ id: 'recR9', fields: { 'Room Name': 'Room A', 'Status': 'Available', 'Property': ['recNoOwner'] } }],
    WS_Bookings: [],
    WS_Guests: []
  });

  const sent = await wh.runWeeklyRecap({ now: NOW });

  assert.strictEqual(sent.length, 0);
  assert.strictEqual(sent.failed.length, 1);
  assert.strictEqual(sent.failed[0].propertyId, 'recNoOwner');

  const failLog = ctx.axiom.find(a => a.event === 'weekly_recap_property_failed');
  assert.ok(failLog);
  assert.match(failLog.message, /ownerName is missing/);
  assert.strictEqual(ctx.axiom.filter(a => a.event === 'weekly_recap_payload').length, 0);

  const alert = ctx.sends.find(s => s.to === '27811110000');
  assert.ok(alert, 'alertShawn sent a WhatsApp alert for the failing property');
  assert.ok(alert.body.includes('weekly_recap'));
});

test('a property that throws mid-run does not abort the others, and alertShawn fires for it', async () => {
  const ctx = setup({
    WS_Config: [{ id: 'recCFG1', fields: { 'Alert Phone': '27811110000' } }],
    WS_Properties: [
      { id: 'recBad', fields: { 'Property Name': 'Broken Lodge', 'Notify Phone': 12345, 'Owner': ['recOwnerBad'] } }, // non-string — .replace() throws
      { id: 'recGood', fields: { 'Property Name': 'Good Lodge', 'Notify Phone': '27700000002', 'Owner': ['recOwnerGood'] } }
    ],
    WS_Owners: [
      { id: 'recOwnerBad', fields: { 'Owner Name': 'Bad Owner' } },
      { id: 'recOwnerGood', fields: { 'Owner Name': 'Good Owner' } }
    ],
    WS_Rooms: [{ id: 'recR3', fields: { 'Room Name': 'Room A', 'Status': 'Available', 'Property': ['recGood'] } }],
    WS_Bookings: [],
    WS_Guests: []
  });

  const sent = await wh.runWeeklyRecap({ now: NOW });

  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].propertyId, 'recGood');
  assert.strictEqual(sent.failed.length, 1);
  assert.strictEqual(sent.failed[0].propertyId, 'recBad');

  const alert = ctx.sends.find(s => s.to === '27811110000');
  assert.ok(alert, 'alertShawn sent a WhatsApp alert for the failing property');
  assert.ok(alert.body.includes('weekly_recap'));
  assert.ok(alert.body.includes('Broken Lodge'));
});
