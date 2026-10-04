// test/messagededupe.test.js
// WABISTAY_MESSAGE_DEDUPE. A message is skipped only when its id already equals the
// guest's stored 'Last Message Id'. The id is written ONLY AFTER the message has been
// handled, by one wrapper, and only if handling returned without throwing — an early
// write would make Meta's retry of a crashed message look like a duplicate and lose it.
// No guest row = cannot be checked (accepted). Fails open on a write failure.
// In-memory only: MockAirtable + mocked fetch.

const { test, afterEach } = require('node:test');
const assert = require('node:assert');
const { installEnv, installFetch, makeRes, metaTextPayload, MockAirtable } = require('./harness');

installEnv();
const saved = process.env.WABISTAY_MESSAGE_DEDUPE;
afterEach(() => { if (saved === undefined) delete process.env.WABISTAY_MESSAGE_DEDUPE; else process.env.WABISTAY_MESSAGE_DEDUPE = saved; });

const wh = require('../api/wabistay/webhook.js');
const GUEST = '27784896186';

function seed({ guest = true, lastMessageId } = {}) {
  return {
    WS_Properties: [{ id: 'recP1', fields: { 'Property Name': 'Canary Street Guest Rooms', 'Phone Number ID': '111000111000', 'Notify Phone': '27831112222' } }],
    WS_Rooms: [], WS_Rates: [], WS_Cleaners: [], WS_Roles: [], WS_Enquiries: [], WS_Bookings: [],
    WS_Guests: guest ? [{ id: 'recG1', fields: { 'Guest Name': 'Mama Test', 'Phone Number': GUEST, 'Session State': 'CONFIRMED', ...(lastMessageId ? { 'Last Message Id': lastMessageId } : {}) } }] : []
  };
}
function start(opts) {
  const ctx = { airtable: new MockAirtable(seed(opts)), sends: [], axiom: [], order: [] };
  installFetch(ctx);
  // Record the order of guest replies and Last Message Id stamps.
  const inner = global.fetch;
  global.fetch = async (url, init = {}) => {
    if (String(url).includes('graph.facebook.com')) ctx.order.push('send');
    if (String(url).includes('api.airtable.com') && init.method === 'PATCH' && init.body && init.body.includes('Last Message Id')) ctx.order.push('stamp');
    return inner(url, init);
  };
  ctx.baseFetch = global.fetch;
  return ctx;
}
async function deliver(text, id) {
  const res = makeRes();
  await wh({ method: 'POST', body: metaTextPayload(GUEST, text, id) }, res);
  return res;
}
// Make every WhatsApp send throw (a crash in the middle of handling, after the guest read).
function crashOnSend(ctx) {
  const inner = ctx.baseFetch;
  global.fetch = async (url, init = {}) => {
    if (String(url).includes('graph.facebook.com')) throw new Error('simulated crash mid-handling');
    return inner(url, init);
  };
}
const guestRow = ctx => ctx.airtable.tables['WS_Guests'][0].fields;
const events = (ctx, n) => ctx.axiom.filter(e => e.event === n);
const toGuest = ctx => ctx.sends.filter(s => s.to === GUEST);

test('flag on: a handled message is processed and its id is stored AFTER the reply, not before', async () => {
  process.env.WABISTAY_MESSAGE_DEDUPE = '1';
  const ctx = start();
  await deliver('hello', 'wamid.AAA');
  assert.strictEqual(guestRow(ctx)['Last Message Id'], 'wamid.AAA');
  assert.strictEqual(toGuest(ctx).length, 1, 'processed');
  assert.ok(ctx.order.indexOf('stamp') > ctx.order.lastIndexOf('send'), `stamp comes after every send: ${ctx.order.join(',')}`);
});

