// test/cleanergate.test.js
// Cleaner gate-arrival notification — the paths a replay fixture cannot reach.
//
// fixtures/65 covers the configured (post-Meta-approval) happy path. What it
// cannot cover is the states that produce NO send: the template being
// unconfigured, no cleaner being assigned, and Meta rejecting the template. Those
// are exactly the states that used to be invisible, so they are asserted here on
// their Axiom evidence — every one of them must name the booking it failed for.
// Run: node --test

const { test } = require('node:test');
const assert = require('node:assert');
const { installEnv, installFetch, MockAirtable, metaTextPayload, makeRes, TEST_ENV } = require('./harness');

installEnv();
const wh = require('../api/wabistay/webhook.js');

const TEMPLATE_ENV = 'WABISTAY_CLEANER_GATE_TEMPLATE';
const TEMPLATE_NAME = 'wabistay_cleaner_gate_arrival';

const propertyA = { id: 'recP1', fields: { 'Property Name': 'Test Lodge', 'Phone Number ID': TEST_ENV.WA_PHONE_NUMBER_ID, 'Notify Phone': '27831112222' } };
const propertyB = { id: 'recP2', fields: { 'Property Name': 'Other Lodge', 'Phone Number ID': '222000222000', 'Notify Phone': '27839998888' } };
const room = { id: 'recR1', fields: { 'Room Name': 'Room 1', 'Status': 'Available', 'Property': ['recP1'] } };
const guest = { id: 'recG1', fields: { 'Guest Name': 'John Smith', 'Phone Number': '27821234567', 'Session State': 'CONFIRMED' } };
const booking = { id: 'recB1', fields: { Guest: ['recG1'], Status: 'Confirmed' } };
const cleanerA = { id: 'recC1', fields: { 'Cleaner Name': 'Thandi', 'Phone Number': '0821110000', Active: true, 'Assigned Property': ['recP1'] } };
const cleanerB = { id: 'recC2', fields: { 'Cleaner Name': 'Sipho', 'Phone Number': '27829990000', Active: true, 'Assigned Property': ['recP2'] } };

function seedWith(cleaners) {
  return {
    WS_Properties: [propertyA, propertyB],
    WS_Rooms: [room],
    WS_Guests: [guest],
    WS_Bookings: [booking],
    WS_Cleaners: cleaners
  };
}

// Drives a real gate arrival ("1" from a CONFIRMED guest) through the full
// handler, so the notification is reached the way production reaches it.
async function arriveAtGate(seed, { template, metaError } = {}) {
  const ctx = { airtable: new MockAirtable(seed), sends: [], axiom: [] };
  installFetch(ctx);

  if (metaError) {
    const base = global.fetch;
    global.fetch = async (url, opts = {}) => {
      if (new URL(url).hostname === 'graph.facebook.com') {
        const body = JSON.parse(opts.body);
        // Record the attempt so "did we even try" stays distinguishable from
        // "we tried and Meta refused" — the distinction the diagnosis turned on.
        ctx.sends.push({ to: body.to, type: body.type, rejected: true });
        return { status: 400, ok: false, json: async () => ({ error: metaError }), text: async () => '' };
      }
      return base(url, opts);
    };
  }

  const previous = process.env[TEMPLATE_ENV];
  if (template) process.env[TEMPLATE_ENV] = template;
  else delete process.env[TEMPLATE_ENV];

  try {
    const res = makeRes();
    await wh({ method: 'POST', body: metaTextPayload('27821234567', '1') }, res);
    await new Promise(r => setImmediate(r)); // let fire-and-forget Axiom logs land
    return ctx;
  } finally {
    if (previous === undefined) delete process.env[TEMPLATE_ENV];
    else process.env[TEMPLATE_ENV] = previous;
  }
}

const axiomEvents = ctx => ctx.axiom.map(e => e.event);
const findEvent = (ctx, name) => ctx.axiom.find(e => e.event === name);

