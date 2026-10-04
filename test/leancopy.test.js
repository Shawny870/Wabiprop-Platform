// test/leancopy.test.js
// WABISTAY_LEAN_COPY. Short-stay path: no separate "Short stay rates" message (the fail-closed
// rates check stays, WABISTAY_HIDE_ONE_HOUR still shapes the duration question), the
// name-and-time request and re-prompt get the new exact copy, and a one-line reply is
// accepted when exactly one part is a time and the rest is a name. Flag off: today's text.
// In-memory only: MockAirtable + mocked fetch.

const { test, afterEach } = require('node:test');
const assert = require('node:assert');
const { installEnv, installFetch, makeRes, metaTextPayload, MockAirtable } = require('./harness');

installEnv();
const ENV = ['WABISTAY_LEAN_COPY', 'WABISTAY_HIDE_ONE_HOUR'];
const saved = Object.fromEntries(ENV.map(k => [k, process.env[k]]));
afterEach(() => { for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

const wh = require('../api/wabistay/webhook.js');
const GUEST = '27784896186';

const LEAN_ASK = 'Please send your full name and the time you expect to arrive, each on a new line.\n\nExample:\nSam Dlamini\n2pm';
const LEAN_REPROMPT = "Sorry, I didn't catch that. Please send your full name and arrival time, each on a new line.\n\nExample:\nSam Dlamini\n2pm";

function seed({ state = 'AWAITING_STAY_TYPE', guestName = 'Unknown', rates = {} } = {}) {
  const prop = { 'Property Name': 'Test Lodge', 'Phone Number ID': '111000111000', 'City': 'Testville', 'Notify Phone': '27831112222', 'Hourly Rate 1hr': 120, 'Hourly Rate 2hr': 250, 'Hourly Rate 3hr': 300, ...rates };
  return {
    WS_Properties: [{ id: 'recP1', fields: prop }],
    WS_Rooms: [{ id: 'recR1', fields: { 'Room Name': 'Room 1', 'Room Number': 1, 'Status': 'Available', 'Property': ['recP1'], 'Active': true } }],
    WS_Rates: [], WS_Cleaners: [], WS_Roles: [], WS_Enquiries: [], WS_Bookings: [],
    WS_Guests: [{ id: 'recG1', fields: { 'Guest Name': guestName, 'Phone Number': GUEST, 'Session State': state } }]
  };
}
async function say(text, { flag, state, guestName, rates, hideOne } = {}) {
  if (flag === undefined) delete process.env.WABISTAY_LEAN_COPY; else process.env.WABISTAY_LEAN_COPY = flag;
  if (hideOne === undefined) delete process.env.WABISTAY_HIDE_ONE_HOUR; else process.env.WABISTAY_HIDE_ONE_HOUR = hideOne;
  const ctx = { airtable: new MockAirtable(seed({ state, guestName, rates })), sends: [], axiom: [] };
  installFetch(ctx);
  await wh({ method: 'POST', body: metaTextPayload(GUEST, text) }, makeRes());
  return ctx;
}
const bodies = ctx => ctx.sends.filter(s => s.to === GUEST && s.type === 'text').map(s => s.body);
const guestRow = ctx => ctx.airtable.tables['WS_Guests'][0].fields;
const menu = ctx => bodies(ctx).find(b => /How long do you need/.test(b));

// ── (1) no rates message ─────────────────────────────────────────────────────

test('flag off: choosing short stay sends the rates message AND the old request (two messages, today)', async () => {
  const ctx = await say('1');
  const b = bodies(ctx);
  assert.strictEqual(b.length, 2);
  assert.match(b[0], /Short stay rates at Test Lodge/);
  assert.match(b[1], /let's set up your \*short stay\*/);
});

test('flag on: choosing short stay sends ONE message, the new request — no rates message', async () => {
  const ctx = await say('1', { flag: '1' });
  assert.deepStrictEqual(bodies(ctx), [LEAN_ASK]);
  assert.strictEqual(guestRow(ctx)['Session State'], 'AWAITING_HOURLY_DETAILS');
});

test('flag on: "short stay" and "short" behave the same as 1', async () => {
  for (const t of ['short stay', 'short']) {
    const ctx = await say(t, { flag: '1' });
    assert.deepStrictEqual(bodies(ctx), [LEAN_ASK], t);
  }
});

test('flag on: the fail-closed rates check stays — a blank 2-hour or 3-hour rate still says short stays are unavailable', async () => {
  for (const rates of [{ 'Hourly Rate 2hr': null }, { 'Hourly Rate 3hr': 0 }]) {
    const ctx = await say('1', { flag: '1', hideOne: '1', rates });
    const b = bodies(ctx);
    assert.strictEqual(b.length, 1);
    assert.match(b[0], /short stays aren't available at Test Lodge/);
    assert.strictEqual(guestRow(ctx)['Session State'], 'AWAITING_DETAILS');
  }
});

test('flag on + WABISTAY_HIDE_ONE_HOUR: a blank 1-hour rate is fine, and the duration question lists only 2 and 3 hours', async () => {
  const first = await say('1', { flag: '1', hideOne: '1', rates: { 'Hourly Rate 1hr': null } });
  assert.deepStrictEqual(bodies(first), [LEAN_ASK]);
  const second = await say('Sam Dlamini\n2pm', { flag: '1', hideOne: '1', state: 'AWAITING_HOURLY_DETAILS', rates: { 'Hourly Rate 1hr': null } });
  assert.match(menu(second), /Reply with a number:\n2 - 2 hours \(R250\)\n3 - 3 hours \(R300\)\n\n/);
  assert.ok(!/1 - 1 hour/.test(menu(second)));
});

test('flag on: the typed word "hourly" gets the same new request', async () => {
  const ctx = await say('hourly', { flag: '1', state: 'AWAITING_STAY_TYPE' });
  assert.deepStrictEqual(bodies(ctx), [LEAN_ASK]);
  const off = await say('hourly', { state: 'AWAITING_STAY_TYPE' });
  assert.match(bodies(off)[0], /let's set up your \*short stay\*/);
});

// ── (2)(3) the copy ──────────────────────────────────────────────────────────

test('the new request and re-prompt are exactly the agreed copy', () => {
  const states = require('../states.json').messages;
  assert.strictEqual(states.hourlyAskDetailsLean, LEAN_ASK);
  assert.strictEqual(states.hourlyDetailsRepromptLean, LEAN_REPROMPT);
});

test('flag on: an unreadable reply gets the new re-prompt; flag off gets today\'s', async () => {
  const on = await say('hello there', { flag: '1', state: 'AWAITING_HOURLY_DETAILS' });
  assert.deepStrictEqual(bodies(on), [LEAN_REPROMPT]);
  const off = await say('hello there', { state: 'AWAITING_HOURLY_DETAILS' });
  assert.match(bodies(off)[0], /Sorry, I didn't quite get that\. Please reply with your:/);
});

// ── (4) one-line replies ─────────────────────────────────────────────────────

test('parseOneLineNameAndTime: name + time in either order, with or without a filler word or a spaced meridiem', () => {
  const p = wh.parseOneLineNameAndTime;
  assert.deepStrictEqual(p('Tim 9pm'), { name: 'Tim', time: { hour: 21, minute: 0 } });
  assert.deepStrictEqual(p('9pm Tim'), { name: 'Tim', time: { hour: 21, minute: 0 } });
  assert.deepStrictEqual(p('Sam Dlamini 2pm'), { name: 'Sam Dlamini', time: { hour: 14, minute: 0 } });
  assert.deepStrictEqual(p('Tim at 9pm'), { name: 'Tim', time: { hour: 21, minute: 0 } });
  assert.deepStrictEqual(p('Tim 9 pm'), { name: 'Tim', time: { hour: 21, minute: 0 } });
  assert.deepStrictEqual(p('Tim 14:30'), { name: 'Tim', time: { hour: 14, minute: 30 } });
  assert.deepStrictEqual(p('Tim 9'), { name: 'Tim', time: { ambiguous: 9 } });
});

test('parseOneLineNameAndTime: refused when there is no name, no time, or more than one time', () => {
  const p = wh.parseOneLineNameAndTime;
  assert.strictEqual(p('9pm'), null, 'no name');
  assert.strictEqual(p('Tim'), null, 'no time');
  assert.strictEqual(p('Tim 9pm 10pm'), null, 'two times');
  assert.strictEqual(p('Tim 2 9pm'), null, 'two time-like parts');
  assert.strictEqual(p(''), null);
});

test('flag on: "Tim 9pm" and "9pm Tim" are accepted — the duration question follows and the arrival and name are saved', async () => {
  for (const text of ['Tim 9pm', '9pm Tim']) {
    // 9pm is later today unless it is already past 21:00 SAST, when it rolls to tomorrow — either way it parses.
    const ctx = await say(text, { flag: '1', state: 'AWAITING_HOURLY_DETAILS' });
    assert.match(menu(ctx), /Great Tim! 🕐 Arriving \*/, text);
    assert.match(menu(ctx), /9:00pm/, text);
    assert.strictEqual(guestRow(ctx)['Guest Name'], 'Tim', text);
    assert.strictEqual(guestRow(ctx)['Session State'], 'AWAITING_HOURLY_DURATION', text);
  }
});

test('flag on: "Tim" alone and "9pm" alone (no known name) are not enough — the re-prompt', async () => {
  const nameOnly = await say('Tim', { flag: '1', state: 'AWAITING_HOURLY_DETAILS' });
  assert.deepStrictEqual(bodies(nameOnly), [LEAN_REPROMPT]);
  const timeOnly = await say('9pm', { flag: '1', state: 'AWAITING_HOURLY_DETAILS' });
  assert.deepStrictEqual(bodies(timeOnly), [LEAN_REPROMPT]);
});

test('flag on: "9pm" alone is accepted when the guest already has a name on file (today\'s fallback, unchanged)', async () => {
  const ctx = await say('9pm', { flag: '1', state: 'AWAITING_HOURLY_DETAILS', guestName: 'Mama Test' });
  assert.match(menu(ctx), /Great Mama Test!/);
});

test('flag on: a bare hour in a one-line reply still asks am or pm', async () => {
  const ctx = await say('Tim 9', { flag: '1', state: 'AWAITING_HOURLY_DETAILS' });
  assert.match(bodies(ctx)[0], /did you mean \*9am\* or \*9pm\*/);
});

test('flag on: the two-line form still works exactly as before', async () => {
  const ctx = await say('Sam Dlamini\n2pm', { flag: '1', state: 'AWAITING_HOURLY_DETAILS' });
  assert.match(menu(ctx), /Great Sam Dlamini!/);
});

test('flag off: a one-line reply is refused with the old re-prompt (today)', async () => {
  const ctx = await say('Tim 9pm', { state: 'AWAITING_HOURLY_DETAILS' });
  assert.match(bodies(ctx)[0], /Sorry, I didn't quite get that/);
  assert.strictEqual(guestRow(ctx)['Session State'], 'AWAITING_HOURLY_DETAILS');
});

test('the flag is on the cold-start flag list: off by default, on only for 1/true', () => {
  const fresh = () => { delete require.cache[require.resolve('../api/wabistay/webhook.js')]; return require('../api/wabistay/webhook.js'); };
  delete process.env.WABISTAY_LEAN_COPY;
  assert.strictEqual(fresh().wabistayFlagState().WABISTAY_LEAN_COPY, 'off');
  for (const [v, exp] of [['1', 'on'], ['true', 'on'], ['yes', 'off']]) {
    process.env.WABISTAY_LEAN_COPY = v;
    assert.strictEqual(fresh().wabistayFlagState().WABISTAY_LEAN_COPY, exp, v);
  }
});
