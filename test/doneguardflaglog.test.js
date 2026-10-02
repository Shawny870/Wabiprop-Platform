// test/doneguardflaglog.test.js
// Doc 1b PR 2.
// (a) `done` guard: a number that is both a cleaner and a guest, mid-way through
//     a guest session, is left to the guest flow when no room is being cleaned;
//     a pure cleaner, a dual-role number at NEW, and any sender when a room IS
//     in Cleaning are claimed exactly as before.
// (b) Cold-start flag log: one `wabistay_flags` event per process, listing every
//     WABISTAY_* variable by NAME with on/off only, never a value.
// In-memory only: MockAirtable + mocked fetch.

const { test, afterEach } = require('node:test');
const assert = require('node:assert');
const { installEnv, installFetch, makeRes, metaTextPayload, MockAirtable } = require('./harness');

installEnv();
const savedOwnerPhone = process.env.OWNER_PHONE;

const DUAL_PHONE = '27780384989';   // cleaner AND guest
const CLEANER_ONLY = '27820000111';

const FLAG_ENV = [
  'WABISTAY_STATE_WRITE_GUARD', 'WABISTAY_OPS_ALERT_TEMPLATE', 'WABISTAY_GUEST_ESCALATION_TEMPLATE',
  'WABISTAY_CLEANER_GATE_TEMPLATE', 'WABISTAY_GATE_ARRIVAL_TEMPLATE', 'WABISTAY_RECEPTION_PAYMENT_TEMPLATE',
  'WABISTAY_ROOM_ORDER', 'WABISTAY_HOLD_RELEASE', 'WABISTAY_OVERDUE_ALERT_TEMPLATE', 'WABISTAY_SOMETHING_NEW'
];
const OTHER_ENV = ['REPORT_TEST_MODE_PHONE', 'WA_TEMPLATE_LANGUAGE'];
afterEach(() => {
  for (const k of FLAG_ENV) delete process.env[k];
  for (const k of OTHER_ENV) delete process.env[k];
  if (savedOwnerPhone === undefined) delete process.env.OWNER_PHONE; else process.env.OWNER_PHONE = savedOwnerPhone;
});

function freshWebhook() {
  delete require.cache[require.resolve('../api/wabistay/webhook.js')];
  return require('../api/wabistay/webhook.js');
}

function seed({ guestState, roomStatus = 'Available' } = {}) {
  return {
    WS_Properties: [{ id: 'recP1', fields: { 'Property Name': 'Canary Street Guest Rooms', 'Phone Number ID': '111000111000', 'Notify Phone': '27831112222' } }],
    WS_Rooms: [{ id: 'recR1', fields: { 'Room Name': 'Room 01', 'Room Number': 1, 'Status': roomStatus, 'Property': ['recP1'], 'Active': true } }],
    WS_Rates: [], WS_Roles: [], WS_Bookings: [], WS_Enquiries: [],
    WS_Cleaners: [
      { id: 'recC1', fields: { 'Cleaner Name': 'Jill', 'Phone Number': DUAL_PHONE, 'Active': true, 'Assigned Property': ['recP1'] } },
      { id: 'recC2', fields: { 'Cleaner Name': 'Thandi', 'Phone Number': CLEANER_ONLY, 'Active': true, 'Assigned Property': ['recP1'] } }
    ],
    WS_Guests: guestState === undefined ? [] : [{ id: 'recG1', fields: { 'Guest Name': 'Unknown', 'Phone Number': DUAL_PHONE, 'Session State': guestState } }]
  };
}

function start(opts) {
  const ctx = { airtable: new MockAirtable(seed(opts)), sends: [], axiom: [] };
  installFetch(ctx);
  return ctx;
}

async function send(wh, from, text) {
  const res = makeRes();
  await wh({ method: 'POST', body: metaTextPayload(from, text) }, res);
  return res;
}

const texts = (ctx, to) => ctx.sends.filter(s => s.to === to).map(s => s.body || '');
const events = (ctx, name) => ctx.axiom.filter(e => e.event === name);
const roomRow = ctx => ctx.airtable.tables['WS_Rooms'].find(r => r.id === 'recR1');

// ── (a) done guard ───────────────────────────────────────────────────────────

test('pure cleaner, nothing in Cleaning: still claimed, still told there is nothing to clean', async () => {
  const wh = freshWebhook();
  const ctx = start({});
  await send(wh, CLEANER_ONLY, 'done');
  assert.ok(texts(ctx, CLEANER_ONLY).some(t => /No rooms currently marked for cleaning/.test(t)));
  assert.strictEqual(events(ctx, 'done_left_to_guest_flow').length, 0);
});

