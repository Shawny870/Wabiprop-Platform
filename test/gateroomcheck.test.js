// test/gateroomcheck.test.js
// WABISTAY_GATE_ROOM_CHECK (1 or true; off by default). A guest who may be let in taps
// the gate button, and the room they would be given is not Available (Cleaning /
// Occupied). Flag off: today — it is assigned and set Occupied anyway. Flag on: nothing
// is assigned or written, the guest is told to wait at the office (not outside),
// reception is alerted (template + owner copy) with the room's real status, and a later
// tap re-checks from scratch.
// In-memory only: MockAirtable + mocked fetch.

const { test, afterEach } = require('node:test');
const assert = require('node:assert');
const { installEnv, installFetch, makeRes, metaTextPayload, MockAirtable } = require('./harness');

installEnv();
const wh = require('../api/wabistay/webhook.js');

const GUEST = '27784896186';
const NOTIFY = '27831112222';
const RECEPTION = '27825999279';
const CLEANER = '27820000111';
const TEMPLATE = 'wabistay_gate_arrival';
const WAIT = /wait at the office, not outside/;

afterEach(() => {
  for (const k of ['WABISTAY_GATE_ROOM_CHECK', 'WABISTAY_GATE_ARRIVAL_TEMPLATE', 'WABISTAY_GATE_ALERT_UNPAID']) delete process.env[k];
});

const minsAgo = m => new Date(Date.now() - m * 60000).toISOString();
const minsAhead = m => new Date(Date.now() + m * 60000).toISOString();
const room = (id, name, status, extra = {}) => ({ id, fields: { 'Room Name': name, 'Room Number': Number(name.slice(-1)), 'Status': status, 'Property': ['recP1'], 'Active': true, ...extra } });

function seed({ rooms = [room('recR1', 'Room 1', 'Cleaning')], booking = {}, bookings = [], roles, cleaners = [] } = {}) {
  return {
    WS_Properties: [{ id: 'recP1', fields: { 'Property Name': 'Canary Street Guest Rooms', 'Phone Number ID': '111000111000', 'Notify Phone': NOTIFY } }],
    WS_Rooms: rooms,
    WS_Roles: roles || [{ id: 'recRecep', fields: { 'Role Label': 'Reception', 'Role Type': 'Reception', 'Property': ['recP1'], 'Current Phone': RECEPTION, 'Active': true } }],
    WS_Guests: [{ id: 'recG1', fields: { 'Guest Name': 'Mama Test', 'Phone Number': GUEST, 'Session State': 'CONFIRMED' } }],
    WS_Bookings: [{ id: 'recBook1', fields: {
      'Guest': ['recG1'], 'Room': ['recR1'], 'Status': 'Confirmed', 'Booking Type': 'Overnight', 'Booking Ref': 'WS-KEGGQF',
      'Amount Due': 250, 'Payment Status': 'Paid', 'Check In': '2020-01-01T12:00:00.000Z', 'Check Out': '2099-01-01T08:00:00.000Z', ...booking
    } }, ...bookings],
    WS_Cleaners: cleaners, WS_Rates: [], WS_Enquiries: []
  };
}

function start(opts) {
  const ctx = { airtable: new MockAirtable(seed(opts)), sends: [], axiom: [] };
  installFetch(ctx);
  return ctx;
}
async function say(from, text) {
  const res = makeRes();
  await wh({ method: 'POST', body: metaTextPayload(from, text) }, res);
  return res;
}
const tap = () => say(GUEST, '1');
function on() { process.env.WABISTAY_GATE_ROOM_CHECK = '1'; process.env.WABISTAY_GATE_ARRIVAL_TEMPLATE = TEMPLATE; }

const roomRow = (ctx, id = 'recR1') => ctx.airtable.tables['WS_Rooms'].find(r => r.id === id).fields;
const bookingRow = (ctx, id = 'recBook1') => ctx.airtable.tables['WS_Bookings'].find(b => b.id === id).fields;
const guestRow = ctx => ctx.airtable.tables['WS_Guests'][0].fields;
const texts = (ctx, to) => ctx.sends.filter(s => s.type === 'text' && s.to === to).map(s => s.body);
const templates = ctx => ctx.sends.filter(s => s.type === 'template');
const events = (ctx, n) => ctx.axiom.filter(e => e.event === n);
const writes = ctx => ctx.airtable.log.filter(w => (w.op === 'update' || w.op === 'create') && w.table !== 'WS_Properties');

