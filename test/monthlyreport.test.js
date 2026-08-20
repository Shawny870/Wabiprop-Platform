// test/monthlyreport.test.js
// Monthly BI rollup: this-month-vs-last-month insight, not a bigger daily/
// weekly dump. Covers each metric's happy path, the "no data" edge cases
// (so a young property doesn't crash or lie about having no baseline), the
// data-gap flags (occupancy denominator caveat, cleaning-turnaround-as-proxy
// labeling), and per-property failure isolation with alertShawn.

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

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-08-31T07:00:00.000Z');
const daysAgo = n => new Date(NOW.getTime() - n * DAY_MS).toISOString();

function windowFor(now) {
  const periodEndMs = now.getTime();
  return {
    periodDays: 30,
    periodStartMs: periodEndMs - 30 * DAY_MS,
    priorPeriodStartMs: periodEndMs - 60 * DAY_MS,
    periodEndMs
  };
}

const rooms = [
  { id: 'recR1', fields: { 'Room Name': 'Room 01', 'Status': 'Available', 'Property': ['recP1'] } },
  { id: 'recR2', fields: { 'Room Name': 'Room 02', 'Status': 'Available', 'Property': ['recP1'] } }
];
const property = { id: 'recP1', fields: { 'Property Name': 'Villa Liza Guest Lodge', 'Notify Phone': '27732273477' } };

test('occupancy, revenue, and rating trends compare this month vs last month correctly', () => {
  const bookings = [
    // This month: 1 booking, 2 nights, R400, rating 5
    { id: 'recB1', fields: { 'Guest': ['recG1'], 'Room': ['recR1'], 'Booking Type': 'Overnight', 'Amount Due': 400, 'Rating': 5, 'Check In': daysAgo(10), 'Check Out': daysAgo(8) } },
    // Last month: 1 booking, 1 night, R200, rating 3
    { id: 'recB2', fields: { 'Guest': ['recG2'], 'Room': ['recR1'], 'Booking Type': 'Overnight', 'Amount Due': 200, 'Rating': 3, 'Check In': daysAgo(40), 'Check Out': daysAgo(39) } }
  ];
  const report = wh.aggregateMonthlyReport(property, rooms, bookings, windowFor(NOW));

  assert.strictEqual(report.revenue.current, 400);
  assert.strictEqual(report.revenue.prior, 200);
  assert.strictEqual(report.avgRating, 5);
  assert.strictEqual(report.priorAvgRating, 3);
  assert.ok(report.occupancy.currentPct > report.occupancy.priorPct, 'more room-nights sold this month');
  assert.ok(report.insights.some(i => i.includes('Revenue up')), `expected an "up" revenue insight, got: ${JSON.stringify(report.insights)}`);
});

test('a property with no prior-month data gets an honest "no baseline" insight, not a fake 0% or a crash', () => {
  const bookings = [
    { id: 'recB1', fields: { 'Guest': ['recG1'], 'Room': ['recR1'], 'Booking Type': 'Overnight', 'Amount Due': 400, 'Check In': daysAgo(5), 'Check Out': daysAgo(3) } }
  ];
  const report = wh.aggregateMonthlyReport(property, rooms, bookings, windowFor(NOW));
  assert.strictEqual(report.revenue.prior, 0);
  assert.ok(report.insights.some(i => i.includes('no prior-month baseline')), `expected a no-baseline insight, got: ${JSON.stringify(report.insights)}`);
});

test('average length of stay only counts Overnight bookings, not Hourly', () => {
  const bookings = [
    { id: 'recB1', fields: { 'Guest': ['recG1'], 'Room': ['recR1'], 'Booking Type': 'Overnight', 'Amount Due': 600, 'Check In': daysAgo(10), 'Check Out': daysAgo(7) } }, // 3 nights
    { id: 'recB2', fields: { 'Guest': ['recG2'], 'Room': ['recR2'], 'Booking Type': 'Hourly', 'Amount Due': 120, 'Check In': daysAgo(5), 'Check Out': daysAgo(5) } }
  ];
  const report = wh.aggregateMonthlyReport(property, rooms, bookings, windowFor(NOW));
  assert.strictEqual(report.avgLengthOfStayNights, 3, 'the Hourly booking must not pull the average toward 0/short stays');
});

