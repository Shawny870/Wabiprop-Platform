// test/payassignsroom.test.js
// WABISTAY_PAY_ASSIGNS_ROOM: a guest who tapped "I'm at the gate" before paying is checked in and sent
// their room when reception records the payment (PAID ROOM / PAID REF), once, only if the room is
// Available. 10 minutes after an AUTOMATIC check-in a tap of 1 is "already checked in", not a checkout.
// Flag off: today's behaviour. In-memory only: MockAirtable + mocked fetch.

const { test, afterEach } = require('node:test');
const assert = require('node:assert');
const { installEnv, installFetch, makeRes, metaTextPayload, MockAirtable } = require('./harness');

installEnv();
const ENV = ['WABISTAY_PAID_ROOM_CONFIRMED', 'WABISTAY_PAY_ASSIGNS_ROOM', 'WABISTAY_GATE_ROOM_CHECK', 'WABISTAY_ENQUIRY_TRACKING', 'WABISTAY_PAID_BY_BOOKING_REF'];
const saved = Object.fromEntries(ENV.map(k => [k, process.env[k]]));
afterEach(() => { for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

const wh = require('../api/wabistay/webhook.js');
const GUEST = '27784896186';
const RECEPTION = '27780384989';
const MIN = 60e3;
const iso = ms => new Date(ms).toISOString();
const ago = m => iso(Date.now() - m * MIN);

const WELCOME = 'Welcome to Canary Street Guest Rooms! 🌟 Your room is *Room 01*.\n\nSomeone is on their way to help you at the gate.\n\nWhen you\'re ready to leave, reply with a number:\n1 - Check out';
const OLD_UNPAID = 'Almost there! Pop into the office to sort payment — card or EFT — and reception will get you your keys.';
const NEW_UNPAID = 'Almost there! Please come into the office and pay by card or EFT. As soon as reception has recorded your payment, we will send you your room number here.';
const ALREADY_IN = 'You are already checked in to Room 01. Reply 1 again when you are ready to leave.';

function seed({ roomStatus = 'Available', guestState = 'CONFIRMED', booking = {}, testPhone = false } = {}) {
  return {
    WS_Properties: [{ id: 'recP1', fields: { 'Property Name': 'Canary Street Guest Rooms', 'Phone Number ID': '111000111000', 'Notify Phone': '27831112222' } }],
    WS_Rooms: [{ id: 'recR1', fields: { 'Room Name': 'Room 01', 'Room Number': 1, 'Status': roomStatus, 'Property': ['recP1'], 'Active': true } }],
    WS_Roles: [{ id: 'recRole1', fields: { 'Role Label': 'Reception', 'Role Type': 'Reception', 'Property': ['recP1'], 'Current Phone': RECEPTION, 'Active': true } }],
    WS_Guests: [{ id: 'recG1', fields: { 'Guest Name': 'Mama Test', 'Phone Number': GUEST, 'Session State': guestState, ...(testPhone ? { 'Test Phone': true } : {}) } }],
    WS_Cleaners: [], WS_Rates: [], WS_Enquiries: [],
    WS_Bookings: [{
      id: 'recBook1',
      fields: {
        'Guest': ['recG1'], 'Room': ['recR1'], 'Booking Type': 'Hourly', 'Status': 'Confirmed', 'Amount Due': 250,
        'Payment Status': 'Unpaid', 'Payment Method': 'Card', 'Booking Ref': 'WS-PAYAS1', 'Payment Reference': 'AB12',
        'Check In': ago(10), 'Check Out': iso(Date.now() + 2 * 3600e3), 'Gate Tap At': ago(5), ...booking
      }
    }]
  };
}
async function run(opts, steps, { flag = '1', failGuestSends = false, env = {} } = {}) {
  if (flag === null) delete process.env.WABISTAY_PAY_ASSIGNS_ROOM; else process.env.WABISTAY_PAY_ASSIGNS_ROOM = flag;
  process.env.WABISTAY_PAID_ROOM_CONFIRMED = '1';   // production has it on: it is how PAID ROOM finds a Confirmed booking
  for (const [k, v] of Object.entries(env)) { if (v === null) delete process.env[k]; else process.env[k] = v; }
  const ctx = { airtable: new MockAirtable(seed(opts)), sends: [], axiom: [] };
  installFetch(ctx);
  if (failGuestSends) {
    const inner = global.fetch;
    global.fetch = async (url, o = {}) => {
      if (String(url).includes('graph.facebook.com') && JSON.parse(o.body).to === GUEST) {
        return { status: 400, json: async () => ({ error: { code: 131047, message: 'Re-engagement message' } }) };
      }
      return inner(url, o);
    };
  }
  for (const [from, text] of steps) await wh({ method: 'POST', body: metaTextPayload(from, text) }, makeRes());
  return ctx;
}
const booking = ctx => ctx.airtable.tables['WS_Bookings'][0].fields;
const room = ctx => ctx.airtable.tables['WS_Rooms'][0].fields;
const guest = ctx => ctx.airtable.tables['WS_Guests'][0].fields;
const to = (ctx, who) => ctx.sends.filter(s => s.to === who && s.type === 'text').map(s => s.body);
const PAY = [RECEPTION, 'PAID ROOM 1 250 card'];

// ── the new unpaid message and the tap stamp ─────────────────────────────────

test('flag on: the unpaid gate tap gets the new message and the tap is stamped, even for a test phone with tracking off', async () => {
  const ctx = await run({ booking: { 'Gate Tap At': undefined }, testPhone: true }, [[GUEST, '1']]);
  assert.strictEqual(to(ctx, GUEST)[0], NEW_UNPAID);
  assert.ok(booking(ctx)['Gate Tap At'], 'tap stamped');
  assert.strictEqual(booking(ctx)['Status'], 'Confirmed');
  assert.strictEqual(guest(ctx)['Session State'], 'CONFIRMED');
});

test('flag off: the unpaid message is today\'s and a test phone is not stamped', async () => {
  const ctx = await run({ booking: { 'Gate Tap At': undefined }, testPhone: true }, [[GUEST, '1']], { flag: null });
  assert.strictEqual(to(ctx, GUEST)[0], OLD_UNPAID);
  assert.strictEqual(booking(ctx)['Gate Tap At'], undefined);
});

// ── payment checks the waiting guest in ──────────────────────────────────────

test('flag on: PAID ROOM for a guest who tapped the gate checks them in and sends exactly one welcome', async () => {
  const ctx = await run({}, [PAY]);
  assert.deepStrictEqual(to(ctx, GUEST), [WELCOME]);
  assert.strictEqual(booking(ctx)['Status'], 'Checked In');
  assert.ok(booking(ctx)['Checked In At']);
  assert.strictEqual(booking(ctx)['Payment Status'], 'Paid');
  assert.deepStrictEqual(booking(ctx)['Room'], ['recR1']);
  assert.strictEqual(room(ctx)['Status'], 'Occupied');
  assert.strictEqual(guest(ctx)['Session State'], 'CHECKED_IN');
  const reception = to(ctx, RECEPTION);
  assert.match(reception[0], /Payment recorded/);
  assert.ok(reception.includes('Mama Test was waiting at the gate. Checked in and sent their room: Room 01.'), reception.join('\n'));
});

test('flag on: PAID REF (4-character EFT reference) does the same', async () => {
  const ctx = await run({}, [[RECEPTION, 'PAID REF AB12 250']], { env: { WABISTAY_PAID_BY_BOOKING_REF: '1' } });
  assert.deepStrictEqual(to(ctx, GUEST), [WELCOME]);
  assert.strictEqual(booking(ctx)['Status'], 'Checked In');
});

test('flag on: a second PAID is "already recorded" and the guest gets nothing more', async () => {
  const ctx = await run({}, [PAY, PAY]);
  assert.strictEqual(to(ctx, GUEST).length, 1);
  assert.match(to(ctx, RECEPTION).join('\n'), /already/i);
  assert.strictEqual(booking(ctx)['Status'], 'Checked In');
});

test('flag on: a guest who taps 1 at the same moment does not get checked in twice', async () => {
  const ctx = await run({}, [PAY, [GUEST, '1']]);
  assert.strictEqual(booking(ctx)['Status'], 'Checked In');
  assert.strictEqual(to(ctx, GUEST).filter(t => /Your room is/.test(t)).length, 1, 'one welcome only');
});

test('flag on: no gate tap means nothing is sent (today\'s behaviour)', async () => {
  const ctx = await run({ booking: { 'Gate Tap At': undefined } }, [PAY]);
  assert.strictEqual(to(ctx, GUEST).length, 0);
  assert.strictEqual(booking(ctx)['Status'], 'Confirmed');
  assert.strictEqual(booking(ctx)['Payment Status'], 'Paid');
  assert.strictEqual(guest(ctx)['Session State'], 'CONFIRMED');
});

test('flag on: a gate tap older than 24 hours, or a guest no longer waiting, sends nothing', async () => {
  const old = await run({ booking: { 'Gate Tap At': ago(25 * 60) } }, [PAY]);
  assert.strictEqual(to(old, GUEST).length, 0);
  assert.strictEqual(booking(old)['Status'], 'Confirmed');
  const notWaiting = await run({ guestState: 'AWAITING_ETA' }, [PAY]);
  assert.strictEqual(to(notWaiting, GUEST).length, 0);
  assert.strictEqual(booking(notWaiting)['Status'], 'Confirmed');
});

test('flag off: payment with a gate tap on record changes nothing for the guest, exactly as today', async () => {
  const ctx = await run({}, [PAY], { flag: null });
  assert.strictEqual(to(ctx, GUEST).length, 0);
  assert.strictEqual(booking(ctx)['Status'], 'Confirmed');
  assert.strictEqual(room(ctx)['Status'], 'Available');
  assert.strictEqual(guest(ctx)['Session State'], 'CONFIRMED');
  assert.strictEqual(to(ctx, RECEPTION).length, 1, 'reception gets only the payment confirmation');
});

// ── room not Available ───────────────────────────────────────────────────────

test('flag on: a room that is not Available is not assigned; guest told to wait at the office, reception told the real status (room check forced even with GATE_ROOM_CHECK off)', async () => {
  const ctx = await run({ roomStatus: 'Cleaning' }, [PAY], { env: { WABISTAY_GATE_ROOM_CHECK: null } });
  assert.strictEqual(booking(ctx)['Status'], 'Confirmed');
  assert.strictEqual(room(ctx)['Status'], 'Cleaning');
  assert.strictEqual(guest(ctx)['Session State'], 'CONFIRMED');
  assert.match(to(ctx, GUEST)[0], /Your room isn't quite ready yet\. Please wait at the office/);
  assert.ok(to(ctx, RECEPTION).includes('Mama Test was waiting at the gate, but Room 01 is Cleaning, so no room was assigned. They were told to wait at the office.'), to(ctx, RECEPTION).join('\n'));
  assert.strictEqual(booking(ctx)['Payment Status'], 'Paid', 'the payment itself is still recorded');
});

// ── the guest message cannot be sent ─────────────────────────────────────────

test('flag on: if the guest message fails (24-hour window), reception is told clearly', async () => {
  const ctx = await run({}, [PAY], { failGuestSends: true });
  assert.strictEqual(booking(ctx)['Status'], 'Checked In');
  assert.ok(to(ctx, RECEPTION).includes('Mama Test is checked in to Room 01, but I could not message them (the 24-hour window may be closed). Please tell them their room.'), to(ctx, RECEPTION).join('\n'));
});

// ── the 10-minute guard ──────────────────────────────────────────────────────

function autoCheckedIn(minutesAgo) {
  // gate tap first, payment after it, check-in a few seconds after the payment: the automatic signature
  const inAt = Date.now() - minutesAgo * MIN;
  return {
    state: { guestState: 'CHECKED_IN', roomStatus: 'Occupied', booking: {
      'Status': 'Checked In', 'Payment Status': 'Paid', 'Amount Paid': 250,
      'Gate Tap At': iso(inAt - 6 * MIN), 'Paid At': iso(inAt - 5000), 'Checked In At': iso(inAt)
    } }
  };
}

test('flag on: at 9 minutes after an automatic check-in, a tap of 1 is "already checked in" and nothing is written', async () => {
  const { state } = autoCheckedIn(9);
  const ctx = await run(state, [[GUEST, '1']]);
  assert.deepStrictEqual(to(ctx, GUEST), [ALREADY_IN]);
  assert.strictEqual(booking(ctx)['Status'], 'Checked In');
  assert.strictEqual(room(ctx)['Status'], 'Occupied');
  assert.strictEqual(guest(ctx)['Session State'], 'CHECKED_IN');
});

test('flag on: at 11 minutes the same tap is a normal checkout', async () => {
  const { state } = autoCheckedIn(11);
  const ctx = await run(state, [[GUEST, '1']]);
  assert.strictEqual(booking(ctx)['Status'], 'Checked Out');
  assert.ok(!to(ctx, GUEST).includes(ALREADY_IN));
});

test('flag on: the guard is only for the automatic path — a guest who tapped 1 themselves after paying can check out at 9 minutes', async () => {
  const inAt = Date.now() - 9 * MIN;
  const ctx = await run({ guestState: 'CHECKED_IN', roomStatus: 'Occupied', booking: {
    'Status': 'Checked In', 'Payment Status': 'Paid', 'Amount Paid': 250,
    'Paid At': iso(inAt - 30 * MIN), 'Checked In At': iso(inAt), 'Gate Tap At': undefined
  } }, [[GUEST, '1']]);
  assert.strictEqual(booking(ctx)['Status'], 'Checked Out');
});

test('flag off: at 9 minutes after the same sequence a tap of 1 is a normal checkout, exactly as today', async () => {
  const { state } = autoCheckedIn(9);
  const ctx = await run(state, [[GUEST, '1']], { flag: null });
  assert.strictEqual(booking(ctx)['Status'], 'Checked Out');
  assert.ok(!to(ctx, GUEST).includes(ALREADY_IN));
});

test('flag on: the end-to-end sequence — tap, pay, impatient second tap 1 minute later is not a checkout', async () => {
  const ctx = await run({ booking: { 'Gate Tap At': undefined } }, [[GUEST, '1'], PAY, [GUEST, '1']]);
  assert.strictEqual(booking(ctx)['Status'], 'Checked In');
  assert.ok(to(ctx, GUEST).includes(NEW_UNPAID));
  assert.ok(to(ctx, GUEST).includes(WELCOME));
});

test('the flag is on the cold-start list and reads off by default', () => {
  delete process.env.WABISTAY_PAY_ASSIGNS_ROOM;
  assert.strictEqual(wh.wabistayFlagState()['WABISTAY_PAY_ASSIGNS_ROOM'], 'off');
  process.env.WABISTAY_PAY_ASSIGNS_ROOM = '1';
  assert.strictEqual(wh.wabistayFlagState()['WABISTAY_PAY_ASSIGNS_ROOM'], 'on');
});
