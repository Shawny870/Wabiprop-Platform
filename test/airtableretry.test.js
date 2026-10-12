// test/airtableretry.test.js
// WABISTAY_AIRTABLE_RETRY: retry on 429 / 5xx / dropped connection, never write a record twice, and a read that
// still fails THROWS (HTTP 500 back to Meta) instead of returning [] as if the table were empty.

const { test, afterEach, beforeEach } = require('node:test');
const assert = require('node:assert');
const { installEnv, installFetch, makeRes, metaTextPayload, MockAirtable } = require('./harness');

installEnv();
const wh = require('../api/wabistay/webhook.js');
const ENV = ['WABISTAY_AIRTABLE_RETRY'];
const saved = Object.fromEntries(ENV.map(k => [k, process.env[k]]));
beforeEach(() => wh.setAirtableRetryDelays([1, 1, 1]));
afterEach(() => { for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } wh.setAirtableRetryDelays([250, 750, 1500]); });

const PHONE = '27821234567';
function seed() {
  return {
    WS_Properties: [{ id: 'recP1', fields: { 'Property Name': 'Villa Liza Guest Lodge', 'Phone Number ID': '111000111000', 'Notify Phone': '27732273477', 'Hourly Rate 1hr': 120, 'Hourly Rate 2hr': 250, 'Hourly Rate 3hr': 320 } }],
    WS_Rooms: [{ id: 'recR1', fields: { 'Room Name': 'Room 01', 'Room Number': 1, 'Status': 'Available', 'Property': ['recP1'], 'Active': true } }],
    WS_Rates: [], WS_Bookings: [], WS_Cleaners: [], WS_Enquiries: [], WS_Roles: [],
    WS_Guests: [{ id: 'recG1', fields: { 'Phone Number': PHONE, 'Guest Name': 'John', 'Session State': 'AWAITING_STAY_TYPE' } }]
  };
}
// rules: [{ table, method, fails: [ {status, error?, headers?, throw?} ... ] | 'always' }]; a failure is consumed per matching call.
function setup(flag, rules = [], seedOver) {
  if (flag === undefined) delete process.env.WABISTAY_AIRTABLE_RETRY; else process.env.WABISTAY_AIRTABLE_RETRY = flag;
  const ctx = { airtable: new MockAirtable({ ...seed(), ...(seedOver || {}) }), sends: [], axiom: [], calls: [] };
  installFetch(ctx);
  const real = global.fetch;
  global.fetch = async (url, init = {}) => {
    const u = String(url);
    if (!u.includes('api.airtable.com')) return real(url, init);
    const table = decodeURIComponent(u.split('/v0/')[1].split('/')[1].split('?')[0]);
    const method = (init.method || 'GET').toUpperCase();
    ctx.calls.push(method + ' ' + table);
    const rule = rules.find(r => r.table === table && r.method === method && (r.fails === 'always' || r.fails.length > 0));
    if (rule) {
      const f = rule.fails === 'always' ? { status: 500 } : rule.fails.shift();
      if (f.throw) throw new Error('socket hang up');
      const headers = f.headers || {};
      return { status: f.status, ok: false, headers: { get: k => headers[k.toLowerCase()] ?? null }, json: async () => ({ error: f.error || { type: 'SERVER_ERROR', message: 'x' } }), text: async () => '' };
    }
    return real(url, init);
  };
  return ctx;
}
const n = (ctx, k) => ctx.calls.filter(c => c === k).length;
async function say(text) { const res = makeRes(); await wh({ method: 'POST', body: metaTextPayload(PHONE, text) }, res); return res; }
const guestRows = ctx => ctx.airtable.tables.WS_Guests;

test('flag off: a failed guest lookup returns [] — the sender is treated as a brand-new guest and a second guest row is created', async () => {
  const ctx = setup(undefined, [{ table: 'WS_Guests', method: 'GET', fails: 'always' }]);
  await say('1');
  assert.strictEqual(guestRows(ctx).length, 2, 'duplicate guest created (the bug this flag fixes)');
  assert.strictEqual(n(ctx, 'GET WS_Guests'), 1, 'no retry');
});

