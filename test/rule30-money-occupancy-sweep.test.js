// test/rule30-money-occupancy-sweep.test.js
// Rule 30 step 2, slice 1 — money and occupancy handlers only.
//
// The 128-call-site sweep is multiple future PRs, not one. This slice covers
// every call site touching WS_Bookings, WS_Rooms.Status, or a payment/amount
// field, EXCLUDING notification-only, logging-only, and cosmetic writes
// (runAutoCheckout's warning-timestamp stamp is deferred to a future slice —
// it gates a reminder message, not money/occupancy state).
//
// Split, matching F40's existing precedent in this file:
//   FATAL — money-determining or state-finalizing writes (Amount Due, a
//   booking Status transition that finalizes a sale/check-in/checkout/
//   cancellation). Checked; on failure, logged loud and the guest is told
//   the truth instead of a false success message, and the dependent
//   send/state-advance is skipped.
//   NON-FATAL — WS_Rooms.Status writes, which are a derived display field,
//   not findAvailableRoom's source of truth (that's the WS_Bookings overlap
//   check). Checked and logged loud, but the flow proceeds regardless,
//   matching walkinBooking's existing room-status precedent (F40).
//
// Already-compliant sites (F40/F41/F42) are not retested here.

const { test } = require('node:test');
const assert = require('node:assert');
const { installEnv, installFetch, makeRes, metaTextPayload, MockAirtable } = require('./harness');

installEnv();
const wh = require('../api/wabistay/webhook.js');

const GUEST_PHONE = '27821234567';

function baseSeed(overrides = {}) {
  return {
    WS_Properties: [{
      id: 'recP1',
      fields: {
        'Property Name': 'Villa Liza Guest Lodge', 'Phone Number ID': '111000111000',
        'Notify Phone': '27732273477', 'Hourly Rate 1hr': 120, 'Hourly Rate 2hr': 250, 'Hourly Rate 3hr': 320
      }
    }],
    WS_Rooms: [
      { id: 'recR1', fields: { 'Room Name': 'Room 01', 'Room Number': 1, 'Status': 'Available', 'Property': ['recP1'] } }
    ],
    WS_Rates: [
      { id: 'recRateSingle', fields: { 'Rate Name': 'Single', 'Occupancy Type': 'Single', 'Amount': 250, 'Active': true, 'Property': ['recP1'] } },
      { id: 'recRateCouple', fields: { 'Rate Name': 'Couple', 'Occupancy Type': 'Couple', 'Amount': 400, 'Active': true, 'Property': ['recP1'] } }
    ],
    WS_Guests: [],
    WS_Bookings: [],
    WS_Cleaners: [],
    WS_Enquiries: [],
    ...overrides
  };
}

function start(overrides) {
  const ctx = { airtable: new MockAirtable(baseSeed(overrides)), sends: [], axiom: [] };
  installFetch(ctx);
  return ctx;
}

async function send(from, text) {
  const res = makeRes();
  await wh({ method: 'POST', body: metaTextPayload(from, text) }, res);
  return res;
}

const bookingRow = (ctx, id) => ctx.airtable.tables['WS_Bookings'].find(b => b.id === id).fields;
const guestRow = (ctx, phone) => ctx.airtable.tables['WS_Guests'].find(g => g.fields['Phone Number'] === phone);
const roomRow = (ctx, id) => ctx.airtable.tables['WS_Rooms'].find(r => r.id === id).fields;
const texts = (ctx, to) => ctx.sends.filter(s => s.to === to).map(s => s.body || '').join('\n---\n');
const axiomEvents = ctx => ctx.axiom.map(e => e.event);