test('dual-role number mid-guest-session, nothing in Cleaning: left to the guest flow, not told "nothing to clean"', async () => {
  const wh = freshWebhook();
  const ctx = start({ guestState: 'AWAITING_DETAILS' });
  await send(wh, DUAL_PHONE, 'done');

  const reply = texts(ctx, DUAL_PHONE).join('\n');
  assert.ok(!/No rooms currently marked for cleaning/.test(reply), 'cleaner reply must not fire');
  assert.ok(reply.length > 0, 'the guest flow answered (details re-prompt)');
  assert.strictEqual(events(ctx, 'done_left_to_guest_flow').length, 1);
});

test('dual-role number mid-guest-session WITH a room in Cleaning: claimed as before, room marked Available', async () => {
  const wh = freshWebhook();
  const ctx = start({ guestState: 'AWAITING_DETAILS', roomStatus: 'Cleaning' });
  await send(wh, DUAL_PHONE, 'done');

  assert.strictEqual(roomRow(ctx).fields['Status'], 'Available');
  assert.strictEqual(events(ctx, 'done_left_to_guest_flow').length, 0);
});

test('dual-role number at NEW (no live guest session), nothing in Cleaning: claimed as before', async () => {
  const wh = freshWebhook();
  const ctx = start({ guestState: 'NEW' });
  await send(wh, DUAL_PHONE, 'done');
  assert.ok(texts(ctx, DUAL_PHONE).some(t => /No rooms currently marked for cleaning/.test(t)));
});

test('dual-role number with no guest row at all, nothing in Cleaning: claimed as before', async () => {
  const wh = freshWebhook();
  const ctx = start({});
  await send(wh, DUAL_PHONE, 'done');
  assert.ok(texts(ctx, DUAL_PHONE).some(t => /No rooms currently marked for cleaning/.test(t)));
});

// ── (b) cold-start flag log ──────────────────────────────────────────────────

test('wabistayFlagState: every known flag is listed, unset ones read "off"', () => {
  const wh = freshWebhook();
  const flags = wh.wabistayFlagState();
  assert.deepStrictEqual(Object.keys(flags), [
    'WABISTAY_CLEANER_GATE_TEMPLATE', 'WABISTAY_GATE_ARRIVAL_TEMPLATE', 'WABISTAY_GUEST_ESCALATION_TEMPLATE',
    'WABISTAY_HOLD_RELEASE', 'WABISTAY_OPS_ALERT_TEMPLATE', 'WABISTAY_OVERDUE_ALERT_TEMPLATE',
    'WABISTAY_RECEPTION_PAYMENT_TEMPLATE', 'WABISTAY_ROOM_ORDER', 'WABISTAY_STATE_WRITE_GUARD'
  ]);
  assert.ok(Object.values(flags).every(v => v === 'off'));
});

test('wabistayFlagState: on/off only — the guard counts as on only for 1/true, templates when set, unknown WABISTAY_ variables are listed by name', () => {
  process.env.WABISTAY_STATE_WRITE_GUARD = 'yes';           // not a recognised "on"
  process.env.WABISTAY_OPS_ALERT_TEMPLATE = 'wabistay_ops_alert';
  process.env.WABISTAY_GATE_ARRIVAL_TEMPLATE = '   ';       // whitespace is not "set"
  process.env.WABISTAY_SOMETHING_NEW = 'x';
  const flags = freshWebhook().wabistayFlagState();
  assert.strictEqual(flags.WABISTAY_STATE_WRITE_GUARD, 'off');
  assert.strictEqual(flags.WABISTAY_OPS_ALERT_TEMPLATE, 'on');
  assert.strictEqual(flags.WABISTAY_GATE_ARRIVAL_TEMPLATE, 'off');
  assert.strictEqual(flags.WABISTAY_SOMETHING_NEW, 'on');

  process.env.WABISTAY_STATE_WRITE_GUARD = 'TRUE';
  assert.strictEqual(freshWebhook().wabistayFlagState().WABISTAY_STATE_WRITE_GUARD, 'on');
});

