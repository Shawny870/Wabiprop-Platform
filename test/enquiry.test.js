// test/enquiry.test.js
// B19 — WS_Enquiries logging cases that need multiple messages against one
// persistent store (sequential attempts, one-write dedup), the staleness sweep
// (Abandoned), and property scoping. The single-message terminals (Booked / No
// Availability / Invalid Input) are covered by the replay fixtures. Run: node --test

const { test } = require('node:test');
const assert = require('node:assert');
const { installEnv, installFetch, MockAirtable, metaTextPayload, makeRes } = require('./harness');

installEnv();
const handler = require('../api/wabistay/webhook.js');
const { runEnquiryAbandonment } = handler;

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
const enquiries = ctx => ctx.airtable.tables['WS_Enquiries'] || [];
const outcomes = ctx => enquiries(ctx).map(e => e.fields['Outcome']);

const property = { id: 'recP1', fields: { 'Property Name': 'Test Lodge', 'Phone Number ID': '111000111000', 'Notify Phone': '27831112222' } };
const room = { id: 'recR1', fields: { 'Room Name': 'Room 1', 'Status': 'Available', 'Property': ['recP1'] } };
const rates = [
  { id: 'recRS', fields: { 'Rate Name': 'Single', 'Rate Type': 'Per Night', 'Amount': 250, 'Active': true, 'Occupancy Type': 'Single', 'Property': ['recP1'] } },
  { id: 'recRC', fields: { 'Rate Name': 'Couple', 'Rate Type': 'Per Night', 'Amount': 400, 'Active': true, 'Occupancy Type': 'Couple', 'Property': ['recP1'] } }
];
const FROM = '27821234567';

test('B19: two sequential attempts (refused, then fully booked) → exactly two rows', async () => {
  const ctx = makeCtx({
    WS_Properties: [property],
    WS_Rooms: [room],
    WS_Rates: rates,
    WS_Guests: [{ id: 'recG1', fields: { 'Guest Name': 'Unknown', 'Phone Number': FROM, 'Session State': 'AWAITING_DETAILS' } }],
    // A block on the only room for late August.
    WS_Bookings: [{ id: 'recB0', fields: { 'Status': 'Confirmed', 'Room': ['recR1'], 'Check In': '2026-08-24T12:00:00.000Z', 'Check Out': '2026-08-28T10:00:00.000Z' } }],
    WS_Cleaners: []
  });

  await send(FROM, 'John Smith\n25 Aug 2026\n27 Aug 2026'); // overlaps the block → No Availability
  await send(FROM, 'John Smith\n1 Dec 2026\n3 Dec 2026');   // free → booking created (Booked)
  await send(FROM, '1');                                     // occupancy → Single
  await send(FROM, 'around 5pm');                            // ETA → confirms (Booked re-affirm, deduped)

  assert.deepStrictEqual(outcomes(ctx), ['No Availability', 'Booked']); // exactly two, not one, not three
});

test('B19: the full booked flow logs ONE Booked row despite passing through collectDetails and recordEta', async () => {
  const ctx = makeCtx({
    WS_Properties: [property], WS_Rooms: [room], WS_Rates: rates,
    WS_Guests: [{ id: 'recG1', fields: { 'Guest Name': 'Unknown', 'Phone Number': FROM, 'Session State': 'AWAITING_DETAILS' } }],
    WS_Bookings: [], WS_Cleaners: []
  });
  await send(FROM, 'John Smith\n1 Dec 2026\n3 Dec 2026');
  await send(FROM, '1');
  await send(FROM, 'around 5pm');
  const booked = enquiries(ctx).filter(e => e.fields['Outcome'] === 'Booked');
  assert.strictEqual(booked.length, 1);            // dedup by booking id held
  assert.deepStrictEqual(booked[0].fields['Booking'], ['recNEW001']); // and the booking is linked
});