// One-shot: makes ONE matching write return an Airtable error body, then
// restores. Matches money-path-checks.test.js's helper.
function failNextWrite(ctx, { method, pathIncludes, bodyIncludes } = {}) {
  const originalFetch = global.fetch;
  global.fetch = async (url, opts = {}) => {
    const u = new URL(url);
    const methodMatches = (opts.method || 'GET').toUpperCase() === method;
    const pathMatches = !pathIncludes || u.pathname.includes(pathIncludes);
    const bodyMatches = !bodyIncludes || String(opts.body || '').includes(bodyIncludes);
    if (methodMatches && pathMatches && bodyMatches) {
      global.fetch = originalFetch; // one-shot
      return { status: 422, ok: false, json: async () => ({ error: { type: 'INVALID_REQUEST', message: 'simulated' } }), text: async () => 'simulated' };
    }
    return originalFetch(url, opts);
  };
}

// ── selectOccupancy (FATAL: Rate Applied / Amount Due) ──────────────────────

function seedAwaitingOccupancy(fields = {}) {
  return baseSeed({
    WS_Guests: [{ id: 'recG1', fields: { 'Guest Name': 'Jane Doe', 'Phone Number': GUEST_PHONE, 'Session State': 'AWAITING_OCCUPANCY' } }],
    WS_Bookings: [{
      id: 'recBook1',
      fields: {
        'Guest': ['recG1'], 'Booking Type': 'Overnight', 'Status': 'Enquiry',
        'Notes': 'Check-in: 1 September 2026 | Check-out: 2 September 2026',
        'Check In': '2026-09-01T12:00:00.000Z', 'Check Out': '2026-09-02T08:00:00.000Z',
        ...fields
      }
    }]
  });
}

test('selectOccupancy: a failed rate write tells the guest plainly and does not advance state', async () => {
  const ctx = start(seedAwaitingOccupancy());
  failNextWrite(ctx, { method: 'PATCH', pathIncludes: 'WS_Bookings/recBook1', bodyIncludes: 'Amount Due' });

  await send(GUEST_PHONE, '2'); // "Two of us" -> Couple

  assert.strictEqual(bookingRow(ctx, 'recBook1')['Amount Due'], undefined, 'no price written on a failed PATCH');
  assert.strictEqual(guestRow(ctx, GUEST_PHONE).fields['Session State'], 'AWAITING_OCCUPANCY', 'not advanced to AWAITING_ETA with no rate behind it');
  assert.match(texts(ctx, GUEST_PHONE), /went wrong/i);
  assert.doesNotMatch(texts(ctx, GUEST_PHONE), /booking enquiry has been received/i);
  assert.ok(axiomEvents(ctx).includes('occupancy_rate_write_failed'));
});

test('selectOccupancy: a successful rate write is unaffected by the new check', async () => {
  const ctx = start(seedAwaitingOccupancy());

  await send(GUEST_PHONE, '2');

  assert.strictEqual(bookingRow(ctx, 'recBook1')['Amount Due'], 400);
  assert.strictEqual(guestRow(ctx, GUEST_PHONE).fields['Session State'], 'AWAITING_ETA');
  assert.match(texts(ctx, GUEST_PHONE), /booking enquiry has been received/i);
});

// ── selectHourlyDuration (FATAL: core confirm write; NON-FATAL: >3hr cancel) ─

function seedPendingHourly(overrides = {}) {
  return baseSeed({
    WS_Guests: [{ id: 'recG1', fields: { 'Guest Name': 'Jane Doe', 'Phone Number': GUEST_PHONE, 'Session State': 'AWAITING_HOURLY_DURATION' } }],
    WS_Bookings: [{
      id: 'recPending', fields: {
        'Guest': ['recG1'], 'Booking Type': 'Hourly', 'Status': 'Enquiry',
        'Check In': '2026-09-01T12:00:00.000Z', 'Payment Status': 'Unpaid'
      }
    }],
    ...overrides
  });
}

