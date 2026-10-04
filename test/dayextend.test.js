// test/dayextend.test.js
// A Day stay ends at 17:00 and has no extension rule. A guest's extend reply on a Day booking
// must say "Please speak to reception to extend your stay." and change NOTHING: no price, no
// time, no booking field, no owner alert. The guard is not behind a flag (a Day booking only
// exists because the stay menu made it, and it must stay protected if that flag is switched off),
// so these run with WABISTAY_STAY_MENU on and off. Hourly and Overnight extensions are unchanged.
// In-memory only: MockAirtable + mocked fetch.

const { test, afterEach } = require('node:test');
const assert = require('node:assert');
const { installEnv, installFetch, makeRes, metaTextPayload, MockAirtable } = require('./harness');

installEnv();
const saved = process.env.WABISTAY_STAY_MENU;
afterEach(() => { if (saved === undefined) delete process.env.WABISTAY_STAY_MENU; else process.env.WABISTAY_STAY_MENU = saved; });

const wh = require('../api/wabistay/webhook.js');
const GUEST = '27784896186';
const OWNER = '27830000001';
const REPLY = 'Please speak to reception to extend your stay.';
const iso = ms => new Date(ms).toISOString();

function seed(bookingFields) {
  return {
    WS_Properties: [{ id: 'recP1', fields: { 'Property Name': 'Canary Street Guest Rooms', 'Phone Number ID': '111000111000', 'Notify Phone': '27831112222', 'Hourly Rate 1hr': 120, 'Hourly Rate 2hr': 250, 'Hourly Rate 3hr': 300 } }],
    WS_Rooms: [{ id: 'recR1', fields: { 'Room Name': 'Room 01', 'Room Number': 1, 'Status': 'Occupied', 'Property': ['recP1'], 'Active': true } }],
    WS_Rates: [{ id: 'recRateDay', fields: { 'Rate Name': 'Day', 'Rate Type': 'Per Day', 'Amount': 400, 'Active': true, 'Property': ['recP1'] } },
               { id: 'recRateNight', fields: { 'Rate Name': 'Standard Night', 'Rate Type': 'Per Night', 'Amount': 500, 'Active': true, 'Property': ['recP1'] } }],
    WS_Guests: [{ id: 'recG1', fields: { 'Guest Name': 'Mama Test', 'Phone Number': GUEST, 'Session State': 'CHECKED_IN' } }],
    WS_Cleaners: [], WS_Roles: [], WS_Enquiries: [],
    WS_Bookings: [{ id: 'recBook1', fields: {
      'Guest': ['recG1'], 'Room': ['recR1'], 'Status': 'Checked In', 'Payment Status': 'Paid', 'Booking Ref': 'WS-DAY001',
      'Checked In At': iso(Date.now() - 3 * 3600e3), ...bookingFields
    } }]
  };
}
async function extend(bookingFields, flag, text = 'extend') {
  if (flag === undefined) delete process.env.WABISTAY_STAY_MENU; else process.env.WABISTAY_STAY_MENU = flag;
  const ctx = { airtable: new MockAirtable(seed(bookingFields)), sends: [], axiom: [] };
  installFetch(ctx);
  await wh({ method: 'POST', body: metaTextPayload(GUEST, text) }, makeRes());
  return ctx;
}
const row = ctx => ctx.airtable.tables['WS_Bookings'][0].fields;
const writes = ctx => ctx.airtable.log.filter(w => w.table !== 'WS_Properties');
const day = { 'Booking Type': 'Day', 'Notes': 'Stay: Day', 'Amount Due': 400, 'Rate Applied': ['recRateDay'], 'Check In': iso(Date.now() - 3 * 3600e3), 'Check Out': iso(Date.now() + 2 * 3600e3) };

for (const [label, flag] of [['stay menu on', '1'], ['stay menu off', undefined]]) {
  test(`Day booking, ${label}: "extend" gets the speak-to-reception reply and NOTHING is written`, async () => {
    const before = JSON.parse(JSON.stringify(day));
    const ctx = await extend(day, flag);
    assert.deepStrictEqual(ctx.sends.filter(s => s.to === GUEST).map(s => s.body), [REPLY]);
    assert.deepStrictEqual(writes(ctx), [], 'no Airtable write at all (bar the property activity stamp)');
    assert.strictEqual(row(ctx)['Check Out'], before['Check Out'], 'time unchanged');
    assert.strictEqual(row(ctx)['Amount Due'], 400, 'price unchanged');
    assert.strictEqual(row(ctx)['Extension Owner Notified'], undefined);
    assert.strictEqual(ctx.sends.filter(s => s.to === OWNER).length, 0, 'no owner alert');
    assert.strictEqual(ctx.airtable.tables['WS_Guests'][0].fields['Session State'], 'CHECKED_IN');
    assert.strictEqual(ctx.axiom.filter(e => e.event === 'extend_refused_day_booking').length, 1);
  });
}

test('every extend phrasing is refused the same way for a Day booking, repeatedly', async () => {
  for (const phrase of ['extend', 'extend stay', 'more time', 'stay longer', 'longer']) {
    const ctx = await extend(day, '1', phrase);
    assert.deepStrictEqual(ctx.sends.filter(s => s.to === GUEST).map(s => s.body), [REPLY], phrase);
    assert.deepStrictEqual(writes(ctx), [], phrase);
  }
});

test('an Hourly booking still extends by an hour at the 1-hour rate (unchanged)', async () => {
  const out = Date.now() + 3600e3;
  const ctx = await extend({ 'Booking Type': 'Hourly', 'Amount Due': 250, 'Check In': iso(Date.now() - 3600e3), 'Check Out': iso(out) }, '1');
  assert.strictEqual(Date.parse(row(ctx)['Check Out']), out + 3600e3);
  assert.strictEqual(row(ctx)['Amount Due'], 370);
  assert.match(ctx.sends.filter(s => s.to === GUEST).map(s => s.body).join('\n'), /We've extended your stay/);
});

test('an Overnight booking still extends by a night at its own rate (unchanged)', async () => {
  const out = Date.now() + 3600e3;
  const ctx = await extend({ 'Booking Type': 'Overnight', 'Amount Due': 500, 'Rate Applied': ['recRateNight'], 'Check In': iso(Date.now() - 12 * 3600e3), 'Check Out': iso(out) }, '1');
  assert.strictEqual(Date.parse(row(ctx)['Check Out']), out + 24 * 3600e3);
  assert.strictEqual(row(ctx)['Amount Due'], 1000);
});