test('flag on: a guest lookup that fails once is retried and finds the existing guest — no duplicate guest, the flow continues', async () => {
  const ctx = setup('1', [{ table: 'WS_Guests', method: 'GET', fails: [{ status: 500 }] }]);
  const res = await say('1');
  assert.strictEqual(res.statusCode, 200);
  assert.strictEqual(guestRows(ctx).length, 1);
  assert.strictEqual(n(ctx, 'GET WS_Guests'), 2);
  assert.strictEqual(guestRows(ctx)[0].fields['Session State'], 'AWAITING_HOURLY_DETAILS', 'handled as the existing guest answering the stay-type question');
  assert.ok(ctx.axiom.some(e => e.event === 'airtable_retry'));
});

test('flag on: a guest lookup that keeps failing creates no guest, sends the guest nothing, and answers Meta HTTP 500 for a redelivery', async () => {
  const ctx = setup('1', [{ table: 'WS_Guests', method: 'GET', fails: 'always' }]);
  const res = await say('1');
  assert.strictEqual(res.statusCode, 500);
  assert.strictEqual(guestRows(ctx).length, 1, 'no duplicate guest');
  assert.deepStrictEqual(ctx.sends.filter(s => s.to === PHONE), [], 'the guest got no wrong reply');
  assert.strictEqual(n(ctx, 'GET WS_Guests'), 4, 'first try plus three retries');
  assert.ok(ctx.axiom.some(e => e.event === 'airtable_get_error'));
});

test('flag on: a 429 is retried, a dropped connection is retried, a non-retryable 422 is thrown at once', async () => {
  const a = setup('1', [{ table: 'WS_Guests', method: 'GET', fails: [{ status: 429 }, { throw: true }] }]);
  const resA = await say('1');
  assert.strictEqual(resA.statusCode, 200);
  assert.strictEqual(n(a, 'GET WS_Guests'), 3);
  const b = setup('1', [{ table: 'WS_Guests', method: 'GET', fails: [{ status: 422, error: { type: 'INVALID_FILTER_BY_FORMULA' } }] }]);
  const resB = await say('1');
  assert.strictEqual(resB.statusCode, 500);
  assert.strictEqual(n(b, 'GET WS_Guests'), 1, '422 is not retried');
});

test('flag on: a Retry-After longer than 3 s is not waited for — the call fails at once', async () => {
  const ctx = setup('1', [{ table: 'WS_Guests', method: 'GET', fails: [{ status: 429, headers: { 'retry-after': '30' } }] }]);
  const t = Date.now();
  const res = await say('1');
  assert.strictEqual(res.statusCode, 500);
  assert.strictEqual(n(ctx, 'GET WS_Guests'), 1);
  assert.ok(Date.now() - t < 1000);
});

test('rooms path, flag off: a failed rooms read looks like "no rooms" and the guest is told the lodge is full', async () => {
  const ctx = setup(undefined, [{ table: 'WS_Rooms', method: 'GET', fails: 'always' }], { WS_Guests: [] });
  await say('hi');
  assert.ok(ctx.axiom.some(e => e.event === 'greeting_zero_rooms'), 'the old behaviour: fully booked');
});

test('rooms path, flag on: a failed rooms read is NOT reported to the guest as "fully booked" — Meta gets a 500 and redelivers', async () => {
  const ctx = setup('1', [{ table: 'WS_Rooms', method: 'GET', fails: 'always' }], { WS_Guests: [] });
  const res = await say('hi');
  assert.strictEqual(res.statusCode, 500);
  assert.ok(!ctx.axiom.some(e => e.event === 'greeting_zero_rooms'));
  assert.ok(ctx.sends.filter(s => s.to === PHONE).every(s => /Quick note before we start/.test(s.body)), 'only the first-contact consent notice (sent before the rooms read) went out');
  assert.strictEqual(guestRows(ctx).length, 0, 'and no guest row was created on the way');
});

