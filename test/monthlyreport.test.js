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
const property = { id: 'recP1', fields: { 'Property Name': 'Villa Liza Guest Lodge', 'Notify Phone': '27732273477', 'Owner': ['recOwnerVL'] } };
const ownerRecord = { id: 'recOwnerVL', fields: { 'Owner Name': 'Villa Liza Owner' } };

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

test('repeat-guest rate: a guest with a booking in the 12 months prior to this period counts as repeat', () => {
  const bookings = [
    // recG1: one booking 45 days ago (within the 12-month prior window) + one this month — repeat.
    { id: 'recB1', fields: { 'Guest': ['recG1'], 'Room': ['recR1'], 'Booking Type': 'Overnight', 'Amount Due': 400, 'Check In': daysAgo(45), 'Check Out': daysAgo(44) } },
    { id: 'recB2', fields: { 'Guest': ['recG1'], 'Room': ['recR1'], 'Booking Type': 'Overnight', 'Amount Due': 400, 'Check In': daysAgo(5), 'Check Out': daysAgo(4) } },
    // recG2 has only this one booking — not a repeat.
    { id: 'recB3', fields: { 'Guest': ['recG2'], 'Room': ['recR2'], 'Booking Type': 'Overnight', 'Amount Due': 400, 'Check In': daysAgo(3), 'Check Out': daysAgo(2) } }
  ];
  const report = wh.aggregateMonthlyReport(property, rooms, bookings, windowFor(NOW));
  assert.strictEqual(report.repeatGuestRate, 0.5, '1 of 2 distinct guests this month is a repeat');
});

test('repeat-guest rate: a prior booking OLDER than 12 months does not count — rolling window, not lifetime', () => {
  const bookings = [
    // recG1's only prior booking is 400 days ago — outside the 365-day window.
    { id: 'recB1', fields: { 'Guest': ['recG1'], 'Room': ['recR1'], 'Booking Type': 'Overnight', 'Amount Due': 400, 'Check In': daysAgo(400), 'Check Out': daysAgo(399) } },
    { id: 'recB2', fields: { 'Guest': ['recG1'], 'Room': ['recR1'], 'Booking Type': 'Overnight', 'Amount Due': 400, 'Check In': daysAgo(5), 'Check Out': daysAgo(4) } }
  ];
  const report = wh.aggregateMonthlyReport(property, rooms, bookings, windowFor(NOW));
  assert.strictEqual(report.repeatGuestRate, 0, 'a 400-day-old booking is outside the 12-month rolling window, unlike a lifetime-cumulative count');
});

