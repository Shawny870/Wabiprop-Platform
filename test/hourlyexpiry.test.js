// test/hourlyexpiry.test.js
// WABISTAY_HOURLY_EXPIRY. Live bug, Tue 6 Oct 2026: WS-D4NUMZ (3 hours, R300, Room 02, created 15:33, arrival 16:00, never
// paid, never used) was still Confirmed and holding Room 02 at 18:54, and the gate used it.
// With the flag on, a Confirmed Hourly or Day booking that is unpaid, not checked in, with no gate tap, is released 30 minutes
// after its Check In (Status Cancelled, Notes marker, enquiry row + Axiom event, Notify Phone told once, a failed notice never
// undoes it). A sweep in the 5-minute cron does it; the gate tap does the same check itself. The guest stays in CONFIRMED and
// their next tap/message gets "Your short stay has expired. Reply hi to start a new booking." (state NEW, no room, no alert).
// A test phone expires exactly like a real guest. Flag off: nothing changes.
// Time is mocked (SAST = UTC+2). In-memory only: MockAirtable + mocked fetch.

const { test, mock, afterEach } = require('node:test');
const assert = require('node:assert');
const { installEnv, installFetch, makeRes, metaTextPayload, MockAirtable } = require('./harness');

installEnv();
const ENV = ['WABISTAY_HOURLY_EXPIRY', 'WABISTAY_ONE_OPEN_BOOKING', 'WABISTAY_GATE_REQUIRES_BOOKING', 'WABISTAY_GATE_ALERT_UNPAID', 'WABISTAY_ENQUIRY_TRACKING', 'WABISTAY_STAY_MENU', 'WABISTAY_PAY_ASSIGNS_ROOM'];
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

const EXPIRED = 'Your short stay has expired. Reply hi to start a new booking.';
const NOTE = 'Expired: unpaid 30 min after arrival';

function booking(id, fields, createdTime) {
  return {
    id, ...(createdTime ? { createdTime } : {}),
    fields: { 'Guest': ['recG1'], 'Booking Type': 'Hourly', 'Status': 'Confirmed', 'Payment Status': 'Unpaid', 'Amount Due': 300, 'Booking Ref': 'WS-' + id.slice(-6).toUpperCase(), ...fields }
  };
}
// WS-D4NUMZ: 3 hours, R300, Room 02, 16:00-19:00 SAST, created 15:33.
const d4 = (extra = {}) => booking('recBookD4NUMZ', {
  'Room': ['recR2'], 'Check In': iso(16), 'Check Out': iso(19), 'Payment Method': 'Card', ...extra
}, iso(15, 33));