test('flag on: a retry AFTER success is skipped — no reply, no write, event logged', async () => {
  process.env.WABISTAY_MESSAGE_DEDUPE = '1';
  const ctx = start();
  await deliver('hello', 'wamid.AAA');
  const sendsAfterFirst = ctx.sends.length;
  const writes = () => ctx.airtable.log.filter(w => w.table !== 'WS_Properties').length; // (property activity stamp is idempotent, not counted)
  const writesAfterFirst = writes();
  await deliver('hello', 'wamid.AAA');
  assert.strictEqual(ctx.sends.length, sendsAfterFirst, 'nothing sent for the duplicate');
  assert.strictEqual(writes(), writesAfterFirst, 'no Airtable write for the duplicate');
  const ev = events(ctx, 'duplicate_message_skipped');
  assert.strictEqual(ev.length, 1);
  assert.strictEqual(ev[0].wamid, 'wamid.AAA');
});

test('flag on: a throw AFTER the guest read leaves the id UNWRITTEN, and the retry (same id) is processed', async () => {
  process.env.WABISTAY_MESSAGE_DEDUPE = '1';
  const ctx = start();
  crashOnSend(ctx);
  await deliver('hello', 'wamid.CRASH');
  assert.strictEqual(events(ctx, 'fatal').length, 1, 'the handler threw and the POST handler logged it');
  assert.strictEqual(guestRow(ctx)['Last Message Id'], undefined, 'id NOT written for a message that crashed');
  assert.strictEqual(ctx.order.includes('stamp'), false);

  // Meta retries the same message; this time nothing crashes.
  global.fetch = ctx.baseFetch;
  await deliver('hello', 'wamid.CRASH');
  assert.strictEqual(events(ctx, 'duplicate_message_skipped').length, 0, 'the retry is NOT treated as a duplicate');
  assert.strictEqual(toGuest(ctx).length, 1, 'the retry was processed and the guest got their reply');
  assert.strictEqual(guestRow(ctx)['Last Message Id'], 'wamid.CRASH', 'now it is stored');
});

test('flag on: a throw from an Airtable call mid-handling behaves the same (id unwritten, retry processes)', async () => {
  process.env.WABISTAY_MESSAGE_DEDUPE = '1';
  const ctx = start();
  const inner = ctx.baseFetch;
  let armed = true;
  global.fetch = async (url, init = {}) => {
    // CONFIRMED + a text message reaches showConfirmedMenu; make the room read blow up first by
    // throwing on the first Airtable GET after the guest read has happened.
    if (armed && String(url).includes('api.airtable.com') && (init.method || 'GET') === 'GET' && String(url).includes('WS_Cleaners')) {
      armed = false;
      throw new Error('simulated Airtable outage');
    }
    return inner(url, init);
  };
  await deliver('done', 'wamid.OUT');
  assert.strictEqual(guestRow(ctx)['Last Message Id'], undefined);
  assert.strictEqual(events(ctx, 'fatal').length, 1);
  global.fetch = inner;
  await deliver('done', 'wamid.OUT');
  assert.strictEqual(events(ctx, 'duplicate_message_skipped').length, 0);
  assert.strictEqual(guestRow(ctx)['Last Message Id'], 'wamid.OUT');
});

test('flag on: a different id is processed and replaces the stored id; the same new id is then the duplicate', async () => {
  process.env.WABISTAY_MESSAGE_DEDUPE = '1';
  const ctx = start({ lastMessageId: 'wamid.AAA' });
  await deliver('hello', 'wamid.BBB');
  assert.strictEqual(toGuest(ctx).length, 1);
  assert.strictEqual(guestRow(ctx)['Last Message Id'], 'wamid.BBB');
  await deliver('hello', 'wamid.BBB');
  assert.strictEqual(toGuest(ctx).length, 1, 'BBB is now the duplicate');
});

test('a real guest repeating the same words with a NEW id is not a duplicate', async () => {
  process.env.WABISTAY_MESSAGE_DEDUPE = '1';
  const ctx = start();
  await deliver('hello', 'wamid.AAA');
  await deliver('hello', 'wamid.AAB');
  assert.strictEqual(toGuest(ctx).length, 2);
  assert.strictEqual(events(ctx, 'duplicate_message_skipped').length, 0);
});

