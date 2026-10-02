// test/roomorder.test.js
// Doc 1b PR 4: room selection order. With WABISTAY_ROOM_ORDER on, findAvailableRoom
// prefers Available, then Cleaning, then Occupied rooms, ties broken by lowest
// room number; a held room (preferRoomId) still wins. Off (unset) keeps
// Airtable's order, which is why Rooms 04 and 05 won every booking before.
// In-memory only: MockAirtable + mocked fetch.

const { test, afterEach } = require('node:test');
const assert = require('node:assert');
const { installEnv, installFetch, makeRes, metaTextPayload, MockAirtable } = require('./harness');

installEnv();
const wh = require('../api/wabistay/webhook.js');

const GUEST_PHONE = '27821234567';
afterEach(() => { delete process.env.WABISTAY_ROOM_ORDER; });

// Airtable returned the live rooms in this order (Doc 1b section 3).
const LIVE_ORDER = ['04', '05', '08', '01', '03', '10', '02', '06'];

function room(num, status = 'Available', extra = {}) {
  return {
    id: `recR${num}`,
    fields: { 'Room Name': `Room ${num}`, 'Room Number': Number(num), 'Status': status, 'Property': ['recP1'], 'Active': true, ...extra }
  };
}

function seed({ rooms, bookings = [], guest } = {}) {
  return {
    WS_Properties: [{ id: 'recP1', fields: { 'Property Name': 'Canary Street Guest Rooms', 'Phone Number ID': '111000111000', 'Notify Phone': '27831112222' } }],
    WS_Rooms: rooms,
    WS_Rates: [{ id: 'recRate', fields: { 'Rate Name': 'Standard Night', 'Rate Type': 'Per Night', 'Amount': 600, 'Active': true, 'Property': ['recP1'] } }],
    WS_Roles: [], WS_Cleaners: [], WS_Enquiries: [],
    WS_Guests: [guest || { id: 'recG1', fields: { 'Guest Name': 'Unknown', 'Phone Number': GUEST_PHONE, 'Session State': 'AWAITING_DETAILS' } }],
    WS_Bookings: bookings
  };
}

function start(opts) {
  const ctx = { airtable: new MockAirtable(seed(opts)), sends: [], axiom: [] };
  installFetch(ctx);
  return ctx;
}

async function send(text) {
  const res = makeRes();
  await wh({ method: 'POST', body: metaTextPayload(GUEST_PHONE, text) }, res);
  return res;
}

const BOOK = 'Jane Doe\n1 December 2099\n3 December 2099';
const assigned = ctx => {
  const b = ctx.airtable.tables['WS_Bookings'].find(x => x.fields['Guest'] && x.fields['Guest'].includes('recG1'));
  return b ? b.fields['Room'][0] : null;
};

test('flag OFF: the first free row Airtable lists wins, as before (Room 04)', async () => {
  const ctx = start({ rooms: LIVE_ORDER.map(n => room(n)) });
  await send(BOOK);
  assert.strictEqual(assigned(ctx), 'recR04');
});

test('flag ON, all Available: the lowest room number wins, not the first row (Room 01, not 04)', async () => {
  process.env.WABISTAY_ROOM_ORDER = '1';
  const ctx = start({ rooms: LIVE_ORDER.map(n => room(n)) });
  await send(BOOK);
  assert.strictEqual(assigned(ctx), 'recR01');
});

test('flag ON: an Available room beats a Cleaning room even when the Cleaning room is first in the list and lower numbered', async () => {
  process.env.WABISTAY_ROOM_ORDER = 'true';
  const rooms = [room('01', 'Cleaning'), room('02', 'Occupied'), room('08', 'Available'), room('05', 'Available')];
  const ctx = start({ rooms });
  await send(BOOK);
  assert.strictEqual(assigned(ctx), 'recR05', 'lowest-numbered Available');
});

test('flag ON: with no Available room free, Cleaning is next, then Occupied', async () => {
  process.env.WABISTAY_ROOM_ORDER = '1';
  let ctx = start({ rooms: [room('01', 'Occupied'), room('03', 'Cleaning'), room('02', 'Occupied')] });
  await send(BOOK);
  assert.strictEqual(assigned(ctx), 'recR03', 'Cleaning before Occupied');

  ctx = start({ rooms: [room('09', 'Occupied'), room('02', 'Occupied')] });
  await send(BOOK);
  assert.strictEqual(assigned(ctx), 'recR02', 'only Occupied left: lowest number');
});

