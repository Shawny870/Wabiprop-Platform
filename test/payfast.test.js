// test/payfast.test.js
// PayFast ITN transport-layer verification (lib/payfast.js). Transport only —
// no Airtable, no webhook route wiring (that's Phase 2 proper, not built yet).
//
// HONESTY NOTE, not swept under the rug: PayFast's own documentation pages
// (pulled live, see lib/payfast.js header) show an example ITN payload but
// with blank field values and no fully-worked final MD5 hash to check
// against — so there is no independently-known-good "real PayFast signature"
// test vector available from their docs alone. These tests verify the
// algorithm's PROPERTIES (round-trips correctly, breaks on tampering,
// matches PayFast's documented field-order/passphrase/URL-encoding rules)
// rather than claiming to match a verified real signature. True end-to-end
// verification against a real PayFast sandbox transaction is still
// outstanding — flag this explicitly before this module is trusted in
// enforce mode against production ITNs.

const { test } = require('node:test');
const assert = require('node:assert');

const ORIGINAL_ENV = { ...process.env };
function resetEnv() {
  for (const k of Object.keys(process.env)) {
    if (!(k in ORIGINAL_ENV)) delete process.env[k];
  }
  Object.assign(process.env, ORIGINAL_ENV);
}

const pf = require('../lib/payfast');

// ─── Mode ────────────────────────────────────────────────────────────────────

test('payfastItnMode defaults to "log" when unset', () => {
  delete process.env.PAYFAST_ITN_MODE;
  assert.strictEqual(pf.payfastItnMode(), 'log');
  resetEnv();
});

test('payfastItnMode accepts off/log/enforce, falls back to "log" on garbage (never silently "off")', () => {
  process.env.PAYFAST_ITN_MODE = 'ENFORCE';
  assert.strictEqual(pf.payfastItnMode(), 'enforce');
  process.env.PAYFAST_ITN_MODE = 'off';
  assert.strictEqual(pf.payfastItnMode(), 'off');
  process.env.PAYFAST_ITN_MODE = 'nonsense';
  assert.strictEqual(pf.payfastItnMode(), 'log');
  resetEnv();
});

// ─── Check 1: signature ──────────────────────────────────────────────────────

test('verifyPayfastSignature: a signature computed by buildParamString + md5 verifies correctly (round-trip)', () => {
  const crypto = require('crypto');
  const fields = { m_payment_id: 'ABC123', pf_payment_id: '1089250', payment_status: 'COMPLETE', amount_gross: '200.00' };
  const passphrase = 'jt7NOE43FZPn';
  const paramString = pf.buildParamString(fields, passphrase);
  const signature = crypto.createHash('md5').update(paramString).digest('hex');
  const result = pf.verifyPayfastSignature({ ...fields, signature }, passphrase);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.reason, 'verified');
});

test('verifyPayfastSignature: tampering with any field value invalidates the signature', () => {
  const crypto = require('crypto');
  const fields = { m_payment_id: 'ABC123', amount_gross: '200.00' };
  const passphrase = 'jt7NOE43FZPn';
  const signature = crypto.createHash('md5').update(pf.buildParamString(fields, passphrase)).digest('hex');
  const tampered = { ...fields, amount_gross: '999.00', signature };
  const result = pf.verifyPayfastSignature(tampered, passphrase);
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'signature_mismatch');
});

test('verifyPayfastSignature: wrong passphrase invalidates the signature (passphrase is part of what is signed)', () => {
  const crypto = require('crypto');
  const fields = { m_payment_id: 'ABC123' };
  const signature = crypto.createHash('md5').update(pf.buildParamString(fields, 'correct-phrase')).digest('hex');
  const result = pf.verifyPayfastSignature({ ...fields, signature }, 'wrong-phrase');
  assert.strictEqual(result.ok, false);
});

test('verifyPayfastSignature: missing signature field is refused outright, not treated as a mismatch to compute past', () => {
  const result = pf.verifyPayfastSignature({ m_payment_id: 'ABC123' }, 'phrase');
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'missing_signature_field');
});