test('flag on, no guest row: cannot be checked, so it is processed (and no id is stored)', async () => {
  process.env.WABISTAY_MESSAGE_DEDUPE = '1';
  const ctx = start({ guest: false });
  await deliver('hi', 'wamid.NEW1');
  assert.ok(toGuest(ctx).length >= 1, 'greeted');
  assert.strictEqual(events(ctx, 'duplicate_message_skipped').length, 0);
  assert.ok(ctx.airtable.tables['WS_Guests'].every(g => g.fields['Last Message Id'] === undefined), 'no id stored');
});

test('flag on, the id write fails (Airtable error): fails OPEN — the message was processed and the failure is logged', async () => {
  process.env.WABISTAY_MESSAGE_DEDUPE = '1';
  const ctx = start();
  const inner = ctx.baseFetch;
  global.fetch = async (url, init = {}) => {
    if (String(url).includes('api.airtable.com') && init.method === 'PATCH' && init.body && init.body.includes('Last Message Id')) {
      return { status: 422, ok: false, json: async () => ({ error: { type: 'UNKNOWN_FIELD_NAME', message: 'Unknown field name: "Last Message Id"' } }), text: async () => '' };
    }
    return inner(url, init);
  };
  await deliver('hello', 'wamid.AAA');
  assert.strictEqual(toGuest(ctx).length, 1, 'processed');
  assert.strictEqual(events(ctx, 'fatal').length, 0, 'a failed stamp is not a failed message');
  const ev = events(ctx, 'message_dedupe_write_failed');
  assert.strictEqual(ev.length, 1);
  assert.match(ev[0].error, /UNKNOWN_FIELD_NAME/);
});

test('flag on, the id write throws (network): fails OPEN too', async () => {
  process.env.WABISTAY_MESSAGE_DEDUPE = '1';
  const ctx = start();
  const inner = ctx.baseFetch;
  global.fetch = async (url, init = {}) => {
    if (String(url).includes('api.airtable.com') && init.method === 'PATCH' && init.body && init.body.includes('Last Message Id')) throw new Error('network down');
    return inner(url, init);
  };
  await deliver('hello', 'wamid.AAA');
  assert.strictEqual(toGuest(ctx).length, 1);
  assert.strictEqual(events(ctx, 'message_dedupe_write_failed').length, 1);
  assert.strictEqual(events(ctx, 'fatal').length, 0);
});

test('a message handled to an early return (no property for the number) stores nothing', async () => {
  process.env.WABISTAY_MESSAGE_DEDUPE = '1';
  const ctx = start();
  const payload = metaTextPayload(GUEST, 'hello', 'wamid.NOPROP');
  payload.entry[0].changes[0].value.metadata.phone_number_id = '999999';
  await wh({ method: 'POST', body: payload }, makeRes());
  assert.strictEqual(guestRow(ctx)['Last Message Id'], undefined);
});

test('flag off: nothing is stored and a repeat delivery is processed twice (today)', async () => {
  delete process.env.WABISTAY_MESSAGE_DEDUPE;
  const ctx = start();
  await deliver('hello', 'wamid.AAA');
  await deliver('hello', 'wamid.AAA');
  assert.strictEqual(guestRow(ctx)['Last Message Id'], undefined);
  assert.strictEqual(toGuest(ctx).length, 2);
  assert.strictEqual(events(ctx, 'duplicate_message_skipped').length, 0);
});

test('flag values: only 1/true turn it on', async () => {
  for (const [flag, on] of [['1', true], ['true', true], ['yes', false], ['0', false]]) {
    process.env.WABISTAY_MESSAGE_DEDUPE = flag;
    const ctx = start();
    await deliver('hello', 'wamid.AAA');
    assert.strictEqual(guestRow(ctx)['Last Message Id'] === 'wamid.AAA', on, flag);
  }
});
