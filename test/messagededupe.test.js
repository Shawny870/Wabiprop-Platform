// test/messagededupe.test.js
// WABISTAY_MESSAGE_DEDUPE. The inbound WhatsApp message id is written to the guest's
// 'Last Message Id' before any side effect; a message whose id equals the stored id is
// skipped. No guest row = cannot be checked (accepted). Fails open on a write failure.
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
  const ctx = { airtable: new MockAirtable(seed(opts)), sends: [], axiom: [] };
  installFetch(ctx);
  return ctx;
}
async function deliver(text, id) {
  await wh({ method: 'POST', body: metaTextPayload(GUEST, text, id) }, makeRes());
}
const guestRow = ctx => ctx.airtable.tables['WS_Guests'][0].fields;
const events = (ctx, n) => ctx.axiom.filter(e => e.event === n);
const toGuest = ctx => ctx.sends.filter(s => s.to === GUEST);

test('flag on: the first delivery is processed and its id is stored before the reply', async () => {
  process.env.WABISTAY_MESSAGE_DEDUPE = '1';
  const ctx = start();
  await deliver('hello', 'wamid.AAA');
  assert.strictEqual(guestRow(ctx)['Last Message Id'], 'wamid.AAA');
  assert.strictEqual(toGuest(ctx).length, 1, 'processed (the confirmed menu)');
  assert.strictEqual(events(ctx, 'duplicate_message_skipped').length, 0);
});

test('flag on: a repeat delivery of the same id is skipped — no reply, no side effect, event logged', async () => {
  process.env.WABISTAY_MESSAGE_DEDUPE = '1';
  const ctx = start();
  await deliver('hello', 'wamid.AAA');
  const sendsAfterFirst = ctx.sends.length;
  // (The property activity stamp runs before the guest is read; it is idempotent and not counted.)
  const writes = () => ctx.airtable.log.filter(w => w.table !== 'WS_Properties').length;
  const writesAfterFirst = writes();
  await deliver('hello', 'wamid.AAA');
  assert.strictEqual(ctx.sends.length, sendsAfterFirst, 'nothing sent for the duplicate');
  assert.strictEqual(writes(), writesAfterFirst, 'no Airtable write for the duplicate');
  const ev = events(ctx, 'duplicate_message_skipped');
  assert.strictEqual(ev.length, 1);
  assert.strictEqual(ev[0].wamid, 'wamid.AAA');
});

test('flag on: a different id is processed and replaces the stored id', async () => {
  process.env.WABISTAY_MESSAGE_DEDUPE = '1';
  const ctx = start({ lastMessageId: 'wamid.AAA' });
  await deliver('hello', 'wamid.BBB');
  assert.strictEqual(toGuest(ctx).length, 1);
  assert.strictEqual(guestRow(ctx)['Last Message Id'], 'wamid.BBB');
  await deliver('hello', 'wamid.BBB');
  assert.strictEqual(toGuest(ctx).length, 1, 'and now BBB is the duplicate');
});

test('a real guest repeating the same words with a NEW id is not a duplicate', async () => {
  process.env.WABISTAY_MESSAGE_DEDUPE = '1';
  const ctx = start();
  await deliver('hello', 'wamid.AAA');
  await deliver('hello', 'wamid.AAB');
  assert.strictEqual(toGuest(ctx).length, 2);
  assert.strictEqual(events(ctx, 'duplicate_message_skipped').length, 0);
});

test('flag on, no guest row: cannot be checked, so it is processed (and no id is stored for a row that does not exist yet)', async () => {
  process.env.WABISTAY_MESSAGE_DEDUPE = '1';
  const ctx = start({ guest: false });
  await deliver('hi', 'wamid.NEW1');
  assert.ok(toGuest(ctx).length >= 1, 'greeted');
  assert.strictEqual(events(ctx, 'duplicate_message_skipped').length, 0);
  assert.ok(ctx.airtable.tables['WS_Guests'].every(g => g.fields['Last Message Id'] === undefined), 'no id stored');
});

test('flag on, the id write fails (Airtable error): fails OPEN — the message is processed and the failure logged', async () => {
  process.env.WABISTAY_MESSAGE_DEDUPE = '1';
  const ctx = start();
  const inner = global.fetch;
  global.fetch = async (url, init = {}) => {
    if (String(url).includes('api.airtable.com') && init.method === 'PATCH' && init.body && init.body.includes('Last Message Id')) {
      return { status: 422, ok: false, json: async () => ({ error: { type: 'UNKNOWN_FIELD_NAME', message: 'Unknown field name: "Last Message Id"' } }), text: async () => '' };
    }
    return inner(url, init);
  };
  await deliver('hello', 'wamid.AAA');
  assert.strictEqual(toGuest(ctx).length, 1, 'processed anyway');
  const ev = events(ctx, 'message_dedupe_write_failed');
  assert.strictEqual(ev.length, 1);
  assert.match(ev[0].error, /UNKNOWN_FIELD_NAME/);
});

test('flag on, the id write throws (network): fails OPEN too', async () => {
  process.env.WABISTAY_MESSAGE_DEDUPE = '1';
  const ctx = start();
  const inner = global.fetch;
  global.fetch = async (url, init = {}) => {
    if (String(url).includes('api.airtable.com') && init.method === 'PATCH' && init.body && init.body.includes('Last Message Id')) throw new Error('network down');
    return inner(url, init);
  };
  await deliver('hello', 'wamid.AAA');
  assert.strictEqual(toGuest(ctx).length, 1);
  assert.strictEqual(events(ctx, 'message_dedupe_write_failed').length, 1);
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
