// test/staytype.test.js
// A1 (flow inversion, Stage 4) — "short stay or multiple days?" is now the
// FIRST real question, before any date/name capture, replacing the old
// greeting that asked for name+dates directly with "reply HOURLY" as a
// footnote. Covers: the new AWAITING_STAY_TYPE state end to end, the scoped
// pricing menus (never both rate types in one message), the fail-closed path
// when hourly isn't configured, the invalid-answer re-prompt, and that the
// existing "hourly" keyword shortcut still works at every entry point.
//
// Rule 29 — interaction surface: this reorders NEW's fallback destination and
// inserts one new state ahead of AWAITING_DETAILS. AWAITING_OCCUPANCY
// (Single/Couple, F19 rate-fix) and AWAITING_HOURLY_DETAILS/DURATION are
// UNCHANGED — this only changes what precedes them, not their own logic. No
// shared writable state with those states beyond Session State itself, which
// every state transition already owns exclusively per guest.

const { test } = require('node:test');
const assert = require('node:assert');
const { installEnv, installFetch, makeRes, metaTextPayload, MockAirtable } = require('./harness');

installEnv();
const wh = require('../api/wabistay/webhook.js');

function baseSeed(overrides = {}) {
  return {
    WS_Properties: [{
      id: 'recP1',
      fields: {
        'Property Name': 'Villa Liza Guest Lodge', 'Phone Number ID': '111000111000',
        'Notify Phone': '27732273477', 'Hourly Rate 1hr': 120, 'Hourly Rate 2hr': 250, 'Hourly Rate 3hr': 320
      }
    }],
    WS_Rooms: [
      { id: 'recR1', fields: { 'Room Name': 'Room 01', 'Room Number': 1, 'Status': 'Available', 'Property': ['recP1'] } }
    ],
    WS_Rates: [
      { id: 'recRateSingle', fields: { 'Rate Name': 'Single', 'Occupancy Type': 'Single', 'Rate Type': 'Per Night', 'Amount': 300, 'Active': true, 'Property': ['recP1'] } },
      { id: 'recRateCouple', fields: { 'Rate Name': 'Couple', 'Occupancy Type': 'Couple', 'Rate Type': 'Per Night', 'Amount': 400, 'Active': true, 'Property': ['recP1'] } }
    ],
    WS_Guests: [],
    WS_Bookings: [],
    WS_Cleaners: [],
    WS_Enquiries: [],
    ...overrides
  };
}

function start(overrides) {
  const ctx = { airtable: new MockAirtable(baseSeed(overrides)), sends: [], axiom: [] };
  installFetch(ctx);
  return ctx;
}

async function send(from, text) {
  const res = makeRes();
  await wh({ method: 'POST', body: metaTextPayload(from, text) }, res);
  return res;
}

const GUEST_PHONE = '27821234567';
const guestRow = ctx => ctx.airtable.tables['WS_Guests'].find(g => g.fields['Phone Number'] === GUEST_PHONE);
const lastText = ctx => (ctx.sends[ctx.sends.length - 1] || {}).body || '';
const allTexts = ctx => ctx.sends.map(s => s.body || '').join('\n---\n');

// ── The reordered greeting itself ────────────────────────────────────────

test('NEW: first contact asks stay-type first — no dates/name instructions, no rates shown yet', async () => {
  const ctx = start();
  await send(GUEST_PHONE, 'hi');

  assert.strictEqual(guestRow(ctx).fields['Session State'], 'AWAITING_STAY_TYPE');
  const text = lastText(ctx);
  assert.match(text, /short stay/i);
  assert.match(text, /multiple days/i);
  assert.doesNotMatch(text, /check-in date/i, 'no date capture instructions in the first message');
  assert.doesNotMatch(text, /R300|R400|R120/, 'no rates shown before the guest has chosen a type');
});

// ── Short stay branch ────────────────────────────────────────────────────

test('AWAITING_STAY_TYPE "1": shows HOURLY rates only, never overnight rates, then asks name+arrival', async () => {
  const ctx = start();
  await send(GUEST_PHONE, 'hi');
  await send(GUEST_PHONE, '1');

  assert.strictEqual(guestRow(ctx).fields['Session State'], 'AWAITING_HOURLY_DETAILS');
  const text = allTexts(ctx);
  assert.match(text, /R120/, 'hourly 1hr rate shown');
  assert.match(text, /R250/, 'hourly 2hr rate shown');
  assert.match(text, /R320/, 'hourly 3hr rate shown');
  assert.doesNotMatch(text, /R300|R400/, 'overnight rates (Single/Couple) never shown on the short-stay path');
  assert.match(text, /full name/i, 'continues into the existing hourly capture prompt');
  assert.match(text, /arrive/i);
});