test('template unconfigured: no template send, and the skip is logged against the booking', async () => {
  const ctx = await arriveAtGate(seedWith([cleanerA, cleanerB]), { template: null });

  // Owner + guest only. Critically, NO free-form fallback to the cleaner: that
  // would 200-and-vanish outside the 24h window, which is the bug being fixed.
  assert.strictEqual(ctx.sends.length, 2, `sends: ${JSON.stringify(ctx.sends)}`);
  assert.deepStrictEqual(ctx.sends.map(s => s.to), ['27831112222', '27821234567']);
  assert.ok(!ctx.sends.some(s => s.type === 'template'), 'no template send while unconfigured');

  const stub = findEvent(ctx, 'cleaner_gate_notify_stubbed');
  assert.ok(stub, `expected cleaner_gate_notify_stubbed, got ${axiomEvents(ctx)}`);
  assert.strictEqual(stub.bookingId, 'recB1', 'stub log names the booking');
  assert.strictEqual(stub.to, '27821110000', 'stub log records the normalised number it would have used');
  assert.strictEqual(stub.cleanerId, 'recC1');
  assert.deepStrictEqual(stub.params, ['Thandi', 'John Smith', 'Room 1', 'Test Lodge']);
});

test('configured: only the booking property\'s cleaner is sent the template', async () => {
  const ctx = await arriveAtGate(seedWith([cleanerA, cleanerB]), { template: TEMPLATE_NAME });

  const templates = ctx.sends.filter(s => s.type === 'template');
  assert.strictEqual(templates.length, 1, `one template send, got ${JSON.stringify(ctx.sends)}`);
  assert.strictEqual(templates[0].to, '27821110000', '0-prefixed number normalised to 27');
  assert.strictEqual(templates[0].template, TEMPLATE_NAME);
  assert.deepStrictEqual(templates[0].params, ['Thandi', 'John Smith', 'Room 1', 'Test Lodge']);

  // Property B's cleaner asserted absent explicitly, not merely implied by count —
  // the fixture-61 exclusion pattern. Two ACTIVE cleaners are seeded, so only
  // property scoping can exclude Sipho.
  assert.ok(!ctx.sends.some(s => s.to === '27829990000'), `property B cleaner notified: ${JSON.stringify(ctx.sends)}`);

  // The owner send is unchanged and still first — this is in addition to it.
  assert.strictEqual(ctx.sends[0].to, '27831112222');
  assert.strictEqual(ctx.sends[0].type, 'text');
});

test('no cleaner assigned to the property: logged loudly against the booking, not silent', async () => {
  // Only property B has a cleaner, so property A's arrival resolves nobody.
  const ctx = await arriveAtGate(seedWith([cleanerB]), { template: TEMPLATE_NAME });

  assert.ok(!ctx.sends.some(s => s.type === 'template'), 'nobody is notified');
  const miss = findEvent(ctx, 'cleaner_gate_notify_no_cleaner');
  assert.ok(miss, `expected cleaner_gate_notify_no_cleaner, got ${axiomEvents(ctx)}`);
  assert.strictEqual(miss.bookingId, 'recB1');
  assert.strictEqual(miss.propertyId, 'recP1');
});

test('Meta rejects the template (131047): surfaces as a booking-correlated failure', async () => {
  const ctx = await arriveAtGate(seedWith([cleanerA]), {
    template: TEMPLATE_NAME,
    metaError: { code: 131047, message: 'Re-engagement message', type: 'OAuthException' }
  });

  // The send was attempted — this is NOT the "never sent" case.
  assert.ok(ctx.sends.some(s => s.type === 'template' && s.rejected), 'template send attempted');

  const sendErr = findEvent(ctx, 'whatsapp_template_send_error');
  assert.ok(sendErr, `expected whatsapp_template_send_error, got ${axiomEvents(ctx)}`);
  assert.strictEqual(sendErr.reEngagementRejected, true, '131047 flagged as the re-engagement rejection');
  assert.strictEqual(sendErr.bookingId, 'recB1', 'helper carries caller correlation into the error');

  // The whole point: an operator can ask "which bookings had no cleaner told?"
  const failed = findEvent(ctx, 'cleaner_gate_notify_failed');
  assert.ok(failed, `expected cleaner_gate_notify_failed, got ${axiomEvents(ctx)}`);
  assert.strictEqual(failed.bookingId, 'recB1');
  assert.strictEqual(failed.cleanerId, 'recC1');
  assert.strictEqual(failed.site, 'gate_arrival');
});

test('successful template send logs the wamid, the join key to B3 delivery callbacks', async () => {
  const ctx = await arriveAtGate(seedWith([cleanerA]), { template: TEMPLATE_NAME });

  const sent = findEvent(ctx, 'whatsapp_template_sent');
  assert.ok(sent, `expected whatsapp_template_sent, got ${axiomEvents(ctx)}`);
  assert.strictEqual(sent.wamid, 'wamid.test', 'wamid recorded for status-callback correlation');
  assert.strictEqual(sent.bookingId, 'recB1');
  assert.strictEqual(sent.template, TEMPLATE_NAME);
});