test('selectHourlyDuration: a failed confirm write tells the guest plainly and does not sell the room', async () => {
  const ctx = { airtable: new MockAirtable(seedPendingHourly()), sends: [], axiom: [] };
  installFetch(ctx);
  failNextWrite(ctx, { method: 'PATCH', pathIncludes: 'WS_Bookings/recPending', bodyIncludes: 'Confirmed' });

  await send(GUEST_PHONE, '1');

  assert.strictEqual(bookingRow(ctx, 'recPending')['Status'], 'Enquiry', 'never confirmed');
  assert.strictEqual(roomRow(ctx, 'recR1')['Status'], 'Available', 'room never sold');
  assert.match(texts(ctx, GUEST_PHONE), /went wrong/i);
  assert.ok(axiomEvents(ctx).includes('hourly_confirm_write_failed'));
});

test('selectHourlyDuration: a successful confirm write is unaffected by the new check', async () => {
  const ctx = { airtable: new MockAirtable(seedPendingHourly()), sends: [], axiom: [] };
  installFetch(ctx);

  await send(GUEST_PHONE, '1');

  assert.strictEqual(bookingRow(ctx, 'recPending')['Status'], 'Confirmed');
  assert.strictEqual(bookingRow(ctx, 'recPending')['Amount Due'], 120);
});

test('selectHourlyDuration: a failed >3hr redirect cancel is logged loud but the redirect still happens', async () => {
  const ctx = { airtable: new MockAirtable(seedPendingHourly()), sends: [], axiom: [] };
  installFetch(ctx);
  failNextWrite(ctx, { method: 'PATCH', pathIncludes: 'WS_Bookings/recPending', bodyIncludes: 'Cancelled' });

  await send(GUEST_PHONE, '5'); // >3hr

  assert.strictEqual(guestRow(ctx, GUEST_PHONE).fields['Session State'], 'AWAITING_DETAILS', 'redirect proceeds regardless');
  assert.ok(axiomEvents(ctx).includes('hourly_redirect_cancel_failed'));
  assert.match(texts(ctx, GUEST_PHONE), /overnight instead/i);
});

// ── recordEta (FATAL: ETA + Status: Confirmed) ───────────────────────────────

function seedAwaitingEta(fields = {}) {
  return baseSeed({
    WS_Guests: [{ id: 'recG1', fields: { 'Guest Name': 'Jane Doe', 'Phone Number': GUEST_PHONE, 'Session State': 'AWAITING_ETA' } }],
    WS_Bookings: [{ id: 'recBook1', fields: { 'Guest': ['recG1'], 'Status': 'Enquiry', ...fields } }]
  });
}

test('recordEta: a failed confirm write tells the guest plainly and does not advance state', async () => {
  const ctx = start(seedAwaitingEta());
  failNextWrite(ctx, { method: 'PATCH', pathIncludes: 'WS_Bookings/recBook1', bodyIncludes: 'Confirmed' });

  await send(GUEST_PHONE, 'around 2pm');

  assert.strictEqual(bookingRow(ctx, 'recBook1')['Status'], 'Enquiry', 'never confirmed');
  assert.strictEqual(guestRow(ctx, GUEST_PHONE).fields['Session State'], 'AWAITING_ETA', 'not advanced');
  assert.match(texts(ctx, GUEST_PHONE), /went wrong/i);
  assert.ok(axiomEvents(ctx).includes('eta_confirm_write_failed'));
});

test('recordEta: a successful confirm write is unaffected by the new check', async () => {
  const ctx = start(seedAwaitingEta());

  await send(GUEST_PHONE, 'around 2pm');

  assert.strictEqual(bookingRow(ctx, 'recBook1')['Status'], 'Confirmed');
  assert.strictEqual(guestRow(ctx, GUEST_PHONE).fields['Session State'], 'CONFIRMED');
});

// ── gateArrival (FATAL: booking->Checked In; NON-FATAL: room->Occupied) ─────

