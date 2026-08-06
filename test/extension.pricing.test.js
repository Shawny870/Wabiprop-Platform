// test/extension.pricing.test.js
// Extension repricing — the revenue leak in shipped B12 extension logic.
//
// `extendStay` pushed `Check Out` out and wrote nothing financial, so every
// extension since B12 shipped has been FREE: the guest gained an hour (or a
// night) and `Amount Due` never moved. B17's owner summary sums `Amount Due`,
// so every extended booking has also been understating revenue in the weekly
// report. Live confirmation at diagnosis time: 29 bookings in the base, every
// one `Payment Status: Unpaid`, and no code path had ever written `Amount Paid`.
//
// The fix is deliberately narrow: one extension's worth is ADDED to whatever the
// booking already carries. No itemisation, no new field, no recomputation.
//
// Driven through the real webhook against a persistent MockAirtable rather than
// a fixture, because the property under test is cumulative — the second
// extension has to see what the first one wrote. Run: node --test

const { test } = require('node:test');
const assert = require('node:assert');
const { installEnv, installFetch, makeRes, metaTextPayload, MockAirtable, TEST_ENV } = require('./harness');

installEnv();
const wh = require('../api/wabistay/webhook.js');
const handler = wh;

const GUEST_PHONE = '27821234567';

// Rates mirror the live base: Villa Liza's 1hr is R120, and F19's occupancy
// rates are R250 single / R400 couple.
function seed(overrides = {}) {
  return {
    WS_Properties: [{
      id: 'recP1',
      fields: {
        'Property Name': 'Villa Liza Guest Lodge', 'Phone Number ID': '111000111000',
        'Notify Phone': '27732273477',
        'Hourly Rate 1hr': 120, 'Hourly Rate 2hr': 250, 'Hourly Rate 3hr': 320
      }
    }],
    WS_Rooms: [
      { id: 'recR1', fields: { 'Room Name': 'Room 01', 'Room Number': 1, 'Status': 'Occupied', 'Property': ['recP1'] } }
    ],
    WS_Rates: [
      { id: 'recRateCouple', fields: { 'Rate Name': 'Couple', 'Occupancy Type': 'Couple', 'Amount': 400, 'Active': true, 'Property': ['recP1'] } }
    ],
    WS_Guests: [{
      id: 'recG1',
      fields: { 'Guest Name': 'John Smith', 'Phone Number': GUEST_PHONE, 'Session State': 'CHECKED_IN' }
    }],
    WS_Cleaners: [],
    WS_Enquiries: [],
    ...overrides
  };
}

// A live overnight stay: priced R400 at booking, Rate Applied linked (F19).
function overnightBooking(fields = {}) {
  return {
    id: 'recBook1',
    fields: {
      'Guest': ['recG1'], 'Room': ['recR1'], 'Status': 'Checked In',
      'Booking Type': 'Overnight', 'Amount Due': 400, 'Rate Applied': ['recRateCouple'],
      'Check In': '2026-08-05T12:00:00.000Z', 'Check Out': '2026-08-06T08:00:00.000Z',
      'WS_Property': ['recP1'],
      ...fields
    }
  };
}

// A live hourly stay: 2 hours at R250. Walk-ins are Booking Type 'Hourly' too,
// and carry no Rate Applied at all — covered separately below.
function hourlyBooking(fields = {}) {
  return {
    id: 'recBook1',
    fields: {
      'Guest': ['recG1'], 'Room': ['recR1'], 'Status': 'Checked In',
      'Booking Type': 'Hourly', 'Amount Due': 250,
      'Check In': '2026-08-05T12:00:00.000Z', 'Check Out': '2026-08-05T14:00:00.000Z',
      'WS_Property': ['recP1'],
      ...fields
    }
  };
}

function start(bookingRecords, overrides) {
  const ctx = { airtable: new MockAirtable(seed({ WS_Bookings: bookingRecords, ...overrides })), sends: [], axiom: [] };
  installFetch(ctx);
  return ctx;
}

async function extend(from = GUEST_PHONE) {
  const res = makeRes();
  await handler({ method: 'POST', body: metaTextPayload(from, 'extend') }, res);
  return res;
}

const booking = ctx => ctx.airtable.tables['WS_Bookings'][0].fields;

// ── The two priced paths ────────────────────────────────────────────────────

test('overnight extension adds the booking\'s own Rate Applied amount', async () => {
  const ctx = start([overnightBooking()]);
  await extend();

  assert.strictEqual(booking(ctx)['Amount Due'], 800, 'R400 + one night at the linked R400 rate');
});

test('hourly extension adds the property\'s 1-hour rate', async () => {
  const ctx = start([hourlyBooking()]);
  await extend();

  // +1 hour is the extension unit for Hourly, so it costs the 1hr rate (R120) —
  // NOT the 2hr rate the booking was originally priced at.
  assert.strictEqual(booking(ctx)['Amount Due'], 370, 'R250 + R120');
});

test('a walk-in extension is priced at the hourly rate, with no Rate Applied link', async () => {
  // Walk-ins are created as Booking Type 'Hourly' with Rate Applied deliberately
  // empty (hourly prices live on WS_Properties, which cannot be linked to), so
  // this is the case that would break if pricing keyed off Rate Applied alone.
  const ctx = start([hourlyBooking({ 'Source': 'Walk-in', 'Logged By': 'Manual', 'Amount Due': 250 })]);
  await extend();

  assert.strictEqual(booking(ctx)['Amount Due'], 370);
});

// ── Additive, not recomputed ────────────────────────────────────────────────

