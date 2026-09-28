// test/roomsactive.test.js
// Rooms 1-6 operational / 7-12 disabled (CEO decision, 2026-09-28): a room
// with WS_Rooms.Active !== true must be fully invisible in every guest-facing
// flow and blocked for staff WALKIN too, with a clear staff-facing message.
// Run: node --test

const { test } = require('node:test');
const assert = require('node:assert');
const { installEnv, installFetch, MockAirtable, metaTextPayload, makeRes } = require('./harness');

installEnv();
const handler = require('../api/wabistay/webhook.js');

function makeCtx(seed) {
  const ctx = { airtable: new MockAirtable(seed), sends: [], axiom: [] };
  installFetch(ctx);
  return ctx;
}
async function send(from, text) {
  const res = makeRes();
  await handler({ method: 'POST', body: metaTextPayload(from, text) }, res);
  return res;
}

const property = { id: 'recP1', fields: { 'Property Name': 'Test Lodge', 'Phone Number ID': '111000111000', 'Notify Phone': '27831112222' } };
const activeRoom = { id: 'recR1', fields: { 'Room Name': 'Room 1', 'Status': 'Available', 'Property': ['recP1'], 'Active': true } };
const disabledRoom = { id: 'recR8', fields: { 'Room Name': 'Room 8', 'Room Number': 8, 'Status': 'Available', 'Property': ['recP1'], 'Active': false } };
const neverTouchedRoom = { id: 'recR9', fields: { 'Room Name': 'Room 9', 'Room Number': 9, 'Status': 'Available', 'Property': ['recP1'] } }; // Active never set — same as unchecked
const rates = [
  { id: 'recRS', fields: { 'Rate Name': 'Single', 'Rate Type': 'Per Night', 'Amount': 250, 'Active': true, 'Occupancy Type': 'Single', 'Property': ['recP1'] } }
];
const FROM = '27821234567';

test('guest overnight booking: a disabled room is never offered, an active one still is', async () => {
  const ctx = makeCtx({
    WS_Properties: [property],
    WS_Rooms: [disabledRoom, activeRoom],
    WS_Rates: rates,
    WS_Guests: [{ id: 'recG1', fields: { 'Guest Name': 'Unknown', 'Phone Number': FROM, 'Session State': 'AWAITING_DETAILS' } }],
    WS_Bookings: [], WS_Cleaners: []
  });
  await send(FROM, 'John Smith\n1 Dec 2026\n3 Dec 2026');
  const booking = (ctx.airtable.tables['WS_Bookings'] || [])[0];
  assert.ok(booking, 'booking must be created — the active room is still bookable');
  assert.deepStrictEqual(booking.fields['Room'], ['recR1'], 'only the active room may ever be assigned');
});

test('guest overnight booking: ALL rooms disabled looks exactly like "no availability" — never a distinct disabled message', async () => {
  const ctx = makeCtx({
    WS_Properties: [property],
    WS_Rooms: [disabledRoom, neverTouchedRoom],
    WS_Rates: rates,
    WS_Guests: [{ id: 'recG1', fields: { 'Guest Name': 'Unknown', 'Phone Number': FROM, 'Session State': 'AWAITING_DETAILS' } }],
    WS_Bookings: [], WS_Cleaners: []
  });
  await send(FROM, 'John Smith\n1 Dec 2026\n3 Dec 2026');
  assert.strictEqual(ctx.airtable.tables['WS_Bookings'].length, 0, 'no booking — every room is disabled or never activated');
  assert.strictEqual(ctx.sends.length, 1);
  assert.ok(ctx.sends[0].body.includes('fully booked'), 'guest sees the ordinary fully-booked copy, never a "disabled" mention');
  assert.ok(!ctx.sends[0].body.toLowerCase().includes('disabled'), 'a disabled room must never be described as such to a guest');
});

