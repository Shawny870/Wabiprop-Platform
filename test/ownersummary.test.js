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

// ── Stage 1: payment reconciliation / leakage-detection ─────────────────────
// Reuses the SAME periodBookings window the rest of the summary is already
// computed from — no new query, no new scheduler, extends runOwnerSummary's
// existing weekly cron. Design note carried in the code, not just here: delta
// can only ever be known once reception has recorded a real collection via
// PAID/COLLECTED — a booking nobody has acted on correctly shows its full
// Amount Due as outstanding delta, not a gap to "fix" later.

function reconSeed() {
  const s = structuredClone(seed);
  s.WS_Guests = [
    { id: 'recGA1', fields: { 'Guest Name': 'Thabo Nkosi' } },
    { id: 'recGA2', fields: { 'Guest Name': 'Sarah Cohen' } }
  ];
  // recBA1: R700 due, fully paid via PAID/COLLECTED — delta 0.
  s.WS_Bookings[0].fields['Guest'] = ['recGA1'];
  s.WS_Bookings[0].fields['Amount Paid'] = 700;
  // recBA2: R300 due, nothing recorded yet — full amount is outstanding delta.
  s.WS_Bookings[1].fields['Guest'] = ['recGA2'];
  // recBB1 (Lodge B): R5000 due, partially recorded (reception under-recorded, or a discount not yet reflected).
  s.WS_Bookings[4].fields['Amount Paid'] = 4500;
  return s;
}

test('B17/Stage1: payment lines carry room, guest, Amount Due, Amount Paid and delta per booking', async () => {
  const ctx = setup(reconSeed());
  const summaries = await wh.runOwnerSummary({ now: NOW });
  const a = byId(summaries, 'recPA');

  assert.strictEqual(a.paymentLines.length, 2);
  const paid = a.paymentLines.find(l => l.bookingId === 'recBA1');
  const unpaid = a.paymentLines.find(l => l.bookingId === 'recBA2');

  assert.deepStrictEqual(
    { room: paid.roomName, guest: paid.guestName, due: paid.amountDue, paidAmt: paid.amountPaid, delta: paid.delta },
    { room: 'A1', guest: 'Thabo Nkosi', due: 700, paidAmt: 700, delta: 0 }
  );
  assert.deepStrictEqual(
    { room: unpaid.roomName, guest: unpaid.guestName, due: unpaid.amountDue, paidAmt: unpaid.amountPaid, delta: unpaid.delta },
    { room: 'A2', guest: 'Sarah Cohen', due: 300, paidAmt: 0, delta: 300 }
  );
});

test('B17/Stage1: aggregate delta sums every line, not just the mismatched ones', async () => {
  const ctx = setup(reconSeed());
  const summaries = await wh.runOwnerSummary({ now: NOW });
  const a = byId(summaries, 'recPA');
  const b = byId(summaries, 'recPB');

  assert.strictEqual(a.paymentDeltaTotal, 300, '0 (settled) + 300 (outstanding)');
  assert.strictEqual(b.paymentDeltaTotal, 500, '5000 due, 4500 recorded so far');
});

test('B17/Stage1: a booking with no Guest link degrades to a labelled placeholder, not a crash', async () => {
  const s = reconSeed();
  delete s.WS_Bookings[1].fields['Guest'];
  const ctx = setup(s);
  const summaries = await wh.runOwnerSummary({ now: NOW });
  const a = byId(summaries, 'recPA');
  const line = a.paymentLines.find(l => l.bookingId === 'recBA2');
  assert.strictEqual(line.guestName, null);
});

test('B17/Stage1: a zero-booking week has zero payment lines and zero delta, not an error', async () => {
  const ctx = setup(reconSeed());
  const summaries = await wh.runOwnerSummary({ now: NOW });
  const c = byId(summaries, 'recPC');
  assert.deepStrictEqual(c.paymentLines, []);
  assert.strictEqual(c.paymentDeltaTotal, 0);
});

test('B17/Stage1: the weekly payload carries a rendered reconciliation message with a top-line total and one line per booking', async () => {
  const ctx = setup(reconSeed());
  await wh.runOwnerSummary({ now: NOW });
  const payloads = ctx.axiom.filter(e => e.event === 'owner_summary_payload');
  const a = payloads.find(p => p.propertyId === 'recPA');

  assert.ok(a.paymentReconciliationMessage.startsWith('💰 *Payment Reconciliation — Lodge A*'));
  assert.match(a.paymentReconciliationMessage, /\*Total Delta:\* R300\.00/);
  assert.match(a.paymentReconciliationMessage, /A1 — Thabo Nkosi: Due R700\.00 \/ Paid R700\.00 \(Δ R0\.00\)/);
  assert.match(a.paymentReconciliationMessage, /A2 — Sarah Cohen: Due R300\.00 \/ Paid R0\.00 \(Δ R300\.00\)/);
  // The total line appears before the per-booking lines, not after.
  assert.ok(a.paymentReconciliationMessage.indexOf('Total Delta') < a.paymentReconciliationMessage.indexOf('A1 —'));
});

test('formatPaymentReconciliationMessage renders an overpayment delta with a minus sign, not a misleading positive figure', () => {
  const summary = {
    propertyName: 'Lodge A',
    paymentDeltaTotal: -50,
    paymentLines: [{ roomName: 'A1', guestName: 'Thabo Nkosi', amountDue: 400, amountPaid: 450, delta: -50 }]
  };
  const message = wh.formatPaymentReconciliationMessage(summary);
  assert.match(message, /\*Total Delta:\* -R50\.00/);
  assert.match(message, /\(Δ -R50\.00\)/);
});
