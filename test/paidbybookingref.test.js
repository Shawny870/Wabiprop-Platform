// test/paidbybookingref.test.js
// WABISTAY_PAID_BY_BOOKING_REF (1 or true; off by default): `PAID REF WS-ABC123 <amount>`
// records a payment against the booking whose Booking Ref is WS-ABC123, so reception
// can settle a booking before check-in even when it has no 4-character payment
// reference (card bookings never get one). Off: that form is refused as a syntax
// error, exactly as before. The amount must equal Amount Due, same as every PAID form.
// In-memory only: MockAirtable + mocked fetch.

const { test, afterEach } = require('node:test');
const assert = require('node:assert');
const { installEnv, installFetch, makeRes, metaTextPayload, MockAirtable } = require('./harness');

installEnv();
const saved = process.env.WABISTAY_PAID_BY_BOOKING_REF;
afterEach(() => { if (saved === undefined) delete process.env.WABISTAY_PAID_BY_BOOKING_REF; else process.env.WABISTAY_PAID_BY_BOOKING_REF = saved; });

const RECEPTION = '27780384989';
const OUTSIDER = '27820000999';
const GUEST = '27784896186';

function freshWebhook() {
  delete require.cache[require.resolve('../api/wabistay/webhook.js')];
  return require('../api/wabistay/webhook.js');
}

function seed({ booking = {}, extraBookings = [] } = {}) {
  return {
    WS_Properties: [
      { id: 'recP1', fields: { 'Property Name': 'Canary Street Guest Rooms', 'Phone Number ID': '111000111000', 'Notify Phone': '27831112222' } },
      { id: 'recP2', fields: { 'Property Name': 'Other Lodge', 'Phone Number ID': '222000222000' } }
    ],
    WS_Rooms: [
      { id: 'recR1', fields: { 'Room Name': 'Room 01', 'Room Number': 1, 'Status': 'Available', 'Property': ['recP1'], 'Active': true } },
      { id: 'recR9', fields: { 'Room Name': 'Room 09', 'Room Number': 9, 'Status': 'Available', 'Property': ['recP2'], 'Active': true } }
    ],
    WS_Roles: [{ id: 'recRole1', fields: { 'Role Label': 'Reception', 'Role Type': 'Reception', 'Property': ['recP1'], 'Current Phone': RECEPTION, 'Active': true } }],
    WS_Guests: [{ id: 'recG1', fields: { 'Guest Name': 'Mama Test', 'Phone Number': GUEST, 'Session State': 'CONFIRMED' } }],
    WS_Cleaners: [], WS_Enquiries: [], WS_Rates: [],
    WS_Bookings: [
      { id: 'recBookKEGGQF', fields: {
        'Booking Ref': 'WS-KEGGQF', 'Guest': ['recG1'], 'Room': ['recR1'], 'Status': 'Confirmed', 'Booking Type': 'Hourly',
        'Amount Due': 250, 'Payment Status': 'Unpaid', 'Payment Method': 'Card',
        'Check In': '2026-10-03T12:00:00.000Z', 'Check Out': '2026-10-03T14:00:00.000Z', ...booking
      } },
      ...extraBookings
    ]
  };
}

async function say(from, text, { flag, seedOpts } = {}) {
  if (flag === undefined) delete process.env.WABISTAY_PAID_BY_BOOKING_REF; else process.env.WABISTAY_PAID_BY_BOOKING_REF = flag;
  const wh = freshWebhook();
  const ctx = { airtable: new MockAirtable(seed(seedOpts)), sends: [], axiom: [] };
  installFetch(ctx);
  await wh({ method: 'POST', body: metaTextPayload(from, text) }, makeRes());
  return { ctx, wh };
}
const row = ctx => ctx.airtable.tables['WS_Bookings'][0].fields;
const bodies = (ctx, to) => ctx.sends.filter(s => s.to === to).map(s => s.body || '');
const events = (ctx, n) => ctx.axiom.filter(e => e.event === n);

// ── grammar ──────────────────────────────────────────────────────────────────

