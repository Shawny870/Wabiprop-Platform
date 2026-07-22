// test/ownersummary.test.js
// B17 — owner summary aggregation (api/wabistay/webhook.js → runOwnerSummary).
// Time-driven and property-scoped, so tested directly against the in-memory
// Airtable mock with an injected `now`. The send is stubbed (pending a Meta
// template); these assert the aggregation and that the payload is emitted to
// Axiom for end-to-end verification. Run: node --test

const { test } = require('node:test');
const assert = require('node:assert');
const { installEnv, installFetch, MockAirtable } = require('./harness');

installEnv();
const wh = require('../api/wabistay/webhook.js');

const NOW = new Date('2026-07-22T12:00:00.000Z'); // period = [07-15 12:00, 07-22 12:00)

function setup(seed) {
  const ctx = { airtable: new MockAirtable(seed), sends: [], axiom: [] };
  installFetch(ctx);
  return ctx;
}

// Two properties (A: 2 rooms, B: 1 room) + a zero-booking property C (1 room).
const seed = {
  WS_Properties: [
    { id: 'recPA', fields: { 'Property Name': 'Lodge A', 'Phone Number ID': 'PA', 'Notify Phone': '27831110001' } },
    { id: 'recPB', fields: { 'Property Name': 'Lodge B', 'Phone Number ID': 'PB', 'Notify Phone': '27831110002' } },
    { id: 'recPC', fields: { 'Property Name': 'Lodge C', 'Phone Number ID': 'PC' } }
  ],
  WS_Rooms: [
    { id: 'recRA1', fields: { 'Room Name': 'A1', 'Status': 'Available', 'Property': ['recPA'] } },
    { id: 'recRA2', fields: { 'Room Name': 'A2', 'Status': 'Available', 'Property': ['recPA'] } },
    { id: 'recRB1', fields: { 'Room Name': 'B1', 'Status': 'Available', 'Property': ['recPB'] } },
    { id: 'recRC1', fields: { 'Room Name': 'C1', 'Status': 'Available', 'Property': ['recPC'] } }
  ],
  WS_Bookings: [
    // A — in period: 2-night overnight (R700) + 3h hourly (R300)
    { id: 'recBA1', fields: { 'Room': ['recRA1'], 'Status': 'Confirmed', 'Booking Type': 'Overnight', 'Amount Due': 700, 'Check In': '2026-07-18T12:00:00.000Z', 'Check Out': '2026-07-20T08:00:00.000Z' } },
    { id: 'recBA2', fields: { 'Room': ['recRA2'], 'Status': 'Checked Out', 'Booking Type': 'Hourly', 'Amount Due': 300, 'Check In': '2026-07-19T10:00:00.000Z', 'Check Out': '2026-07-19T13:00:00.000Z' } },
    // A — upcoming (next 7 days), not in period
    { id: 'recBA3', fields: { 'Room': ['recRA1'], 'Status': 'Confirmed', 'Booking Type': 'Overnight', 'Amount Due': 500, 'Check In': '2026-07-25T12:00:00.000Z', 'Check Out': '2026-07-26T08:00:00.000Z' } },
    // A — cancelled in period (excluded at fetch by status filter)
    { id: 'recBA4', fields: { 'Room': ['recRA1'], 'Status': 'Cancelled', 'Booking Type': 'Overnight', 'Amount Due': 999, 'Check In': '2026-07-17T12:00:00.000Z', 'Check Out': '2026-07-18T08:00:00.000Z' } },
    // B — in period: 1-night overnight (R5000)
    { id: 'recBB1', fields: { 'Room': ['recRB1'], 'Status': 'Confirmed', 'Booking Type': 'Overnight', 'Amount Due': 5000, 'Check In': '2026-07-18T12:00:00.000Z', 'Check Out': '2026-07-19T08:00:00.000Z' } }
  ],
  WS_Cleaners: []
};

function byId(summaries, id) {
  return summaries.find(s => s.propertyId === id);
}

test('B17: correct weekly totals, hourly + overnight both counted', async () => {
  const ctx = setup(structuredClone(seed));
  const summaries = await wh.runOwnerSummary({ now: NOW });
  const a = byId(summaries, 'recPA');
  assert.strictEqual(a.periodDays, 7);
  assert.strictEqual(a.totalBookings, 2);           // overnight + hourly in period
  assert.strictEqual(a.totalRevenue, 1000);         // 700 + 300
  assert.strictEqual(a.roomNightsSold, 2.125);      // 2 nights + 3h(=0.125) partial
  assert.strictEqual(a.roomNightsAvailable, 14);    // 2 rooms * 7 nights
  assert.strictEqual(a.occupancyRate, 0.1518);      // 2.125 / 14, 4dp
  assert.strictEqual(a.upcomingBookings, 1);        // recBA3
});

test('B17: property scoping — Lodge A excludes Lodge B bookings and vice versa', async () => {
  const ctx = setup(structuredClone(seed));
  const summaries = await wh.runOwnerSummary({ now: NOW });
  const a = byId(summaries, 'recPA');
  const b = byId(summaries, 'recPB');
  assert.strictEqual(a.totalRevenue, 1000);  // NOT 6000 — B's 5000 excluded
  assert.strictEqual(b.totalRevenue, 5000);  // only B's booking
  assert.strictEqual(b.totalBookings, 1);
  assert.strictEqual(b.roomNightsSold, 1);   // 20h overnight rounds to 1 night
  assert.strictEqual(b.roomNightsAvailable, 7);
});

test('B17: a zero-booking week produces a sensible summary, not an error', async () => {
  const ctx = setup(structuredClone(seed));
  const summaries = await wh.runOwnerSummary({ now: NOW });
  const c = byId(summaries, 'recPC');
  assert.deepStrictEqual(
    { b: c.totalBookings, r: c.totalRevenue, s: c.roomNightsSold, o: c.occupancyRate, u: c.upcomingBookings },
    { b: 0, r: 0, s: 0, o: 0, u: 0 }
  );
  assert.strictEqual(c.roomNightsAvailable, 7);
});

test('B17: the fully-assembled payload is logged to Axiom for each property (send stubbed)', async () => {
  const ctx = setup(structuredClone(seed));
  await wh.runOwnerSummary({ now: NOW });
  const payloads = ctx.axiom.filter(e => e.event === 'owner_summary_payload');
  assert.strictEqual(payloads.length, 3); // one per property
  const a = payloads.find(p => p.propertyId === 'recPA');
  assert.strictEqual(a.totalRevenue, 1000);
  assert.strictEqual(a.template, 'wabistay_owner_weekly_summary');
  assert.strictEqual(a.notifyPhone, '27831110001');
  // Send is stubbed — no WhatsApp goes out.
  assert.strictEqual(ctx.sends.length, 0);
});

test('B17: daily variant narrows the period to 1 day', async () => {
  const ctx = setup(structuredClone(seed));
  const summaries = await wh.runOwnerSummary({ now: NOW, daily: true });
  const a = byId(summaries, 'recPA');
  assert.strictEqual(a.periodDays, 1);
  assert.strictEqual(a.roomNightsAvailable, 2); // 2 rooms * 1
  // Period [07-21 12:00, 07-22 12:00) contains none of the seeded check-ins.
  assert.strictEqual(a.totalBookings, 0);
});
