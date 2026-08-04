// test/hmac.test.js
// B1 — Meta webhook signature verification (X-Hub-Signature-256).
//
// These drive lib/hmac.js directly AND through the real router, because the two
// failure modes that matter live in different places: the digest logic is in the
// lib, but "does a bad signature actually stop the handler running" is only
// answerable at the router. A test that only checked the lib would pass while
// production forwarded forged traffic straight to a product handler.
//
// The mutation these are written against: flipping the default HMAC_MODE from
// 'log' to 'enforce' must make the default-mode pass-through tests fail. If it
// doesn't, the safe-deploy guarantee isn't real.

const { test } = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { installEnv, makeRes, installFetch, MockAirtable } = require('./harness');

installEnv();
const { readRawBody, verifySignature } = require('../lib/hmac');
const router = require('../api/webhook.js');

const SECRET = 'test_app_secret_do_not_use_in_prod';

function payload(phoneNumberId = '1157302750805659', from = '27821234567', text = 'Hi') {
  return {
    object: 'whatsapp_business_account',
    entry: [{
      id: 'WABA_TEST',
      changes: [{
        field: 'messages',
        value: {
          messaging_product: 'whatsapp',
          metadata: { display_phone_number: '27000000000', phone_number_id: phoneNumberId },
          contacts: [{ profile: { name: 'Test' }, wa_id: from }],
          messages: [{ from, id: 'wamid.incoming.test', timestamp: '1750000000', type: 'text', text: { body: text } }]
        }
      }]
    }]
  };
}

function sign(rawBuf, secret = SECRET) {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(rawBuf).digest('hex');
}

// A request carrying genuine raw bytes, the way Vercel delivers one once the
// body parser is off. rawBody is what Meta actually signed.
function signedReq(body, { secret = SECRET, tamper = false, header = undefined } = {}) {
  const raw = Buffer.from(JSON.stringify(body), 'utf8');
  const sig = header !== undefined ? header : sign(tamper ? Buffer.from(raw.toString() + ' ') : raw, secret);
  return {
    method: 'POST',
    rawBody: raw,
    headers: sig === null ? {} : { 'x-hub-signature-256': sig }
  };
}

