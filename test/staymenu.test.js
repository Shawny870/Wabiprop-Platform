// test/staymenu.test.js
// WABISTAY_STAY_MENU — slice 1. A numbered TEXT menu of what is on sale now, by SAST time:
// 2 hours R250, 3 hours R300, Day R400 (arrive 08:00-15:00, leave by 17:00, offered until 12:00),
// Overnight R500 (check in 17:00-23:00, check out 10:00). Reply keys are fixed (1-4).
// 08:00-11:59 all four; 12:00-16:59 2h, 3h, Overnight; 17:00-22:59 Overnight only; outside that,
// or with nothing priceable, today's flow. The guest still types the arrival time.
// Time is mocked with node:test mock timers (the menu depends on the SAST hour).
// In-memory only: MockAirtable + mocked fetch.

const { test, mock, afterEach } = require('node:test');
const assert = require('node:assert');
const { installEnv, installFetch, makeRes, metaTextPayload, MockAirtable } = require('./harness');

installEnv();
const ENV = ['WABISTAY_STAY_MENU', 'WABISTAY_HOLD_RELEASE', 'WABISTAY_INTERACTIVE', 'WABISTAY_PAID_ROOM_CONFIRMED', 'WABISTAY_LEAN_COPY'];
const saved = Object.fromEntries(ENV.map(k => [k, process.env[k]]));
afterEach(() => {
  mock.timers.reset();
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

const wh = require('../api/wabistay/webhook.js');
const GUEST = '27784896186';
const OWNER = '27830000001'; // installEnv's OWNER_PHONE
const LODGE = '0730260871';

// A Tuesday. SAST = UTC+2.
const sast = (h, m = 0, d = 6) => Date.UTC(2026, 9, d, h - 2, m);
function atSast(h, m = 0) { mock.timers.reset(); mock.timers.enable({ apis: ['Date'], now: sast(h, m) }); }
const iso = (h, m = 0, d = 6) => new Date(sast(h, m, d)).toISOString();

function seed({ state, guest = true, phone = LODGE, dayRate = 400, nightRates = [500], rooms, bookings = [], hourly = {} } = {}) {
  const prop = { 'Property Name': 'Canary Street Guest Rooms', 'Phone Number ID': '111000111000', 'City': 'Pretoria', 'Notify Phone': '27831112222', 'Hourly Rate 1hr': 120, 'Hourly Rate 2hr': 250, 'Hourly Rate 3hr': 300, ...hourly };
  if (phone) prop['Guest Redirect Phone'] = phone;
  const rates = [];
  if (dayRate) rates.push({ id: 'recRateDay', fields: { 'Rate Name': 'Day', 'Rate Type': 'Per Day', 'Amount': dayRate, 'Active': true, 'Property': ['recP1'] } });
  nightRates.forEach((a, i) => rates.push({ id: 'recRateNight' + i, fields: { 'Rate Name': 'Standard Night', 'Rate Type': 'Per Night', 'Amount': a, 'Active': true, 'Property': ['recP1'] } }));
  return {
    WS_Properties: [{ id: 'recP1', fields: prop }],
    WS_Rooms: rooms || [{ id: 'recR1', fields: { 'Room Name': 'Room 01', 'Room Number': 1, 'Status': 'Available', 'Property': ['recP1'], 'Active': true } }],
    WS_Rates: rates, WS_Cleaners: [], WS_Enquiries: [],
    WS_Roles: [{ id: 'recRole1', fields: { 'Role Label': 'Reception', 'Role Type': 'Reception', 'Property': ['recP1'], 'Current Phone': '27780384989', 'Active': true } }],
    WS_Guests: guest ? [{ id: 'recG1', fields: { 'Guest Name': 'Unknown', 'Phone Number': GUEST, 'Session State': state || 'NEW' } }] : [],
    WS_Bookings: bookings
  };
}
function start(opts = {}, flag = '1') {
  if (flag === null) delete process.env.WABISTAY_STAY_MENU; else process.env.WABISTAY_STAY_MENU = flag;
  const ctx = { airtable: new MockAirtable(seed(opts)), sends: [], axiom: [] };
  installFetch(ctx);
  return ctx;
}
const say = (text) => wh({ method: 'POST', body: metaTextPayload(GUEST, text) }, makeRes());
const guestRow = ctx => ctx.airtable.tables['WS_Guests'][0].fields;
const bookings = ctx => ctx.airtable.tables['WS_Bookings'];
const mine = ctx => bookings(ctx).find(b => String(b.fields['Notes'] || '').startsWith('Stay: ')) || bookings(ctx)[0];
const texts = (ctx, to = GUEST) => ctx.sends.filter(s => s.type === 'text' && s.to === to).map(s => s.body);
const events = (ctx, n) => ctx.axiom.filter(e => e.event === n);
const ANOTHER = `Another day? Please phone reception on ${LODGE}.`;

// ── the menu by time ─────────────────────────────────────────────────────────

test('08:00-11:59: all four products, fixed keys, prices, windows, and the phone line at the end', async () => {
  for (const [h, m] of [[8, 0], [9, 30], [11, 59]]) {
    atSast(h, m);
    const ctx = start();
    await say('hi');
    const menu = texts(ctx).find(t => /What would you like to book/.test(t));
    assert.ok(menu, `${h}:${m}`);
    assert.match(menu, /^Hi! 👋 Welcome to Canary Street Guest Rooms/);
    assert.match(menu, /1 - 2 hours \(R250\)\n2 - 3 hours \(R300\)\n3 - Day \(R400\): arrive 08:00 to 15:00, leave by 17:00\n4 - Overnight \(R500\): check in 17:00 to 23:00, check out 10:00\n\n/);
    assert.ok(menu.endsWith(ANOTHER), 'ends with the phone line');
    assert.strictEqual(guestRow(ctx)['Session State'], 'AWAITING_STAY_TYPE');
    mock.timers.reset();
  }
});

test('12:00-16:59: 2h, 3h and Overnight — Day is gone, but keys stay fixed (1, 2, 4)', async () => {
  for (const [h, m] of [[12, 0], [16, 59]]) {
    atSast(h, m);
    const ctx = start();
    await say('hi');
    const menu = texts(ctx).find(t => /What would you like to book/.test(t));
    assert.match(menu, /1 - 2 hours \(R250\)\n2 - 3 hours \(R300\)\n4 - Overnight \(R500\)/);
    assert.ok(!/Day/.test(menu.replace('Another day?', '')), `${h}:${m}`);
    assert.ok(!/\n3 - /.test(menu));
    mock.timers.reset();
  }
});

test('17:00-22:59: Overnight only', async () => {
  for (const [h, m] of [[17, 0], [22, 59]]) {
    atSast(h, m);
    const ctx = start();
    await say('hi');
    const menu = texts(ctx).find(t => /What would you like to book/.test(t));
    assert.match(menu, /Reply with a number:\n4 - Overnight \(R500\): check in 17:00 to 23:00, check out 10:00\n\n/);
    assert.ok(!/hours \(/.test(menu));
    mock.timers.reset();
  }
});

test('outside 08:00-22:59 (closed hours are not built yet): today\'s greeting, unchanged', async () => {
  for (const [h, m] of [[23, 0], [3, 0], [7, 59]]) {
    atSast(h, m);
    const ctx = start();
    await say('hi');
    assert.match(texts(ctx).join('\n'), /short stay\* \(a few hours\) or \*multiple days\*/, `${h}:${m}`);
    assert.ok(!texts(ctx).some(t => /What would you like to book/.test(t)));
    mock.timers.reset();
  }
});

test('flag off: today\'s greeting at any time of day', async () => {
  atSast(9, 0);
  const ctx = start({}, null);
  await say('hi');
  assert.match(texts(ctx).join('\n'), /short stay\* \(a few hours\) or \*multiple days\*/);
  assert.ok(!texts(ctx).some(t => /What would you like to book/.test(t)));
});

test('a product with no price is left off; with nothing priceable there is no menu (today\'s flow)', async () => {
  atSast(9, 0);
  const noDay = start({ dayRate: null });
  await say('hi');
  assert.ok(!/3 - Day/.test(texts(noDay).join('\n')), 'no Per Day row: Day is not offered');
  assert.match(texts(noDay).join('\n'), /4 - Overnight \(R500\)/);
  mock.timers.reset();

  atSast(9, 0);
  const twoNights = start({ nightRates: [500, 450] });
  await say('hi');
  assert.ok(!/4 - Overnight/.test(texts(twoNights).join('\n')), 'two active Per Night rows: not priced, not offered');
  mock.timers.reset();

  atSast(18, 0);
  const none = start({ nightRates: [] });
  await say('hi');
  assert.match(texts(none).join('\n'), /multiple days/, 'nothing priceable at 18:00: today\'s greeting');
});

test('no Guest Redirect Phone: the closing line has no number', async () => {
  atSast(9, 0);
  const ctx = start({ phone: null });
  await say('hi');
  assert.ok(texts(ctx).find(t => /What would you like/.test(t)).endsWith('Another day? Please phone reception.'));
});

test('parseStayMenuChoice: fixed keys, typed words, and "2" is the SECOND line (3 hours) while "2 hours" is two hours', () => {
  const p = wh.parseStayMenuChoice;
  assert.strictEqual(p('1'), '1'); assert.strictEqual(p('2'), '2'); assert.strictEqual(p('3'), '3'); assert.strictEqual(p('4'), '4');
  for (const t of ['2 hours', '2hrs', '2h', 'two hours', '2 Hours']) assert.strictEqual(p(t), '1', t);
  for (const t of ['3 hours', '3hrs', 'three hours']) assert.strictEqual(p(t), '2', t);
  for (const t of ['day', 'Day stay']) assert.strictEqual(p(t), '3', t);
  for (const t of ['overnight', 'night']) assert.strictEqual(p(t), '4', t);
  for (const t of ['multiple days', 'multi-day', 'multiday']) assert.strictEqual(p(t), 'multi', t);
  for (const t of ['5', '0', 'hello', 'short stay', '']) assert.strictEqual(p(t), null, t);
});

test('stayMenuKeysForHour boundaries', () => {
  const k = wh.stayMenuKeysForHour;
  assert.strictEqual(k(7), null); assert.deepStrictEqual(k(8), ['1', '2', '3', '4']); assert.deepStrictEqual(k(11), ['1', '2', '3', '4']);
  assert.deepStrictEqual(k(12), ['1', '2', '4']); assert.deepStrictEqual(k(16), ['1', '2', '4']);
  assert.deepStrictEqual(k(17), ['4']); assert.deepStrictEqual(k(22), ['4']); assert.strictEqual(k(23), null); assert.strictEqual(k(0), null);
});

// ── the choice ───────────────────────────────────────────────────────────────

test('choosing a product parks it on an inert booking row and asks for name and time; nothing else is written', async () => {
  atSast(9, 0);
  const ctx = start({ state: 'AWAITING_STAY_TYPE' });
  await say('3');
  const b = bookings(ctx)[0];
  assert.strictEqual(b.fields['Booking Type'], 'Day');
  assert.strictEqual(b.fields['Notes'], 'Stay: Day');
  assert.strictEqual(b.fields['Status'], 'Enquiry');
  assert.strictEqual(b.fields['Check In'], undefined, 'no dates: it blocks nothing');
  assert.strictEqual(guestRow(ctx)['Session State'], 'AWAITING_HOURLY_DETAILS');
  assert.deepStrictEqual(texts(ctx), ['Please send your full name and the time you expect to arrive, each on a new line.\n\nExample:\nSam Dlamini\n2pm']);
});

test('each product maps to its own Booking Type and note; picking again reuses the same row', async () => {
  atSast(9, 0);
  for (const [reply, type, note] of [['1', 'Hourly', 'Stay: 2 hours'], ['2', 'Hourly', 'Stay: 3 hours'], ['day', 'Day', 'Stay: Day'], ['overnight', 'Overnight', 'Stay: Overnight']]) {
    const ctx = start({ state: 'AWAITING_STAY_TYPE' });
    await say(reply);
    assert.strictEqual(bookings(ctx).length, 1, reply);
    assert.strictEqual(bookings(ctx)[0].fields['Booking Type'], type, reply);
    assert.strictEqual(bookings(ctx)[0].fields['Notes'], note, reply);
  }
  const ctx = start({ state: 'AWAITING_STAY_TYPE' });
  await say('1');
  ctx.airtable.tables['WS_Guests'][0].fields['Session State'] = 'AWAITING_STAY_TYPE';
  await say('4');
  assert.strictEqual(bookings(ctx).length, 1);
  assert.strictEqual(bookings(ctx)[0].fields['Notes'], 'Stay: Overnight');
});

test('a product that is not on sale right now (Day at 12:30) or a junk reply gets the menu again; no row is made', async () => {
  atSast(12, 30);
  const ctx = start({ state: 'AWAITING_STAY_TYPE' });
  await say('3');
  await say('banana');
  const again = texts(ctx);
  assert.strictEqual(again.length, 2);
  for (const t of again) {
    assert.match(t, /^Sorry, I didn't catch that\. Please reply with a number:\n1 - 2 hours \(R250\)\n2 - 3 hours \(R300\)\n4 - Overnight \(R500\)/);
    assert.ok(t.endsWith(ANOTHER));
  }
  assert.strictEqual(bookings(ctx).length, 0);
  assert.strictEqual(guestRow(ctx)['Session State'], 'AWAITING_STAY_TYPE');
});

test('the typed words "multiple days" still reach today\'s typed-dates flow, and "hourly" today\'s hourly flow', async () => {
  atSast(9, 0);
  const multi = start({ state: 'AWAITING_STAY_TYPE' });
  await say('multiple days');
  assert.match(texts(multi).join('\n'), /Overnight rates at Canary Street Guest Rooms/);
  assert.strictEqual(guestRow(multi)['Session State'], 'AWAITING_DETAILS');
  const hourly = start({ state: 'AWAITING_STAY_TYPE' });
  await say('hourly');
  assert.match(texts(hourly).join('\n'), /Please send your full name and the time you expect to arrive|short stay/);
  assert.strictEqual(guestRow(hourly)['Session State'], 'AWAITING_HOURLY_DETAILS');
});

test('flag off: "2" is "multiple days" and "1" is "short stay", exactly as today', async () => {
  atSast(9, 0);
  const two = start({ state: 'AWAITING_STAY_TYPE' }, null);
  await say('2');
  assert.match(texts(two).join('\n'), /Overnight rates at/);
  assert.strictEqual(bookings(two).length, 0);
  const one = start({ state: 'AWAITING_STAY_TYPE' }, null);
  await say('1');
  assert.strictEqual(guestRow(one)['Session State'], 'AWAITING_HOURLY_DETAILS');
  assert.strictEqual(bookings(one).length, 0);
});

// ── arrival windows ──────────────────────────────────────────────────────────

const P = wh.STAY_PRODUCTS;
test('stayWindowForArrival: short stays today and before 17:00; Day 08:00-15:00, leave by 17:00; Overnight 17:00-23:00, out 10:00 tomorrow', () => {
  const w = wh.stayWindowForArrival;
  const now = new Date(sast(6, 0));
  assert.strictEqual(w(P['1'], { hour: 16, minute: 59 }, now).ok, true);
  assert.strictEqual(w(P['1'], { hour: 17, minute: 0 }, now).ok, false);
  assert.strictEqual(w(P['2'], { hour: 14, minute: 0 }, now).coIso, iso(17, 0));
  assert.strictEqual(w(P['1'], { hour: 14, minute: 0 }, now).coIso, iso(16, 0));
  assert.strictEqual(w(P['3'], { hour: 7, minute: 59 }, now).ok, false);
  assert.strictEqual(w(P['3'], { hour: 8, minute: 0 }, now).ok, true);
  assert.strictEqual(w(P['3'], { hour: 15, minute: 0 }, now).ok, true);
  assert.strictEqual(w(P['3'], { hour: 15, minute: 1 }, now).ok, false);
  assert.strictEqual(w(P['3'], { hour: 9, minute: 0 }, now).coIso, iso(17, 0), 'Day leaves by 17:00 the same day');
  assert.strictEqual(w(P['4'], { hour: 16, minute: 59 }, now).ok, false);
  assert.strictEqual(w(P['4'], { hour: 17, minute: 0 }, now).ok, true);
  assert.strictEqual(w(P['4'], { hour: 23, minute: 0 }, now).ok, true);
  assert.strictEqual(w(P['4'], { hour: 23, minute: 1 }, now).ok, false);
  assert.strictEqual(w(P['4'], { hour: 19, minute: 0 }, now).coIso, iso(10, 0, 7), 'Overnight checks out 10:00 the next morning');
  assert.strictEqual(w(P['3'], { hour: 9, minute: 0 }, new Date(sast(10, 0))).reason, 'in_the_past', 'a time already past is refused: always today');
});

test('resolveBareHour: the one reading inside the window and not yet past wins; two valid readings means ask; none means re-ask', () => {
  const r = wh.resolveBareHour;
  const early = new Date(sast(1, 0));
  assert.deepStrictEqual(r(P['3'], 9, new Date(sast(8, 5))).arrival, { hour: 9, minute: 0 });
  assert.deepStrictEqual(r(P['4'], 7, new Date(sast(12, 0))).arrival, { hour: 19, minute: 0 });
  assert.strictEqual(r(P['1'], 4, early).ambiguous, true, '4am and 4pm are both valid for a short stay at 01:00');
  assert.deepStrictEqual(r(P['3'], 5, new Date(sast(8, 5))), { arrival: null, ambiguous: false });
});

// ── the booking, per product ─────────────────────────────────────────────────

async function book(choice, reply, { now = [9, 0], opts = {} } = {}) {
  atSast(...now);
  const ctx = start({ state: 'AWAITING_STAY_TYPE', ...opts });
  await say(choice);
  await say(reply);
  return ctx;
}

test('2 hours: Sam Dlamini, 10am -> Hourly, 10:00 to 12:00, R250, Confirmed with a room, payment menu next', async () => {
  const ctx = await book('1', 'Sam Dlamini\n10am');
  const b = mine(ctx).fields;
  assert.strictEqual(b['Booking Type'], 'Hourly');
  assert.strictEqual(b['Check In'], iso(10, 0));
  assert.strictEqual(b['Check Out'], iso(12, 0));
  assert.strictEqual(b['Amount Due'], 250);
  assert.strictEqual(b['Status'], 'Confirmed');
  assert.deepStrictEqual(b['Room'], ['recR1']);
  assert.match(b['Booking Ref'], /^WS-/);
  assert.strictEqual(b['Rate Applied'], undefined, 'hourly prices live on the property, not WS_Rates');
  assert.strictEqual(guestRow(ctx)['Guest Name'], 'Sam Dlamini');
  assert.strictEqual(guestRow(ctx)['Session State'], 'AWAITING_PAYMENT_METHOD');
  const t = texts(ctx);
  assert.match(t.find(x => /is booked/.test(x)), /Your \*2 hours\* is booked\.[\s\S]*\*Ref:\* WS-[\s\S]*\*Arriving:\* 6 Oct at 10:00am[\s\S]*\*Until:\* 6 Oct at 12:00pm[\s\S]*\*Price:\* R250/);
  assert.ok(t.some(x => /cashless property/.test(x)), 'payment-method menu');
  assert.match(texts(ctx, OWNER).join('\n'), /New \*2 hours\* booking from Sam Dlamini/);
});

test('3 hours: 2pm -> 14:00 to 17:00, R300', async () => {
  const ctx = await book('2', 'Sam Dlamini 2pm');
  const b = mine(ctx).fields;
  assert.strictEqual(b['Check In'], iso(14, 0));
  assert.strictEqual(b['Check Out'], iso(17, 0));
  assert.strictEqual(b['Amount Due'], 300);
});

test('Day: 10am -> Booking Type Day, 10:00 to 17:00, R400, linked to the Per Day rate row', async () => {
  const ctx = await book('3', 'Sam Dlamini\n10am');
  const b = mine(ctx).fields;
  assert.strictEqual(b['Booking Type'], 'Day');
  assert.strictEqual(b['Check In'], iso(10, 0));
  assert.strictEqual(b['Check Out'], iso(17, 0));
  assert.strictEqual(b['Amount Due'], 400);
  assert.deepStrictEqual(b['Rate Applied'], ['recRateDay']);
  assert.strictEqual(b['Status'], 'Confirmed');
  assert.match(texts(ctx).find(x => /is booked/.test(x)), /Your \*Day stay\* is booked[\s\S]*\*Price:\* R400/);
  assert.match(texts(ctx, OWNER).join('\n'), /New \*Day stay\* booking/);
});

test('Overnight: 7pm at 12:00 -> 19:00 today to 10:00 tomorrow, R500, linked to the single Per Night row (the Per Day row does not disturb it)', async () => {
  const ctx = await book('4', 'Sam Dlamini 7pm', { now: [12, 0] });
  const b = mine(ctx).fields;
  assert.strictEqual(b['Booking Type'], 'Overnight');
  assert.strictEqual(b['Check In'], iso(19, 0));
  assert.strictEqual(b['Check Out'], iso(10, 0, 7));
  assert.strictEqual(b['Amount Due'], 500);
  assert.deepStrictEqual(b['Rate Applied'], ['recRateNight0']);
  assert.match(texts(ctx).find(x => /is booked/.test(x)), /Your \*Overnight stay\* is booked[\s\S]*\*Until:\* 7 Oct at 10:00am/);
});

test('a bare hour is resolved by the product window: Day "Tim 9" at 08:05 is 9am; Overnight "Tim 7" is 7pm', async () => {
  const day = await book('3', 'Tim 9', { now: [8, 5] });
  assert.strictEqual(mine(day).fields['Check In'], iso(9, 0));
  const night = await book('4', 'Tim 7', { now: [12, 0] });
  assert.strictEqual(mine(night).fields['Check In'], iso(19, 0));
});

test('the new copy: one-line "Tim 10am" works here too', async () => {
  const ctx = await book('3', 'Tim 10am');
  assert.strictEqual(mine(ctx).fields['Check In'], iso(10, 0));
  assert.strictEqual(guestRow(ctx)['Guest Name'], 'Tim');
});

test('arrival outside the window is refused with the window restated, no booking made, the name kept; a later time-only reply then works', async () => {
  const cases = [
    ['1', 'Sam Dlamini\n5pm', /Sorry, a short stay must start later today and before 17:00\. Please send your full name and the time you expect to arrive, each on a new line\.\n\nExample:\nSam Dlamini\n2pm/, [9, 0]],
    ['3', 'Sam Dlamini\n3:30pm', /Sorry, Day arrival must be between 08:00 and 15:00 today\./, [9, 0]],
    ['4', 'Sam Dlamini\n11:30pm', /Sorry, Overnight check-in must be between 17:00 and 23:00 tonight\.[\s\S]*Example:\nSam Dlamini\n7pm/, [12, 0]],
    ['4', 'Sam Dlamini\n4pm', /Overnight check-in must be between 17:00 and 23:00 tonight/, [12, 0]]
  ];
  for (const [choice, reply, expected, now] of cases) {
    const ctx = await book(choice, reply, { now });
    assert.match(texts(ctx).slice(-1)[0], expected, reply);
    assert.strictEqual(mine(ctx).fields['Status'], 'Enquiry', reply);
    assert.strictEqual(mine(ctx).fields['Check In'], undefined, reply);
    assert.strictEqual(guestRow(ctx)['Session State'], 'AWAITING_HOURLY_DETAILS');
    assert.strictEqual(guestRow(ctx)['Guest Name'], 'Sam Dlamini', 'the name is kept');
  }
  const ctx = await book('3', 'Sam Dlamini\n3:30pm');
  await say('11am');
  assert.strictEqual(mine(ctx).fields['Check In'], iso(11, 0));
  assert.strictEqual(mine(ctx).fields['Status'], 'Confirmed');
});

test('a time already past today is refused (the stay is always today)', async () => {
  const ctx = await book('1', 'Sam Dlamini\n9am', { now: [10, 0] });
  assert.match(texts(ctx).slice(-1)[0], /a short stay must start later today and before 17:00/);
  assert.strictEqual(mine(ctx).fields['Status'], 'Enquiry');
});

test('an unreadable reply gets the lean re-prompt and changes nothing', async () => {
  const ctx = await book('1', 'hello there');
  assert.strictEqual(texts(ctx).slice(-1)[0], "Sorry, I didn't catch that. Please send your full name and arrival time, each on a new line.\n\nExample:\nSam Dlamini\n2pm");
  assert.strictEqual(mine(ctx).fields['Status'], 'Enquiry');
});

test('no free room: the no-room message, state back at the details step, the booking stays inert, the name is kept', async () => {
  const taken = [{ id: 'recOther', fields: { 'Guest': ['recGx'], 'Room': ['recR1'], 'Status': 'Confirmed', 'Check In': iso(8, 0), 'Check Out': iso(20, 0) } }];
  const ctx = await book('1', 'Sam Dlamini\n10am', { opts: { bookings: taken } });
  const b = bookings(ctx).find(x => x.id !== 'recOther').fields;
  assert.strictEqual(b['Status'], 'Enquiry');
  assert.strictEqual(guestRow(ctx)['Session State'], 'AWAITING_HOURLY_DETAILS');
  assert.strictEqual(guestRow(ctx)['Guest Name'], 'Sam Dlamini');
  assert.strictEqual(events(ctx, 'stay_menu_no_availability').length, 1);
});

test('a Per Day rate that disappears between the menu and the booking fails closed: no booking', async () => {
  atSast(9, 0);
  const ctx = start({ state: 'AWAITING_STAY_TYPE' });
  await say('3');
  ctx.airtable.tables['WS_Rates'] = ctx.airtable.tables['WS_Rates'].filter(r => r.fields['Rate Type'] !== 'Per Day');
  await say('Sam Dlamini\n10am');
  assert.strictEqual(mine(ctx).fields['Status'], 'Enquiry');
  assert.strictEqual(events(ctx, 'stay_menu_unpriced').length, 1);
  assert.match(texts(ctx).slice(-1)[0], /short stays aren't available/);
});

test('with WABISTAY_HOLD_RELEASE on a menu booking carries a hold 30 minutes after arrival; off, none', async () => {
  process.env.WABISTAY_HOLD_RELEASE = '1';
  const on = await book('3', 'Sam Dlamini\n10am');
  assert.strictEqual(mine(on).fields['Hold Expires At'], iso(10, 30));
  mock.timers.reset();
  delete process.env.WABISTAY_HOLD_RELEASE;
  const off = await book('3', 'Sam Dlamini\n10am');
  assert.strictEqual(mine(off).fields['Hold Expires At'], undefined);
});

// ── after the booking: payment method, gate, PAID ROOM, checkout, cleaner ────

test('payment method: card or EFT takes a menu booking straight to CONFIRMED (no arrival-time question), for Day and Overnight too', async () => {
  for (const [choice, reply, now] of [['3', 'Sam\n10am', [9, 0]], ['4', 'Sam\n7pm', [12, 0]], ['1', 'Sam\n10am', [9, 0]]]) {
    const ctx = await book(choice, reply, { now });
    await say('1');
    assert.strictEqual(guestRow(ctx)['Session State'], 'CONFIRMED', choice);
    assert.strictEqual(mine(ctx).fields['Payment Method'], 'Card', choice);
    assert.ok(!texts(ctx).some(t => /What time do you expect to arrive/.test(t)), choice);
    assert.match(texts(ctx).slice(-1)[0], /Your booking is confirmed/);
  }
  const eft = await book('3', 'Sam\n10am');
  await say('2');
  assert.match(mine(eft).fields['Payment Reference'], /^[A-Z0-9]{4}$/);
  assert.strictEqual(guestRow(eft)['Session State'], 'CONFIRMED');
});

test('today\'s typed-dates overnight (the "multiple days" route) is unchanged: payment then asks for the arrival time', async () => {
  atSast(9, 0);
  const ctx = start({ state: 'AWAITING_STAY_TYPE' });
  await say('multiple days');
  await say('Sam Dlamini\n25 October\n27 October');
  await say('1');
  assert.strictEqual(guestRow(ctx)['Session State'], 'AWAITING_ETA');
  assert.match(texts(ctx).slice(-1)[0], /What time do you expect to arrive/);
});

test('gate: a paid Day booking checks in like any other; room goes Occupied', async () => {
  const ctx = await book('3', 'Sam\n10am');
  await say('1');
  mine(ctx).fields['Payment Status'] = 'Paid';
  await say('1');
  assert.strictEqual(mine(ctx).fields['Status'], 'Checked In');
  assert.strictEqual(ctx.airtable.tables['WS_Rooms'][0].fields['Status'], 'Occupied');
  assert.match(texts(ctx).slice(-1)[0], /Your room is \*Room 01\*/);
});

test('PAID ROOM settles a Day or Overnight menu booking before check-in (with WABISTAY_PAID_ROOM_CONFIRMED)', async () => {
  process.env.WABISTAY_PAID_ROOM_CONFIRMED = '1';
  for (const [choice, reply, now, amount] of [['3', 'Sam\n10am', [9, 0], 400], ['4', 'Sam\n7pm', [12, 0], 500]]) {
    const ctx = await book(choice, reply, { now });
    await say('1');
    await wh({ method: 'POST', body: metaTextPayload('27780384989', 'PAID ROOM 1 ' + amount + ' card') }, makeRes());
    assert.strictEqual(mine(ctx).fields['Payment Status'], 'Paid', choice);
    assert.strictEqual(mine(ctx).fields['Amount Paid'], amount, choice);
    mock.timers.reset();
  }
});

test('auto-checkout: a Day booking is warned at its 17:00 check-out and checked out 15 minutes later, like any other', async () => {
  atSast(9, 0);
  const ctx = start({ state: 'CHECKED_IN', bookings: [{ id: 'recDay1', fields: {
    'Guest': ['recG1'], 'Room': ['recR1'], 'Status': 'Checked In', 'Booking Type': 'Day', 'Notes': 'Stay: Day',
    'Check In': iso(10, 0), 'Check Out': iso(17, 0), 'Amount Due': 400, 'Payment Status': 'Paid', 'Booking Ref': 'WS-DAY001'
  } }] });
  const warned = await wh.runAutoCheckout(new Date(sast(17, 1)));
  assert.deepStrictEqual(warned, { warnings: 1, autoCheckouts: 0 });
  assert.match(texts(ctx).slice(-1)[0], /checkout time at Canary Street Guest Rooms has arrived/);
  const out = await wh.runAutoCheckout(new Date(sast(17, 20)));
  assert.deepStrictEqual(out, { warnings: 0, autoCheckouts: 1 });
  assert.strictEqual(bookings(ctx)[0].fields['Status'], 'Checked Out');
  assert.strictEqual(ctx.airtable.tables['WS_Rooms'][0].fields['Status'], 'Cleaning');
});

// ── reports and the rate label ───────────────────────────────────────────────

test('weekly recap: a Day stay counts as a part room-night (not 0) and in the short-stay count', () => {
  const property = { id: 'recP1', fields: { 'Property Name': 'Canary Street Guest Rooms' } };
  const rooms = [{ id: 'recR1', fields: { 'Room Name': 'Room 01', 'Status': 'Available', 'Property': ['recP1'] } }];
  const day = { id: 'recDay1', fields: { 'Room': ['recR1'], 'Booking Type': 'Day', 'Status': 'Checked Out', 'Amount Due': 400, 'Check In': iso(8, 0, 3), 'Check Out': iso(17, 0, 3) } };
  const hourly = { id: 'recHr1', fields: { 'Room': ['recR1'], 'Booking Type': 'Hourly', 'Status': 'Checked Out', 'Amount Due': 250, 'Check In': iso(10, 0, 4), 'Check Out': iso(12, 0, 4) } };
  const night = { id: 'recNt1', fields: { 'Room': ['recR1'], 'Booking Type': 'Overnight', 'Status': 'Checked Out', 'Amount Due': 500, 'Check In': iso(17, 0, 4), 'Check Out': iso(10, 0, 5) } };
  const w = { periodDays: 7, periodStartMs: sast(0, 0, 1), periodEndMs: sast(0, 0, 8), upcomingEndMs: sast(0, 0, 15) };
  const r = wh.aggregateWeeklyRecap(property, rooms, [day, hourly, night], w, new Map());
  assert.strictEqual(r.shortStayBookingsCount, 2, 'hourly + day');
  assert.strictEqual(r.overnightBookingsCount, 1);
  const expectedRoomNights = 9 / 24 + 2 / 24 + 1;
  assert.ok(Math.abs(r.occupancyRate - expectedRoomNights / 7) < 1e-3, 'occupancy ' + r.occupancyRate + ' vs ' + expectedRoomNights / 7);
});

test('the typed-dates rates menu labels each rate by its type: Per Night "per night", Per Day "per day" (no longer "per hour"); unconditional', async () => {
  assert.strictEqual(wh.rateUnitLabel('Per Night'), 'per night');
  assert.strictEqual(wh.rateUnitLabel('Per Day'), 'per day');
  assert.strictEqual(wh.rateUnitLabel('Per Hour'), 'per hour');
  atSast(9, 0);
  const ctx = start({ state: 'AWAITING_STAY_TYPE' }, null);   // flag OFF: the label fix is not behind it
  await say('2');
  const menu = texts(ctx).join('\n');
  assert.match(menu, /Day: R400 per day/);
  assert.match(menu, /Standard Night: R500 per night/);
  assert.ok(!/R400 per hour/.test(menu));
});

test('the flag is on the cold-start flag list: off by default, on only for 1/true', () => {
  const fresh = () => { delete require.cache[require.resolve('../api/wabistay/webhook.js')]; return require('../api/wabistay/webhook.js'); };
  delete process.env.WABISTAY_STAY_MENU;
  assert.strictEqual(fresh().wabistayFlagState().WABISTAY_STAY_MENU, 'off');
  for (const [v, exp] of [['1', 'on'], ['true', 'on'], ['yes', 'off']]) {
    process.env.WABISTAY_STAY_MENU = v;
    assert.strictEqual(fresh().wabistayFlagState().WABISTAY_STAY_MENU, exp, v);
  }
});