test('repeat-guest rate: a guest with a prior booking anywhere in the scoped set counts as repeat', () => {
  const bookings = [
    // recG1 has TWO bookings total (one prior month, one this month) — repeat.
    { id: 'recB1', fields: { 'Guest': ['recG1'], 'Room': ['recR1'], 'Booking Type': 'Overnight', 'Amount Due': 400, 'Check In': daysAgo(45), 'Check Out': daysAgo(44) } },
    { id: 'recB2', fields: { 'Guest': ['recG1'], 'Room': ['recR1'], 'Booking Type': 'Overnight', 'Amount Due': 400, 'Check In': daysAgo(5), 'Check Out': daysAgo(4) } },
    // recG2 has only this one booking — not a repeat.
    { id: 'recB3', fields: { 'Guest': ['recG2'], 'Room': ['recR2'], 'Booking Type': 'Overnight', 'Amount Due': 400, 'Check In': daysAgo(3), 'Check Out': daysAgo(2) } }
  ];
  const report = wh.aggregateMonthlyReport(property, rooms, bookings, windowFor(NOW));
  assert.strictEqual(report.repeatGuestRate, 0.5, '1 of 2 distinct guests this month is a repeat');
});

test('cleaning turnaround uses job duration (dispatch-to-DONE) and labels itself explicitly as a proxy', () => {
  const bookings = [
    {
      id: 'recB1', fields: {
        'Guest': ['recG1'], 'Room': ['recR1'], 'Booking Type': 'Overnight', 'Amount Due': 400,
        'Check In': daysAgo(10), 'Check Out': daysAgo(8),
        'Cleaning Job Started At': daysAgo(8),
        'Cleaning Completed At': new Date(NOW.getTime() - 8 * DAY_MS + 45 * 60 * 1000).toISOString() // +45 min
      }
    }
  ];
  const report = wh.aggregateMonthlyReport(property, rooms, bookings, windowFor(NOW));
  assert.strictEqual(Math.round(report.avgCleaningJobDurationMs / 60000), 45);
  assert.ok(report.insights.some(i => i.includes('dispatch-to-DONE') && i.includes('not vacant-to-ready')),
    'the insight itself must label this as a proxy, not present it as the real vacant-to-ready number');
});

test('occupancy carries an explicit denominatorCaveat — never presented as exact', () => {
  const report = wh.aggregateMonthlyReport(property, rooms, [], windowFor(NOW));
  assert.ok(typeof report.occupancy.denominatorCaveat === 'string' && report.occupancy.denominatorCaveat.length > 0);
});

test('a property with zero bookings this month and last month produces honest "no data" insights, no crash', () => {
  const report = wh.aggregateMonthlyReport(property, rooms, [], windowFor(NOW));
  assert.strictEqual(report.totalBookings, 0);
  assert.strictEqual(report.avgLengthOfStayNights, null);
  assert.strictEqual(report.repeatGuestRate, null);
  assert.strictEqual(report.avgCleaningJobDurationMs, null);
  assert.strictEqual(report.avgRating, null);
});

// ── Duration-mode insight: most common stay length, per booking type ───────

test('overnight duration mode: a clear mode (one value strictly more frequent) reports "most guests stayed"', () => {
  const bookings = [
    // 3x 2-night, 1x 5-night — 2 nights is the clear mode
    { id: 'recB1', fields: { 'Guest': ['recG1'], 'Room': ['recR1'], 'Booking Type': 'Overnight', 'Amount Due': 400, 'Check In': daysAgo(10), 'Check Out': daysAgo(8) } },
    { id: 'recB2', fields: { 'Guest': ['recG2'], 'Room': ['recR1'], 'Booking Type': 'Overnight', 'Amount Due': 400, 'Check In': daysAgo(9), 'Check Out': daysAgo(7) } },
    { id: 'recB3', fields: { 'Guest': ['recG3'], 'Room': ['recR1'], 'Booking Type': 'Overnight', 'Amount Due': 400, 'Check In': daysAgo(6), 'Check Out': daysAgo(4) } },
    { id: 'recB4', fields: { 'Guest': ['recG4'], 'Room': ['recR2'], 'Booking Type': 'Overnight', 'Amount Due': 400, 'Check In': daysAgo(5), 'Check Out': daysAgo(0) } }
  ];
  const report = wh.aggregateMonthlyReport(property, rooms, bookings, windowFor(NOW));
  assert.strictEqual(report.overnightDurationModeInsight, 'Most overnight guests stayed 2 nights.');
});