test('rooms path, flag on: a rooms read that fails once is retried and the greeting proceeds', async () => {
  const ctx = setup('1', [{ table: 'WS_Rooms', method: 'GET', fails: [{ status: 503 }] }], { WS_Guests: [] });
  const res = await say('hi');
  assert.strictEqual(res.statusCode, 200);
  assert.ok(ctx.sends.some(s => s.to === PHONE), 'greeting sent');
});

test('availability check, flag on: a rooms read that keeps failing during the booking step throws instead of reporting no availability', async () => {
  const ctx = setup('1', [], { WS_Guests: [{ id: 'recG1', fields: { 'Phone Number': PHONE, 'Guest Name': 'John', 'Session State': 'AWAITING_HOURLY_DURATION' } }] });
  ctx.airtable.tables.WS_Bookings.push({ id: 'recB1', fields: { Guest: ['recG1'], 'Booking Type': 'Hourly', Status: 'Enquiry', 'Check In': new Date(Date.now() + 3600000).toISOString(), 'Payment Status': 'Unpaid' } });
  const real = global.fetch;
  global.fetch = async (u, o) => (String(u).includes('/WS_Rooms?') ? { status: 500, ok: false, headers: { get: () => null }, json: async () => ({ error: { type: 'SERVER_ERROR' } }) } : real(u, o));
  const res = await say('3');
  assert.strictEqual(res.statusCode, 500);
  assert.ok(!ctx.axiom.some(e => e.event === 'availability_check_failed_closed' || e.event === 'booking_race_lost'));
  assert.notStrictEqual(ctx.airtable.tables.WS_Bookings[0].fields.Status, 'Confirmed');
});

test('create: a 500 is NOT retried (it could already be written), a 429 is retried and writes exactly one record', async () => {
  const a = setup('1', [{ table: 'WS_Guests', method: 'POST', fails: [{ status: 500 }] }], { WS_Guests: [] });
  await say('hi');
  assert.strictEqual(n(a, 'POST WS_Guests'), 1);
  const b = setup('1', [{ table: 'WS_Guests', method: 'POST', fails: [{ status: 429 }] }], { WS_Guests: [] });
  await say('hi');
  assert.strictEqual(n(b, 'POST WS_Guests'), 2);
  assert.strictEqual(guestRows(b).length, 1, 'exactly one guest row');
});

test('update: a 5xx is retried and the write lands once', async () => {
  const ctx = setup('1', [{ table: 'WS_Guests', method: 'PATCH', fails: [{ status: 502 }] }]);
  await say('1');
  assert.ok(n(ctx, 'PATCH WS_Guests') >= 2);
  assert.strictEqual(guestRows(ctx)[0].fields['Session State'], 'AWAITING_HOURLY_DETAILS');
});

test('a failed write that exhausts its retries still returns the error object and the flow carries on as before', async () => {
  const ctx = setup('1', [{ table: 'WS_Properties', method: 'PATCH', fails: 'always' }]);
  const res = await say('1');
  assert.strictEqual(res.statusCode, 200, 'the property stamp is best-effort and never blocks a guest');
  assert.strictEqual(n(ctx, 'PATCH WS_Properties'), 4);
});

test('with the read cache on as well, a persistent failure is retried once (not twice over) and then thrown', async () => {
  process.env.WABISTAY_READ_CACHE = '1';
  try {
    const ctx = setup('1', [{ table: 'WS_Rooms', method: 'GET', fails: 'always' }], { WS_Guests: [] });
    const res = await say('hi');
    assert.strictEqual(res.statusCode, 500);
    assert.strictEqual(n(ctx, 'GET WS_Rooms'), 4, 'first try plus three retries, not eight');
  } finally { delete process.env.WABISTAY_READ_CACHE; }
});
