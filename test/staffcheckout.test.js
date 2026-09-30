// test/staffcheckout.test.js
// PR D (CEO decision, 2026-09-29) — `CHECKOUT ROOM <n>`, a staff command to
// close out a Checked In stay directly (in particular a walk-in with no
// phone, or one reception needs to end immediately), rather than relying on
// the guest's own phone or the auto-checkout cron. Deliberately separate
// from PAID: no amount, no payment side-effect — checkout and payment stay
// two independently composable commands.

const { test } = require('node:test');
const assert = require('node:assert');
const { installEnv, installFetch, makeRes, metaTextPayload, MockAirtable } = require('./harness');

installEnv();
const handler = require('../api/wabistay/webhook.js');
const { parseCheckoutCommand } = handler;

const STAFF_PHONE = '27825999279';
const ON_DUTY_PHONE = '27825999001';
const OUTSIDER_PHONE = '27820000999';
const GUEST_PHONE = '27821234567';

function seed(overrides = {}) {
  return {
    WS_Properties: [{
      id: 'recP1',
      fields: { 'Property Name': 'Villa Liza Guest Lodge', 'Phone Number ID': '111000111000', 'Notify Phone': '27732273477' }
    }],
    WS_Rooms: [
      { id: 'recR1', fields: { 'Room Name': 'Room 01', 'Room Number': 1, 'Status': 'Occupied', 'Property': ['recP1'], 'Active': true } }
    ],
    WS_Roles: [
      { id: 'recRole1', fields: { 'Role Label': 'Reception', 'Role Type': 'Reception', 'Property': ['recP1'], 'Current Phone': STAFF_PHONE, 'Active': true } }
    ],
    WS_Guests: [{ id: 'recG1', fields: { 'Guest Name': 'John Smith', 'Phone Number': GUEST_PHONE, 'Session State': 'CHECKED_IN' } }],
    WS_Bookings: [{
      id: 'recB1', fields: {
        'Guest': ['recG1'], 'Room': ['recR1'], 'Status': 'Checked In', 'Booking Type': 'Overnight',
        'Amount Due': 400, 'Checked In At': '2020-01-01T00:00:00.000Z', 'WS_Property': ['recP1']
      }
    }],
    WS_Cleaners: [], WS_Enquiries: [],
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

const bookingRow = ctx => ctx.airtable.tables['WS_Bookings'].find(b => b.id === 'recB1');
const roomRow = ctx => ctx.airtable.tables['WS_Rooms'].find(r => r.id === 'recR1');
const texts = ctx => ctx.sends.map(s => s.body || '').join('\n---\n');
const axiomEvents = ctx => ctx.axiom.map(e => e.event);

// ── Grammar ──────────────────────────────────────────────────────────────────

test('parseCheckoutCommand accepts CHECKOUT ROOM <n>, room only, no amount', () => {
  assert.deepStrictEqual(parseCheckoutCommand('CHECKOUT ROOM 2'), { ok: true, roomToken: '2' });
  assert.deepStrictEqual(parseCheckoutCommand('checkout room2'), { ok: true, roomToken: '2' });
});

test('parseCheckoutCommand refuses a bare CHECKOUT with no room', () => {
  assert.deepStrictEqual(parseCheckoutCommand('CHECKOUT'), { ok: false, reason: 'bad_syntax' });
});

test('ordinary traffic is not a CHECKOUT attempt — null, falls through silently', () => {
  for (const text of ['hi', 'checking out', 'check out', 'done', '']) {
    assert.strictEqual(parseCheckoutCommand(text), null, `should not be CHECKOUT: ${JSON.stringify(text)}`);
  }
});

// ── End to end ───────────────────────────────────────────────────────────────

test('reception closes out a Checked In stay: booking Checked Out, room to Cleaning, no amount involved', async () => {
  const ctx = start();
  await send(STAFF_PHONE, 'CHECKOUT ROOM 1');

  assert.strictEqual(bookingRow(ctx).fields['Status'], 'Checked Out');
  assert.strictEqual(bookingRow(ctx).fields['Checkout Confirmed'], true);
  assert.strictEqual(bookingRow(ctx).fields['Amount Due'], 400, 'untouched — checkout never writes money fields');
  assert.strictEqual(roomRow(ctx).fields['Status'], 'Cleaning');
  assert.match(texts(ctx), /checked out/i);
  assert.ok(axiomEvents(ctx).includes('checkout_command_recorded'));
});

test('CHECKOUT and PAID are independently composable — PAID before CHECKOUT still works, and CHECKOUT does not require or check payment', async () => {
  const ctx = start();
  await send(STAFF_PHONE, 'PAID ROOM 1 400'); // paid first, while still Checked In
  assert.strictEqual(bookingRow(ctx).fields['Payment Status'], 'Paid');

  await send(STAFF_PHONE, 'CHECKOUT ROOM 1'); // closes out separately, no amount needed
  assert.strictEqual(bookingRow(ctx).fields['Status'], 'Checked Out');
});

test('CHECKOUT before PAID also works — payment recorded after the stay is already Checked Out', async () => {
  const ctx = start();
  await send(STAFF_PHONE, 'CHECKOUT ROOM 1');
  assert.strictEqual(bookingRow(ctx).fields['Status'], 'Checked Out');
  assert.strictEqual(roomRow(ctx).fields['Status'], 'Cleaning');

  await send(STAFF_PHONE, 'PAID ROOM 1 400');
  assert.strictEqual(bookingRow(ctx).fields['Payment Status'], 'Paid');
  assert.strictEqual(bookingRow(ctx).fields['Status'], 'Checked Out', 'PAID must not reopen the stay');
  assert.strictEqual(roomRow(ctx).fields['Status'], 'Cleaning', 'PAID must not touch the room');
  assert.match(texts(ctx), /Payment recorded/);
});

test('an On Duty seat (Jill) can also run CHECKOUT — same fallback as PAID', async () => {
  const ctx = start({
    WS_Roles: [{ id: 'recRoleOD', fields: { 'Role Label': 'On Duty', 'Role Type': 'On Duty', 'Property': ['recP1'], 'Current Phone': ON_DUTY_PHONE, 'Active': true } }]
  });
  await send(ON_DUTY_PHONE, 'CHECKOUT ROOM 1');
  assert.strictEqual(bookingRow(ctx).fields['Status'], 'Checked Out');
});

test('an unauthorised sender gets nothing back — same no-leak rule as PAID/WALKIN', async () => {
  const ctx = start();
  await send(OUTSIDER_PHONE, 'CHECKOUT ROOM 1');
  assert.strictEqual(bookingRow(ctx).fields['Status'], 'Checked In', 'nothing changed');
  assert.strictEqual(ctx.sends.length, 2, 'ordinary POPIA notice + guest greeting only');
  assert.doesNotMatch(texts(ctx), /checked out/i);
});

test('CHECKOUT ROOM for a room with no Checked In booking is refused, nothing written', async () => {
  const ctx = start({ WS_Bookings: [] });
  await send(STAFF_PHONE, 'CHECKOUT ROOM 1');
  assert.strictEqual(roomRow(ctx).fields['Status'], 'Occupied', 'untouched');
  assert.match(texts(ctx), /no booking found/i);
});

test('CHECKOUT for an unknown room number is refused clearly', async () => {
  const ctx = start();
  await send(STAFF_PHONE, 'CHECKOUT ROOM 9');
  assert.match(texts(ctx), /no room matching/i);
});

test('CHECKOUT dispatches active cleaners for the property, same as guest-driven checkout', async () => {
  const ctx = start({
    WS_Cleaners: [{ id: 'recC1', fields: { 'Cleaner Name': 'Thandi', 'Phone Number': '27821110000', 'Active': true, 'Assigned Property': ['recP1'] } }]
  });
  await send(STAFF_PHONE, 'CHECKOUT ROOM 1');
  assert.ok(ctx.sends.some(s => s.to === '27821110000' && /has just been vacated/i.test(s.body || '')));
});
