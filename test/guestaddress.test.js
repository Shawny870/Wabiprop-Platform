// test/guestaddress.test.js
// WABISTAY_GUEST_ADDRESS: the booking-confirmed messages carry the property's Guest Address and,
// on its own line, Guest Maps Link, between the "confirmed" / "See you at" line and "Reply with a
// number". Each line only when its field is filled. Flag off: text identical to today.
// Covers confirmedMenu (card and EFT, short stay), etaConfirmed (overnight) and the CONFIRMED fallback.
// In-memory only: MockAirtable + mocked fetch.

const { test, afterEach } = require('node:test');
const assert = require('node:assert');
const { installEnv, installFetch, makeRes, metaTextPayload, MockAirtable } = require('./harness');

installEnv();
const saved = process.env.WABISTAY_GUEST_ADDRESS;
afterEach(() => { if (saved === undefined) delete process.env.WABISTAY_GUEST_ADDRESS; else process.env.WABISTAY_GUEST_ADDRESS = saved; });

const wh = require('../api/wabistay/webhook.js');
const GUEST = '27784896186';
const ADDRESS = '57 Canary St, Villa Liza, Boksburg, 1459';
const MAPS = 'https://www.google.com/maps/place/57+Canary+St,+Villa+Liza,+Boksburg,+1459';

const TODAY_CONFIRMED = 'Hi Mama Test! Your booking is confirmed. 🛏️\n\nReply with a number:\n1 - I\'m at the gate\n2 - Cancel my booking';
const TODAY_ETA = (eta) => `Perfect! We'll have your room ready for you. 🛏️\n\nSee you at *${eta}*.\n\nWhen you arrive, reply with a number:\n1 - I'm at the gate\n2 - Cancel my booking\n\nWe look forward to hosting you at Canary Street Guest Rooms! 🌟`;

function seed({ state, type, address, maps }) {
  const prop = { 'Property Name': 'Canary Street Guest Rooms', 'Phone Number ID': '111000111000', 'Notify Phone': '27831112222' };
  if (address) prop['Guest Address'] = address;
  if (maps) prop['Guest Maps Link'] = maps;
  const future = new Date(Date.now() + 5 * 3600 * 1000).toISOString();
  const later = new Date(Date.now() + 29 * 3600 * 1000).toISOString();
  return {
    WS_Properties: [{ id: 'recP1', fields: prop }],
    WS_Rooms: [{ id: 'recR1', fields: { 'Room Name': 'Room 01', 'Room Number': 1, 'Status': 'Available', 'Property': ['recP1'], 'Active': true } }],
    WS_Rates: [], WS_Cleaners: [], WS_Roles: [], WS_Enquiries: [],
    WS_Guests: [{ id: 'recG1', fields: { 'Guest Name': 'Mama Test', 'Phone Number': GUEST, 'Session State': state } }],
    WS_Bookings: [{ id: 'recBook1', fields: { 'Guest': ['recG1'], 'Room': ['recR1'], 'Status': 'Confirmed', 'Booking Type': type, 'Booking Ref': 'WS-ADR001', 'Amount Due': 250, 'Payment Status': 'Unpaid', 'Check In': future, 'Check Out': later } }]
  };
}
async function send(flag, opts, text) {
  if (flag === undefined) delete process.env.WABISTAY_GUEST_ADDRESS; else process.env.WABISTAY_GUEST_ADDRESS = flag;
  const ctx = { airtable: new MockAirtable(seed(opts)), sends: [], axiom: [] };
  installFetch(ctx);
  await wh({ method: 'POST', body: metaTextPayload(GUEST, text) }, makeRes());
  return ctx;
}
const bodies = ctx => ctx.sends.filter(s => s.to === GUEST && s.type === 'text').map(s => s.body);
const last = ctx => bodies(ctx).slice(-1)[0];
const both = { address: ADDRESS, maps: MAPS };

// ── short stay: confirmedMenu after the payment choice ───────────────────────

test('flag on: card choice, the confirmed message has the address then the maps link on its own line, before "Reply with a number"', async () => {
  const ctx = await send('1', { state: 'AWAITING_PAYMENT_METHOD', type: 'Hourly', ...both }, '1');
  assert.strictEqual(last(ctx), `Hi Mama Test! Your booking is confirmed. 🛏️\n\n${ADDRESS}\n${MAPS}\n\nReply with a number:\n1 - I'm at the gate\n2 - Cancel my booking`);
});

test('flag on: EFT choice gets the same address block', async () => {
  const ctx = await send('1', { state: 'AWAITING_PAYMENT_METHOD', type: 'Hourly', ...both }, '2');
  assert.strictEqual(last(ctx), `Hi Mama Test! Your booking is confirmed. 🛏️\n\n${ADDRESS}\n${MAPS}\n\nReply with a number:\n1 - I'm at the gate\n2 - Cancel my booking`);
});

