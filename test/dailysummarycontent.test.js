// test/dailysummarycontent.test.js
// Stage 3 part 2 — daily summary content sections (runDailySummary's stub is
// filled in). Covers each of the 7 spec sections independently against the
// exported per-section functions, plus two full end-to-end payload-shape
// tests via runDailySummary itself (one property with active hourly
// bookings, one with none). Delivery stays stubbed — these tests assert the
// aggregated payload shape and the Axiom log call, not any WhatsApp send.

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

// Fixed "today" for every section test: 2026-08-17 (SAST), well clear of any
// DST/offset edge case. Expressed as a UTC instant so sastCalendarDate(NOW)
// lands on this exact SAST calendar day.
const NOW = new Date('2026-08-17T10:00:00.000Z'); // 12:00 SAST
const TODAY_YMD = wh.sastCalendarDate(NOW);
const TOMORROW_YMD = wh.addSastDays(TODAY_YMD, 1);
const iso = (y, m, d, h = 12, min = 0) => new Date(Date.UTC(y, m - 1, d, h - 2, min)).toISOString(); // h/min are SAST

// ── 1. Room state grid ───────────────────────────────────────────────────────

test('roomStateGrid: distinguishes occupied-overnight from occupied-hourly via the active Checked In booking', () => {
  const rooms = [
    { id: 'r1', fields: { Status: 'Occupied' } },
    { id: 'r2', fields: { Status: 'Occupied' } },
    { id: 'r3', fields: { Status: 'Available' } },
    { id: 'r4', fields: { Status: 'Cleaning' } },
    { id: 'r5', fields: { Status: 'Maintenance' } },
  ];
  const bookingsByRoomId = new Map([
    ['r1', [{ fields: { Status: 'Checked In', 'Booking Type': 'Overnight' } }]],
    ['r2', [{ fields: { Status: 'Checked In', 'Booking Type': 'Hourly' } }]],
  ]);
  const grid = wh.roomStateGrid(rooms, bookingsByRoomId);
  assert.deepStrictEqual(grid, {
    'occupied-overnight': 1, 'occupied-hourly': 1, ready: 1, cleaning: 1, maintenance: 1
  });
});

test('roomStateGrid: an Occupied room with no resolvable Checked In booking defaults to occupied-overnight, not dropped', () => {
  const rooms = [{ id: 'r1', fields: { Status: 'Occupied' } }];
  const grid = wh.roomStateGrid(rooms, new Map());
  assert.strictEqual(grid['occupied-overnight'], 1);
  assert.strictEqual(grid['occupied-hourly'], 0);
});

// ── 2. Overnight: check-ins, check-outs, no-shows ────────────────────────────

test('overnightStatsToday: counts check-ins via Checked In At, check-outs via Status+Check Out date, no-shows via the approved inferred rule', () => {
  const bookings = [
    // Checked in today
    { fields: { 'Booking Type': 'Overnight', 'Checked In At': iso(2026, 8, 17, 9) } },
    // Checked out today (scheduled Check Out date)
    { fields: { 'Booking Type': 'Overnight', Status: 'Checked Out', 'Check Out': iso(2026, 8, 17, 10) } },
    // No-show: Confirmed, Check In date already arrived (today), never checked in
    { fields: { 'Booking Type': 'Overnight', Status: 'Confirmed', 'Check In': iso(2026, 8, 17, 14) } },
    // Not a no-show: Confirmed but Check In is tomorrow
    { fields: { 'Booking Type': 'Overnight', Status: 'Confirmed', 'Check In': iso(2026, 8, 18, 14) } },
    // Hourly booking — excluded from overnight stats entirely
    { fields: { 'Booking Type': 'Hourly', 'Checked In At': iso(2026, 8, 17, 9) } },
  ];
  const stats = wh.overnightStatsToday(bookings, TODAY_YMD);
  assert.deepStrictEqual(stats, { checkInsToday: 1, checkOutsToday: 1, noShowsToday: 1 });
});

test('isNoShow: a Confirmed booking whose Check In date is in the past (never resolved) still counts, per the approved <= today rule', () => {
  const stale = { fields: { Status: 'Confirmed', 'Check In': iso(2026, 8, 10, 14) } };
  assert.strictEqual(wh.isNoShow(stale, TODAY_YMD), true);
});

test('isNoShow: a Checked In booking is never a no-show regardless of date', () => {
  const checkedIn = { fields: { Status: 'Checked In', 'Check In': iso(2026, 8, 10, 14) } };
  assert.strictEqual(wh.isNoShow(checkedIn, TODAY_YMD), false);
});

// ── 3. Hourly: bookings today + overstay interventions ──────────────────────