// ── flag off: today ──────────────────────────────────────────────────────────

test('flag off: a held room that is Cleaning is still assigned and set Occupied (today\'s behaviour, pinned)', async () => {
  process.env.WABISTAY_GATE_ARRIVAL_TEMPLATE = TEMPLATE;
  const ctx = start();
  await tap();
  assert.strictEqual(bookingRow(ctx)['Status'], 'Checked In');
  assert.strictEqual(roomRow(ctx)['Status'], 'Occupied');
  assert.ok(texts(ctx, GUEST).some(t => /Your room is \*Room 1\*/.test(t)));
  assert.strictEqual(events(ctx, 'gate_room_not_ready').length, 0);
});

// ── flag on: the room is not ready ───────────────────────────────────────────

for (const status of ['Cleaning', 'Occupied']) {
  test(`flag on, paid, held room is ${status}: guest told to wait at the office; reception alerted with the real status; nothing written`, async () => {
    on();
    const ctx = start({ rooms: [room('recR1', 'Room 1', status)] });
    await tap();

    const toGuest = texts(ctx, GUEST);
    assert.strictEqual(toGuest.length, 1);
    assert.match(toGuest[0], WAIT);
    assert.ok(!/Welcome/.test(toGuest[0]));

    const t = templates(ctx);
    assert.strictEqual(t.length, 1);
    assert.strictEqual(t[0].to, RECEPTION);
    assert.strictEqual(t[0].template, TEMPLATE);
    assert.deepStrictEqual(t[0].params, ['Canary Street Guest Rooms', 'Mama Test', 'Room 1', status, GUEST]);

    const owner = texts(ctx, NOTIFY);
    assert.strictEqual(owner.length, 1);
    assert.match(owner[0], new RegExp(`Room 1 is ${status}`));
    assert.match(owner[0], /WS-KEGGQF/);
    assert.match(owner[0], /wait at the office, not outside/);

    assert.strictEqual(roomRow(ctx)['Status'], status, 'room untouched');
    assert.strictEqual(bookingRow(ctx)['Status'], 'Confirmed', 'booking untouched');
    assert.deepStrictEqual(bookingRow(ctx)['Room'], ['recR1']);
    assert.strictEqual(bookingRow(ctx)['Checked In At'], undefined);
    assert.strictEqual(guestRow(ctx)['Session State'], 'CONFIRMED');
    assert.deepStrictEqual(writes(ctx), [], 'no writes at all (bar the property activity stamp)');
    assert.strictEqual(events(ctx, 'gate_room_not_ready').length, 1);
    assert.strictEqual(events(ctx, 'gate_room_not_ready')[0].roomStatus, status);
  });
}

test('flag on, held room is Available: normal check-in, unchanged', async () => {
  on();
  const ctx = start({ rooms: [room('recR1', 'Room 1', 'Available')] });
  await tap();
  assert.strictEqual(bookingRow(ctx)['Status'], 'Checked In');
  assert.strictEqual(roomRow(ctx)['Status'], 'Occupied');
  assert.ok(texts(ctx, GUEST).some(t => /Your room is \*Room 1\*/.test(t)));
  assert.strictEqual(events(ctx, 'gate_room_not_ready').length, 0);
});

test('flag on, held room is Cleaning and the property has no Notify Phone: reception template still goes, no owner copy', async () => {
  on();
  const ctx = start();
  ctx.airtable.tables['WS_Properties'][0].fields['Notify Phone'] = undefined;
  delete ctx.airtable.tables['WS_Properties'][0].fields['Notify Phone'];
  await tap();
  assert.match(texts(ctx, GUEST)[0], WAIT);
  assert.strictEqual(templates(ctx).length, 1);
});

