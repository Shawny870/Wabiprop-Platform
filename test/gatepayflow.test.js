// test/gatepayflow.test.js
// WABISTAY_GATE_PAY_FLOW: the at-the-gate-before-paying journey.
//  (a) new unpaid gate reply, (b) payment checks the waiting guest in and sends the Welcome (24 h window, never twice),
//  (c) free text from a waiting guest, (d) Card-chosen wording. Flag off: today's messages and behaviour.

const { test, afterEach } = require('node:test');
const assert = require('node:assert');
const { installEnv, installFetch, makeRes, metaTextPayload, MockAirtable } = require('./harness');

installEnv();
const ENV = ['WABISTAY_GATE_PAY_FLOW', 'WABISTAY_PAY_ASSIGNS_ROOM', 'WABISTAY_PAID_ROOM_CONFIRMED', 'WABISTAY_GATE_ROOM_CHECK', 'WABISTAY_ENQUIRY_TRACKING', 'WABISTAY_PAID_BY_BOOKING_REF', 'WABISTAY_MESSAGE_DEDUPE'];
const saved = Object.fromEntries(ENV.map(k => [k, process.env[k]]));
afterEach(() => { for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

const wh = require('../api/wabistay/webhook.js');
const GUEST = '27784896186';
const RECEPTION = '27780384989';
const MIN = 60e3;
const iso = ms => new Date(ms).toISOString();
const ago = m => iso(Date.now() - m * MIN);

const WELCOME = 'Welcome to Canary Street Guest Rooms! Your room is *Room 01*. We\'re happy to have you here. When you\'re ready to leave, tap Check out.\n\n1 - Check out';
const OLD_UNPAID = 'Almost there! Pop into the office to sort payment — card or EFT — and reception will get you your keys.';
const NEW_UNPAID = 'Thanks Mama Test, reception knows you\'re here and will open the gate. Please come to the office to pay (card or EFT). We\'ll message you your room as soon as payment is confirmed. No reply in 5 minutes? Call 073 026 0871.';
const WAITING = 'Thanks Mama Test, reception knows you\'re here and will be with you shortly. We\'ll message you your room as soon as payment is confirmed. No reply in 5 minutes? Call 073 026 0871.';
const OLD_CARD = 'Great — head on in! Please tap your card on the SpeedPoint machine in the office, and reception will hand you your keys.';
const NEW_CARD = 'When you arrive, reply 1 so we can open the gate. Please tap your card on the SpeedPoint machine in the office, and reception will hand you your keys.';

function seed({ roomStatus = 'Available', guestState = 'CONFIRMED', guest = {}, booking = {}, property = {} } = {}) {
  return {
    WS_Properties: [{ id: 'recP1', fields: { 'Property Name': 'Canary Street Guest Rooms', 'Phone Number ID': '111000111000', 'Notify Phone': '27831112222', 'Guest Redirect Phone': '0730260871', ...property } }],
    WS_Rooms: [{ id: 'recR1', fields: { 'Room Name': 'Room 01', 'Room Number': 1, 'Status': roomStatus, 'Property': ['recP1'], 'Active': true } }],
    WS_Roles: [{ id: 'recRole1', fields: { 'Role Label': 'Reception', 'Role Type': 'Reception', 'Property': ['recP1'], 'Current Phone': RECEPTION, 'Active': true } }],
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
async function run(opts, steps, { flag = '1', env = {} } = {}) {
  if (flag === null) delete process.env.WABISTAY_GATE_PAY_FLOW; else process.env.WABISTAY_GATE_PAY_FLOW = flag;
  delete process.env.WABISTAY_PAY_ASSIGNS_ROOM;           // the new flag alone must be enough
  process.env.WABISTAY_PAID_ROOM_CONFIRMED = '1';
  for (const [k, v] of Object.entries(env)) { if (v === null) delete process.env[k]; else process.env[k] = v; }
  const ctx = { airtable: new MockAirtable(seed(opts)), sends: [], axiom: [] };
  installFetch(ctx);
  for (const step of steps) {
    const [from, text, id] = step;
    await wh({ method: 'POST', body: metaTextPayload(from, text, id) }, makeRes());
  }
  return ctx;
}
const booking = ctx => ctx.airtable.tables['WS_Bookings'][0].fields;
const guest = ctx => ctx.airtable.tables['WS_Guests'][0].fields;
const to = (ctx, who) => ctx.sends.filter(s => s.to === who && s.type === 'text').map(s => s.body);
const welcomes = ctx => to(ctx, GUEST).filter(t => /Your room is/.test(t));
const PAY = [RECEPTION, 'PAID ROOM 1 250 card'];
const skipped = ctx => ctx.axiom.filter(e => e.event === 'pay_assigns_room_skipped').map(e => e.reason);

// ── (a) the unpaid at-the-gate reply ─────────────────────────────────────────

test('(a) flag on: the unpaid gate press gets the new message with the property\'s own call number; nothing but the tap stamp is written', async () => {
  const ctx = await run({ booking: { 'Gate Tap At': undefined } }, [[GUEST, '1']]);
  assert.strictEqual(to(ctx, GUEST)[0], NEW_UNPAID);
  assert.ok(booking(ctx)['Gate Tap At'], 'tap remembered');
  assert.strictEqual(booking(ctx)['Status'], 'Confirmed');
  assert.strictEqual(guest(ctx)['Session State'], 'CONFIRMED');
});

test('(a) flag on: a property with no Guest Redirect Phone gets the message without a call line', async () => {
  const ctx = await run({ property: { 'Guest Redirect Phone': '' }, booking: { 'Gate Tap At': undefined } }, [[GUEST, '1']]);
  assert.strictEqual(to(ctx, GUEST)[0], NEW_UNPAID.replace(' No reply in 5 minutes? Call 073 026 0871.', ''));
});

test('(a) flag off: today\'s unpaid message', async () => {
  const ctx = await run({ booking: { 'Gate Tap At': undefined } }, [[GUEST, '1']], { flag: null });
  assert.strictEqual(to(ctx, GUEST)[0], OLD_UNPAID);
});

// ── (b) payment checks the waiting guest in ──────────────────────────────────

test('(b) flag on alone: PAID ROOM for a guest who pressed 1 checks them in and sends the existing Welcome once', async () => {
  const ctx = await run({}, [PAY]);
  assert.deepStrictEqual(to(ctx, GUEST), [WELCOME]);
  assert.strictEqual(booking(ctx)['Status'], 'Checked In');
  assert.strictEqual(booking(ctx)['Payment Status'], 'Paid');
  assert.strictEqual(guest(ctx)['Session State'], 'CHECKED_IN');
  assert.ok(ctx.sends.every(s => s.type === 'text' || s.template === 'wabistay_gate_arrival' || s.type === 'interactive'), 'no template was added for the guest');
});

test('(b) flag on: PAID REF does the same', async () => {
  const ctx = await run({}, [[RECEPTION, 'PAID REF AB12 250']], { env: { WABISTAY_PAID_BY_BOOKING_REF: '1' } });
  assert.deepStrictEqual(welcomes(ctx), [WELCOME]);
  assert.strictEqual(booking(ctx)['Status'], 'Checked In');
});

test('(b) flag on: the guest has not pressed 1 yet — nothing is sent, and the existing flow runs when they do', async () => {
  const ctx = await run({ booking: { 'Gate Tap At': undefined } }, [PAY]);
  assert.strictEqual(to(ctx, GUEST).length, 0);
  assert.strictEqual(booking(ctx)['Status'], 'Confirmed');
  assert.strictEqual(booking(ctx)['Payment Status'], 'Paid');
  await wh({ method: 'POST', body: metaTextPayload(GUEST, '1') }, makeRes());
  assert.strictEqual(welcomes(ctx).length, 1, 'the guest\'s own press checks them in as before');
  assert.strictEqual(booking(ctx)['Status'], 'Checked In');
});

test('(b) flag on: the 24 h window is the guest\'s LAST inbound message: closed = nothing sent and it is logged', async () => {
  const closed = await run({ booking: { 'Gate Tap At': ago(30 * 60) }, guest: { 'Last Inbound At': ago(26 * 60) } }, [PAY]);
  assert.strictEqual(to(closed, GUEST).length, 0);
  assert.strictEqual(booking(closed)['Status'], 'Confirmed');
  assert.strictEqual(booking(closed)['Payment Status'], 'Paid', 'the payment itself is still recorded');
  assert.deepStrictEqual(skipped(closed), ['window_closed']);
  const open = await run({ booking: { 'Gate Tap At': ago(30 * 60) }, guest: { 'Last Inbound At': ago(60) } }, [PAY]);
  assert.strictEqual(welcomes(open).length, 1, 'a later message from the guest re-opened the window');
});

test('(b) flag on: a room that is not Available is not handed over; the guest gets the existing room-not-ready message (no Welcome) and reception is told', async () => {
  const ctx = await run({ roomStatus: 'Cleaning' }, [PAY]);
  assert.ok(!to(ctx, GUEST).some(t => /^Welcome to/.test(t)));
  assert.strictEqual(to(ctx, GUEST).length, 1, 'one message: the existing room-not-ready wait message');
  assert.strictEqual(booking(ctx)['Status'], 'Confirmed');
  assert.match(to(ctx, RECEPTION).join('\n'), /not ready|cleaning/i);
});

test('(b) flag off: payment with a gate tap on record changes nothing for the guest, as today', async () => {
  const ctx = await run({}, [PAY], { flag: null });
  assert.strictEqual(to(ctx, GUEST).length, 0);
  assert.strictEqual(booking(ctx)['Status'], 'Confirmed');
});

// ── redelivery: the Welcome can never go twice ──────────────────────────────

test('redelivery: the same PAID delivered again with a new message id sends no second Welcome', async () => {
  const ctx = await run({}, [[RECEPTION, 'PAID ROOM 1 250 card', 'wamid.P1'], [RECEPTION, 'PAID ROOM 1 250 card', 'wamid.P2']]);
  assert.strictEqual(welcomes(ctx).length, 1);
  assert.match(to(ctx, RECEPTION).join('\n'), /already/i);
});

test('redelivery: the very same PAID message id delivered twice (message dedupe on) is skipped the second time', async () => {
  const ctx = await run({}, [[RECEPTION, 'PAID ROOM 1 250 card', 'wamid.SAME'], [RECEPTION, 'PAID ROOM 1 250 card', 'wamid.SAME']], { env: { WABISTAY_MESSAGE_DEDUPE: '1' } });
  assert.strictEqual(welcomes(ctx).length, 1);
});

test('redelivery: two copies of the payment arriving at the same moment send one Welcome', async () => {
  process.env.WABISTAY_GATE_PAY_FLOW = '1';
  delete process.env.WABISTAY_PAY_ASSIGNS_ROOM;
  process.env.WABISTAY_PAID_ROOM_CONFIRMED = '1';
  const ctx = { airtable: new MockAirtable(seed()), sends: [], axiom: [] };
  installFetch(ctx);
  await Promise.all([
    wh({ method: 'POST', body: metaTextPayload(RECEPTION, 'PAID ROOM 1 250 card', 'wamid.C1') }, makeRes()),
    wh({ method: 'POST', body: metaTextPayload(RECEPTION, 'PAID ROOM 1 250 card', 'wamid.C2') }, makeRes())
  ]);
  assert.strictEqual(welcomes(ctx).length, 1);
  assert.strictEqual(booking(ctx)['Status'], 'Checked In');
});

test('redelivery: the guest\'s own redelivered "1" right after the automatic check-in is "already checked in", not a checkout', async () => {
  const ctx = await run({}, [PAY, [GUEST, '1', 'wamid.G1'], [GUEST, '1', 'wamid.G1b']]);
  assert.strictEqual(welcomes(ctx).length, 1);
  assert.strictEqual(booking(ctx)['Status'], 'Checked In', 'not checked out');
  assert.ok(to(ctx, GUEST).some(t => /already checked in/i.test(t)));
});

// ── (c) free text from a guest who has pressed 1 ─────────────────────────────

test('(c) flag on: free text from a guest who pressed 1 gets the short reply, not the menu with option 1', async () => {
  const ctx = await run({}, [[GUEST, 'no trigger here for next steps what does guest do next']]);
  assert.deepStrictEqual(to(ctx, GUEST), [WAITING]);
  assert.ok(!to(ctx, GUEST).join('').includes('1 - I\'m at the gate'));
  assert.strictEqual(booking(ctx)['Status'], 'Confirmed');
});

test('(c) flag on: free text from a guest who has NOT pressed 1 still gets the confirmed menu', async () => {
  const ctx = await run({ booking: { 'Gate Tap At': undefined } }, [[GUEST, 'hello?']]);
  assert.match(to(ctx, GUEST)[0], /Your booking is confirmed[\s\S]*1 - I'm at the gate/);
});

test('(c) flag off: free text from a guest who pressed 1 gets the confirmed menu, as today', async () => {
  const ctx = await run({}, [[GUEST, 'hello?']], { flag: null });
  assert.match(to(ctx, GUEST)[0], /1 - I'm at the gate/);
});

// ── (d) Card chosen ──────────────────────────────────────────────────────────

test('(d) choosing Card: new wording with the flag on, old wording off', async () => {
  const state = { guestState: 'AWAITING_PAYMENT_METHOD', booking: { 'Gate Tap At': undefined, 'Payment Method': undefined } };
  const on = await run(state, [[GUEST, 'card']]);
  assert.strictEqual(to(on, GUEST)[0], NEW_CARD);
  const off = await run(state, [[GUEST, 'card']], { flag: null });
  assert.strictEqual(to(off, GUEST)[0], OLD_CARD);
});

// ── guards exercised directly (the payment-message paths above have other protections as well) ───────────────

async function directSetup(over = { booking: { 'Payment Status': 'Paid', 'Paid At': new Date().toISOString() } }) {
  process.env.WABISTAY_GATE_PAY_FLOW = '1';
  delete process.env.WABISTAY_PAY_ASSIGNS_ROOM;
  const ctx = { airtable: new MockAirtable(seed(over)), sends: [], axiom: [] };
  installFetch(ctx);
  const property = ctx.airtable.tables['WS_Properties'][0];
  const roleCtx = { phone: RECEPTION, property, paid: {}, paidRole: {} };
  return { ctx, property, roleCtx };
}

test('two automatic check-ins started together for one booking send one Welcome (in-flight guard)', async () => {
  const { ctx, roleCtx } = await directSetup();
  const real = global.fetch;
  global.fetch = async (u, o) => { await new Promise(r => setTimeout(r, 15)); return real(u, o); };
  const b = ctx.airtable.tables['WS_Bookings'][0];
  const [a, c] = await Promise.all([
    wh.actions.autoCheckInAfterPayment(roleCtx, { ...b }, { reportTo: null }),
    wh.actions.autoCheckInAfterPayment(roleCtx, { ...b }, { reportTo: null })
  ]);
  assert.strictEqual(welcomes(ctx).length, 1);
  assert.strictEqual([a, c].filter(Boolean).length, 1, 'exactly one of the two ran the check-in');
  assert.ok(skipped(ctx).includes('already_in_progress'));
});

test('a stale copy of a booking that has meanwhile been checked in is not checked in again (fresh read)', async () => {
  const { ctx, roleCtx } = await directSetup();
  const stale = { ...ctx.airtable.tables['WS_Bookings'][0], fields: { ...ctx.airtable.tables['WS_Bookings'][0].fields } };
  Object.assign(ctx.airtable.tables['WS_Bookings'][0].fields, { Status: 'Checked In', 'Checked In At': ago(1) }); // guest state still CONFIRMED
  const ok = await wh.actions.autoCheckInAfterPayment(roleCtx, stale, { reportTo: null });
  assert.ok(!ok);
  assert.strictEqual(welcomes(ctx).length, 0);
  assert.deepStrictEqual(skipped(ctx), ['already_checked_in']);
});

test('(a)/(c) the call number comes from the property, formatted 3-3-4', async () => {
  const ctx = await run({ property: { 'Guest Redirect Phone': '0821112222' }, booking: { 'Gate Tap At': undefined } }, [[GUEST, '1']]);
  assert.match(to(ctx, GUEST)[0], /Call 082 111 2222\.$/);
  const ctx2 = await run({ property: { 'Guest Redirect Phone': '0821112222' } }, [[GUEST, 'hello?']]);
  assert.match(to(ctx2, GUEST)[0], /Call 082 111 2222\.$/);
});