test('parse, flag on: the booking reference is accepted in the shapes reception types, normalised to WS-XXXXXX', () => {
  process.env.WABISTAY_PAID_BY_BOOKING_REF = '1';
  const { parsePaidCommand } = freshWebhook();
  const want = { ok: true, refToken: 'WS-KEGGQF', refKind: 'booking', amount: 250, method: null };
  for (const t of ['PAID REF WS-KEGGQF 250', 'paid ref ws-keggqf r250', 'PAID REF WSKEGGQF 250', 'paid ref ws-KEGGQF 250.00', 'collected ref WS-KEGGQF 250,00']) {
    assert.deepStrictEqual(parsePaidCommand(t), want, t);
  }
  assert.deepStrictEqual(parsePaidCommand('PAID REF WS-KEGGQF 250 cash'), { ...want, method: 'Cash' });
  assert.deepStrictEqual(parsePaidCommand('PAID REF WS-KEGGQF 0'), { ok: false, reason: 'bad_amount' });
});

test('parse, flag on: the 4-character payment reference and PAID ROOM parse exactly as before', () => {
  process.env.WABISTAY_PAID_BY_BOOKING_REF = '1';
  const { parsePaidCommand } = freshWebhook();
  assert.deepStrictEqual(parsePaidCommand('PAID REF ab3d 400'), { ok: true, refToken: 'AB3D', amount: 400, method: null });
  assert.deepStrictEqual(parsePaidCommand('PAID ROOM 2 500'), { ok: true, roomToken: '2', amount: 500, method: null });
});

test('parse, flag off: a booking reference is a syntax error, as today', () => {
  delete process.env.WABISTAY_PAID_BY_BOOKING_REF;
  const { parsePaidCommand } = freshWebhook();
  assert.deepStrictEqual(parsePaidCommand('PAID REF WS-KEGGQF 250'), { ok: false, reason: 'bad_syntax' });
});

// ── recording a payment ──────────────────────────────────────────────────────

test('flag on: a card booking with no payment reference is settled by its booking reference; the method on the booking is kept', async () => {
  const { ctx } = await say(RECEPTION, 'PAID REF WS-KEGGQF 250', { flag: '1' });
  assert.strictEqual(row(ctx)['Payment Status'], 'Paid');
  assert.strictEqual(row(ctx)['Amount Paid'], 250);
  assert.strictEqual(row(ctx)['Payment Method'], 'Card');
  assert.ok(row(ctx)['Paid At']);
  assert.strictEqual(row(ctx)['Status'], 'Confirmed', 'payment alone does not check anyone in');
  const reply = bodies(ctx, RECEPTION).join('\n');
  assert.match(reply, /Payment recorded/);
  assert.match(reply, /WS-KEGGQF/);
  assert.match(reply, /Room 01/);
  assert.strictEqual(ctx.sends.filter(s => s.to === GUEST).length, 0, 'the guest is not messaged');
  assert.strictEqual(ctx.airtable.tables['WS_Rooms'][0].fields['Status'], 'Available', 'the room is untouched');
});

test('flag on: lowercase / no-hyphen references and an explicit method also work', async () => {
  const a = await say(RECEPTION, 'paid ref wskeggqf 250 eft', { flag: 'true' });
  assert.strictEqual(row(a.ctx)['Payment Status'], 'Paid');
  assert.strictEqual(row(a.ctx)['Payment Method'], 'EFT', 'an explicit method overrides the booking\'s');
});

test('flag on: a wrong amount is refused and nothing is recorded', async () => {
  const { ctx } = await say(RECEPTION, 'PAID REF WS-KEGGQF 200', { flag: '1' });
  assert.strictEqual(row(ctx)['Payment Status'], 'Unpaid');
  assert.strictEqual(row(ctx)['Amount Paid'], undefined);
  assert.match(bodies(ctx, RECEPTION).join('\n'), /doesn't match what's owed/);
  assert.strictEqual(events(ctx, 'payment_amount_mismatch').length, 1);
});

test('flag on: an already-paid booking is not paid twice', async () => {
  const { ctx } = await say(RECEPTION, 'PAID REF WS-KEGGQF 250', { flag: '1', seedOpts: { booking: { 'Payment Status': 'Paid', 'Amount Paid': 250 } } });
  assert.match(bodies(ctx, RECEPTION).join('\n'), /Already recorded/);
  assert.strictEqual(events(ctx, 'payment_recorded').length, 0);
});

