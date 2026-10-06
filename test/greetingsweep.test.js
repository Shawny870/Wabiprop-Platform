// test/greetingsweep.test.js
// Bug seen live 6 Oct 2026, 15:32-15:34 SAST (test phone 27736880175, WABISTAY_STAY_MENU on): "Hie" got the menu,
// then "1" got the SAME menu again (not a booking), then "2" worked.
// Cause: the greeting writes Session State AWAITING_STAY_TYPE but, for a TEST PHONE, writes no "Last Inbound At"
// (greetingTrackingFields returns {} for test phones). The 5-minute auto-checkout cron's abandonment sweep reads the
// guest's stale "Last Inbound At" from an earlier session (> 24 hours), decides the guest abandoned the chat, and
// resets the state to NEW seconds after the greeting. The next reply is then handled in NEW: a fresh greeting.
// It is not about the word "Hie": every first word takes the same path (NEW -> greetAndAskStayType).
// This file must FAIL until the greeting stamps "Last Inbound At" for test phones too.
// Time is mocked (Tue 6 Oct 2026, 15:32 SAST: the 12:00-16:59 menu, keys 1, 2, 4). In-memory only.

const { test, mock, afterEach } = require('node:test');
const assert = require('node:assert');
const { installEnv, installFetch, makeRes, metaTextPayload, MockAirtable } = require('./harness');

installEnv();
const ENV = ['WABISTAY_STAY_MENU', 'WABISTAY_ENQUIRY_TRACKING', 'WABISTAY_AFTER_HOURS'];
const saved = Object.fromEntries(ENV.map(k => [k, process.env[k]]));
afterEach(() => {
  mock.timers.reset();
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

const wh = require('../api/wabistay/webhook.js');
const GUEST = '27736880175';
const sast = (h, m = 0, s = 0, d = 6) => Date.UTC(2026, 9, d, h - 2, m, s);
function setClock(h, m, s) { mock.timers.reset(); mock.timers.enable({ apis: ['Date'], now: sast(h, m, s) }); }
const hoursAgo = (n) => new Date(sast(15, 32) - n * 3600e3).toISOString();

function start({ testPhone, lastInboundAt }) {
  process.env.WABISTAY_STAY_MENU = '1';
  process.env.WABISTAY_ENQUIRY_TRACKING = '1';
  delete process.env.WABISTAY_AFTER_HOURS;
  const guest = { 'Guest Name': 'Robson Tembo', 'Phone Number': GUEST, 'Session State': 'NEW' };
  if (testPhone) guest['Test Phone'] = true;
  if (lastInboundAt) guest['Last Inbound At'] = lastInboundAt;
  const ctx = {
    airtable: new MockAirtable({
      WS_Properties: [{ id: 'recP1', fields: { 'Property Name': 'Canary Street Guest Rooms', 'Phone Number ID': '111000111000', 'City': 'Boksburg', 'Notify Phone': '27831112222', 'Hourly Rate 1hr': 120, 'Hourly Rate 2hr': 250, 'Hourly Rate 3hr': 300, 'Guest Redirect Phone': '0730260871' } }],
      WS_Rooms: [{ id: 'recR1', fields: { 'Room Name': 'Room 01', 'Room Number': 1, 'Status': 'Available', 'Property': ['recP1'], 'Active': true } }],
      WS_Rates: [{ id: 'recRateNight', fields: { 'Rate Name': 'Standard Night', 'Rate Type': 'Per Night', 'Amount': 500, 'Active': true, 'Property': ['recP1'] } }],
      WS_Cleaners: [], WS_Enquiries: [], WS_Roles: [], WS_Bookings: [],
      WS_Guests: [{ id: 'recG1', fields: guest }]
    }),
    sends: [], axiom: []
  };
  installFetch(ctx);
  return ctx;
}
const say = (text) => wh({ method: 'POST', body: metaTextPayload(GUEST, text) }, makeRes());
const guestRow = ctx => ctx.airtable.tables['WS_Guests'][0].fields;
const texts = ctx => ctx.sends.filter(s => s.type === 'text' && s.to === GUEST).map(s => s.body);
const isMenu = t => /What would you like to book\? Reply with a number/.test(t);

test('the live sequence: "Hie", the 5-minute sweep runs, then "1" must choose 2 hours, not repeat the menu (test phone, old Last Inbound At)', async () => {
  setClock(15, 32, 10);
  const ctx = start({ testPhone: true, lastInboundAt: hoursAgo(72) });
  await say('Hie');
  assert.ok(isMenu(texts(ctx)[0]), 'the first message gets the menu');
  assert.strictEqual(guestRow(ctx)['Session State'], 'AWAITING_STAY_TYPE');

  setClock(15, 32, 25);                       // the cron tick, 12 seconds later, as in the live log
  await wh.runEnquiryAbandonment(new Date());
  assert.strictEqual(guestRow(ctx)['Session State'], 'AWAITING_STAY_TYPE', 'a chat that began 15 seconds ago is not abandoned');

  setClock(15, 33, 13);
  await say('1');
  assert.strictEqual(guestRow(ctx)['Session State'], 'AWAITING_HOURLY_DETAILS', '"1" is the 2-hour stay');
  assert.ok(!isMenu(texts(ctx)[1]), 'not the menu again');
  assert.match(texts(ctx)[1], /Please send your full name and the time you expect to arrive/);
});

test('control: a normal guest (not a test phone) with the same old Last Inbound At is not reset by the sweep', async () => {
  setClock(15, 32, 10);
  const ctx = start({ testPhone: false, lastInboundAt: hoursAgo(72) });
  await say('Hie');
  setClock(15, 32, 25);
  await wh.runEnquiryAbandonment(new Date());
  assert.strictEqual(guestRow(ctx)['Session State'], 'AWAITING_STAY_TYPE');
});

test('the greeting itself records when the guest last wrote, test phone or not', async () => {
  setClock(15, 32, 10);
  const ctx = start({ testPhone: true, lastInboundAt: hoursAgo(72) });
  await say('Hie');
  assert.strictEqual(guestRow(ctx)['Last Inbound At'], new Date(sast(15, 32, 10)).toISOString());
});

test('every first word takes the same path: Hi, hi, Hie, Hey, Hello, Good day, a random word and an emoji all give the menu and AWAITING_STAY_TYPE', async () => {
  for (const word of ['Hi', 'hi', 'Hie', 'Hey', 'Hello', 'Good day', 'banana', '🙂']) {
    setClock(15, 32, 10);
    const ctx = start({ testPhone: false });
    await say(word);
    assert.ok(isMenu(texts(ctx)[0]), word);
    assert.strictEqual(guestRow(ctx)['Session State'], 'AWAITING_STAY_TYPE', word);
  }
});