test('extensions accumulate — the third extension is not the first', async () => {
  // Uncapped extensions are the locked behaviour (16 July), so repeat extensions
  // are the normal case rather than an edge one — and this is the only test that
  // can tell "added" from "recomputed" if the per-extension charge ever happens
  // to equal the booking's base price. (Replacing the addition with an
  // assignment fails 7 of these 13, this one included; it is not a subtle
  // mutation, but this is the assertion that stays valid when the others cannot
  // distinguish the two.)
  const ctx = start([overnightBooking()]);
  await extend();
  await extend();
  await extend();

  assert.strictEqual(booking(ctx)['Amount Due'], 1600, 'R400 base + 3 × R400');
});

test('the added charge is one extension, matching the time actually granted', async () => {
  const ctx = start([hourlyBooking()]);
  const before = Date.parse(booking(ctx)['Check Out']);
  await extend();

  const after = Date.parse(booking(ctx)['Check Out']);
  assert.strictEqual(after - before, 60 * 60 * 1000, 'one hour of time');
  assert.strictEqual(booking(ctx)['Amount Due'], 370, 'one hour of money');
});

test('an existing Amount Due of zero still accrues the charge', async () => {
  const ctx = start([overnightBooking({ 'Amount Due': 0 })]);
  await extend();

  assert.strictEqual(booking(ctx)['Amount Due'], 400);
});

// ── Fail closed: never invent a price ───────────────────────────────────────

test('an overnight booking with no Rate Applied still extends, but Amount Due is untouched', async () => {
  // F19's fail-closed path produces exactly this record: booked, owner notified,
  // never priced. Refusing the guest more time over a config gap would be a worse
  // failure than an unpriced extension, and is not what B12 promised them.
  const ctx = start([overnightBooking({ 'Rate Applied': undefined, 'Amount Due': 400 })]);
  await extend();

  assert.strictEqual(booking(ctx)['Amount Due'], 400, 'no guessed figure written');
  const span = Date.parse(booking(ctx)['Check Out']) - Date.parse('2026-08-06T08:00:00.000Z');
  assert.strictEqual(span, 24 * 60 * 60 * 1000, 'the time extension still happened');
  assert.ok(
    ctx.axiom.some(e => e.event === 'extension_not_priced'),
    'the gap is logged loudly rather than silently absorbed'
  );
});

test('a property with no 1-hour rate cannot price an hourly extension', async () => {
  const s = seed();
  delete s.WS_Properties[0].fields['Hourly Rate 1hr'];
  const ctx = start([hourlyBooking()], { WS_Properties: s.WS_Properties });
  await extend();

  assert.strictEqual(booking(ctx)['Amount Due'], 250, 'unchanged, not zero-charged');
  assert.ok(ctx.axiom.some(e => e.event === 'extension_not_priced'));
});

test('a zero hourly rate is treated as unconfigured, never as a free extension', async () => {
  const s = seed();
  s.WS_Properties[0].fields['Hourly Rate 1hr'] = 0;
  const ctx = start([hourlyBooking()], { WS_Properties: s.WS_Properties });
  await extend();

  assert.strictEqual(booking(ctx)['Amount Due'], 250);
  assert.ok(ctx.axiom.some(e => e.event === 'extension_not_priced'));
});

// ── B12 behaviour that must not regress ─────────────────────────────────────

test('the owner is still notified on the first extension only', async () => {
  const ctx = start([overnightBooking()]);
  // Counted by RECIPIENT, not by wording: the guest gets their own confirmation
  // on every extension, so matching on the copy would count that too.
  const ownerSends = () => ctx.sends.filter(s => s.to === TEST_ENV.OWNER_PHONE).length;
  await extend();
  const afterFirst = ownerSends();
  await extend();
  const afterSecond = ownerSends();

  assert.strictEqual(booking(ctx)['Extension Owner Notified'], true);
  assert.strictEqual(afterSecond, afterFirst, 'no re-notify on the second extension');
  assert.strictEqual(booking(ctx)['Amount Due'], 1200, 'but both extensions were charged');
});

test('the checkout warning is re-armed, so the cron still manages the new window', async () => {
  const ctx = start([overnightBooking({ 'Checkout Warning Sent At': '2026-08-06T07:45:00.000Z' })]);
  await extend();

  assert.strictEqual(booking(ctx)['Checkout Warning Sent At'], null);
});

test('nothing is charged when there is nothing to extend', async () => {
  const ctx = start([overnightBooking({ 'Check Out': undefined })]);
  await extend();

  assert.strictEqual(booking(ctx)['Amount Due'], 400, 'date-less legacy row is left alone entirely');
});

// ── B17 self-corrects with no separate change ───────────────────────────────

test('the owner summary picks up the extended total with no change to B17', async () => {
  // The confirmation asked for: aggregateOwnerSummary sums `Amount Due` from the
  // record at report time, so an in-place update is all it needs. Room-nights
  // come from Check In/Check Out, which the extension also moves — both halves
  // of the report self-correct.
  const NOW = new Date('2026-08-06T12:00:00.000Z');
  const ctx = start([overnightBooking()]);

  const before = await wh.runOwnerSummary({ now: NOW });
  assert.strictEqual(before[0].totalRevenue, 400, 'pre-extension revenue');

  await extend();

  const after = await wh.runOwnerSummary({ now: NOW });
  assert.strictEqual(after[0].totalRevenue, 800, 'the extension is now in the owner report');
  assert.ok(after[0].roomNightsSold > before[0].roomNightsSold, 'and so is the extra night');
});
