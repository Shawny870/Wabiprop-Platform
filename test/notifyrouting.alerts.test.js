// test/notifyrouting.alerts.test.js
// PR 8 — end-to-end routing of the three alerts that test/notifyrouting.test.js
// only covers through the shared resolver (room-cleaned is covered there):
// overnight new booking, hourly new booking, and extension. Each is driven
// through the real webhook in three modes:
//   · flag off                      -> OWNER_PHONE is told, Notify Phone is not (today)
//   · flag on                       -> Notify Phone is told, OWNER_PHONE is not
//   · flag on, no Notify Phone      -> OWNER_PHONE fallback
// In-memory only: MockAirtable + mocked fetch.

const { test, afterEach } = require('node:test');
const assert = require('node:assert');
const { installEnv, installFetch, makeRes, metaTextPayload, MockAirtable } = require('./harness');

installEnv();
const saved = { OWNER_PHONE: process.env.OWNER_PHONE, WABISTAY_NOTIFY_ROUTING: process.env.WABISTAY_NOTIFY_ROUTING };
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
});

const OWNER = '27999000111';
const NOTIFY = '27831112222';
const GUEST = '27821234567';

function freshWebhook() {
  delete require.cache[require.resolve('../api/wabistay/webhook.js')];
  return require('../api/wabistay/webhook.js');
}

function propertyRecord(withNotify, extra = {}) {
  const fields = {
    'Property Name': 'Test Lodge', 'Phone Number ID': '111000111000', 'City': 'Testville',
    'Hourly Rate 1hr': 120, 'Hourly Rate 2hr': 250, 'Hourly Rate 3hr': 320, ...extra
  };
  if (withNotify) fields['Notify Phone'] = NOTIFY;
  return { id: 'recP1', fields };
}
const room = status => ({ id: 'recR1', fields: { 'Room Name': 'Room 1', 'Room Number': 1, 'Status': status, 'Property': ['recP1'], 'Active': true } });
const guest = state => ({ id: 'recG1', fields: { 'Guest Name': 'John Smith', 'Phone Number': GUEST, 'Session State': state } });

const SCENARIOS = {
  overnight: {
    text: 'John Smith\n25 June\n27 June',
    marker: /New booking enquiry from John Smith/,
    seed: withNotify => ({
      WS_Properties: [propertyRecord(withNotify)],
      WS_Rates: [{ id: 'recRATE1', fields: { 'Rate Name': 'Standard Overnight', 'Rate Type': 'Per Night', 'Amount': 350, 'Active': true, 'Property': ['recP1'] } }],
      WS_Rooms: [room('Available')],
      WS_Guests: [{ id: 'recG1', fields: { 'Guest Name': 'Unknown', 'Phone Number': GUEST, 'Session State': 'AWAITING_DETAILS' } }],
      WS_Cleaners: [], WS_Bookings: [], WS_Enquiries: []
    })
  },
  hourly: {
    text: '1',
    marker: /New \*short stay\* booking from John Smith/,
    seed: withNotify => ({
      WS_Properties: [propertyRecord(withNotify)],
      WS_Rates: [],
      WS_Rooms: [room('Available')],
      WS_Guests: [guest('AWAITING_HOURLY_DURATION')],
      WS_Bookings: [{ id: 'recHourlyPend0001', fields: {
        'Guest': ['recG1'], 'Booking Type': 'Hourly', 'Status': 'Enquiry',
        'Check In': new Date(Date.now() + 24 * 3600e3).toISOString().replace(/T.*/, 'T12:00:00.000Z'), 'Payment Status': 'Unpaid'
      } }],
      WS_Cleaners: [], WS_Enquiries: []
    })
  },
  extension: {
    text: 'extend',
    marker: /John Smith has extended their stay/,
    seed: withNotify => ({
      WS_Properties: [propertyRecord(withNotify)],
      WS_Rates: [{ id: 'recRateCouple', fields: { 'Rate Name': 'Couple', 'Occupancy Type': 'Couple', 'Amount': 400, 'Active': true, 'Property': ['recP1'] } }],
      WS_Rooms: [room('Occupied')],
      WS_Guests: [guest('CHECKED_IN')],
      WS_Bookings: [{ id: 'recBook1', fields: {
        'Guest': ['recG1'], 'Room': ['recR1'], 'Status': 'Checked In', 'Booking Type': 'Overnight',
        'Amount Due': 400, 'Rate Applied': ['recRateCouple'],
        'Check In': '2026-08-05T12:00:00.000Z', 'Check Out': '2026-08-06T08:00:00.000Z', 'WS_Property': ['recP1']
      } }],
      WS_Cleaners: [], WS_Enquiries: []
    })
  }
};

