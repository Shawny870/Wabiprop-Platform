// lib/hmac.js
// B1 — Meta webhook signature verification (X-Hub-Signature-256).
//
// Lives OUTSIDE api/ deliberately: everything under api/ is a Vercel serverless
// function, and this is a library, not an endpoint. It is bundled because the
// handlers require() it.
//
// ─── WHY THIS IS THREE MODES AND NOT A BARE 403 ──────────────────────────────
// The original B1 spec (WABISTAY_SESSION_BRIEF.md, 5 Jul 2026) said "log-only
// first, then enforce", and that sequencing is load-bearing, not caution for its
// own sake. Two things must be true before rejecting traffic is safe, and NEITHER
// can be proven from a laptop:
//
//   1. META_APP_SECRET must actually be set in the deployed environment.
//   2. Vercel must actually hand us the RAW request bytes. Meta signs the exact
//      bytes it sent; JSON.stringify(req.body) re-serialises them and produces a
//      DIFFERENT digest (key order, whitespace, unicode escaping). If the body
//      parser is still running, every signature fails.
//
// If (2) is wrong and we ship a bare 403, every inbound webhook is rejected the
// moment the secret is set — Meta retries, then disables the subscription, and
// Wabistay goes dark: no bookings, no gate arrival, no cleaner dispatch. So the
// default mode OBSERVES and reports, and the CEO flips to enforce only after
// Axiom shows real traffic verifying cleanly.
//
// HMAC_MODE:
//   'off'     — no check at all.
//   'log'     — DEFAULT. Verify, log the verdict, ALWAYS pass through. The gate
//               is NOT closed in this mode. This is the safe deploy state.
//   'enforce' — Verify and reject with 403 before any handler logic runs.
//
// Unset/absent secret is never silently ignored: it logs at warn/error every
// request so a gate that was believed closed cannot be quietly open.

const crypto = require('crypto');

const SIGNATURE_HEADER = 'x-hub-signature-256';

function hmacMode() {
  // Read at CALL time, not module load, so tests can drive every mode and a
  // Vercel env change takes effect on redeploy without a code change.
  const raw = String(process.env.HMAC_MODE || 'log').toLowerCase().trim();
  return ['off', 'log', 'enforce'].includes(raw) ? raw : 'log';
}

function appSecret() {
  return process.env.META_APP_SECRET || null;
}

// Read the raw request bytes. Returns { raw, body } where `raw` is a Buffer (or
// null when unavailable) and `body` is the parsed payload.
//
// Two paths, because the same code runs in three places:
//   - Vercel with bodyParser disabled → req is a stream, we read + parse. RAW OK.
//   - The test harness → passes a plain object as req.body, no stream. RAW absent
//     unless the test supplies req.rawBody explicitly (which the HMAC tests do).
//   - Vercel with the parser somehow still active → req.body set, stream drained.
//     RAW absent. This is the failure mode mode='log' exists to detect.
async function readRawBody(req) {
  if (req.rawBody) {
    const raw = Buffer.isBuffer(req.rawBody) ? req.rawBody : Buffer.from(String(req.rawBody), 'utf8');
    let body = req.body;
    if (body === undefined) {
      try { body = JSON.parse(raw.toString('utf8')); } catch { body = undefined; }
    }
    return { raw, body };
  }

  // Already-parsed body and no stream to read — cannot recover the original bytes.
  // Deliberately does NOT re-serialise: a re-serialised digest would "verify"
  // nothing while looking like it worked, which is worse than no check at all.
  if (req.body !== undefined && typeof req.on !== 'function') {
    return { raw: null, body: req.body };
  }

  if (typeof req.on !== 'function') return { raw: null, body: req.body };

  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks);
  if (raw.length === 0) return { raw, body: undefined };

  let body;
  try { body = JSON.parse(raw.toString('utf8')); } catch { body = undefined; }
  return { raw, body };
}

// Constant-time compare of two hex digests. Length-checks first because
// timingSafeEqual throws on length mismatch.
function safeEqualHex(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  const bufA = Buffer.from(a, 'hex');
  const bufB = Buffer.from(b, 'hex');
  if (bufA.length !== bufB.length || bufA.length === 0) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function headerValue(req, name) {
  const headers = req.headers || {};
  // Node lowercases incoming header names; be tolerant of test objects that don't.
  return headers[name] || headers[name.toLowerCase()] ||
    headers[Object.keys(headers).find(k => k.toLowerCase() === name) || ''] || null;
}

// The verdict. `ok` means the signature verified. `reject` means the caller must
// return 403 — it is ONLY ever true in enforce mode, so no other mode can take
// production down.
function verifySignature(req, raw) {
  const mode = hmacMode();
  if (mode === 'off') {
    return { mode, ok: null, reject: false, reason: 'disabled' };
  }

  const secret = appSecret();
  if (!secret) {
    // Never treat a missing secret as a pass. In enforce mode this is a hard
    // stop: the operator asked for a closed gate and we cannot provide one.
    return {
      mode, ok: null, reject: mode === 'enforce',
      reason: 'no_secret', level: 'error'
    };
  }

  const header = headerValue(req, SIGNATURE_HEADER);
  if (!header) {
    return { mode, ok: false, reject: mode === 'enforce', reason: 'missing_signature_header', level: 'warn' };
  }

  if (raw === null || raw === undefined) {
    // The parser ate the bytes. Cannot verify; must not pretend to.
    return { mode, ok: null, reject: mode === 'enforce', reason: 'no_raw_body', level: 'error' };
  }

  const match = /^sha256=([a-f0-9]+)$/i.exec(String(header).trim());
  if (!match) {
    return { mode, ok: false, reject: mode === 'enforce', reason: 'malformed_signature_header', level: 'warn' };
  }

  const expected = crypto.createHmac('sha256', secret).update(raw).digest('hex');
  const ok = safeEqualHex(match[1].toLowerCase(), expected);

  return {
    mode, ok,
    reject: mode === 'enforce' && !ok,
    reason: ok ? 'verified' : 'signature_mismatch',
    level: ok ? 'info' : 'warn'
  };
}

module.exports = { readRawBody, verifySignature, hmacMode, SIGNATURE_HEADER };
