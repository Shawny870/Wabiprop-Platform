// test/success-logging.test.js
// Rule 30, step 1 — centralized success logging (visibility only).
//
// Before this: airtableUpdate, airtableCreate and sendWhatsApp logged FAILURE
// to Axiom (data.error present) but never logged success. "Did this write
// actually land" was answerable only by the absence of an error event —
// indistinguishable from Axiom itself being down (F32 lived in exactly this
// gap for weeks). sendWhatsAppTemplate already logged success correctly
// (whatsapp_template_sent, carrying the wamid); this brings the other three
// functions to the same standard, mirroring that exact shape.
//
// Deliberately NOT tested here: any handler checking these logs before
// proceeding to a dependent write. That's Rule 30 step 2 (PR 3/4) — this PR
// adds visibility only, and these tests only confirm the new log line fires
// with the right payload on success, and that failure logging (and the
// return value both branches rely on) is completely unchanged.

const { test } = require('node:test');
const assert = require('node:assert');
const { installEnv, installFetch, MockAirtable } = require('./harness');

installEnv();
const wh = require('../api/wabistay/webhook.js');

function setup(seed = {}) {
  const ctx = { airtable: new MockAirtable(seed), sends: [], axiom: [] };
  installFetch(ctx);
  return ctx;
}

const event = (ctx, name) => ctx.axiom.find(e => e.event === name);

// ── airtableCreate ──────────────────────────────────────────────────────────

test('airtableCreate logs airtable_create_success on a successful write, with table and the new record id', async () => {
  const ctx = setup();
  const record = await wh.airtableCreate('WS_Guests', { 'Guest Name': 'Jane Doe' });

  assert.ok(record.id, 'create still returns the record as before — unchanged return shape');
  const e = event(ctx, 'airtable_create_success');
  assert.ok(e, 'success event fired');
  assert.strictEqual(e.table, 'WS_Guests');
  assert.strictEqual(e.id, record.id);
  assert.strictEqual(event(ctx, 'airtable_create_error'), undefined, 'no error event on the success path');
});

// ── airtableUpdate ───────────────────────────────────────────────────────────

test('airtableUpdate logs airtable_update_success on a successful write, with table and recordId', async () => {
  const ctx = setup({ WS_Guests: [{ id: 'recG1', fields: { 'Guest Name': 'Jane Doe' } }] });
  const record = await wh.airtableUpdate('WS_Guests', 'recG1', { 'Guest Name': 'Jane Smith' });

  assert.strictEqual(record.fields['Guest Name'], 'Jane Smith', 'update still applies and returns as before');
  const e = event(ctx, 'airtable_update_success');
  assert.ok(e, 'success event fired');
  assert.strictEqual(e.table, 'WS_Guests');
  assert.strictEqual(e.recordId, 'recG1');
  assert.strictEqual(event(ctx, 'airtable_update_error'), undefined);
});

// ── sendWhatsApp ─────────────────────────────────────────────────────────────

test('sendWhatsApp logs whatsapp_sent on a successful send, with the recipient and wamid', async () => {
  const ctx = setup();
  const result = await wh.sendWhatsApp('27821234567', 'hello');

  assert.ok(result.messages, 'send still returns the raw Meta response as before — unchanged return shape');
  const e = event(ctx, 'whatsapp_sent');
  assert.ok(e, 'success event fired');
  assert.strictEqual(e.to, '27821234567');
  assert.ok(e.wamid, 'the join key to B3\'s whatsapp_status_callback events');
  assert.strictEqual(event(ctx, 'whatsapp_send_error'), undefined);
});

// ── Failure logging is completely unchanged ─────────────────────────────────
//
// These force each function's existing error branch and confirm nothing about
// it moved: same event name, same fields, and now ALSO confirm the new
// success event does NOT fire alongside it (the two branches are mutually
// exclusive, not both emitted).

function withOneShotFailure(ctx, { method, pathIncludes }) {
  const originalFetch = global.fetch;
  global.fetch = async (url, opts = {}) => {
    const u = new URL(url);
    // pathIncludes may name a hostname (graph.facebook.com) or a path segment
    // (WS_Guests/recG1) — check both, since URL.pathname alone excludes the host.
    if ((opts.method || 'GET').toUpperCase() === method && (u.pathname.includes(pathIncludes) || u.hostname.includes(pathIncludes))) {
      global.fetch = originalFetch; // one-shot
      return {
        status: 422, ok: false,
        json: async () => ({ error: { type: 'INVALID_REQUEST', message: 'simulated' } }),
        text: async () => 'simulated'
      };
    }
    return originalFetch(url, opts);
  };
}

test('airtableCreate: failure still logs airtable_create_error, unchanged, and does not also log success', async () => {
  const ctx = setup();
  withOneShotFailure(ctx, { method: 'POST', pathIncludes: 'WS_Guests' });

  const record = await wh.airtableCreate('WS_Guests', { 'Guest Name': 'Jane Doe' });

  assert.ok(record.error, 'the error body is still returned, unchanged');
  const errEvent = event(ctx, 'airtable_create_error');
  assert.ok(errEvent);
  assert.strictEqual(errEvent.table, 'WS_Guests');
  assert.strictEqual(event(ctx, 'airtable_create_success'), undefined, 'the two branches are mutually exclusive');
});

test('airtableUpdate: failure still logs airtable_update_error, unchanged, and does not also log success', async () => {
  const ctx = setup({ WS_Guests: [{ id: 'recG1', fields: {} }] });
  withOneShotFailure(ctx, { method: 'PATCH', pathIncludes: 'WS_Guests/recG1' });

  const result = await wh.airtableUpdate('WS_Guests', 'recG1', { 'Guest Name': 'Jane Smith' });

  assert.ok(result.error);
  assert.ok(event(ctx, 'airtable_update_error'));
  assert.strictEqual(event(ctx, 'airtable_update_success'), undefined);
});

test('sendWhatsApp: failure still logs whatsapp_send_error, unchanged, and does not also log success', async () => {
  const ctx = setup();
  withOneShotFailure(ctx, { method: 'POST', pathIncludes: 'graph.facebook.com' });

  const result = await wh.sendWhatsApp('27821234567', 'hello');

  assert.ok(result.error);
  assert.ok(event(ctx, 'whatsapp_send_error'));
  assert.strictEqual(event(ctx, 'whatsapp_sent'), undefined);
});