test('the first request of a process logs wabistay_flags once, with no values anywhere in the log', async () => {
  const SECRET = 'secret_template_value_do_not_log_9f3a';
  process.env.WABISTAY_OPS_ALERT_TEMPLATE = SECRET;
  process.env.WABISTAY_STATE_WRITE_GUARD = '1';
  process.env.WABISTAY_SOMETHING_NEW = SECRET;

  const logged = [];
  const realLog = console.log;
  console.log = (...args) => { logged.push(args.join(' ')); };
  let ctx;
  try {
    const wh = freshWebhook();
    ctx = start({});
    await send(wh, CLEANER_ONLY, 'done');
    await send(wh, CLEANER_ONLY, 'done');
  } finally {
    console.log = realLog;
  }

  const flagEvents = events(ctx, 'wabistay_flags');
  assert.strictEqual(flagEvents.length, 1, 'logged once per process, not per request');
  assert.strictEqual(flagEvents[0].flags.WABISTAY_OPS_ALERT_TEMPLATE, 'on');
  assert.strictEqual(flagEvents[0].flags.WABISTAY_STATE_WRITE_GUARD, 'on');
  assert.strictEqual(flagEvents[0].flags.WABISTAY_GATE_ARRIVAL_TEMPLATE, 'off');
  assert.ok(!JSON.stringify(ctx.axiom).includes(SECRET), 'no value in the Axiom events');
  assert.ok(!logged.join('\n').includes(SECRET), 'no value in the console log');
  assert.ok(logged.some(l => l.startsWith('[WABISTAY FLAGS]')));
});

// ── (b2) non-WABISTAY switches: phones set/unset only, language with its value ─

test('otherSwitchState: REPORT_TEST_MODE_PHONE and OWNER_PHONE are set/unset only; WA_TEMPLATE_LANGUAGE shows its value and source', () => {
  delete process.env.OWNER_PHONE;
  delete process.env.REPORT_TEST_MODE_PHONE;
  delete process.env.WA_TEMPLATE_LANGUAGE;
  let wh = freshWebhook();
  assert.deepStrictEqual(wh.otherSwitchState(), {
    REPORT_TEST_MODE_PHONE: 'unset', OWNER_PHONE: 'unset',
    WA_TEMPLATE_LANGUAGE: 'en', WA_TEMPLATE_LANGUAGE_source: 'default'
  });

  process.env.OWNER_PHONE = '27999000111';
  process.env.REPORT_TEST_MODE_PHONE = '27999000222';
  process.env.WA_TEMPLATE_LANGUAGE = 'en_US';
  wh = freshWebhook();
  assert.deepStrictEqual(wh.otherSwitchState(), {
    REPORT_TEST_MODE_PHONE: 'set', OWNER_PHONE: 'set',
    WA_TEMPLATE_LANGUAGE: 'en_US', WA_TEMPLATE_LANGUAGE_source: 'env'
  });
});

test('the logged event carries the language value but neither phone number, in Axiom or the console', async () => {
  process.env.OWNER_PHONE = '27999000111';
  process.env.REPORT_TEST_MODE_PHONE = '27999000222';
  process.env.WA_TEMPLATE_LANGUAGE = 'en_US';

  const logged = [];
  const realLog = console.log;
  console.log = (...args) => { logged.push(args.join(' ')); };
  let ctx;
  try {
    const wh = freshWebhook();
    ctx = start({});
    await send(wh, CLEANER_ONLY, 'done');
  } finally {
    console.log = realLog;
  }

  const event = events(ctx, 'wabistay_flags')[0];
  assert.deepStrictEqual(event.others, {
    REPORT_TEST_MODE_PHONE: 'set', OWNER_PHONE: 'set', WA_TEMPLATE_LANGUAGE: 'en_US', WA_TEMPLATE_LANGUAGE_source: 'env'
  });
  const everything = JSON.stringify(ctx.axiom) + logged.filter(l => l.startsWith('[WABISTAY FLAGS]')).join('\n');
  assert.ok(!everything.includes('27999000111'), 'OWNER_PHONE value must not be logged');
  assert.ok(!everything.includes('27999000222'), 'REPORT_TEST_MODE_PHONE value must not be logged');
});

test('WABISTAY_ROOM_ORDER shows off when unset, and on only for 1/true (like the state-write guard)', () => {
  assert.strictEqual(freshWebhook().wabistayFlagState().WABISTAY_ROOM_ORDER, 'off');
  for (const [value, expected] of [['1', 'on'], ['true', 'on'], ['TRUE', 'on'], ['yes', 'off'], ['0', 'off'], ['', 'off']]) {
    process.env.WABISTAY_ROOM_ORDER = value;
    assert.strictEqual(freshWebhook().wabistayFlagState().WABISTAY_ROOM_ORDER, expected, 'value ' + JSON.stringify(value));
  }
});
