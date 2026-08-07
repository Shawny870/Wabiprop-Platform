// test/create-failure-recovery.test.js
// Fix-order item 4 — collectDetails silent stuck-loop on booking-create failure.
//
// Diagnosed shape (not assumed from the symptom): the create's return value
// was checked only to pick between rollback/booked-log sub-branches, never to
// guard whether the guest reply, owner notify, or Session State advance
// should happen at all. Session State was already written to AWAITING_OCCUPANCY
// BEFORE the create ran, so on outright create failure the guest was left
// there with no booking behind it — the next message hits selectOccupancy,
// finds nothing, and just re-prompts the same dead question forever with no
// path back to AWAITING_DETAILS. The owner also got a false "new booking"
// notification for a booking that doesn't exist.
//
// collectHourlyDetails had the identical unchecked-write pattern (its return
// value wasn't even assigned to a variable) — fixed here too, same shape.
// selectHourlyDuration already had a backstop for the missing-pending-row
// case, so hourly wasn't a hard stuck loop, but it was silent (no log) and
// made the guest wait a full round-trip to discover the failure.

const { test } = require('node:test');
const assert = require('node:assert');
const { installEnv, installFetch, makeRes, metaTextPayload, MockAirtable } = require('./harness');

installEnv();
const handler = require('../api/wabistay/webhook.js');

const GUEST_PHONE = '27821234567';

function seed(overrides = {}) {
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
      { id: 'recRateSingle', fields: { 'Rate Name': 'Single', 'Occupancy Type': 'Single', 'Amount': 250, 'Active': true, 'Property': ['recP1'] } }
    ],
    WS_Guests: [],
    WS_Bookings: [],
    WS_Cleaners: [],
    WS_Roles: [],
    WS_Enquiries: [],
    ...overrides
  };
}

function start(overrides) {
  const ctx = { airtable: new MockAirtable(seed(overrides)), sends: [], axiom: [] };
  installFetch(ctx);
  return ctx;
}

async function send(from, text) {
  const res = makeRes();
  await handler({ method: 'POST', body: metaTextPayload(from, text) }, res);
  return res;
}

const bookings = ctx => ctx.airtable.tables['WS_Bookings'] || [];
const guestRow = (ctx, phone) => ctx.airtable.tables['WS_Guests'].find(g => g.fields['Phone Number'] === phone);
const texts = (ctx, to) => ctx.sends.filter(s => s.to === to).map(s => s.body || '').join('\n---\n');
const axiomEvents = ctx => ctx.axiom.map(e => e.event);

// One-shot: makes ONE matching write (create or update) return an Airtable
// error body instead of delegating to the mock, then restores. Same shape as
// money-path-checks.test.js's helper.
function failNextWrite(ctx, { method, pathIncludes }) {
  const originalFetch = global.fetch;
  global.fetch = async (url, opts = {}) => {
    const u = new URL(url);
    if ((opts.method || 'GET').toUpperCase() === method && u.pathname.includes(pathIncludes)) {
      global.fetch = originalFetch; // one-shot
      return { status: 422, ok: false, json: async () => ({ error: { type: 'INVALID_REQUEST', message: 'simulated' } }), text: async () => 'simulated' };
    }
    return originalFetch(url, opts);
  };
}

// ── collectDetails (overnight) ──────────────────────────────────────────────

