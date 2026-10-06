// test/oneopenbooking.test.js
// WABISTAY_ONE_OPEN_BOOKING and WABISTAY_GATE_REQUIRES_BOOKING.
// Live bug, Tue 6 Oct 2026: WS-D4NUMZ (3 hours, R300, Room 02, created 15:33, arrival 16:00, never paid) was still
// Confirmed at 18:53 when the guest booked WS-PSG4VQ (Overnight, R500, Room 01); the 18:54 gate tap used the OLD one.
//   ONE_OPEN_BOOKING: a booking becoming Confirmed cancels the guest's other unpaid, unchecked-in Enquiry/Confirmed
//     bookings at the same property (not one on a later day, never paid / checked in), Notify Phone told once, a failed
//     notice never blocks; gate + payment-method step pick the open booking nearest to now (newest on a tie);
//     cancel / ETA / checkout / extend pick the newest.
//   GATE_REQUIRES_BOOKING: no Confirmed booking at the gate = "couldn't find a booking", NEW, nothing else.
// Time is mocked (SAST = UTC+2). In-memory only: MockAirtable + mocked fetch.

const { test, mock, afterEach } = require('node:test');
const assert = require('node:assert');
const { installEnv, installFetch, makeRes, metaTextPayload, MockAirtable } = require('./harness');

