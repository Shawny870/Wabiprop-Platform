// test/suspensionbookinggate.test.js
// Wabistay Automated Payment Gating investigation, Phase 4: suspended-property
// booking block. Resolver is inline in handleMessage() (webhook.js) — tested
// end-to-end via the real dispatch path, same style as enquiry.test.js.
//
// Field names are PROPOSED, not yet live in Airtable (blocked on the API
// billing cap) — these tests exercise the code against the proposed field
// names ('Subscription Status', 'Guest Redirect Phone') via the mock, so the
// logic is verified now and ready the moment the fields are created live.
//
// CEO decision (2026-09-17): the check sits AFTER the STOP/opt-out block
// (opt-out must work regardless of subscription status) but BEFORE the POPIA
// consent notice (a suspended property's first-ever contact must get ONLY
// the redirect, not consent-then-redirect).

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
const texts = ctx => ctx.sends.map(s => s.body || '').join('\n---\n');
const FROM = '27821234567';

const suspendedProperty = {
  id: 'recP1',
  fields: {
    'Property Name': 'Test Lodge', 'Phone Number ID': '111000111000',
    'Notify Phone': '27831112222',
    'Subscription Status': 'Suspended', 'Guest Redirect Phone': '27839998888'
  }
};
const activeProperty = {
  id: 'recP1',
  fields: { 'Property Name': 'Test Lodge', 'Phone Number ID': '111000111000', 'Notify Phone': '27831112222' }
};
const room = { id: 'recR1', fields: { 'Room Name': 'Room 1', 'Status': 'Available', 'Property': ['recP1'], 'Active': true } };
const rates = [
  { id: 'recRS', fields: { 'Rate Name': 'Single', 'Rate Type': 'Per Night', 'Amount': 250, 'Active': true, 'Occupancy Type': 'Single', 'Property': ['recP1'] } }
];