test('repeat-guest rate: two bookings both within the current month do not count as repeat — only a booking BEFORE this period does', () => {
  const bookings = [
    // recG1 books twice this month, no earlier history — not a "prior visit" repeat.
    { id: 'recB1', fields: { 'Guest': ['recG1'], 'Room': ['recR1'], 'Booking Type': 'Overnight', 'Amount Due': 400, 'Check In': daysAgo(20), 'Check Out': daysAgo(19) } },
    { id: 'recB2', fields: { 'Guest': ['recG1'], 'Room': ['recR1'], 'Booking Type': 'Overnight', 'Amount Due': 400, 'Check In': daysAgo(5), 'Check Out': daysAgo(4) } }
  ];
  const report = wh.aggregateMonthlyReport(property, rooms, bookings, windowFor(NOW));
  assert.strictEqual(report.repeatGuestRate, 0, 'a second same-month booking is not a returning-from-a-previous-visit repeat');
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

// ── Busiest-day insight: single calendar day with the most rooms occupied ──

test('busiest day: identifies the single calendar day with the highest distinct-room occupancy', () => {
  const bookings = [
    // recR1: Fri 21 Aug -> Sun 23 Aug (2 nights: occupies Fri 21 and Sat 22)
    { id: 'recB1', fields: { 'Guest': ['recG1'], 'Room': ['recR1'], 'Booking Type': 'Overnight', 'Amount Due': 400, 'Check In': daysAgo(10), 'Check Out': daysAgo(8) } },
    // recR2: Sat 22 Aug -> Sun 23 Aug (1 night: occupies Sat 22)
    { id: 'recB2', fields: { 'Guest': ['recG2'], 'Room': ['recR2'], 'Booking Type': 'Overnight', 'Amount Due': 400, 'Check In': daysAgo(9), 'Check Out': daysAgo(8) } },
    // recR3: Sat 22 Aug -> Sun 23 Aug (1 night: occupies Sat 22)
    { id: 'recB3', fields: { 'Guest': ['recG3'], 'Room': ['recR3'], 'Booking Type': 'Overnight', 'Amount Due': 400, 'Check In': daysAgo(9), 'Check Out': daysAgo(8) } }
  ];
  const report = wh.aggregateMonthlyReport(property, rooms, bookings, windowFor(NOW));
  // Sat 22 Aug: recR1 + recR2 + recR3 = 3 rooms. Fri 21 Aug: recR1 only = 1 room.
  assert.strictEqual(report.busiestDayInsight, 'Your busiest day this month was Saturday, 22 August, with 3 rooms occupied.');
  assert.strictEqual(report.busiestDay.roomsOccupied, 3);
  assert.strictEqual(report.busiestDay.dates.length, 1);
});

test('busiest day: a tie between two days states both explicitly rather than picking a winner', () => {
  const bookings = [
    { id: 'recB1', fields: { 'Guest': ['recG1'], 'Room': ['recR1'], 'Booking Type': 'Overnight', 'Amount Due': 400, 'Check In': daysAgo(9), 'Check Out': daysAgo(8) } },  // Sat 22 Aug
    { id: 'recB2', fields: { 'Guest': ['recG2'], 'Room': ['recR2'], 'Booking Type': 'Overnight', 'Amount Due': 400, 'Check In': daysAgo(9), 'Check Out': daysAgo(8) } },  // Sat 22 Aug
    { id: 'recB3', fields: { 'Guest': ['recG3'], 'Room': ['recR1'], 'Booking Type': 'Overnight', 'Amount Due': 400, 'Check In': daysAgo(15), 'Check Out': daysAgo(14) } }, // Sun 16 Aug
    { id: 'recB4', fields: { 'Guest': ['recG4'], 'Room': ['recR2'], 'Booking Type': 'Overnight', 'Amount Due': 400, 'Check In': daysAgo(15), 'Check Out': daysAgo(14) } }  // Sun 16 Aug
  ];
  const report = wh.aggregateMonthlyReport(property, rooms, bookings, windowFor(NOW));
  assert.strictEqual(report.busiestDayInsight, 'Your busiest days this month were Sunday 16 August and Saturday 22 August.');
  assert.strictEqual(report.busiestDay.roomsOccupied, 2);
  assert.deepStrictEqual(report.busiestDay.dates, ['2026-08-16', '2026-08-22']);
});

test('busiest day: zero bookings this month reports "no bookings," no crash or false claim', () => {
  const report = wh.aggregateMonthlyReport(property, rooms, [], windowFor(NOW));
  assert.strictEqual(report.busiestDayInsight, 'No bookings this month.');
  assert.strictEqual(report.busiestDay.roomsOccupied, 0);
  assert.deepStrictEqual(report.busiestDay.dates, []);
});

test('busiest day: a single booking is a true (not misleading) busiest-day claim, singular "room"', () => {
  const bookings = [
    { id: 'recB1', fields: { 'Guest': ['recG1'], 'Room': ['recR1'], 'Booking Type': 'Overnight', 'Amount Due': 400, 'Check In': daysAgo(9), 'Check Out': daysAgo(8) } }
  ];
  const report = wh.aggregateMonthlyReport(property, rooms, bookings, windowFor(NOW));
  assert.strictEqual(report.busiestDayInsight, 'Your busiest day this month was Saturday, 22 August, with 1 room occupied.');
});

// ── Cron-level: LIVE send, per-property isolation, alertShawn ──────────────

test('runMonthlyReport sends one live template per property, and writes no Airtable data', async () => {
  const ctx = setup({
    WS_Properties: [property],
    WS_Owners: [ownerRecord],
    WS_Rooms: rooms,
    WS_Bookings: [{ id: 'recB1', fields: { 'Guest': ['recG1'], 'Room': ['recR1'], 'Booking Type': 'Overnight', 'Amount Due': 400, 'Check In': daysAgo(5), 'Check Out': daysAgo(3) } }],
    WS_Guests: []
  });
  const sent = await wh.runMonthlyReport({ now: NOW });

  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent.failed.length, 0);
  assert.strictEqual(ctx.sends.length, 1, 'LIVE as of MONTHLY_REPORT_TEMPLATE approval — no REPORT_TEST_MODE_PHONE set in this test, so this sends to the real Notify Phone');
  assert.strictEqual(ctx.sends[0].to, '27732273477');
  assert.strictEqual(ctx.sends[0].template, wh.MONTHLY_REPORT_TEMPLATE);
  assert.strictEqual(ctx.airtable.log.length, 0, 'read-only, no Airtable writes');
  const payloadEvent = ctx.axiom.find(e => e.event === 'monthly_report_payload');
  assert.ok(payloadEvent);
  assert.strictEqual(payloadEvent.template, wh.MONTHLY_REPORT_TEMPLATE);
  assert.strictEqual(payloadEvent.ownerName, 'Villa Liza Owner', 'ownerName is resolved and attached, not orphaned');
});

// ── monthlyReportTemplateParams: wabistay_owner_monthly_recap, 13 split slots ──
// Submitted-to-Meta shape: NO combined "up X% vs last month" delta sentences —
// occupancy/revenue/rating are each two independent this-month/last-month
// params. Mirrors dailySummaryTemplateParams's pattern exactly: pure,
// synchronous, expects report.ownerName pre-resolved and attached, throws
// loudly rather than silently defaulting if it's missing.

function withOwner(report, ownerName = 'Villa Liza Owner') {
  return { ...report, ownerName };
}

test('monthlyReportTemplateParams: returns exactly 11 params in the locked order, correctly sourced', () => {
  const bookings = [
    // This month: 1 overnight (2 nights, R400, rating 5), 1 hourly (2h)
    { id: 'recB1', fields: { 'Guest': ['recG1'], 'Room': ['recR1'], 'Booking Type': 'Overnight', 'Amount Due': 400, 'Rating': 5, 'Check In': daysAgo(10), 'Check Out': daysAgo(8) } },
    { id: 'recB2', fields: { 'Guest': ['recG2'], 'Room': ['recR2'], 'Booking Type': 'Hourly', 'Amount Due': 100, 'Check In': daysAgo(5), 'Check Out': new Date(new Date(daysAgo(5)).getTime() + 2 * 3600000).toISOString() } },
    // Last month: 1 overnight (1 night, R200, rating 3)
    { id: 'recB3', fields: { 'Guest': ['recG3'], 'Room': ['recR1'], 'Booking Type': 'Overnight', 'Amount Due': 200, 'Rating': 3, 'Check In': daysAgo(40), 'Check Out': daysAgo(39) } }
  ];
  const report = withOwner(wh.aggregateMonthlyReport(property, rooms, bookings, windowFor(NOW)));
  const params = wh.monthlyReportTemplateParams(report);

  assert.strictEqual(params.length, 11);
  assert.deepStrictEqual(params, [
    'Villa Liza Owner',                               // {{1}} owner name
    'Villa Liza Guest Lodge',                         // {{2}} property name
    `${report.occupancy.currentPct}%`,                // {{3}} occupancy this-month
    `${report.occupancy.priorPct}%`,                  // {{4}} occupancy last-month
    'R500',                                           // {{5}} revenue this-month (billed) — R400 overnight + R100 hourly
    'R200',                                           // {{6}} revenue last-month (billed)
    '1 overnight booking this month — guests stayed an average of 2 nights.', // {{7}} (1 booking is below durationModeInsight's minimum for a "most common" claim)
    '1 short-stay booking this month — guests stayed an average of 2 hours.', // {{8}}
    '0%',                                              // {{9}} repeat-guest % (no repeats in this dataset)
    '5',                                               // {{10}} rating this-month
    '3'                                                // {{11}} rating last-month
  ]);
});

test('monthlyReportTemplateParams: occupancy/revenue/rating are split this/last values, not combined delta sentences', () => {
  const report = withOwner(wh.aggregateMonthlyReport(property, rooms, [], windowFor(NOW)));
  const params = wh.monthlyReportTemplateParams(report);
  for (const p of [params[2], params[3], params[4], params[5], params[9], params[10]]) {
    assert.ok(!String(p).includes('vs last month'), `expected a split raw value, got a combined delta sentence: ${p}`);
  }
});

test('monthlyReportTemplateParams: revenue param is the plain currency figure only — "earned" wording is NOT baked in', () => {
  const bookings = [
    { id: 'recB1', fields: { 'Guest': ['recG1'], 'Room': ['recR1'], 'Booking Type': 'Overnight', 'Amount Due': 12400, 'Check In': daysAgo(5), 'Check Out': daysAgo(3) } }
  ];
  const report = withOwner(wh.aggregateMonthlyReport(property, rooms, bookings, windowFor(NOW)));
  const params = wh.monthlyReportTemplateParams(report);
  assert.strictEqual(params[4], 'R12400');
  assert.ok(!params[4].toLowerCase().includes('earned'), 'the word "earned" belongs in the template\'s static text, not the param value');
});

test('monthlyReportTemplateParams: null occupancy/rating/repeat-guest values render as "N/A", not "null" or NaN', () => {
  const report = withOwner(wh.aggregateMonthlyReport(property, rooms, [], windowFor(NOW)));
  const params = wh.monthlyReportTemplateParams(report);
  assert.strictEqual(params[8], 'N/A', 'repeat-guest % with zero current-month guests');
  assert.strictEqual(params[9], 'N/A', 'rating this-month with no ratings captured');
  assert.strictEqual(params[10], 'N/A', 'rating last-month with no ratings captured');
});

// ── {{7}}/{{8}}: overnight/short-stay combined count + duration-mode sentence ──
// Meta approved ONE slot per booking type, not separate count + mode params.
// durationModeInsight's mode-vs-average-vs-tie decision (PR #52) is reused
// completely untouched via report.overnightDurationModeInsight/
// shortStayDurationModeInsight — these tests only check the new combined
// string format, reusing the exact PR #52 test scenarios.

test('{{7}} overnight: a clear mode combines the count and "most guests stayed" phrasing into one sentence', () => {
  const bookings = [
    // Same as PR #52's clear-mode scenario: 3x 2-night, 1x 5-night — 2 nights is the clear mode
    { id: 'recB1', fields: { 'Guest': ['recG1'], 'Room': ['recR1'], 'Booking Type': 'Overnight', 'Amount Due': 400, 'Check In': daysAgo(10), 'Check Out': daysAgo(8) } },
    { id: 'recB2', fields: { 'Guest': ['recG2'], 'Room': ['recR1'], 'Booking Type': 'Overnight', 'Amount Due': 400, 'Check In': daysAgo(9), 'Check Out': daysAgo(7) } },
    { id: 'recB3', fields: { 'Guest': ['recG3'], 'Room': ['recR1'], 'Booking Type': 'Overnight', 'Amount Due': 400, 'Check In': daysAgo(6), 'Check Out': daysAgo(4) } },
    { id: 'recB4', fields: { 'Guest': ['recG4'], 'Room': ['recR2'], 'Booking Type': 'Overnight', 'Amount Due': 400, 'Check In': daysAgo(5), 'Check Out': daysAgo(0) } }
  ];
  const report = withOwner(wh.aggregateMonthlyReport(property, rooms, bookings, windowFor(NOW)));
  const params = wh.monthlyReportTemplateParams(report);
  assert.strictEqual(params[6], '4 overnight bookings this month — most guests stayed 2 nights.');
});

test('{{7}} overnight: a tie falls back to the existing average phrasing, combined with the count', () => {
  const bookings = [
    // Same as PR #52's tie scenario: 2x 2-night, 2x 4-night — tied
    { id: 'recB1', fields: { 'Guest': ['recG1'], 'Room': ['recR1'], 'Booking Type': 'Overnight', 'Amount Due': 400, 'Check In': daysAgo(10), 'Check Out': daysAgo(8) } },
    { id: 'recB2', fields: { 'Guest': ['recG2'], 'Room': ['recR1'], 'Booking Type': 'Overnight', 'Amount Due': 400, 'Check In': daysAgo(9), 'Check Out': daysAgo(7) } },
    { id: 'recB3', fields: { 'Guest': ['recG3'], 'Room': ['recR1'], 'Booking Type': 'Overnight', 'Amount Due': 400, 'Check In': daysAgo(6), 'Check Out': daysAgo(2) } },
    { id: 'recB4', fields: { 'Guest': ['recG4'], 'Room': ['recR2'], 'Booking Type': 'Overnight', 'Amount Due': 400, 'Check In': daysAgo(5), 'Check Out': daysAgo(1) } }
  ];
  const report = withOwner(wh.aggregateMonthlyReport(property, rooms, bookings, windowFor(NOW)));
  const params = wh.monthlyReportTemplateParams(report);
  assert.strictEqual(params[6], '4 overnight bookings this month — guests stayed an average of 3 nights.');
  assert.ok(!params[6].includes('most'), 'a tie must not be presented as a clear mode');
});

test('{{7}} overnight: zero bookings this period reports "No overnight bookings this month," no crash', () => {
  const report = withOwner(wh.aggregateMonthlyReport(property, rooms, [], windowFor(NOW)));
  const params = wh.monthlyReportTemplateParams(report);
  assert.strictEqual(params[6], 'No overnight bookings this month.');
});

test('{{7}} overnight: a single booking is singular "booking," not "bookings"', () => {
  const bookings = [
    { id: 'recB1', fields: { 'Guest': ['recG1'], 'Room': ['recR1'], 'Booking Type': 'Overnight', 'Amount Due': 400, 'Check In': daysAgo(5), 'Check Out': daysAgo(3) } }
  ];
  const report = withOwner(wh.aggregateMonthlyReport(property, rooms, bookings, windowFor(NOW)));
  const params = wh.monthlyReportTemplateParams(report);
  assert.match(params[6], /^1 overnight booking this month/);
});

test('{{8}} short-stay: a clear mode combines the count and "most guests booked N-hour stays" phrasing', () => {
  const bookings = [
    // Same as PR #52's clear-mode scenario, adapted for Hourly: 2x 2-hour, 1x 3-hour
    { id: 'recB1', fields: { 'Guest': ['recG1'], 'Room': ['recR1'], 'Booking Type': 'Hourly', 'Amount Due': 100, 'Check In': daysAgo(10), 'Check Out': new Date(new Date(daysAgo(10)).getTime() + 2 * 3600000).toISOString() } },
    { id: 'recB2', fields: { 'Guest': ['recG2'], 'Room': ['recR1'], 'Booking Type': 'Hourly', 'Amount Due': 100, 'Check In': daysAgo(9), 'Check Out': new Date(new Date(daysAgo(9)).getTime() + 2 * 3600000).toISOString() } },
    { id: 'recB3', fields: { 'Guest': ['recG3'], 'Room': ['recR2'], 'Booking Type': 'Hourly', 'Amount Due': 150, 'Check In': daysAgo(6), 'Check Out': new Date(new Date(daysAgo(6)).getTime() + 3 * 3600000).toISOString() } }
  ];
  const report = withOwner(wh.aggregateMonthlyReport(property, rooms, bookings, windowFor(NOW)));
  const params = wh.monthlyReportTemplateParams(report);
  assert.strictEqual(params[7], '3 short-stay bookings this month — most guests booked 2-hour stays.');
});

test('{{8}} short-stay: a tie falls back to the existing average phrasing, combined with the count', () => {
  const bookings = [
    { id: 'recB1', fields: { 'Guest': ['recG1'], 'Room': ['recR1'], 'Booking Type': 'Hourly', 'Amount Due': 100, 'Check In': daysAgo(10), 'Check Out': new Date(new Date(daysAgo(10)).getTime() + 1 * 3600000).toISOString() } },
    { id: 'recB2', fields: { 'Guest': ['recG2'], 'Room': ['recR1'], 'Booking Type': 'Hourly', 'Amount Due': 100, 'Check In': daysAgo(9), 'Check Out': new Date(new Date(daysAgo(9)).getTime() + 1 * 3600000).toISOString() } },
    { id: 'recB3', fields: { 'Guest': ['recG3'], 'Room': ['recR2'], 'Booking Type': 'Hourly', 'Amount Due': 150, 'Check In': daysAgo(6), 'Check Out': new Date(new Date(daysAgo(6)).getTime() + 3 * 3600000).toISOString() } },
    { id: 'recB4', fields: { 'Guest': ['recG4'], 'Room': ['recR2'], 'Booking Type': 'Hourly', 'Amount Due': 150, 'Check In': daysAgo(5), 'Check Out': new Date(new Date(daysAgo(5)).getTime() + 3 * 3600000).toISOString() } }
  ];
  const report = withOwner(wh.aggregateMonthlyReport(property, rooms, bookings, windowFor(NOW)));
  const params = wh.monthlyReportTemplateParams(report);
  assert.strictEqual(params[7], '4 short-stay bookings this month — guests stayed an average of 2 hours.');
  assert.ok(!params[7].includes('most'), 'a tie must not be presented as a clear mode');
});

test('{{8}} short-stay: zero Hourly bookings reports "No short-stay bookings this month," no crash', () => {
  const bookings = [
    { id: 'recB1', fields: { 'Guest': ['recG1'], 'Room': ['recR1'], 'Booking Type': 'Overnight', 'Amount Due': 400, 'Check In': daysAgo(5), 'Check Out': daysAgo(3) } }
  ];
  const report = withOwner(wh.aggregateMonthlyReport(property, rooms, bookings, windowFor(NOW)));
  const params = wh.monthlyReportTemplateParams(report);
  assert.strictEqual(params[7], 'No short-stay bookings this month.');
});

test('monthlyReportTemplateParams: preserves the 12-month repeat-guest window, unchanged from the prior wiring pass', () => {
  const bookings = [
    // recG1: repeat, within the 12-month window
    { id: 'recB1', fields: { 'Guest': ['recG1'], 'Room': ['recR1'], 'Booking Type': 'Overnight', 'Amount Due': 400, 'Check In': daysAgo(45), 'Check Out': daysAgo(44) } },
    { id: 'recB2', fields: { 'Guest': ['recG1'], 'Room': ['recR1'], 'Booking Type': 'Overnight', 'Amount Due': 400, 'Check In': daysAgo(5), 'Check Out': daysAgo(4) } },
    // recG2: not a repeat
    { id: 'recB3', fields: { 'Guest': ['recG2'], 'Room': ['recR2'], 'Booking Type': 'Overnight', 'Amount Due': 400, 'Check In': daysAgo(3), 'Check Out': daysAgo(2) } }
  ];
  const report = withOwner(wh.aggregateMonthlyReport(property, rooms, bookings, windowFor(NOW)));
  const params = wh.monthlyReportTemplateParams(report);
  assert.strictEqual(params[8], '50%');
});

test('monthlyReportTemplateParams: does NOT include busiestDayInsight (PR #53) — still an open CEO decision', () => {
  const report = withOwner(wh.aggregateMonthlyReport(property, rooms, [], windowFor(NOW)));
  const params = wh.monthlyReportTemplateParams(report);
  assert.ok(!params.includes(report.busiestDayInsight));
});

test('monthlyReportTemplateParams: does NOT include the cleaning-turnaround insight — internal ops metric, not owner-facing', () => {
  const report = withOwner(wh.aggregateMonthlyReport(property, rooms, [], windowFor(NOW)));
  const params = wh.monthlyReportTemplateParams(report);
  assert.ok(!params.includes(report.insights[4]));
});

test('monthlyReportTemplateParams: throws if ownerName is missing (undefined) — no silent placeholder', () => {
  const report = wh.aggregateMonthlyReport(property, rooms, [], windowFor(NOW));
  assert.throws(() => wh.monthlyReportTemplateParams(report), /ownerName is missing/);
});

test('monthlyReportTemplateParams: throws if ownerName is null (property has no linked owner)', () => {
  const report = withOwner(wh.aggregateMonthlyReport(property, rooms, [], windowFor(NOW)), null);
  assert.throws(() => wh.monthlyReportTemplateParams(report), /ownerName is missing/);
});

// ── END-TO-END: runMonthlyReport actually resolves ownerName and builds 11 params ──

test('E2E: runMonthlyReport resolves a real linked owner and logs correct 11-param templateParams in the Axiom payload', async () => {
  const ctx = setup({
    WS_Properties: [property],
    WS_Owners: [ownerRecord],
    WS_Rooms: rooms,
    WS_Bookings: [{ id: 'recB1', fields: { 'Guest': ['recG1'], 'Room': ['recR1'], 'Booking Type': 'Overnight', 'Amount Due': 400, 'Rating': 5, 'Check In': daysAgo(5), 'Check Out': daysAgo(3) } }],
    WS_Guests: []
  });

  const sent = await wh.runMonthlyReport({ now: NOW });
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent.failed.length, 0);

  const payloadEvent = ctx.axiom.find(e => e.event === 'monthly_report_payload');
  assert.ok(payloadEvent);
  assert.strictEqual(payloadEvent.templateParams.length, 11);
  assert.strictEqual(payloadEvent.templateParams[0], 'Villa Liza Owner');
  assert.strictEqual(payloadEvent.templateParams[1], 'Villa Liza Guest Lodge');
});