test('hourlyStatsToday: counts hourly bookings by Check In date, and overstay interventions unscoped by Booking Type', () => {
  const bookings = [
    { fields: { 'Booking Type': 'Hourly', 'Check In': iso(2026, 8, 17, 9) } },
    { fields: { 'Booking Type': 'Hourly', 'Check In': iso(2026, 8, 18, 9) } }, // tomorrow — excluded
    { fields: { 'Booking Type': 'Overnight', 'Check In': iso(2026, 8, 17, 9) } }, // overnight — excluded from hourly count
    { fields: { 'Booking Type': 'Overnight', 'Checkout Warning Sent At': iso(2026, 8, 17, 11) } }, // warning on an OVERNIGHT booking still counts
    { fields: { 'Booking Type': 'Hourly', 'Checkout Warning Sent At': iso(2026, 8, 16, 11) } }, // yesterday — excluded
  ];
  const stats = wh.hourlyStatsToday(bookings, TODAY_YMD);
  assert.deepStrictEqual(stats, { totalHourlyBookingsToday: 1, overstayInterventionsToday: 1 });
});

// ── 4. Cleaning turnaround (job duration, not vacant-to-ready) ──────────────

test('cleaningTurnaroundToday: averages Cleaning Job Started At -> Cleaning Completed At for jobs completed today, labeled job_duration', () => {
  const bookings = [
    { fields: { 'Cleaning Job Started At': iso(2026, 8, 17, 8), 'Cleaning Completed At': iso(2026, 8, 17, 9) } }, // 60 min
    { fields: { 'Cleaning Job Started At': iso(2026, 8, 17, 9, 0), 'Cleaning Completed At': iso(2026, 8, 17, 9, 30) } }, // 30 min
    // Completed today but no START sent — counts toward jobsCompletedToday, not jobsWithDuration
    { fields: { 'Cleaning Completed At': iso(2026, 8, 17, 10) } },
    // Completed yesterday — excluded entirely
    { fields: { 'Cleaning Job Started At': iso(2026, 8, 16, 8), 'Cleaning Completed At': iso(2026, 8, 16, 9) } },
  ];
  const result = wh.cleaningTurnaroundToday(bookings, TODAY_YMD);
  assert.strictEqual(result.metric, 'job_duration');
  assert.strictEqual(result.jobsCompletedToday, 3);
  assert.strictEqual(result.jobsWithDuration, 2);
  assert.strictEqual(result.averageJobDurationMs, 45 * 60 * 1000); // (60+30)/2 minutes
});

test('cleaningTurnaroundToday: no jobs completed today reports null average, not zero or a crash', () => {
  const result = wh.cleaningTurnaroundToday([], TODAY_YMD);
  assert.deepStrictEqual(result, { metric: 'job_duration', jobsCompletedToday: 0, jobsWithDuration: 0, averageJobDurationMs: null });
});

// ── 5. Revenue (overnight / hourly / combined) ───────────────────────────────

test('revenueToday: sums Amount Due by Booking Type for the bookings already scoped to today', () => {
  const todaysBookings = [
    { fields: { 'Booking Type': 'Overnight', 'Amount Due': 700 } },
    { fields: { 'Booking Type': 'Overnight', 'Amount Due': 300 } },
    { fields: { 'Booking Type': 'Hourly', 'Amount Due': 150 } },
  ];
  assert.deepStrictEqual(wh.revenueToday(todaysBookings), {
    overnightRevenue: 1000, hourlyRevenue: 150, combinedRevenue: 1150
  });
});

// ── 6. Outstanding/pending payments — reuses Stage 1's paymentReconciliationLines ──

test('aggregateDailySummary: outstandingPayments reuses paymentReconciliationLines unchanged, scoped to today', () => {
  const property = { id: 'recP1', fields: { 'Property Name': 'Test Lodge' } };
  const rooms = [{ id: 'r1', fields: { 'Room Name': 'Room 1', Status: 'Occupied' } }];
  const guestsById = new Map([['g1', 'Jane Doe']]);
  const bookings = [
    { id: 'b1', fields: { 'Booking Type': 'Overnight', Room: ['r1'], Guest: ['g1'], 'Check In': iso(2026, 8, 17, 9), 'Amount Due': 700, 'Amount Paid': 200, Status: 'Checked In' } },
  ];
  const summary = wh.aggregateDailySummary(property, rooms, bookings, { todayYmd: TODAY_YMD, tomorrowYmd: TOMORROW_YMD }, guestsById);
  assert.strictEqual(summary.outstandingPayments.paymentLines.length, 1);
  assert.strictEqual(summary.outstandingPayments.paymentLines[0].delta, 500);
  assert.strictEqual(summary.outstandingPayments.paymentDeltaTotal, 500);
  assert.strictEqual(summary.outstandingPayments.paymentLines[0].guestName, 'Jane Doe');
});

// ── 7. Tomorrow's overnight arrivals ─────────────────────────────────────────

