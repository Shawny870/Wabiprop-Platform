// test/autocheckout.test.js
// B12 — the auto-checkout cron (api/wabistay/webhook.js → runAutoCheckout).
// The cron is time-driven, not message-driven, so it can't be exercised by the
// Meta-payload replay harness. These tests inject `now` and assert the sweep's
// writes/sends directly against the in-memory Airtable mock. Run: node --test

const { test } = require('node:test');
const assert = require('node:assert');
const { installEnv, installFetch, MockAirtable } = require('./harness');

installEnv();
const wh = require('../api/wabistay/webhook.js');

function setup(seed) {
  const ctx = { airtable: new MockAirtable(seed), sends: [], axiom: [] };
  installFetch(ctx);
  return ctx;
}

const property = { id: 'recP1', fields: { 'Property Name': 'Test Lodge' } };
const guest = { id: 'recG1', fields: { 'Guest Name': 'John Smith', 'Phone Number': '27821234567' } };
const room = { id: 'recR1', fields: { 'Room Name': 'Room 1', 'Status': 'Occupied', 'Property': ['recP1'] } };

// A Checked In booking whose Check Out / warning timestamp are set per test.
function booking(fields) {
  return { id: 'recB1', fields: { Guest: ['recG1'], Status: 'Checked In', 'Booking Type': 'Overnight', Room: ['recR1'], ...fields } };
}

const NOW = new Date('2026-07-22T12:00:00.000Z');
const minsBefore = m => new Date(NOW.getTime() - m * 60 * 1000).toISOString();
const minsAfter = m => new Date(NOW.getTime() + m * 60 * 1000).toISOString();

test('B12: past checkout, not yet warned → sends the 15-min warning and stamps the time', async () => {
  const ctx = setup({
    WS_Bookings: [booking({ 'Check Out': minsBefore(1) })],
    WS_Guests: [guest], WS_Rooms: [room], WS_Properties: [property], WS_Cleaners: []
  });
  const summary = await wh.runAutoCheckout(NOW);
  assert.deepStrictEqual(summary, { warnings: 1, autoCheckouts: 0 });
  assert.deepStrictEqual(ctx.airtable.log.length, 1);
  assert.strictEqual(ctx.airtable.log[0].table, 'WS_Bookings');
  assert.strictEqual(ctx.airtable.log[0].fields['Checkout Warning Sent At'], NOW.toISOString());
  assert.strictEqual(ctx.sends.length, 1);
  assert.strictEqual(ctx.sends[0].to, '27821234567');
  assert.match(ctx.sends[0].body, /Reply \*EXTEND\*/);
});

test('B12: not yet past checkout (or extended into the future) → no action', async () => {
  const ctx = setup({
    WS_Bookings: [booking({ 'Check Out': minsAfter(30) })],
    WS_Guests: [guest], WS_Rooms: [room], WS_Properties: [property], WS_Cleaners: []
  });
  const summary = await wh.runAutoCheckout(NOW);
  assert.deepStrictEqual(summary, { warnings: 0, autoCheckouts: 0 });
  assert.strictEqual(ctx.airtable.log.length, 0);
  assert.strictEqual(ctx.sends.length, 0);
});

test('B12: warned, still inside the 15-min grace → no action', async () => {
  const ctx = setup({
    WS_Bookings: [booking({ 'Check Out': minsBefore(20), 'Checkout Warning Sent At': minsBefore(5) })],
    WS_Guests: [guest], WS_Rooms: [room], WS_Properties: [property], WS_Cleaners: []
  });
  const summary = await wh.runAutoCheckout(NOW);
  assert.deepStrictEqual(summary, { warnings: 0, autoCheckouts: 0 });
  assert.strictEqual(ctx.airtable.log.length, 0);
  assert.strictEqual(ctx.sends.length, 0);
});

test('B12: warned ≥15 min ago, no guest response → auto-checkout fires (same path as manual checkout)', async () => {
  const ctx = setup({
    WS_Bookings: [booking({ 'Check Out': minsBefore(20), 'Checkout Warning Sent At': minsBefore(16) })],
    WS_Guests: [guest], WS_Rooms: [room], WS_Properties: [property],
    WS_Cleaners: [{ id: 'recC1', fields: { 'Cleaner Name': 'Thandi', 'Phone Number': '0821110000', 'Active': true } }]
  });
  const summary = await wh.runAutoCheckout(NOW);
  assert.deepStrictEqual(summary, { warnings: 0, autoCheckouts: 1 });
  // Mirrors the manual checkout write order exactly.
  assert.deepStrictEqual(
    ctx.airtable.log.map(l => `${l.op} ${l.table}`),
    ['update WS_Bookings', 'update WS_Rooms', 'update WS_Rooms', 'update WS_Guests']
  );
  assert.strictEqual(ctx.airtable.log[0].fields['Status'], 'Checked Out');
  assert.strictEqual(ctx.airtable.log[0].fields['Checkout Confirmed'], true);
  assert.strictEqual(ctx.airtable.log[1].fields['Status'], 'Cleaning');
  assert.strictEqual(ctx.airtable.log[3].fields['Session State'], 'NEW');
  // Cleaner dispatched, then guest thanked.
  assert.strictEqual(ctx.sends.length, 2);
  assert.strictEqual(ctx.sends[0].to, '27821110000');
  assert.match(ctx.sends[0].body, /Room 1 has just been vacated/);
  assert.strictEqual(ctx.sends[1].to, '27821234567');
  assert.match(ctx.sends[1].body, /checked you out automatically/);
});

test('B12: boundary — warned exactly 15 min ago fires (>= grace)', async () => {
  const ctx = setup({
    WS_Bookings: [booking({ 'Check Out': minsBefore(20), 'Checkout Warning Sent At': minsBefore(15) })],
    WS_Guests: [guest], WS_Rooms: [room], WS_Properties: [property], WS_Cleaners: []
  });
  const summary = await wh.runAutoCheckout(NOW);
  assert.deepStrictEqual(summary, { warnings: 0, autoCheckouts: 1 });
});

test('B12: hourly bookings are handled the same as overnight', async () => {
  const ctx = setup({
    WS_Bookings: [booking({ 'Booking Type': 'Hourly', 'Check Out': minsBefore(20), 'Checkout Warning Sent At': minsBefore(16) })],
    WS_Guests: [guest], WS_Rooms: [room], WS_Properties: [property], WS_Cleaners: []
  });
  const summary = await wh.runAutoCheckout(NOW);
  assert.deepStrictEqual(summary, { warnings: 0, autoCheckouts: 1 });
  assert.strictEqual(ctx.airtable.log[0].fields['Status'], 'Checked Out');
});

test('B12: a date-less legacy Checked In row is ignored by the cron', async () => {
  const ctx = setup({
    WS_Bookings: [booking({ 'Check Out': undefined })],
    WS_Guests: [guest], WS_Rooms: [room], WS_Properties: [property], WS_Cleaners: []
  });
  const summary = await wh.runAutoCheckout(NOW);
  assert.deepStrictEqual(summary, { warnings: 0, autoCheckouts: 0 });
  assert.strictEqual(ctx.airtable.log.length, 0);
});