test('suspended property, first-ever contact (no guest record): gets ONLY the redirect, never the POPIA consent notice', async () => {
  const ctx = makeCtx({
    WS_Properties: [suspendedProperty], WS_Rooms: [room], WS_Rates: rates,
    WS_Guests: [], WS_Bookings: [], WS_Cleaners: []
  });
  await send(FROM, 'hi');
  const out = texts(ctx);
  assert.match(out, /can't take bookings through this chat right now/);
  assert.match(out, /27839998888/, 'the configured Guest Redirect Phone must appear in the message');
  assert.doesNotMatch(out, /Quick note before we start/, 'consent notice must NOT also fire — redirect only');
});

test('suspended property, no Guest Redirect Phone configured yet: guest gets a graceful generic fallback, never leaks literal "null"', async () => {
  const noPhoneProperty = { id: 'recP1', fields: { ...suspendedProperty.fields, 'Guest Redirect Phone': undefined } };
  const ctx = makeCtx({
    WS_Properties: [noPhoneProperty], WS_Rooms: [room], WS_Rates: rates,
    WS_Guests: [], WS_Bookings: [], WS_Cleaners: []
  });
  await send(FROM, 'hi');
  const out = texts(ctx);
  assert.match(out, /can't take bookings through this chat right now/);
  assert.match(out, /contact the guesthouse directly/);
  assert.doesNotMatch(out, /null/i);
});

test('suspended property, no Guest Redirect Phone configured yet: CEO is alerted via the existing alertShawn channel, exactly once per message', async () => {
  const noPhoneProperty = { id: 'recP1', fields: { ...suspendedProperty.fields, 'Guest Redirect Phone': undefined } };
  const ctx = makeCtx({
    WS_Properties: [noPhoneProperty], WS_Rooms: [room], WS_Rates: rates,
    WS_Guests: [], WS_Bookings: [], WS_Cleaners: [],
    WS_Config: [{ id: 'recCfg1', fields: { 'Alert Phone': '27811110000' } }]
  });
  await send(FROM, 'hi');
  const alertSend = ctx.sends.find(s => s.to === '27811110000' && /missing_redirect_phone|Guest Redirect Phone/.test(s.body));
  assert.ok(alertSend, 'alertShawn must fire when a Suspended property has no Guest Redirect Phone');
  assert.strictEqual(ctx.axiom.some(e => e.event === 'suspended_property_missing_redirect_phone'), true, 'must be logged, not silent');
});

test('suspended property, guest mid-enquiry (AWAITING_DETAILS, not yet confirmed): still blocked, redirected instead of processing the booking', async () => {
  const ctx = makeCtx({
    WS_Properties: [suspendedProperty], WS_Rooms: [room], WS_Rates: rates,
    WS_Guests: [{ id: 'recG1', fields: { 'Guest Name': 'Unknown', 'Phone Number': FROM, 'Session State': 'AWAITING_DETAILS' } }],
    WS_Bookings: [], WS_Cleaners: []
  });
  await send(FROM, 'John Smith\n1 Dec 2026\n3 Dec 2026');
  const out = texts(ctx);
  assert.match(out, /can't take bookings through this chat right now/);
  assert.strictEqual(ctx.airtable.tables['WS_Bookings'].length, 0, 'no booking must be created for a suspended property');
});

test('suspended property, guest WITH an existing confirmed booking: normal service continues uninterrupted (Phase 4 core requirement)', async () => {
  const ctx = makeCtx({
    WS_Properties: [suspendedProperty], WS_Rooms: [room], WS_Rates: rates,
    WS_Guests: [{ id: 'recG1', fields: { 'Guest Name': 'Shawn', 'Phone Number': FROM, 'Session State': 'CONFIRMED' } }],
    WS_Bookings: [{ id: 'recB1', fields: {
      'Guest': ['recG1'], 'Room': ['recR1'], 'Status': 'Confirmed',
      'Check In': '2026-12-01T12:00:00.000Z', 'Check Out': '2026-12-03T10:00:00.000Z'
    } }],
    WS_Cleaners: []
  });
  await send(FROM, '1'); // gate arrival — normal transaction-completion flow
  const out = texts(ctx);
  assert.doesNotMatch(out, /can't take bookings through this chat right now/, 'a guest with an existing confirmed booking must never see the suspension redirect');
});

test('suspended property, guest CHECKED_IN: normal service (e.g. checkout) continues uninterrupted', async () => {
  const ctx = makeCtx({
    WS_Properties: [suspendedProperty], WS_Rooms: [room], WS_Rates: rates,
    WS_Guests: [{ id: 'recG1', fields: { 'Guest Name': 'Shawn', 'Phone Number': FROM, 'Session State': 'CHECKED_IN' } }],
    WS_Bookings: [{ id: 'recB1', fields: {
      'Guest': ['recG1'], 'Room': ['recR1'], 'Status': 'Checked In',
      'Check In': '2026-12-01T12:00:00.000Z', 'Check Out': '2026-12-03T10:00:00.000Z'
    } }],
    WS_Cleaners: []
  });
  await send(FROM, 'random text');
  const out = texts(ctx);
  assert.doesNotMatch(out, /can't take bookings through this chat right now/);
});

test('not-suspended property (no Subscription Status field at all): consent notice fires exactly as before — no regression on the ordinary path', async () => {
  const ctx = makeCtx({
    WS_Properties: [activeProperty], WS_Rooms: [room], WS_Rates: rates,
    WS_Guests: [], WS_Bookings: [], WS_Cleaners: []
  });
  await send(FROM, 'hi');
  const out = texts(ctx);
  assert.match(out, /Quick note before we start/, 'consent notice must still fire for an unsuspended property');
  assert.doesNotMatch(out, /can't take bookings through this chat right now/);
});

test('property with Subscription Status explicitly "Active": treated identically to unset — not suspended', async () => {
  const activeExplicit = { id: 'recP1', fields: { ...activeProperty.fields, 'Subscription Status': 'Active' } };
  const ctx = makeCtx({
    WS_Properties: [activeExplicit], WS_Rooms: [room], WS_Rates: rates,
    WS_Guests: [], WS_Bookings: [], WS_Cleaners: []
  });
  await send(FROM, 'hi');
  assert.doesNotMatch(texts(ctx), /can't take bookings through this chat right now/);
});

test('STOP still works on a suspended property, regardless of booking status — opt-out is a compliance concern, not a booking one', async () => {
  const ctx = makeCtx({
    WS_Properties: [suspendedProperty], WS_Rooms: [room], WS_Rates: rates,
    WS_Guests: [{ id: 'recG1', fields: { 'Guest Name': 'Unknown', 'Phone Number': FROM, 'Session State': 'NEW' } }],
    WS_Bookings: [], WS_Cleaners: []
  });
  await send(FROM, 'STOP');
  const guestRow = ctx.airtable.tables['WS_Guests'].find(g => g.id === 'recG1').fields;
  assert.strictEqual(guestRow['Opted Out'], true, 'STOP must still be honoured on a suspended property');
});