installEnv();
const ENV = ['WABISTAY_ONE_OPEN_BOOKING', 'WABISTAY_GATE_REQUIRES_BOOKING', 'WABISTAY_GATE_ALERT_UNPAID', 'WABISTAY_STAY_MENU', 'WABISTAY_PAY_ASSIGNS_ROOM', 'WABISTAY_LEAN_COPY'];
const saved = Object.fromEntries(ENV.map(k => [k, process.env[k]]));
afterEach(() => {
  mock.timers.reset();
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

const wh = require('../api/wabistay/webhook.js');
const GUEST = '27736880175';
const NOTIFY = '27831112222';
const sast = (h, m = 0, d = 6) => Date.UTC(2026, 9, d, h - 2, m);
const iso = (h, m = 0, d = 6) => new Date(sast(h, m, d)).toISOString();
function setClock(h, m = 0, d = 6) { mock.timers.reset(); mock.timers.enable({ apis: ['Date'], now: sast(h, m, d) }); }

const NO_BOOKING_TEXT = "We couldn't find a booking for you. Reply hi to start a new booking.";

function booking(id, fields, createdTime) {
  return {
    id, ...(createdTime ? { createdTime } : {}),
    fields: { 'Guest': ['recG1'], 'Booking Type': 'Hourly', 'Status': 'Confirmed', 'Payment Status': 'Unpaid', 'Amount Due': 300, 'Booking Ref': 'WS-' + id.slice(-6).toUpperCase(), ...fields }
  };
}
// WS-D4NUMZ: 3 hours, R300, Room 02, 16:00-19:00 SAST, created 15:33.
const d4 = (extra = {}) => booking('recBookD4NUMZ', {
  'Room': ['recR2'], 'Check In': iso(16), 'Check Out': iso(19), 'Amount Due': 300, 'Payment Method': 'Card', ...extra
}, iso(15, 33));

function seed({ state = 'CONFIRMED', testPhone = false, bookings = [], noGuest = false } = {}) {
  return {
    WS_Properties: [
      { id: 'recP1', fields: { 'Property Name': 'Canary Street Guest Rooms', 'Phone Number ID': '111000111000', 'City': 'Boksburg', 'Notify Phone': NOTIFY, 'Hourly Rate 1hr': 120, 'Hourly Rate 2hr': 250, 'Hourly Rate 3hr': 300 } },
      { id: 'recP2', fields: { 'Property Name': 'Other Lodge', 'Phone Number ID': '999000999000' } }
    ],
    WS_Rooms: [
      { id: 'recR1', fields: { 'Room Name': 'Room 01', 'Room Number': 1, 'Status': 'Available', 'Property': ['recP1'], 'Active': true } },
      { id: 'recR2', fields: { 'Room Name': 'Room 02', 'Room Number': 2, 'Status': 'Available', 'Property': ['recP1'], 'Active': true } },
      { id: 'recRX', fields: { 'Room Name': 'Other Room', 'Room Number': 1, 'Status': 'Available', 'Property': ['recP2'], 'Active': true } }
    ],
    WS_Rates: [{ id: 'recRateNight', fields: { 'Rate Name': 'Standard Night', 'Rate Type': 'Per Night', 'Amount': 500, 'Active': true, 'Property': ['recP1'] } }],
    WS_Cleaners: [], WS_Enquiries: [], WS_Roles: [],
    WS_Guests: noGuest ? [] : [{ id: 'recG1', fields: { 'Guest Name': 'Robson Tembo', 'Phone Number': GUEST, 'Session State': state, ...(testPhone ? { 'Test Phone': true } : {}) } }],
    WS_Bookings: bookings
  };
}
function start(opts = {}, env = {}) {
  const set = (k, v) => { if (v === null || v === undefined) delete process.env[k]; else process.env[k] = v; };
  set('WABISTAY_ONE_OPEN_BOOKING', env.one === undefined ? '1' : env.one);
  set('WABISTAY_GATE_REQUIRES_BOOKING', env.gate === undefined ? '1' : env.gate);
  set('WABISTAY_GATE_ALERT_UNPAID', '1');
  set('WABISTAY_STAY_MENU', env.menu === undefined ? null : env.menu);
  set('WABISTAY_PAY_ASSIGNS_ROOM', null);
  const ctx = { airtable: new MockAirtable(seed(opts)), sends: [], axiom: [] };
  installFetch(ctx);
  if (env.failNotify) {
    const inner = global.fetch;
    global.fetch = async (url, o = {}) => {
      if (String(url).includes('graph.facebook.com') && JSON.parse(o.body).to === NOTIFY) {
        return { status: 400, json: async () => ({ error: { code: 131047, message: 'window closed' } }) };
      }
      return inner(url, o);
    };
  }
  return ctx;
}
const say = (text, from = GUEST) => wh({ method: 'POST', body: metaTextPayload(from, text) }, makeRes());
const bookings = ctx => ctx.airtable.tables['WS_Bookings'];
const byId = (ctx, id) => bookings(ctx).find(b => b.id === id);
const guestRow = ctx => ctx.airtable.tables['WS_Guests'][0].fields;
const room = (ctx, id) => ctx.airtable.tables['WS_Rooms'].find(r => r.id === id).fields;
const texts = (ctx, to = GUEST) => ctx.sends.filter(s => s.type === 'text' && s.to === to).map(s => s.body);
const events = (ctx, n) => ctx.axiom.filter(e => e.event === n);
const superseded = ctx => texts(ctx, NOTIFY).filter(t => /earlier unpaid booking was cancelled/.test(t));

// ── the exact live sequence: 15:33 / 18:53 / 18:54 ───────────────────────────

async function liveSequence(opts = {}, env = {}) {
  setClock(15, 33);
  const ctx = start({ state: 'NEW', bookings: [d4()], ...opts }, env);   // D4NUMZ made at 15:33; the guest was then reset to NEW
  setClock(18, 53);
  await say('hi');                                // greeting
  await say('2');                                 // multiple days
  await say('Robson Tembo\n6 Oct\n7 Oct');        // overnight request: WS-PSG4VQ is created as an Enquiry in Room 01
  await say('1');                                 // card
  await say('around 7pm');                        // arrival time: PSG4VQ becomes Confirmed
  return ctx;
}
const newOne = ctx => bookings(ctx).find(b => b.id !== 'recBookD4NUMZ');

test('15:33 / 18:53 / 18:54 with the flags on: PSG4VQ replaces D4NUMZ, reception told once, and the gate tap uses PSG4VQ (R500, Room 01)', async () => {
  const ctx = await liveSequence();
  const psg = newOne(ctx);
  assert.strictEqual(psg.fields['Booking Type'], 'Overnight');
  assert.strictEqual(psg.fields['Status'], 'Confirmed');
  assert.deepStrictEqual(psg.fields['Room'], ['recR1']);
  assert.strictEqual(psg.fields['Amount Due'], 500);
  assert.strictEqual(byId(ctx, 'recBookD4NUMZ').fields['Status'], 'Cancelled', 'the older unpaid booking is cancelled');
  assert.strictEqual(superseded(ctx).length, 1, 'reception (Notify Phone) told exactly once');
  assert.match(superseded(ctx)[0], /Robson Tembo/);
  assert.match(superseded(ctx)[0], /WS-D4NUMZ \(Hourly, Room 02\)/);

  setClock(18, 54);
  assert.strictEqual(guestRow(ctx)['Session State'], 'CONFIRMED');
  await say('1');                                 // the gate tap
  const owner = texts(ctx, NOTIFY).filter(t => /has not paid yet/.test(t)).slice(-1)[0];
  assert.ok(owner, 'the unpaid-gate alert went out');
  assert.match(owner, new RegExp('Booking: ' + psg.fields['Booking Ref']));
  assert.match(owner, /Amount due: R500/);
  assert.match(owner, /Room 01 is held/);
  assert.ok(!/R300|D4NUMZ|Room 02/.test(owner), 'not the old booking');
  assert.strictEqual(byId(ctx, 'recBookD4NUMZ').fields['Status'], 'Cancelled');
  assert.strictEqual(room(ctx, 'recR2')['Status'], 'Available');
});

test('the same sequence with both flags OFF reproduces today: D4NUMZ stays Confirmed and the gate tap uses it (R300, Room 02)', async () => {
  const ctx = await liveSequence({}, { one: null, gate: null });
  assert.strictEqual(byId(ctx, 'recBookD4NUMZ').fields['Status'], 'Confirmed');
  assert.strictEqual(superseded(ctx).length, 0);
  setClock(18, 54);
  await say('1');
  const owner = texts(ctx, NOTIFY).filter(t => /has not paid yet/.test(t)).slice(-1)[0];
  assert.match(owner, /Booking: WS-D4NUMZ/);
  assert.match(owner, /Amount due: R300/);
  assert.match(owner, /Room 02 is held/);
});

test('a test phone is superseded exactly like a real guest', async () => {
  const ctx = await liveSequence({ testPhone: true });
  assert.strictEqual(byId(ctx, 'recBookD4NUMZ').fields['Status'], 'Cancelled');
  assert.strictEqual(superseded(ctx).length, 1);
  setClock(18, 54);
  await say('1');
  assert.match(texts(ctx, NOTIFY).filter(t => /has not paid yet/.test(t)).slice(-1)[0], /Amount due: R500/);
});

// ── what supersede never touches ─────────────────────────────────────────────

test('a paid older booking is never cancelled; neither is one with money received or already checked in', async () => {
  for (const extra of [{ 'Payment Status': 'Paid' }, { 'Amount Paid': 300 }, { 'Checked In At': iso(16, 5) }]) {
    const ctx = await liveSequence({ bookings: [d4(extra)] });
    assert.strictEqual(byId(ctx, 'recBookD4NUMZ').fields['Status'], 'Confirmed', JSON.stringify(extra));
    assert.strictEqual(superseded(ctx).length, 0, JSON.stringify(extra));
  }
});

test('a Checked In older booking is never cancelled', async () => {
  const ctx = await liveSequence({ bookings: [d4({ 'Status': 'Checked In', 'Checked In At': iso(16, 5) })] });
  assert.strictEqual(byId(ctx, 'recBookD4NUMZ').fields['Status'], 'Checked In');
});

test('an older booking on a LATER DAY is left alone (a real future stay), a same-day one is not (an overnight is stamped 14:00, earlier than a 16:00 short stay)', async () => {
  const future = d4({ 'Check In': iso(14, 0, 9), 'Check Out': iso(10, 0, 10), 'Room': ['recR2'], 'Booking Type': 'Overnight' });
  const ctx = await liveSequence({ bookings: [future] });
  assert.strictEqual(byId(ctx, 'recBookD4NUMZ').fields['Status'], 'Confirmed', 'future stay untouched');
  assert.strictEqual(superseded(ctx).length, 0);
  const sameDay = await liveSequence();
  assert.strictEqual(byId(sameDay, 'recBookD4NUMZ').fields['Status'], 'Cancelled');
});

test('an older booking at another property is left alone', async () => {
  const other = d4({ 'Room': ['recRX'] });
  const ctx = await liveSequence({ bookings: [other] });
  assert.strictEqual(byId(ctx, 'recBookD4NUMZ').fields['Status'], 'Confirmed');
  assert.strictEqual(superseded(ctx).length, 0);
});

test('another guest\'s open booking is never touched', async () => {
  const theirs = booking('recBookOTHER1', { 'Guest': ['recG9'], 'Room': ['recR2'], 'Check In': iso(16), 'Check Out': iso(19) }, iso(15, 0));
  const ctx = await liveSequence({ bookings: [theirs] });
  assert.strictEqual(byId(ctx, 'recBookOTHER1').fields['Status'], 'Confirmed');
});

test('a failed reception notice never blocks the cancel (the booking is Cancelled and the failure is logged)', async () => {
  const ctx = await liveSequence({}, { failNotify: true });
  assert.strictEqual(byId(ctx, 'recBookD4NUMZ').fields['Status'], 'Cancelled');
  assert.strictEqual(events(ctx, 'booking_superseded_notice_failed').length, 1);
  assert.strictEqual(newOne(ctx).fields['Status'], 'Confirmed');
  assert.strictEqual(guestRow(ctx)['Session State'], 'CONFIRMED');
});

test('two older unpaid bookings are both cancelled and reception gets ONE line', async () => {
  const second = booking('recBookSECOND1', { 'Room': ['recR2'], 'Check In': iso(17), 'Check Out': iso(19), 'Amount Due': 250 }, iso(16, 0));
  const ctx = await liveSequence({ bookings: [d4(), second] });
  assert.strictEqual(byId(ctx, 'recBookD4NUMZ').fields['Status'], 'Cancelled');
  assert.strictEqual(byId(ctx, 'recBookSECOND1').fields['Status'], 'Cancelled');
  assert.strictEqual(superseded(ctx).length, 1);
});

// ── the other two confirm points ─────────────────────────────────────────────

test('the old short-stay flow: confirming the duration cancels the older unpaid booking', async () => {
  setClock(15, 33);
  const ctx = start({ state: 'NEW', bookings: [d4({ 'Check In': iso(15, 0), 'Check Out': iso(18, 0) })] });
  setClock(16, 40);
  await say('hi'); await say('1'); await say('Robson Tembo\n5pm'); await say('2');
  const fresh = newOne(ctx);
  assert.strictEqual(fresh.fields['Status'], 'Confirmed');
  assert.strictEqual(byId(ctx, 'recBookD4NUMZ').fields['Status'], 'Cancelled');
  assert.strictEqual(superseded(ctx).length, 1);
});

test('the stay-menu flow: confirming the name and time cancels the older unpaid booking', async () => {
  setClock(15, 33);
  const ctx = start({ state: 'AWAITING_STAY_TYPE', bookings: [d4()] }, { menu: '1' });
  setClock(15, 40);
  await say('1');                                  // 2 hours
  await say('Robson Tembo\n4pm');
  assert.strictEqual(newOne(ctx).fields['Status'], 'Confirmed');
  assert.strictEqual(byId(ctx, 'recBookD4NUMZ').fields['Status'], 'Cancelled');
  assert.strictEqual(superseded(ctx).length, 1);
});

// ── which booking is picked ──────────────────────────────────────────────────

const A = (extra = {}) => booking('recBookAAAAAA', { 'Room': ['recR2'], 'Check In': iso(16), 'Check Out': iso(19), 'Amount Due': 300, ...extra }, iso(15, 0));
const B = (extra = {}) => booking('recBookBBBBBB', { 'Room': ['recR1'], 'Check In': iso(19, 30), 'Check Out': iso(22), 'Amount Due': 250, ...extra }, iso(16, 0));

test('gate: the open booking whose check-in is nearest to now is used, not the oldest', async () => {
  setClock(18, 54);
  const ctx = start({ bookings: [A(), B()] });         // A 16:00 (2h54m ago, older), B 19:30 (36 min ahead, newer)
  await say('1');
  const owner = texts(ctx, NOTIFY).filter(t => /has not paid yet/.test(t))[0];
  assert.match(owner, /Booking: WS-BBBBBB/);
  assert.match(owner, /Amount due: R250/);
});

test('gate: a tie on distance goes to the newest by createdTime', async () => {
  setClock(18, 0);
  const a = A({ 'Check In': iso(17, 0), 'Check Out': iso(20) });
  const b = B({ 'Check In': iso(19, 0), 'Check Out': iso(22) });    // 1 hour either side of 18:00
  const ctx = start({ bookings: [a, b] });
  await say('1');
  assert.match(texts(ctx, NOTIFY).filter(t => /has not paid yet/.test(t))[0], /Booking: WS-BBBBBB/, 'newer wins the tie');
  const ctx2 = start({ bookings: [{ ...a, createdTime: iso(17, 0) }, { ...b, createdTime: iso(16, 0) }] });
  await say('1');
  assert.match(texts(ctx2, NOTIFY).filter(t => /has not paid yet/.test(t))[0], /Booking: WS-AAAAAA/, 'and the other way round');
});

test('gate with the flag off still takes the first booking Airtable returns (today)', async () => {
  setClock(18, 54);
  const ctx = start({ bookings: [A(), B()] }, { one: null });
  await say('1');
  assert.match(texts(ctx, NOTIFY).filter(t => /has not paid yet/.test(t))[0], /Booking: WS-AAAAAA/);
});

test('payment method: the NEWEST priced booking gets the method, not the oldest, even when the older one is nearer to now', async () => {
  setClock(18, 54);
  const ctx = start({ state: 'AWAITING_PAYMENT_METHOD', bookings: [A({ 'Check In': iso(18, 30), 'Check Out': iso(21) }), B({ 'Check In': iso(23, 0), 'Check Out': iso(23, 50) })] });
  await say('2');                                      // EFT
  assert.strictEqual(byId(ctx, 'recBookBBBBBB').fields['Payment Method'], 'EFT');
  assert.strictEqual(byId(ctx, 'recBookAAAAAA').fields['Payment Method'], undefined);
  const off = start({ state: 'AWAITING_PAYMENT_METHOD', bookings: [A(), B()] }, { one: null });
  await say('2');
  assert.strictEqual(byId(off, 'recBookAAAAAA').fields['Payment Method'], 'EFT', 'flag off: the first, as today');
});

test('the guest\'s own cancel (2) cancels the newest Confirmed booking, not the oldest', async () => {
  setClock(18, 54);
  const ctx = start({ bookings: [A(), B()] });
  await say('2');
  assert.strictEqual(byId(ctx, 'recBookBBBBBB').fields['Status'], 'Cancelled');
  assert.strictEqual(byId(ctx, 'recBookAAAAAA').fields['Status'], 'Confirmed');
  const off = start({ bookings: [A(), B()] }, { one: null });
  await say('2');
  assert.strictEqual(byId(off, 'recBookAAAAAA').fields['Status'], 'Cancelled', 'flag off: the oldest, as today');
});

test('the arrival-time step (overnight) confirms the newest Enquiry', async () => {
  setClock(18, 54);
  const e1 = booking('recBookENQ111', { 'Status': 'Enquiry', 'Booking Type': 'Overnight', 'Room': ['recR2'], 'Check In': iso(14, 0, 8), 'Check Out': iso(10, 0, 9), 'Amount Due': 500 }, iso(15, 0));
  const e2 = booking('recBookENQ222', { 'Status': 'Enquiry', 'Booking Type': 'Overnight', 'Room': ['recR1'], 'Check In': iso(14, 0, 8), 'Check Out': iso(10, 0, 9), 'Amount Due': 500 }, iso(16, 0));
  const ctx = start({ state: 'AWAITING_ETA', bookings: [e1, e2] });
  await say('around 7pm');
  assert.strictEqual(byId(ctx, 'recBookENQ222').fields['Status'], 'Confirmed');
});

test('checkout and extend act on the newest Checked In booking', async () => {
  setClock(18, 0);
  const inA = A({ 'Status': 'Checked In', 'Checked In At': iso(16, 0), 'Payment Status': 'Paid', 'Check Out': iso(19) });
  const inB = B({ 'Status': 'Checked In', 'Checked In At': iso(17, 0), 'Payment Status': 'Paid', 'Check In': iso(17, 0), 'Check Out': iso(20) });
  const ctx = start({ state: 'CHECKED_IN', bookings: [inA, inB] });
  await say('1');                                      // checkout
  assert.strictEqual(byId(ctx, 'recBookBBBBBB').fields['Status'], 'Checked Out');
  assert.strictEqual(byId(ctx, 'recBookAAAAAA').fields['Status'], 'Checked In');
  const ext = start({ state: 'CHECKED_IN', bookings: [A({ 'Status': 'Checked In', 'Checked In At': iso(16, 0), 'Payment Status': 'Paid' }), B({ 'Status': 'Checked In', 'Checked In At': iso(17, 0), 'Payment Status': 'Paid', 'Check In': iso(17, 0), 'Check Out': iso(20) })] });
  await say('extend');
  assert.notStrictEqual(byId(ext, 'recBookBBBBBB').fields['Check Out'], iso(20), 'the newest booking was the one extended');
  assert.strictEqual(byId(ext, 'recBookAAAAAA').fields['Check Out'], iso(19));
});

test('PAID ROOM is unchanged by the flag: it still pays the booking on the room it names', async () => {
  setClock(18, 54);
  process.env.WABISTAY_PAID_ROOM_CONFIRMED = '1';
  try {
    const ctx = start({ bookings: [A(), B()] });
    ctx.airtable.tables['WS_Roles'].push({ id: 'recRole1', fields: { 'Role Label': 'Reception', 'Role Type': 'Reception', 'Property': ['recP1'], 'Current Phone': '27780384989', 'Active': true } });
    await say('PAID ROOM 2 300 card', '27780384989');
    assert.strictEqual(byId(ctx, 'recBookAAAAAA').fields['Payment Status'], 'Paid');
    assert.strictEqual(byId(ctx, 'recBookBBBBBB').fields['Payment Status'], 'Unpaid');
  } finally { delete process.env.WABISTAY_PAID_ROOM_CONFIRMED; }
});

// ── GATE_REQUIRES_BOOKING ────────────────────────────────────────────────────

test('gate tap with no Confirmed booking: the exact message, state NEW, no room, no check-in, no alert', async () => {
  setClock(18, 54);
  const ctx = start({ state: 'CONFIRMED', bookings: [d4({ 'Status': 'Cancelled' })] });
  await say('1');
  assert.deepStrictEqual(texts(ctx), [NO_BOOKING_TEXT]);
  assert.strictEqual(guestRow(ctx)['Session State'], 'NEW');
  assert.strictEqual(room(ctx, 'recR1')['Status'], 'Available');
  assert.strictEqual(room(ctx, 'recR2')['Status'], 'Available');
  assert.strictEqual(byId(ctx, 'recBookD4NUMZ').fields['Status'], 'Cancelled');
  assert.strictEqual(ctx.sends.filter(s => s.to !== GUEST).length, 0, 'no alert to anyone');
  assert.strictEqual(events(ctx, 'gate_arrival_no_booking').length, 1);
});

test('the same tap with the flag off reproduces today: a free room is assigned and the guest is checked in with no booking', async () => {
  setClock(18, 54);
  const ctx = start({ state: 'CONFIRMED', bookings: [] }, { gate: null });
  await say('1');
  assert.strictEqual(guestRow(ctx)['Session State'], 'CHECKED_IN');
  assert.match(texts(ctx)[0], /Your room is \*Room 01\*/);
  assert.strictEqual(room(ctx, 'recR1')['Status'], 'Occupied');
});

test('a test phone with no booking gets the same message', async () => {
  setClock(18, 54);
  const ctx = start({ state: 'CONFIRMED', testPhone: true, bookings: [] });
  await say('1');
  assert.deepStrictEqual(texts(ctx), [NO_BOOKING_TEXT]);
  assert.strictEqual(guestRow(ctx)['Session State'], 'NEW');
});

test('a booking with no dates keeps the old path with the flag on (paid, so it is let through)', async () => {
  setClock(18, 54);
  const legacy = booking('recBookLEGACY', { 'Room': undefined, 'Amount Due': undefined, 'Payment Status': 'Paid' }, iso(10, 0));
  delete legacy.fields['Room']; delete legacy.fields['Amount Due'];
  const ctx = start({ state: 'CONFIRMED', bookings: [legacy] });
  await say('1');
  assert.strictEqual(guestRow(ctx)['Session State'], 'CHECKED_IN');
  assert.strictEqual(byId(ctx, 'recBookLEGACY').fields['Status'], 'Checked In');
  assert.ok(!texts(ctx).includes(NO_BOOKING_TEXT));
});

test('a tap by a guest who does have a Confirmed booking is unaffected by GATE_REQUIRES_BOOKING', async () => {
  setClock(16, 10);
  const ctx = start({ bookings: [d4({ 'Payment Status': 'Paid', 'Amount Paid': 300 })] }, { one: null });
  await say('1');
  assert.strictEqual(byId(ctx, 'recBookD4NUMZ').fields['Status'], 'Checked In');
  assert.match(texts(ctx)[0], /Your room is \*Room 02\*/);
});

test('both flags are on the cold-start list and read off by default', () => {
  for (const k of ['WABISTAY_ONE_OPEN_BOOKING', 'WABISTAY_GATE_REQUIRES_BOOKING']) {
    delete process.env[k];
    assert.strictEqual(wh.wabistayFlagState()[k], 'off', k);
    process.env[k] = 'true';
    assert.strictEqual(wh.wabistayFlagState()[k], 'on', k);
  }
});
