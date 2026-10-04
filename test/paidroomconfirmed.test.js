// test/paidroomconfirmed.test.js
// WABISTAY_PAID_ROOM_CONFIRMED. PAID ROOM n amount [CARD|EFT] also matches a CONFIRMED booking
// holding that room. Rule when a room carries several bookings: unpaid beats paid; Checked Out
// (latest first), then Checked In, then Confirmed; among Confirmed the nearest arrival wins,
// unless two unpaid Confirmed bookings arrive the same SAST day, which is refused with a request
// for the booking reference. Amount-must-match, already-paid, authorisation and "a paid Confirmed
// booking's room is not changed or released" all stay. Flag off: today's behaviour.
// In-memory only: MockAirtable + mocked fetch.

const { test, afterEach } = require('node:test');
const assert = require('node:assert');
const { installEnv, installFetch, makeRes, metaTextPayload, MockAirtable } = require('./harness');

installEnv();
const ENV = ['WABISTAY_PAID_ROOM_CONFIRMED', 'WABISTAY_PAID_BY_BOOKING_REF', 'WABISTAY_HOLD_RELEASE'];
const saved = Object.fromEntries(ENV.map(k => [k, process.env[k]]));
afterEach(() => { for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

const wh = require('../api/wabistay/webhook.js');
const RECEPTION = '27780384989';
const ON_DUTY = '27820000222';
const OUTSIDER = '27820000999';
const HOUR = 3600e3;
const iso = ms => new Date(ms).toISOString();

const USAGE = 'Payment format:\n\nPAID ROOM 2 500\n\nRoom, then the amount received. Add EFT or CARD at the end.\n\n(example: PAID Room 03 500 card)';

function booking(id, fields) {
  return { id, fields: { 'Guest': ['recG1'], 'Room': ['recR1'], 'Booking Type': 'Hourly', 'Amount Due': 250, 'Payment Status': 'Unpaid', 'Booking Ref': 'WS-' + id.slice(-6).toUpperCase(), ...fields } };
}
const confirmed = (id, extra = {}) => booking(id, { 'Status': 'Confirmed', 'Payment Method': 'Card', 'Check In': iso(Date.now() + HOUR), 'Check Out': iso(Date.now() + 3 * HOUR), ...extra });

function seed(bookings) {
  return {
    WS_Properties: [{ id: 'recP1', fields: { 'Property Name': 'Canary Street Guest Rooms', 'Phone Number ID': '111000111000', 'Notify Phone': '27831112222' } }],
    WS_Rooms: [
      { id: 'recR1', fields: { 'Room Name': 'Room 01', 'Room Number': 1, 'Status': 'Available', 'Property': ['recP1'], 'Active': true } },
      { id: 'recR3', fields: { 'Room Name': 'Room 03', 'Room Number': 3, 'Status': 'Available', 'Property': ['recP1'], 'Active': true } }
    ],
    WS_Roles: [
      { id: 'recRole1', fields: { 'Role Label': 'Reception', 'Role Type': 'Reception', 'Property': ['recP1'], 'Current Phone': RECEPTION, 'Active': true } },
      { id: 'recRole2', fields: { 'Role Label': 'On Duty', 'Role Type': 'On Duty', 'Property': ['recP1'], 'Current Phone': ON_DUTY, 'Active': true } }
    ],
    WS_Guests: [{ id: 'recG1', fields: { 'Guest Name': 'Mama Test', 'Phone Number': '27784896186', 'Session State': 'CONFIRMED' } }],
    WS_Cleaners: [], WS_Rates: [], WS_Enquiries: [],
    WS_Bookings: bookings
  };
}
async function say(bookings, from, text, { flag = '1', refFlag } = {}) {
  if (flag === null) delete process.env.WABISTAY_PAID_ROOM_CONFIRMED; else process.env.WABISTAY_PAID_ROOM_CONFIRMED = flag;
  if (refFlag === undefined) delete process.env.WABISTAY_PAID_BY_BOOKING_REF; else process.env.WABISTAY_PAID_BY_BOOKING_REF = refFlag;
  const ctx = { airtable: new MockAirtable(seed(bookings)), sends: [], axiom: [] };
  installFetch(ctx);
  await wh({ method: 'POST', body: metaTextPayload(from, text) }, makeRes());
  return ctx;
}
const row = (ctx, id) => ctx.airtable.tables['WS_Bookings'].find(b => b.id === id).fields;
const reply = (ctx, to = RECEPTION) => ctx.sends.filter(s => s.to === to).map(s => s.body).join('\n');
const events = (ctx, n) => ctx.axiom.filter(e => e.event === n);

// ── the new match ────────────────────────────────────────────────────────────

test('flag on: PAID ROOM settles a CONFIRMED booking that holds the room — method taken from the booking, nothing else touched', async () => {
  const ctx = await say([confirmed('recBookKEGGQF', { 'Hold Expires At': iso(Date.now() + HOUR) })], RECEPTION, 'PAID ROOM 1 250');
  const b = row(ctx, 'recBookKEGGQF');
  assert.strictEqual(b['Payment Status'], 'Paid');
  assert.strictEqual(b['Amount Paid'], 250);
  assert.strictEqual(b['Payment Method'], 'Card', 'the guest chose card; not overwritten with Cash');
  assert.ok(b['Paid At']);
  assert.match(reply(ctx), /Payment recorded[\s\S]*WS-KEGGQF[\s\S]*Room 01[\s\S]*R250\.00[\s\S]*Card/);
  assert.strictEqual(b['Status'], 'Confirmed', 'not checked in');
  assert.deepStrictEqual(b['Room'], ['recR1'], 'room link unchanged');
  assert.strictEqual(ctx.airtable.tables['WS_Rooms'][0].fields['Status'], 'Available', 'room status unchanged');
  assert.strictEqual(ctx.sends.filter(s => s.to === '27784896186').length, 0, 'the guest is not messaged');
});

test('flag off: the same command still finds nothing (today)', async () => {
  const ctx = await say([confirmed('recBookKEGGQF')], RECEPTION, 'PAID ROOM 1 250', { flag: null });
  assert.match(reply(ctx), /No booking found for Room 01/);
  assert.strictEqual(row(ctx, 'recBookKEGGQF')['Payment Status'], 'Unpaid');
});

test('typed method wins: CARD / EFT at the end; CASH still parses though it is not advertised', async () => {
  for (const [typed, expected] of [['card', 'Card'], ['EFT', 'EFT'], ['cash', 'Cash']]) {
    const ctx = await say([confirmed('recBookKEGGQF')], RECEPTION, `PAID Room 01 250 ${typed}`);
    assert.strictEqual(row(ctx, 'recBookKEGGQF')['Payment Method'], expected, typed);
  }
});

test('no recorded method on the booking: Cash, as before', async () => {
  const ctx = await say([confirmed('recBookKEGGQF', { 'Payment Method': undefined })], RECEPTION, 'PAID ROOM 1 250');
  assert.strictEqual(row(ctx, 'recBookKEGGQF')['Payment Method'], 'Cash');
});

// ── the rules that stay ──────────────────────────────────────────────────────

test('amount must equal Amount Due: a wrong amount is refused and nothing is recorded', async () => {
  const ctx = await say([confirmed('recBookKEGGQF')], RECEPTION, 'PAID ROOM 1 200');
  assert.match(reply(ctx), /doesn't match what's owed/);
  assert.strictEqual(row(ctx, 'recBookKEGGQF')['Payment Status'], 'Unpaid');
});

test('already paid: the already-recorded reply, nothing rewritten', async () => {
  const ctx = await say([confirmed('recBookKEGGQF', { 'Payment Status': 'Paid', 'Amount Paid': 250 })], RECEPTION, 'PAID ROOM 1 250');
  assert.match(reply(ctx), /Already recorded/);
  assert.strictEqual(events(ctx, 'payment_recorded').length, 0);
});

test('authorisation: Reception and On Duty may; anyone else falls through silently', async () => {
  for (const from of [RECEPTION, ON_DUTY]) {
    const ok = await say([confirmed('recBookKEGGQF')], from, 'PAID ROOM 1 250');
    assert.strictEqual(row(ok, 'recBookKEGGQF')['Payment Status'], 'Paid', from);
  }
  const no = await say([confirmed('recBookKEGGQF')], OUTSIDER, 'PAID ROOM 1 250');
  assert.strictEqual(row(no, 'recBookKEGGQF')['Payment Status'], 'Unpaid');
  assert.strictEqual(events(no, 'paid_unauthorised_sender').length, 1);
});

test('a paid Confirmed booking is not released by the hold sweep and keeps its room', async () => {
  process.env.WABISTAY_HOLD_RELEASE = '1';
  const ctx = await say([confirmed('recBookKEGGQF', { 'Hold Expires At': iso(Date.now() - HOUR) })], RECEPTION, 'PAID ROOM 1 250');
  assert.strictEqual(row(ctx, 'recBookKEGGQF')['Payment Status'], 'Paid');
  const summary = await wh.runHoldRelease(new Date());
  assert.strictEqual(summary.holdsReleased, 0);
  assert.strictEqual(row(ctx, 'recBookKEGGQF')['Status'], 'Confirmed');
  assert.deepStrictEqual(row(ctx, 'recBookKEGGQF')['Room'], ['recR1']);
  assert.ok(events(ctx, 'hold_expired_paid_skipped').length >= 1);
});

// ── the ambiguity rule ───────────────────────────────────────────────────────

test('unpaid beats paid: last night\'s settled stay no longer shadows tonight\'s Confirmed booking (flag on); flag off still answers "already recorded" for the old one', async () => {
  const old = booking('recBookOLD001', { 'Status': 'Checked Out', 'Payment Status': 'Paid', 'Amount Paid': 250, 'Check In': iso(Date.now() - 30 * HOUR), 'Check Out': iso(Date.now() - 28 * HOUR) });
  const on = await say([old, confirmed('recBookKEGGQF')], RECEPTION, 'PAID ROOM 1 250');
  assert.strictEqual(row(on, 'recBookKEGGQF')['Payment Status'], 'Paid');
  assert.match(reply(on), /WS-KEGGQF/);
  const off = await say([old, confirmed('recBookKEGGQF')], RECEPTION, 'PAID ROOM 1 250', { flag: null });
  assert.match(reply(off), /Already recorded[\s\S]*WS-OLD001/);
  assert.strictEqual(row(off, 'recBookKEGGQF')['Payment Status'], 'Unpaid');
});

test('Checked In is preferred over a Confirmed booking (the guest in the room)', async () => {
  const inHouse = booking('recBookINHOUS', { 'Status': 'Checked In', 'Check In': iso(Date.now() - HOUR), 'Check Out': iso(Date.now() + HOUR) });
  const ctx = await say([confirmed('recBookKEGGQF', { 'Check In': iso(Date.now() + 5 * HOUR) }), inHouse], RECEPTION, 'PAID ROOM 1 250');
  assert.strictEqual(row(ctx, 'recBookINHOUS')['Payment Status'], 'Paid');
  assert.strictEqual(row(ctx, 'recBookKEGGQF')['Payment Status'], 'Unpaid');
});

test('what existed before is unchanged: Checked Out ranks over Checked In when both are unpaid', async () => {
  const out = booking('recBookOUT001', { 'Status': 'Checked Out', 'Check In': iso(Date.now() - 6 * HOUR), 'Check Out': iso(Date.now() - 4 * HOUR) });
  const inn = booking('recBookINN001', { 'Status': 'Checked In', 'Check In': iso(Date.now() - HOUR), 'Check Out': iso(Date.now() + HOUR) });
  const ctx = await say([inn, out], RECEPTION, 'PAID ROOM 1 250');
  assert.strictEqual(row(ctx, 'recBookOUT001')['Payment Status'], 'Paid');
});

test('two Confirmed bookings on different days: the nearest arrival wins', async () => {
  const near = confirmed('recBookNEAR01', { 'Check In': iso(Date.now() + 2 * HOUR), 'Check Out': iso(Date.now() + 4 * HOUR) });
  const far = confirmed('recBookFAR001', { 'Check In': iso(Date.now() + 50 * HOUR), 'Check Out': iso(Date.now() + 52 * HOUR) });
  const ctx = await say([far, near], RECEPTION, 'PAID ROOM 1 250');
  assert.strictEqual(row(ctx, 'recBookNEAR01')['Payment Status'], 'Paid');
  assert.strictEqual(row(ctx, 'recBookFAR001')['Payment Status'], 'Unpaid');
});

test('two unpaid Confirmed bookings arriving the same SAST day: refused, nothing recorded, the booking reference is asked for', async () => {
  const a = confirmed('recBookSAMEA1', { 'Check In': iso(Date.now() + 1 * HOUR), 'Check Out': iso(Date.now() + 3 * HOUR) });
  const b = confirmed('recBookSAMEB1', { 'Check In': iso(Date.now() + 1.5 * HOUR), 'Check Out': iso(Date.now() + 3.5 * HOUR) });
  // keep both on the same SAST day whatever time the test runs
  const dayStart = Date.UTC(2030, 5, 10, 8, 0);
  a.fields['Check In'] = iso(dayStart); a.fields['Check Out'] = iso(dayStart + 2 * HOUR);
  b.fields['Check In'] = iso(dayStart + 5 * HOUR); b.fields['Check Out'] = iso(dayStart + 7 * HOUR);
  const ctx = await say([a, b], RECEPTION, 'PAID ROOM 1 250');
  assert.match(reply(ctx), /More than one booking could match Room 01, so nothing was recorded\. Please use the booking reference instead, for example: \*PAID REF WS-ABC123 500\*/);
  assert.strictEqual(row(ctx, 'recBookSAMEA1')['Payment Status'], 'Unpaid');
  assert.strictEqual(row(ctx, 'recBookSAMEB1')['Payment Status'], 'Unpaid');
  assert.strictEqual(events(ctx, 'paid_rejected')[0].reason, 'ambiguous_confirmed_bookings');
});

test('the booking reference resolves the ambiguity (PAID REF WS-… needs WABISTAY_PAID_BY_BOOKING_REF)', async () => {
  const dayStart = Date.UTC(2030, 5, 10, 8, 0);
  const a = confirmed('recBookSAMEA1', { 'Check In': iso(dayStart), 'Check Out': iso(dayStart + 2 * HOUR) });
  const b = confirmed('recBookSAMEB1', { 'Check In': iso(dayStart + 5 * HOUR), 'Check Out': iso(dayStart + 7 * HOUR) });
  const ctx = await say([a, b], RECEPTION, 'PAID REF WS-SAMEB1 250', { refFlag: '1' });
  assert.strictEqual(row(ctx, 'recBookSAMEB1')['Payment Status'], 'Paid');
  assert.strictEqual(row(ctx, 'recBookSAMEA1')['Payment Status'], 'Unpaid');
});

test('pickBookingForPaidRoom: pure rule checks', () => {
  const now = Date.UTC(2030, 5, 10, 8, 0);
  const mk = (id, status, paid, checkIn, checkOut) => ({ id, fields: { 'Status': status, 'Payment Status': paid ? 'Paid' : 'Unpaid', 'Check In': iso(checkIn), 'Check Out': iso(checkOut) } });
  assert.deepStrictEqual(wh.pickBookingForPaidRoom([], now), { booking: null });
  const allPaid = [mk('a', 'Checked Out', true, now - 9 * HOUR, now - 8 * HOUR), mk('b', 'Confirmed', true, now + HOUR, now + 2 * HOUR)];
  assert.strictEqual(wh.pickBookingForPaidRoom(allPaid, now).booking.id, 'a', 'all paid: the same order picks the one to report');
  const one = [mk('a', 'Checked Out', true, now - 9 * HOUR, now - 8 * HOUR), mk('b', 'Confirmed', false, now + HOUR, now + 2 * HOUR)];
  assert.strictEqual(wh.pickBookingForPaidRoom(one, now).booking.id, 'b');
});

// ── usage text and the other forms ───────────────────────────────────────────

test('flag on: the usage text is exactly the agreed one — no mention of cash or references', async () => {
  const ctx = await say([], RECEPTION, 'PAID garbage');
  assert.strictEqual(reply(ctx), USAGE);
  assert.ok(!/cash|ref/i.test(reply(ctx).replace('PAID ROOM', '').replace('PAID Room', '')));
  const both = await say([], RECEPTION, 'PAID garbage', { refFlag: '1' });
  assert.strictEqual(reply(both), USAGE, 'wins over the booking-reference usage text');
  assert.strictEqual(require('../states.json').messages.paidUsageRoomOnly, USAGE);
});

test('flag off: the usage text is today\'s', async () => {
  const ctx = await say([], RECEPTION, 'PAID garbage', { flag: null });
  assert.match(reply(ctx), /Add CASH, EFT or CARD at the end if it wasn't cash\.[\s\S]*PAID REF AB3D 500/);
});

test('PAID REF (payment reference) and COLLECTED keep working with the flag on, unadvertised', async () => {
  const ref = await say([confirmed('recBookKEGGQF', { 'Payment Reference': 'AB3D', 'Payment Method': 'EFT' })], RECEPTION, 'PAID REF AB3D 250');
  assert.strictEqual(row(ref, 'recBookKEGGQF')['Payment Status'], 'Paid');
  assert.strictEqual(row(ref, 'recBookKEGGQF')['Payment Method'], 'EFT');
  const col = await say([confirmed('recBookKEGGQF')], RECEPTION, 'COLLECTED ROOM 1 250');
  assert.strictEqual(row(col, 'recBookKEGGQF')['Payment Status'], 'Paid');
});

test('the flag is on the cold-start flag list: off by default, on only for 1/true', () => {
  const fresh = () => { delete require.cache[require.resolve('../api/wabistay/webhook.js')]; return require('../api/wabistay/webhook.js'); };
  delete process.env.WABISTAY_PAID_ROOM_CONFIRMED;
  assert.strictEqual(fresh().wabistayFlagState().WABISTAY_PAID_ROOM_CONFIRMED, 'off');
  for (const [v, exp] of [['1', 'on'], ['true', 'on'], ['yes', 'off']]) {
    process.env.WABISTAY_PAID_ROOM_CONFIRMED = v;
    assert.strictEqual(fresh().wabistayFlagState().WABISTAY_PAID_ROOM_CONFIRMED, exp, v);
  }
});