test('E2E: a property with NO linked owner throws inside sendMonthlyReport, is logged loudly, and is excluded from `sent`', async () => {
  const ctx = setup({
    WS_Config: [{ id: 'recCFG1', fields: { 'Alert Phone': '27811110000' } }],
    WS_Properties: [{ id: 'recNoOwner', fields: { 'Property Name': 'No Owner Lodge', 'Notify Phone': '27700000003' } }], // no Owner field at all
    WS_Owners: [],
    WS_Rooms: [{ id: 'recR9', fields: { 'Room Name': 'Room A', 'Status': 'Available', 'Property': ['recNoOwner'] } }],
    WS_Bookings: [],
    WS_Guests: []
  });

  const sent = await wh.runMonthlyReport({ now: NOW });

  assert.strictEqual(sent.length, 0, 'the misconfigured property never made it into sent');
  assert.strictEqual(sent.failed.length, 1);
  assert.strictEqual(sent.failed[0].propertyId, 'recNoOwner');

  const failLog = ctx.axiom.find(a => a.event === 'monthly_report_property_failed');
  assert.ok(failLog, 'the failure is logged loudly to Axiom, not silently dropped');
  assert.match(failLog.message, /ownerName is missing/);

  assert.strictEqual(ctx.axiom.filter(a => a.event === 'monthly_report_payload').length, 0, 'no payload logged for a property that threw');
});

test('a property that throws mid-run does not abort the others, and alertShawn fires for it', async () => {
  const ctx = setup({
    WS_Config: [{ id: 'recCFG1', fields: { 'Alert Phone': '27811110000' } }],
    WS_Properties: [
      { id: 'recBad', fields: { 'Property Name': 'Broken Lodge', 'Notify Phone': 12345 } }, // non-string — .replace() throws
      { id: 'recGood', fields: { 'Property Name': 'Good Lodge', 'Notify Phone': '27700000002', 'Owner': ['recOwnerGood'] } }
    ],
    WS_Owners: [{ id: 'recOwnerGood', fields: { 'Owner Name': 'Good Owner' } }],
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
