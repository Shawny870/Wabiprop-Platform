// test/receptiongatealert.test.js
// Reception gate-arrival alert: on gate arrival every Active Reception seat for
// the property gets WABISTAY_GATE_ARRIVAL_TEMPLATE with five positional params
// (property, guest, room, room status, guest phone). Additive to the free-form
// Notify Phone alert, which is unchanged. Also covers the template-param
// sanitiser (Meta rejects newlines/tabs/4+ spaces), which protects alertShawn.
// In-memory only: MockAirtable + mocked fetch.

const { test, afterEach } = require('node:test');
const assert = require('node:assert');
const { installEnv, installFetch, makeRes, metaTextPayload, MockAirtable } = require('./harness');

installEnv();
const wh = require('../api/wabistay/webhook.js');

const GUEST_PHONE = '27821234567';
const NOTIFY_PHONE = '27831112222';
const RECEP_1 = '27825999001';
const RECEP_2 = '27825999002';
const ON_DUTY = '27825999003';
const OTHER_PROP_RECEP = '27825999004';
const INACTIVE_RECEP = '27825999005';
const TEMPLATE = 'wabistay_gate_arrival_test';

afterEach(() => { delete process.env.WABISTAY_GATE_ARRIVAL_TEMPLATE; });

function seed({ roomStatus = 'Available', roles } = {}) {
  const role = (id, type, phone, extra = {}) => ({
    id, fields: { 'Role Label': id, 'Role Type': type, 'Property': ['recP1'], 'Current Phone': phone, 'Active': true, ...extra }
  });
  return {
    WS_Properties: [
      { id: 'recP1', fields: { 'Property Name': 'Canary Street Guest Rooms', 'Phone Number ID': '111000111000', 'Notify Phone': NOTIFY_PHONE } },
      { id: 'recP2', fields: { 'Property Name': 'Other Lodge', 'Phone Number ID': '222000222000' } }
    ],
    WS_Rooms: [{
      id: 'recR1',
      fields: { 'Room Name': 'Room 01', 'Room Number': 1, 'Status': roomStatus, 'Property': ['recP1'], 'Active': true }
    }],
    WS_Roles: roles || [
      role('recRecep1', 'Reception', RECEP_1),
      role('recRecep2', 'Reception', RECEP_2),
      role('recOnDuty', 'On Duty', ON_DUTY),
      role('recOther', 'Reception', OTHER_PROP_RECEP, { 'Property': ['recP2'] }),
      role('recInactive', 'Reception', INACTIVE_RECEP, { 'Active': false })
    ],
    WS_Guests: [{ id: 'recG1', fields: { 'Guest Name': 'Jane Doe', 'Phone Number': GUEST_PHONE, 'Session State': 'CONFIRMED' } }],
    WS_Bookings: [{
      id: 'recB1', fields: {
        'Guest': ['recG1'], 'Status': 'Confirmed', 'Booking Type': 'Overnight',
        'Check In': '2020-01-01T12:00:00.000Z', 'Check Out': '2099-01-01T08:00:00.000Z'
      }
    }],
    WS_Cleaners: [], WS_Enquiries: []
  };
}

function start(opts) {
  const ctx = { airtable: new MockAirtable(seed(opts)), sends: [], axiom: [] };
  installFetch(ctx);
  return ctx;
}

async function arrive(ctx) {
  const res = makeRes();
  await wh({ method: 'POST', body: metaTextPayload(GUEST_PHONE, '1') }, res);
  return res;
}

const templateSends = ctx => ctx.sends.filter(s => s.type === 'template');
const events = (ctx, name) => ctx.axiom.filter(e => e.event === name);
const bookingRow = ctx => ctx.airtable.tables['WS_Bookings'].find(b => b.id === 'recB1');

test('every Active Reception seat for the property gets the template with the five params in order', async () => {
  process.env.WABISTAY_GATE_ARRIVAL_TEMPLATE = TEMPLATE;
  const ctx = start({ roomStatus: 'Cleaning' });
  await arrive(ctx);

  const sends = templateSends(ctx);
  assert.deepStrictEqual(sends.map(s => s.to).sort(), [RECEP_1, RECEP_2].sort());
  for (const s of sends) {
    assert.strictEqual(s.template, TEMPLATE);
    assert.deepStrictEqual(s.params, ['Canary Street Guest Rooms', 'Jane Doe', 'Room 01', 'Cleaning', GUEST_PHONE]);
  }
});

test('On Duty, another property\'s Reception and an inactive Reception seat are not alerted', async () => {
  process.env.WABISTAY_GATE_ARRIVAL_TEMPLATE = TEMPLATE;
  const ctx = start();
  await arrive(ctx);

  const recipients = templateSends(ctx).map(s => s.to);
  for (const phone of [ON_DUTY, OTHER_PROP_RECEP, INACTIVE_RECEP]) {
    assert.ok(!recipients.includes(phone), `${phone} must not be alerted`);
  }
});