function seedConfirmed(overrides = {}) {
  return baseSeed({
    WS_Guests: [{ id: 'recG1', fields: { 'Guest Name': 'Jane Doe', 'Phone Number': GUEST_PHONE, 'Session State': 'CONFIRMED' } }],
    WS_Bookings: [{
      id: 'recBook1',
      fields: {
        'Guest': ['recG1'], 'Status': 'Confirmed', 'Room': ['recR1'],
        'Check In': '2020-01-01T12:00:00.000Z', 'Check Out': '2099-01-01T08:00:00.000Z'
      }
    }],
    ...overrides
  });
}

test('gateArrival: a failed check-in write tells the guest plainly and skips owner notify / cleaner dispatch / welcome', async () => {
  const ctx = start(seedConfirmed());
  failNextWrite(ctx, { method: 'PATCH', pathIncludes: 'WS_Bookings/recBook1', bodyIncludes: 'Checked In' });

  await send(GUEST_PHONE, '1');

  assert.strictEqual(bookingRow(ctx, 'recBook1')['Status'], 'Confirmed', 'never checked in');
  assert.strictEqual(guestRow(ctx, GUEST_PHONE).fields['Session State'], 'CONFIRMED', 'not advanced');
  assert.strictEqual(ctx.sends.length, 1, 'only the guest is told, nobody else');
  assert.match(texts(ctx, GUEST_PHONE), /went wrong/i);
  assert.ok(axiomEvents(ctx).includes('gate_arrival_checkin_write_failed'));
});

test('gateArrival: a failed room-status write is logged loud but check-in still completes', async () => {
  const ctx = start(seedConfirmed());
  failNextWrite(ctx, { method: 'PATCH', pathIncludes: 'WS_Rooms/recR1', bodyIncludes: 'Occupied' });

  await send(GUEST_PHONE, '1');

  assert.strictEqual(bookingRow(ctx, 'recBook1')['Status'], 'Checked In', 'check-in still completes');
  assert.ok(axiomEvents(ctx).includes('gate_arrival_room_status_write_failed'));
  assert.match(texts(ctx, GUEST_PHONE), /Welcome to/i, 'guest is still welcomed');
});

test('gateArrival: a successful arrival is unaffected by the new checks', async () => {
  const ctx = start(seedConfirmed());

  await send(GUEST_PHONE, '1');

  assert.strictEqual(bookingRow(ctx, 'recBook1')['Status'], 'Checked In');
  assert.strictEqual(roomRow(ctx, 'recR1')['Status'], 'Occupied');
  assert.strictEqual(guestRow(ctx, GUEST_PHONE).fields['Session State'], 'CHECKED_IN');
});

// ── cancelBooking (FATAL) ─────────────────────────────────────────────────

test('cancelBooking: a failed cancel write tells the guest plainly and does not advance state', async () => {
  const ctx = start(seedConfirmed());
  failNextWrite(ctx, { method: 'PATCH', pathIncludes: 'WS_Bookings/recBook1', bodyIncludes: 'Cancelled' });

  await send(GUEST_PHONE, '2');

  assert.strictEqual(bookingRow(ctx, 'recBook1')['Status'], 'Confirmed', 'still holds the room, not silently cancelled');
  assert.strictEqual(guestRow(ctx, GUEST_PHONE).fields['Session State'], 'CONFIRMED', 'not advanced');
  assert.match(texts(ctx, GUEST_PHONE), /went wrong/i);
  assert.doesNotMatch(texts(ctx, GUEST_PHONE), /has been cancelled/i);
  assert.ok(axiomEvents(ctx).includes('cancel_booking_write_failed'));
});

test('cancelBooking: a successful cancel is unaffected by the new check', async () => {
  const ctx = start(seedConfirmed());

  await send(GUEST_PHONE, '2');

  assert.strictEqual(bookingRow(ctx, 'recBook1')['Status'], 'Cancelled');
  assert.strictEqual(guestRow(ctx, GUEST_PHONE).fields['Session State'], 'NEW');
  assert.match(texts(ctx, GUEST_PHONE), /has been cancelled/i);
});