test('verifyPayfastSignature: comparison is case-insensitive (PayFast documents lower-case, do not silently reject an upper-case posted value)', () => {
  const crypto = require('crypto');
  const fields = { m_payment_id: 'ABC123' };
  const passphrase = 'phrase';
  const signature = crypto.createHash('md5').update(pf.buildParamString(fields, passphrase)).digest('hex').toUpperCase();
  const result = pf.verifyPayfastSignature({ ...fields, signature }, passphrase);
  assert.strictEqual(result.ok, true);
});

test('buildParamString: blank/undefined/null fields are excluded, matching PayFast\'s "non-blank only" rule', () => {
  const s = pf.buildParamString({ a: '1', b: '', c: undefined, d: null, e: '2' }, null);
  assert.strictEqual(s, 'a=1&e=2');
});

test('buildParamString: the "signature" field itself is never included, even if present in the input', () => {
  const s = pf.buildParamString({ a: '1', signature: 'whatever' }, null);
  assert.strictEqual(s, 'a=1');
});

test('buildParamString: spaces encode as "+", matching PayFast\'s documented urlencode convention (not %20)', () => {
  const s = pf.buildParamString({ item_name: 'Test Product' }, null);
  assert.strictEqual(s, 'item_name=Test+Product');
});

// ─── Check 2: source IP ──────────────────────────────────────────────────────

test('verifyPayfastIp: an IP inside a documented PayFast CIDR range verifies', () => {
  assert.strictEqual(pf.verifyPayfastIp('197.97.145.150').ok, true); // inside 197.97.145.144/28
});

test('verifyPayfastIp: the single documented bare IP (treated as /32) verifies exactly, and only exactly', () => {
  assert.strictEqual(pf.verifyPayfastIp('144.126.193.139').ok, true);
  assert.strictEqual(pf.verifyPayfastIp('144.126.193.140').ok, false);
});

test('verifyPayfastIp: an IP outside every documented range is refused', () => {
  const result = pf.verifyPayfastIp('8.8.8.8');
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'ip_not_whitelisted');
});

test('verifyPayfastIp: no source IP at all is refused, not silently skipped', () => {
  const result = pf.verifyPayfastIp(null);
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'no_source_ip');
});

test('ipInCidr: boundary correctness on a /27 range (edges included, one past the edge excluded)', () => {
  assert.strictEqual(pf.ipInCidr('41.74.179.192', '41.74.179.192/27'), true);  // first address
  assert.strictEqual(pf.ipInCidr('41.74.179.223', '41.74.179.192/27'), true);  // last address
  assert.strictEqual(pf.ipInCidr('41.74.179.224', '41.74.179.192/27'), false); // one past
  assert.strictEqual(pf.ipInCidr('41.74.179.191', '41.74.179.192/27'), false); // one before
});

// ─── Check 3: amount match ───────────────────────────────────────────────────

test('validPaymentData: exact match is valid', () => {
  assert.strictEqual(pf.validPaymentData(200, 200), true);
});

test('validPaymentData: within PayFast\'s documented 1-cent float tolerance is valid', () => {
  assert.strictEqual(pf.validPaymentData(200, 200.009), true);
});

test('validPaymentData: beyond tolerance is invalid', () => {
  assert.strictEqual(pf.validPaymentData(200, 199), false);
});

test('validPaymentData: non-numeric input is invalid, not coerced to a false match', () => {
  assert.strictEqual(pf.validPaymentData(200, 'not a number'), false);
  assert.strictEqual(pf.validPaymentData(undefined, 200), false);
});

// ─── Check 4: server round-trip confirmation ────────────────────────────────

function mockFetchReturning(bodyText, ok = true) {
  const calls = [];
  global.fetch = async (url, opts) => {
    calls.push({ url, opts });
    return { text: async () => bodyText };
  };
  return calls;
}

test('confirmWithPayfast: literal "VALID" response body is the only passing case', async () => {
  mockFetchReturning('VALID');
  const result = await pf.confirmWithPayfast({ m_payment_id: 'ABC' });
  assert.strictEqual(result.ok, true);
});

