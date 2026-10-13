// test/combinedstay.test.js
// WABISTAY_COMBINED_STAY (needs WABISTAY_RATE_CARD_V2 and WABISTAY_STAY_MENU): the combined Day + night booking.
// Arrival date, departure date and arrival time (08:00-13:00); R650 per day x nights (1 to 14); arrival up to 7 days ahead;
// check-out 09:00 on the departure day; stored as Booking Type Overnight with the note "Stay: Combined" (no new Airtable field).
// Time is mocked with node:test mock timers. In-memory only: MockAirtable + mocked fetch.

const { test, mock, afterEach } = require('node:test');
const assert = require('node:assert');
const { installEnv, installFetch, makeRes, metaTextPayload, MockAirtable } = require('./harness');

installEnv();
const ENV = ['WABISTAY_STAY_MENU', 'WABISTAY_RATE_CARD_V2', 'WABISTAY_COMBINED_STAY', 'WABISTAY_HOLD_RELEASE', 'WABISTAY_INTERACTIVE', 'WABISTAY_LEAN_COPY'];
const saved = Object.fromEntries(ENV.map(k => [k, process.env[k]]));
afterEach(() => {
  mock.timers.reset();
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

const wh = require('../api/wabistay/webhook.js');
const GUEST = '27784896186';
const OWNER = '27830000001'; // installEnv's OWNER_PHONE
const NOTIFY = '27831112222';
const LODGE = '0730260871';
const sast = (h, m = 0, d = 6) => Date.UTC(2026, 9, d, h - 2, m); // Tue 6 Oct 2026, SAST = UTC+2
function atSast(h, m = 0) { mock.timers.reset(); mock.timers.enable({ apis: ['Date'], now: sast(h, m) }); }
const iso = (h, m = 0, d = 6) => new Date(sast(h, m, d)).toISOString();

function seed({ state, combined = 650, rooms } = {}) {
  const prop = { 'Property Name': 'Canary Street Guest Rooms', 'Phone Number ID': '111000111000', 'City': 'Pretoria', 'Notify Phone': NOTIFY, 'Guest Redirect Phone': LODGE, 'Hourly Rate 1hr': 120, 'Hourly Rate 2hr': 200, 'Hourly Rate 3hr': 250 };
  const rates = [
    { id: 'recRateDay', fields: { 'Rate Name': 'Day', 'Rate Type': 'Per Day', 'Amount': 350, 'Active': true, 'Property': ['recP1'] } },
    { id: 'recRateNight0', fields: { 'Rate Name': 'Standard Night', 'Rate Type': 'Per Night', 'Amount': 450, 'Active': true, 'Property': ['recP1'] } }
  ];
  if (combined) rates.push({ id: 'recRateCombined', fields: { 'Rate Name': 'Day + night', 'Rate Type': 'Combined', 'Amount': combined, 'Active': true, 'Property': ['recP1'] } });
  return {
    WS_Properties: [{ id: 'recP1', fields: prop }],
    WS_Rooms: rooms || [{ id: 'recR1', fields: { 'Room Name': 'Room 01', 'Room Number': 1, 'Status': 'Available', 'Property': ['recP1'], 'Active': true } }],
    WS_Rates: rates, WS_Cleaners: [], WS_Enquiries: [],
    WS_Roles: [{ id: 'recRole1', fields: { 'Role Label': 'Reception', 'Role Type': 'Reception', 'Property': ['recP1'], 'Current Phone': '27780384989', 'Active': true } }],
    WS_Guests: [{ id: 'recG1', fields: { 'Guest Name': 'Unknown', 'Phone Number': GUEST, 'Session State': state || 'NEW' } }],
    WS_Bookings: []
  };
}
function start(opts = {}, { combinedFlag = '1' } = {}) {
  process.env.WABISTAY_STAY_MENU = '1';
  process.env.WABISTAY_RATE_CARD_V2 = '1';
  if (combinedFlag === null) delete process.env.WABISTAY_COMBINED_STAY; else process.env.WABISTAY_COMBINED_STAY = combinedFlag;
  const ctx = { airtable: new MockAirtable(seed(opts)), sends: [], axiom: [] };
  installFetch(ctx);
  return ctx;
}
const say = (text) => wh({ method: 'POST', body: metaTextPayload(GUEST, text) }, makeRes());
const guestRow = ctx => ctx.airtable.tables['WS_Guests'][0].fields;
const bookings = ctx => ctx.airtable.tables['WS_Bookings'];
const mine = ctx => bookings(ctx).find(b => String(b.fields['Notes'] || '').startsWith('Stay: ')) || bookings(ctx)[0] || { fields: {} };
const texts = (ctx, to = GUEST) => ctx.sends.filter(s => s.type === 'text' && s.to === to).map(s => s.body);
const greeting = ctx => texts(ctx).find(t => /Our rates/.test(t));

async function book(reply, { now = [9, 0], opts = {}, flags = {}, choice = 'day + night' } = {}) {
  atSast(...now);
  const ctx = start({ state: 'AWAITING_STAY_TYPE', ...opts }, flags);
  await say(choice);
  await say(reply);
  return ctx;
}

test('the combined line shows only with the flag AND a priced Combined rate; it is the last numbered option and is never marked closed', async () => {
  atSast(9, 0);
  const on = start();
  await say('hi');
  assert.match(greeting(on), /• Day \+ night: R650 per day\. Arrive between 8am and 1pm, check out at 9am on your departure day\./);
  assert.match(greeting(on), /\n4 - Overnight\n5 - Day \+ night\n/);
  mock.timers.reset();
  atSast(18, 0);
  const evening = start();
  await say('hi');
  assert.match(greeting(evening), /Reply with a number:\n1 - Overnight\n2 - Day \+ night\n/, 'still bookable in the evening (any later date)');
  assert.ok(!/Day \+ night: R650 per day\.[^\n]*closed/.test(greeting(evening)));
  mock.timers.reset();
  atSast(9, 0);
  const noRate = start({ combined: null });
  await say('hi');
  assert.ok(!/Day \+ night/.test(greeting(noRate)), 'no Combined rate row: not shown');
  mock.timers.reset();
  atSast(9, 0);
  const flagOff = start({}, { combinedFlag: null });
  await say('hi');
  assert.ok(!/Day \+ night/.test(greeting(flagOff)), 'flag off: not shown');
});

test('choosing it by number (5 at 09:00) asks for name, both dates and the arrival time', async () => {
  atSast(9, 0);
  const c = start({ state: 'AWAITING_STAY_TYPE' });
  await say('5');
  assert.strictEqual(mine(c).fields['Notes'], 'Stay: Combined');
  assert.match(texts(c).slice(-1)[0], /^Day \+ night: please send your full name, your arrival date, your departure date and the time you expect to arrive \(between 8am and 1pm\)/);
});

test('2 nights: R1300, check-in 09:00 on arrival, check-out 09:00 on departure, stored as Overnight, rate row linked, payment menu next', async () => {
  const c = await book('Sam Dlamini\n8 October\n10 October\n9am');
  const b = mine(c).fields;
  assert.strictEqual(b['Booking Type'], 'Overnight');
  assert.strictEqual(b['Notes'], 'Stay: Combined');
  assert.strictEqual(b['Check In'], iso(9, 0, 8));
  assert.strictEqual(b['Check Out'], iso(9, 0, 10));
  assert.strictEqual(b['Amount Due'], 1300);
  assert.deepStrictEqual(b['Rate Applied'], ['recRateCombined']);
  assert.strictEqual(b['Status'], 'Confirmed');
  assert.deepStrictEqual(b['Room'], ['recR1']);
  assert.strictEqual(guestRow(c)['Session State'], 'AWAITING_PAYMENT_METHOD');
  const t = texts(c).find(x => /is booked/.test(x));
  assert.match(t, /Your \*Day \+ night\* stay is booked[\s\S]*\*Arriving:\* 8 Oct(ober)? at 9:00am[\s\S]*\*Leaving:\* 10 Oct(ober)?, check-out 9:00am[\s\S]*\*Nights:\* 2 nights[\s\S]*\*Price:\* R1300\n\nNeed more time\? Ask reception: an extra 2 hours is R200\./);
  assert.ok(texts(c).some(x => /cashless property/.test(x)), 'payment menu follows');
});

test('the reception alert shows arrival date, arrival time and departure date; the approved template carries "day and night until <date>"', async () => {
  const c = await book('Sam Dlamini\n8 October\n10 October\n9am');
  const alert = texts(c, NOTIFY).concat(texts(c, OWNER)).join('\n');
  assert.match(alert, /New \*Day \+ night\* booking from Sam Dlamini/);
  assert.match(alert, /Arrival: 8 Oct(ober)? at 9:00am/);
  assert.match(alert, /Departure: 10 Oct(ober)?, check-out 9:00am/);
  assert.match(alert, /Nights: 2 nights/);
  const params = wh.newBookingTemplateParams({ propertyName: 'P', guestName: 'S', guestPhone: '1', bookingRef: 'R', bookingType: 'Combined', checkInIso: iso(9, 0, 8), checkOutIso: iso(9, 0, 10), amount: 1300 });
  assert.strictEqual(params[4], 'day and night until 10 October');
  assert.strictEqual(params[5], '8 Oct at 9:00am');
});

test('minimum 1 night is R650, and a one-line message works', async () => {
  const c = await book('Sam Dlamini 7 October 8 October 10am');
  assert.strictEqual(mine(c).fields['Amount Due'], 650);
  assert.strictEqual(mine(c).fields['Check In'], iso(10, 0, 7));
  assert.strictEqual(mine(c).fields['Check Out'], iso(9, 0, 8));
});

test('maximum 14 nights and arrival 7 days ahead are accepted; 15 nights or 8 days ahead goes to reception with the phone number; nothing is booked', async () => {
  const ok14 = await book('Sam Dlamini\n13 October\n27 October\n11am');
  assert.strictEqual(mine(ok14).fields['Amount Due'], 650 * 14);
  mock.timers.reset();
  const ok7 = await book('Sam Dlamini\n13 October\n14 October\n11am');
  assert.strictEqual(mine(ok7).fields['Check In'], iso(11, 0, 13));
  mock.timers.reset();
  for (const text of ['Sam Dlamini\n13 October\n28 October\n11am', 'Sam Dlamini\n14 October\n15 October\n11am']) {
    const c = await book(text);
    assert.strictEqual(mine(c).fields['Check In'], undefined, text);
    assert.match(texts(c).slice(-1)[0], /longer than 14 nights, or arrivals more than 7 days away, please phone reception on 0730260871/);
    mock.timers.reset();
  }
});

test('an arrival time outside 08:00-13:00 is refused and overnight is offered at the Per Night price; replying "overnight" switches the booking', async () => {
  const c = await book('Sam Dlamini\n8 October\n9 October\n2pm');
  assert.strictEqual(mine(c).fields['Check In'], undefined);
  assert.match(texts(c).slice(-1)[0], /^Day \+ night arrivals must be between 8am and 1pm\. For a later arrival we can book you overnight for R450 \(check in 5pm to 11pm, check out 9am\)\. Reply \*overnight\*/);
  await say('overnight');
  assert.strictEqual(mine(c).fields['Notes'], 'Stay: Overnight');
  assert.match(texts(c).slice(-1)[0], /send your full name and the time you expect to arrive/);
  await say('Sam Dlamini 7pm');
  assert.strictEqual(mine(c).fields['Booking Type'], 'Overnight');
  assert.strictEqual(mine(c).fields['Amount Due'], 450);
  assert.strictEqual(mine(c).fields['Check Out'], iso(9, 0, 7));
});

test('arrival time boundaries: 08:00 and 13:00 are fine, 13:01 and 07:59 are not; bare hours are read inside the window (1 is 13:00, 3 is refused)', async () => {
  for (const [t, ok] of [['8am', true], ['13:00', true], ['1pm', true], ['13:01', false], ['7:59', false], ['9', true], ['1', true], ['3', false]]) {
    const c = await book(`Sam Dlamini\n8 October\n9 October\n${t}`);
    assert.strictEqual(!!mine(c).fields['Check In'], ok, t);
    mock.timers.reset();
  }
});

test('dates that do not work (same day out, departure before arrival, arrival in the past, a time already past today) re-ask and book nothing', async () => {
  for (const [text, now] of [['Sam Dlamini\n9 October\n9 October\n9am', [9, 0]], ['Sam Dlamini\n9 October\n8 October\n9am', [9, 0]], ['Sam Dlamini\n5 October\n7 October\n9am', [9, 0]], ['Sam Dlamini\n6 October\n7 October\n9am', [11, 0]]]) {
    const c = await book(text, { now });
    assert.strictEqual(mine(c).fields['Check In'], undefined, text);
    assert.match(texts(c).slice(-1)[0], /those dates do not work/);
    mock.timers.reset();
  }
});

test('same-day arrival later this morning is fine (08:30, arrive 10am)', async () => {
  const c = await book('Sam Dlamini\n6 October\n7 October\n10am', { now: [8, 30] });
  assert.strictEqual(mine(c).fields['Check In'], iso(10, 0));
});

test('an unreadable message gets the re-prompt and books nothing', async () => {
  const c = await book('Sam Dlamini\nsometime');
  assert.match(texts(c).slice(-1)[0], /I need your full name, arrival date, departure date and arrival time/);
  assert.strictEqual(mine(c).fields['Check In'], undefined);
});

test('a Combined rate that disappears between the menu and the booking fails closed: no booking, no price made up', async () => {
  atSast(9, 0);
  const c = start({ state: 'AWAITING_STAY_TYPE' });
  await say('day + night');
  c.airtable.tables['WS_Rates'] = c.airtable.tables['WS_Rates'].filter(r => r.fields['Rate Type'] !== 'Combined');
  await say('Sam Dlamini\n8 October\n9 October\n9am');
  assert.strictEqual(mine(c).fields['Check In'], undefined);
  assert.match(texts(c).slice(-1)[0], /short stays aren't available/);
});

test('two active Combined rate rows are ambiguous: the line is not offered', async () => {
  atSast(9, 0);
  const c = start();
  c.airtable.tables['WS_Rates'].push({ id: 'recRateCombined2', fields: { 'Rate Name': 'Other', 'Rate Type': 'Combined', 'Amount': 700, 'Active': true, 'Property': ['recP1'] } });
  await say('hi');
  assert.ok(!/Day \+ night/.test(greeting(c)));
});

test('no free room: the booking stays inert and nothing is confirmed', async () => {
  atSast(9, 0);
  const c = start({ state: 'AWAITING_STAY_TYPE' });
  await say('day + night');
  c.airtable.tables['WS_Rooms'][0].fields['Active'] = false;
  await say('Sam Dlamini\n8 October\n9 October\n9am');
  assert.strictEqual(mine(c).fields['Check In'], undefined);
  assert.notStrictEqual(mine(c).fields['Status'], 'Confirmed');
});

test('with WABISTAY_HOLD_RELEASE on the booking carries a hold 30 minutes after arrival (the unpaid release that covers it); card goes straight to CONFIRMED', async () => {
  process.env.WABISTAY_HOLD_RELEASE = '1';
  const c = await book('Sam Dlamini\n8 October\n9 October\n9am');
  assert.strictEqual(mine(c).fields['Hold Expires At'], new Date(Date.parse(iso(9, 0, 8)) + 30 * 60 * 1000).toISOString());
  await say('1');
  assert.strictEqual(guestRow(c)['Session State'], 'CONFIRMED');
});

test('without WABISTAY_COMBINED_STAY, "day + night" is not a product', async () => {
  atSast(9, 0);
  const c = start({ state: 'AWAITING_STAY_TYPE' }, { combinedFlag: null });
  await say('day + night');
  assert.ok(!bookings(c).some(b => b.fields['Notes'] === 'Stay: Combined'));
});