test('Reception seat and Notify Phone are the same number: both messages still go', async () => {
  on();
  const ctx = start({ roles: [{ id: 'recRecep', fields: { 'Role Label': 'Reception', 'Role Type': 'Reception', 'Property': ['recP1'], 'Current Phone': NOTIFY, 'Active': true } }] });
  await tap();
  assert.strictEqual(templates(ctx).filter(s => s.to === NOTIFY).length, 1);
  assert.strictEqual(texts(ctx, NOTIFY).length, 1);
});

// ── later taps re-check ──────────────────────────────────────────────────────

test('a later tap re-checks: while the room is still Cleaning every tap waits and re-alerts; once it is Available the tap checks the guest in', async () => {
  on();
  const ctx = start();
  await tap();
  await tap();
  assert.strictEqual(events(ctx, 'gate_room_not_ready').length, 2, 'no quiet period: each tap re-alerts');
  assert.strictEqual(roomRow(ctx)['Status'], 'Cleaning');

  ctx.airtable.tables['WS_Rooms'][0].fields['Status'] = 'Available';
  await tap();
  assert.strictEqual(bookingRow(ctx)['Status'], 'Checked In');
  assert.strictEqual(roomRow(ctx)['Status'], 'Occupied');
  assert.ok(texts(ctx, GUEST).some(t => /Your room is \*Room 1\*/.test(t)));
});

// ── the hourly turnover case ─────────────────────────────────────────────────

test('hourly turnover: last stay checked out 5 minutes ago, room Cleaning, new hourly guest taps -> waits; the cleaner\'s DONE frees the room and stamps the PREVIOUS stay; the next tap checks in', async () => {
  on();
  const ctx = start({
    cleaners: [{ id: 'recC1', fields: { 'Cleaner Name': 'Jill', 'Phone Number': CLEANER, 'Active': true, 'Assigned Property': ['recP1'] } }],
    rooms: [room('recR1', 'Room 1', 'Cleaning', { 'Cleaning Started At': minsAgo(5) })],
    booking: { 'Booking Type': 'Hourly', 'Check In': minsAgo(1), 'Check Out': minsAhead(119), 'Amount Due': 250, 'Payment Status': 'Paid' },
    bookings: [{ id: 'recPrev1', fields: {
      'Guest': ['recGprev'], 'Room': ['recR1'], 'Status': 'Checked Out', 'Booking Type': 'Hourly', 'Booking Ref': 'WS-PREV01',
      'Check In': minsAgo(125), 'Check Out': minsAgo(5), 'Amount Due': 250, 'Payment Status': 'Paid'
    } }]
  });

  await tap();
  assert.match(texts(ctx, GUEST)[0], WAIT);
  assert.strictEqual(roomRow(ctx)['Status'], 'Cleaning');
  assert.strictEqual(bookingRow(ctx)['Status'], 'Confirmed');

  await say(CLEANER, 'done');
  assert.strictEqual(roomRow(ctx)['Status'], 'Available');
  assert.ok(bookingRow(ctx, 'recPrev1')['Cleaning Completed At'], 'DONE is recorded against the stay that just ended');
  assert.strictEqual(bookingRow(ctx)['Cleaning Completed At'], undefined, 'not against the waiting guest\'s booking');

  await tap();
  assert.strictEqual(bookingRow(ctx)['Status'], 'Checked In');
  assert.strictEqual(roomRow(ctx)['Status'], 'Occupied');
  assert.ok(texts(ctx, GUEST).some(t => /Your room is \*Room 1\*/.test(t)));
});

test('flag off, same turnover: the guest is put into the Cleaning room and DONE then has nothing to clean (the gap this flag closes)', async () => {
  process.env.WABISTAY_GATE_ARRIVAL_TEMPLATE = TEMPLATE;
  const ctx = start({
    cleaners: [{ id: 'recC1', fields: { 'Cleaner Name': 'Jill', 'Phone Number': CLEANER, 'Active': true, 'Assigned Property': ['recP1'] } }],
    rooms: [room('recR1', 'Room 1', 'Cleaning')]
  });
  await tap();
  assert.strictEqual(roomRow(ctx)['Status'], 'Occupied');
  await say(CLEANER, 'done');
  assert.ok(texts(ctx, CLEANER).some(t => /No rooms currently marked for cleaning/.test(t)));
});

// ── reassignment and the legacy fallback ─────────────────────────────────────