// MUST await fn() inside the try: `return fn()` would hand back a pending promise
// and run the finally — restoring the env — before the assertions ever execute,
// so every mode test would silently run against the ambient environment instead
// of the one it set up.
async function withEnv(vars, fn) {
  const saved = {};
  for (const [k, v] of Object.entries(vars)) {
    saved[k] = process.env[k];
    if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
  try { return await fn(); } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
}

function seededCtx() {
  return {
    airtable: new MockAirtable({
      WS_Properties: [{
        id: 'recP1',
        fields: { 'Property Name': 'Villa Liza Guest Lodge', 'Phone Number ID': '1157302750805659', 'Notify Phone': '27831112222' }
      }],
      WS_Rooms: [{ id: 'recR1', fields: { 'Room Name': 'Room 1', Status: 'Available', Property: ['recP1'] } }],
      WS_Rates: [{ id: 'recRATE1', fields: { 'Rate Name': 'Standard Overnight', 'Rate Type': 'Per Night', Amount: 350, Active: true, Property: ['recP1'] } }],
      WS_Guests: [],
      WS_Cleaners: []
    }),
    sends: [],
    axiom: []
  };
}

// ─── DIGEST LOGIC ────────────────────────────────────────────────────────────

test('B1: a genuine Meta signature over the raw bytes verifies', async () => {
  await withEnv({ META_APP_SECRET: SECRET, HMAC_MODE: 'enforce' }, async () => {
    const req = signedReq(payload());
    const { raw } = await readRawBody(req);
    const v = verifySignature(req, raw);
    assert.strictEqual(v.ok, true, 'signature verifies');
    assert.strictEqual(v.reject, false, 'valid traffic is never rejected');
    assert.strictEqual(v.reason, 'verified');
  });
});

test('B1: a tampered body fails verification — this is the whole point', async () => {
  await withEnv({ META_APP_SECRET: SECRET, HMAC_MODE: 'enforce' }, async () => {
    const req = signedReq(payload(), { tamper: true });
    const { raw } = await readRawBody(req);
    const v = verifySignature(req, raw);
    assert.strictEqual(v.ok, false, 'digest over different bytes must not match');
    assert.strictEqual(v.reject, true, 'enforce mode rejects');
    assert.strictEqual(v.reason, 'signature_mismatch');
  });
});

test('B1: a signature made with the wrong secret fails', async () => {
  await withEnv({ META_APP_SECRET: SECRET, HMAC_MODE: 'enforce' }, async () => {
    const req = signedReq(payload(), { secret: 'attacker_guess' });
    const { raw } = await readRawBody(req);
    assert.strictEqual(verifySignature(req, raw).ok, false);
  });
});

test('B1: re-serialising the parsed body is NOT accepted as raw — no false verification', async () => {
  // The trap this guards: JSON.stringify(req.body) round-trips to different bytes
  // than Meta signed. If readRawBody ever fell back to re-serialising, this would
  // report 'verified' and the gate would be decorative.
  await withEnv({ META_APP_SECRET: SECRET, HMAC_MODE: 'enforce' }, async () => {
    const body = payload();
    const req = {
      method: 'POST',
      body,                                   // parsed only — no rawBody, no stream
      headers: { 'x-hub-signature-256': sign(Buffer.from(JSON.stringify(body), 'utf8')) }
    };
    const { raw } = await readRawBody(req);
    assert.strictEqual(raw, null, 'raw bytes are reported ABSENT, not reconstructed');
    const v = verifySignature(req, raw);
    assert.strictEqual(v.ok, null, 'verdict is "cannot verify", never "verified"');
    assert.strictEqual(v.reason, 'no_raw_body');
    assert.strictEqual(v.reject, true, 'enforce mode fails CLOSED when it cannot verify');
  });
});

test('B1: a missing signature header is refused in enforce mode', async () => {
  await withEnv({ META_APP_SECRET: SECRET, HMAC_MODE: 'enforce' }, async () => {
    const req = signedReq(payload(), { header: null });
    const { raw } = await readRawBody(req);
    const v = verifySignature(req, raw);
    assert.strictEqual(v.reason, 'missing_signature_header');
    assert.strictEqual(v.reject, true);
  });
});

test('B1: a malformed signature header is refused, not crashed on', async () => {
  await withEnv({ META_APP_SECRET: SECRET, HMAC_MODE: 'enforce' }, async () => {
    for (const bad of ['garbage', 'sha256=', 'sha1=abcdef', 'sha256=zzzz']) {
      const req = signedReq(payload(), { header: bad });
      const { raw } = await readRawBody(req);
      const v = verifySignature(req, raw);
      assert.strictEqual(v.reject, true, `rejected: ${bad}`);
      assert.ok(['malformed_signature_header', 'signature_mismatch'].includes(v.reason), `sane reason for ${bad}`);
    }
  });
});

// ─── MODE BEHAVIOUR — THE SAFE-DEPLOY GUARANTEE ──────────────────────────────

test('B1: an absent app secret NEVER counts as a pass, and fails closed in enforce', async () => {
  await withEnv({ META_APP_SECRET: undefined, HMAC_MODE: 'enforce' }, async () => {
    const req = signedReq(payload());
    const { raw } = await readRawBody(req);
    const v = verifySignature(req, raw);
    assert.strictEqual(v.ok, null, 'not a pass');
    assert.strictEqual(v.reason, 'no_secret');
    assert.strictEqual(v.reject, true, 'enforce with no secret must refuse, not wave traffic through');
  });
});

test('B1: default mode is log — bad signatures are reported but NEVER rejected', async () => {
  // The safe-deploy guarantee. Merging this branch cannot take production down,
  // because nothing reaches a 403 until HMAC_MODE is explicitly set to enforce.
  await withEnv({ META_APP_SECRET: SECRET, HMAC_MODE: undefined }, async () => {
    const req = signedReq(payload(), { tamper: true });
    const { raw } = await readRawBody(req);
    const v = verifySignature(req, raw);
    assert.strictEqual(v.mode, 'log', 'default mode is log, not enforce');
    assert.strictEqual(v.ok, false, 'still reports the truth');
    assert.strictEqual(v.reject, false, 'but does NOT reject');
  });
});

test('B1: mode=off skips verification entirely', async () => {
  await withEnv({ META_APP_SECRET: SECRET, HMAC_MODE: 'off' }, async () => {
    const req = signedReq(payload(), { tamper: true });
    const { raw } = await readRawBody(req);
    const v = verifySignature(req, raw);
    assert.strictEqual(v.reject, false);
    assert.strictEqual(v.reason, 'disabled');
  });
});

test('B1: an unrecognised HMAC_MODE falls back to log, never to off', async () => {
  await withEnv({ META_APP_SECRET: SECRET, HMAC_MODE: 'ENFORCE_MAYBE' }, async () => {
    const req = signedReq(payload(), { tamper: true });
    const { raw } = await readRawBody(req);
    const v = verifySignature(req, raw);
    assert.strictEqual(v.mode, 'log', 'typo in config must not silently disable the check');
    assert.strictEqual(v.reject, false);
  });
});

// ─── ROUTER INTEGRATION — DOES IT ACTUALLY STOP THE HANDLER ──────────────────

test('B1 (router): forged traffic in enforce mode gets 403 and NEVER reaches a product handler', async () => {
  await withEnv({ META_APP_SECRET: SECRET, HMAC_MODE: 'enforce' }, async () => {
    const ctx = seededCtx();
    installFetch(ctx);
    const res = makeRes();
    const req = signedReq(payload(), { tamper: true });

    await router(req, res);

    assert.strictEqual(res.statusCode, 403, 'forged request is refused');
    assert.strictEqual(ctx.sends.length, 0, 'no WhatsApp send — handler never ran');
    assert.strictEqual(ctx.airtable.log.length, 0, 'no Airtable write — no side effects from forged traffic');
  });
});

test('B1 (router): genuine traffic in enforce mode passes through and is handled normally', async () => {
  await withEnv({ META_APP_SECRET: SECRET, HMAC_MODE: 'enforce' }, async () => {
    const ctx = seededCtx();
    installFetch(ctx);
    const res = makeRes();

    await router(signedReq(payload()), res);

    assert.strictEqual(res.statusCode, 200, 'genuine request is handled');
    assert.strictEqual(ctx.sends.length, 2, 'B13 consent + greeting — the real flow ran end to end');
    assert.ok(ctx.sends[1].body.includes('Welcome to Villa Liza Guest Lodge'));
  });
});

test('B1 (router): forged traffic in the DEFAULT mode is still handled — gate is open until enforced', async () => {
  // Documents the deliberate hole. This is the state production ships in, and it
  // is exactly why the PR says the gate is not closed until Shawn flips the env
  // var. If this test ever starts returning 403, the default changed.
  await withEnv({ META_APP_SECRET: SECRET, HMAC_MODE: undefined }, async () => {
    const ctx = seededCtx();
    installFetch(ctx);
    const res = makeRes();

    await router(signedReq(payload(), { tamper: true }), res);

    assert.strictEqual(res.statusCode, 200, 'log mode passes through');
    assert.strictEqual(ctx.sends.length, 2, 'handler ran — verification observed only');
  });
});

test('B1 (router): the existing parsed-body call shape still works — no regression for the other suites', async () => {
  // Every other test file calls router({ method, body }) with no rawBody. That
  // must keep working, or B1 breaks the whole suite rather than just itself.
  await withEnv({ META_APP_SECRET: undefined, HMAC_MODE: undefined }, async () => {
    const ctx = seededCtx();
    installFetch(ctx);
    const res = makeRes();

    await router({ method: 'POST', body: payload() }, res);

    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(ctx.sends.length, 2, 'unchanged behaviour for pre-B1 call shape');
  });
});
