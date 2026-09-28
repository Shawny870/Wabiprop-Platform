// lib/payfast.js
// Wabistay Automated Payment Gating — PayFast ITN (Instant Transaction
// Notification) transport-layer verification.
//
// TRANSPORT LAYER ONLY. This module answers exactly one question: "did this
// ITN really come from PayFast, unaltered?" It does not read or write
// Airtable, does not know about WS_Properties, and does not decide what a
// verified ITN means for a subscription. That's the webhook route/handler,
// deliberately not built yet — see the payment-gating investigation report.
//
// ─── WHY THIS IS NOT lib/hmac.js WITH DIFFERENT STRINGS ─────────────────────
// PayFast's own docs (developers.payfast.co.za, "Step 4: Confirm payment is
// successful", pulled live — not guessed) specify FOUR checks, not one
// signature comparison, and ALL FOUR must pass:
//   1. Signature — MD5 (not HMAC-SHA256) of the URL-encoded posted fields in
//      POST order, with the merchant passphrase appended before hashing. The
//      signature travels as a POST BODY field ('signature'), not an HTTP
//      header — nothing here is a header-based check the way Meta's is.
//   2. Source IP — confirm the request actually came from PayFast's servers.
//      PayFast's own sample code checks HTTP_REFERER (spoofable — a header
//      an attacker controls); this module checks the actual TCP source IP
//      against PayFast's published static IP ranges instead, which is the
//      trustworthy version of the same check.
//   3. Amount match — the posted amount_gross must equal what we expected to
//      charge. NOT implemented as a general-purpose function here: the
//      "expected amount" is a caller concern (it depends on which
//      subscription/property this ITN claims to be for), so this module
//      exposes the primitive (validPaymentData) and the caller supplies both
//      numbers.
//   4. Server round-trip confirmation — POST the same param string BACK to
//      PayFast's own /eng/query/validate endpoint and require the literal
//      response body "VALID". This is a live outbound HTTP call as PART OF
//      verifying an inbound webhook — a shape lib/hmac.js has no equivalent
//      of at all. Uses global.fetch, same convention as the rest of this
//      codebase (airtableGet etc.), so the existing test harness's fetch
//      mock covers it without a new test pattern.
//
// ─── STAGED ROLLOUT, SAME SHAPE AS HMAC_MODE (CEO-CONFIRMED 2026-09-17) ─────
// Carried over deliberately, not skipped just because it wasn't asked for
// explicitly this time: the same reason Meta's HMAC gate ships in three
// modes applies here, arguably more so, since this scheme was built from
// documentation pulled today, never yet run against real PayFast traffic.
// off/log/enforce, same semantics as lib/hmac.js's hmacMode():
//   'off'     — no checks at all.
//   'log'     — DEFAULT. Run all four checks, log each verdict, ALWAYS pass
//               through regardless of result. Safe deploy state — lets real
//               PayFast sandbox/live traffic prove the checks work before
//               anything can reject a real payment notification.
//   'enforce' — any failed check rejects (caller returns 403 / treats as
//               unverified). Only flip once Axiom shows real ITNs verifying
//               cleanly, same graduation rule as HMAC_MODE.
//
// ─── KNOWN GAP, LEFT AS AN EXPLICIT TODO, NOT GUESSED ───────────────────────
// PayFast's ITN payload documents `payment_status` as 'COMPLETE' or
// 'CANCELLED' for subscriptions. Two real documentation passes (the ITN doc
// itself, and the separate Recurring Billing / Subscriptions API doc) turned
// up NO documented value or separate webhook for "this billing cycle's card
// charge failed, will retry" — only prose describing PayFast's own internal
// retry behaviour and an eventual 'locked' subscription state reachable only
// via the management API, not an ITN field. Phase 2's "on failed ITN: set
// Suspended + Retry Deadline" cannot be wired against a value this module
// does not know exists. See verifyPaymentStatus() below — deliberately
// narrow, only classifies what PayFast's docs actually document.

const crypto = require('crypto');
const dns = require('dns').promises;

// PayFast's published server IP ranges (developers.payfast.co.za, "Ports and
// IP addresses" — pulled live 2026-09-17, not the weaker HTTP_REFERER check
// PayFast's own sample code uses). CIDR notation; a bare IP is treated as /32.
const PAYFAST_IP_RANGES = [
  '197.97.145.144/28',
  '41.74.179.192/27',
  '102.216.36.0/28',
  '102.216.36.128/28',
  '144.126.193.139/32'
];

const PAYFAST_VALID_HOSTNAMES = [
  'www.payfast.co.za',
  'sandbox.payfast.co.za',
  'w1w.payfast.co.za',
  'w2w.payfast.co.za'
];

function payfastItnMode() {
  // Read at CALL time, not module load — same reasoning as hmacMode(): tests
  // must be able to drive every mode, and a Vercel env change should take
  // effect on redeploy without a code change.
  const raw = String(process.env.PAYFAST_ITN_MODE || 'log').toLowerCase().trim();
  return ['off', 'log', 'enforce'].includes(raw) ? raw : 'log';
}

