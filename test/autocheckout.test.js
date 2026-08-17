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
    // B10.5 Bug 2: cleaners are property-scoped now, so the seed must assign one.
    WS_Cleaners: [{ id: 'recC1', fields: { 'Cleaner Name': 'Thandi', 'Phone Number': '0821110000', 'Active': true, 'Assigned Property': ['recP1'] } }]
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
  assert.strictEqual(ctx.airtable.log[3].fields['Session State'], 'AWAITING_RATING');
  // Cleaner dispatched, guest thanked, then prompted to rate the stay.
  assert.strictEqual(ctx.sends.length, 3);
  assert.strictEqual(ctx.sends[0].to, '27821110000');
  assert.match(ctx.sends[0].body, /Room 1 has just been vacated/);
  assert.strictEqual(ctx.sends[1].to, '27821234567');
  assert.match(ctx.sends[1].body, /checked you out automatically/);
  assert.strictEqual(ctx.sends[2].to, '27821234567');
  assert.match(ctx.sends[2].body, /rate your stay/);
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

// ─── B10.5 Bug 2 — auto-checkout property scoping ────────────────────────────
// Mirrors fixtures/61 (the manual path) for the cron. Two properties, each with
// an Active cleaner, plus an Active-but-unassigned cleaner: all three are Active,
// so the {Active} filter cannot be what excludes anyone — only property scoping
// can. The assertions prove EXCLUSION (exact send count, and property B's number
// never appears), not merely that property A's cleaner was included.
test('B10.5 Bug 2: auto-checkout dispatches ONLY the cleaner at the booking WS_Property — property B is untouched', async () => {
  const ctx = setup({
    // Scope must come from the booking's own WS_Property. recR1 carries a
    // Property link only because runAutoCheckout's room walk needs it for the
    // guest copy — the cleaner query does not read it.
    WS_Bookings: [booking({ 'Check Out': minsBefore(20), 'Checkout Warning Sent At': minsBefore(16), 'WS_Property': ['recP1'] })],
    WS_Guests: [guest], WS_Rooms: [room],
    WS_Properties: [property, { id: 'recP2', fields: { 'Property Name': 'Second Lodge' } }],
    WS_Cleaners: [
      { id: 'recC1', fields: { 'Cleaner Name': 'Thandi', 'Phone Number': '0821110000', 'Active': true, 'Assigned Property': ['recP1'] } },
      { id: 'recC2', fields: { 'Cleaner Name': 'Bongani', 'Phone Number': '0822220000', 'Active': true, 'Assigned Property': ['recP2'] } },
      { id: 'recC3', fields: { 'Cleaner Name': 'Sipho', 'Phone Number': '0823330000', 'Active': true } }
    ]
  });
  const summary = await wh.runAutoCheckout(NOW);
  assert.deepStrictEqual(summary, { warnings: 0, autoCheckouts: 1 });

  // Exactly three sends: property A's cleaner, then the guest thanks + rating
  // prompt. Unscoped dispatch would add property B's cleaner too.
  assert.strictEqual(ctx.sends.length, 3,
    `send count — actual: ${JSON.stringify(ctx.sends.map(s => s.to))}`);
  assert.strictEqual(ctx.sends[0].to, '27821110000');
  assert.match(ctx.sends[0].body, /Hi Thandi/);
  assert.strictEqual(ctx.sends[1].to, '27821234567');

  // Explicit exclusion: property B's cleaner and the unassigned cleaner are
  // never messaged, by number and by name.
  const recipients = ctx.sends.map(s => s.to);
  assert.ok(!recipients.includes('27822220000'), 'property B cleaner must NOT be notified');
  assert.ok(!recipients.includes('27823330000'), 'unassigned cleaner must NOT be notified');
  const bodies = ctx.sends.map(s => s.body).join('\n');
  assert.ok(!bodies.includes('Bongani'), 'property B cleaner name must not appear in any send');
  assert.ok(!bodies.includes('Sipho'), 'unassigned cleaner name must not appear in any send');
});

test('B10.5 Bug 2: auto-checkout fails CLOSED — a booking with no resolvable property dispatches nobody', async () => {
  const ctx = setup({
    // No WS_Property on the booking and no Property link on the room: nothing to
    // scope by. The pre-fix behaviour messaged every active cleaner in the base.
    WS_Bookings: [booking({ 'Check Out': minsBefore(20), 'Checkout Warning Sent At': minsBefore(16) })],
    WS_Guests: [guest],
    WS_Rooms: [{ id: 'recR1', fields: { 'Room Name': 'Room 1', 'Status': 'Occupied' } }],
    WS_Properties: [property],
    WS_Cleaners: [
      { id: 'recC1', fields: { 'Cleaner Name': 'Thandi', 'Phone Number': '0821110000', 'Active': true, 'Assigned Property': ['recP1'] } }
    ]
  });
  const summary = await wh.runAutoCheckout(NOW);
  assert.deepStrictEqual(summary, { warnings: 0, autoCheckouts: 1 });
  // The guest is still checked out, thanked, and prompted to rate; no cleaner is dispatched.
  assert.strictEqual(ctx.sends.length, 2);
  assert.strictEqual(ctx.sends[0].to, '27821234567');
  assert.strictEqual(ctx.sends[1].to, '27821234567');
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