test('overnight: an outright create failure tells the guest plainly and resets them out of the dead state', async () => {
  const ctx = start({
    WS_Guests: [{ id: 'recGA', fields: { 'Guest Name': 'Unknown', 'Phone Number': GUEST_PHONE, 'Session State': 'AWAITING_DETAILS' } }]
  });
  failNextWrite(ctx, { method: 'POST', pathIncludes: 'WS_Bookings' });

  await send(GUEST_PHONE, 'Jane Doe\n1 September 2026\n2 September 2026');

  assert.strictEqual(guestRow(ctx, GUEST_PHONE).fields['Session State'], 'AWAITING_DETAILS', 'not left stuck in AWAITING_OCCUPANCY with nothing behind it');
  assert.match(texts(ctx, GUEST_PHONE), /went wrong|couldn't save/i, 'guest is told plainly, not left with a menu for a booking that does not exist');
  assert.doesNotMatch(texts(ctx, GUEST_PHONE), /How many of you|occupancy/i, 'the occupancy question never goes out for a phantom booking');
  assert.strictEqual(ctx.sends.filter(s => s.to === '27830000001').length, 0, 'owner is not falsely told a new booking arrived');
  assert.ok(axiomEvents(ctx).includes('booking_create'), 'the failure is logged, not silent');
});

test('overnight: after a failed create, an immediate retry with the same details succeeds normally', async () => {
  const ctx = start({
    WS_Guests: [{ id: 'recGA', fields: { 'Guest Name': 'Unknown', 'Phone Number': GUEST_PHONE, 'Session State': 'AWAITING_DETAILS' } }]
  });
  failNextWrite(ctx, { method: 'POST', pathIncludes: 'WS_Bookings' });
  await send(GUEST_PHONE, 'Jane Doe\n1 September 2026\n2 September 2026'); // fails

  await send(GUEST_PHONE, 'Jane Doe\n1 September 2026\n2 September 2026'); // retry, no injected failure this time

  const live = bookings(ctx).filter(b => b.fields['Status'] !== 'Cancelled');
  assert.strictEqual(live.length, 1, 'the retry actually creates a booking');
  assert.match(texts(ctx, GUEST_PHONE), /occupancy|How many of you/i, 'the retry proceeds to the normal next step');
});

test('overnight: a successful create is completely unaffected by the new check', async () => {
  const ctx = start({
    WS_Guests: [{ id: 'recGA', fields: { 'Guest Name': 'Unknown', 'Phone Number': GUEST_PHONE, 'Session State': 'AWAITING_DETAILS' } }]
  });

  await send(GUEST_PHONE, 'Jane Doe\n1 September 2026\n2 September 2026');

  assert.strictEqual(bookings(ctx).length, 1);
  assert.strictEqual(guestRow(ctx, GUEST_PHONE).fields['Session State'], 'AWAITING_OCCUPANCY');
  assert.strictEqual(ctx.sends.filter(s => s.to === '27830000001').length, 1, 'owner is notified normally on a real booking');
});

// ── collectHourlyDetails ─────────────────────────────────────────────────────

test('hourly: an outright create failure tells the guest plainly and resets them, instead of the silent later backstop', async () => {
  const ctx = start({
    WS_Guests: [{ id: 'recGA', fields: { 'Guest Name': 'Unknown', 'Phone Number': GUEST_PHONE, 'Session State': 'AWAITING_HOURLY_DETAILS' } }]
  });
  failNextWrite(ctx, { method: 'POST', pathIncludes: 'WS_Bookings' });

  await send(GUEST_PHONE, 'Jane Doe\n2pm');

  assert.strictEqual(guestRow(ctx, GUEST_PHONE).fields['Session State'], 'AWAITING_DETAILS', 'reset immediately, not left at AWAITING_HOURLY_DURATION with no pending row');
  assert.match(texts(ctx, GUEST_PHONE), /went wrong|couldn't save/i, 'told immediately, not left to discover it on the next message');
  assert.doesNotMatch(texts(ctx, GUEST_PHONE), /How long do you need/i, 'the duration menu never goes out for a phantom pending booking');
  assert.ok(axiomEvents(ctx).includes('hourly_booking_write_failed'), 'the failure is logged, not silently discarded');
});

test('hourly: after a failed create, an immediate retry succeeds normally', async () => {
  const ctx = start({
    WS_Guests: [{ id: 'recGA', fields: { 'Guest Name': 'Unknown', 'Phone Number': GUEST_PHONE, 'Session State': 'AWAITING_HOURLY_DETAILS' } }]
  });
  failNextWrite(ctx, { method: 'POST', pathIncludes: 'WS_Bookings' });
  await send(GUEST_PHONE, 'Jane Doe\n2pm'); // fails, resets to AWAITING_DETAILS

  await send(GUEST_PHONE, 'hourly'); // guest re-enters the hourly flow
  await send(GUEST_PHONE, 'Jane Doe\n2pm'); // retry, no injected failure this time

  assert.match(texts(ctx, GUEST_PHONE), /How long do you need/i, 'the retry proceeds to the duration menu');
});

test('hourly: a successful pending-row create is completely unaffected by the new check', async () => {
  const ctx = start({
    WS_Guests: [{ id: 'recGA', fields: { 'Guest Name': 'Unknown', 'Phone Number': GUEST_PHONE, 'Session State': 'AWAITING_HOURLY_DETAILS' } }]
  });

  await send(GUEST_PHONE, 'Jane Doe\n2pm');

  assert.strictEqual(bookings(ctx).length, 1);
  assert.strictEqual(guestRow(ctx, GUEST_PHONE).fields['Session State'], 'AWAITING_HOURLY_DURATION');
  assert.match(texts(ctx, GUEST_PHONE), /How long do you need/i);
  assert.strictEqual(axiomEvents(ctx).includes('hourly_booking_write_failed'), false);
});