function payfastPassphrase() {
  return process.env.PAYFAST_PASSPHRASE || null;
}

// ─── CHECK 1: SIGNATURE ──────────────────────────────────────────────────────
// PayFast's own PHP reference implementation, ported directly: concatenate
// name=value pairs in POST order (object key order, since a parsed POST body
// preserves it), url-encode each value, join with '&', append the passphrase
// (if set — required for Subscriptions per PayFast's docs, optional
// otherwise), then MD5 the whole string. Compared against the posted
// 'signature' field, lower-case per PayFast's own documented format.
//
// `fields` is the ALREADY-PARSED POST body as a plain object, in the order
// PayFast sent it — Node's querystring/URLSearchParams parsing preserves
// field order, so this assumes the caller hands in an object built that way
// (e.g. Object.fromEntries(new URLSearchParams(rawBody)) ), not a body that
// has been re-ordered or re-serialized by an intermediate JSON round-trip.
function buildParamString(fields, passphrase) {
  let out = '';
  for (const [key, val] of Object.entries(fields)) {
    if (key === 'signature') continue; // never part of what's signed
    if (val === undefined || val === null || val === '') continue; // PayFast: non-blank only
    out += `${key}=${encodeURIComponent(String(val)).replace(/%20/g, '+')}&`;
  }
  out = out.slice(0, -1); // drop trailing '&'
  if (passphrase) {
    out += `&passphrase=${encodeURIComponent(passphrase).replace(/%20/g, '+')}`;
  }
  return out;
}

function verifyPayfastSignature(fields, passphrase) {
  const posted = fields && fields.signature;
  if (!posted) return { ok: false, reason: 'missing_signature_field' };

  const paramString = buildParamString(fields, passphrase);
  const expected = crypto.createHash('md5').update(paramString).digest('hex');
  // MD5 is not a secret-keyed HMAC — no timing-attack surface the way an
  // HMAC comparison has (the "secret" is the passphrase baked INTO the hash
  // input, not compared directly), so a plain comparison is the correct
  // primitive here, not crypto.timingSafeEqual (which would also require
  // matching buffer lengths this comparison doesn't need to enforce).
  const ok = String(posted).toLowerCase() === expected.toLowerCase();
  return { ok, reason: ok ? 'verified' : 'signature_mismatch' };
}

