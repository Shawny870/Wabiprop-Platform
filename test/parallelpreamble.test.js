// test/parallelpreamble.test.js
// WABISTAY_PARALLEL_PREAMBLE: the property, guest and cleaner lookups of an inbound message start together and
// the property's activity stamp runs alongside the guest read, but the request still waits for it. Off: the old
// sequence. No guest-state write moves, so WABISTAY_STATE_WRITE_GUARD still sees the result of the state write.

const { test, afterEach } = require('node:test');
const assert = require('node:assert');
const { installEnv, installFetch, makeRes, metaTextPayload, MockAirtable } = require('./harness');

installEnv();
const wh = require('../api/wabistay/webhook.js');
const ENV = ['WABISTAY_PARALLEL_PREAMBLE', 'WABISTAY_STATE_WRITE_GUARD'];
const saved = Object.fromEntries(ENV.map(k => [k, process.env[k]]));
afterEach(() => { for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

const PHONE = '27821234567';
function seed(over = {}) {
  return {
    WS_Properties: [{ id: 'recP1', fields: { 'Property Name': 'Villa Liza Guest Lodge', 'Phone Number ID': '111000111000', 'Notify Phone': '27732273477', 'Guest Redirect Phone': '0730260871' } }],
    WS_Rooms: [{ id: 'recR1', fields: { 'Room Name': 'Room 01', 'Status': 'Available', 'Property': ['recP1'], 'Active': true } }],
    WS_Rates: [], WS_Bookings: [], WS_Cleaners: [], WS_Enquiries: [], WS_Roles: [],
    WS_Guests: [{ id: 'recG1', fields: { 'Phone Number': PHONE, 'Guest Name': 'John', 'Session State': 'AWAITING_STAY_TYPE' } }],
    ...over
  };
}
// Every Airtable call takes `latency` ms; `events` records start/end order per call.
function setup(flag, { latency = 0, seedOver } = {}) {
  if (flag === undefined) delete process.env.WABISTAY_PARALLEL_PREAMBLE; else process.env.WABISTAY_PARALLEL_PREAMBLE = flag;
  const ctx = { airtable: new MockAirtable(seed(seedOver)), sends: [], axiom: [], events: [] };
  installFetch(ctx);
  const real = global.fetch;
  global.fetch = async (url, opts) => {
    const u = String(url);
    if (!u.includes('api.airtable.com')) return real(url, opts);
    const table = decodeURIComponent(u.split('/v0/')[1].split('/')[1].split('?')[0]);
    const kind = (opts && opts.method) === 'PATCH' ? 'update' : (opts && opts.method) === 'POST' ? 'create' : 'get';
    ctx.events.push('start ' + kind + ' ' + table);
    if (latency) await new Promise(r => setTimeout(r, latency));
    const res = await real(url, opts);
    ctx.events.push('end ' + kind + ' ' + table);
    return res;
  };
  return ctx;
}
const say = text => wh({ method: 'POST', body: metaTextPayload(PHONE, text) }, makeRes());
const idx = (ctx, e) => ctx.events.indexOf(e);

test('flag off: the lookups run one after another (property finishes before the guest read starts)', async () => {
  const ctx = setup(undefined, { latency: 20 });
  await say('1');
  assert.ok(idx(ctx, 'end get WS_Properties') < idx(ctx, 'start get WS_Guests'));
  assert.ok(idx(ctx, 'end update WS_Properties') < idx(ctx, 'start get WS_Guests'));
});

test('flag on: property, guest and cleaner lookups are all in flight before the first one finishes', async () => {
  const ctx = setup('1', { latency: 20 });
  await say('1');
  const firstEnd = Math.min(...ctx.events.map((e, i) => (e.startsWith('end ') ? i : Infinity)));
  for (const s of ['start get WS_Properties', 'start get WS_Guests', 'start get WS_Cleaners']) {
    assert.ok(idx(ctx, s) !== -1 && idx(ctx, s) < firstEnd, s + ' started before anything finished');
  }
});

test('flag on: the same reply is sent and the same writes are made as with the flag off', async () => {
  const off = setup(undefined); await say('1');
  const on = setup('1'); await say('1');
  assert.deepStrictEqual(on.sends.map(s => s.body), off.sends.map(s => s.body));
  const norm = ctx => ctx.airtable.log.map(l => `${l.op} ${l.table} ${Object.keys(l.fields).sort().join(',')}`).sort();
  assert.deepStrictEqual(norm(on), norm(off));
});

test('flag on: the preamble is measurably faster with realistic latency', async () => {
  const off = setup(undefined, { latency: 40 }); let t = Date.now(); await say('1'); const msOff = Date.now() - t;
  const on = setup('1', { latency: 40 }); t = Date.now(); await say('1'); const msOn = Date.now() - t;
  assert.ok(msOn <= msOff - 60, `on ${msOn} ms vs off ${msOff} ms`);
  void off; void on;
});

test('flag on: the activity stamp is finished before the handler returns — nothing is left running after the 200', async () => {
  const ctx = setup('1', { latency: 20 });
  await say('1');
  assert.ok(ctx.events.filter(e => e.startsWith('start')).length === ctx.events.filter(e => e.startsWith('end')).length, 'every call that started has ended');
  assert.ok(ctx.airtable.tables.WS_Properties[0].fields['Last Message Received'], 'stamp written');
});

test('flag on: an unconfigured number still gets the not-configured reply and no stamp is written', async () => {
  const ctx = setup('1');
  await wh({ method: 'POST', body: (() => { const p = metaTextPayload(PHONE, 'hi'); p.entry[0].changes[0].value.metadata.phone_number_id = '999'; return p; })() }, makeRes());
  assert.strictEqual(ctx.sends.length, 1);
  assert.ok(!ctx.airtable.log.some(l => l.table === 'WS_Properties'));
});

test('flag on: a network failure on the property lookup is handled like before (fatal logged, 200), with no unhandled rejection', async () => {
  const ctx = setup('1');
  const real = global.fetch;
  global.fetch = async (url, opts) => { if (String(url).includes('/WS_Properties?')) throw new Error('network down'); return real(url, opts); };
  const unhandled = [];
  const onUnhandled = e => unhandled.push(e);
  process.on('unhandledRejection', onUnhandled);
  const res = makeRes();
  await wh({ method: 'POST', body: metaTextPayload(PHONE, '1') }, res);
  await new Promise(r => setTimeout(r, 20));
  process.off('unhandledRejection', onUnhandled);
  assert.strictEqual(res.statusCode, 200);
  assert.ok(ctx.axiom.some(e => e.event === 'fatal'));
  assert.deepStrictEqual(unhandled, []);
});

test('flag on, STATE_WRITE_GUARD on: a failed AWAITING_PAYMENT_METHOD advance still stops before the quote and tells the guest (same as flag off)', async () => {
  process.env.WABISTAY_STATE_WRITE_GUARD = '1';
  for (const flag of [undefined, '1']) {
    const ctx = setup(flag, {
      seedOver: {
        WS_Rates: [{ id: 'recRate', fields: { 'Rate Name': 'Standard Night', 'Rate Type': 'Per Night', 'Amount': 600, 'Active': true, 'Property': ['recP1'] } }]
      }
    });
    ctx.airtable.tables.WS_Guests[0].fields['Session State'] = 'AWAITING_DETAILS';
    const inner = global.fetch;
    global.fetch = async (url, init = {}) => {
      if (String(url).includes('WS_Guests') && (init.method || '').toUpperCase() === 'PATCH' && JSON.parse(init.body).fields['Session State'] === 'AWAITING_PAYMENT_METHOD') {
        return { status: 422, ok: false, json: async () => ({ error: { type: 'INVALID_MULTIPLE_CHOICE_OPTIONS', message: 'no such option' } }), text: async () => '' };
      }
      return inner(url, init);
    };
    await say('Jane Doe\n1 September 2099\n2 September 2099');
    assert.strictEqual(ctx.axiom.filter(e => e.event === 'guest_state_write_guard_tripped').length, 1, 'flag ' + flag);
    assert.ok(ctx.sends.some(s => /something went wrong/.test(s.body)), 'guest told to speak to reception, flag ' + flag);
    assert.strictEqual(ctx.airtable.tables.WS_Bookings.length, 0, 'no booking written, flag ' + flag);
    assert.strictEqual(ctx.airtable.tables.WS_Guests[0].fields['Session State'], 'AWAITING_DETAILS');
  }
});

test('flag on: a slow stamp write is still finished when the handler returns (the request waits for it before answering Meta)', async () => {
  const ctx = setup('1');
  const real = global.fetch;
  let stampDone = false;
  global.fetch = async (url, opts) => {
    if (String(url).includes('/WS_Properties/') && opts && opts.method === 'PATCH') {
      await new Promise(r => setTimeout(r, 150));
      const res = await real(url, opts);
      stampDone = true;
      return res;
    }
    return real(url, opts);
  };
  await say('1');
  assert.strictEqual(stampDone, true, 'the 150 ms stamp had finished before the handler returned');
});

test('flag on: the cleaner lookup started at the top is shared — one WS_Cleaners read per message, not two', async () => {
  const ctx = setup('1');
  await say('1');
  assert.strictEqual(ctx.events.filter(e => e === 'start get WS_Cleaners').length, 1);
  const off = setup(undefined);
  await say('1');
  assert.ok(off.events.filter(e => e === 'start get WS_Cleaners').length >= 1);
});

test('flag on: a cleaner lookup that fails and is never awaited (unconfigured number) is not an unhandled rejection', async () => {
  const ctx = setup('1');
  const real = global.fetch;
  global.fetch = async (url, opts) => { if (String(url).includes('/WS_Cleaners?')) throw new Error('cleaners down'); return real(url, opts); };
  const unhandled = [];
  const onUnhandled = e => unhandled.push(e);
  process.on('unhandledRejection', onUnhandled);
  const p = metaTextPayload(PHONE, 'hi');
  p.entry[0].changes[0].value.metadata.phone_number_id = '999';
  await wh({ method: 'POST', body: p }, makeRes());
  await new Promise(r => setTimeout(r, 30));
  process.off('unhandledRejection', onUnhandled);
  assert.deepStrictEqual(unhandled, []);
  void ctx;
});

test('flag on: the guest read does not wait for the property read', async () => {
  const ctx = setup('1');
  const real = global.fetch;
  let propertyDone = false, guestStartedBeforePropertyDone = null;
  global.fetch = async (url, opts) => {
    const u = String(url);
    if (u.includes('/WS_Properties?')) { await new Promise(r => setTimeout(r, 80)); propertyDone = true; }
    if (u.includes('/WS_Guests?') && guestStartedBeforePropertyDone === null) guestStartedBeforePropertyDone = !propertyDone;
    return real(url, opts);
  };
  await say('1');
  assert.strictEqual(guestStartedBeforePropertyDone, true);
  void ctx;
});
