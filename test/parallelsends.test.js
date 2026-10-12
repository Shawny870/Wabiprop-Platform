// test/parallelsends.test.js
// WABISTAY_PARALLEL_SENDS: the owner alert and the guest's confirmation start together and are both awaited before
// the handler returns. WABISTAY_WA_PREWARM: a HEAD request opens the WhatsApp connection at the start of a message.

const { test, afterEach } = require('node:test');
const assert = require('node:assert');
const { installEnv, installFetch, makeRes, metaTextPayload, MockAirtable } = require('./harness');

installEnv();
const wh = require('../api/wabistay/webhook.js');
const ENV = ['WABISTAY_PARALLEL_SENDS', 'WABISTAY_WA_PREWARM', 'WABISTAY_INTERACTIVE'];
const saved = Object.fromEntries(ENV.map(k => [k, process.env[k]]));
const OTHERS = ['WABISTAY_ACTIVITY_THROTTLE', 'WABISTAY_READ_CACHE', 'WABISTAY_PARALLEL_PREAMBLE', 'WABISTAY_TIMING_LOG', 'WABISTAY_AIRTABLE_RETRY'];
const savedOthers = Object.fromEntries(OTHERS.map(k => [k, process.env[k]]));
for (const k of OTHERS) delete process.env[k];
require('node:test').after(() => { for (const k of OTHERS) { if (savedOthers[k] === undefined) delete process.env[k]; else process.env[k] = savedOthers[k]; } });
afterEach(() => { for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

const PHONE = '27821234567';
const OWNER = '27830000001'; // OWNER_PHONE: with WABISTAY_NOTIFY_ROUTING off the new-booking alert goes there
function seed(guestState = 'AWAITING_HOURLY_DURATION') {
  const ci = new Date(Date.now() + 3600000).toISOString();
  return {
    WS_Properties: [{ id: 'recP1', fields: { 'Property Name': 'Villa Liza Guest Lodge', 'Phone Number ID': '111000111000', 'Notify Phone': OWNER, 'Hourly Rate 1hr': 120, 'Hourly Rate 2hr': 250, 'Hourly Rate 3hr': 320 } }],
    WS_Rooms: [{ id: 'recR1', fields: { 'Room Name': 'Room 01', 'Room Number': 1, 'Status': 'Available', 'Property': ['recP1'], 'Active': true } }],
    WS_Rates: [{ id: 'recRate', fields: { 'Rate Type': 'Per Night', 'Amount': 600, 'Active': true, 'Property': ['recP1'] } }],
    WS_Bookings: guestState === 'AWAITING_HOURLY_DURATION'
      ? [{ id: 'recB1', fields: { Guest: ['recG1'], 'Booking Type': 'Hourly', Status: 'Enquiry', 'Check In': ci, 'Payment Status': 'Unpaid' } }] : [],
    WS_Cleaners: [], WS_Enquiries: [], WS_Roles: [],
    WS_Guests: [{ id: 'recG1', fields: { 'Phone Number': PHONE, 'Guest Name': 'John', 'Session State': guestState } }]
  };
}
// latency applies to every graph.facebook.com call; events record start/end per recipient.
function setup(flags, { latency = 0, guestState, ownerFails = false, guestFails = false, headMs = 0 } = {}) {
  for (const k of ENV) delete process.env[k];
  Object.assign(process.env, flags);
  const ctx = { airtable: new MockAirtable(seed(guestState)), sends: [], axiom: [], events: [] };
  installFetch(ctx);
  const real = global.fetch;
  global.fetch = async (url, opts = {}) => {
    const u = new URL(url);
    if (u.hostname !== 'graph.facebook.com') return real(url, opts);
    if (opts.method === 'HEAD') {
      ctx.events.push('start head');
      if (headMs) await new Promise((res, rej) => { const t = setTimeout(res, headMs); opts.signal && opts.signal.addEventListener('abort', () => { clearTimeout(t); rej(new Error('aborted')); }); });
      const r = await real(url, opts);
      ctx.events.push('end head');
      return r;
    }
    const body = JSON.parse(opts.body);
    const who = body.to === OWNER ? 'owner' : 'guest';
    ctx.events.push(`start ${who} ${body.type}`);
    if (latency) await new Promise(r => setTimeout(r, latency));
    if ((who === 'owner' && ownerFails) || (who === 'guest' && guestFails && body.type === 'text')) {
      ctx.events.push(`end ${who} ${body.type}`);
      if (who === 'guest') throw new Error('guest send blew up');
      return { status: 400, json: async () => ({ error: { message: 'owner send rejected', code: 131047 } }) };
    }
    const r = await real(url, opts);
    ctx.events.push(`end ${who} ${body.type}`);
    return r;
  };
  return ctx;
}
const say = text => wh({ method: 'POST', body: metaTextPayload(PHONE, text) }, makeRes());
const idx = (ctx, e) => ctx.events.indexOf(e);
const guestTexts = ctx => ctx.sends.filter(s => s.to === PHONE).map(s => s.body || '');

test('flag off: the owner alert finishes before the guest\'s confirmation starts', async () => {
  const ctx = setup({}, { latency: 20 });
  await say('3');
  assert.ok(idx(ctx, 'end owner text') !== -1 && idx(ctx, 'start guest text') !== -1);
  assert.ok(idx(ctx, 'end owner text') < idx(ctx, 'start guest text'));
});

test('flag on: the owner alert and the guest confirmation are both in flight before either finishes', async () => {
  const ctx = setup({ WABISTAY_PARALLEL_SENDS: '1' }, { latency: 30 });
  await say('3');
  const firstEnd = Math.min(...['end owner text', 'end guest text'].map(e => idx(ctx, e)).filter(i => i !== -1));
  assert.ok(idx(ctx, 'start owner text') < firstEnd && idx(ctx, 'start guest text') < firstEnd);
});

test('flag on: both are finished when the handler returns, even a slow owner alert (nothing is left running after the 200)', async () => {
  const ctx = setup({ WABISTAY_PARALLEL_SENDS: '1' }, { latency: 0 });
  const real = global.fetch;
  let ownerDone = false;
  global.fetch = async (url, opts = {}) => {
    if (opts.body && String(opts.body).includes(`"to":"${OWNER}"`)) { await new Promise(r => setTimeout(r, 200)); const r = await real(url, opts); ownerDone = true; return r; }
    return real(url, opts);
  };
  await say('3');
  assert.strictEqual(ownerDone, true);
});

test('flag on: the guest gets the same messages in the same order as with the flag off (confirmation, then the payment menu)', async () => {
  const off = setup({}); await say('3');
  const on = setup({ WABISTAY_PARALLEL_SENDS: '1' }); await say('3');
  assert.deepStrictEqual(guestTexts(on), guestTexts(off));
  assert.ok(guestTexts(on).length >= 2 && /booked|received|confirm/i.test(guestTexts(on)[0]));
  const owner = c => c.sends.filter(s => s.to === OWNER).map(s => s.body);
  assert.deepStrictEqual(owner(on), owner(off));
  const norm = c => c.airtable.log.map(l => `${l.op} ${l.table} ${Object.keys(l.fields).sort().join(',')}`).sort();
  assert.deepStrictEqual(norm(on), norm(off));
});

test('flag on: a rejected owner alert is logged as before and the guest is still confirmed', async () => {
  const ctx = setup({ WABISTAY_PARALLEL_SENDS: '1' }, { ownerFails: true });
  await say('3');
  assert.ok(ctx.axiom.some(e => e.event === 'owner_hourly_booking_notify_failed'));
  assert.ok(guestTexts(ctx).length >= 2);
});

test('flag on: a failing guest send still raises (handler fatal), and only after the owner alert has completed', async () => {
  const ctx = setup({ WABISTAY_PARALLEL_SENDS: '1' }, { guestFails: true, latency: 40 });
  await say('3');
  assert.ok(ctx.axiom.some(e => e.event === 'fatal'));
  assert.ok(idx(ctx, 'end owner text') !== -1, 'the owner alert was not abandoned half-way');
});

test('flag on: the booking step is faster by about one send round trip', async () => {
  const off = setup({}, { latency: 80 }); let t = Date.now(); await say('3'); const msOff = Date.now() - t;
  const on = setup({ WABISTAY_PARALLEL_SENDS: '1' }, { latency: 80 }); t = Date.now(); await say('3'); const msOn = Date.now() - t;
  assert.ok(msOn <= msOff - 50, `on ${msOn} ms vs off ${msOff} ms`);
  void off; void on;
});

test('overnight booking step: same guest messages and writes with the flag on, owner alert still sent', async () => {
  const run = async flags => {
    const ctx = setup(flags, { guestState: 'AWAITING_DETAILS' });
    await say('Jane Doe\n1 September 2099\n2 September 2099');
    return ctx;
  };
  const off = await run({});
  const on = await run({ WABISTAY_PARALLEL_SENDS: '1' });
  assert.deepStrictEqual(guestTexts(on), guestTexts(off));
  assert.ok(guestTexts(on).length >= 2);
  assert.strictEqual(on.sends.filter(s => s.to === OWNER).length, off.sends.filter(s => s.to === OWNER).length);
  assert.ok(on.sends.filter(s => s.to === OWNER).length >= 1);
});

test('prewarm: flag on sends one HEAD per message at the start; flag off sends none', async () => {
  const on = setup({ WABISTAY_WA_PREWARM: '1' }); await say('hi');
  const off = setup({}); await say('hi');
  assert.strictEqual(on.prewarms, 1);
  assert.strictEqual(off.prewarms || 0, 0);
  assert.strictEqual(on.events[0], 'start head', 'it is the first thing the message does');
});

test('prewarm: a slow warm-up is finished before the handler returns; a failing one is ignored', async () => {
  const slow = setup({ WABISTAY_WA_PREWARM: '1' }, { headMs: 150 });
  await say('hi');
  assert.ok(idx(slow, 'end head') !== -1, 'the 150 ms warm-up had completed');
  const failing = setup({ WABISTAY_WA_PREWARM: '1' });
  const real = global.fetch;
  global.fetch = async (url, opts = {}) => { if (opts.method === 'HEAD') throw new Error('network down'); return real(url, opts); };
  const res = makeRes();
  await wh({ method: 'POST', body: metaTextPayload(PHONE, 'hi') }, res);
  assert.strictEqual(res.statusCode, 200);
  assert.ok(failing.sends.some(s => s.to === PHONE), 'the guest was still answered');
});

test('prewarm: a warm-up that never answers cannot hold the message for more than about 1.5 s', { timeout: 8000 }, async () => {
  const ctx = setup({ WABISTAY_WA_PREWARM: '1' }, { headMs: 60000 });
  const t = Date.now();
  await say('hi');
  assert.ok(Date.now() - t < 3500, `returned in ${Date.now() - t} ms`);
  void ctx;
});

test('prewarm: a warm-up that fails early is not an unhandled rejection', async () => {
  const ctx = setup({ WABISTAY_WA_PREWARM: '1' }, { latency: 30 });
  const real = global.fetch;
  global.fetch = async (url, opts = {}) => { if (opts.method === 'HEAD') throw new Error('network down'); return real(url, opts); };
  const unhandled = [];
  const onUnhandled = e => unhandled.push(e);
  process.on('unhandledRejection', onUnhandled);
  await say('hi');
  await new Promise(r => setTimeout(r, 30));
  process.off('unhandledRejection', onUnhandled);
  assert.deepStrictEqual(unhandled, []);
  void ctx;
});

test('an owner send that throws (network) is raised either way: off = before the guest is told, on = after the guest was told, never lost', async () => {
  for (const [flags, guestToldBeforeRaise] of [[{}, false], [{ WABISTAY_PARALLEL_SENDS: '1' }, true]]) {
    const ctx = setup(flags);
    const real = global.fetch;
    global.fetch = async (url, opts = {}) => { if (opts.body && String(opts.body).includes(`"to":"${OWNER}"`)) throw new Error('owner send blew up'); return real(url, opts); };
    await say('3');
    assert.ok(ctx.axiom.some(e => e.event === 'fatal'), 'raised: ' + JSON.stringify(flags));
    assert.strictEqual(guestTexts(ctx).length > 0, guestToldBeforeRaise, JSON.stringify(flags));
  }
});