// ─── CHECK 2: SOURCE IP ──────────────────────────────────────────────────────
function ipToInt(ip) {
  const parts = String(ip).split('.').map(Number);
  if (parts.length !== 4 || parts.some(p => !Number.isInteger(p) || p < 0 || p > 255)) return null;
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function ipInCidr(ip, cidr) {
  const [rangeIp, prefixStr] = cidr.split('/');
  const prefix = Number(prefixStr);
  const ipInt = ipToInt(ip);
  const rangeInt = ipToInt(rangeIp);
  if (ipInt === null || rangeInt === null || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) return false;
  if (prefix === 0) return true;
  const mask = (0xFFFFFFFF << (32 - prefix)) >>> 0;
  return (ipInt & mask) === (rangeInt & mask);
}

// Static whitelist only — deliberately NOT the DNS-resolve-hostname-then-
// compare approach PayFast's own sample code uses for IP validation (that
// helper, pfValidIP in their docs, actually resolves hostnames and compares
// against HTTP_REFERER's host, which is attacker-controlled input, not a
// real source-IP check at all). resolvePayfastHostIps() below is kept
// separate and unused by verifyPayfastIp() for that reason — see its own
// comment.
function verifyPayfastIp(sourceIp) {
  if (!sourceIp) return { ok: false, reason: 'no_source_ip' };
  const ok = PAYFAST_IP_RANGES.some(cidr => ipInCidr(sourceIp, cidr));
  return { ok, reason: ok ? 'verified' : 'ip_not_whitelisted' };
}

// Exposed but NOT part of verifyItn()'s check pipeline — kept only so a
// caller who specifically needs hostname-resolved IPs (e.g. to detect
// PayFast rotating their infrastructure before the static list here is
// updated) has it available. Resolving live DNS on every inbound webhook
// request would be slow and itself a new failure mode; the static list is
// the documented, stable check.
async function resolvePayfastHostIps() {
  const results = await Promise.allSettled(PAYFAST_VALID_HOSTNAMES.map(h => dns.resolve4(h)));
  return results.filter(r => r.status === 'fulfilled').flatMap(r => r.value);
}

// ─── CHECK 3: AMOUNT MATCH ───────────────────────────────────────────────────
// PayFast's own reference implementation allows a 1-cent tolerance for
// float rounding — matched here, not a stricter check invented locally.
function validPaymentData(expectedAmount, amountGross) {
  const expected = Number(expectedAmount);
  const posted = Number(amountGross);
  if (!Number.isFinite(expected) || !Number.isFinite(posted)) return false;
  return Math.abs(expected - posted) <= 0.01;
}

// ─── CHECK 4: SERVER ROUND-TRIP CONFIRMATION ────────────────────────────────
// POSTs the exact same param string (order preserved, signature excluded)
// back to PayFast's own validate endpoint. Requires the literal response
// body 'VALID' — anything else (including a network failure) is NOT valid.
// Uses global.fetch (this codebase's existing convention, e.g. airtableGet)
// so the test harness's fetch mock covers this without a new pattern.
const PAYFAST_VALIDATE_URL = {
  live: 'https://www.payfast.co.za/eng/query/validate',
  sandbox: 'https://sandbox.payfast.co.za/eng/query/validate'
};

async function confirmWithPayfast(fields, opts = {}) {
  const { sandbox = false } = opts;
  const url = sandbox ? PAYFAST_VALIDATE_URL.sandbox : PAYFAST_VALIDATE_URL.live;
  // Deliberately re-includes 'signature' here (unlike buildParamString for
  // hashing) — PayFast's own docs post the FULL received param string back
  // for validation, not the pre-signature slice.
  const body = Object.entries(fields)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v)).replace(/%20/g, '+')}`)
    .join('&');

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body
    });
    const text = await res.text();
    const ok = text.trim() === 'VALID';
    return { ok, reason: ok ? 'verified' : 'server_confirmation_not_valid', responseBody: text };
  } catch (err) {
    // A network failure here must NOT read as "valid" — no check silently
    // passes on error, same posture as every other check in this module.
    return { ok: false, reason: 'server_confirmation_request_failed', error: err.message };
  }
}

// ─── ORCHESTRATION ───────────────────────────────────────────────────────────
// Runs all four checks unconditionally (even after an early failure) so
// `log` mode's Axiom record shows every check's real verdict, not just the
// first failure — same reasoning as wanting full visibility during the
// unproven-against-real-traffic period this mode exists for.
//
// `expectedAmount` is REQUIRED (unlike PayFast's own optional-feeling docs)
// — this module has no source of truth for what a given ITN's booking/
// subscription should have cost, so the caller (the not-yet-built webhook
// route) must resolve and supply it. Passing null/undefined fails check 3
// loudly rather than skipping it.
async function verifyPayfastItn(fields, opts = {}) {
  const { sourceIp = null, expectedAmount = null, sandbox = false } = opts;
  const mode = payfastItnMode();

  if (mode === 'off') {
    return { mode, ok: null, reject: false, reason: 'disabled', checks: null };
  }

  const passphrase = payfastPassphrase();
  const signature = verifyPayfastSignature(fields, passphrase);
  const ip = verifyPayfastIp(sourceIp);
  const amount = { ok: validPaymentData(expectedAmount, fields && fields.amount_gross) };
  amount.reason = amount.ok ? 'verified' : 'amount_mismatch';
  const serverConfirm = await confirmWithPayfast(fields, { sandbox });

  const checks = { signature, ip, amount, serverConfirm };
  const allOk = signature.ok && ip.ok && amount.ok && serverConfirm.ok;

  return {
    mode,
    ok: allOk,
    reject: mode === 'enforce' && !allOk,
    reason: allOk ? 'verified' : 'one_or_more_checks_failed',
    checks
  };
}

// See the module header's "KNOWN GAP" comment. Deliberately narrow: this
// classifies ONLY the two documented values. Anything else — including a
// hypothetical undocumented "failed" status — returns 'unknown', NOT
// 'failed', so the caller cannot accidentally treat this as having resolved
// the open question rather than surfacing it.
// TODO(payment-gating Phase 2): PayFast's docs document no ITN-level value
// for "this billing cycle's charge failed, will retry" — only 'COMPLETE'/
// 'CANCELLED' for subscriptions, plus prose about an eventual account-locked
// state reachable via the management API, not an ITN field. Do not wire
// Phase 2's "on failed ITN: suspend + set retry deadline" against a guessed
// value here. Resolve this against a sandbox test firing a real failed
// recurring charge, or treat 'unknown' as failure deliberately (a decision,
// not a default) — CEO to confirm which before Phase 2 proceeds.
function classifyPaymentStatus(paymentStatus) {
  if (paymentStatus === 'COMPLETE') return 'complete';
  if (paymentStatus === 'CANCELLED') return 'cancelled';
  return 'unknown';
}

module.exports = {
  payfastItnMode,
  payfastPassphrase,
  buildParamString,
  verifyPayfastSignature,
  ipToInt,
  ipInCidr,
  verifyPayfastIp,
  resolvePayfastHostIps,
  validPaymentData,
  confirmWithPayfast,
  verifyPayfastItn,
  classifyPaymentStatus,
  PAYFAST_IP_RANGES
};
