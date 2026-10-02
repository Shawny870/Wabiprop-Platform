// test/gatealertunpaid.test.js
// Unpaid gate-arrival alert. A guest who taps "I'm at the gate" on a priced booking
// whose payment is not confirmed is told to go to the office; with
// WABISTAY_GATE_ALERT_UNPAID on, the office is told too: Reception seats (the
// WABISTAY_GATE_ARRIVAL_TEMPLATE template) and Notify Phone (free-form copy). Repeat
// taps are suppressed for 10 minutes via WS_Bookings 'Gate Alert Sent At', written
// only after an alert actually went out. A paid tap always alerts.
// In-memory only: MockAirtable + mocked fetch.

const { test, afterEach } = require('node:test');
const assert = require('node:assert');
const { installEnv, installFetch, makeRes, metaTextPayload, MockAirtable } = require('./harness');

installEnv();
const wh = require('../api/wabistay/webhook.js');

const GUEST_PHONE = '27821234567';
const NOTIFY_PHONE = '27831112222';
const RECEPTION_PHONE = '27825999279';
const TEMPLATE = 'wabistay_gate_arrival';
const REPLY = /Almost there! Pop into the office/;

afterEach(() => {
  delete process.env.WABISTAY_GATE_ALERT_UNPAID;
  delete process.env.WABISTAY_GATE_ARRIVAL_TEMPLATE;
});

const minsAgoIso = m => new Date(Date.now() - m * 60000).toISOString();

function seed({ booking = {}, rooms, roles, propertyFields = {}, guestPhone = GUEST_PHONE } = {}) {
  return {
    WS_Properties: [{ id: 'recP1', fields: { 'Property Name': 'Canary Street Guest Rooms', 'Phone Number ID': '111000111000', 'Notify Phone': NOTIFY_PHONE, ...propertyFields } }],
    WS_Rooms: rooms || [{ id: 'recR1', fields: { 'Room Name': 'Room 01', 'Room Number': 1, 'Status': 'Cleaning', 'Property': ['recP1'], 'Active': true } }],
    WS_Roles: roles || [{ id: 'recRecep', fields: { 'Role Label': 'Reception', 'Role Type': 'Reception', 'Property': ['recP1'], 'Current Phone': RECEPTION_PHONE, 'Active': true } }],
    WS_Guests: [{ id: 'recG1', fields: { 'Guest Name': 'Jane Doe', 'Phone Number': guestPhone, 'Session State': 'CONFIRMED' } }],
    WS_Bookings: [{
      id: 'reczpYalJShDpEKV0', fields: {
        'Guest': ['recG1'], 'Status': 'Confirmed', 'Booking Type': 'Overnight', 'Booking Ref': 'WS-ABC123',
        'Amount Due': 250, 'Payment Status': 'Unpaid',
        'Check In': '2020-01-01T12:00:00.000Z', 'Check Out': '2099-01-01T08:00:00.000Z',
        ...booking
      }
    }],
    WS_Cleaners: [], WS_Enquiries: []
  };
}

function start(opts = {}) {
  const ctx = { airtable: new MockAirtable(seed(opts)), sends: [], axiom: [] };
  installFetch(ctx);
  return ctx;
}

async function tap(phone = GUEST_PHONE) {
  const res = makeRes();
  await wh({ method: 'POST', body: metaTextPayload(phone, '1') }, res);
  return res;
}

const bookingRow = ctx => ctx.airtable.tables['WS_Bookings'].find(b => b.id === 'reczpYalJShDpEKV0');
const roomRow = ctx => ctx.airtable.tables['WS_Rooms'][0];
const guestRow = ctx => ctx.airtable.tables['WS_Guests'][0];
const templateSends = ctx => ctx.sends.filter(s => s.type === 'template');
const textsTo = (ctx, to) => ctx.sends.filter(s => s.type === 'text' && s.to === to).map(s => s.body);
const events = (ctx, name) => ctx.axiom.filter(e => e.event === name);

const OWNER_COPY = 'A guest has arrived at the gate and has not paid yet. Name: Jane Doe. Phone: 27821234567. Booking: WS-ABC123. Amount due: R250. No room has been assigned. Please take payment at reception first.';

function on() {
  process.env.WABISTAY_GATE_ALERT_UNPAID = '1';
  process.env.WABISTAY_GATE_ARRIVAL_TEMPLATE = TEMPLATE;
}

// ── the alert itself ─────────────────────────────────────────────────────────

test('flag ON, unpaid, booking holds a room: Reception gets the template with the room\'s real name and status; owner copy goes to Notify Phone; the guest still gets the office reply', async () => {
  on();
  const ctx = start({ booking: { Room: ['recR1'] } });
  await tap();

  assert.match(textsTo(ctx, GUEST_PHONE).join('\n'), REPLY);
  const t = templateSends(ctx);
  assert.strictEqual(t.length, 1);
  assert.strictEqual(t[0].to, RECEPTION_PHONE);
  assert.strictEqual(t[0].template, TEMPLATE);
  assert.deepStrictEqual(t[0].params, ['Canary Street Guest Rooms', 'Jane Doe', 'Room 01', 'Cleaning', GUEST_PHONE]);
  assert.deepStrictEqual(textsTo(ctx, NOTIFY_PHONE), [OWNER_COPY]);
});

