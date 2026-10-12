// test/readcache.test.js
// WABISTAY_READ_CACHE: WS_Properties / WS_Rates kept 30 s on a warm instance, WS_Rooms / WS_Cleaners /
// WS_Roles read once per inbound message. WS_Bookings is never cached, so the availability re-check
// right before a booking is written still sees a booking made a moment earlier.

const { test, afterEach, beforeEach, mock } = require('node:test');
const assert = require('node:assert');
const { installEnv, installFetch, makeRes, metaTextPayload, MockAirtable } = require('./harness');

installEnv();
const wh = require('../api/wabistay/webhook.js');
const ENV = ['WABISTAY_READ_CACHE', 'WABISTAY_INTERACTIVE'];
const saved = Object.fromEntries(ENV.map(k => [k, process.env[k]]));
beforeEach(() => wh.resetReadCache());
afterEach(() => { for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

const PHONE = '27821234567';
function seed() {
  return {
    WS_Properties: [{ id: 'recP1', fields: { 'Property Name': 'Villa Liza Guest Lodge', 'Phone Number ID': '111000111000', 'Notify Phone': '27732273477', 'Hourly Rate 1hr': 120, 'Hourly Rate 2hr': 250, 'Hourly Rate 3hr': 320 } }],
    WS_Rooms: [{ id: 'recR1', fields: { 'Room Name': 'Room 01', 'Room Number': 1, 'Status': 'Available', 'Property': ['recP1'], 'Active': true } }],
    WS_Rates: [{ id: 'recRate', fields: { 'Rate Type': 'Per Night', 'Amount': 300, 'Active': true, 'Property': ['recP1'] } }],
    WS_Guests: [], WS_Bookings: [], WS_Cleaners: [], WS_Enquiries: []
  };
}
// Sets up the mock and a counting layer. hook(ctx, kind, table, url) runs after each Airtable response.
function setup(flag, hook) {
  if (flag === undefined) delete process.env.WABISTAY_READ_CACHE; else process.env.WABISTAY_READ_CACHE = flag;
  const ctx = { airtable: new MockAirtable(seed()), sends: [], axiom: [], counts: {} };
  installFetch(ctx);
  const real = global.fetch;
  global.fetch = async (url, opts) => {
    const u = String(url);
    const isAt = u.includes('api.airtable.com');
    let kind, table;
    if (isAt) {
      table = decodeURIComponent(u.split('/v0/')[1].split('/')[1].split('?')[0]);
      kind = (opts && opts.method) === 'PATCH' ? 'update' : (opts && opts.method) === 'POST' ? 'create' : 'get';
      ctx.counts[kind + ' ' + table] = (ctx.counts[kind + ' ' + table] || 0) + 1;
    }
    const res = await real(url, opts);
    if (isAt && hook) hook(ctx, kind, table, u);
    return res;
  };
  return ctx;
}
const say = text => wh({ method: 'POST', body: metaTextPayload(PHONE, text) }, makeRes());
const n = (ctx, k) => ctx.counts[k] || 0;
async function throughDuration(ctx) { for (const t of ['hi', '1', 'John\n3pm']) await say(t); }

test('flag on: WS_Properties is NEVER cached — it holds Subscription Status and the bank details, so it is read fresh on every message', async () => {
  const off = setup(undefined);
  await say('hi'); await say('hi'); await say('hi');
  const on = setup('1');
  await say('hi'); await say('hi'); await say('hi');
  assert.strictEqual(n(off, 'get WS_Properties'), 3);
  assert.strictEqual(n(on, 'get WS_Properties'), 3);
});

test('flag on: a property suspended in Airtable between two messages blocks the second message immediately (no 30 s staleness)', async () => {
  const ctx = setup('1');
  await say('hi');
  ctx.airtable.tables.WS_Properties[0].fields['Subscription Status'] = 'Suspended';
  const before = ctx.sends.length;
  await say('hi');
  assert.ok(ctx.sends.length > before, 'the second message was answered');
  assert.ok(ctx.sends.slice(before).some(s => /can.t take bookings through this chat/.test(s.body)), 'the suspended-property redirect was sent straight away');
  assert.strictEqual(n(ctx, 'get WS_Properties'), 2, 'the suspended flag was read from Airtable, not from a cache');
});

test('flag on: WS_Rates is read once and then served from the cache for later messages; flag off reads it every time', async () => {
  const on = setup('1');
  await say('hi'); await say('hi'); await say('hi');
  const off = setup(undefined);
  await say('hi'); await say('hi'); await say('hi');
  assert.strictEqual(n(on, 'get WS_Rates'), 1);
  assert.strictEqual(n(off, 'get WS_Rates'), 3);
});

test('flag on: a write to WS_Rates drops the cached rates', async () => {
  const ctx = setup('1');
  await say('hi');
  assert.strictEqual(n(ctx, 'get WS_Rates'), 1);
  await wh.airtableUpdate('WS_Rates', 'recRate', { Amount: 999 });
  await say('hi');
  assert.strictEqual(n(ctx, 'get WS_Rates'), 2);
});

test('flag on: a failed rates read is not cached — the next message reads again', async () => {
  const ctx = setup('1');
  const real = global.fetch;
  let failOnce = true;
  global.fetch = async (url, opts) => {
    if (failOnce && String(url).includes('/WS_Rates?')) { failOnce = false; return { status: 500, json: async () => ({ error: { type: 'SERVER_ERROR' } }) }; }
    return real(url, opts);
  };
  await say('hi');
  await say('hi');
  assert.strictEqual(failOnce, false);
  assert.strictEqual(n(ctx, 'get WS_Rates'), 2, 'the failure was not cached as an empty result');
});

test('the greeting reads WS_Rooms once with the flag on, twice with it off', async () => {
  const on = setup('1'); await say('hi');
  const off = setup(undefined); await say('hi');
  assert.strictEqual(n(on, 'get WS_Rooms'), 1);
  assert.strictEqual(n(off, 'get WS_Rooms'), 2);
});

test('the booking-confirmation step reads WS_Rooms once with the flag on, and WS_Bookings fresh every time (3 reads, as before)', async () => {
  const on = setup('1'); await throughDuration(on); on.counts = {}; await say('3');
  const off = setup(undefined); await throughDuration(off); off.counts = {}; await say('3');
  assert.strictEqual(n(off, 'get WS_Rooms'), 2);
  assert.strictEqual(n(on, 'get WS_Rooms'), 1);
  assert.strictEqual(n(on, 'get WS_Bookings'), n(off, 'get WS_Bookings'), 'bookings reads are never cached');
  assert.strictEqual(n(on, 'get WS_Bookings'), 3);
});

for (const flag of [undefined, '1']) {
  test(`double-booking guard holds (flag ${flag === undefined ? 'off' : 'on'}): a booking made between the first availability check and the re-check is seen`, async () => {
    let armed = false;
    let injected = false;
    const ctx = setup(flag, (c, kind, table, url) => {
      // after the first availability read of WS_Bookings (the 3-status OR formula) a rival books the only room
      if (armed && !injected && kind === 'get' && table === 'WS_Bookings' && decodeURIComponent(url).includes("'Checked In'")) {
        injected = true;
        const pending = c.airtable.tables.WS_Bookings[0];
        const ci = pending.fields['Check In'];
        const co = new Date(Date.parse(ci) + 4 * 3600000).toISOString();
        c.airtable.tables.WS_Bookings.push({ id: 'recRival', fields: { Guest: ['recOther'], Room: ['recR1'], 'Booking Type': 'Hourly', Status: 'Confirmed', 'Check In': ci, 'Check Out': co, 'Amount Due': 300 } });
      }
    });
    await throughDuration(ctx);
    armed = true;
    await say('3');
    assert.ok(injected, 'the rival booking was injected mid-message');
    const mine = ctx.airtable.tables.WS_Bookings.filter(b => b.id !== 'recRival');
    assert.ok(mine.every(b => b.fields.Status !== 'Confirmed'), 'the guest was not confirmed into a room that was just taken');
  });
}

test('flag on: room reads are request-scoped — a second message does not reuse the first message\'s room list', async () => {
  const ctx = setup('1');
  await say('hi'); await say('hi');
  assert.strictEqual(n(ctx, 'get WS_Rooms'), 2, 'one per message, not one per process');
});

test('flag on: cached rates expire after 30 seconds', async () => {
  const ctx = setup('1');
  const t0 = Date.now();
  mock.timers.enable({ apis: ['Date'], now: t0 });
  try {
    await say('hi');
    mock.timers.setTime(t0 + 29000);
    await say('hi');
    assert.strictEqual(n(ctx, 'get WS_Rates'), 1, 'still cached at 29 s');
    mock.timers.setTime(t0 + 31000);
    await say('hi');
    assert.strictEqual(n(ctx, 'get WS_Rates'), 2, 're-read after 31 s');
  } finally { mock.timers.reset(); }
});

test('flag on: even with no write in between, two availability checks in one message see a booking made between them (bookings are never cached)', async () => {
  const ctx = setup('1');
  const ci = new Date(Date.now() + 3600000).toISOString();
  const co = new Date(Date.now() + 4 * 3600000).toISOString();
  const [first, second] = await wh.runInRequestScope(async () => {
    const a = await wh.findAvailableRoom('recP1', ci, co);
    ctx.airtable.tables.WS_Bookings.push({ id: 'recRival', fields: { Guest: ['recOther'], Room: ['recR1'], 'Booking Type': 'Hourly', Status: 'Confirmed', 'Check In': ci, 'Check Out': co } });
    const b = await wh.findAvailableRoom('recP1', ci, co);
    return [a, b];
  });
  assert.ok(first, 'free at the first check');
  assert.strictEqual(second, null, 'taken at the second check');
  assert.strictEqual(n(ctx, 'get WS_Rooms'), 1, 'but the room list was read once');
  assert.strictEqual(n(ctx, 'get WS_Bookings'), 2);
});

test('flag on: resolveProperty reads Airtable every time even with no write in between (nothing about the property is cached)', async () => {
  const ctx = setup('1');
  await wh.resolveProperty('111000111000');
  ctx.airtable.tables.WS_Properties[0].fields['Subscription Status'] = 'Suspended';
  const second = await wh.resolveProperty('111000111000');
  assert.strictEqual(n(ctx, 'get WS_Properties'), 2);
  assert.strictEqual(second.fields['Subscription Status'], 'Suspended', 'the change is visible immediately');
});

test('flag on: a dropped connection on a cached read is thrown exactly as an uncached read would (the cache does not retry or hide it)', async () => {
  const ctx = setup('1');
  const real = global.fetch;
  let armed = true;
  let attempts = 0;
  global.fetch = async (url, opts) => { if (String(url).includes('/WS_Cleaners?')) { attempts++; if (armed) { armed = false; throw new Error('simulated outage'); } } return real(url, opts); };
  await say('hi');
  assert.strictEqual(ctx.axiom.filter(e => e.event === 'fatal').length, 1);
  assert.strictEqual(attempts, 1, 'one attempt was made and not repeated behind the scenes');
});

test('flag on: the rate that sets Amount Due is read fresh even when the same rate was cached a moment ago', async () => {
  const ctx = setup('1');
  await say('hi');                                 // greeting reads rates (cached)
  const ratesBefore = n(ctx, 'get WS_Rates');
  ctx.airtable.tables.WS_Guests[0] && (ctx.airtable.tables.WS_Guests[0].fields['Session State'] = 'AWAITING_DETAILS');
  await say('Jane Doe\n1 September 2099\n2 September 2099');   // overnight booking prices from Per Night
  assert.ok(n(ctx, 'get WS_Rates') > ratesBefore, 'the booking-time rate lookup went to Airtable');
});

test('flag on: a dropped connection on a cached RATES read is thrown too, not retried behind the scenes', async () => {
  const ctx = setup('1');
  const real = global.fetch;
  let attempts = 0;
  global.fetch = async (url, opts) => { if (String(url).includes('/WS_Rates?')) { attempts++; throw new Error('simulated outage'); } return real(url, opts); };
  await say('hi');
  assert.strictEqual(ctx.axiom.filter(e => e.event === 'fatal').length, 1);
  assert.strictEqual(attempts, 1);
});