test('held room taken before arrival -> findAvailableRoom reassigns; the reassigned room is checked too (Cleaning waits, Available is assigned)', async () => {
  on();
  const blocker = { id: 'recOther', fields: { 'Guest': ['recGx'], 'Room': ['recR1'], 'Status': 'Checked In', 'Check In': '2019-01-01T12:00:00.000Z', 'Check Out': '2099-06-01T08:00:00.000Z' } };

  const cleaning = start({ rooms: [room('recR1', 'Room 1', 'Occupied'), room('recR2', 'Room 2', 'Cleaning')], bookings: [blocker] });
  await tap();
  assert.match(texts(cleaning, GUEST)[0], WAIT);
  assert.strictEqual(events(cleaning, 'gate_room_not_ready')[0].roomName, 'Room 2');
  assert.strictEqual(roomRow(cleaning, 'recR2')['Status'], 'Cleaning');
  assert.strictEqual(bookingRow(cleaning)['Status'], 'Confirmed');

  const free = start({ rooms: [room('recR1', 'Room 1', 'Occupied'), room('recR2', 'Room 2', 'Available')], bookings: [blocker] });
  await tap();
  assert.strictEqual(bookingRow(free)['Status'], 'Checked In');
  assert.deepStrictEqual(bookingRow(free)['Room'], ['recR2']);
  assert.strictEqual(roomRow(free, 'recR2')['Status'], 'Occupied');
});

test('legacy no-dates fallback only ever offers Available rooms, so the check never fires: with only a Cleaning room the guest is unassigned, exactly as before', async () => {
  on();
  const ctx = start({ booking: { 'Check In': undefined, 'Check Out': undefined } });
  delete ctx.airtable.tables['WS_Bookings'][0].fields['Check In'];
  delete ctx.airtable.tables['WS_Bookings'][0].fields['Check Out'];
  await tap();
  assert.strictEqual(events(ctx, 'gate_room_not_ready').length, 0);
  assert.strictEqual(roomRow(ctx)['Status'], 'Cleaning');
  assert.ok(texts(ctx, GUEST).some(t => /notified someone to assist you at the gate/.test(t)));
});

// ── ordering with the payment gate, and failure ──────────────────────────────

test('unpaid guest with a Cleaning room: the payment gate answers first, exactly as before — not the room check', async () => {
  on();
  const ctx = start({ booking: { 'Payment Status': 'Unpaid' } });
  await tap();
  assert.match(texts(ctx, GUEST)[0], /Pop into the office to sort payment/);
  assert.strictEqual(events(ctx, 'gate_room_not_ready').length, 0);
});

test('a rejected reception template never costs the guest their answer, and nothing is assigned', async () => {
  on();
  const ctx = start();
  const inner = global.fetch;
  global.fetch = async (url, init = {}) => {
    if (String(url).includes('graph.facebook.com') && init.body && JSON.parse(init.body).type === 'template') {
      return { status: 404, ok: false, json: async () => ({ error: { message: 'no such template', code: 132001 } }), text: async () => '' };
    }
    return inner(url, init);
  };
  await tap();
  assert.match(texts(ctx, GUEST)[0], WAIT);
  assert.strictEqual(roomRow(ctx)['Status'], 'Cleaning');
  assert.strictEqual(texts(ctx, NOTIFY).length, 1, 'the owner copy still goes');
});

// ── the flag ─────────────────────────────────────────────────────────────────

test('flag state: on the cold-start list, off by default, on only for 1/true', () => {
  const fresh = () => { delete require.cache[require.resolve('../api/wabistay/webhook.js')]; return require('../api/wabistay/webhook.js'); };
  delete process.env.WABISTAY_GATE_ROOM_CHECK;
  assert.strictEqual(fresh().wabistayFlagState().WABISTAY_GATE_ROOM_CHECK, 'off');
  for (const [v, exp] of [['1', 'on'], ['true', 'on'], ['TRUE', 'on'], ['yes', 'off'], ['0', 'off']]) {
    process.env.WABISTAY_GATE_ROOM_CHECK = v;
    assert.strictEqual(fresh().wabistayFlagState().WABISTAY_GATE_ROOM_CHECK, exp, v);
  }
});