test('confirmWithPayfast: "INVALID" or any other body fails, not just a strict "INVALID" check', async () => {
  mockFetchReturning('INVALID');
  const result = await pf.confirmWithPayfast({ m_payment_id: 'ABC' });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'server_confirmation_not_valid');
});

test('confirmWithPayfast: a network failure is treated as NOT valid, never silently passes', async () => {
  global.fetch = async () => { throw new Error('network down'); };
  const result = await pf.confirmWithPayfast({ m_payment_id: 'ABC' });
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reason, 'server_confirmation_request_failed');
});

test('confirmWithPayfast: posts to the sandbox URL when opts.sandbox is true, live URL otherwise', async () => {
  const calls = mockFetchReturning('VALID');
  await pf.confirmWithPayfast({ a: '1' }, { sandbox: true });
  assert.match(calls[0].url, /sandbox\.payfast\.co\.za/);
  await pf.confirmWithPayfast({ a: '1' }, { sandbox: false });
  assert.match(calls[1].url, /www\.payfast\.co\.za/);
});

// ─── Orchestration ───────────────────────────────────────────────────────────

function validItnSetup(overrides = {}) {
  const crypto = require('crypto');
  const passphrase = 'jt7NOE43FZPn';
  process.env.PAYFAST_PASSPHRASE = passphrase;
  const fields = { m_payment_id: 'ABC123', amount_gross: '200.00', payment_status: 'COMPLETE', ...overrides };
  const signature = crypto.createHash('md5').update(pf.buildParamString(fields, passphrase)).digest('hex');
  mockFetchReturning('VALID');
  return { ...fields, signature };
}

test('verifyPayfastItn: mode "off" skips every check and always passes through', async () => {
  process.env.PAYFAST_ITN_MODE = 'off';
  const result = await pf.verifyPayfastItn({}, {});
  assert.strictEqual(result.ok, null);
  assert.strictEqual(result.reject, false);
  assert.strictEqual(result.checks, null);
  resetEnv();
});

test('verifyPayfastItn: mode "log" (default) runs all checks and reports the real verdict but NEVER rejects', async () => {
  delete process.env.PAYFAST_ITN_MODE;
  const fields = validItnSetup();
  const result = await pf.verifyPayfastItn(fields, { sourceIp: '8.8.8.8' /* deliberately invalid */, expectedAmount: 200 });
  assert.strictEqual(result.mode, 'log');
  assert.strictEqual(result.checks.ip.ok, false, 'the real failing verdict must still be visible');
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.reject, false, 'log mode never rejects, regardless of verdict');
  resetEnv();
});

test('verifyPayfastItn: mode "enforce" rejects when any single check fails', async () => {
  process.env.PAYFAST_ITN_MODE = 'enforce';
  const fields = validItnSetup();
  const result = await pf.verifyPayfastItn(fields, { sourceIp: '8.8.8.8', expectedAmount: 200 });
  assert.strictEqual(result.reject, true);
  resetEnv();
});

test('verifyPayfastItn: mode "enforce" passes (does not reject) when all four checks genuinely pass', async () => {
  process.env.PAYFAST_ITN_MODE = 'enforce';
  const fields = validItnSetup();
  const result = await pf.verifyPayfastItn(fields, { sourceIp: '197.97.145.150', expectedAmount: 200 });
  assert.strictEqual(result.checks.signature.ok, true);
  assert.strictEqual(result.checks.ip.ok, true);
  assert.strictEqual(result.checks.amount.ok, true);
  assert.strictEqual(result.checks.serverConfirm.ok, true);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.reject, false);
  resetEnv();
});

// ─── Known gap: payment_status classification ───────────────────────────────

test('classifyPaymentStatus: only the two documented values are classified; everything else is "unknown", never silently "failed"', () => {
  assert.strictEqual(pf.classifyPaymentStatus('COMPLETE'), 'complete');
  assert.strictEqual(pf.classifyPaymentStatus('CANCELLED'), 'cancelled');
  assert.strictEqual(pf.classifyPaymentStatus('FAILED'), 'unknown', 'not a documented PayFast value — must not be assumed');
  assert.strictEqual(pf.classifyPaymentStatus(undefined), 'unknown');
});
