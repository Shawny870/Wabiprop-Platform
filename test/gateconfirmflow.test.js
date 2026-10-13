// test/gateconfirmflow.test.js
// WABISTAY_GATE_CONFIRM_FLOW (includes WABISTAY_GATE_PAY_FLOW): the gate journey end to end.
//  B1 reply wording, B2 one "I have my keys" message once paid and in a room, B3 the tap is logged and the existing
//  check-out message follows, B4 free text in between gets a nudge, B5 one alert per press and nothing sent twice.
// In-memory only: MockAirtable + mocked fetch. Flag off: the pay-flow behaviour is untouched (gatepayflow.test.js).

const { test, afterEach } = require('node:test');
const assert = require('node:assert');
const { installEnv, installFetch, makeRes, metaTextPayload, metaInteractivePayload, MockAirtable } = require('./harness');

installEnv();
const ENV = ['WABISTAY_GATE_CONFIRM_FLOW', 'WABISTAY_GATE_PAY_FLOW', 'WABISTAY_PAY_ASSIGNS_ROOM', 'WABISTAY_PAID_ROOM_CONFIRMED', 'WABISTAY_GATE_ROOM_CHECK',
  'WABISTAY_ENQUIRY_TRACKING', 'WABISTAY_PAID_BY_BOOKING_REF', 'WABISTAY_MESSAGE_DEDUPE', 'WABISTAY_INTERACTIVE', 'WABISTAY_CHECKOUT_BUTTON',
  'WABISTAY_GATE_ALERT_UNPAID', 'WABISTAY_GATE_ARRIVAL_TEMPLATE'];