test('gate arrival, no-dates legacy fallback: a disabled room is skipped, the active one is assigned', async () => {
  const ctx = makeCtx({
    WS_Properties: [property],
    WS_Rooms: [disabledRoom, activeRoom],
    WS_Guests: [{ id: 'recG1', fields: { 'Guest Name': 'John Smith', 'Phone Number': FROM, 'Session State': 'CONFIRMED' } }],
    WS_Bookings: [{ id: 'recB1', fields: { 'Guest': ['recG1'], 'Status': 'Confirmed' } }], // no dates — hits the legacy fallback
    WS_Cleaners: []
  });
  await send(FROM, 'here');
  const booking = (ctx.airtable.tables['WS_Bookings'] || []).find(b => b.id === 'recB1');
  assert.deepStrictEqual(booking.fields['Room'], ['recR1']);
  const roomWrite = ctx.airtable.log.find(w => w.table === 'WS_Rooms' && w.id === 'recR8');
  assert.strictEqual(roomWrite, undefined, 'the disabled room must never be touched');
});

test('WALKIN targeting a disabled room by number: refused with a clear, distinct staff message, not silently', async () => {
  const propertyWithRates = { id: 'recP1', fields: { ...property.fields, 'Hourly Rate 1hr': 100, 'Hourly Rate 2hr': 150, 'Hourly Rate 3hr': 200 } };
  const ctx = makeCtx({
    WS_Properties: [propertyWithRates],
    WS_Rooms: [disabledRoom, activeRoom],
    WS_Roles: [{ id: 'recRole1', fields: { 'Role Label': 'Reception', 'Role Type': 'Reception', 'Current Phone': FROM, 'Property': ['recP1'], 'Active': true } }],
    WS_Cleaners: [], WS_Guests: [], WS_Bookings: []
  });

  await send(FROM, 'WALKIN ROOM 8 2HRS John Smith');
  assert.strictEqual(ctx.airtable.tables['WS_Bookings'].length, 0, 'no booking created for a disabled room');
  assert.strictEqual(ctx.sends.length, 1);
  assert.ok(ctx.sends[0].body.toLowerCase().includes('disabled'), 'staff must be told clearly the room is disabled, not a generic failure');
  assert.ok(!ctx.sends[0].body.toLowerCase().includes('no room matching'), 'must not be confused with a genuine "no such room" typo response');
});

test('WALKIN targeting an active room still works exactly as before', async () => {
  const propertyWithRates = { id: 'recP1', fields: { ...property.fields, 'Hourly Rate 1hr': 100, 'Hourly Rate 2hr': 150, 'Hourly Rate 3hr': 200 } };
  const ctx = makeCtx({
    WS_Properties: [propertyWithRates],
    WS_Rooms: [disabledRoom, activeRoom],
    WS_Roles: [{ id: 'recRole1', fields: { 'Role Label': 'Reception', 'Role Type': 'Reception', 'Current Phone': FROM, 'Property': ['recP1'], 'Active': true } }],
    WS_Cleaners: [], WS_Guests: [], WS_Bookings: []
  });

  await send(FROM, 'WALKIN ROOM 1 2HRS John Smith');
  assert.strictEqual(ctx.airtable.tables['WS_Bookings'].length, 1, 'the active room still books normally');
});

test('findAvailableRoom-backed paths: a room with Active never set (unchecked, same as live Airtable omitting the key) is treated as disabled, not active', async () => {
  const ctx = makeCtx({
    WS_Properties: [property],
    WS_Rooms: [neverTouchedRoom],
    WS_Rates: rates,
    WS_Guests: [{ id: 'recG1', fields: { 'Guest Name': 'Unknown', 'Phone Number': FROM, 'Session State': 'AWAITING_DETAILS' } }],
    WS_Bookings: [], WS_Cleaners: []
  });
  await send(FROM, 'John Smith\n1 Dec 2026\n3 Dec 2026');
  assert.strictEqual(ctx.airtable.tables['WS_Bookings'].length, 0, 'a room that has never been touched in Airtable must default to disabled, not active — a field CEO has not set yet must never accidentally open every room');
});
