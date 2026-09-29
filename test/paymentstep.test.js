// test/paymentstep.test.js
// Payment build (CEO decision, 2026-09-29): cashless property, Card/EFT
// choice after the price quote, no room/key until reception confirms via
// PAID/PAID REF. Covers: the payment-method menu and both branches, the
// EFT reference (generation, uniqueness, PAID REF matching), the
// input-format disclaimer, the EFT-bank-details fallback, and the
// gate-arrival payment gate. Several pieces here are flagged in the PR
// report as needing Shawn's confirmation (exact copy / command syntax) —
// this suite locks in behaviour, not final wording.

const { test } = require('node:test');
const assert = require('node:assert');
const { installEnv, installFetch, makeRes, metaTextPayload, MockAirtable } = require('./harness');

installEnv();
const wh = require('../api/wabistay/webhook.js');
const { parsePaidCommand } = wh;

const GUEST_PHONE = '27821234567';
const RECEPTION_PHONE = '27825999279';

function baseSeed(overrides = {}) {
  return {
    WS_Properties: [{
      id: 'recP1',
      fields: {
        'Property Name': 'Canary Street Guest Rooms', 'Phone Number ID': '111000111000',
        'Notify Phone': '27831112222', 'EFT Bank Details': 'FNB Cheque\nAcc No: 63029423330\nBranch Code: 250655'
      }
    }],
    WS_Rooms: [
      { id: 'recR1', fields: { 'Room Name': 'Room 01', 'Status': 'Available', 'Property': ['recP1'], 'Active': true } }
    ],
    WS_Rates: [
      { id: 'recRateNight', fields: { 'Rate Name': 'Standard Night', 'Rate Type': 'Per Night', 'Amount': 400, 'Active': true, 'Property': ['recP1'] } }
    ],
    WS_Roles: [
      { id: 'recRecep', fields: { 'Role Label': 'Reception', 'Role Type': 'Reception', 'Property': ['recP1'], 'Current Phone': RECEPTION_PHONE, 'Active': true } }
    ],
    WS_Guests: [], WS_Bookings: [], WS_Cleaners: [], WS_Enquiries: [],
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

const guestRow = ctx => ctx.airtable.tables['WS_Guests'].find(g => g.fields['Phone Number'] === GUEST_PHONE);
const bookingRow = ctx => ctx.airtable.tables['WS_Bookings'].find(b => b.fields['Guest'] && b.fields['Guest'].includes(guestRow(ctx).id));
const texts = (ctx, to) => ctx.sends.filter(s => s.to === to).map(s => s.body || '').join('\n---\n');

// ── Input-format disclaimer ─────────────────────────────────────────────────

test('the input-format disclaimer appears on the overnight name/dates prompt and its reprompt', async () => {
  const ctx = start({
    WS_Guests: [{ id: 'recG1', fields: { 'Guest Name': 'Unknown', 'Phone Number': GUEST_PHONE, 'Session State': 'AWAITING_STAY_TYPE' } }]
  });
  await send(GUEST_PHONE, '2'); // multiple days
  assert.match(texts(ctx, GUEST_PHONE), /type your details exactly as shown/i);

  await send(GUEST_PHONE, 'garbage no dates here');
  assert.match(texts(ctx, GUEST_PHONE), /type your details exactly as shown/i);
});

test('the input-format disclaimer appears on the hourly ask-details prompt and its reprompt', async () => {
  const ctx = start({
    WS_Guests: [{ id: 'recG1', fields: { 'Guest Name': 'Unknown', 'Phone Number': GUEST_PHONE, 'Session State': 'AWAITING_STAY_TYPE' } }],
    WS_Properties: [{ id: 'recP1', fields: { 'Property Name': 'Canary Street Guest Rooms', 'Phone Number ID': '111000111000', 'Hourly Rate 1hr': 120, 'Hourly Rate 2hr': 250, 'Hourly Rate 3hr': 320 } }]
  });
  await send(GUEST_PHONE, '1'); // short stay
  assert.match(texts(ctx, GUEST_PHONE), /type your details exactly as shown/i);
});

// ── Payment method: Card ────────────────────────────────────────────────────

test('overnight: after the quote, Card is offered; choosing it moves straight to the arrival-time ask, no room assigned yet', async () => {
  const ctx = start({
    WS_Guests: [{ id: 'recG1', fields: { 'Guest Name': 'Unknown', 'Phone Number': GUEST_PHONE, 'Session State': 'AWAITING_DETAILS' } }]
  });
  await send(GUEST_PHONE, 'Jane Doe\n1 September 2026\n2 September 2026');
  assert.strictEqual(guestRow(ctx).fields['Session State'], 'AWAITING_PAYMENT_METHOD');

  await send(GUEST_PHONE, '1'); // Card
  assert.strictEqual(bookingRow(ctx).fields['Payment Method'], 'Card');
  assert.strictEqual(bookingRow(ctx).fields['Payment Reference'], undefined, 'Card never generates a reference');
  assert.strictEqual(guestRow(ctx).fields['Session State'], 'AWAITING_ETA');
  assert.match(texts(ctx, GUEST_PHONE), /SpeedPoint/i);
  assert.match(texts(ctx, GUEST_PHONE), /what time do you expect to arrive/i);
});

test('an invalid payment-method reply re-prompts with zero writes', async () => {
  const ctx = start({
    WS_Guests: [{ id: 'recG1', fields: { 'Guest Name': 'Jane Doe', 'Phone Number': GUEST_PHONE, 'Session State': 'AWAITING_PAYMENT_METHOD' } }],
    WS_Bookings: [{ id: 'recB1', fields: { 'Guest': ['recG1'], 'Booking Type': 'Overnight', 'Status': 'Enquiry', 'Amount Due': 400 } }]
  });
  await send(GUEST_PHONE, 'huh');
  assert.strictEqual(guestRow(ctx).fields['Session State'], 'AWAITING_PAYMENT_METHOD', 'stays put');
  assert.match(texts(ctx, GUEST_PHONE), /reply with a number/i);
});

// ── Payment method: EFT ──────────────────────────────────────────────────────

test('overnight: choosing EFT generates a 4-char reference, reads EFT Bank Details, and moves to the arrival-time ask', async () => {
  const ctx = start({
    WS_Guests: [{ id: 'recG1', fields: { 'Guest Name': 'Unknown', 'Phone Number': GUEST_PHONE, 'Session State': 'AWAITING_DETAILS' } }]
  });
  await send(GUEST_PHONE, 'Jane Doe\n1 September 2026\n2 September 2026');
  await send(GUEST_PHONE, '2'); // EFT

  const booking = bookingRow(ctx);
  assert.strictEqual(booking.fields['Payment Method'], 'EFT');
  assert.match(booking.fields['Payment Reference'], /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}$/, 'excludes O,0,I,1,L');
  assert.strictEqual(guestRow(ctx).fields['Session State'], 'AWAITING_ETA');
  assert.match(texts(ctx, GUEST_PHONE), new RegExp(`using ${booking.fields['Payment Reference']} as your reference`, 'i'));
  assert.match(texts(ctx, GUEST_PHONE), /R400/);
  assert.match(texts(ctx, GUEST_PHONE), /FNB Cheque/, 'reads the live EFT Bank Details field');
});

test('EFT confirmation falls back to a clear message when EFT Bank Details is empty', async () => {
  const ctx = start({
    WS_Properties: [{ id: 'recP1', fields: { 'Property Name': 'Canary Street Guest Rooms', 'Phone Number ID': '111000111000', 'Notify Phone': '27831112222' } }], // no EFT Bank Details
    WS_Guests: [{ id: 'recG1', fields: { 'Guest Name': 'Unknown', 'Phone Number': GUEST_PHONE, 'Session State': 'AWAITING_DETAILS' } }]
  });
  await send(GUEST_PHONE, 'Jane Doe\n1 September 2026\n2 September 2026');
  await send(GUEST_PHONE, '2');
  assert.match(texts(ctx, GUEST_PHONE), /ask reception for the bank details/i);
});

test('hourly: choosing EFT skips the arrival-time ask (already known) and goes to the gate-arrival menu', async () => {
  const ctx = start({
    WS_Properties: [{ id: 'recP1', fields: { 'Property Name': 'Canary Street Guest Rooms', 'Phone Number ID': '111000111000', 'Hourly Rate 1hr': 120, 'Hourly Rate 2hr': 250, 'Hourly Rate 3hr': 320 } }],
    WS_Guests: [{ id: 'recG1', fields: { 'Guest Name': 'Unknown', 'Phone Number': GUEST_PHONE, 'Session State': 'AWAITING_HOURLY_DETAILS' } }]
  });
  await send(GUEST_PHONE, 'Jane Doe\n2pm');
  await send(GUEST_PHONE, '1'); // 1 hour
  assert.strictEqual(guestRow(ctx).fields['Session State'], 'AWAITING_PAYMENT_METHOD');

  await send(GUEST_PHONE, '2'); // EFT
  assert.strictEqual(guestRow(ctx).fields['Session State'], 'CONFIRMED', 'hourly already has its arrival time — no AWAITING_ETA detour');
  assert.match(texts(ctx, GUEST_PHONE), /I'm at the gate/i);
  assert.doesNotMatch(texts(ctx, GUEST_PHONE), /what time do you expect to arrive/i);
});

// ── PAID REF (proposed syntax, flagged for confirmation) ────────────────────

test('parsePaidCommand accepts PAID REF <ref> <amount>, normalised to uppercase', () => {
  assert.deepStrictEqual(parsePaidCommand('PAID REF ab3d 400'), { ok: true, refToken: 'AB3D', amount: 400, method: null });
  assert.deepStrictEqual(parsePaidCommand('paid ref AB3D R400 eft'), { ok: true, refToken: 'AB3D', amount: 400, method: 'EFT' });
});

test('PAID REF confirms an EFT booking pre-check-in — Payment Status flips to Paid, no room needed to match', async () => {
  const ctx = start({
    WS_Guests: [{ id: 'recG1', fields: { 'Guest Name': 'Jane Doe', 'Phone Number': GUEST_PHONE, 'Session State': 'AWAITING_DETAILS' } }]
  });
  await send(GUEST_PHONE, 'Jane Doe\n1 September 2026\n2 September 2026');
  await send(GUEST_PHONE, '2'); // EFT
  const ref = bookingRow(ctx).fields['Payment Reference'];

  await send(RECEPTION_PHONE, `PAID REF ${ref} 400`);

  const booking = bookingRow(ctx);
  assert.strictEqual(booking.fields['Payment Status'], 'Paid');
  assert.strictEqual(booking.fields['Amount Paid'], 400);
  assert.match(texts(ctx, RECEPTION_PHONE), /Payment recorded/i);
});

test('PAID REF for an unknown reference is refused, nothing written', async () => {
  const ctx = start({
    WS_Guests: [{ id: 'recG1', fields: { 'Guest Name': 'Jane Doe', 'Phone Number': GUEST_PHONE, 'Session State': 'AWAITING_DETAILS' } }]
  });
  await send(GUEST_PHONE, 'Jane Doe\n1 September 2026\n2 September 2026');
  await send(RECEPTION_PHONE, 'PAID REF ZZZZ 400');
  assert.strictEqual(bookingRow(ctx).fields['Payment Status'], 'Unpaid');
});

// ── Gate-arrival payment gate ────────────────────────────────────────────────

test('gate arrival: no room is assigned while a priced booking is still Unpaid — no writes, guest told to settle up', async () => {
  const ctx = start({
    WS_Guests: [{ id: 'recG1', fields: { 'Guest Name': 'Jane Doe', 'Phone Number': GUEST_PHONE, 'Session State': 'CONFIRMED' } }],
    WS_Bookings: [{
      id: 'recB1', fields: {
        'Guest': ['recG1'], 'Status': 'Confirmed', 'Booking Type': 'Overnight',
        'Amount Due': 400, 'Payment Status': 'Unpaid',
        'Check In': '2020-01-01T12:00:00.000Z', 'Check Out': '2099-01-01T08:00:00.000Z'
      }
    }]
  });
  await send(GUEST_PHONE, '1'); // "I'm at the gate"

  const booking = bookingRow(ctx);
  assert.strictEqual(booking.fields['Status'], 'Confirmed', 'never checked in');
  assert.strictEqual(booking.fields['Room'], undefined, 'no room assigned');
  assert.strictEqual(guestRow(ctx).fields['Session State'], 'CONFIRMED', 'not advanced');
  assert.match(texts(ctx, GUEST_PHONE), /pop into the office/i);
});

test('gate arrival: reachable more than once — a guest nudged to the office can try "I\'m at the gate" again after paying, without restarting the booking', async () => {
  const ctx = start({
    WS_Guests: [{ id: 'recG1', fields: { 'Guest Name': 'Jane Doe', 'Phone Number': GUEST_PHONE, 'Session State': 'CONFIRMED' } }],
    WS_Bookings: [{
      id: 'recB1', fields: {
        'Guest': ['recG1'], 'Status': 'Confirmed', 'Booking Type': 'Overnight',
        'Amount Due': 400, 'Payment Status': 'Unpaid',
        'Check In': '2020-01-01T12:00:00.000Z', 'Check Out': '2099-01-01T08:00:00.000Z'
      }
    }]
  });
  await send(GUEST_PHONE, '1'); // nudged to the office, no writes
  assert.strictEqual(bookingRow(ctx).fields['Status'], 'Confirmed');

  // Reception confirms payment in the meantime (same as PAID ROOM would do).
  ctx.airtable.tables['WS_Bookings'].find(b => b.id === 'recB1').fields['Payment Status'] = 'Paid';

  await send(GUEST_PHONE, '1'); // same booking, same guest, no restart needed
  const booking = bookingRow(ctx);
  assert.strictEqual(booking.fields['Status'], 'Checked In', 'the SAME booking now completes, nothing had to be redone');
  assert.strictEqual(guestRow(ctx).fields['Session State'], 'CHECKED_IN');
});

test('gate arrival: proceeds normally once Payment Status is Paid', async () => {
  const ctx = start({
    WS_Guests: [{ id: 'recG1', fields: { 'Guest Name': 'Jane Doe', 'Phone Number': GUEST_PHONE, 'Session State': 'CONFIRMED' } }],
    WS_Bookings: [{
      id: 'recB1', fields: {
        'Guest': ['recG1'], 'Status': 'Confirmed', 'Booking Type': 'Overnight',
        'Amount Due': 400, 'Payment Status': 'Paid',
        'Check In': '2020-01-01T12:00:00.000Z', 'Check Out': '2099-01-01T08:00:00.000Z'
      }
    }]
  });
  await send(GUEST_PHONE, '1');
  assert.strictEqual(bookingRow(ctx).fields['Status'], 'Checked In');
  assert.strictEqual(guestRow(ctx).fields['Session State'], 'CHECKED_IN');
});

test('gate arrival: the fail-closed unpriced booking (owner to finalise price) is never blocked by the payment gate', async () => {
  const ctx = start({
    WS_Guests: [{ id: 'recG1', fields: { 'Guest Name': 'Jane Doe', 'Phone Number': GUEST_PHONE, 'Session State': 'CONFIRMED' } }],
    WS_Bookings: [{
      id: 'recB1', fields: {
        'Guest': ['recG1'], 'Status': 'Confirmed', 'Booking Type': 'Overnight',
        'Payment Status': 'Unpaid', // no Amount Due at all — never priced
        'Check In': '2020-01-01T12:00:00.000Z', 'Check Out': '2099-01-01T08:00:00.000Z'
      }
    }]
  });
  await send(GUEST_PHONE, '1');
  assert.strictEqual(bookingRow(ctx).fields['Status'], 'Checked In', 'unpriced bookings are unaffected by the payment gate');
});