function seed({ state = 'CONFIRMED', testPhone = false, bookings = [d4()] } = {}) {
  return {
    WS_Properties: [{ id: 'recP1', fields: { 'Property Name': 'Canary Street Guest Rooms', 'Phone Number ID': '111000111000', 'City': 'Boksburg', 'Notify Phone': NOTIFY, 'Hourly Rate 1hr': 120, 'Hourly Rate 2hr': 250, 'Hourly Rate 3hr': 300 } }],
    WS_Rooms: [
      { id: 'recR1', fields: { 'Room Name': 'Room 01', 'Room Number': 1, 'Status': 'Available', 'Property': ['recP1'], 'Active': true } },
      { id: 'recR2', fields: { 'Room Name': 'Room 02', 'Room Number': 2, 'Status': 'Available', 'Property': ['recP1'], 'Active': true } }
    ],
    WS_Rates: [], WS_Cleaners: [], WS_Enquiries: [], WS_Roles: [],
    WS_Guests: [{ id: 'recG1', fields: { 'Guest Name': 'Robson Tembo', 'Phone Number': GUEST, 'Session State': state, ...(testPhone ? { 'Test Phone': true } : {}) } }],
    WS_Bookings: bookings
  };
}
function start(opts = {}, env = {}) {
  const set = (k, v) => { if (v === null || v === undefined) delete process.env[k]; else process.env[k] = v; };
  set('WABISTAY_HOURLY_EXPIRY', env.expiry === undefined ? '1' : env.expiry);
  set('WABISTAY_ONE_OPEN_BOOKING', env.one === undefined ? null : env.one);
  set('WABISTAY_GATE_REQUIRES_BOOKING', env.gate === undefined ? null : env.gate);
  set('WABISTAY_GATE_ALERT_UNPAID', '1');
  set('WABISTAY_ENQUIRY_TRACKING', env.tracking === undefined ? null : env.tracking);
  set('WABISTAY_STAY_MENU', null);
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
const say = (text) => wh({ method: 'POST', body: metaTextPayload(GUEST, text) }, makeRes());
const sweep = (ctx, h, m, d) => { setClock(h, m, d); return wh.runHourlyExpiry(new Date()); };
const byId = (ctx, id) => ctx.airtable.tables['WS_Bookings'].find(b => b.id === id);
const guestRow = ctx => ctx.airtable.tables['WS_Guests'][0].fields;
const room = (ctx, id) => ctx.airtable.tables['WS_Rooms'].find(r => r.id === id).fields;
const texts = (ctx, to = GUEST) => ctx.sends.filter(s => s.type === 'text' && s.to === to).map(s => s.body);
const events = (ctx, n) => ctx.axiom.filter(e => e.event === n);
const notices = ctx => texts(ctx, NOTIFY).filter(t => /was not paid within 30 minutes/.test(t));
const alerts = ctx => ctx.sends.filter(s => s.to !== GUEST && !(s.to === NOTIFY && /was not paid within 30 minutes/.test(s.body)));

// ── the exact sequence: 15:33 / 16:32 / 18:53 / 18:54 ────────────────────────

test('15:33 booking, cron at 15:57 and 16:29 does nothing, cron at 16:32 releases it, a second tick tells no one again', async () => {
  setClock(15, 33);
  const ctx = start();
  assert.strictEqual((await sweep(ctx, 15, 57)).hourlyExpired, 0);
  assert.strictEqual((await sweep(ctx, 16, 29)).hourlyExpired, 0);
  assert.strictEqual(byId(ctx, 'recBookD4NUMZ').fields['Status'], 'Confirmed');
  assert.strictEqual((await sweep(ctx, 16, 32)).hourlyExpired, 1);
  const b = byId(ctx, 'recBookD4NUMZ').fields;
  assert.strictEqual(b['Status'], 'Cancelled');
  assert.ok(!wh.BLOCKING_BOOKING_STATUSES.includes(b['Status']), 'a Cancelled booking no longer blocks its room');
  assert.ok(b['Notes'].includes(NOTE));
  assert.strictEqual(notices(ctx).length, 1);
  assert.match(notices(ctx)[0], /WS-D4NUMZ \(short stay, Room 02\) for Robson Tembo/);
  assert.strictEqual((await sweep(ctx, 16, 37)).hourlyExpired, 0);
  assert.strictEqual(notices(ctx).length, 1, 'told once');
  assert.strictEqual(guestRow(ctx)['Session State'], 'CONFIRMED', 'the guest stays in CONFIRMED so their tap can be answered');
  assert.strictEqual(events(ctx, 'hourly_booking_expired').length, 1);
  assert.strictEqual(events(ctx, 'hourly_booking_expired')[0].source, 'cron');
});

test('18:53 tap after the cron released it: the exact expired text, state NEW, no room, no check-in, no alert; 18:54 tap gets the normal greeting', async () => {
  setClock(15, 33);
  const ctx = start();
  await sweep(ctx, 16, 32);
  setClock(18, 53);
  await say('1');
  assert.deepStrictEqual(texts(ctx), [EXPIRED]);
  assert.strictEqual(guestRow(ctx)['Session State'], 'NEW');
  assert.strictEqual(room(ctx, 'recR2')['Status'], 'Available');
  assert.strictEqual(room(ctx, 'recR1')['Status'], 'Available');
  assert.strictEqual(byId(ctx, 'recBookD4NUMZ').fields['Status'], 'Cancelled');
  assert.strictEqual(alerts(ctx).length, 0, 'no alert to reception or anyone else');
  setClock(18, 54);
  await say('1');
  assert.ok(!texts(ctx).slice(1).includes(EXPIRED), 'the second tap is not another expired message');
  assert.match(texts(ctx).slice(-1)[0], /short stay/, 'it is the greeting');
});

test('the cron never ran: the 18:53 tap releases the booking itself, tells reception once, and answers expired', async () => {
  setClock(18, 53);
  const ctx = start();
  await say('1');
  assert.deepStrictEqual(texts(ctx), [EXPIRED]);
  assert.strictEqual(byId(ctx, 'recBookD4NUMZ').fields['Status'], 'Cancelled');
  assert.strictEqual(notices(ctx).length, 1);
  assert.strictEqual(alerts(ctx).length, 0);
  assert.strictEqual(guestRow(ctx)['Session State'], 'NEW');
  assert.strictEqual(room(ctx, 'recR2')['Status'], 'Available');
  assert.strictEqual(events(ctx, 'hourly_booking_expired')[0].source, 'gate');
});

test('the same 18:53 tap with the flag OFF reproduces today: the old booking is used (unpaid alert for R300, Room 02)', async () => {
  setClock(18, 53);
  const ctx = start({}, { expiry: null });
  await say('1');
  assert.ok(texts(ctx, NOTIFY).some(t => /has not paid yet/.test(t) && /R300/.test(t)));
  assert.strictEqual(byId(ctx, 'recBookD4NUMZ').fields['Status'], 'Confirmed');
  assert.strictEqual((await wh.runHourlyExpiry(new Date())).hourlyExpired, 0, 'the sweep does nothing with the flag off');
});

// ── who is never released ────────────────────────────────────────────────────

test('never released: paid, money received, checked in, gate already tapped, Overnight, Walk-in, inside the 30 minutes', async () => {
  const cases = [
    ['paid', { 'Payment Status': 'Paid' }], ['money received', { 'Amount Paid': 300 }], ['checked in', { 'Checked In At': iso(16, 5) }],
    ['gate tap', { 'Gate Tap At': iso(16, 20) }], ['overnight', { 'Booking Type': 'Overnight' }], ['walk-in', { 'Booking Type': 'Walk-in' }]
  ];
  for (const [name, extra] of cases) {
    setClock(15, 33);
    const ctx = start({ bookings: [d4(extra)] });
    assert.strictEqual((await sweep(ctx, 18, 53)).hourlyExpired, 0, name);
    assert.strictEqual(byId(ctx, 'recBookD4NUMZ').fields['Status'], 'Confirmed', name);
  }
  setClock(16, 29);
  const ctx = start();
  assert.strictEqual((await wh.runHourlyExpiry(new Date())).hourlyExpired, 0, 'inside the grace');
});

test('a Day booking is released like a short stay', async () => {
  setClock(8, 0);
  const day = booking('recBookDAYDAY', { 'Booking Type': 'Day', 'Room': ['recR1'], 'Check In': iso(9), 'Check Out': iso(17), 'Amount Due': 400 }, iso(8, 0));
  const ctx = start({ bookings: [day] });
  assert.strictEqual((await sweep(ctx, 9, 29)).hourlyExpired, 0);
  assert.strictEqual((await sweep(ctx, 9, 30)).hourlyExpired, 1);
  assert.strictEqual(byId(ctx, 'recBookDAYDAY').fields['Status'], 'Cancelled');
  assert.match(notices(ctx)[0], /day stay, Room 01/);
});

// ── the guest at the desk ────────────────────────────────────────────────────

test('a guest who taps the gate inside the grace is stamped, handled as before, and not released at 16:40 (a test phone too)', async () => {
  for (const testPhone of [false, true]) {
    setClock(16, 20);
    const ctx = start({ testPhone });
    await say('1');
    assert.match(texts(ctx)[0], /Pop into the office/, 'the unpaid reply, as today');
    assert.ok(byId(ctx, 'recBookD4NUMZ').fields['Gate Tap At'], `tap stamped (test phone ${testPhone})`);
    assert.strictEqual((await sweep(ctx, 16, 40)).hourlyExpired, 0, `at the desk, not released (test phone ${testPhone})`);
    assert.strictEqual(byId(ctx, 'recBookD4NUMZ').fields['Status'], 'Confirmed');
  }
});

// ── test phones, notices, records ────────────────────────────────────────────

test('a test phone is released exactly like a real guest: by the cron and by its own tap', async () => {
  setClock(15, 33);
  const viaCron = start({ testPhone: true });
  assert.strictEqual((await sweep(viaCron, 16, 32)).hourlyExpired, 1);
  setClock(18, 53);
  await say('1');
  assert.deepStrictEqual(texts(viaCron), [EXPIRED]);
  const viaTap = start({ testPhone: true });
  setClock(18, 53);
  await say('1');
  assert.deepStrictEqual(texts(viaTap), [EXPIRED]);
  assert.strictEqual(byId(viaTap, 'recBookD4NUMZ').fields['Status'], 'Cancelled');
  assert.strictEqual(notices(viaTap).length, 1);
});

test('a failed reception notice never blocks the release (cron and gate)', async () => {
  setClock(15, 33);
  const viaCron = start({}, { failNotify: true });
  assert.strictEqual((await sweep(viaCron, 16, 32)).hourlyExpired, 1);
  assert.strictEqual(byId(viaCron, 'recBookD4NUMZ').fields['Status'], 'Cancelled');
  assert.strictEqual(events(viaCron, 'hourly_expiry_notice_failed').length, 1);
  setClock(18, 53);
  const viaTap = start({}, { failNotify: true });
  await say('1');
  assert.strictEqual(byId(viaTap, 'recBookD4NUMZ').fields['Status'], 'Cancelled');
  assert.deepStrictEqual(texts(viaTap), [EXPIRED]);
});

test('tracking on: a Hold Expired enquiry row for a real guest; a test phone logs the event only', async () => {
  setClock(15, 33);
  const real = start({}, { tracking: '1' });
  await sweep(real, 16, 32);
  const rows = real.airtable.tables['WS_Enquiries'].filter(e => e.fields['Outcome'] === 'Hold Expired');
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].fields['Phone Number'], GUEST);
  assert.strictEqual(rows[0].fields['Booking Type'], 'Hourly');
  const test = start({ testPhone: true }, { tracking: '1' });
  await sweep(test, 16, 32);
  assert.strictEqual(test.airtable.tables['WS_Enquiries'].filter(e => e.fields['Outcome'] === 'Hold Expired').length, 0);
  assert.ok(events(test, 'enquiry_closed').some(e => e.outcome === 'Hold Expired' && e.testPhone === true));
});