test('flag on: an unknown booking reference is "no booking found", nothing recorded', async () => {
  const { ctx } = await say(RECEPTION, 'PAID REF WS-ZZZZZZ 250', { flag: '1' });
  assert.match(bodies(ctx, RECEPTION).join('\n'), /No booking found for reference WS-ZZZZZZ/);
  assert.strictEqual(row(ctx)['Payment Status'], 'Unpaid');
});

test('flag on: a cancelled booking cannot be paid by reference', async () => {
  const { ctx } = await say(RECEPTION, 'PAID REF WS-KEGGQF 250', { flag: '1', seedOpts: { booking: { 'Status': 'Cancelled' } } });
  assert.match(bodies(ctx, RECEPTION).join('\n'), /No booking found/);
  assert.strictEqual(row(ctx)['Payment Status'], 'Unpaid');
});

test('flag on: a booking that has already checked in or out can be settled by its reference too', async () => {
  for (const status of ['Checked In', 'Checked Out']) {
    const { ctx } = await say(RECEPTION, 'PAID REF WS-KEGGQF 250', { flag: '1', seedOpts: { booking: { 'Status': status } } });
    assert.strictEqual(row(ctx)['Payment Status'], 'Paid', status);
  }
});

test('flag on: another property\'s booking is refused (wrong property), nothing recorded', async () => {
  const { ctx } = await say(RECEPTION, 'PAID REF WS-KEGGQF 250', { flag: '1', seedOpts: { booking: { 'Room': ['recR9'], 'WS_Property': ['recP2'] } } });
  assert.match(bodies(ctx, RECEPTION).join('\n'), /different property/);
  assert.strictEqual(row(ctx)['Payment Status'], 'Unpaid');
});

test('flag on: a sender who is not a Reception seat gets nothing special — no leak, nothing recorded', async () => {
  const { ctx } = await say(OUTSIDER, 'PAID REF WS-KEGGQF 250', { flag: '1' });
  assert.strictEqual(row(ctx)['Payment Status'], 'Unpaid');
  assert.strictEqual(events(ctx, 'paid_unauthorised_sender').length, 1);
  assert.ok(!bodies(ctx, OUTSIDER).some(b => /Payment recorded|PAID REF/.test(b)));
});

test('flag on: the 4-character payment reference path still records a payment', async () => {
  const { ctx } = await say(RECEPTION, 'PAID REF AB3D 250', { flag: '1', seedOpts: { booking: { 'Payment Reference': 'AB3D', 'Payment Method': 'EFT' } } });
  assert.strictEqual(row(ctx)['Payment Status'], 'Paid');
  assert.strictEqual(row(ctx)['Payment Method'], 'EFT');
});

// ── flag off and the usage text ──────────────────────────────────────────────

test('flag off: PAID REF WS-… is refused with today\'s usage text and records nothing', async () => {
  const { ctx } = await say(RECEPTION, 'PAID REF WS-KEGGQF 250');
  assert.strictEqual(row(ctx)['Payment Status'], 'Unpaid');
  const reply = bodies(ctx, RECEPTION).join('\n');
  assert.match(reply, /Payment format/);
  assert.ok(!/WS-ABC123/.test(reply), 'the booking-reference form is not advertised while the flag is off');
});

test('usage text: flag on mentions the booking-reference form; flag off is unchanged', async () => {
  const on = await say(RECEPTION, 'PAID garbage', { flag: '1' });
  assert.match(bodies(on.ctx, RECEPTION).join('\n'), /PAID REF WS-ABC123 500/);
  const off = await say(RECEPTION, 'PAID garbage');
  assert.match(bodies(off.ctx, RECEPTION).join('\n'), /PAID REF AB3D 500/);
  assert.ok(!/WS-ABC123/.test(bodies(off.ctx, RECEPTION).join('\n')));
});

test('the flag is on the cold-start flag list: off by default, on only for 1/true', () => {
  delete process.env.WABISTAY_PAID_BY_BOOKING_REF;
  assert.strictEqual(freshWebhook().wabistayFlagState().WABISTAY_PAID_BY_BOOKING_REF, 'off');
  for (const [v, exp] of [['1', 'on'], ['true', 'on'], ['yes', 'off']]) {
    process.env.WABISTAY_PAID_BY_BOOKING_REF = v;
    assert.strictEqual(freshWebhook().wabistayFlagState().WABISTAY_PAID_BY_BOOKING_REF, exp, v);
  }
});
