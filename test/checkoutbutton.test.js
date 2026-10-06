// test/checkoutbutton.test.js
// WABISTAY_CHECKOUT_BUTTON (on top of WABISTAY_INTERACTIVE; off by default). The welcome carries one "Check out" reply button.
// Tapping it does NOT check out: it asks "Check out now?" with "Yes, check out" and "Not yet". Only "Yes" runs the existing checkout
// (60-second and 10-minute guards intact); "Not yet" replies "No problem, enjoy your stay.". Button ids mean something only in
// CHECKED_IN; a stale tap anywhere else (or with the flag off) is ignored. A failed interactive send falls back to today's text.
// In-memory only: MockAirtable + mocked fetch.

const { test, afterEach } = require('node:test');
const assert = require('node:assert');
const { installEnv, installFetch, makeRes, metaTextPayload, metaInteractivePayload, MockAirtable } = require('./harness');

installEnv();
const ENV = ['WABISTAY_CHECKOUT_BUTTON', 'WABISTAY_INTERACTIVE', 'WABISTAY_PAY_ASSIGNS_ROOM', 'WABISTAY_GATE_ROOM_CHECK'];
const saved = Object.fromEntries(ENV.map(k => [k, process.env[k]]));
afterEach(() => { for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

const wh = require('../api/wabistay/webhook.js');
const GUEST = '27736880175';
const MIN = 60e3;
const iso = ms => new Date(ms).toISOString();
const ago = m => iso(Date.now() - m * MIN);

const WELCOME_BODY = "Welcome to Canary Street Guest Rooms! Your room is *Room 01*. We're happy to have you here. When you're ready to leave, tap Check out.";
const WELCOME_TEXT_NEW = "Welcome to Canary Street Guest Rooms! Your room is *Room 01*. We're happy to have you here. When you're ready to leave, tap Check out.\n\n1 - Check out";
const WELCOME_TEXT_OLD = "Welcome to Canary Street Guest Rooms! 🌟 Your room is *Room 01*.\n\nSomeone is on their way to help you at the gate.\n\nWhen you're ready to leave, reply with a number:\n1 - Check out";

function seed({ state, testPhone = false, booking = {}, rooms = true }) {
  return {
    WS_Properties: [{ id: 'recP1', fields: { 'Property Name': 'Canary Street Guest Rooms', 'Phone Number ID': '111000111000', 'Notify Phone': '27831112222' } }],
    WS_Rooms: rooms ? [{ id: 'recR1', fields: { 'Room Name': 'Room 01', 'Room Number': 1, 'Status': 'Available', 'Property': ['recP1'], 'Active': true } }] : [],
    WS_Roles: [], WS_Cleaners: [], WS_Rates: [], WS_Enquiries: [],
    WS_Guests: [{ id: 'recG1', fields: { 'Guest Name': 'Robson Tembo', 'Phone Number': GUEST, 'Session State': state, ...(testPhone ? { 'Test Phone': true } : {}) } }],
    WS_Bookings: [{
      id: 'recBook1',
      fields: { 'Guest': ['recG1'], 'Room': ['recR1'], 'Booking Type': 'Hourly', 'Status': 'Confirmed', 'Amount Due': 250, 'Payment Status': 'Paid', 'Amount Paid': 250,
        'Paid At': ago(30), 'Booking Ref': 'WS-BOOK01', 'Check In': ago(20), 'Check Out': iso(Date.now() + 2 * 3600e3), ...booking }
    }]
  };
}
function start(opts, { button = '1', interactive = '1', payAssigns = null, failInteractive = false } = {}) {
  const set = (k, v) => { if (v === null) delete process.env[k]; else process.env[k] = v; };
  set('WABISTAY_CHECKOUT_BUTTON', button);
  set('WABISTAY_INTERACTIVE', interactive);
  set('WABISTAY_PAY_ASSIGNS_ROOM', payAssigns);
  set('WABISTAY_GATE_ROOM_CHECK', null);
  const ctx = { airtable: new MockAirtable(seed(opts)), sends: [], axiom: [] };
  installFetch(ctx);
  if (failInteractive) {
    const inner = global.fetch;
    global.fetch = async (url, o = {}) => {
      if (String(url).includes('graph.facebook.com') && JSON.parse(o.body).type === 'interactive') {
        return { status: 400, json: async () => ({ error: { code: 131009, message: 'Parameter value is not valid' } }) };
      }
      return inner(url, o);
    };
  }
  return ctx;
}
const say = (text) => wh({ method: 'POST', body: metaTextPayload(GUEST, text) }, makeRes());
const tap = (id, title = 'x') => wh({ method: 'POST', body: metaInteractivePayload(GUEST, { id, title }) }, makeRes());
const bk = ctx => ctx.airtable.tables['WS_Bookings'][0].fields;
const gs = ctx => ctx.airtable.tables['WS_Guests'][0].fields;
const texts = ctx => ctx.sends.filter(s => s.to === GUEST && s.type === 'text').map(s => s.body);
const inter = ctx => ctx.sends.filter(s => s.to === GUEST && s.type === 'interactive');
const sentToGuest = ctx => ctx.sends.filter(s => s.to === GUEST);

const CHECKED_IN = { state: 'CHECKED_IN', booking: { 'Status': 'Checked In', 'Checked In At': ago(5) } };

// ── the welcome ──────────────────────────────────────────────────────────────

test('flag on: the welcome is one interactive message with a single "Check out" button and no text welcome', async () => {
  const ctx = start({ state: 'CONFIRMED' });
  await say('1');
  assert.deepStrictEqual(texts(ctx), []);
  assert.strictEqual(inter(ctx).length, 1);
  assert.strictEqual(inter(ctx)[0].body, WELCOME_BODY);
  assert.deepStrictEqual(inter(ctx)[0].buttons, [{ id: 'co_start', title: 'Check out' }]);
  assert.strictEqual(bk(ctx)['Status'], 'Checked In');
  assert.strictEqual(gs(ctx)['Session State'], 'CHECKED_IN');
});

test('a test phone gets the same button welcome', async () => {
  const ctx = start({ state: 'CONFIRMED', testPhone: true });
  await say('1');
  assert.deepStrictEqual(inter(ctx)[0].buttons, [{ id: 'co_start', title: 'Check out' }]);
});

test('no room assigned: the welcome stays text (no button)', async () => {
  const ctx = start({ state: 'CONFIRMED', rooms: false, booking: { 'Room': undefined } });
  await say('1');
  assert.strictEqual(inter(ctx).length, 0);
  assert.match(texts(ctx)[0], /We've notified someone to assist you at the gate/);
});

// ── the tap asks first ───────────────────────────────────────────────────────

test('tapping Check out asks "Check out now?" with Yes and Not yet, and checks nobody out', async () => {
  const ctx = start(CHECKED_IN);
  await tap('co_start', 'Check out');
  assert.strictEqual(inter(ctx).length, 1);
  assert.strictEqual(inter(ctx)[0].body, 'Check out now?');
  assert.deepStrictEqual(inter(ctx)[0].buttons, [{ id: 'co_yes', title: 'Yes, check out' }, { id: 'co_no', title: 'Not yet' }]);
  assert.strictEqual(bk(ctx)['Status'], 'Checked In');
  assert.strictEqual(gs(ctx)['Session State'], 'CHECKED_IN');
  assert.strictEqual(ctx.airtable.log.length > 0 ? ctx.airtable.log.filter(l => l.table === 'WS_Bookings').length : 0, 0, 'no booking write');
});

test('"Yes, check out" runs the existing checkout: booking Checked Out, thanks and the rating question', async () => {
  const ctx = start(CHECKED_IN);
  await tap('co_yes', 'Yes, check out');
  assert.strictEqual(bk(ctx)['Status'], 'Checked Out');
  assert.strictEqual(gs(ctx)['Session State'], 'AWAITING_RATING');
  assert.ok(texts(ctx).some(t => /Thank you for staying with us/.test(t)));
  assert.ok(texts(ctx).some(t => /how would you rate your stay/.test(t)));
});

test('"Not yet" replies "No problem, enjoy your stay." and changes nothing', async () => {
  const ctx = start(CHECKED_IN);
  await tap('co_no', 'Not yet');
  assert.deepStrictEqual(texts(ctx), ['No problem, enjoy your stay.']);
  assert.strictEqual(bk(ctx)['Status'], 'Checked In');
  assert.strictEqual(gs(ctx)['Session State'], 'CHECKED_IN');
});

// ── the existing guards still hold ───────────────────────────────────────────

test('"Yes" inside 60 seconds of check-in is ignored by the existing cooldown', async () => {
  const ctx = start({ state: 'CHECKED_IN', booking: { 'Status': 'Checked In', 'Checked In At': iso(Date.now() - 20e3) } });
  await tap('co_yes');
  assert.strictEqual(bk(ctx)['Status'], 'Checked In');
  assert.match(texts(ctx)[0], /Just checked you in — give it a minute/);
});

test('"Yes" inside 10 minutes of an automatic check-in answers "already checked in" and does not check out', async () => {
  const inAt = Date.now() - 4 * MIN;
  const ctx = start({ state: 'CHECKED_IN', booking: { 'Status': 'Checked In', 'Gate Tap At': iso(inAt - 6 * MIN), 'Paid At': iso(inAt - 5000), 'Checked In At': iso(inAt) } }, { payAssigns: '1' });
  await tap('co_yes');
  assert.strictEqual(bk(ctx)['Status'], 'Checked In');
  assert.strictEqual(texts(ctx)[0], 'You are already checked in to Room 01. Reply 1 again when you are ready to leave.');
});

test('a typed 1 still checks out as before', async () => {
  const ctx = start(CHECKED_IN);
  await say('1');
  assert.strictEqual(bk(ctx)['Status'], 'Checked Out');
});

// ── stale taps and wrong states: ignored ─────────────────────────────────────

test('stale or wrong-state taps are ignored: nothing is sent and nothing changes', async () => {
  const cases = [
    ['co_yes', { state: 'AWAITING_RATING', booking: { 'Status': 'Checked Out' } }],
    ['co_yes', { state: 'CONFIRMED' }],
    ['co_yes', { state: 'NEW' }],
    ['co_start', { state: 'CONFIRMED' }],
    ['co_no', { state: 'AWAITING_PAYMENT_METHOD' }],
    ['co_yes', { state: 'AWAITING_ETA' }],
    ['co_start', { state: 'AWAITING_RATING_FEEDBACK', booking: { 'Status': 'Checked Out' } }]
  ];
  for (const [id, opts] of cases) {
    const ctx = start(opts);
    const before = bk(ctx)['Status'];
    const state = gs(ctx)['Session State'];
    await tap(id);
    assert.deepStrictEqual(sentToGuest(ctx), [], `${id} in ${opts.state}`);
    assert.strictEqual(bk(ctx)['Status'], before, `${id} in ${opts.state}`);
    assert.strictEqual(gs(ctx)['Session State'], state, `${id} in ${opts.state}`);
    assert.strictEqual(ctx.axiom.filter(e => e.event === 'checkout_button_tap_ignored').length, 1, `${id} in ${opts.state}`);
  }
});

test('the typed internal words do nothing special with the flag off (the checked-in menu is shown)', async () => {
  const ctx = start(CHECKED_IN, { button: null });
  await say('__checkout_ask');
  assert.strictEqual(inter(ctx).length, 0);
  assert.match(texts(ctx)[0], /You're checked in/);
});

// ── a failed send falls back to text ─────────────────────────────────────────

test('the welcome button cannot be sent: today\'s text goes instead (new text with the 1 line when PAY_ASSIGNS is on, the old welcome when it is off)', async () => {
  const on = start({ state: 'CONFIRMED' }, { failInteractive: true, payAssigns: '1' });
  await say('1');
  assert.deepStrictEqual(texts(on), [WELCOME_TEXT_NEW]);
  assert.strictEqual(bk(on)['Status'], 'Checked In');
  assert.strictEqual(on.axiom.filter(e => e.event === 'checkout_button_welcome_fell_back').length, 1);
  const off = start({ state: 'CONFIRMED' }, { failInteractive: true });
  await say('1');
  assert.deepStrictEqual(texts(off), [WELCOME_TEXT_OLD]);
});

test('the "Check out now?" buttons cannot be sent: a text with the 1 reply goes instead', async () => {
  const ctx = start(CHECKED_IN, { failInteractive: true });
  await tap('co_start');
  assert.deepStrictEqual(texts(ctx), ['Check out now? Reply 1 to check out.']);
  assert.strictEqual(bk(ctx)['Status'], 'Checked In');
});

// ── flag off ─────────────────────────────────────────────────────────────────

test('flag off, or INTERACTIVE off: the welcome is today\'s text and the button ids are ignored', async () => {
  for (const env of [{ button: null }, { interactive: null }]) {
    const ctx = start({ state: 'CONFIRMED' }, env);
    await say('1');
    assert.strictEqual(inter(ctx).length, 0, JSON.stringify(env));
    assert.deepStrictEqual(texts(ctx), [WELCOME_TEXT_OLD], JSON.stringify(env));
    await tap('co_yes');
    assert.strictEqual(bk(ctx)['Status'], 'Checked In', JSON.stringify(env));
  }
});

test('the flag is on the cold-start list and reads off by default', () => {
  delete process.env.WABISTAY_CHECKOUT_BUTTON;
  assert.strictEqual(wh.wabistayFlagState()['WABISTAY_CHECKOUT_BUTTON'], 'off');
  process.env.WABISTAY_CHECKOUT_BUTTON = 'true';
  assert.strictEqual(wh.wabistayFlagState()['WABISTAY_CHECKOUT_BUTTON'], 'on');
});

test('flag off (or INTERACTIVE off), well after check-in: a Check out / Yes tap is ignored and checks nobody out', async () => {
  for (const env of [{ button: null }, { interactive: null }]) {
    for (const id of ['co_start', 'co_yes', 'co_no']) {
      const ctx = start(CHECKED_IN, env);
      await tap(id);
      assert.deepStrictEqual(sentToGuest(ctx), [], `${id} ${JSON.stringify(env)}`);
      assert.strictEqual(bk(ctx)['Status'], 'Checked In', `${id} ${JSON.stringify(env)}`);
    }
  }
});
