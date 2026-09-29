// test/walkinovernight.test.js
// PR D (CEO decision, 2026-09-29) — the overnight sibling of the hourly WALKIN
// command: `WALKIN ROOM <n> OVERNIGHT <checkin> <checkout> [name] [phone]`.
// Reuses the same date parser collectDetails already uses for guest-typed
// dates, and the same flat per-night rate lookup, unpriced-but-proceeds if
// ambiguous/absent (staff are standing in front of the guest either way).

const { test } = require('node:test');
const assert = require('node:assert');
const { installEnv, installFetch, makeRes, metaTextPayload, MockAirtable } = require('./harness');

installEnv();
const handler = require('../api/wabistay/webhook.js');
const { parseWalkinCommand } = handler;

const STAFF_PHONE = '27825999279';
const GUEST_PHONE = '27821234567';

function seed(overrides = {}) {
  return {
    WS_Properties: [{
      id: 'recP1',
      fields: { 'Property Name': 'Villa Liza Guest Lodge', 'Phone Number ID': '111000111000', 'Notify Phone': '27732273477' }
    }],
    WS_Rooms: [
      { id: 'recR1', fields: { 'Room Name': 'Room 01', 'Room Number': 1, 'Status': 'Available', 'Property': ['recP1'], 'Active': true } }
    ],
    WS_Rates: [
      { id: 'recRateNight', fields: { 'Rate Name': 'Standard Night', 'Rate Type': 'Per Night', 'Amount': 400, 'Active': true, 'Property': ['recP1'] } }
    ],
    WS_Roles: [
      { id: 'recRole1', fields: { 'Role Label': 'Reception', 'Role Type': 'Reception', 'Property': ['recP1'], 'Current Phone': STAFF_PHONE, 'Active': true } }
    ],
    WS_Cleaners: [], WS_Guests: [], WS_Bookings: [], WS_Enquiries: [],
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

const texts = ctx => ctx.sends.map(s => s.body || '').join('\n---\n');

// ── Grammar ──────────────────────────────────────────────────────────────────

test('parseWalkinCommand accepts WALKIN ROOM <n> OVERNIGHT <checkin> <checkout> [name] [phone]', () => {
  const parsed = parseWalkinCommand('WALKIN ROOM 4 OVERNIGHT 1 Oct 2026 5 Oct 2026 John Smith');
  assert.strictEqual(parsed.ok, true);
  assert.strictEqual(parsed.overnight, true);
  assert.strictEqual(parsed.roomToken, '4');
  assert.strictEqual(parsed.checkInText, '1 Oct 2026');
  assert.strictEqual(parsed.checkOutText, '5 Oct 2026');
  assert.strictEqual(parsed.guestName, 'John Smith');
});

test('parseWalkinCommand rejects check-out before check-in', () => {
  const parsed = parseWalkinCommand('WALKIN ROOM 4 OVERNIGHT 5 Oct 2026 1 Oct 2026 John Smith');
  assert.deepStrictEqual(parsed, { ok: false, reason: 'bad_dates' });
});

test('parseWalkinCommand rejects an overnight command with fewer than two real dates', () => {
  const parsed = parseWalkinCommand('WALKIN ROOM 4 OVERNIGHT 1 Oct 2026 John Smith');
  assert.deepStrictEqual(parsed, { ok: false, reason: 'bad_dates' });
});

// ── End to end ───────────────────────────────────────────────────────────────

test('an overnight walk-in books the room, applies the flat per-night rate, checks the guest in immediately', async () => {
  const ctx = start();
  await send(STAFF_PHONE, 'WALKIN ROOM 1 OVERNIGHT 1 Oct 2026 5 Oct 2026 John Smith');

  const booking = ctx.airtable.tables['WS_Bookings'][0];
  assert.ok(booking, 'booking created');
  assert.strictEqual(booking.fields['Booking Type'], 'Overnight');
  assert.strictEqual(booking.fields['Status'], 'Checked In', 'physically present, checked in immediately');
  assert.strictEqual(booking.fields['Source'], 'Walk-in');
  assert.strictEqual(booking.fields['Amount Due'], 400);
  assert.deepStrictEqual(booking.fields['Rate Applied'], ['recRateNight']);
  assert.ok(booking.fields['Checked In At'], 'stamped with the real physical check-in moment');
  assert.match(booking.fields['Check In'], /^2026-10-01T12:00:00\.000Z$/, 'Check In uses the TYPED date, not "now"');
  assert.match(booking.fields['Check Out'], /^2026-10-05T08:00:00\.000Z$/);

  const room = ctx.airtable.tables['WS_Rooms'].find(r => r.id === 'recR1');
  assert.strictEqual(room.fields['Status'], 'Occupied');
  assert.match(texts(ctx), /R400/);
});

test('an overnight walk-in still proceeds, unpriced, when there is no active Per Night rate — never blocked, never guessed', async () => {
  const ctx = start({ WS_Rates: [] });
  await send(STAFF_PHONE, 'WALKIN ROOM 1 OVERNIGHT 1 Oct 2026 5 Oct 2026 John Smith');

  const booking = ctx.airtable.tables['WS_Bookings'][0];
  assert.ok(booking, 'the walk-in still completes — staff are standing in front of the guest either way');
  assert.strictEqual(booking.fields['Status'], 'Checked In');
  assert.strictEqual(booking.fields['Amount Due'], undefined, 'never guessed');
  assert.match(texts(ctx), /to be confirmed/i);
});

test('an overnight walk-in is refused for a room already booked over the same dates — same availability path as everything else', async () => {
  const ctx = start({
    WS_Bookings: [{
      id: 'recBExisting', fields: {
        'Room': ['recR1'], 'Status': 'Confirmed', 'Booking Type': 'Overnight',
        'Check In': '2026-10-02T12:00:00.000Z', 'Check Out': '2026-10-04T08:00:00.000Z'
      }
    }]
  });
  await send(STAFF_PHONE, 'WALKIN ROOM 1 OVERNIGHT 1 Oct 2026 5 Oct 2026 John Smith');
  assert.strictEqual(ctx.airtable.tables['WS_Bookings'].length, 1, 'no second booking created');
  assert.match(texts(ctx), /isn't free/i);
});

test('an unrecognised sender gets nothing back for the overnight command — same no-leak rule as hourly', async () => {
  const ctx = start();
  await send('27820000999', 'WALKIN ROOM 1 OVERNIGHT 1 Oct 2026 5 Oct 2026 John Smith');
  assert.strictEqual(ctx.airtable.tables['WS_Bookings'].length, 0);
  assert.strictEqual(ctx.sends.length, 2, 'the ordinary POPIA notice + guest greeting, nothing WALKIN-specific');
  assert.doesNotMatch(texts(ctx), /walk-in|overnight/i);
});