test('the existing free-form Notify Phone alert is unchanged and still sent', async () => {
  process.env.WABISTAY_GATE_ARRIVAL_TEMPLATE = TEMPLATE;
  const ctx = start({ roomStatus: 'Cleaning' });
  await arrive(ctx);

  const freeForm = ctx.sends.filter(s => s.type === 'text' && s.to === NOTIFY_PHONE);
  assert.strictEqual(freeForm.length, 1);
  assert.strictEqual(
    freeForm[0].body,
    `🔔 Jane Doe is at the gate. Room 01 assigned.\nRoom status right now: Cleaning\nPhone: ${GUEST_PHONE}`
  );
});

test('no room assigned: "an unassigned room" and "N/A"', async () => {
  process.env.WABISTAY_GATE_ARRIVAL_TEMPLATE = TEMPLATE;
  const ctx = start();
  ctx.airtable.tables['WS_Rooms'].length = 0;
  await arrive(ctx);

  const sends = templateSends(ctx);
  assert.strictEqual(sends.length, 2);
  assert.deepStrictEqual(sends[0].params, ['Canary Street Guest Rooms', 'Jane Doe', 'an unassigned room', 'N/A', GUEST_PHONE]);
});

test('env var unset: nothing is sent to Reception, one stub event per seat, Notify Phone alert still goes', async () => {
  const ctx = start();
  await arrive(ctx);

  assert.strictEqual(templateSends(ctx).length, 0);
  assert.strictEqual(events(ctx, 'reception_gate_notify_stubbed').length, 2);
  assert.strictEqual(ctx.sends.filter(s => s.type === 'text' && s.to === NOTIFY_PHONE).length, 1);
  assert.strictEqual(bookingRow(ctx).fields['Status'], 'Checked In');
});

test('no Reception seat: a warning is logged, nothing else changes, check-in completes', async () => {
  process.env.WABISTAY_GATE_ARRIVAL_TEMPLATE = TEMPLATE;
  const ctx = start({ roles: [] });
  await arrive(ctx);

  assert.strictEqual(events(ctx, 'reception_gate_notify_no_seat').length, 1);
  assert.strictEqual(templateSends(ctx).length, 0);
  assert.strictEqual(bookingRow(ctx).fields['Status'], 'Checked In');
  assert.strictEqual(ctx.sends.filter(s => s.type === 'text' && s.to === NOTIFY_PHONE).length, 1);
});

test('a rejected template send logs reception_gate_notify_failed and does not break check-in', async () => {
  process.env.WABISTAY_GATE_ARRIVAL_TEMPLATE = TEMPLATE;
  const ctx = start();
  const realFetch = global.fetch;
  global.fetch = async (url, opts) => {
    const isTemplate = String(url).includes('graph.facebook.com') && opts && opts.body && JSON.parse(opts.body).type === 'template';
    if (isTemplate) {
      return { status: 400, ok: false, json: async () => ({ error: { message: 'Template not found', code: 132001 } }), text: async () => '' };
    }
    return realFetch(url, opts);
  };
  try {
    await arrive(ctx);
  } finally {
    global.fetch = realFetch;
  }

  assert.strictEqual(events(ctx, 'reception_gate_notify_failed').length, 2);
  assert.strictEqual(bookingRow(ctx).fields['Status'], 'Checked In');
});

// ── Template param sanitiser ─────────────────────────────────────────────────

test('sanitizeTemplateParam flattens newlines and tabs and collapses runs of 4+ spaces', () => {
  const s = wh.sanitizeTemplateParam;
  assert.strictEqual(s('line one\nline two'), 'line one line two');
  assert.strictEqual(s('a\r\n\r\nb'), 'a b');
  assert.strictEqual(s('a\tb'), 'a b');
  assert.strictEqual(s('a     b'), 'a b');
  assert.strictEqual(s('a   b'), 'a   b', 'three spaces are allowed by Meta and left alone');
  assert.strictEqual(s('  padded  '), 'padded');
  assert.strictEqual(s(42), '42');
});

test('alertShawn template params reach Meta sanitised, in the same four-slot order', async () => {
  process.env.WABISTAY_OPS_ALERT_TEMPLATE = 'wabistay_ops_alert';
  const ctx = { airtable: new MockAirtable({ WS_Config: [{ id: 'recC', fields: { 'Alert Phone': '27811110000' } }] }), sends: [], axiom: [] };
  installFetch(ctx);
  try {
    await wh.alertShawn('daily_summary', 'Airtable 500:\n{"error":\t"boom"}     end', { propertyName: 'Canary Street Guest Rooms' });
  } finally {
    delete process.env.WABISTAY_OPS_ALERT_TEMPLATE;
  }

  const sent = templateSends(ctx);
  assert.strictEqual(sent.length, 1);
  const [type, property, time, details] = sent[0].params;
  assert.strictEqual(sent[0].params.length, 4);
  assert.strictEqual(type, 'daily_summary');
  assert.strictEqual(property, 'Canary Street Guest Rooms');
  assert.match(time, /^\d{4}-\d{2}-\d{2}T/);
  assert.strictEqual(details, 'Airtable 500: {"error": "boom"} end');
});