test('B19: property scoping — the enquiry row carries the messaged property, not another', async () => {
  const ctx = makeCtx({
    WS_Properties: [property, { id: 'recPB', fields: { 'Property Name': 'Other Lodge', 'Phone Number ID': '999', 'Notify Phone': '27830000009' } }],
    WS_Rooms: [room, { id: 'recRB', fields: { 'Room Name': 'B1', 'Status': 'Available', 'Property': ['recPB'] } }],
    WS_Rates: rates,
    WS_Guests: [{ id: 'recG1', fields: { 'Guest Name': 'Unknown', 'Phone Number': FROM, 'Session State': 'AWAITING_DETAILS' } }],
    WS_Bookings: [], WS_Cleaners: []
  });
  await send(FROM, 'John Smith\n1 Dec 2026\n3 Dec 2026');
  const e = enquiries(ctx).find(x => x.fields['Outcome'] === 'Booked');
  assert.deepStrictEqual(e.fields['Property'], ['recP1']); // A, never recPB
});

test('B19: staleness sweep logs Abandoned for a stale draft-bearing guest, property from the booking', async () => {
  const now = new Date('2026-07-22T12:00:00.000Z');
  const stale = new Date(now.getTime() - 25 * 60 * 60 * 1000).toISOString(); // 25h ago
  const ctx = makeCtx({
    WS_Properties: [property], WS_Rooms: [room],
    WS_Guests: [{ id: 'recG1', fields: { 'Guest Name': 'John Smith', 'Phone Number': FROM, 'Session State': 'AWAITING_ETA', 'Last Inbound At': stale } }],
    WS_Bookings: [{ id: 'recB1', fields: { 'Guest': ['recG1'], 'Status': 'Enquiry', 'Booking Type': 'Overnight', 'Room': ['recR1'], 'Check In': '2026-12-01T12:00:00.000Z', 'Check Out': '2026-12-03T08:00:00.000Z' } }],
    WS_Enquiries: [], WS_Cleaners: []
  });
  const summary = await runEnquiryAbandonment(now);
  assert.strictEqual(summary.abandoned, 1);
  assert.strictEqual(enquiries(ctx).length, 1);
  assert.strictEqual(enquiries(ctx)[0].fields['Outcome'], 'Abandoned');
  assert.deepStrictEqual(enquiries(ctx)[0].fields['Property'], ['recP1']);
});

test('B19: the sweep does NOT double-log a guest who already reached a terminal on their last message', async () => {
  const now = new Date('2026-07-22T12:00:00.000Z');
  const stale = new Date(now.getTime() - 25 * 60 * 60 * 1000).toISOString();
  const ctx = makeCtx({
    WS_Properties: [property], WS_Rooms: [room],
    WS_Guests: [{ id: 'recG1', fields: { 'Guest Name': 'John Smith', 'Phone Number': FROM, 'Session State': 'AWAITING_ETA', 'Last Inbound At': stale } }],
    WS_Bookings: [{ id: 'recB1', fields: { 'Guest': ['recG1'], 'Status': 'Enquiry', 'Booking Type': 'Overnight', 'Room': ['recR1'], 'Check In': '2026-12-01T12:00:00.000Z', 'Check Out': '2026-12-03T08:00:00.000Z' } }],
    // An enquiry already logged for this attempt (created at the guest's last activity).
    WS_Enquiries: [{ id: 'recE0', fields: { 'Phone Number': FROM, 'Property': ['recP1'], 'Outcome': 'No Availability', 'Created At': stale } }],
    WS_Cleaners: []
  });
  const summary = await runEnquiryAbandonment(now);
  assert.strictEqual(summary.abandoned, 0);       // guard held — no Abandoned added
  assert.strictEqual(enquiries(ctx).length, 1);   // still just the seeded row
});

test('B19: the sweep leaves a still-active (recent) draft guest alone', async () => {
  const now = new Date('2026-07-22T12:00:00.000Z');
  const recent = new Date(now.getTime() - 60 * 60 * 1000).toISOString(); // 1h ago
  const ctx = makeCtx({
    WS_Properties: [property], WS_Rooms: [room],
    WS_Guests: [{ id: 'recG1', fields: { 'Guest Name': 'John Smith', 'Phone Number': FROM, 'Session State': 'AWAITING_ETA', 'Last Inbound At': recent } }],
    WS_Bookings: [{ id: 'recB1', fields: { 'Guest': ['recG1'], 'Status': 'Enquiry', 'Booking Type': 'Overnight', 'Room': ['recR1'], 'Check In': '2026-12-01T12:00:00.000Z', 'Check Out': '2026-12-03T08:00:00.000Z' } }],
    WS_Enquiries: [], WS_Cleaners: []
  });
  const summary = await runEnquiryAbandonment(now);
  assert.strictEqual(summary.abandoned, 0);
});
