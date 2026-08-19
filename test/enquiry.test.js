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

test('B19: the sweep does NOT double-log a guest who already reached a terminal on their last message, but STILL resets them (reset/log are decoupled)', async () => {
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
  // Pre-decoupling this asserted summary.abandoned === 0 here — that conflated
  // "don't double-log" with "don't reset". They're now separate concerns: the
  // guest is genuinely stale and still gets reset (summary.abandoned counts
  // resets), the dedup guard only suppresses the redundant REPORT row.
  assert.strictEqual(summary.abandoned, 1);
  assert.strictEqual(enquiries(ctx).length, 1, 'no double-log — still just the seeded row');
  const guest = ctx.airtable.tables['WS_Guests'].find(g => g.id === 'recG1');
  assert.strictEqual(guest.fields['Session State'], 'NEW', 'reset still happens even though the log was suppressed');
});

test('B10.5 BUG 1: with 120+ existing enquiry rows, completing a booking still writes exactly ONE Booked row (pagination)', async () => {
  // Realistic filler rows so the test guest's just-created Booked row lands past
  // Airtable's 100-record first page. Distinct phones so they never collide with
  // the test guest. Without offset pagination in airtableGet, recordEta's dedup
  // guard reads only the first 100, misses the booking's own Booked row (created
  // at ~position 120), and double-logs. With pagination it sees all of them.
  const fillers = Array.from({ length: 120 }, (_, i) => ({
    id: `recFILL${String(i).padStart(3, '0')}`,
    fields: {
      'Phone Number': `2782${String(1000000 + i)}`,
      'Property': ['recP1'],
      'Outcome': ['Booked', 'No Availability', 'Invalid Input', 'Abandoned'][i % 4],
      'Booking Type': i % 3 === 0 ? 'Hourly' : 'Overnight',
      'Created At': new Date(Date.now() - i * 3600000).toISOString(),
      ...(i % 4 === 0 ? { 'Booking': [`recBK${i}`] } : {})
    }
  }));
  const ctx = makeCtx({
    WS_Properties: [property], WS_Rooms: [room], WS_Rates: rates,
    WS_Guests: [{ id: 'recG1', fields: { 'Guest Name': 'Unknown', 'Phone Number': FROM, 'Session State': 'AWAITING_DETAILS' } }],
    WS_Bookings: [], WS_Cleaners: [], WS_Enquiries: fillers
  });

  await send(FROM, 'John Smith\n1 Dec 2026\n3 Dec 2026'); // collectDetails → Booked
  await send(FROM, '1');                                   // occupancy
  await send(FROM, 'around 5pm');                          // recordEta → Booked re-affirm (must dedup)

  const mine = enquiries(ctx).filter(e => e.fields['Phone Number'] === FROM);
  assert.strictEqual(mine.length, 1);                      // exactly one, not two
  assert.strictEqual(mine[0].fields['Outcome'], 'Booked');
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

// ── the sweep must actually RESET the guest, not just log it ────────────────
// Found alongside the AWAITING_HOURLY_DETAILS stuck-state bug (recDAQmhoe4aFHvFy):
// runEnquiryAbandonment logged 'Abandoned' but never wrote Session State back,
// so even the 3 states it already covers (AWAITING_OCCUPANCY, AWAITING_ETA,
// AWAITING_HOURLY_DURATION) left the guest stuck forever — the sweep only ever
// reported the problem, never fixed it.

test('B19 fix: the sweep resets a stale AWAITING_ETA guest to NEW, not just logs Abandoned', async () => {
  const now = new Date('2026-07-22T12:00:00.000Z');
  const stale = new Date(now.getTime() - 25 * 60 * 60 * 1000).toISOString();
  const ctx = makeCtx({
    WS_Properties: [property], WS_Rooms: [room],
    WS_Guests: [{ id: 'recG1', fields: { 'Guest Name': 'John Smith', 'Phone Number': FROM, 'Session State': 'AWAITING_ETA', 'Last Inbound At': stale } }],
    WS_Bookings: [{ id: 'recB1', fields: { 'Guest': ['recG1'], 'Status': 'Enquiry', 'Booking Type': 'Overnight', 'Room': ['recR1'], 'Check In': '2026-12-01T12:00:00.000Z', 'Check Out': '2026-12-03T08:00:00.000Z' } }],
    WS_Enquiries: [], WS_Cleaners: []
  });
  const summary = await runEnquiryAbandonment(now);
  assert.strictEqual(summary.abandoned, 1);
  const guest = ctx.airtable.tables['WS_Guests'].find(g => g.id === 'recG1');
  assert.strictEqual(guest.fields['Session State'], 'NEW');
  // No proactive WhatsApp send — the guest is 24h+ silent, outside Meta's
  // free-form service window; reset only takes effect on THEIR next message.
  assert.strictEqual(ctx.sends.length, 0);
});

test('B19 fix: the sweep resets a stale AWAITING_OCCUPANCY guest to NEW', async () => {
  const now = new Date('2026-07-22T12:00:00.000Z');
  const stale = new Date(now.getTime() - 25 * 60 * 60 * 1000).toISOString();
  const ctx = makeCtx({
    WS_Properties: [property], WS_Rooms: [room],
    WS_Guests: [{ id: 'recG1', fields: { 'Guest Name': 'John Smith', 'Phone Number': FROM, 'Session State': 'AWAITING_OCCUPANCY', 'Last Inbound At': stale } }],
    WS_Bookings: [{ id: 'recB1', fields: { 'Guest': ['recG1'], 'Status': 'Enquiry', 'Booking Type': 'Overnight', 'Room': ['recR1'], 'Check In': '2026-12-01T12:00:00.000Z', 'Check Out': '2026-12-03T08:00:00.000Z' } }],
    WS_Enquiries: [], WS_Cleaners: []
  });
  const summary = await runEnquiryAbandonment(now);
  assert.strictEqual(summary.abandoned, 1);
  const guest = ctx.airtable.tables['WS_Guests'].find(g => g.id === 'recG1');
  assert.strictEqual(guest.fields['Session State'], 'NEW');
});

test('B19 fix: the sweep resets a stale AWAITING_HOURLY_DURATION guest to NEW', async () => {
  const now = new Date('2026-07-22T12:00:00.000Z');
  const stale = new Date(now.getTime() - 25 * 60 * 60 * 1000).toISOString();
  const ctx = makeCtx({
    WS_Properties: [property], WS_Rooms: [room],
    WS_Guests: [{ id: 'recG1', fields: { 'Guest Name': 'John Smith', 'Phone Number': FROM, 'Session State': 'AWAITING_HOURLY_DURATION', 'Last Inbound At': stale } }],
    WS_Bookings: [{ id: 'recB1', fields: { 'Guest': ['recG1'], 'Status': 'Enquiry', 'Booking Type': 'Hourly', 'Room': ['recR1'], 'Check In': '2026-12-01T12:00:00.000Z' } }],
    WS_Enquiries: [], WS_Cleaners: []
  });
  const summary = await runEnquiryAbandonment(now);
  assert.strictEqual(summary.abandoned, 1);
  const guest = ctx.airtable.tables['WS_Guests'].find(g => g.id === 'recG1');
  assert.strictEqual(guest.fields['Session State'], 'NEW');
});

test('B19 fix: a guest the sweep correctly skips (recent activity) is NOT reset', async () => {
  const now = new Date('2026-07-22T12:00:00.000Z');
  const recent = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
  const ctx = makeCtx({
    WS_Properties: [property], WS_Rooms: [room],
    WS_Guests: [{ id: 'recG1', fields: { 'Guest Name': 'John Smith', 'Phone Number': FROM, 'Session State': 'AWAITING_ETA', 'Last Inbound At': recent } }],
    WS_Bookings: [{ id: 'recB1', fields: { 'Guest': ['recG1'], 'Status': 'Enquiry', 'Booking Type': 'Overnight', 'Room': ['recR1'], 'Check In': '2026-12-01T12:00:00.000Z', 'Check Out': '2026-12-03T08:00:00.000Z' } }],
    WS_Enquiries: [], WS_Cleaners: []
  });
  await runEnquiryAbandonment(now);
  const guest = ctx.airtable.tables['WS_Guests'].find(g => g.id === 'recG1');
  assert.strictEqual(guest.fields['Session State'], 'AWAITING_ETA', 'untouched — sweep correctly held off, so no reset either');
});

// ── sweep coverage extended to AWAITING_DETAILS / AWAITING_HOURLY_DETAILS ───
// Closing the last gap from the stuck-state investigation. Deliberately
// modeling the REAL stuck-guest data shape, not the original 3 states' shape:
// Guest Name still 'Unknown' (never successfully parsed), no WS_Bookings row
// at all (collectDetails/collectHourlyDetails only create one on a
// successful parse — the same event that would have moved them past this
// state), and an existing deduped 'Invalid Input' enquiry row from their
// first failed attempt. All three would have blocked a naive un-decoupled
// reset — these tests are what actually prove the fix, not just that the
// state name is in the array.

test('B19 fix (new coverage): the sweep resets a stale AWAITING_DETAILS guest with NO name and NO booking — the realistic stuck-guest shape', async () => {
  const now = new Date('2026-07-22T12:00:00.000Z');
  const stale = new Date(now.getTime() - 25 * 60 * 60 * 1000).toISOString();
  const ctx = makeCtx({
    WS_Properties: [property], WS_Rooms: [room],
    WS_Guests: [{ id: 'recG1', fields: { 'Guest Name': 'Unknown', 'Phone Number': FROM, 'Session State': 'AWAITING_DETAILS', 'Last Inbound At': stale } }],
    // No WS_Bookings row at all — collectDetails never got far enough to create one.
    WS_Bookings: [],
    // The 'Invalid Input' row every failed parse attempt logs, deduped to one,
    // created at/after the guest's (stamped-at-entry) Last Inbound At — this is
    // exactly what would trip the old single "already covered" gate forever.
    WS_Enquiries: [{ id: 'recE0', fields: { 'Phone Number': FROM, 'Property': ['recP1'], 'Outcome': 'Invalid Input', 'Created At': stale } }],
    WS_Cleaners: []
  });
  const summary = await runEnquiryAbandonment(now);
  assert.strictEqual(summary.abandoned, 1, 'reset still happens despite Unknown name, no booking, and a pre-existing Invalid Input row');
  const guest = ctx.airtable.tables['WS_Guests'].find(g => g.id === 'recG1');
  assert.strictEqual(guest.fields['Session State'], 'NEW');
  // No second enquiry row — the log correctly stayed suppressed (dedup guard
  // still does its job), only the reset went through.
  assert.strictEqual(enquiries(ctx).length, 1);
});

test('B19 fix (new coverage): the sweep resets a stale AWAITING_HOURLY_DETAILS guest with NO name and NO booking — the ORIGINAL bug\'s exact shape (recDAQmhoe4aFHvFy)', async () => {
  const now = new Date('2026-07-22T12:00:00.000Z');
  const stale = new Date(now.getTime() - 25 * 60 * 60 * 1000).toISOString();
  const ctx = makeCtx({
    WS_Properties: [property], WS_Rooms: [room],
    WS_Guests: [{ id: 'recG1', fields: { 'Guest Name': 'Unknown', 'Phone Number': FROM, 'Session State': 'AWAITING_HOURLY_DETAILS', 'Last Inbound At': stale } }],
    WS_Bookings: [],
    WS_Enquiries: [],
    WS_Cleaners: []
  });
  const summary = await runEnquiryAbandonment(now);
  assert.strictEqual(summary.abandoned, 1);
  const guest = ctx.airtable.tables['WS_Guests'].find(g => g.id === 'recG1');
  assert.strictEqual(guest.fields['Session State'], 'NEW');
});

test('B19 fix (new coverage): a RECENT (not yet 24h stale) AWAITING_HOURLY_DETAILS guest is left alone — same staleness gate as every other state', async () => {
  const now = new Date('2026-07-22T12:00:00.000Z');
  const recent = new Date(now.getTime() - 60 * 60 * 1000).toISOString();
  const ctx = makeCtx({
    WS_Properties: [property], WS_Rooms: [room],
    WS_Guests: [{ id: 'recG1', fields: { 'Guest Name': 'Unknown', 'Phone Number': FROM, 'Session State': 'AWAITING_HOURLY_DETAILS', 'Last Inbound At': recent } }],
    WS_Bookings: [], WS_Enquiries: [], WS_Cleaners: []
  });
  const summary = await runEnquiryAbandonment(now);
  assert.strictEqual(summary.abandoned, 0);
  const guest = ctx.airtable.tables['WS_Guests'].find(g => g.id === 'recG1');
  assert.strictEqual(guest.fields['Session State'], 'AWAITING_HOURLY_DETAILS');
});

test('B19 fix (new coverage): the sweep does NOT touch CHECKED_IN or any other out-of-scope state, even if stale', async () => {
  const now = new Date('2026-07-22T12:00:00.000Z');
  const stale = new Date(now.getTime() - 25 * 60 * 60 * 1000).toISOString();
  const ctx = makeCtx({
    WS_Properties: [property], WS_Rooms: [room],
    WS_Guests: [
      { id: 'recGCheckedIn', fields: { 'Guest Name': 'Active Guest', 'Phone Number': '27822223333', 'Session State': 'CHECKED_IN', 'Last Inbound At': stale } },
      { id: 'recGConfirmed', fields: { 'Guest Name': 'Waiting Guest', 'Phone Number': '27822224444', 'Session State': 'CONFIRMED', 'Last Inbound At': stale } },
      { id: 'recGNew', fields: { 'Guest Name': 'Unknown', 'Phone Number': '27822225555', 'Session State': 'NEW', 'Last Inbound At': stale } }
    ],
    WS_Bookings: [], WS_Enquiries: [], WS_Cleaners: []
  });
  const summary = await runEnquiryAbandonment(now);
  assert.strictEqual(summary.abandoned, 0, 'none of these 3 states are in ENQUIRY_ABANDON_STATES — the query itself should never even return them');
  const guests = ctx.airtable.tables['WS_Guests'];
  assert.strictEqual(guests.find(g => g.id === 'recGCheckedIn').fields['Session State'], 'CHECKED_IN');
  assert.strictEqual(guests.find(g => g.id === 'recGConfirmed').fields['Session State'], 'CONFIRMED');
  assert.strictEqual(guests.find(g => g.id === 'recGNew').fields['Session State'], 'NEW');
});