test('a stay-menu booking keeps its Stay: marker and gains the expiry note', async () => {
  setClock(15, 33);
  const ctx = start({ bookings: [d4({ 'Notes': 'Stay: 3 hours' })] });
  await sweep(ctx, 16, 32);
  assert.strictEqual(byId(ctx, 'recBookD4NUMZ').fields['Notes'], 'Stay: 3 hours | ' + NOTE);
});

// ── the guest left in CONFIRMED, other bookings, legacy ──────────────────────

test('any other message from a guest left in CONFIRMED gets the expired text, not "your booking is confirmed"', async () => {
  setClock(15, 33);
  const ctx = start();
  await sweep(ctx, 16, 32);
  setClock(18, 0);
  await say('banana');
  assert.deepStrictEqual(texts(ctx), [EXPIRED]);
  assert.strictEqual(guestRow(ctx)['Session State'], 'NEW');
});

test('a guest with the expired booking AND another live Confirmed booking taps the gate normally (no expired text)', async () => {
  const live = booking('recBookLIVE11', { 'Booking Type': 'Overnight', 'Room': ['recR1'], 'Check In': iso(14), 'Check Out': iso(10, 0, 7), 'Amount Due': 500, 'Payment Status': 'Paid' }, iso(18, 30));
  setClock(18, 54);
  const ctx = start({ bookings: [d4(), live] });
  await say('1');
  assert.ok(!texts(ctx).includes(EXPIRED));
  assert.strictEqual(byId(ctx, 'recBookD4NUMZ').fields['Status'], 'Cancelled');
  assert.strictEqual(byId(ctx, 'recBookLIVE11').fields['Status'], 'Checked In');
  assert.match(texts(ctx)[0], /Your room is \*Room 01\*/);
});