test('flag ON: a booking that overlaps the best room moves the choice to the next one', async () => {
  process.env.WABISTAY_ROOM_ORDER = '1';
  const blocker = {
    id: 'recBblock', fields: {
      'Guest': ['recGother'], 'Room': ['recR01'], 'Status': 'Confirmed', 'Booking Type': 'Overnight',
      'Check In': '2099-12-02T12:00:00.000Z', 'Check Out': '2099-12-04T08:00:00.000Z'
    }
  };
  const ctx = start({ rooms: LIVE_ORDER.map(n => room(n)), bookings: [blocker] });
  await send(BOOK);
  assert.strictEqual(assigned(ctx), 'recR02', 'Room 01 is taken for those dates, so the next lowest Available');
});

test('flag ON: Maintenance and inactive rooms are still never offered', async () => {
  process.env.WABISTAY_ROOM_ORDER = '1';
  const rooms = [room('01', 'Maintenance'), room('02', 'Available', { Active: false }), room('07', 'Available')];
  const ctx = start({ rooms });
  await send(BOOK);
  assert.strictEqual(assigned(ctx), 'recR07');
});

test('flag ON: a held room is kept at the gate even when a lower-numbered Available room is free', async () => {
  process.env.WABISTAY_ROOM_ORDER = '1';
  const held = {
    id: 'recBheld', fields: {
      'Guest': ['recG1'], 'Room': ['recR08'], 'Status': 'Confirmed', 'Booking Type': 'Overnight',
      'Check In': '2020-01-01T12:00:00.000Z', 'Check Out': '2099-01-01T08:00:00.000Z'
    }
  };
  const ctx = start({
    rooms: [room('01'), room('08')], bookings: [held],
    guest: { id: 'recG1', fields: { 'Guest Name': 'Jane Doe', 'Phone Number': GUEST_PHONE, 'Session State': 'CONFIRMED' } }
  });
  await send('1');
  const booking = ctx.airtable.tables['WS_Bookings'].find(b => b.id === 'recBheld');
  assert.strictEqual(booking.fields['Status'], 'Checked In');
  assert.deepStrictEqual(booking.fields['Room'], ['recR08'], 'the held room, not Room 01');
});

test('orderFreeRooms: number comes from Room Number, else the digits in Room Name; unnumbered rooms sort last', () => {
  const rooms = [
    { id: 'a', fields: { 'Room Name': 'Garden Suite', Status: 'Available' } },
    { id: 'b', fields: { 'Room Name': 'Room 12', Status: 'Available' } },
    { id: 'c', fields: { 'Room Name': 'Whatever', 'Room Number': 3, Status: 'Available' } },
    { id: 'd', fields: { 'Room Name': 'Room 9', Status: 'Available' } },
    { id: 'e', fields: { 'Room Name': 'Annex', Status: 'Mystery' } }
  ];
  assert.deepStrictEqual(wh.orderFreeRooms(rooms).map(r => r.id), ['c', 'd', 'b', 'a', 'e']);
});

test('orderFreeRooms does not mutate its input', () => {
  const rooms = [room('09'), room('01')];
  const before = rooms.map(r => r.id);
  wh.orderFreeRooms(rooms);
  assert.deepStrictEqual(rooms.map(r => r.id), before);
});

// ── Characterisation: what the overlap check does and does not protect ───────
// The date-range check decides availability; Room Status only ranks (flag on)
// or is ignored (flag off). So an Occupied or Cleaning room whose current
// booking ends BEFORE the new check-in is offered even though it is physically
// in use right now. Same-day turnover relies on this; "arrive now" bookings are
// the case it does not cover. Documented here so it is a known, tested edge.
test('characterisation: an Occupied room whose booking ends before the new check-in is still offered (status is not an availability test)', async () => {
  process.env.WABISTAY_ROOM_ORDER = '1';
  const ending = {
    id: 'recBoccupied', fields: {
      'Guest': ['recGother'], 'Room': ['recR01'], 'Status': 'Checked In', 'Booking Type': 'Overnight',
      'Check In': '2099-11-30T12:00:00.000Z', 'Check Out': '2099-12-01T08:00:00.000Z'
    }
  };
  const ctx = start({ rooms: [room('01', 'Occupied')], bookings: [ending] });
  await send(BOOK);
  assert.strictEqual(assigned(ctx), 'recR01');
});
