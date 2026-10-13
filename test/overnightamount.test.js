// test/overnightamount.test.js
// Typed-dates overnight ("multiple days") booking: Amount Due for a stay of N nights.
// Reads the live code path with no flags set. Finding under test: Amount Due is ONE night's rate whatever the nights.

const { test, mock, afterEach } = require('node:test');
const assert = require('node:assert');
const { installEnv, installFetch, makeRes, metaTextPayload, MockAirtable } = require('./harness');

installEnv();
const ENV = ['WABISTAY_STAY_MENU', 'WABISTAY_OVERNIGHT_AMOUNT_NIGHTS'];
const saved = Object.fromEntries(ENV.map(k => [k, process.env[k]]));
afterEach(() => {
  mock.timers.reset();
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

const wh = require('../api/wabistay/webhook.js');
const GUEST = '27784896186';
const sast = (h, m = 0, d = 6) => Date.UTC(2026, 9, d, h - 2, m);

function seed() {
  return {
    WS_Properties: [{ id: 'recP1', fields: { 'Property Name': 'Canary Street Guest Rooms', 'Phone Number ID': '111000111000', 'Notify Phone': '27831112222', 'Guest Redirect Phone': '0730260871' } }],
    WS_Rooms: [{ id: 'recR1', fields: { 'Room Name': 'Room 01', 'Room Number': 1, 'Status': 'Available', 'Property': ['recP1'], 'Active': true } }],
    WS_Rates: [{ id: 'recRateNight0', fields: { 'Rate Name': 'Standard Night', 'Rate Type': 'Per Night', 'Amount': 450, 'Active': true, 'Property': ['recP1'] } }],
    WS_Cleaners: [], WS_Enquiries: [],
    WS_Roles: [{ id: 'recRole1', fields: { 'Role Label': 'Reception', 'Role Type': 'Reception', 'Property': ['recP1'], 'Current Phone': '27780384989', 'Active': true } }],
    WS_Guests: [{ id: 'recG1', fields: { 'Guest Name': 'Unknown', 'Phone Number': GUEST, 'Session State': 'AWAITING_STAY_TYPE' } }],
    WS_Bookings: []
  };
}
const say = (text) => wh({ method: 'POST', body: metaTextPayload(GUEST, text) }, makeRes());
const texts = ctx => ctx.sends.filter(s => s.type === 'text' && s.to === GUEST).map(s => s.body);

async function bookNights(checkIn, checkOut) {
  mock.timers.reset();
  mock.timers.enable({ apis: ['Date'], now: sast(9, 0) });
  const ctx = { airtable: new MockAirtable(seed()), sends: [], axiom: [] };
  installFetch(ctx);
  await say('multiple days');
  await say(`Sam Dlamini\n${checkIn}\n${checkOut}`);
  return ctx;
}

test("flag OFF (today): 1, 2 and 3 nights all store ONE night's rate: the bug", async () => {
  delete process.env.WABISTAY_OVERNIGHT_AMOUNT_NIGHTS;
  for (const [from, to] of [['25 October', '26 October'], ['25 October', '27 October'], ['25 October', '28 October']]) {
    const ctx = await bookNights(from, to);
    assert.strictEqual(ctx.airtable.tables['WS_Bookings'][0].fields['Amount Due'], 450);
  }
});

test('flag ON: 1, 2 and 3 nights store nights x the Per Night rate, and the guest is shown the total', async () => {
  process.env.WABISTAY_OVERNIGHT_AMOUNT_NIGHTS = '1';
  for (const [from, to, nights] of [['25 October', '26 October', 1], ['25 October', '27 October', 2], ['25 October', '28 October', 3]]) {
    const ctx = await bookNights(from, to);
    const b = ctx.airtable.tables['WS_Bookings'][0].fields;
    assert.strictEqual(b['Booking Type'], 'Overnight');
    assert.strictEqual(b['Amount Due'], 450 * nights, nights + ' night(s)');
    const shown = '*Rate:* R450 per night (R' + (450 * nights) + ' for ' + nights + ' night' + (nights > 1 ? 's' : '') + ')';
    assert.ok(texts(ctx).find(x => /Your booking enquiry/.test(x)).includes(shown), shown);
  }
});

test('flag ON: a staff walk-in overnight of 3 nights also stores 3 x the rate', async () => {
  process.env.WABISTAY_OVERNIGHT_AMOUNT_NIGHTS = '1';
  mock.timers.reset();
  mock.timers.enable({ apis: ['Date'], now: sast(9, 0) });
  const ctx = { airtable: new MockAirtable(seed()), sends: [], axiom: [] };
  installFetch(ctx);
  await wh({ method: 'POST', body: metaTextPayload('27780384989', 'WALKIN ROOM 1 OVERNIGHT 6 October 9 October Sam Dlamini') }, makeRes());
  const b = ctx.airtable.tables['WS_Bookings'][0];
  assert.ok(b, 'walk-in booking created');
  assert.strictEqual(b.fields['Amount Due'], 1350);
});
