// test/axiomfieldshape.test.js
// Axiom turns every nested object key into its own dotted field and the "wabistay" dataset is
// capped at 256 fields. The events below used to carry whole objects; each now carries ONE JSON
// string (flags_json, payload_json, fields_json, errors_json, breakdown_json) plus a few flat,
// queryable fields (event, propertyId, template, status, error_code, phone_number_id, ...).

const { test } = require('node:test');
const assert = require('node:assert');
const { installEnv, installFetch, MockAirtable } = require('./harness');

installEnv();
function freshWebhook() {
  delete require.cache[require.resolve('../api/wabistay/webhook.js')];
  return require('../api/wabistay/webhook.js');
}
const BUILTIN = ['_time', 'level', 'event', 'source'];
const keysOf = e => Object.keys(e).filter(k => !BUILTIN.includes(k)).sort();
const NOW = new Date('2026-08-20T10:00:00.000Z');

function world() {
  return {
    WS_Config: [{ id: 'recC', fields: { 'Alert Phone': '27811110000' } }],
    WS_Properties: [{ id: 'recVL', fields: { 'Property Name': 'Villa Liza', 'Notify Phone': '27700000001', 'Owner': ['recO'], 'Daily Summary Hour': 12 } }],
    WS_Owners: [{ id: 'recO', fields: { 'Owner Name': 'Thandiwe' } }],
    WS_Rooms: [{ id: 'r1', fields: { 'Room Name': 'Room 1', Status: 'Available', Property: ['recVL'] } }],
    WS_Bookings: [{ id: 'b1', fields: { Guest: ['g1'], Room: ['r1'], 'Booking Type': 'Overnight', Status: 'Checked Out', 'Amount Due': 400, 'Amount Paid': 400, 'Check In': '2026-08-17T12:00:00.000Z', 'Check Out': '2026-08-19T08:00:00.000Z' } }],
    WS_Guests: [{ id: 'g1', fields: { 'Guest Name': 'G', 'Phone Number': '27820000001' } }]
  };
}
function start(seed) {
  const ctx = { airtable: new MockAirtable(seed), sends: [], axiom: [] };
  installFetch(ctx);
  return ctx;
}
const objectValued = e => Object.entries(e).filter(([, v]) => v !== null && typeof v === 'object').map(([k]) => k);

test('the four report payload events carry flat scalars plus ONE payload_json string, no object or array fields', async () => {
  const wh = freshWebhook();
  const ctx = start(world());
  await wh.runWeeklyRecap({ now: NOW });
  await wh.runMonthlyReport({ now: NOW });
  await wh.runOwnerSummary({ now: NOW });
  await wh.runDailySummary({ now: NOW });
  for (const ev of ['weekly_recap_payload', 'monthly_report_payload', 'owner_summary_payload', 'daily_summary_payload']) {
    const e = ctx.axiom.find(x => x.event === ev);
    assert.ok(e, `${ev} logged`);
    assert.deepStrictEqual(keysOf(e), ['notifyPhone', 'payload_json', 'propertyId', 'propertyName', 'template'], ev);
    assert.deepStrictEqual(objectValued(e), [], `${ev}: no nested values for Axiom to flatten`);
    const full = JSON.parse(e.payload_json);
    assert.strictEqual(full.propertyId, 'recVL');
    assert.ok(Object.keys(full).length > 5, `${ev}: the whole report is still in the string`);
  }
  assert.ok(Array.isArray(JSON.parse(ctx.axiom.find(x => x.event === 'weekly_recap_payload').payload_json).templateParams));
});

test('wabistay_flags carries one flags_json string, not a flags object and an others object', async () => {
  const wh = freshWebhook();
  const ctx = start(world());
  const realLog = console.log; console.log = () => {};
  try { const res = { status() { return this; }, json() {}, send() {} };
    await wh.weeklyRecapHandler({}, res); } finally { console.log = realLog; }
  const e = ctx.axiom.find(x => x.event === 'wabistay_flags');
  assert.ok(e);
  assert.deepStrictEqual(keysOf(e), ['commit', 'deploymentId', 'flags_json']);
  const parsed = JSON.parse(e.flags_json);
  assert.ok(Object.keys(parsed.flags).length > 30 && parsed.others);
});

test('a failed guest-state write logs fields_json (a string), not a fields object', async () => {
  const wh = freshWebhook();
  const ctx = start(world());
  const real = global.fetch;
  global.fetch = async (url, opts) => (String(url).includes('WS_Guests') && opts && opts.method === 'PATCH')
    ? { status: 422, json: async () => ({ error: { type: 'UNKNOWN_FIELD_NAME', message: 'x' } }) }
    : real(url, opts);
  await wh.updateGuestState('g1', { 'Session State': 'NEW', 'Last Inbound At': 'now' }, { phone: '27820000001' });
  const e = ctx.axiom.find(x => x.event === 'guest_state_write_failed');
  assert.ok(e);
  assert.deepStrictEqual(JSON.parse(e.fields_json), { 'Session State': 'NEW', 'Last Inbound At': 'now' });
  assert.deepStrictEqual(objectValued(e), []);
  assert.ok(!('fields' in e));
  assert.strictEqual(e.phone, '27820000001', 'caller context stays flat and queryable');
});

test('airtable_call_count carries breakdown_json, not breakdown.get/create/update', async () => {
  const wh = freshWebhook();
  const ctx = start(world());
  await wh.runOwnerSummary({ now: NOW });
  const e = ctx.axiom.find(x => x.event === 'airtable_call_count');
  assert.deepStrictEqual(keysOf(e), ['breakdown_json', 'callsPerProperty', 'cronName', 'propertyCount', 'totalCalls']);
  assert.ok(typeof JSON.parse(e.breakdown_json).get === 'number');
});

test('a template Meta rejects logs error_code and http status as flat fields next to the JSON error', async () => {
  const wh = freshWebhook();
  const ctx = start(world());
  const real = global.fetch;
  global.fetch = async (url, opts) => (String(url).includes('graph.facebook.com') && /"type":"template"/.test(String(opts && opts.body)) && /weekly_recap/.test(String(opts.body)))
    ? { status: 404, json: async () => ({ error: { code: 132001, message: 'Template name does not exist' } }) }
    : real(url, opts);
  await wh.runWeeklyRecap({ now: NOW });
  const e = ctx.axiom.find(x => x.event === 'whatsapp_template_send_error');
  assert.strictEqual(e.error_code, 132001);
  assert.strictEqual(e.status, 404);
  assert.strictEqual(e.template, wh.WEEKLY_RECAP_TEMPLATE);
  assert.strictEqual(e.site, 'weekly_recap');
  assert.strictEqual(typeof e.error, 'string');
});
