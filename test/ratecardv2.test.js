// test/ratecardv2.test.js
// WABISTAY_RATE_CARD_V2 (needs WABISTAY_STAY_MENU): new rates (2h R200, 3h R250, Day 4h R350 bookable 08:00-13:00 and
// out by 17:00, Overnight R450), 1 hour gone, check-out 09:00, and the menu that always prints the whole rate card
// while numbering only what can be booked now, 1, 2, 3 ... with no gaps. Prices come from Airtable (seeded here).
// Time is mocked with node:test mock timers. In-memory only: MockAirtable + mocked fetch.

const { test, mock, afterEach } = require('node:test');
const assert = require('node:assert');
const { installEnv, installFetch, makeRes, metaTextPayload, MockAirtable } = require('./harness');

installEnv();
const ENV = ['WABISTAY_STAY_MENU', 'WABISTAY_RATE_CARD_V2', 'WABISTAY_COMBINED_STAY', 'WABISTAY_HOLD_RELEASE', 'WABISTAY_INTERACTIVE', 'WABISTAY_LEAN_COPY', 'WABISTAY_HIDE_ONE_HOUR', 'WABISTAY_BOOKING_EVENT'];
const saved = Object.fromEntries(ENV.map(k => [k, process.env[k]]));
afterEach(() => {
  mock.timers.reset();
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

const wh = require('../api/wabistay/webhook.js');
const GUEST = '27784896186';
const LODGE = '0730260871';
const sast = (h, m = 0, d = 6) => Date.UTC(2026, 9, d, h - 2, m); // Tue 6 Oct 2026, SAST = UTC+2
function atSast(h, m = 0) { mock.timers.reset(); mock.timers.enable({ apis: ['Date'], now: sast(h, m) }); }
const iso = (h, m = 0, d = 6) => new Date(sast(h, m, d)).toISOString();

function seed({ state, dayRate = 350, nightRates = [450], hourly = { 'Hourly Rate 2hr': 200, 'Hourly Rate 3hr': 250 }, combined = null } = {}) {
  const prop = { 'Property Name': 'Canary Street Guest Rooms', 'Phone Number ID': '111000111000', 'City': 'Pretoria', 'Notify Phone': '27831112222', 'Guest Redirect Phone': LODGE, 'Hourly Rate 1hr': 120, ...hourly };
  const rates = [];
  if (dayRate) rates.push({ id: 'recRateDay', fields: { 'Rate Name': 'Day', 'Rate Type': 'Per Day', 'Amount': dayRate, 'Active': true, 'Property': ['recP1'] } });
  nightRates.forEach((a, i) => rates.push({ id: 'recRateNight' + i, fields: { 'Rate Name': 'Standard Night', 'Rate Type': 'Per Night', 'Amount': a, 'Active': true, 'Property': ['recP1'] } }));
  if (combined) rates.push({ id: 'recRateCombined', fields: { 'Rate Name': 'Day + night', 'Rate Type': 'Combined', 'Amount': combined, 'Active': true, 'Property': ['recP1'] } });
  return {
    WS_Properties: [{ id: 'recP1', fields: prop }],
    WS_Rooms: [{ id: 'recR1', fields: { 'Room Name': 'Room 01', 'Room Number': 1, 'Status': 'Available', 'Property': ['recP1'], 'Active': true } }],
    WS_Rates: rates, WS_Cleaners: [], WS_Enquiries: [],
    WS_Roles: [{ id: 'recRole1', fields: { 'Role Label': 'Reception', 'Role Type': 'Reception', 'Property': ['recP1'], 'Current Phone': '27780384989', 'Active': true } }],
    WS_Guests: [{ id: 'recG1', fields: { 'Guest Name': 'Unknown', 'Phone Number': GUEST, 'Session State': state || 'NEW' } }],
    WS_Bookings: []
  };
}
function start(opts = {}, { v2 = '1', menu = '1', combined = null } = {}) {
  if (menu === null) delete process.env.WABISTAY_STAY_MENU; else process.env.WABISTAY_STAY_MENU = menu;
  if (v2 === null) delete process.env.WABISTAY_RATE_CARD_V2; else process.env.WABISTAY_RATE_CARD_V2 = v2;
  if (combined === null) delete process.env.WABISTAY_COMBINED_STAY; else process.env.WABISTAY_COMBINED_STAY = combined;
  const ctx = { airtable: new MockAirtable(seed(opts)), sends: [], axiom: [] };
  installFetch(ctx);
  return ctx;
}
const say = (text) => wh({ method: 'POST', body: metaTextPayload(GUEST, text) }, makeRes());
const guestRow = ctx => ctx.airtable.tables['WS_Guests'][0].fields;
const bookings = ctx => ctx.airtable.tables['WS_Bookings'];
const mine = ctx => bookings(ctx).find(b => String(b.fields['Notes'] || '').startsWith('Stay: ')) || bookings(ctx)[0];
const texts = (ctx, to = GUEST) => ctx.sends.filter(s => s.type === 'text' && s.to === to).map(s => s.body);
const greeting = ctx => texts(ctx).find(t => /Our rates/.test(t));
const CLOSED = '(closed for today, back from 08:00)';

async function book(choice, reply, { now = [9, 0], opts = {}, flags = {} } = {}) {
  atSast(...now);
  const ctx = start({ state: 'AWAITING_STAY_TYPE', ...opts }, flags);
  await say(choice);
  await say(reply);
  return ctx;
}

// ── the greeting: whole rate card + only what is bookable, numbered without gaps ─────────────────────

test('09:00: the whole rate card with prices and windows, no 1 hour, four numbered options 1-4', async () => {
  atSast(9, 0);
  const ctx = start();
  await say('hi');
  const g = greeting(ctx);
  assert.ok(g, 'rate card greeting sent');
  assert.match(g, /^Hi! 👋 Welcome to Canary Street Guest Rooms/);
  assert.match(g, /• 2 hours: R200\. Arrive between 8am and 5pm\./);
  assert.match(g, /• 3 hours: R250\. Arrive between 8am and 5pm\./);
  assert.match(g, /• Day stay \(4 hours\): R350\. Arrive between 8am and 1pm, leave by 5pm\./);
  assert.match(g, /• Overnight: R450\. Check in between 5pm and 11pm, check out at 9am\./);
  assert.ok(!/closed for today/.test(g), 'nothing closed at 09:00');
  assert.ok(!/1 hour|R120/.test(g), 'the 1 hour stay is gone');
  assert.match(g, /Reply with a number:\n1 - 2 hours\n2 - 3 hours\n3 - Day stay \(4 hours\)\n4 - Overnight\n/);
  assert.match(g, /Need more time\? Ask reception: an extra 2 hours is R200\./);
  assert.ok(g.endsWith(`Operating hours are 8am to 11pm. Another day? Please phone reception on ${LODGE}.`));
  assert.strictEqual(guestRow(ctx)['Session State'], 'AWAITING_STAY_TYPE');
});

test('14:00: Day is marked closed on the card, and the list is 1, 2, 3 with no skip (2 hours, 3 hours, Overnight)', async () => {
  atSast(14, 0);
  const ctx = start();
  await say('hi');
  const g = greeting(ctx);
  assert.ok(g.includes('• Day stay (4 hours): R350. Arrive between 8am and 1pm, leave by 5pm. ' + CLOSED), 'Day line marked closed');
  assert.match(g, /Reply with a number:\n1 - 2 hours\n2 - 3 hours\n3 - Overnight\n/);
  assert.ok(!/\n4 - /.test(g), 'no fourth option');
  assert.ok(!/3 - Day/.test(g), 'Day is not selectable');
});

test('18:00: short stays and Day are closed on the card; only Overnight is selectable as 1', async () => {
  atSast(18, 0);
  const ctx = start();
  await say('hi');
  const g = greeting(ctx);
  assert.strictEqual((g.match(/closed for today, back from 08:00/g) || []).length, 3, '2h, 3h and Day show closed');
  assert.match(g, /• Overnight: R450\. Check in between 5pm and 11pm, check out at 9am\.\n/);
  assert.match(g, /Reply with a number:\n1 - Overnight\n/);
});

test('boundaries: Day is bookable until 12:59 and closed from 13:00; short stays until 16:59', async () => {
  for (const [h, m, day, short] of [[12, 59, true, true], [13, 0, false, true], [16, 59, false, true], [17, 0, false, false]]) {
    atSast(h, m);
    const ctx = start();
    await say('hi');
    const g = greeting(ctx);
    assert.strictEqual(/\n\d - Day stay/.test(g), day, `Day at ${h}:${m}`);
    assert.strictEqual(/\n1 - 2 hours/.test(g), short, `2 hours at ${h}:${m}`);
    mock.timers.reset();
  }
});

test('outside 08:00-22:59: no rate card, today\'s greeting (closed hours are the after-hours flow\'s job)', async () => {
  for (const [h, m] of [[23, 0], [3, 0], [7, 59]]) {
    atSast(h, m);
    const ctx = start();
    await say('hi');
    assert.ok(!greeting(ctx), `${h}:${m}`);
    assert.match(texts(ctx).join('\n'), /short stay\* \(a few hours\)/);
    mock.timers.reset();
  }
});

test('flag off: today\'s greeting and today\'s prices wording — V2 text never appears', async () => {
  atSast(9, 0);
  const ctx = start({}, { v2: null });
  await say('hi');
  assert.ok(!greeting(ctx));
  assert.match(texts(ctx).join('\n'), /1 - 2 hour stay, R200\n2 - 3 hour stay, R250\n3 - Full day stay, R350\. Arrive between 8am and 3pm, leave by 5pm\.\n4 - Overnight stay, R450\. Check in between 5pm and 11pm, check out by 10am\./);
});

test('a product that cannot be priced is left off the card and the list; with nothing priceable there is no menu', async () => {
  atSast(9, 0);
  const noDay = start({ dayRate: null });
  await say('hi');
  assert.ok(!/Day stay/.test(greeting(noDay)));
  assert.match(greeting(noDay), /Reply with a number:\n1 - 2 hours\n2 - 3 hours\n3 - Overnight\n/);
  mock.timers.reset();
  atSast(9, 0);
  const noHourly = start({ hourly: { 'Hourly Rate 2hr': 0, 'Hourly Rate 3hr': 0 } });
  await say('hi');
  assert.ok(!/2 hours/.test(greeting(noHourly)));
  assert.match(greeting(noHourly), /Reply with a number:\n1 - Day stay \(4 hours\)\n2 - Overnight\n/);
  mock.timers.reset();
  atSast(18, 0);
  const none = start({ nightRates: [], dayRate: null });
  await say('hi');
  assert.ok(!greeting(none));
});

// ── choosing: the number means the position in the list the guest was shown ─────────────────────────

test('at 14:00 "3" is Overnight (position 3), not Day (old fixed key 3); typed "day" is refused as closed', async () => {
  atSast(14, 0);
  const ctx = start({ state: 'AWAITING_STAY_TYPE' });
  await say('day');
  assert.ok(!mine(ctx), 'nothing parked for a closed product');
  assert.match(texts(ctx).slice(-1)[0], /Please reply with a number:\n1 - 2 hours\n2 - 3 hours\n3 - Overnight/);
  await say('3');
  assert.strictEqual(mine(ctx).fields['Booking Type'], 'Overnight');
  assert.strictEqual(mine(ctx).fields['Notes'], 'Stay: Overnight');
});

test('a number beyond the list ("4" at 14:00) is refused with the numbered list; "2 hours" typed still means two hours', async () => {
  atSast(14, 0);
  const ctx = start({ state: 'AWAITING_STAY_TYPE' });
  await say('4');
  assert.ok(!mine(ctx));
  assert.match(texts(ctx).slice(-1)[0], /1 - 2 hours\n2 - 3 hours\n3 - Overnight/);
  await say('2 hours');
  assert.strictEqual(mine(ctx).fields['Notes'], 'Stay: 2 hours');
});

test('parseStayMenuChoice (V2): a bare number is the list position; words map to fixed keys; the 1 hour words are not a product', () => {
  process.env.WABISTAY_RATE_CARD_V2 = '1';
  const menu = { keys: ['1', '2', '4'] };
  assert.strictEqual(wh.parseStayMenuChoice('3', menu), '4');
  assert.strictEqual(wh.parseStayMenuChoice('1', menu), '1');
  assert.strictEqual(wh.parseStayMenuChoice('4', menu), null);
  assert.strictEqual(wh.parseStayMenuChoice('2 hours', menu), '1');
  assert.strictEqual(wh.parseStayMenuChoice('3 hours', menu), '2');
  assert.strictEqual(wh.parseStayMenuChoice('overnight', menu), '4');
  assert.strictEqual(wh.parseStayMenuChoice('day', menu), '3');
  assert.strictEqual(wh.parseStayMenuChoice('1 hour', menu), null);
  assert.strictEqual(wh.parseStayMenuChoice('multiple days', menu), 'multi');
});

// ── the bookings: windows, check-out times, prices ──────────────────────────────────────────────────

test('2 hours: 10am -> 10:00 to 12:00, R200 from the property\'s own rate; the confirmation mentions the R200 extra 2 hours', async () => {
  const ctx = await book('1', 'Sam Dlamini\n10am');
  const b = mine(ctx).fields;
  assert.strictEqual(b['Booking Type'], 'Hourly');
  assert.strictEqual(b['Check In'], iso(10, 0));
  assert.strictEqual(b['Check Out'], iso(12, 0));
  assert.strictEqual(b['Amount Due'], 200);
  const msg = texts(ctx).find(x => /is booked/.test(x));
  assert.match(msg, /Your \*2 hours\* is booked\.[\s\S]*\*Price:\* R200\n\nNeed more time\? Ask reception: an extra 2 hours is R200\./);
});

test('3 hours: 2pm -> 14:00 to 17:00, R250', async () => {
  const ctx = await book('2', 'Sam Dlamini 2pm');
  const b = mine(ctx).fields;
  assert.strictEqual(b['Check Out'], iso(17, 0));
  assert.strictEqual(b['Amount Due'], 250);
});

test('Day stay: 10am -> 10:00 to 14:00 (4 hours), R350, linked to the Per Day row', async () => {
  const ctx = await book('3', 'Sam Dlamini\n10am');
  const b = mine(ctx).fields;
  assert.strictEqual(b['Booking Type'], 'Day');
  assert.strictEqual(b['Check In'], iso(10, 0));
  assert.strictEqual(b['Check Out'], iso(14, 0));
  assert.strictEqual(b['Amount Due'], 350);
  assert.deepStrictEqual(b['Rate Applied'], ['recRateDay']);
  assert.match(texts(ctx).find(x => /is booked/.test(x)), /Your \*Day stay \(4 hours\)\* is booked[\s\S]*\*Until:\* 6 Oct at 2:00pm[\s\S]*\*Price:\* R350/);
});

test('Day stay: arriving at 13:00 ends at 17:00 (the latest allowed); 1:30pm and 2pm are refused', async () => {
  const ok = await book('3', 'Sam Dlamini 1pm', { now: [9, 0] });
  assert.strictEqual(mine(ok).fields['Check Out'], iso(17, 0));
  mock.timers.reset();
  for (const t of ['1:30pm', '2pm']) {
    const ctx = await book('3', 'Sam Dlamini ' + t, { now: [9, 0] });
    assert.strictEqual(mine(ctx).fields['Check In'], undefined, t);
    assert.match(texts(ctx).slice(-1)[0], /Day stay arrival must be between 08:00 and 13:00 today/);
    mock.timers.reset();
  }
});

test('Overnight: 7pm -> 19:00 today to 09:00 tomorrow (was 10:00), R450 flat', async () => {
  const ctx = await book('4', 'Sam Dlamini 7pm', { now: [12, 0] });
  const b = mine(ctx).fields;
  assert.strictEqual(b['Booking Type'], 'Overnight');
  assert.strictEqual(b['Check In'], iso(19, 0));
  assert.strictEqual(b['Check Out'], iso(9, 0, 7));
  assert.strictEqual(b['Amount Due'], 450);
  assert.match(texts(ctx).find(x => /is booked/.test(x)), /Your \*Overnight\* is booked[\s\S]*\*Until:\* 7 Oct at 9:00am/);
});

test('flag off: Overnight still checks out at 10:00 and Day still ends at 17:00', async () => {
  const on = await book('4', 'Sam Dlamini 7pm', { now: [12, 0], flags: { v2: null } });
  assert.strictEqual(mine(on).fields['Check Out'], iso(10, 0, 7));
  mock.timers.reset();
  const day = await book('3', 'Sam Dlamini 10am', { flags: { v2: null } });
  assert.strictEqual(mine(day).fields['Check Out'], iso(17, 0));
});

test('stayWindowForArrival (V2): Day 08:00-13:00 and 4 hours long; Overnight out at 09:00 tomorrow; short stays before 17:00', () => {
  process.env.WABISTAY_RATE_CARD_V2 = '1';
  const now = new Date(sast(7, 0));
  const P = wh.STAY_PRODUCTS;
  assert.strictEqual(wh.stayWindowForArrival(P['3'], { hour: 13, minute: 0 }, now).ok, true);
  assert.strictEqual(wh.stayWindowForArrival(P['3'], { hour: 13, minute: 1 }, now).ok, false);
  assert.strictEqual(wh.stayWindowForArrival(P['3'], { hour: 8, minute: 0 }, now).coIso, iso(12, 0));
  assert.strictEqual(wh.stayWindowForArrival(P['4'], { hour: 17, minute: 0 }, now).coIso, iso(9, 0, 7));
  assert.strictEqual(wh.stayWindowForArrival(P['1'], { hour: 16, minute: 59 }, now).ok, true);
  assert.strictEqual(wh.stayWindowForArrival(P['1'], { hour: 17, minute: 0 }, now).ok, false);
});

// ── 1 hour is gone, check-out 09:00 in the typed-dates overnight flow ─────────────────────────────────

test('the 1 hour stay is not offered or accepted anywhere in the guest flow when V2 is on (implies HIDE_ONE_HOUR)', async () => {
  process.env.WABISTAY_RATE_CARD_V2 = '1';
  delete process.env.WABISTAY_HIDE_ONE_HOUR;
  // The legacy short-stay path (reached outside menu hours) must also refuse "1": drive it at 23:30.
  atSast(23, 30);
  const ctx = start({ state: 'AWAITING_HOURLY_DURATION' });
  ctx.airtable.tables['WS_Bookings'].push({ id: 'recB1', fields: { 'Guest': ['recG1'], 'Status': 'Enquiry', 'Booking Type': 'Hourly', 'Check In': iso(23, 45), 'Payment Status': 'Unpaid' } });
  await say('1');
  assert.strictEqual(ctx.airtable.tables['WS_Bookings'][0].fields['Status'], 'Enquiry', 'nothing was booked for "1"');
  assert.ok(!/1 - 1 hour/.test(texts(ctx).join('\n')));
});

test('typed-dates overnight (multiple days): check-out is 09:00 under V2, 10:00 with the flag off; check-in stays 14:00', async () => {
  for (const [v2, hour] of [['1', 9], [null, 10]]) {
    atSast(9, 0);
    const ctx = start({ state: 'AWAITING_STAY_TYPE' }, { v2, menu: null });
    await say('multiple days');
    await say('Sam Dlamini\n25 October\n27 October');
    const b = bookings(ctx)[0].fields;
    assert.strictEqual(b['Check In'], iso(14, 0, 25), 'check-in 14:00');
    assert.strictEqual(new Date(Date.parse(b['Check Out']) + 2 * 3600 * 1000).getUTCHours(), hour, `v2=${v2}`);
    mock.timers.reset();
  }
});

// ── extensions are reception's job ──────────────────────────────────────────────────────────────────

test('EXTEND from a checked-in guest (any stay type) goes to reception with the 2 hour price; nothing is written; flag off still extends in the bot', async () => {
  for (const type of ['Hourly', 'Overnight']) {
    atSast(11, 0);
    const ctx = start({ state: 'CHECKED_IN' });
    ctx.airtable.tables['WS_Bookings'].push({ id: 'recB1', fields: { 'Guest': ['recG1'], 'Status': 'Checked In', 'Booking Type': type, 'Check In': iso(9, 0), 'Check Out': iso(12, 0), 'Amount Due': 200, 'Payment Status': 'Paid', 'Room': ['recR1'] } });
    await say('extend');
    assert.match(texts(ctx).slice(-1)[0], /^Need more time\? Please ask reception\. An extra 2 hours is R200\.$/, type);
    assert.strictEqual(ctx.airtable.tables['WS_Bookings'][0].fields['Check Out'], iso(12, 0), 'Check Out untouched');
    assert.strictEqual(ctx.airtable.tables['WS_Bookings'][0].fields['Amount Due'], 200, 'no extra charge');
    mock.timers.reset();
  }
  atSast(11, 0);
  const off = start({ state: 'CHECKED_IN' }, { v2: null });
  off.airtable.tables['WS_Bookings'].push({ id: 'recB1', fields: { 'Guest': ['recG1'], 'Status': 'Checked In', 'Booking Type': 'Hourly', 'Check In': iso(9, 0), 'Check Out': iso(12, 0), 'Amount Due': 200, 'Payment Status': 'Paid', 'Room': ['recR1'] } });
  await say('extend');
  assert.ok(!/ask reception/.test(texts(off).join('\n')), 'flag off: today\'s extend flow runs');
});

// ── review support: one Axiom event per booking (WABISTAY_BOOKING_EVENT) and the Combined row stays out of the typed-dates menu ──

test('WABISTAY_BOOKING_EVENT: one booking_created_detail per booking, with stay, nights, amount and arrival; none with the flag off', async () => {
  process.env.WABISTAY_BOOKING_EVENT = '1';
  const events = ctx => ctx.axiom.filter(e => e.event === 'booking_created_detail');
  const h2 = await book('1', 'Sam Dlamini\n10am');
  assert.deepStrictEqual(events(h2).map(e => [e.stay, e.bookingType, e.nights, e.amount, e.arrivalDate]), [['h2', 'Hourly', 0, 200, '2026-10-06']]);
  mock.timers.reset();
  const day = await book('3', 'Sam Dlamini\n10am');
  assert.deepStrictEqual(events(day).map(e => [e.stay, e.nights, e.amount]), [['day', 0, 350]]);
  mock.timers.reset();
  const night = await book('4', 'Sam Dlamini 7pm', { now: [12, 0] });
  assert.deepStrictEqual(events(night).map(e => [e.stay, e.nights, e.amount]), [['overnight', 1, 450]]);
  mock.timers.reset();
  atSast(9, 0);
  const typed = start({ state: 'AWAITING_STAY_TYPE' }, { menu: null });
  await say('multiple days');
  await say('Sam Dlamini\n25 October\n27 October');
  assert.deepStrictEqual(events(typed).map(e => [e.stay, e.nights, e.arrivalDate]), [['overnight_typed', 2, '2026-10-25']]);
  mock.timers.reset();
  delete process.env.WABISTAY_BOOKING_EVENT;
  const off = await book('1', 'Sam Dlamini\n10am');
  assert.strictEqual(events(off).length, 0);
});

test('an active Combined rate row is never listed in the typed-dates "multiple days" rate menu (it has no per-hour unit)', async () => {
  atSast(9, 0);
  const ctx = start({ state: 'AWAITING_STAY_TYPE', combined: 650 }, { menu: null, v2: null });
  await say('multiple days');
  const menu = texts(ctx).join('\n');
  assert.match(menu, /Standard Night: R450 per night/);
  assert.ok(!/Day \+ night|R650/.test(menu));
});
