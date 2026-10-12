// test/timinglog.test.js
// WABISTAY_TIMING_LOG: one request_timing Axiom event per inbound message, with ONE JSON string field
// (timing_json). Off: nothing extra is logged.

const { test, afterEach } = require('node:test');
const assert = require('node:assert');
const { installEnv, installFetch, makeRes, metaTextPayload, MockAirtable } = require('./harness');

installEnv();
const ENV = ['WABISTAY_TIMING_LOG', 'WABISTAY_INTERACTIVE', 'VERCEL_REGION'];
const saved = Object.fromEntries(ENV.map(k => [k, process.env[k]]));
// These tests assert one flag in isolation: the other performance flags are cleared for the file, then restored.
const OTHER_PERF_FLAGS = ['WABISTAY_ACTIVITY_THROTTLE', 'WABISTAY_READ_CACHE', 'WABISTAY_PARALLEL_PREAMBLE', 'WABISTAY_TIMING_LOG', 'WABISTAY_AIRTABLE_RETRY'].filter(k => k !== 'WABISTAY_TIMING_LOG');
const savedOther = Object.fromEntries(OTHER_PERF_FLAGS.map(k => [k, process.env[k]]));
for (const k of OTHER_PERF_FLAGS) delete process.env[k];
require('node:test').after(() => { for (const k of OTHER_PERF_FLAGS) { if (savedOther[k] === undefined) delete process.env[k]; else process.env[k] = savedOther[k]; } });
afterEach(() => { for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

const PHONE = '27821234567';
function freshWebhook() {
  delete require.cache[require.resolve('../api/wabistay/webhook.js')];
  return require('../api/wabistay/webhook.js');
}
function setup(flag, latency = 0) {
  if (flag === undefined) delete process.env.WABISTAY_TIMING_LOG; else process.env.WABISTAY_TIMING_LOG = flag;
  const ctx = {
    airtable: new MockAirtable({
      WS_Properties: [{ id: 'recP1', fields: { 'Property Name': 'Villa Liza', 'Phone Number ID': '111000111000', 'Notify Phone': '27732273477' } }],
      WS_Rooms: [{ id: 'recR1', fields: { 'Room Name': 'Room 01', 'Status': 'Available', 'Property': ['recP1'], 'Active': true } }],
      WS_Rates: [], WS_Bookings: [], WS_Cleaners: [], WS_Enquiries: [], WS_Roles: [],
      WS_Guests: [{ id: 'recG1', fields: { 'Phone Number': PHONE, 'Guest Name': 'John', 'Session State': 'AWAITING_STAY_TYPE' } }]
    }),
    sends: [], axiom: []
  };
  installFetch(ctx);
  if (latency) {
    const real = global.fetch;
    global.fetch = async (u, o) => { if (String(u).includes('api.airtable.com')) await new Promise(r => setTimeout(r, latency)); return real(u, o); };
  }
  return ctx;
}
const say = (wh, text, id) => wh({ method: 'POST', body: metaTextPayload(PHONE, text, id) }, makeRes());
const timingEvents = ctx => ctx.axiom.filter(e => e.event === 'request_timing');

test('flag off (unset): no request_timing event', async () => {
  const wh = freshWebhook();
  const ctx = setup(undefined);
  await say(wh, '1');
  assert.strictEqual(timingEvents(ctx).length, 0);
});

test('flag on: exactly one request_timing event per message, with only phone_number_id, wamid and one timing_json string', async () => {
  const wh = freshWebhook();
  const ctx = setup('1');
  await say(wh, '1', 'wamid.T1');
  const [e] = timingEvents(ctx);
  assert.strictEqual(timingEvents(ctx).length, 1);
  assert.deepStrictEqual(Object.keys(e).filter(k => !['_time', 'level', 'event', 'source'].includes(k)).sort(), ['phone_number_id', 'timing_json', 'wamid']);
  assert.strictEqual(typeof e.timing_json, 'string');
  assert.strictEqual(e.wamid, 'wamid.T1');
  assert.strictEqual(e.phone_number_id, '111000111000');
});

test('flag on: the JSON has the totals, a call list that adds up, and the right kinds', async () => {
  const wh = freshWebhook();
  const ctx = setup('1', 15);
  await say(wh, '1');
  const t = JSON.parse(timingEvents(ctx)[0].timing_json);
  assert.ok(t.total_ms >= 60, 'total covers the (15 ms each) calls');
  const kinds = t.calls.map(c => c[0]);
  assert.ok(kinds.includes('at_get') && kinds.includes('at_update') && kinds.includes('wa_text'));
  assert.strictEqual(t.airtable_calls, t.calls.filter(c => c[0].startsWith('at_')).length);
  assert.strictEqual(t.whatsapp_sends, t.calls.filter(c => c[0].startsWith('wa_')).length);
  assert.strictEqual(t.airtable_ms, t.calls.filter(c => c[0].startsWith('at_')).reduce((n, c) => n + c[2], 0));
  assert.ok(t.calls.every(c => c.length === 4 && c[2] >= 0 && c[3] >= 0));
  assert.ok(t.calls.filter(c => c[0].startsWith('at_')).every(c => c[2] >= 10), 'each 15 ms call is measured, not zero');
  assert.ok(t.airtable_ms + t.whatsapp_ms <= t.total_ms + 5, 'sequential calls cannot exceed the wall time');
});

test('flag on: labels are table names only — no phone number, message text or formula in the event', async () => {
  const wh = freshWebhook();
  const ctx = setup('1');
  await say(wh, '1');
  const raw = JSON.stringify(timingEvents(ctx)[0]);
  assert.ok(!raw.includes(PHONE));
  assert.ok(!raw.includes('Phone Number'));
  assert.ok(!raw.includes('filterByFormula'));
});

test('flag on: cold is true for the first message the process handles and false afterwards; region comes from VERCEL_REGION', async () => {
  process.env.VERCEL_REGION = 'iad1';
  const wh = freshWebhook();
  const ctx = setup('1');
  await say(wh, '1');
  await say(wh, 'hi');
  const [a, b] = timingEvents(ctx).map(e => JSON.parse(e.timing_json));
  assert.strictEqual(a.cold, true);
  assert.strictEqual(b.cold, false);
  assert.strictEqual(a.region, 'iad1');
});

test('flag on: the event is still logged when the handler throws', async () => {
  const wh = freshWebhook();
  const ctx = setup('1');
  const real = global.fetch;
  global.fetch = async (u, o) => { if (String(u).includes('/WS_Properties?')) throw new Error('boom'); return real(u, o); };
  await say(wh, '1');
  assert.strictEqual(timingEvents(ctx).length, 1);
  assert.ok(ctx.axiom.some(e => e.event === 'fatal'));
});

test('flag on: two messages handled at the same time keep separate timings', async () => {
  const wh = freshWebhook();
  const ctx = setup('1', 10);
  await Promise.all([say(wh, '1', 'wamid.A'), say(wh, 'hi', 'wamid.B')]);
  const events = timingEvents(ctx);
  assert.strictEqual(events.length, 2);
  for (const e of events) {
    const t = JSON.parse(e.timing_json);
    assert.ok(t.airtable_calls >= 3 && t.airtable_calls <= 14, 'each event counts only its own calls: ' + t.airtable_calls);
  }
});

test('flag on: the reply and the Airtable writes are the same as with the flag off', async () => {
  const wh = freshWebhook();
  const off = setup(undefined); await say(wh, '1');
  const on = setup('1'); await say(wh, '1');
  assert.deepStrictEqual(on.sends.map(s => s.body), off.sends.map(s => s.body));
  const norm = c => c.airtable.log.map(l => `${l.op} ${l.table} ${Object.keys(l.fields).sort().join(',')}`).sort();
  assert.deepStrictEqual(norm(on), norm(off));
});

test('flag on: the request does not return until the request_timing event has been sent (it is the last event and would otherwise be cut off)', async () => {
  const wh = freshWebhook();
  const ctx = setup('1');
  const real = global.fetch;
  let ingestDone = false;
  global.fetch = async (u, o) => {
    if (String(u).includes('api.axiom.co') && String(o && o.body).includes('request_timing')) {
      await new Promise(r => setTimeout(r, 120));
      const res = await real(u, o);
      ingestDone = true;
      return res;
    }
    return real(u, o);
  };
  await say(wh, '1');
  assert.strictEqual(ingestDone, true);
  void ctx;
});

test('flag on: a hung Axiom ingest cannot hold the request for more than about a second', { timeout: 8000 }, async () => {
  const wh = freshWebhook();
  setup('1');
  const real = global.fetch;
  global.fetch = async (u, o) => {
    if (String(u).includes('api.axiom.co') && String(o && o.body).includes('request_timing')) return new Promise(() => {});
    return real(u, o);
  };
  const t = Date.now();
  await say(wh, '1');
  assert.ok(Date.now() - t < 2500, 'returned in ' + (Date.now() - t) + ' ms');
});
