// test/anonnamereversion.test.js
// Bugfix: anonymous-guest name reverting to a stored real name from a prior
// booking. Root cause: collectDetails() / collectHourlyDetails() treated "the
// guest has ANY stored name that isn't 'Unknown'" as "reuse it, never
// re-derive" — so a returning guest typing "anon" on a NEW booking had that
// input silently discarded, and the old real name re-written back to
// WS_Guests. Violates the locked decision that anonymous entry stays as
// entered, never reverts to a stored real name.
//
// Fix: prefer whatever the guest typed THIS turn (including an explicit
// "anon") over any stored name; the stored name is now only a fallback for
// when nothing usable was typed this turn.
//
// Exact reproduction requested: book once with a real name, then rebook
// (same phone) typing "anon" — confirm "anon" wins and nothing gets
// rewritten back to the real name. Covers both the overnight (collectDetails)
// and hourly (collectHourlyDetails) paths, since both had the identical bug.

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
const guestRow = (ctx, id = 'recG1') => ctx.airtable.tables['WS_Guests'].find(g => g.id === id).fields;

const property = { id: 'recP1', fields: {
  'Property Name': 'Test Lodge', 'Phone Number ID': '111000111000', 'Notify Phone': '27831112222',
  'Hourly Rate 1hr': 120, 'Hourly Rate 2hr': 250, 'Hourly Rate 3hr': 320
} };
const room = { id: 'recR1', fields: { 'Room Name': 'Room 1', 'Status': 'Available', 'Property': ['recP1'] } };
const rates = [
  { id: 'recRS', fields: { 'Rate Name': 'Single', 'Rate Type': 'Per Night', 'Amount': 250, 'Active': true, 'Occupancy Type': 'Single', 'Property': ['recP1'] } },
  { id: 'recRC', fields: { 'Rate Name': 'Couple', 'Rate Type': 'Per Night', 'Amount': 400, 'Active': true, 'Occupancy Type': 'Couple', 'Property': ['recP1'] } }
];
const FROM = '27821234567';

test('overnight: guest with a stored real name from a prior booking types "anon" on a new booking — anon wins, real name is not rewritten', async () => {
  // Simulates "book once as Shawn" having already happened: the guest record
  // already carries a real name, not 'Unknown', exactly the state a prior
  // completed booking leaves behind.
  const ctx = makeCtx({
    WS_Properties: [property], WS_Rooms: [room], WS_Rates: rates,
    WS_Guests: [{ id: 'recG1', fields: { 'Guest Name': 'Shawn', 'Phone Number': FROM, 'Session State': 'AWAITING_DETAILS' } }],
    WS_Bookings: [], WS_Cleaners: []
  });

  await send(FROM, 'anon\n1 Dec 2026\n3 Dec 2026');

  assert.strictEqual(guestRow(ctx)['Guest Name'], 'anon', 'the explicitly typed "anon" must win, not the stored "Shawn"');
});

test('overnight: a guest who sends nothing usable as a name this turn still falls back to the stored name (fallback path preserved)', async () => {
  // Not a full reproduction of a real scenario (the flow always expects a
  // name line), but confirms the fix did not remove the fallback entirely —
  // only reordered which value wins when both are present.
  const ctx = makeCtx({
    WS_Properties: [property], WS_Rooms: [room], WS_Rates: rates,
    WS_Guests: [{ id: 'recG1', fields: { 'Guest Name': 'Shawn', 'Phone Number': FROM, 'Session State': 'AWAITING_DETAILS' } }],
    WS_Bookings: [], WS_Cleaners: []
  });

  // No text before the first date token — nothing typed as a name this turn.
  await send(FROM, '1 Dec 2026\n3 Dec 2026');

  assert.strictEqual(guestRow(ctx)['Guest Name'], 'Shawn', 'falls back to the stored name only when nothing was typed this turn');
});

test('hourly: guest with a stored real name from a prior booking types "anon" on a new hourly booking — anon wins, real name is not rewritten', async () => {
  const ctx = makeCtx({
    WS_Properties: [property], WS_Rooms: [room], WS_Rates: rates,
    WS_Guests: [{ id: 'recG1', fields: { 'Guest Name': 'Shawn', 'Phone Number': FROM, 'Session State': 'AWAITING_HOURLY_DETAILS' } }],
    WS_Bookings: [], WS_Cleaners: []
  });

  await send(FROM, 'anon\n2pm');

  assert.strictEqual(guestRow(ctx)['Guest Name'], 'anon', 'the explicitly typed "anon" must win, not the stored "Shawn"');
});

test('hourly: an arrival-time-only reply (no name line at all) still falls back to the stored name', async () => {
  const ctx = makeCtx({
    WS_Properties: [property], WS_Rooms: [room], WS_Rates: rates,
    WS_Guests: [{ id: 'recG1', fields: { 'Guest Name': 'Shawn', 'Phone Number': FROM, 'Session State': 'AWAITING_HOURLY_DETAILS' } }],
    WS_Bookings: [], WS_Cleaners: []
  });

  await send(FROM, '2pm');

  assert.strictEqual(guestRow(ctx)['Guest Name'], 'Shawn', 'falls back to the stored name only when nothing was typed this turn');
});

test('overnight: a brand-new guest ("Unknown") typing a real name behaves exactly as before — no regression on the ordinary path', async () => {
  const ctx = makeCtx({
    WS_Properties: [property], WS_Rooms: [room], WS_Rates: rates,
    WS_Guests: [{ id: 'recG1', fields: { 'Guest Name': 'Unknown', 'Phone Number': FROM, 'Session State': 'AWAITING_DETAILS' } }],
    WS_Bookings: [], WS_Cleaners: []
  });

  await send(FROM, 'John Smith\n1 Dec 2026\n3 Dec 2026');

  assert.strictEqual(guestRow(ctx)['Guest Name'], 'John Smith');
});
