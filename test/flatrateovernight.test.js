// test/flatrateovernight.test.js
// CEO decision, 2026-09-28: rooms are all the same size, rates are flat
// per-night. Occupancy is no longer asked; collectDetails resolves and
// applies the one active Per Night rate for the property in the same turn as
// the guest's dates. Also covers the moved enquiry-alert/Booked-log timing
// (now fire only once the flow reaches its quote, not right after creation)
// and the removal of AWAITING_OCCUPANCY from the state machine.

const { test } = require('node:test');
const assert = require('node:assert');
const { installEnv, installFetch, makeRes, metaTextPayload, MockAirtable } = require('./harness');

installEnv();
const wh = require('../api/wabistay/webhook.js');

const GUEST_PHONE = '27821234567';
const OWNER_PHONE = '27830000001'; // matches TEST_ENV's configured owner number

function baseSeed(overrides = {}) {
  return {
    WS_Properties: [{
      id: 'recP1',
      fields: { 'Property Name': 'Villa Liza Guest Lodge', 'Phone Number ID': '111000111000', 'Notify Phone': '27732273477' }
    }],
    WS_Rooms: [
      { id: 'recR1', fields: { 'Room Name': 'Room 01', 'Room Number': 1, 'Status': 'Available', 'Property': ['recP1'], 'Active': true } }
    ],
    WS_Rates: [
      { id: 'recRateNight', fields: { 'Rate Name': 'Standard Night', 'Rate Type': 'Per Night', 'Amount': 400, 'Active': true, 'Property': ['recP1'] } }
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

const guestRow = ctx => ctx.airtable.tables['WS_Guests'].find(g => g.fields['Phone Number'] === GUEST_PHONE);
const bookingRow = ctx => ctx.airtable.tables['WS_Bookings'].find(b => b.fields['Guest'] && b.fields['Guest'].includes(guestRow(ctx).id));
const texts = (ctx, to) => ctx.sends.filter(s => s.to === to).map(s => s.body || '').join('\n---\n');

// ── No occupancy question at all ────────────────────────────────────────────

test('overnight flow: after name + dates, the guest goes straight to a quote — no occupancy question anywhere', async () => {
  const ctx = start({
    WS_Guests: [{ id: 'recG1', fields: { 'Guest Name': 'Unknown', 'Phone Number': GUEST_PHONE, 'Session State': 'AWAITING_DETAILS' } }]
  });

  await send(GUEST_PHONE, 'Jane Doe\n1 September 2026\n2 September 2026');

  assert.strictEqual(ctx.sends.length, 2, 'owner alert + guest quote, nothing more');
  assert.doesNotMatch(texts(ctx, GUEST_PHONE), /how many of you|just me|two of us/i);
  assert.match(texts(ctx, GUEST_PHONE), /R400 per night/i);
  assert.strictEqual(guestRow(ctx).fields['Session State'], 'AWAITING_ETA');
});

test('overnight flow: rate is quoted correctly with only a single active Per Night rate present', async () => {
  const ctx = start({
    WS_Guests: [{ id: 'recG1', fields: { 'Guest Name': 'Unknown', 'Phone Number': GUEST_PHONE, 'Session State': 'AWAITING_DETAILS' } }]
  });

  await send(GUEST_PHONE, 'Jane Doe\n1 September 2026\n2 September 2026');

  assert.strictEqual(bookingRow(ctx).fields['Amount Due'], 400);
  assert.deepStrictEqual(bookingRow(ctx).fields['Rate Applied'], ['recRateNight']);
});

test('overnight flow: more than one active Per Night rate for the property fails closed — never guesses, never picks one', async () => {
  const ctx = start({
    WS_Guests: [{ id: 'recG1', fields: { 'Guest Name': 'Unknown', 'Phone Number': GUEST_PHONE, 'Session State': 'AWAITING_DETAILS' } }],
    WS_Rates: [
      { id: 'recRateA', fields: { 'Rate Name': 'Standard Night', 'Rate Type': 'Per Night', 'Amount': 400, 'Active': true, 'Property': ['recP1'] } },
      { id: 'recRateB', fields: { 'Rate Name': 'Weekend Night', 'Rate Type': 'Per Night', 'Amount': 500, 'Active': true, 'Property': ['recP1'] } }
    ]
  });

  await send(GUEST_PHONE, 'Jane Doe\n1 September 2026\n2 September 2026');

  assert.strictEqual(bookingRow(ctx).fields['Amount Due'], undefined, 'never guesses between the two');
  assert.strictEqual(bookingRow(ctx).fields['Rate Applied'], undefined);
  assert.match(texts(ctx, GUEST_PHONE), /owner will be in touch/i);
  assert.strictEqual(guestRow(ctx).fields['Session State'], 'AWAITING_ETA', 'the booking still proceeds — the room stays held');
});

// ── Enquiry alert timing (CEO decision) ─────────────────────────────────────

test('enquiry alert: NOT sent when the guest stops after giving dates (booking create fails outright)', async () => {
  const ctx = start({
    WS_Guests: [{ id: 'recG1', fields: { 'Guest Name': 'Unknown', 'Phone Number': GUEST_PHONE, 'Session State': 'AWAITING_DETAILS' } }]
  });
  const originalCreate = ctx.airtable.create.bind(ctx.airtable);
  ctx.airtable.create = (table, fields) => {
    if (table === 'WS_Bookings') return { error: { type: 'INVALID_REQUEST', message: 'simulated' } };
    return originalCreate(table, fields);
  };

  await send(GUEST_PHONE, 'Jane Doe\n1 September 2026\n2 September 2026');

  assert.strictEqual(ctx.sends.filter(s => s.to === OWNER_PHONE).length, 0, 'no owner alert for a booking that never came to exist');
  assert.strictEqual(ctx.airtable.tables['WS_Enquiries'].length, 0, 'no Booked row either — nothing was ever created');
});

test('enquiry alert: sent exactly once, after the quote', async () => {
  const ctx = start({
    WS_Guests: [{ id: 'recG1', fields: { 'Guest Name': 'Unknown', 'Phone Number': GUEST_PHONE, 'Session State': 'AWAITING_DETAILS' } }]
  });

  await send(GUEST_PHONE, 'Jane Doe\n1 September 2026\n2 September 2026');

  const ownerSends = ctx.sends.filter(s => s.to === OWNER_PHONE);
  assert.strictEqual(ownerSends.length, 1, 'exactly one owner alert');
  const ownerSendIndex = ctx.sends.findIndex(s => s.to === OWNER_PHONE);
  const guestQuoteIndex = ctx.sends.findIndex(s => s.to === GUEST_PHONE && /R400 per night/i.test(s.body || ''));
  assert.ok(guestQuoteIndex !== -1, 'the guest quote was actually sent');
  assert.ok(ownerSendIndex < guestQuoteIndex, 'the owner alert fires before the guest quote send, both within the same already-priced turn');
  const rateWriteIndex = ctx.airtable.log.findIndex(w => w.table === 'WS_Bookings' && w.fields && w.fields['Amount Due'] !== undefined);
  assert.ok(rateWriteIndex !== -1, 'the rate was actually applied to the booking, before either send went out');
});

test('Booked is logged only after the quote (or the fail-closed contact-owner terminal), not at booking creation', async () => {
  const ctx = start({
    WS_Guests: [{ id: 'recG1', fields: { 'Guest Name': 'Unknown', 'Phone Number': GUEST_PHONE, 'Session State': 'AWAITING_DETAILS' } }]
  });

  await send(GUEST_PHONE, 'Jane Doe\n1 September 2026\n2 September 2026');

  const bookedLogIndex = ctx.airtable.log.findIndex(w => w.table === 'WS_Enquiries' && w.fields && w.fields['Outcome'] === 'Booked');
  const rateWriteIndex = ctx.airtable.log.findIndex(w => w.table === 'WS_Bookings' && w.fields && w.fields['Amount Due'] !== undefined);
  assert.ok(bookedLogIndex !== -1, 'the Booked row was written');
  assert.ok(rateWriteIndex !== -1, 'the rate write happened');
  assert.ok(rateWriteIndex < bookedLogIndex, 'the price is applied before Booked is logged — not the other way round');
});

// ── AWAITING_OCCUPANCY removed from the state machine ───────────────────────

test('a guest already sitting in AWAITING_OCCUPANCY (a straggler from before the fix) hits the fallback and resets cleanly, not stuck', async () => {
  const ctx = start({
    WS_Guests: [{ id: 'recG1', fields: { 'Guest Name': 'Jane Doe', 'Phone Number': GUEST_PHONE, 'Session State': 'AWAITING_OCCUPANCY' } }]
  });

  await send(GUEST_PHONE, '1');

  assert.strictEqual(guestRow(ctx).fields['Session State'], 'NEW', 'no dead state — routed forward via the generic unknown-state fallback');
  assert.match(texts(ctx, GUEST_PHONE), /reply with your name and dates/i);
});

// ── Hourly flow is untouched ─────────────────────────────────────────────────

test('hourly flow: unaffected — still prices from WS_Properties hourly rate fields, no occupancy question there either (unchanged)', async () => {
  const ctx = start({
    WS_Properties: [{
      id: 'recP1',
      fields: {
        'Property Name': 'Villa Liza Guest Lodge', 'Phone Number ID': '111000111000', 'Notify Phone': '27732273477',
        'Hourly Rate 1hr': 120, 'Hourly Rate 2hr': 250, 'Hourly Rate 3hr': 320
      }
    }],
    WS_Guests: [{ id: 'recG1', fields: { 'Guest Name': 'Unknown', 'Phone Number': GUEST_PHONE, 'Session State': 'AWAITING_HOURLY_DETAILS' } }]
  });

  await send(GUEST_PHONE, 'Jane Doe\n2pm');

  assert.match(texts(ctx, GUEST_PHONE), /How long do you need/i);
  const booking = ctx.airtable.tables['WS_Bookings'][0];
  assert.strictEqual(booking.fields['Booking Type'], 'Hourly');
});
