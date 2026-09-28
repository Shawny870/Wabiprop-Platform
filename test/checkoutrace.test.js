// test/checkoutrace.test.js
// CEO decision (2026-09-28): settleAutoCheckout and gateArrival both did an
// unconditional Session State write based on a stale snapshot, the same class
// of bug extendStay was already hardened against (PR3/PR3b — a fresh re-read
// immediately before the write, stand down if it moved). These tests simulate
// the actual race: real state changing in the wall-clock gap between a
// snapshot read and the write that assumed it was still current. Run: node --test

const { test } = require('node:test');
const assert = require('node:assert');
const { installEnv, installFetch, MockAirtable, metaTextPayload, makeRes } = require('./harness');

installEnv();
const wh = require('../api/wabistay/webhook.js');

function setup(seed) {
  const ctx = { airtable: new MockAirtable(seed), sends: [], axiom: [] };
  installFetch(ctx);
  return ctx;
}
async function send(payload) {
  const res = makeRes();
  await wh(payload.method === 'GET' ? { method: 'GET' } : { method: 'POST', body: payload }, res);
  return res;
}

// ── settleAutoCheckout / runAutoCheckout ────────────────────────────────────

const property = { id: 'recP1', fields: { 'Property Name': 'Test Lodge' } };
const guest = { id: 'recG1', fields: { 'Guest Name': 'John Smith', 'Phone Number': '27821234567', 'Session State': 'CHECKED_IN' } };
const room = { id: 'recR1', fields: { 'Room Name': 'Room 1', 'Status': 'Occupied', 'Property': ['recP1'] } };
const NOW = new Date('2026-07-22T12:00:00.000Z');
const minsBefore = m => new Date(NOW.getTime() - m * 60 * 1000).toISOString();
function booking(fields) {
  return { id: 'recB1', fields: { Guest: ['recG1'], Status: 'Checked In', 'Booking Type': 'Overnight', Room: ['recR1'], ...fields } };
}

test('race guard: a manual checkout+rating landing between the cron snapshot and settlement is not clobbered', async () => {
  const ctx = setup({
    WS_Bookings: [booking({ 'Check Out': minsBefore(20), 'Checkout Warning Sent At': minsBefore(16) })],
    WS_Guests: [guest], WS_Rooms: [room], WS_Properties: [property], WS_Cleaners: []
  });
  // Simulate the manual checkout+rate completing in the real wall-clock gap
  // between runAutoCheckout's tick-start snapshot and settleAutoCheckout's own
  // fresh-read guard, by mutating the store as a side effect of the very last
  // read that happens before it (the cron's own per-booking guest lookup).
  const originalList = ctx.airtable.list.bind(ctx.airtable);
  let raced = false;
  ctx.airtable.list = (table, formula) => {
    const result = originalList(table, formula);
    if (!raced && table === 'WS_Guests' && formula === "RECORD_ID() = 'recG1'") {
      raced = true;
      ctx.airtable.update('WS_Bookings', 'recB1', { Status: 'Checked Out', 'Checkout Confirmed': true, Rating: 5 });
      ctx.airtable.update('WS_Guests', 'recG1', { 'Session State': 'NEW' });
    }
    return result;
  };

  const summary = await wh.runAutoCheckout(NOW);
  assert.deepStrictEqual(summary, { warnings: 0, autoCheckouts: 0 }, 'the cron must not report a checkout it did not actually perform');
  assert.strictEqual(ctx.sends.length, 0, 'no duplicate guest messages, no duplicate cleaner dispatch from the raced cron pass');
  const guestRec = ctx.airtable.tables['WS_Guests'].find(g => g.id === 'recG1');
  assert.strictEqual(guestRec.fields['Session State'], 'NEW', 'the guest\'s already-advanced state must not be reset backward to AWAITING_RATING');
  const bookingRec = ctx.airtable.tables['WS_Bookings'].find(b => b.id === 'recB1');
  assert.strictEqual(bookingRec.fields['Rating'], 5, 'the manual flow\'s own data must survive untouched');
});