const saved = Object.fromEntries(ENV.map(k => [k, process.env[k]]));
afterEach(() => { for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

const wh = require('../api/wabistay/webhook.js');
const GUEST = '27784896186';
const RECEPTION = '27780384989';
const NOTIFY = '27831112222';
const MIN = 60e3;
const iso = ms => new Date(ms).toISOString();
const ago = m => iso(Date.now() - m * MIN);

function seed({ roomStatus = 'Available', guestState = 'CONFIRMED', guest = {}, booking = {}, property = {}, receptionPhone = RECEPTION } = {}) {
  return {
    WS_Properties: [{ id: 'recP1', fields: { 'Property Name': 'Canary Street Guest Rooms', 'Phone Number ID': '111000111000', 'Notify Phone': NOTIFY, 'Guest Redirect Phone': '0730260871', 'Hourly Rate 2hr': 200, ...property } }],
    WS_Rooms: [{ id: 'recR1', fields: { 'Room Name': 'Room 01', 'Room Number': 1, 'Status': roomStatus, 'Property': ['recP1'], 'Active': true } }],
    WS_Roles: [{ id: 'recRole1', fields: { 'Role Label': 'Reception', 'Role Type': 'Reception', 'Property': ['recP1'], 'Current Phone': receptionPhone, 'Active': true } }],
    WS_Guests: [{ id: 'recG1', fields: { 'Guest Name': 'Mama Test', 'Phone Number': GUEST, 'Session State': guestState, ...guest } }],
    WS_Cleaners: [], WS_Rates: [], WS_Enquiries: [],
    WS_Bookings: [{
      id: 'recBook1',
      fields: {
        'Guest': ['recG1'], 'Room': ['recR1'], 'Booking Type': 'Hourly', 'Status': 'Confirmed', 'Amount Due': 250,
        'Payment Status': 'Unpaid', 'Payment Method': 'Card', 'Booking Ref': 'WS-GATEP1', 'Payment Reference': 'AB12',
        'Check In': ago(10), 'Check Out': iso(Date.now() + 2 * 3600e3), 'Gate Tap At': ago(5), ...booking
      }
    }]
  };
}
let lastCtx = null;
async function run(opts, steps, { flag = '1', env = {} } = {}) {
  if (flag === null) delete process.env.WABISTAY_GATE_CONFIRM_FLOW; else process.env.WABISTAY_GATE_CONFIRM_FLOW = flag;
  delete process.env.WABISTAY_GATE_PAY_FLOW;
  delete process.env.WABISTAY_PAY_ASSIGNS_ROOM;
  process.env.WABISTAY_PAID_ROOM_CONFIRMED = '1';
  process.env.WABISTAY_INTERACTIVE = '1';
  process.env.WABISTAY_CHECKOUT_BUTTON = '1';
  process.env.WABISTAY_GATE_ALERT_UNPAID = '1';
  process.env.WABISTAY_GATE_ARRIVAL_TEMPLATE = 'wabistay_gate_arrival';
  for (const [k, v] of Object.entries(env)) { if (v === null) delete process.env[k]; else process.env[k] = v; }
  const ctx = { airtable: new MockAirtable(seed(opts)), sends: [], axiom: [] };
  installFetch(ctx);
  lastCtx = ctx;
  await play(ctx, steps);
  return ctx;
}
async function play(ctx, steps) {
  for (const step of steps) {
    const [from, text, id] = step;
    const body = text && typeof text === 'object' ? metaInteractivePayload(from, text, id) : metaTextPayload(from, text, id);
    await wh({ method: 'POST', body }, makeRes());
  }
}
const booking = ctx => ctx.airtable.tables['WS_Bookings'][0].fields;
const guest = ctx => ctx.airtable.tables['WS_Guests'][0].fields;
const room = ctx => ctx.airtable.tables['WS_Rooms'][0].fields;
const texts = (ctx, who) => ctx.sends.filter(s => s.to === who && s.type === 'text').map(s => s.body);
const inter = (ctx, who = GUEST) => ctx.sends.filter(s => s.to === who && s.type === 'interactive');
const templates = (ctx, who) => ctx.sends.filter(s => s.to === who && s.template === 'wabistay_gate_arrival');
const allTo = (ctx, who) => ctx.sends.filter(s => s.to === who);
const PAY = [RECEPTION, 'PAID ROOM 1 250 card'];
const KEYS = [GUEST, { id: 'keys_ok', title: 'I have my keys' }];
const CALL = ' No reply in 5 minutes? Call 073 026 0871.';

function keysBody(ctx) {
  const d = new Date(Date.parse(booking(ctx)['Check Out']) + 2 * 3600e3);
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const clock = String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0');
  return `Payment received, Mama Test. Your room is Room 01. Check-out is ${clock} on ${d.getUTCDate()} ${MON[d.getUTCMonth()]}. Need more time? Ask reception: an extra 2 hours is R200. Tap the button once you have your keys so we can log your check-in.`;
}

// ── B1: the gate press ───────────────────────────────────────────────────────

test('B1 unpaid press: new wording with the call line; the room stays held; one alert to reception, the Notify Phone copy goes to its own number', async () => {
  const ctx = await run({ booking: { 'Gate Tap At': undefined } }, [[GUEST, '1']]);
  assert.deepStrictEqual(texts(ctx, GUEST), ['Thanks Mama Test, reception knows you\'re here and someone will be with you shortly to open the gate. Please come to the office to pay (card or EFT).' + CALL]);
  assert.ok(booking(ctx)['Gate Tap At'], 'tap remembered');
  assert.strictEqual(booking(ctx)['Status'], 'Confirmed');
  assert.strictEqual(guest(ctx)['Session State'], 'CONFIRMED');
  assert.strictEqual(templates(ctx, RECEPTION).length, 1, 'reception template once');
  assert.strictEqual(texts(ctx, NOTIFY).length, 1, 'a different Notify Phone still gets its copy');
});

test('B1/B5: when the Notify Phone is the same number as the Reception seat, that phone gets ONE alert per unpaid press (the 12:45 duplicate)', async () => {
  const ctx = await run({ booking: { 'Gate Tap At': undefined }, property: { 'Notify Phone': RECEPTION } }, [[GUEST, '1']]);
  assert.strictEqual(allTo(ctx, RECEPTION).length, 1, 'one message to that phone, not two');
  assert.strictEqual(templates(ctx, RECEPTION).length, 1);
  assert.ok(ctx.axiom.some(e => e.event === 'gate_alert_owner_copy_deduped'));
});

test('B1/B5: a repeat press inside ten minutes raises no second alert (existing quiet period)', async () => {
  const ctx = await run({ booking: { 'Gate Tap At': undefined }, property: { 'Notify Phone': RECEPTION } }, [[GUEST, '1'], [GUEST, '1']]);
  assert.strictEqual(allTo(ctx, RECEPTION).length, 1);
  assert.strictEqual(texts(ctx, GUEST).length, 2, 'the guest is answered both times');
});

test('B1/B2: already paid at the press: the B1 reply, then ONE keys message, one alert; the guest is checked in with the room', async () => {
  const ctx = await run({ booking: { 'Payment Status': 'Paid', 'Gate Tap At': undefined }, property: { 'Notify Phone': RECEPTION } }, [[GUEST, '1']]);
  assert.deepStrictEqual(texts(ctx, GUEST), ['Thanks Mama Test, reception knows you\'re here and someone will be with you shortly to open the gate.' + CALL]);
  assert.strictEqual(inter(ctx).length, 1, 'one interactive message');
  assert.strictEqual(inter(ctx)[0].body, keysBody(ctx));
  assert.deepStrictEqual(inter(ctx)[0].buttons, [{ id: 'keys_ok', title: 'I have my keys' }]);
  assert.ok(!texts(ctx, GUEST).some(t => /^Welcome to/.test(t)), 'no Welcome yet');
  assert.strictEqual(booking(ctx)['Status'], 'Checked In');
  assert.strictEqual(room(ctx)['Status'], 'Occupied');
  assert.strictEqual(allTo(ctx, RECEPTION).length, 1, 'one alert for the press');
  assert.ok(booking(ctx)['Keys Prompt Sent At']);
});

// ── B2: payment recorded by reception ────────────────────────────────────────

test('B2: PAID ROOM for a guest who pressed 1 sends exactly one interactive message with the room, check-out time, extra-2-hours note and the button', async () => {
  const ctx = await run({}, [PAY]);
  assert.strictEqual(inter(ctx).length, 1);
  assert.strictEqual(inter(ctx)[0].body, keysBody(ctx));
  assert.deepStrictEqual(inter(ctx)[0].buttons, [{ id: 'keys_ok', title: 'I have my keys' }]);
  assert.strictEqual(texts(ctx, GUEST).length, 0, 'nothing else to the guest');
  assert.strictEqual(booking(ctx)['Status'], 'Checked In');
  assert.strictEqual(booking(ctx)['Payment Status'], 'Paid');
  assert.strictEqual(guest(ctx)['Session State'], 'CHECKED_IN');
});

test('B5: the check-in that reception\'s own PAID triggers raises no new reception alert and no Notify Phone copy', async () => {
  const ctx = await run({}, [PAY]);
  assert.strictEqual(templates(ctx, RECEPTION).length, 0);
  assert.ok(!texts(ctx, NOTIFY).some(t => /arrived|gate/i.test(t)), 'no arrival copy to the Notify Phone');
});

test('B2: PAID REF does the same', async () => {
  const ctx = await run({}, [[RECEPTION, 'PAID REF AB12 250']], { env: { WABISTAY_PAID_BY_BOOKING_REF: '1' } });
  assert.strictEqual(inter(ctx).length, 1);
});

test('B2: the guest has not pressed 1 yet: nothing is sent; their own later press (already paid) gets B1 then the keys message', async () => {
  const ctx = await run({ booking: { 'Gate Tap At': undefined } }, [PAY]);
  assert.strictEqual(allTo(ctx, GUEST).length, 0);
  await play(ctx, [[GUEST, '1']]);
  assert.strictEqual(inter(ctx).length, 1);
  assert.strictEqual(texts(ctx, GUEST).length, 1);
});

test('B2: the 24 h window closed: nothing is sent to the guest and it is logged; the payment is still recorded', async () => {
  const ctx = await run({ booking: { 'Gate Tap At': ago(30 * 60) }, guest: { 'Last Inbound At': ago(26 * 60) } }, [PAY]);
  assert.strictEqual(allTo(ctx, GUEST).length, 0);
  assert.strictEqual(booking(ctx)['Status'], 'Confirmed');
  assert.strictEqual(booking(ctx)['Payment Status'], 'Paid');
  assert.deepStrictEqual(ctx.axiom.filter(e => e.event === 'pay_assigns_room_skipped').map(e => e.reason), ['window_closed']);
});

test('B2: without WABISTAY_INTERACTIVE the same words go as text and the guest replies KEYS', async () => {
  const ctx = await run({}, [PAY], { env: { WABISTAY_INTERACTIVE: null } });
  assert.strictEqual(inter(ctx).length, 0);
  assert.strictEqual(texts(ctx, GUEST).length, 1);
  assert.match(texts(ctx, GUEST)[0], /^Payment received, Mama Test\. Your room is Room 01\. Check-out is \d\d:\d\d on \d+ \w+\. Need more time\? Ask reception: an extra 2 hours is R200\. Reply KEYS once you have your keys so we can log your check-in\.$/);
  await play(ctx, [[GUEST, 'KEYS']]);
  assert.ok(booking(ctx)['Keys Tap At']);
  assert.match(texts(ctx, GUEST).slice(-1)[0], /^Welcome to Canary Street Guest Rooms! Your room is \*Room 01\*/);
});

test('B2: a property with no 2 hour rate gets the message without the extension sentence', async () => {
  const ctx = await run({ property: { 'Hourly Rate 2hr': undefined } }, [PAY]);
  assert.ok(!/Need more time/.test(inter(ctx)[0].body));
  assert.match(inter(ctx)[0].body, /Check-out is \d\d:\d\d on \d+ \w+\. Tap the button once you have your keys/);
});

test('B2: a room that is not Available (with the room check on) is not handed over and no keys message is sent', async () => {
  const ctx = await run({ roomStatus: 'Cleaning' }, [PAY], { env: { WABISTAY_GATE_ROOM_CHECK: '1' } });
  assert.strictEqual(inter(ctx).length, 0);
  assert.strictEqual(booking(ctx)['Status'], 'Confirmed');
});

// ── B3: the tap ──────────────────────────────────────────────────────────────

test('B3: the tap is logged with a timestamp and the existing check-out message (Welcome + Check out button) follows', async () => {
  const ctx = await run({}, [PAY, KEYS]);
  assert.ok(booking(ctx)['Keys Tap At'], 'timestamp written');
  const last = inter(ctx).slice(-1)[0];
  assert.strictEqual(inter(ctx).length, 2);
  assert.strictEqual(last.body, 'Welcome to Canary Street Guest Rooms! Your room is *Room 01*. We\'re happy to have you here. When you\'re ready to leave, tap Check out.');
  assert.deepStrictEqual(last.buttons, [{ id: 'co_start', title: 'Check out' }]);
  assert.strictEqual(booking(ctx)['Status'], 'Checked In');
});

test('B3/B5: a second tap and a redelivered tap send nothing', async () => {
  const ctx = await run({}, [PAY, [GUEST, { id: 'keys_ok', title: 'I have my keys' }, 'wamid.K1'], [GUEST, { id: 'keys_ok', title: 'I have my keys' }, 'wamid.K1'], [GUEST, { id: 'keys_ok', title: 'I have my keys' }, 'wamid.K2']], { env: { WABISTAY_MESSAGE_DEDUPE: '1' } });
  assert.strictEqual(inter(ctx).length, 2, 'one keys message and one check-out message, never more');
  assert.ok(ctx.axiom.some(e => e.event === 'keys_tap_repeat'));
});

test('B3: a failed timestamp write never blocks the check-out message', async () => {
  const ctx = await run({}, [PAY]);
  const orig = global.fetch;
  global.fetch = async (url, opts = {}) => {
    if ((opts.method || '').toUpperCase() === 'PATCH' && /Keys Tap At/.test(opts.body || '')) {
      return { status: 422, ok: false, json: async () => ({ error: { type: 'UNKNOWN_FIELD_NAME' } }), text: async () => '{"error":"UNKNOWN_FIELD_NAME"}' };
    }
    return orig(url, opts);
  };
  await play(ctx, [KEYS]);
  global.fetch = orig;
  assert.strictEqual(inter(ctx).length, 2, 'the check-out message still went');
  assert.ok(ctx.axiom.some(e => e.event === 'keys_tap_stamp_failed'));
});

test('B3: the Check out button still works after the keys tap (asks "Check out now?")', async () => {
  const ctx = await run({}, [PAY, KEYS, [GUEST, { id: 'co_start', title: 'Check out' }]]);
  assert.strictEqual(inter(ctx).slice(-1)[0].buttons.map(b => b.id).join(), 'co_yes,co_no');
  assert.strictEqual(booking(ctx)['Status'], 'Checked In', 'nothing was checked out by asking');
});

// ── B4: free text in between ─────────────────────────────────────────────────

test('B4: free text after the keys message gets a short nudge with the button; never the menu; no alert', async () => {
  const ctx = await run({}, [PAY]);
  const alertsBefore = ctx.sends.filter(s => s.to === RECEPTION || s.to === NOTIFY).length;
  await play(ctx, [[GUEST, 'hello?']]);
  const last = inter(ctx).slice(-1)[0];
  assert.strictEqual(last.body, 'Please tap the button below once you have your keys, Mama Test.');
  assert.deepStrictEqual(last.buttons, [{ id: 'keys_ok', title: 'I have my keys' }]);
  assert.ok(!texts(ctx, GUEST).some(t => /1 - Check out/.test(t) && !/^Welcome/.test(t)), 'not the checked-in menu');
  assert.strictEqual(ctx.sends.filter(s => s.to === RECEPTION || s.to === NOTIFY).length, alertsBefore, 'no new alert');
});

test('B4: after the tap, free text gets today\'s checked-in menu again', async () => {
  const ctx = await run({}, [PAY, KEYS]);
  const before = ctx.sends.length;
  await play(ctx, [[GUEST, 'thanks']]);
  const added = ctx.sends.slice(before);
  assert.strictEqual(added.length, 1);
  assert.match(added[0].body, /check out|checking out|extend/i);
  assert.ok(!/button below/.test(added[0].body));
});

test('B4: free text between the press and payment gets the waiting reply (not the menu), and raises no alert', async () => {
  const ctx = await run({}, [[GUEST, 'where is everyone']]);
  assert.match(texts(ctx, GUEST)[0], /^Thanks Mama Test, reception knows you're here and will be with you shortly\./);
  assert.strictEqual(allTo(ctx, RECEPTION).length + allTo(ctx, NOTIFY).length, 0);
});

test('B4: typed 1 in the ten minutes after the automatic check-in is "already checked in", never a checkout', async () => {
  const ctx = await run({}, [PAY, [GUEST, '1']]);
  assert.strictEqual(booking(ctx)['Status'], 'Checked In');
  assert.ok(texts(ctx, GUEST).some(t => /already checked in/i.test(t)));
});

// ── B5: nothing is sent twice ────────────────────────────────────────────────

test('B5: a redelivered PAID, a second PAID, and two PAIDs at once send ONE keys message', async () => {
  const a = await run({}, [[RECEPTION, 'PAID ROOM 1 250 card', 'wamid.P1'], [RECEPTION, 'PAID ROOM 1 250 card', 'wamid.P1'], [RECEPTION, 'PAID ROOM 1 250 card', 'wamid.P2']], { env: { WABISTAY_MESSAGE_DEDUPE: '1' } });
  assert.strictEqual(inter(a).length, 1);
  const ctx = { airtable: new MockAirtable(seed()), sends: [], axiom: [] };
  installFetch(ctx);
  await Promise.all([
    wh({ method: 'POST', body: metaTextPayload(RECEPTION, 'PAID ROOM 1 250 card', 'wamid.C1') }, makeRes()),
    wh({ method: 'POST', body: metaTextPayload(RECEPTION, 'PAID ROOM 1 250 card', 'wamid.C2') }, makeRes())
  ]);
  assert.strictEqual(inter(ctx).length, 1);
});

test('flag off: the pay-flow behaviour is unchanged (existing Welcome, old reply, no keys button, both alerts)', async () => {
  const ctx = await run({ booking: { 'Gate Tap At': undefined } }, [[GUEST, '1']], { flag: null });
  assert.strictEqual(inter(ctx).length, 0);
  const paid = await run({}, [PAY], { flag: null });
  assert.strictEqual(inter(paid).length, 0);
  assert.strictEqual(booking(paid)['Status'], 'Confirmed', 'without any gate flow, payment alone does not check in');
});

test('the confirm flag alone includes the pay flow (no need to also set WABISTAY_GATE_PAY_FLOW)', async () => {
  const ctx = await run({}, [PAY]);
  assert.strictEqual(booking(ctx)['Status'], 'Checked In');
});