// ── checkout (FATAL: booking write; NON-FATAL: room->Cleaning) ──────────────

function seedCheckedIn(overrides = {}) {
  return baseSeed({
    WS_Guests: [{ id: 'recG1', fields: { 'Guest Name': 'Jane Doe', 'Phone Number': GUEST_PHONE, 'Session State': 'CHECKED_IN' } }],
    WS_Bookings: [{
      id: 'recBook1',
      fields: {
        'Guest': ['recG1'], 'Status': 'Checked In', 'Room': ['recR1'],
        'Amount Due': 400, 'Checked In At': '2020-01-01T00:00:00.000Z'
      }
    }],
    WS_Rooms: [{ id: 'recR1', fields: { 'Room Name': 'Room 01', 'Room Number': 1, 'Status': 'Occupied', 'Property': ['recP1'] } }],
    ...overrides
  });
}

test('checkout: a failed checkout write tells the guest plainly and skips cleaner dispatch / reception notify', async () => {
  const ctx = start(seedCheckedIn());
  failNextWrite(ctx, { method: 'PATCH', pathIncludes: 'WS_Bookings/recBook1', bodyIncludes: 'Checked Out' });

  await send(GUEST_PHONE, 'checkout');

  assert.strictEqual(bookingRow(ctx, 'recBook1')['Status'], 'Checked In', 'never checked out');
  assert.strictEqual(roomRow(ctx, 'recR1')['Status'], 'Occupied', 'room never flipped to Cleaning');
  assert.strictEqual(guestRow(ctx, GUEST_PHONE).fields['Session State'], 'CHECKED_IN', 'not advanced');
  assert.match(texts(ctx, GUEST_PHONE), /went wrong/i);
  assert.doesNotMatch(texts(ctx, GUEST_PHONE), /Thank you for staying/i);
  assert.ok(axiomEvents(ctx).includes('checkout_write_failed'));
});

test('checkout: a failed room-status write is logged loud but checkout still completes', async () => {
  const ctx = start(seedCheckedIn());
  failNextWrite(ctx, { method: 'PATCH', pathIncludes: 'WS_Rooms/recR1', bodyIncludes: 'Cleaning' });

  await send(GUEST_PHONE, 'checkout');

  assert.strictEqual(bookingRow(ctx, 'recBook1')['Status'], 'Checked Out', 'checkout still completes');
  assert.ok(axiomEvents(ctx).includes('checkout_room_status_write_failed'));
  assert.match(texts(ctx, GUEST_PHONE), /Thank you for staying/i, 'guest is still thanked');
});

test('checkout: a successful checkout is unaffected by the new checks', async () => {
  const ctx = start(seedCheckedIn());

  await send(GUEST_PHONE, 'checkout');

  assert.strictEqual(bookingRow(ctx, 'recBook1')['Status'], 'Checked Out');
  assert.strictEqual(roomRow(ctx, 'recR1')['Status'], 'Cleaning');
  assert.strictEqual(guestRow(ctx, GUEST_PHONE).fields['Session State'], 'NEW');
});

// ── extendStay (FATAL) ───────────────────────────────────────────────────

function seedExtendable(overrides = {}) {
  return baseSeed({
    WS_Guests: [{ id: 'recG1', fields: { 'Guest Name': 'Jane Doe', 'Phone Number': GUEST_PHONE, 'Session State': 'CHECKED_IN' } }],
    WS_Bookings: [{
      id: 'recBook1',
      fields: {
        'Guest': ['recG1'], 'Room': ['recR1'], 'Status': 'Checked In',
        'Booking Type': 'Overnight', 'Amount Due': 400, 'Rate Applied': ['recRateCouple'],
        'Check In': '2026-08-05T12:00:00.000Z', 'Check Out': '2026-08-06T08:00:00.000Z',
        'Checked In At': '2026-08-05T12:05:00.000Z'
      }
    }],
    ...overrides
  });
}