test('normal auto-checkout, no manual action in between, still works exactly as before', async () => {
  const ctx = setup({
    WS_Bookings: [booking({ 'Check Out': minsBefore(20), 'Checkout Warning Sent At': minsBefore(16) })],
    WS_Guests: [guest], WS_Rooms: [room], WS_Properties: [property],
    WS_Cleaners: [{ id: 'recC1', fields: { 'Cleaner Name': 'Thandi', 'Phone Number': '0821110000', 'Active': true, 'Assigned Property': ['recP1'] } }]
  });
  const summary = await wh.runAutoCheckout(NOW);
  assert.deepStrictEqual(summary, { warnings: 0, autoCheckouts: 1 });
  const bookingRec = ctx.airtable.tables['WS_Bookings'].find(b => b.id === 'recB1');
  assert.strictEqual(bookingRec.fields['Status'], 'Checked Out');
  const guestRec = ctx.airtable.tables['WS_Guests'].find(g => g.id === 'recG1');
  assert.strictEqual(guestRec.fields['Session State'], 'AWAITING_RATING');
  assert.strictEqual(ctx.sends.length, 3, 'cleaner dispatch, guest thanks, rating prompt — unaffected by the new guard');
});

// ── gateArrival ──────────────────────────────────────────────────────────────

const gateProperty = { id: 'recP1', fields: { 'Property Name': 'Test Lodge', 'Phone Number ID': '111000111000', 'Notify Phone': '27831112222' } };
const gateGuest = { id: 'recG1', fields: { 'Guest Name': 'John Smith', 'Phone Number': '27821234567', 'Session State': 'CONFIRMED' } };
const gateRoom = { id: 'recR1', fields: { 'Room Name': 'Room 1', 'Status': 'Available', 'Property': ['recP1'], 'Active': true } };
const gateBooking = { id: 'recB1', fields: { Guest: ['recG1'], Status: 'Confirmed' } };

test('race guard: a duplicate gate-arrival delivery landing after the first already checked the guest in stands down', async () => {
  const ctx = setup({
    WS_Properties: [gateProperty], WS_Rooms: [gateRoom],
    WS_Guests: [gateGuest], WS_Bookings: [gateBooking], WS_Cleaners: []
  });
  // Simulate Meta redelivering the SAME "here" message concurrently: this
  // invocation's own Step 3 room read (the earliest read in the function)
  // returns the STALE pre-race snapshot — matching a genuinely concurrent
  // invocation that already read that data before the race landed — but by
  // the time execution reaches the fresh-read guard at Step 4, the OTHER
  // ("real") invocation has already fully completed check-in.
  const originalList = ctx.airtable.list.bind(ctx.airtable);
  let firstArrivalSimulated = false;
  ctx.airtable.list = (table, formula) => {
    const staleResult = originalList(table, formula); // captured before the mutation below
    if (!firstArrivalSimulated && table === 'WS_Rooms' && formula === "{Status} = 'Available'") {
      firstArrivalSimulated = true;
      ctx.airtable.update('WS_Bookings', 'recB1', { Status: 'Checked In', 'Checked In At': '2026-07-22T12:00:00.000Z', Room: ['recR1'] });
      ctx.airtable.update('WS_Rooms', 'recR1', { Status: 'Occupied' });
      ctx.airtable.update('WS_Guests', 'recG1', { 'Session State': 'CHECKED_IN' });
    }
    return staleResult;
  };

  await send(metaTextPayload('27821234567', 'here'));

  assert.strictEqual(ctx.sends.length, 0, 'the duplicate must not send the guest or owner anything — the other invocation already did');
  const axiomEvents = ctx.axiom.map(e => e.event);
  assert.ok(axiomEvents.includes('gate_arrival_skipped_already_checked_in'), 'the stand-down must be logged, not silent in the logs too');
  const guestRec = ctx.airtable.tables['WS_Guests'].find(g => g.id === 'recG1');
  assert.strictEqual(guestRec.fields['Session State'], 'CHECKED_IN', 'unchanged by the duplicate — still exactly what the winning invocation set');
});

test('normal gate arrival, no concurrent duplicate, still works exactly as before', async () => {
  const ctx = setup({
    WS_Properties: [gateProperty], WS_Rooms: [gateRoom],
    WS_Guests: [gateGuest], WS_Bookings: [gateBooking], WS_Cleaners: []
  });
  await send(metaTextPayload('27821234567', 'here'));
  const bookingRec = ctx.airtable.tables['WS_Bookings'].find(b => b.id === 'recB1');
  assert.strictEqual(bookingRec.fields['Status'], 'Checked In');
  assert.deepStrictEqual(bookingRec.fields['Room'], ['recR1']);
  const guestRec = ctx.airtable.tables['WS_Guests'].find(g => g.id === 'recG1');
  assert.strictEqual(guestRec.fields['Session State'], 'CHECKED_IN');
  assert.strictEqual(ctx.sends.length, 2, 'owner notify + guest welcome, unaffected by the new guard');
});