test('overnight duration mode: a tie (two values equally frequent) falls back to average, not a false "most common" claim', () => {
  const bookings = [
    // 2x 2-night, 2x 4-night — tied, no single clear mode
    { id: 'recB1', fields: { 'Guest': ['recG1'], 'Room': ['recR1'], 'Booking Type': 'Overnight', 'Amount Due': 400, 'Check In': daysAgo(10), 'Check Out': daysAgo(8) } },
    { id: 'recB2', fields: { 'Guest': ['recG2'], 'Room': ['recR1'], 'Booking Type': 'Overnight', 'Amount Due': 400, 'Check In': daysAgo(9), 'Check Out': daysAgo(7) } },
    { id: 'recB3', fields: { 'Guest': ['recG3'], 'Room': ['recR1'], 'Booking Type': 'Overnight', 'Amount Due': 400, 'Check In': daysAgo(6), 'Check Out': daysAgo(2) } },
    { id: 'recB4', fields: { 'Guest': ['recG4'], 'Room': ['recR2'], 'Booking Type': 'Overnight', 'Amount Due': 400, 'Check In': daysAgo(5), 'Check Out': daysAgo(1) } }
  ];
  const report = wh.aggregateMonthlyReport(property, rooms, bookings, windowFor(NOW));
  assert.strictEqual(report.overnightDurationModeInsight, 'Overnight guests stayed an average of 3 nights.');
  assert.ok(!report.overnightDurationModeInsight.includes('Most'), 'a tie must not be presented as a clear mode');
});

test('overnight duration mode: fewer than the minimum booking count falls back to average even with a technical mode', () => {
  const bookings = [
    // Only 2 bookings total — below the 3-booking threshold — even though both are 2 nights
    { id: 'recB1', fields: { 'Guest': ['recG1'], 'Room': ['recR1'], 'Booking Type': 'Overnight', 'Amount Due': 400, 'Check In': daysAgo(10), 'Check Out': daysAgo(8) } },
    { id: 'recB2', fields: { 'Guest': ['recG2'], 'Room': ['recR1'], 'Booking Type': 'Overnight', 'Amount Due': 400, 'Check In': daysAgo(9), 'Check Out': daysAgo(7) } }
  ];
  const report = wh.aggregateMonthlyReport(property, rooms, bookings, windowFor(NOW));
  assert.strictEqual(report.overnightDurationModeInsight, 'Overnight guests stayed an average of 2 nights.');
});

test('overnight duration mode: zero bookings this period reports "no bookings," no crash', () => {
  const report = wh.aggregateMonthlyReport(property, rooms, [], windowFor(NOW));
  assert.strictEqual(report.overnightDurationModeInsight, 'No overnight bookings this period.');
});

test('short-stay (Hourly) duration mode: uses hours, not nights, and ignores Overnight bookings', () => {
  const bookings = [
    { id: 'recB1', fields: { 'Guest': ['recG1'], 'Room': ['recR1'], 'Booking Type': 'Hourly', 'Amount Due': 100, 'Check In': daysAgo(10), 'Check Out': new Date(new Date(daysAgo(10)).getTime() + 2 * 3600000).toISOString() } },
    { id: 'recB2', fields: { 'Guest': ['recG2'], 'Room': ['recR1'], 'Booking Type': 'Hourly', 'Amount Due': 100, 'Check In': daysAgo(9), 'Check Out': new Date(new Date(daysAgo(9)).getTime() + 2 * 3600000).toISOString() } },
    { id: 'recB3', fields: { 'Guest': ['recG3'], 'Room': ['recR2'], 'Booking Type': 'Hourly', 'Amount Due': 150, 'Check In': daysAgo(6), 'Check Out': new Date(new Date(daysAgo(6)).getTime() + 3 * 3600000).toISOString() } },
    // Overnight booking present too — must not leak into the short-stay hours calc
    { id: 'recB4', fields: { 'Guest': ['recG4'], 'Room': ['recR2'], 'Booking Type': 'Overnight', 'Amount Due': 400, 'Check In': daysAgo(5), 'Check Out': daysAgo(0) } }
  ];
  const report = wh.aggregateMonthlyReport(property, rooms, bookings, windowFor(NOW));
  assert.strictEqual(report.shortStayDurationModeInsight, 'Most short-stay guests stayed 2 hours.');
});