test('the cron-already-released tap does not fall into the legacy branch even with GATE_REQUIRES_BOOKING off; a guest with no booking at all still gets today\'s behaviour', async () => {
  setClock(15, 33);
  const ctx = start({}, { gate: null });
  await sweep(ctx, 16, 32);
  setClock(18, 53);
  await say('1');
  assert.deepStrictEqual(texts(ctx), [EXPIRED]);
  assert.strictEqual(guestRow(ctx)['Session State'], 'NEW');
  assert.strictEqual(room(ctx, 'recR1')['Status'], 'Available', 'no free room given away');
  const none = start({ bookings: [] }, { gate: null });
  setClock(18, 54);
  await say('1');
  assert.strictEqual(guestRow(none)['Session State'], 'CHECKED_IN', 'no expired booking: the old legacy behaviour is untouched by this flag');
});

test('with GATE_REQUIRES_BOOKING also on, a guest with no booking and no expired booking gets the no-booking message, not the expired one', async () => {
  setClock(18, 54);
  const ctx = start({ bookings: [] }, { gate: '1' });
  await say('1');
  assert.deepStrictEqual(texts(ctx), ["We couldn't find a booking for you. Reply hi to start a new booking."]);
});

// ── wired into the cron ──────────────────────────────────────────────────────

test('the 5-minute auto-checkout cron runs the sweep and reports it', async () => {
  setClock(16, 32);
  const ctx = start();
  const res = { code: null, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
  await wh.autoCheckoutHandler({}, res);
  assert.strictEqual(res.code, 200);
  assert.strictEqual(res.body.hourlyExpired, 1);
  assert.strictEqual(byId(ctx, 'recBookD4NUMZ').fields['Status'], 'Cancelled');
});

test('the flag is on the cold-start list and reads off by default', () => {
  delete process.env.WABISTAY_HOURLY_EXPIRY;
  assert.strictEqual(wh.wabistayFlagState()['WABISTAY_HOURLY_EXPIRY'], 'off');
  process.env.WABISTAY_HOURLY_EXPIRY = 'true';
  assert.strictEqual(wh.wabistayFlagState()['WABISTAY_HOURLY_EXPIRY'], 'on');
});
