// test/statemachine-escape.test.js
// Universal escape hatch for the AWAITING_* limbo states. Found via live
// testing: recDAQmhoe4aFHvFy got stuck in AWAITING_HOURLY_DETAILS with no
// way out — every AWAITING_* state has exactly one "*" row pointing at a
// parser that only advances state on a successful parse, so a guest whose
// input never satisfies that parser is stuck forever, short of a manual
// Airtable edit. Fix: senderStuckInAwaitingState (global guard) +
// ["cancel","menu","hi"] -> greetAndAskStayType (states.json global array).
//
// Drives the real HTTP handler shape (metaTextPayload/makeRes), same idiom
// as test/walkin.test.js and the DISPATCH tests in the (now-removed)
// issuelogging.test.js — this is what actually proves the routing, not just
// a guard function called directly.

const { test } = require('node:test');
const assert = require('node:assert');
const { installEnv, installFetch, MockAirtable, makeRes, metaTextPayload } = require('./harness');

installEnv();
const wh = require('../api/wabistay/webhook.js');

const PROPERTY_ID = 'recEP1';
const FROM = '27821111111';

function seedGuestInState(sessionState, overrides = {}) {
  return {
    WS_Properties: [{ id: PROPERTY_ID, fields: { 'Property Name': 'Villa Liza', 'Phone Number ID': '111000111000' } }],
    WS_Rooms: [{ id: 'recER1', fields: { 'Room Name': 'Room 01', 'Status': 'Available', 'Property': [PROPERTY_ID] } }],
    WS_Guests: [{ id: 'recEGuest1', fields: { 'Guest Name': 'Stuck Guest', 'Phone Number': FROM, 'Session State': sessionState } }],
    WS_Bookings: [],
    WS_Roles: [],
    WS_Cleaners: [],
    ...overrides
  };
}

function ctxFor(seed) {
  const ctx = { airtable: new MockAirtable(seed), sends: [], axiom: [] };
  installFetch(ctx);
  return ctx;
}

async function send(from, text) {
  const res = makeRes();
  await wh({ method: 'POST', body: metaTextPayload(from, text) }, res);
  return res;
}

const AWAITING_STATES_TO_CHECK = ['AWAITING_HOURLY_DETAILS', 'AWAITING_DETAILS', 'AWAITING_ETA'];
const ESCAPE_KEYWORDS = ['cancel', 'menu', 'hi'];

for (const state of AWAITING_STATES_TO_CHECK) {
  for (const keyword of ESCAPE_KEYWORDS) {
    test(`ESCAPE: a guest stuck in ${state} sending "${keyword}" gets reset to NEW and the standard greeting`, async () => {
      const ctx = ctxFor(seedGuestInState(state));

      await send(FROM, keyword);

      const guest = ctx.airtable.tables['WS_Guests'].find(g => g.id === 'recEGuest1');
      assert.strictEqual(guest.fields['Session State'], 'AWAITING_STAY_TYPE', 'greetAndAskStayType writes ctx.next, same as a genuinely new guest\'s first contact');

      const greeting = ctx.sends.find(s => /Welcome to Villa Liza/.test(s.body || ''));
      assert.ok(greeting, 'expected the standard new-guest greeting, not a bespoke reset message');
    });
  }
}

test('ESCAPE: case-insensitive — "CANCEL" and "Menu" also fire', async () => {
  const ctx = ctxFor(seedGuestInState('AWAITING_HOURLY_DETAILS'));
  await send(FROM, 'CANCEL');
  let guest = ctx.airtable.tables['WS_Guests'].find(g => g.id === 'recEGuest1');
  assert.strictEqual(guest.fields['Session State'], 'AWAITING_STAY_TYPE');

  const ctx2 = ctxFor(seedGuestInState('AWAITING_HOURLY_DETAILS'));
  await send(FROM, 'Menu');
  guest = ctx2.airtable.tables['WS_Guests'].find(g => g.id === 'recEGuest1');
  assert.strictEqual(guest.fields['Session State'], 'AWAITING_STAY_TYPE');
});

test('ESCAPE: unrelated text in AWAITING_HOURLY_DETAILS still reproduces the ORIGINAL bug (reprompt loop, no reset) — confirms the fix is additive, not a behavior change to normal parsing', async () => {
  const ctx = ctxFor(seedGuestInState('AWAITING_HOURLY_DETAILS'));
  await send(FROM, '3');
  const guest = ctx.airtable.tables['WS_Guests'].find(g => g.id === 'recEGuest1');
  assert.strictEqual(guest.fields['Session State'], 'AWAITING_HOURLY_DETAILS', 'unparseable, non-keyword input still just reprompts in place — expected, unchanged behavior');
  // "3" alone is ambiguous (3am or 3pm?), so this hits hourlyTimeAmbiguous
  // rather than the generic hourlyDetailsReprompt — either way it's a
  // reprompt, not a silent drop, and the state stays put (the assertion
  // above is the one that actually matters here).
  const reprompt = ctx.sends.find(s => /did you mean|didn.t quite get that/i.test(s.body || ''));
  assert.ok(reprompt);
});

test('ESCAPE: does NOT fire for a CONFIRMED guest — "cancel" there still means cancelBooking, the guard is scoped to AWAITING_* only', async () => {
  const seed = seedGuestInState('CONFIRMED', {
    WS_Bookings: [{ id: 'recECBk1', fields: { 'Guest': ['recEGuest1'], 'Room': ['recER1'], 'WS_Property': [PROPERTY_ID], 'Status': 'Confirmed' } }]
  });
  const ctx = ctxFor(seed);
  await send(FROM, 'cancel');
  const guest = ctx.airtable.tables['WS_Guests'].find(g => g.id === 'recEGuest1');
  // cancelBooking (CONFIRMED's own "cancel" row) writes Session State back to
  // NEW too — but via ITS OWN per-state row, not the new global guard. The
  // meaningful assertion is that it did NOT get routed to AWAITING_STAY_TYPE
  // (which greetAndAskStayType/the new guard would produce) — it went through
  // CONFIRMED's existing cancellation flow instead.
  assert.strictEqual(guest.fields['Session State'], 'NEW');
  const cancelled = ctx.sends.find(s => /cancelled/i.test(s.body || ''));
  assert.ok(cancelled, 'expected CONFIRMED\'s own cancellation copy, not the new-guest greeting');
});

test('ESCAPE: does NOT fire for a CHECKED_IN guest — an active stay is not a stuck draft', async () => {
  const seed = seedGuestInState('CHECKED_IN', {
    WS_Bookings: [{ id: 'recECBk2', fields: { 'Guest': ['recEGuest1'], 'Room': ['recER1'], 'WS_Property': [PROPERTY_ID], 'Status': 'Checked In' } }]
  });
  const ctx = ctxFor(seed);
  await send(FROM, 'cancel');
  const guest = ctx.airtable.tables['WS_Guests'].find(g => g.id === 'recEGuest1');
  assert.strictEqual(guest.fields['Session State'], 'CHECKED_IN', 'CHECKED_IN has no "cancel" row of its own and the new guard must not touch an active stay');
  const menu = ctx.sends.find(s => /You're checked in/i.test(s.body || ''));
  assert.ok(menu, 'expected CHECKED_IN\'s own showCheckedInMenu fallback');
});