test('extendStay: a failed extend write tells the guest plainly and charges nothing', async () => {
  const ctx = start(seedExtendable());
  failNextWrite(ctx, { method: 'PATCH', pathIncludes: 'WS_Bookings/recBook1', bodyIncludes: 'Check Out' });

  await send(GUEST_PHONE, 'extend');

  assert.strictEqual(bookingRow(ctx, 'recBook1')['Amount Due'], 400, 'not charged');
  assert.strictEqual(bookingRow(ctx, 'recBook1')['Check Out'], '2026-08-06T08:00:00.000Z', 'not extended');
  assert.match(texts(ctx, GUEST_PHONE), /went wrong/i);
  assert.doesNotMatch(texts(ctx, GUEST_PHONE), /extended your stay/i);
  assert.ok(axiomEvents(ctx).includes('extend_write_failed'));
});

test('extendStay: a successful extend is unaffected by the new check', async () => {
  const ctx = start(seedExtendable());

  await send(GUEST_PHONE, 'extend');

  assert.strictEqual(bookingRow(ctx, 'recBook1')['Amount Due'], 800);
  assert.match(texts(ctx, GUEST_PHONE), /extended your stay/i);
});

// ── settleAutoCheckout (FATAL: booking write; NON-FATAL: room->Cleaning) ────
// Cron path — driven directly, same approach as test/autocheckout.test.js.

const NOW = new Date('2026-07-22T12:00:00.000Z');
const minsBefore = m => new Date(NOW.getTime() - m * 60 * 1000).toISOString();

function seedAutoCheckoutDue(overrides = {}) {
  return {
    WS_Properties: [{ id: 'recP1', fields: { 'Property Name': 'Test Lodge' } }],
    WS_Guests: [{ id: 'recG1', fields: { 'Guest Name': 'Jane Doe', 'Phone Number': GUEST_PHONE } }],
    WS_Rooms: [{ id: 'recR1', fields: { 'Room Name': 'Room 01', 'Status': 'Occupied', 'Property': ['recP1'] } }],
    WS_Bookings: [{
      id: 'recBook1',
      fields: {
        'Guest': ['recG1'], 'Status': 'Checked In', 'Booking Type': 'Overnight', 'Room': ['recR1'],
        'Check Out': minsBefore(20), 'Checkout Warning Sent At': minsBefore(16), 'Amount Due': 400
      }
    }],
    WS_Cleaners: [],
    WS_Rates: [],
    WS_Enquiries: [],
    ...overrides
  };
}

test('settleAutoCheckout: a failed checkout write is logged loud and the cron leaves the booking Checked In to retry next tick', async () => {
  const ctx = { airtable: new MockAirtable(seedAutoCheckoutDue()), sends: [], axiom: [] };
  installFetch(ctx);
  failNextWrite(ctx, { method: 'PATCH', pathIncludes: 'WS_Bookings/recBook1', bodyIncludes: 'Checked Out' });

  await wh.runAutoCheckout(NOW);

  assert.strictEqual(bookingRow(ctx, 'recBook1')['Status'], 'Checked In', 'left for the next tick to retry, not silently marked Checked Out');
  assert.strictEqual(ctx.sends.length, 0, 'no cleaner dispatch, no guest thanks, no reception notify for a checkout that never landed');
  assert.ok(axiomEvents(ctx).includes('auto_checkout_write_failed'));
});

test('settleAutoCheckout: a failed room-status write is logged loud but checkout still completes', async () => {
  const ctx = { airtable: new MockAirtable(seedAutoCheckoutDue()), sends: [], axiom: [] };
  installFetch(ctx);
  failNextWrite(ctx, { method: 'PATCH', pathIncludes: 'WS_Rooms/recR1', bodyIncludes: 'Cleaning' });

  await wh.runAutoCheckout(NOW);

  assert.strictEqual(bookingRow(ctx, 'recBook1')['Status'], 'Checked Out', 'checkout still completes');
  assert.ok(axiomEvents(ctx).includes('auto_checkout_room_status_write_failed'));
});

