// test/payassignsdone.test.js
// WABISTAY_PAY_ASSIGNS_ROOM, second part: a cleaner's DONE that makes a room Available checks in the PAID guest who tapped the
// gate and was told to wait because that room was not ready (the booking holding THAT room; the earliest gate tap if several),
// once, with the new welcome. Reception stays the only way payment is recorded. Also the new unpaid gate text and welcome text.
// Flag off: DONE tells no guest anything, and the old texts are used. A test phone behaves like any guest.
// In-memory only: MockAirtable + mocked fetch.

const { test, afterEach } = require('node:test');
const assert = require('node:assert');
const { installEnv, installFetch, makeRes, metaTextPayload, MockAirtable } = require('./harness');

installEnv();
const ENV = ['WABISTAY_PAY_ASSIGNS_ROOM', 'WABISTAY_PAID_ROOM_CONFIRMED', 'WABISTAY_GATE_ROOM_CHECK', 'WABISTAY_ENQUIRY_TRACKING'];
const saved = Object.fromEntries(ENV.map(k => [k, process.env[k]]));
afterEach(() => { for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

const wh = require('../api/wabistay/webhook.js');
const GUEST_A = '27784896186';
const GUEST_B = '27736880175';
const RECEPTION = '27780384989';
const CLEANER = '27820000111';
const NOTIFY = '27831112222';
const MIN = 60e3;
const iso = ms => new Date(ms).toISOString();
const ago = m => iso(Date.now() - m * MIN);

const UNPAID_NEW = 'Almost there! Please come into the office and pay by card or EFT. Reception will message you here as soon as you are checked in.';
const UNPAID_OLD = 'Almost there! Pop into the office to sort payment — card or EFT — and reception will get you your keys.';
const welcomeNew = room => `Welcome to Canary Street Guest Rooms! Your room is *${room}*. We're happy to have you here. When you're ready to leave, tap Check out.\n\n1 - Check out`;
const welcomeOld = room => `Welcome to Canary Street Guest Rooms! 🌟 Your room is *${room}*.\n\nSomeone is on their way to help you at the gate.\n\nWhen you're ready to leave, reply with a number:\n1 - Check out`;
const NOT_READY = /Your room isn't quite ready yet\. Please wait at the office/;

function guest(id, phone, name, extra = {}) {
  return { id, fields: { 'Guest Name': name, 'Phone Number': phone, 'Session State': 'CONFIRMED', ...extra } };
}
function booking(id, guestId, roomId, extra = {}) {
  return {
    id,
    fields: {
      'Guest': [guestId], 'Room': [roomId], 'Booking Type': 'Hourly', 'Status': 'Confirmed', 'Amount Due': 250, 'Payment Status': 'Unpaid',
      'Payment Method': 'Card', 'Booking Ref': 'WS-' + id.slice(-6).toUpperCase(), 'Check In': ago(10), 'Check Out': iso(Date.now() + 2 * 3600e3), 'Gate Tap At': ago(5), ...extra
    }
  };
}
function seed({ rooms, guests, bookings }) {
  return {
    WS_Properties: [{ id: 'recP1', fields: { 'Property Name': 'Canary Street Guest Rooms', 'Phone Number ID': '111000111000', 'Notify Phone': NOTIFY } }],
    WS_Rooms: rooms.map(([id, name, number, status]) => ({ id, fields: { 'Room Name': name, 'Room Number': number, 'Status': status, 'Property': ['recP1'], 'Active': true } })),
    WS_Roles: [{ id: 'recRole1', fields: { 'Role Label': 'Reception', 'Role Type': 'Reception', 'Property': ['recP1'], 'Current Phone': RECEPTION, 'Active': true } }],
    WS_Cleaners: [{ id: 'recCl1', fields: { 'Cleaner Name': 'Jill', 'Phone Number': CLEANER, 'Active': true, 'Property': ['recP1'] } }],
    WS_Rates: [], WS_Enquiries: [], WS_Guests: guests, WS_Bookings: bookings
  };
}
async function run(opts, steps, { flag = '1', failGuests = false } = {}) {
  const set = (k, v) => { if (v === null) delete process.env[k]; else process.env[k] = v; };
  set('WABISTAY_PAY_ASSIGNS_ROOM', flag);
  set('WABISTAY_PAID_ROOM_CONFIRMED', '1');
  set('WABISTAY_GATE_ROOM_CHECK', null);
  const ctx = { airtable: new MockAirtable(seed(opts)), sends: [], axiom: [] };
  installFetch(ctx);
  if (failGuests) {
    const inner = global.fetch;
    global.fetch = async (url, o = {}) => {
      if (String(url).includes('graph.facebook.com') && [GUEST_A, GUEST_B].includes(JSON.parse(o.body).to)) {
        return { status: 400, json: async () => ({ error: { code: 131047, message: 'Re-engagement message' } }) };
      }
      return inner(url, o);
    };
  }
  for (const [from, text] of steps) await wh({ method: 'POST', body: metaTextPayload(from, text) }, makeRes());
  return ctx;
}
const to = (ctx, who) => ctx.sends.filter(s => s.to === who && s.type === 'text').map(s => s.body);
const bk = (ctx, id) => ctx.airtable.tables['WS_Bookings'].find(b => b.id === id).fields;
const rm = (ctx, id) => ctx.airtable.tables['WS_Rooms'].find(r => r.id === id).fields;
const gs = (ctx, id) => ctx.airtable.tables['WS_Guests'].find(g => g.id === id).fields;

const oneRoom = (status = 'Cleaning') => [['recR1', 'Room 01', 1, status]];
const tapSteps = [[GUEST_A, '1']];

// ── the new texts ────────────────────────────────────────────────────────────

test('flag on: the unpaid tap says reception will message the guest when they are checked in', async () => {
  const ctx = await run({ rooms: oneRoom('Available'), guests: [guest('recG1', GUEST_A, 'Mama Test')], bookings: [booking('recB1', 'recG1', 'recR1', { 'Gate Tap At': undefined })] }, tapSteps);
  assert.strictEqual(to(ctx, GUEST_A)[0], UNPAID_NEW);
});

test('flag on: PAID after the tap checks the guest in with the new welcome (room Available)', async () => {
  const ctx = await run({ rooms: oneRoom('Available'), guests: [guest('recG1', GUEST_A, 'Mama Test')], bookings: [booking('recB1', 'recG1', 'recR1', { 'Gate Tap At': undefined })] },
    [[GUEST_A, '1'], [RECEPTION, 'PAID ROOM 1 250 card']]);
  assert.deepStrictEqual(to(ctx, GUEST_A), [UNPAID_NEW, welcomeNew('Room 01')]);
  assert.strictEqual(bk(ctx, 'recB1')['Status'], 'Checked In');
});

// ── DONE after room-not-ready ────────────────────────────────────────────────

test('PAID while the room is Cleaning: the guest is told to wait; the cleaner\'s DONE then checks them in, once', async () => {
  const ctx = await run({ rooms: oneRoom('Cleaning'), guests: [guest('recG1', GUEST_A, 'Mama Test')], bookings: [booking('recB1', 'recG1', 'recR1', { 'Gate Tap At': undefined })] },
    [[GUEST_A, '1'], [RECEPTION, 'PAID ROOM 1 250 card']]);
  assert.match(to(ctx, GUEST_A)[1], NOT_READY);
  assert.strictEqual(bk(ctx, 'recB1')['Status'], 'Confirmed');
  assert.strictEqual(gs(ctx, 'recG1')['Session State'], 'CONFIRMED');
  await wh({ method: 'POST', body: metaTextPayload(CLEANER, 'done') }, makeRes());
  assert.strictEqual(to(ctx, GUEST_A).slice(-1)[0], welcomeNew('Room 01'));
  assert.strictEqual(bk(ctx, 'recB1')['Status'], 'Checked In');
  assert.strictEqual(rm(ctx, 'recR1')['Status'], 'Occupied');
  assert.strictEqual(gs(ctx, 'recG1')['Session State'], 'CHECKED_IN');
  assert.ok(to(ctx, NOTIFY).includes('Mama Test was waiting at the gate. Checked in and sent their room: Room 01.'), 'the owner gets the one-line outcome');
  assert.deepStrictEqual(to(ctx, CLEANER), ['Thank you! Room 01 is marked as clean and available. ✅'], 'the cleaner only gets her thanks');
  await wh({ method: 'POST', body: metaTextPayload(CLEANER, 'done') }, makeRes());
  assert.strictEqual(to(ctx, GUEST_A).filter(t => /^Welcome to/.test(t)).length, 1, 'welcome sent once');
});

test('a paid guest who has NOT tapped the gate gets nothing from DONE; their later tap goes straight to the welcome', async () => {
  const ctx = await run({ rooms: oneRoom('Cleaning'), guests: [guest('recG1', GUEST_A, 'Mama Test')],
    bookings: [booking('recB1', 'recG1', 'recR1', { 'Payment Status': 'Paid', 'Amount Paid': 250, 'Gate Tap At': undefined })] }, [[CLEANER, 'done']]);
  assert.deepStrictEqual(to(ctx, GUEST_A), []);
  assert.strictEqual(bk(ctx, 'recB1')['Status'], 'Confirmed');
  assert.strictEqual(rm(ctx, 'recR1')['Status'], 'Available');
  await wh({ method: 'POST', body: metaTextPayload(GUEST_A, '1') }, makeRes());
  assert.deepStrictEqual(to(ctx, GUEST_A), [welcomeNew('Room 01')]);
});

test('an UNPAID guest who tapped is never checked in by DONE (reception is the only way payment is recorded)', async () => {
  const ctx = await run({ rooms: oneRoom('Cleaning'), guests: [guest('recG1', GUEST_A, 'Mama Test')], bookings: [booking('recB1', 'recG1', 'recR1')] }, [[CLEANER, 'done']]);
  assert.deepStrictEqual(to(ctx, GUEST_A), []);
  assert.strictEqual(bk(ctx, 'recB1')['Status'], 'Confirmed');
  assert.strictEqual(rm(ctx, 'recR1')['Status'], 'Available');
});

test('a paid guest who is no longer in CONFIRMED is skipped', async () => {
  const ctx = await run({ rooms: oneRoom('Cleaning'), guests: [guest('recG1', GUEST_A, 'Mama Test', { 'Session State': 'NEW' })],
    bookings: [booking('recB1', 'recG1', 'recR1', { 'Payment Status': 'Paid', 'Amount Paid': 250 })] }, [[CLEANER, 'done']]);
  assert.deepStrictEqual(to(ctx, GUEST_A), []);
  assert.strictEqual(bk(ctx, 'recB1')['Status'], 'Confirmed');
});

// ── two guests waiting ───────────────────────────────────────────────────────

const paidTap = (id, g, r, tapMin) => booking(id, g, r, { 'Payment Status': 'Paid', 'Amount Paid': 250, 'Gate Tap At': ago(tapMin) });

test('two guests waiting on different rooms: DONE on Room 02 checks in only the guest holding Room 02', async () => {
  const ctx = await run({
    rooms: [['recR1', 'Room 01', 1, 'Cleaning'], ['recR2', 'Room 02', 2, 'Cleaning']],
    guests: [guest('recG1', GUEST_A, 'Mama Test'), guest('recG2', GUEST_B, 'Robson Tembo')],
    bookings: [paidTap('recBookAAAAA1', 'recG1', 'recR1', 20), paidTap('recBookBBBBB2', 'recG2', 'recR2', 10)]
  }, [[CLEANER, 'done'], [CLEANER, 'Room 02']]);
  assert.match(to(ctx, CLEANER)[0], /Which room\?/);
  assert.deepStrictEqual(to(ctx, GUEST_B), [welcomeNew('Room 02')]);
  assert.deepStrictEqual(to(ctx, GUEST_A), [], 'the guest on Room 01 is untouched');
  assert.strictEqual(bk(ctx, 'recBookBBBBB2')['Status'], 'Checked In');
  assert.strictEqual(bk(ctx, 'recBookAAAAA1')['Status'], 'Confirmed');
  await wh({ method: 'POST', body: metaTextPayload(CLEANER, 'done') }, makeRes());
  assert.deepStrictEqual(to(ctx, GUEST_A), [welcomeNew('Room 01')], 'and is checked in when their own room is done');
});

test('two bookings holding the same room: the earliest gate tap is checked in, the other stays waiting', async () => {
  const ctx = await run({
    rooms: oneRoom('Cleaning'), guests: [guest('recG1', GUEST_A, 'Mama Test'), guest('recG2', GUEST_B, 'Robson Tembo')],
    bookings: [
      paidTap('recBookLATE001', 'recG2', 'recR1', 3),
      paidTap('recBookEARLY01', 'recG1', 'recR1', 15)
    ].map(b => (b.id === 'recBookLATE001'
      ? { ...b, fields: { ...b.fields, 'Check In': iso(Date.now() + 60 * MIN), 'Check Out': iso(Date.now() + 180 * MIN) } }   // a later slot on the same room
      : { ...b, fields: { ...b.fields, 'Check Out': iso(Date.now() + 30 * MIN) } }))
  }, [[CLEANER, 'done']]);
  assert.deepStrictEqual(to(ctx, GUEST_A), [welcomeNew('Room 01')]);
  assert.deepStrictEqual(to(ctx, GUEST_B), []);
  assert.strictEqual(bk(ctx, 'recBookEARLY01')['Status'], 'Checked In');
  assert.strictEqual(bk(ctx, 'recBookLATE001')['Status'], 'Confirmed');
});

// ── window closed: fails soft with an alert ──────────────────────────────────

test('the guest message cannot be sent (24-hour window closed): the check-in stands and the owner is told to pass the room on', async () => {
  const ctx = await run({ rooms: oneRoom('Cleaning'), guests: [guest('recG1', GUEST_A, 'Mama Test')], bookings: [paidTap('recBook0000A1', 'recG1', 'recR1', 5)] },
    [[CLEANER, 'done']], { failGuests: true });
  assert.strictEqual(bk(ctx, 'recBook0000A1')['Status'], 'Checked In');
  assert.ok(to(ctx, NOTIFY).includes('Mama Test is checked in to Room 01, but I could not message them (the 24-hour window may be closed). Please tell them their room.'), to(ctx, NOTIFY).join('\n'));
  assert.deepStrictEqual(to(ctx, CLEANER), ['Thank you! Room 01 is marked as clean and available. ✅']);
});

// ── test phones, flag off ────────────────────────────────────────────────────

test('a test phone behaves like any guest through DONE', async () => {
  const ctx = await run({ rooms: oneRoom('Cleaning'), guests: [guest('recG1', GUEST_A, 'Mama Test', { 'Test Phone': true })], bookings: [paidTap('recBook0000A1', 'recG1', 'recR1', 5)] }, [[CLEANER, 'done']]);
  assert.deepStrictEqual(to(ctx, GUEST_A), [welcomeNew('Room 01')]);
  assert.strictEqual(bk(ctx, 'recBook0000A1')['Status'], 'Checked In');
});

test('flag off reproduces today: DONE tells no guest anything, the old unpaid text and the old welcome are used', async () => {
  const waiting = await run({ rooms: oneRoom('Cleaning'), guests: [guest('recG1', GUEST_A, 'Mama Test')], bookings: [paidTap('recBook0000A1', 'recG1', 'recR1', 5)] }, [[CLEANER, 'done']], { flag: null });
  assert.deepStrictEqual(to(waiting, GUEST_A), []);
  assert.strictEqual(bk(waiting, 'recBook0000A1')['Status'], 'Confirmed');
  assert.strictEqual(rm(waiting, 'recR1')['Status'], 'Available');
  assert.deepStrictEqual(to(waiting, NOTIFY).filter(t => /waiting at the gate/.test(t)), []);
  await wh({ method: 'POST', body: metaTextPayload(GUEST_A, '1') }, makeRes());
  assert.deepStrictEqual(to(waiting, GUEST_A), [welcomeOld('Room 01')], 'the manual second tap, as today');
  const unpaid = await run({ rooms: oneRoom('Available'), guests: [guest('recG1', GUEST_A, 'Mama Test')], bookings: [booking('recB1', 'recG1', 'recR1', { 'Gate Tap At': undefined })] }, tapSteps, { flag: null });
  assert.strictEqual(to(unpaid, GUEST_A)[0], UNPAID_OLD);
});

test('the flag stays on the cold-start list', () => {
  delete process.env.WABISTAY_PAY_ASSIGNS_ROOM;
  assert.strictEqual(wh.wabistayFlagState()['WABISTAY_PAY_ASSIGNS_ROOM'], 'off');
});