test('flag ON, unpaid, no room held: room = "not assigned yet", status = "payment not confirmed"', async () => {
  on();
  const ctx = start();
  await tap();
  assert.deepStrictEqual(templateSends(ctx)[0].params, ['Canary Street Guest Rooms', 'Jane Doe', 'not assigned yet', 'payment not confirmed', GUEST_PHONE]);
});

test('the guest reply comes first, and nothing is written to the guest, the room or the booking status', async () => {
  on();
  const ctx = start({ booking: { Room: ['recR1'] } });
  await tap();

  assert.match(ctx.sends[0].body, REPLY, 'the guest\'s answer is the first send');
  assert.strictEqual(guestRow(ctx).fields['Session State'], 'CONFIRMED');
  assert.strictEqual(roomRow(ctx).fields['Status'], 'Cleaning');
  assert.strictEqual(bookingRow(ctx).fields['Status'], 'Confirmed');
  // (Property activity tracking writes WS_Properties on every inbound message; unrelated to this alert.)
  const writes = ctx.airtable.log.filter(w => w.op === 'update' && w.table !== 'WS_Properties');
  assert.deepStrictEqual(writes.map(w => Object.keys(w.fields)), [['Gate Alert Sent At']], 'the stamp is the only write');
});

test('cleaners are not told: no room is assigned yet', async () => {
  on();
  const ctx = start();
  ctx.airtable.tables['WS_Cleaners'].push({ id: 'recC1', fields: { 'Cleaner Name': 'Thandi', 'Phone Number': '27820000111', 'Active': true, 'Assigned Property': ['recP1'] } });
  await tap();
  assert.ok(!ctx.sends.some(s => s.to === '27820000111'));
});

test('flag OFF (unset): today\'s behaviour — the unpaid tap alerts nobody and writes nothing', async () => {
  process.env.WABISTAY_GATE_ARRIVAL_TEMPLATE = TEMPLATE;
  const ctx = start();
  await tap();
  assert.strictEqual(ctx.sends.length, 1);
  assert.match(ctx.sends[0].body, REPLY);
  assert.deepStrictEqual(ctx.airtable.log.filter(w => w.table !== 'WS_Properties'), [], 'no writes (bar the unrelated property activity stamp)');
});

// ── repeat taps ──────────────────────────────────────────────────────────────

test('a second tap inside 10 minutes is suppressed (guest still answered); the stamp is the first alert\'s', async () => {
  on();
  const ctx = start();
  await tap();
  const firstStamp = bookingRow(ctx).fields['Gate Alert Sent At'];
  assert.ok(firstStamp);

  await tap();
  assert.strictEqual(templateSends(ctx).length, 1, 'no second template');
  assert.strictEqual(textsTo(ctx, NOTIFY_PHONE).length, 1, 'no second owner copy');
  assert.strictEqual(textsTo(ctx, GUEST_PHONE).filter(t => REPLY.test(t)).length, 2, 'the guest gets their reply both times');
  assert.strictEqual(bookingRow(ctx).fields['Gate Alert Sent At'], firstStamp);
  assert.strictEqual(events(ctx, 'gate_alert_unpaid_suppressed').length, 1);
});

test('suppression window: a stamp 9 minutes old suppresses, one 11 minutes old does not', async () => {
  on();
  let ctx = start({ booking: { 'Gate Alert Sent At': minsAgoIso(9) } });
  await tap();
  assert.strictEqual(templateSends(ctx).length, 0, '9 minutes: still quiet');

  ctx = start({ booking: { 'Gate Alert Sent At': minsAgoIso(11) } });
  await tap();
  assert.strictEqual(templateSends(ctx).length, 1, '11 minutes: alerts again');
  assert.ok(Date.now() - Date.parse(bookingRow(ctx).fields['Gate Alert Sent At']) < 60000, 'and the stamp is renewed');
});

test('a paid tap always alerts, even inside the quiet period, and takes the normal path', async () => {
  on();
  const ctx = start({ booking: { 'Payment Status': 'Paid', 'Gate Alert Sent At': minsAgoIso(1), Room: ['recR1'] }, rooms: [{ id: 'recR1', fields: { 'Room Name': 'Room 01', 'Room Number': 1, 'Status': 'Available', 'Property': ['recP1'], 'Active': true } }] });
  await tap();

  assert.strictEqual(bookingRow(ctx).fields['Status'], 'Checked In');
  const t = templateSends(ctx);
  assert.strictEqual(t.length, 1, 'the normal gate-arrival template');
  assert.deepStrictEqual(t[0].params, ['Canary Street Guest Rooms', 'Jane Doe', 'Room 01', 'Available', GUEST_PHONE]);
  assert.ok(!ctx.sends.some(s => /has not paid yet/.test(s.body || '')), 'not the unpaid owner copy');
});

