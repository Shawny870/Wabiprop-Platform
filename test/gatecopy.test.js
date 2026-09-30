// test/gatecopy.test.js
// Gate-arrival copy PR: reception's gateNotify alert now carries the room's
// status as it was AT ARRIVAL (before check-in flips it to Occupied), and
// welcomeAssigned no longer implies the room is ready. Also an end-to-end
// guest -> staff run (gate arrival, PAID, CHECKOUT ROOM in both orders).
// In-memory only: MockAirtable + mocked fetch, no live Airtable/WhatsApp.

const { test } = require('node:test');
const assert = require('node:assert');
const { installEnv, installFetch, makeRes, metaTextPayload, MockAirtable } = require('./harness');

installEnv();
const wh = require('../api/wabistay/webhook.js');

const GUEST_PHONE = '27821234567';
const STAFF_PHONE = '27825999279';
const NOTIFY_PHONE = '27831112222';

function seed({ roomStatus = 'Available' } = {}) {
  return {
    WS_Properties: [{
      id: 'recP1',
      fields: { 'Property Name': 'Canary Street Guest Rooms', 'Phone Number ID': '111000111000', 'Notify Phone': NOTIFY_PHONE }
    }],
    WS_Rooms: [{
      id: 'recR1',
      fields: { 'Room Name': 'Room 01', 'Room Number': 1, 'Status': roomStatus, 'Property': ['recP1'], 'Active': true }
    }],
    WS_Roles: [
      { id: 'recRecep', fields: { 'Role Label': 'Reception', 'Role Type': 'Reception', 'Property': ['recP1'], 'Current Phone': STAFF_PHONE, 'Active': true } }
    ],
    WS_Guests: [{ id: 'recG1', fields: { 'Guest Name': 'Jane Doe', 'Phone Number': GUEST_PHONE, 'Session State': 'CONFIRMED' } }],
    // No Amount Due: the unpriced path, which the payment gate lets through,
    // so PAID can be exercised after check-in in either order.
    WS_Bookings: [{
      id: 'recB1', fields: {
        'Guest': ['recG1'], 'Status': 'Confirmed', 'Booking Type': 'Overnight',
        'Check In': '2020-01-01T12:00:00.000Z', 'Check Out': '2099-01-01T08:00:00.000Z'
      }
    }],
    WS_Cleaners: [], WS_Enquiries: []
  };
}

function start(opts) {
  const ctx = { airtable: new MockAirtable(seed(opts)), sends: [], axiom: [] };
  installFetch(ctx);
  return ctx;
}

async function send(from, text) {
  const res = makeRes();
  await wh({ method: 'POST', body: metaTextPayload(from, text) }, res);
  return res;
}

const bookingRow = ctx => ctx.airtable.tables['WS_Bookings'].find(b => b.id === 'recB1');
const roomRow = ctx => ctx.airtable.tables['WS_Rooms'].find(r => r.id === 'recR1');
const textsTo = (ctx, to) => ctx.sends.filter(s => s.to === to).map(s => s.body || '');

// ── Alert copy ───────────────────────────────────────────────────────────────

test('gateNotify carries the room status as it was at arrival, in the agreed layout', async () => {
  const ctx = start({ roomStatus: 'Cleaning' });
  await send(GUEST_PHONE, '1');

  const alert = textsTo(ctx, NOTIFY_PHONE).find(t => t.includes('is at the gate'));
  assert.strictEqual(
    alert,
    `🔔 Jane Doe is at the gate. Room 01 assigned.\nRoom status right now: Cleaning\nPhone: ${GUEST_PHONE}`
  );
  assert.strictEqual(roomRow(ctx).fields['Status'], 'Occupied', 'check-in itself still marks the room Occupied');
});

test('an Available and an Occupied room are reported the same way — status is shown, never used to block', async () => {
  for (const status of ['Available', 'Occupied']) {
    const ctx = start({ roomStatus: status });
    await send(GUEST_PHONE, '1');
    assert.match(textsTo(ctx, NOTIFY_PHONE).join('\n'), new RegExp(`Room status right now: ${status}\\n`));
    assert.strictEqual(bookingRow(ctx).fields['Status'], 'Checked In', `${status} room: flow unchanged`);
  }
});

test('gateNotify with no room available says N/A for the status', async () => {
  const ctx = start();
  ctx.airtable.tables['WS_Rooms'].length = 0;
  await send(GUEST_PHONE, '1');
  const alert = textsTo(ctx, NOTIFY_PHONE).find(t => t.includes('is at the gate'));
  assert.strictEqual(
    alert,
    `🔔 Jane Doe is at the gate. No rooms available — please assign manually.\nRoom status right now: N/A\nPhone: ${GUEST_PHONE}`
  );
});

// ── Guest welcome ────────────────────────────────────────────────────────────

test('welcomeAssigned uses the agreed copy and no longer implies the room is ready', async () => {
  const ctx = start({ roomStatus: 'Cleaning' });
  await send(GUEST_PHONE, '1');

  const welcome = textsTo(ctx, GUEST_PHONE).find(t => t.startsWith('Welcome to'));
  assert.strictEqual(
    welcome,
    "Welcome to Canary Street Guest Rooms! 🌟 Your room is *Room 01*.\n\nSomeone is on their way to help you at the gate.\n\nWhen you're ready to leave, reply with a number:\n1 - Check out"
  );
  assert.doesNotMatch(welcome, /assigned|Enjoy your stay|open the gate/);
});

// ── End to end: gate arrival, PAID and CHECKOUT ROOM in both orders ──────────

test('gate arrival, then PAID, then CHECKOUT ROOM', async () => {
  const ctx = start();
  await send(GUEST_PHONE, '1');
  assert.strictEqual(bookingRow(ctx).fields['Status'], 'Checked In');

  await send(STAFF_PHONE, 'PAID ROOM 1 400');
  assert.strictEqual(bookingRow(ctx).fields['Payment Status'], 'Paid');
  assert.strictEqual(bookingRow(ctx).fields['Status'], 'Checked In', 'PAID does not close the stay');

  await send(STAFF_PHONE, 'CHECKOUT ROOM 1');
  assert.strictEqual(bookingRow(ctx).fields['Status'], 'Checked Out');
  assert.strictEqual(roomRow(ctx).fields['Status'], 'Cleaning');
  assert.strictEqual(bookingRow(ctx).fields['Payment Status'], 'Paid', 'checkout leaves payment alone');
});

test('gate arrival, then CHECKOUT ROOM, then PAID', async () => {
  const ctx = start();
  await send(GUEST_PHONE, '1');
  assert.strictEqual(bookingRow(ctx).fields['Status'], 'Checked In');

  await send(STAFF_PHONE, 'CHECKOUT ROOM 1');
  assert.strictEqual(bookingRow(ctx).fields['Status'], 'Checked Out');
  assert.notStrictEqual(bookingRow(ctx).fields['Payment Status'], 'Paid', 'checkout does not record payment');

  await send(STAFF_PHONE, 'PAID ROOM 1 400');
  assert.strictEqual(bookingRow(ctx).fields['Payment Status'], 'Paid');
  assert.strictEqual(bookingRow(ctx).fields['Status'], 'Checked Out', 'PAID must not reopen the stay');
  assert.strictEqual(roomRow(ctx).fields['Status'], 'Cleaning');
});