async function run(name, { flag, withNotify, ownerPhone = OWNER }) {
  if (ownerPhone) process.env.OWNER_PHONE = ownerPhone; else delete process.env.OWNER_PHONE;
  if (flag) process.env.WABISTAY_NOTIFY_ROUTING = '1'; else delete process.env.WABISTAY_NOTIFY_ROUTING;
  const wh = freshWebhook();
  const sc = SCENARIOS[name];
  const ctx = { airtable: new MockAirtable(sc.seed(withNotify)), sends: [], axiom: [] };
  installFetch(ctx);
  const res = makeRes();
  await wh({ method: 'POST', body: metaTextPayload(GUEST, sc.text) }, res);
  const to = phone => ctx.sends.filter(s => s.to === phone && sc.marker.test(s.body || ''));
  return { ctx, alertsTo: to, windowEvents: ctx.axiom.filter(e => e.event === 'owner_send_window_check') };
}

for (const name of Object.keys(SCENARIOS)) {
  test(`${name}: flag off -> OWNER_PHONE is alerted, Notify Phone is not`, async () => {
    const r = await run(name, { flag: false, withNotify: true });
    assert.strictEqual(r.alertsTo(OWNER).length, 1, 'alert reached OWNER_PHONE');
    assert.strictEqual(r.alertsTo(NOTIFY).length, 0, 'Notify Phone did not get it');
  });

  test(`${name}: flag on -> Notify Phone is alerted, OWNER_PHONE is not`, async () => {
    const r = await run(name, { flag: true, withNotify: true });
    assert.strictEqual(r.alertsTo(NOTIFY).length, 1, 'alert reached Notify Phone');
    assert.strictEqual(r.alertsTo(OWNER).length, 0, 'OWNER_PHONE did not get it');
  });

  test(`${name}: flag on but the property has no Notify Phone -> OWNER_PHONE fallback`, async () => {
    const r = await run(name, { flag: true, withNotify: false });
    assert.strictEqual(r.alertsTo(OWNER).length, 1, 'fell back to OWNER_PHONE');
  });

  test(`${name}: flag on, no Notify Phone and no OWNER_PHONE -> no alert, and the guest flow is unaffected`, async () => {
    const r = await run(name, { flag: true, withNotify: false, ownerPhone: null });
    assert.strictEqual(r.ctx.sends.filter(s => SCENARIOS[name].marker.test(s.body || '')).length, 0);
    assert.ok(r.ctx.sends.some(s => s.to === GUEST), 'the guest still got their own reply');
  });
}

test('hourly and extension alerts now log the send-window check, with the routed recipient', async () => {
  for (const [name, site] of [['hourly', 'hourly_new_booking'], ['extension', 'extension']]) {
    const off = await run(name, { flag: false, withNotify: true });
    assert.strictEqual(off.windowEvents.filter(e => e.site === site)[0].recipient, OWNER, `${name} flag off`);
    const on = await run(name, { flag: true, withNotify: true });
    assert.strictEqual(on.windowEvents.filter(e => e.site === site)[0].recipient, NOTIFY, `${name} flag on`);
  }
});

test('an extension alert fires once per booking: a second extension is not re-announced, flag on', async () => {
  process.env.OWNER_PHONE = OWNER;
  process.env.WABISTAY_NOTIFY_ROUTING = '1';
  const wh = freshWebhook();
  const ctx = { airtable: new MockAirtable(SCENARIOS.extension.seed(true)), sends: [], axiom: [] };
  installFetch(ctx);
  for (let i = 0; i < 2; i++) await wh({ method: 'POST', body: metaTextPayload(GUEST, 'extend') }, makeRes());
  assert.strictEqual(ctx.sends.filter(s => s.to === NOTIFY && SCENARIOS.extension.marker.test(s.body || '')).length, 1);
});