test('flag on: each line shows only when its field is filled', async () => {
  const onlyAddress = await send('1', { state: 'AWAITING_PAYMENT_METHOD', type: 'Hourly', address: ADDRESS }, '1');
  assert.strictEqual(last(onlyAddress), `Hi Mama Test! Your booking is confirmed. 🛏️\n\n${ADDRESS}\n\nReply with a number:\n1 - I'm at the gate\n2 - Cancel my booking`);
  const onlyMaps = await send('1', { state: 'AWAITING_PAYMENT_METHOD', type: 'Hourly', maps: MAPS }, '1');
  assert.strictEqual(last(onlyMaps), `Hi Mama Test! Your booking is confirmed. 🛏️\n\n${MAPS}\n\nReply with a number:\n1 - I'm at the gate\n2 - Cancel my booking`);
  const neither = await send('1', { state: 'AWAITING_PAYMENT_METHOD', type: 'Hourly' }, '1');
  assert.strictEqual(last(neither), TODAY_CONFIRMED);
});

// ── overnight: etaConfirmed ──────────────────────────────────────────────────

test('flag on: the overnight "See you at" message has the address block before "When you arrive"', async () => {
  const ctx = await send('1', { state: 'AWAITING_ETA', type: 'Overnight', ...both }, 'around 7pm');
  const text = last(ctx);
  assert.match(text, /^Perfect! We'll have your room ready for you\. 🛏️\n\nSee you at \*[^*]+\*\.\n\n/);
  assert.ok(text.includes(`\n\n${ADDRESS}\n${MAPS}\n\nWhen you arrive, reply with a number:\n1 - I'm at the gate\n2 - Cancel my booking\n\nWe look forward to hosting you at Canary Street Guest Rooms! 🌟`), text);
});

test('flag on, fields empty: the overnight message is exactly today\'s', async () => {
  const ctx = await send('1', { state: 'AWAITING_ETA', type: 'Overnight' }, 'around 7pm');
  const eta = /See you at \*([^*]+)\*/.exec(last(ctx))[1];
  assert.strictEqual(last(ctx), TODAY_ETA(eta));
});

// ── the CONFIRMED fallback reply ─────────────────────────────────────────────

test('flag on: the CONFIRMED fallback reply (shared text) carries the address too', async () => {
  const ctx = await send('1', { state: 'CONFIRMED', type: 'Hourly', ...both }, 'banana');
  assert.strictEqual(last(ctx), `Hi Mama Test! Your booking is confirmed. 🛏️\n\n${ADDRESS}\n${MAPS}\n\nReply with a number:\n1 - I'm at the gate\n2 - Cancel my booking`);
});

// ── flag off: identical to today, even with both fields filled ───────────────

test('flag off: every confirmed message is exactly today\'s text, even with the address and link filled', async () => {
  for (const flag of [undefined, '0', 'false']) {
    const card = await send(flag, { state: 'AWAITING_PAYMENT_METHOD', type: 'Hourly', ...both }, '1');
    assert.strictEqual(last(card), TODAY_CONFIRMED, String(flag));
    const eft = await send(flag, { state: 'AWAITING_PAYMENT_METHOD', type: 'Hourly', ...both }, '2');
    assert.strictEqual(last(eft), TODAY_CONFIRMED, String(flag));
    const fallback = await send(flag, { state: 'CONFIRMED', type: 'Hourly', ...both }, 'banana');
    assert.strictEqual(last(fallback), TODAY_CONFIRMED, String(flag));
    const eta = await send(flag, { state: 'AWAITING_ETA', type: 'Overnight', ...both }, 'around 7pm');
    assert.ok(!eta.sends.some(s => s.body && s.body.includes(ADDRESS)), String(flag));
    assert.ok(!/57 Canary|google\.com/.test(last(eta)), String(flag));
    assert.ok(!/\{addressBlock\}/.test(last(eta)), 'no placeholder left behind');
  }
});

test('no message ever shows a raw {addressBlock} placeholder', async () => {
  for (const flag of ['1', undefined]) {
    for (const [state, type, text] of [['AWAITING_PAYMENT_METHOD', 'Hourly', '1'], ['AWAITING_ETA', 'Overnight', 'around 7pm'], ['CONFIRMED', 'Hourly', 'banana']]) {
      const ctx = await send(flag, { state, type, ...both }, text);
      assert.ok(!bodies(ctx).some(b => /\{addressBlock\}/.test(b)), `${flag} ${state}`);
    }
  }
});

test('the flag is on the cold-start list and reads off by default', () => {
  delete process.env.WABISTAY_GUEST_ADDRESS;
  assert.strictEqual(wh.wabistayFlagState()['WABISTAY_GUEST_ADDRESS'], 'off');
  process.env.WABISTAY_GUEST_ADDRESS = 'true';
  assert.strictEqual(wh.wabistayFlagState()['WABISTAY_GUEST_ADDRESS'], 'on');
});