test('tomorrowsOvernightArrivals: only overnight bookings whose Check In date is tomorrow, hourly excluded', () => {
  const roomsById = new Map([['r1', 'Room 1']]);
  const guestsById = new Map([['g1', 'John Smith']]);
  const bookings = [
    { id: 'b1', fields: { 'Booking Type': 'Overnight', 'Check In': iso(2026, 8, 18, 14), Room: ['r1'], Guest: ['g1'], 'Booking Ref': 'BK1' } },
    { id: 'b2', fields: { 'Booking Type': 'Hourly', 'Check In': iso(2026, 8, 18, 14) } }, // excluded — not overnight
    { id: 'b3', fields: { 'Booking Type': 'Overnight', 'Check In': iso(2026, 8, 17, 14) } }, // today, not tomorrow — excluded
  ];
  const arrivals = wh.tomorrowsOvernightArrivals(bookings, TOMORROW_YMD, roomsById, guestsById);
  assert.strictEqual(arrivals.length, 1);
  assert.strictEqual(arrivals[0].bookingId, 'b1');
  assert.strictEqual(arrivals[0].guestName, 'John Smith');
  assert.strictEqual(arrivals[0].roomName, 'Room 1');
});

// ── End-to-end payload shape, via runDailySummary ────────────────────────────

function setupE2E(extraBookings) {
  // Owner link: sendDailySummary now resolves ownerName and throws without
  // one — a realistically-configured property has an owner, so this fixture
  // needs one too (see test/dailysummary.test.js's seed for the same fix).
  const property = { id: 'recVL', fields: { 'Property Name': 'Villa Liza Guest Lodge', 'Notify Phone': '27732273477', 'Daily Summary Hour': 12, 'Owner': ['recOwnerVL'] } };
  const owner = { id: 'recOwnerVL', fields: { 'Owner Name': 'Villa Liza Owner' } };
  const rooms = [
    { id: 'r1', fields: { 'Room Name': 'Room 1', Status: 'Occupied', Property: ['recVL'] } },
    { id: 'r2', fields: { 'Room Name': 'Room 2', Status: 'Available', Property: ['recVL'] } },
  ];
  const guest = { id: 'g1', fields: { 'Guest Name': 'Jane Doe' } };
  const bookings = [
    { id: 'b1', fields: { 'Booking Type': 'Overnight', Room: ['r1'], Guest: ['g1'], Status: 'Checked In', 'Checked In At': iso(2026, 8, 17, 9), 'Check In': iso(2026, 8, 17, 9), 'Amount Due': 700, 'Amount Paid': 700 } },
    ...extraBookings
  ];
  const ctx = setup({ WS_Properties: [property], WS_Rooms: rooms, WS_Bookings: bookings, WS_Guests: [guest], WS_Owners: [owner] });
  return { ctx, property };
}

test('runDailySummary E2E: a property WITH an active hourly booking produces a full 7-section payload', async () => {
  const { ctx } = setupE2E([
    { id: 'b2', fields: { 'Booking Type': 'Hourly', Room: ['r2'], Status: 'Checked In', 'Check In': iso(2026, 8, 17, 11), 'Amount Due': 150, 'Amount Paid': 0 } },
  ]);
  const result = await wh.runDailySummary({ now: NOW });

  assert.strictEqual(result.fired.length, 1);
  const summary = result.fired[0].summary;
  assert.strictEqual(summary.propertyId, 'recVL');
  assert.ok(summary.roomStateGrid);
  assert.ok(summary.overnight);
  assert.ok(summary.hourly);
  assert.strictEqual(summary.hourly.totalHourlyBookingsToday, 1);
  assert.ok(summary.cleaningTurnaround);
  assert.ok(summary.revenue);
  assert.strictEqual(summary.revenue.combinedRevenue, 700 + 150);
  assert.ok(summary.outstandingPayments);
  assert.ok(Array.isArray(summary.tomorrowsArrivals));

  // Payload was logged to Axiom (the stubbed send surface) — not actually sent.
  const payloadLog = ctx.axiom.find(a => a.event === 'daily_summary_payload');
  assert.ok(payloadLog, 'daily_summary_payload should be logged to Axiom');
  assert.strictEqual(payloadLog.template, 'wabistay_daily_summary');
  assert.strictEqual(ctx.sends.length, 0, 'stubbed — no WhatsApp send should happen');
});

test('runDailySummary E2E: a property with NO hourly bookings still produces a complete, zeroed hourly/revenue section', async () => {
  const { ctx } = setupE2E([]);
  const result = await wh.runDailySummary({ now: NOW });

  assert.strictEqual(result.fired.length, 1);
  const summary = result.fired[0].summary;
  assert.deepStrictEqual(summary.hourly, { totalHourlyBookingsToday: 0, overstayInterventionsToday: 0 });
  assert.strictEqual(summary.revenue.hourlyRevenue, 0);
  assert.strictEqual(summary.revenue.overnightRevenue, 700);

  const payloadLog = ctx.axiom.find(a => a.event === 'daily_summary_payload');
  assert.ok(payloadLog);
  assert.strictEqual(ctx.sends.length, 0);
});