test('AWAITING_STAY_TYPE "short stay" (text alias) behaves identically to "1"', async () => {
  const ctx = start();
  await send(GUEST_PHONE, 'hi');
  await send(GUEST_PHONE, 'short stay');
  assert.strictEqual(guestRow(ctx).fields['Session State'], 'AWAITING_HOURLY_DETAILS');
});

test('AWAITING_STAY_TYPE "1" with hourly NOT configured: fails closed to the overnight path, zero rate quoted', async () => {
  const ctx = start({
    WS_Properties: [{
      id: 'recP1',
      fields: { 'Property Name': 'Villa Liza Guest Lodge', 'Phone Number ID': '111000111000', 'Notify Phone': '27732273477' }
      // no Hourly Rate fields at all — hourlyRates() returns null
    }]
  });
  await send(GUEST_PHONE, 'hi');
  await send(GUEST_PHONE, '1');

  assert.strictEqual(guestRow(ctx).fields['Session State'], 'AWAITING_DETAILS', 'routed to the overnight path, not stuck');
  assert.match(lastText(ctx), /aren't available/i);
  assert.ok(ctx.axiom.some(e => e.event === 'hourly_not_configured'));
});

// ── Multi-day branch ─────────────────────────────────────────────────────

test('AWAITING_STAY_TYPE "2": shows OVERNIGHT rates only, never hourly rates, then asks for name/check-in/check-out', async () => {
  const ctx = start();
  await send(GUEST_PHONE, 'hi');
  await send(GUEST_PHONE, '2');

  assert.strictEqual(guestRow(ctx).fields['Session State'], 'AWAITING_DETAILS');
  const text = lastText(ctx);
  assert.match(text, /R300/, 'overnight Single rate shown');
  assert.match(text, /R400/, 'overnight Couple rate shown');
  assert.doesNotMatch(text, /R120|R250|R320/, 'hourly rates never shown on the multi-day path');
  assert.match(text, /check-in date/i);
  assert.match(text, /check-out date/i);
});

test('AWAITING_STAY_TYPE "multiple days" (text alias) behaves identically to "2"', async () => {
  const ctx = start();
  await send(GUEST_PHONE, 'hi');
  await send(GUEST_PHONE, 'multiple days');
  assert.strictEqual(guestRow(ctx).fields['Session State'], 'AWAITING_DETAILS');
});

// ── Invalid answer ────────────────────────────────────────────────────────

test('AWAITING_STAY_TYPE: an unreadable answer re-prompts in place, zero writes', async () => {
  const ctx = start();
  await send(GUEST_PHONE, 'hi');
  const writesBefore = ctx.airtable.log.length;
  await send(GUEST_PHONE, 'banana');

  assert.strictEqual(guestRow(ctx).fields['Session State'], 'AWAITING_STAY_TYPE', 'still in the same state');
  assert.strictEqual(ctx.airtable.log.length, writesBefore, 'no writes on an invalid answer');
  assert.match(lastText(ctx), /1 - Short stay/);
});

// ── The "hourly" keyword shortcut still works everywhere it used to ──────

test('NEW: the "hourly" keyword shortcut still bypasses straight to AWAITING_HOURLY_DETAILS', async () => {
  const ctx = start();
  await send(GUEST_PHONE, 'hourly');
  assert.strictEqual(guestRow(ctx).fields['Session State'], 'AWAITING_HOURLY_DETAILS');
});

test('AWAITING_STAY_TYPE: the "hourly" keyword shortcut also works from the new state', async () => {
  const ctx = start();
  await send(GUEST_PHONE, 'hi');
  await send(GUEST_PHONE, 'hourly');
  assert.strictEqual(guestRow(ctx).fields['Session State'], 'AWAITING_HOURLY_DETAILS');
});

test('AWAITING_DETAILS: the "hourly" keyword shortcut still works after reaching the overnight path', async () => {
  const ctx = start();
  await send(GUEST_PHONE, 'hi');
  await send(GUEST_PHONE, '2'); // -> AWAITING_DETAILS
  await send(GUEST_PHONE, 'hourly');
  assert.strictEqual(guestRow(ctx).fields['Session State'], 'AWAITING_HOURLY_DETAILS');
});

// ── End-to-end: multi-day pick still completes a real overnight booking ──

test('End-to-end: short-stay-then-multi-day-reconsidered guest can still complete a normal overnight booking after the reorder', async () => {
  const ctx = start();
  await send(GUEST_PHONE, 'hi');
  await send(GUEST_PHONE, '2');
  await send(GUEST_PHONE, 'Jane Doe\n25 June\n27 June');

  const booking = ctx.airtable.tables['WS_Bookings'][0];
  assert.ok(booking, 'a booking was created');
  assert.strictEqual(booking.fields['Booking Type'], 'Overnight');
  assert.strictEqual(guestRow(ctx).fields['Session State'], 'AWAITING_OCCUPANCY', 'still lands in the unchanged occupancy step next');
});