// ── failures ─────────────────────────────────────────────────────────────────

test('the Gate Alert Sent At write fails: the alert has already gone, the failure is logged, and nothing blocks the guest', async () => {
  on();
  const ctx = start();
  const inner = global.fetch;
  global.fetch = async (url, init = {}) => {
    if (String(url).includes('WS_Bookings') && (init.method || '').toUpperCase() === 'PATCH' && 'Gate Alert Sent At' in JSON.parse(init.body).fields) {
      return { status: 422, ok: false, json: async () => ({ error: { type: 'UNKNOWN_FIELD_NAME', message: 'Unknown field name: "Gate Alert Sent At"' } }), text: async () => '' };
    }
    return inner(url, init);
  };
  await tap();

  assert.match(textsTo(ctx, GUEST_PHONE).join('\n'), REPLY);
  assert.strictEqual(templateSends(ctx).length, 1);
  assert.deepStrictEqual(textsTo(ctx, NOTIFY_PHONE), [OWNER_COPY]);
  assert.strictEqual(events(ctx, 'gate_alert_stamp_write_failed').length, 1);
});

test('every alert send fails: logged, no stamp (so the next tap retries), guest still answered', async () => {
  on();
  const ctx = start();
  const inner = global.fetch;
  global.fetch = async (url, init = {}) => {
    if (String(url).includes('graph.facebook.com') && init.body && JSON.parse(init.body).to !== GUEST_PHONE) {
      return { status: 400, ok: false, json: async () => ({ error: { message: 'Re-engagement message', code: 131047 } }), text: async () => '' };
    }
    return inner(url, init);
  };
  await tap();

  assert.match(textsTo(ctx, GUEST_PHONE).join('\n'), REPLY);
  assert.strictEqual(events(ctx, 'reception_gate_notify_failed').length, 1);
  assert.strictEqual(events(ctx, 'gate_alert_unpaid_owner_send_failed').length, 1);
  assert.strictEqual(bookingRow(ctx).fields['Gate Alert Sent At'], undefined);
});

test('only the owner copy goes out (no Reception seat): that counts as an alert and starts the quiet period', async () => {
  on();
  const ctx = start({ roles: [] });
  await tap();
  assert.strictEqual(events(ctx, 'reception_gate_notify_no_seat').length, 1);
  assert.deepStrictEqual(textsTo(ctx, NOTIFY_PHONE), [OWNER_COPY]);
  assert.ok(bookingRow(ctx).fields['Gate Alert Sent At']);
});

test('no Notify Phone on the property: the owner copy falls back to the OWNER_PHONE number, as the paid-path copy does', async () => {
  on();
  const ctx = start({ roles: [], propertyFields: { 'Notify Phone': undefined } });
  await tap();
  const copies = ctx.sends.filter(s => /has not paid yet/.test(s.body || ''));
  assert.strictEqual(copies.length, 1);
  assert.notStrictEqual(copies[0].to, NOTIFY_PHONE);
  assert.match(textsTo(ctx, GUEST_PHONE).join('\n'), REPLY);
});

test('template not configured: the stub is logged per seat, the owner copy still goes', async () => {
  process.env.WABISTAY_GATE_ALERT_UNPAID = '1';
  const ctx = start();
  await tap();
  assert.strictEqual(events(ctx, 'reception_gate_notify_stubbed').length, 1);
  assert.strictEqual(templateSends(ctx).length, 0);
  assert.deepStrictEqual(textsTo(ctx, NOTIFY_PHONE), [OWNER_COPY]);
});

// ── the 2 Oct case ───────────────────────────────────────────────────────────

test('guest, Reception seat and Notify Phone are one number: the alerts still go to it, in addition to the guest reply', async () => {
  on();
  const SHAWN = '27780384989';
  const ctx = start({
    guestPhone: SHAWN,
    propertyFields: { 'Notify Phone': SHAWN },
    roles: [{ id: 'recRecep', fields: { 'Role Label': 'Reception', 'Role Type': 'Reception', 'Property': ['recP1'], 'Current Phone': SHAWN, 'Active': true } }]
  });
  await tap(SHAWN);

  const toShawn = ctx.sends.filter(s => s.to === SHAWN);
  assert.strictEqual(toShawn.length, 3, 'office reply + owner copy (text) + reception template');
  assert.strictEqual(toShawn.filter(s => s.type === 'template').length, 1);
  assert.ok(toShawn.some(s => /has not paid yet/.test(s.body || '')));
});

test('the flag shows up in the cold-start flag state as off when unset and on for 1/true', () => {
  delete process.env.WABISTAY_GATE_ALERT_UNPAID;
  assert.strictEqual(wh.wabistayFlagState().WABISTAY_GATE_ALERT_UNPAID, 'off');
  process.env.WABISTAY_GATE_ALERT_UNPAID = 'true';
  assert.strictEqual(wh.wabistayFlagState().WABISTAY_GATE_ALERT_UNPAID, 'on');
});
