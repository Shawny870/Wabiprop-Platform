// test/hourly.status.test.js
// Hourly booking status — the inventory-leak fix.
//
// `selectHourlyDuration` completed an hourly booking but never set
// `Status: 'Confirmed'`, leaving the row at 'Enquiry'. Both `cancelBooking` and
// `gateArrival` query strictly on 'Confirmed', and 'Enquiry' is in
// BLOCKING_BOOKING_STATUSES — so a cancelled hourly booking survived, kept
// holding its room forever, and an arriving hourly guest matched no booking at
// all.
//
// The replay harness drives ONE message per fixture, but this bug only shows up
// ACROSS messages: the damage is done by message 1 (duration) and only becomes
// visible at message 2 (cancel / gate arrival). So these tests drive the real
// handler twice against a single persistent MockAirtable — the same store, the
// same webhook, in sequence — which is the only way to reproduce the live
// sequence honestly. Run: node --test

const { test } = require('node:test');
const assert = require('node:assert');
const { installEnv, installFetch, makeRes, metaTextPayload, MockAirtable } = require('./harness');

installEnv();
const handler = require('../api/wabistay/webhook.js');

const GUEST_PHONE = '27821234567';
const SAST_OFFSET_MS = 2 * 60 * 60 * 1000;

// Check In at 14:00 SAST TODAY, so the gate-arrival test is not refused by the
// B9 too-early guard (which compares SAST calendar days).
function todaySast(hour) {
  const nowSast = new Date(Date.now() + SAST_OFFSET_MS);
  return new Date(Date.UTC(
    nowSast.getUTCFullYear(), nowSast.getUTCMonth(), nowSast.getUTCDate(), hour
  ) - SAST_OFFSET_MS).toISOString();
}

// A guest mid-hourly-flow: sitting at the duration menu with the half-built
// 'Enquiry' hold that collectHourlyDetails created. Two rooms so that "was the
// guest given their OWN room" is a real question with a wrong answer available.
function seed() {
  return {
    WS_Properties: [{
      id: 'recP1',
      fields: {
        'Property Name': 'Test Lodge', 'Phone Number ID': '111000111000',
        'City': 'Testville', 'Notify Phone': '27831112222',
        'Hourly Rate 1hr': 120, 'Hourly Rate 2hr': 250, 'Hourly Rate 3hr': 320
      }
    }],
    WS_Rooms: [
      { id: 'recR1', fields: { 'Room Name': 'Room 1', 'Status': 'Available', 'Property': ['recP1'] } },
      { id: 'recR2', fields: { 'Room Name': 'Room 2', 'Status': 'Available', 'Property': ['recP1'] } }
    ],
    WS_Guests: [{
      id: 'recG1',
      fields: { 'Guest Name': 'John Smith', 'Phone Number': GUEST_PHONE, 'Session State': 'AWAITING_HOURLY_DURATION' }
    }],
    WS_Bookings: [{
      id: 'recHourlyPend0001',
      fields: {
        'Guest': ['recG1'], 'Booking Type': 'Hourly', 'Status': 'Enquiry',
        'Check In': todaySast(14), 'Payment Status': 'Unpaid'
      }
    }],
    WS_Cleaners: []
  };
}

// Drives the real webhook once, against the shared store.
async function send(ctx, text) {
  const res = makeRes();
  await handler({ method: 'POST', body: metaTextPayload(GUEST_PHONE, text) }, res);
  return res;
}

function startSession() {
  const ctx = { airtable: new MockAirtable(seed()), sends: [], axiom: [] };
  installFetch(ctx);
  return ctx;
}

const bookingRow = ctx => ctx.airtable.tables.WS_Bookings.find(b => b.id === 'recHourlyPend0001');

// ── The fix itself ──────────────────────────────────────────────────────────

test('hourly: completing the booking sets Status to Confirmed, matching an overnight booking', async () => {
  const ctx = startSession();
  await send(ctx, '1'); // 1 hour

  const booking = bookingRow(ctx);
  assert.strictEqual(booking.fields['Status'], 'Confirmed',
    'a completed hourly booking must reach Confirmed — Enquiry leaves it invisible to cancelBooking/gateArrival and still blocking inventory');
  // Still a real, complete booking — the status change is additive.
  assert.ok(booking.fields['Check Out'], 'Check Out still written');
  assert.deepStrictEqual(booking.fields['Room'], ['recR1'], 'room still held');
});

// ── Leak closed: cancel actually cancels, room is freed ─────────────────────

test('hourly → cancel: the booking is really cancelled and its room stops blocking', async () => {
  const ctx = startSession();
  await send(ctx, '1');  // book 1 hour  → session CONFIRMED
  await send(ctx, '2');  // "2 - Cancel my booking"

  const booking = bookingRow(ctx);
  assert.strictEqual(booking.fields['Status'], 'Cancelled',
    'the guest was told the booking was cancelled — the row must actually say so');

  // The leak: 'Enquiry' and 'Confirmed' are both in BLOCKING_BOOKING_STATUSES,
  // so a row left in either state keeps holding its room against every future
  // availability check. Only 'Cancelled' releases it.
  const BLOCKING = ['Enquiry', 'Confirmed', 'Checked In'];
  assert.ok(!BLOCKING.includes(booking.fields['Status']),
    `room recR1 is still blocked by a booking the guest believes is cancelled (status: ${booking.fields['Status']})`);

  // And the guest was told the truth.
  const last = ctx.sends[ctx.sends.length - 1];
  assert.strictEqual(last.to, GUEST_PHONE);
  assert.match(last.body, /cancelled/i);
});

// ── Arriving guest matches their OWN booking ────────────────────────────────

test('hourly → gate arrival: the guest matches their own booking, not the legacy first-available fallback', async () => {
  const ctx = startSession();
  await send(ctx, '1');  // books recR1
  ctx.airtable.log.length = 0;
  ctx.sends.length = 0;
  await send(ctx, '1');  // "1 - I'm at the gate"

  const booking = bookingRow(ctx);
  assert.strictEqual(booking.fields['Status'], 'Checked In',
    'gate arrival must find and check in the guest\'s own booking');
  assert.deepStrictEqual(booking.fields['Room'], ['recR1'],
    'the guest must keep the room they were assigned — a reassignment here means gateArrival matched no booking and fell through to the first-available-room branch');

  // recR2 must never be touched: it is the room the legacy fallback would have
  // handed out. Its being written at all is the signature of the bug.
  const roomWrites = ctx.airtable.log.filter(l => l.table === 'WS_Rooms');
  assert.ok(roomWrites.every(w => w.id === 'recR1'),
    `only the guest's own room may be written; got: ${JSON.stringify(roomWrites.map(w => w.id))}`);

  const room2 = ctx.airtable.tables.WS_Rooms.find(r => r.id === 'recR2');
  assert.strictEqual(room2.fields['Status'], 'Available', 'the second room must be untouched');
});