test('settleAutoCheckout: a successful auto-checkout is unaffected by the new checks', async () => {
  const ctx = { airtable: new MockAirtable(seedAutoCheckoutDue()), sends: [], axiom: [] };
  installFetch(ctx);

  const summary = await wh.runAutoCheckout(NOW);

  assert.deepStrictEqual(summary, { warnings: 0, autoCheckouts: 1 });
  assert.strictEqual(bookingRow(ctx, 'recBook1')['Status'], 'Checked Out');
  assert.strictEqual(roomRow(ctx, 'recR1')['Status'], 'Cleaning');
});

// ── resolveRoomClean / cleanerDone (NON-FATAL) ───────────────────────────────

test('cleanerDone: a failed room->Available write is logged loud but the cleaner is still thanked', async () => {
  const ctx = start({
    WS_Rooms: [{ id: 'recR1', fields: { 'Room Name': 'Room 01', 'Room Number': 1, 'Status': 'Cleaning', 'Property': ['recP1'] } }],
    WS_Cleaners: [{ id: 'recC1', fields: { 'Cleaner Name': 'Thandi', 'Phone Number': '27821110000', 'Active': true, 'Assigned Property': ['recP1'] } }]
  });
  failNextWrite(ctx, { method: 'PATCH', pathIncludes: 'WS_Rooms/recR1', bodyIncludes: 'Available' });

  await send('27821110000', 'done');

  assert.strictEqual(roomRow(ctx, 'recR1')['Status'], 'Cleaning', 'the write genuinely failed');
  assert.ok(axiomEvents(ctx).includes('cleaner_done_room_status_write_failed'));
  assert.match(texts(ctx, '27821110000'), /clean/i, 'the cleaner is still thanked — non-fatal');
});

test('cleanerDone: a successful room->Available write is unaffected by the new check', async () => {
  const ctx = start({
    WS_Rooms: [{ id: 'recR1', fields: { 'Room Name': 'Room 01', 'Room Number': 1, 'Status': 'Cleaning', 'Property': ['recP1'] } }],
    WS_Cleaners: [{ id: 'recC1', fields: { 'Cleaner Name': 'Thandi', 'Phone Number': '27821110000', 'Active': true, 'Assigned Property': ['recP1'] } }]
  });

  await send('27821110000', 'done');

  assert.strictEqual(roomRow(ctx, 'recR1')['Status'], 'Available');
});

// ── collectDetails's Booking Ref writeback (NON-FATAL) ───────────────────────

test('collectDetails: a failed Booking Ref writeback is logged loud but the booking still confirms', async () => {
  const ctx = start({
    WS_Guests: [{ id: 'recG1', fields: { 'Guest Name': 'Unknown', 'Phone Number': GUEST_PHONE, 'Session State': 'AWAITING_DETAILS' } }]
  });
  failNextWrite(ctx, { method: 'PATCH', pathIncludes: 'WS_Bookings', bodyIncludes: 'Booking Ref' });

  await send(GUEST_PHONE, 'Jane Doe\n1 September 2026\n2 September 2026');

  const booking = ctx.airtable.tables['WS_Bookings'].find(b => b.fields['Guest'] && b.fields['Guest'].includes('recG1'));
  assert.ok(booking, 'booking still exists');
  assert.strictEqual(booking.fields['Status'], 'Enquiry');
  assert.ok(axiomEvents(ctx).includes('collectdetails_bookingref_writeback_failed'));
  assert.match(texts(ctx, GUEST_PHONE), /occupancy|How many of you/i, 'flow proceeds normally to the occupancy question');
});