test('short-stay (Hourly) duration mode: zero Hourly bookings reports "no bookings," no crash', () => {
  const bookings = [
    { id: 'recB1', fields: { 'Guest': ['recG1'], 'Room': ['recR1'], 'Booking Type': 'Overnight', 'Amount Due': 400, 'Check In': daysAgo(5), 'Check Out': daysAgo(3) } }
  ];
  const report = wh.aggregateMonthlyReport(property, rooms, bookings, windowFor(NOW));
  assert.strictEqual(report.shortStayDurationModeInsight, 'No short-stay bookings this period.');
});

// ── Cron-level: stubbed send, per-property isolation, alertShawn ───────────

test('runMonthlyReport produces one stubbed payload per property, read-only', async () => {
  const ctx = setup({
    WS_Properties: [property],
    WS_Rooms: rooms,
    WS_Bookings: [{ id: 'recB1', fields: { 'Guest': ['recG1'], 'Room': ['recR1'], 'Booking Type': 'Overnight', 'Amount Due': 400, 'Check In': daysAgo(5), 'Check Out': daysAgo(3) } }],
    WS_Guests: []
  });
  const sent = await wh.runMonthlyReport({ now: NOW });

  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent.failed.length, 0);
  assert.strictEqual(ctx.sends.length, 0, 'still stubbed — no live WhatsApp send yet');
  assert.strictEqual(ctx.airtable.log.length, 0, 'read-only, no Airtable writes');
  const payloadEvent = ctx.axiom.find(e => e.event === 'monthly_report_payload');
  assert.ok(payloadEvent);
  assert.strictEqual(payloadEvent.template, wh.MONTHLY_REPORT_TEMPLATE);
});

test('monthlyReportTemplateParams omits the cleaning-turnaround insight from the WhatsApp body', () => {
  const report = wh.aggregateMonthlyReport(property, rooms, [], windowFor(NOW));
  const params = wh.monthlyReportTemplateParams(report);
  assert.strictEqual(params.length, 6);
  assert.ok(!params.includes(report.insights[4]), 'cleaning-turnaround insight (internal ops metric) is not sent to the owner');
});

test('a property that throws mid-run does not abort the others, and alertShawn fires for it', async () => {
  const ctx = setup({
    WS_Config: [{ id: 'recCFG1', fields: { 'Alert Phone': '27811110000' } }],
    WS_Properties: [
      { id: 'recBad', fields: { 'Property Name': 'Broken Lodge', 'Notify Phone': 12345 } }, // non-string — .replace() throws
      { id: 'recGood', fields: { 'Property Name': 'Good Lodge', 'Notify Phone': '27700000002' } }
    ],
    WS_Rooms: [{ id: 'recR3', fields: { 'Room Name': 'Room A', 'Status': 'Available', 'Property': ['recGood'] } }],
    WS_Bookings: [],
    WS_Guests: []
  });

  const sent = await wh.runMonthlyReport({ now: NOW });

  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].propertyId, 'recGood');
  assert.strictEqual(sent.failed.length, 1);
  assert.strictEqual(sent.failed[0].propertyId, 'recBad');

  const alert = ctx.sends.find(s => s.to === '27811110000');
  assert.ok(alert, 'alertShawn sent a WhatsApp alert for the failing property');
  assert.ok(alert.body.includes('monthly_report'));
  assert.ok(alert.body.includes('Broken Lodge'));
});
