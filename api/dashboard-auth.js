// /api/dashboard-auth.js
// Wabiprop Agent Dashboard — password check + session issuance
// Reads: process.env.DASHBOARD_PASSWORD
// Writes: nothing (no Airtable access from this file)
// Issues: signed session cookie (wp_dash_session) on successful password match
// No AI. Deterministic logic only. Solar Geyser Principle.
//
// Session design: stateless HMAC-SHA256 signed cookie — no session store, no DB.
// Signing key is DASHBOARD_PASSWORD itself (V1 decision — no second secret).
// Cookie format: "<expiryEpochMs>.<hmacHex>" — dashboard.js and dashboard-data.js
// verify by recomputing the HMAC over the expiry and checking expiry > now.

const crypto = require('crypto');

const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD;
const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const COOKIE_NAME = 'wp_dash_session';

// ─── SESSION COOKIE HELPERS ──────────────────────────────────────────────────

function signExpiry(expiry) {
  return crypto.createHmac('sha256', DASHBOARD_PASSWORD).update(String(expiry)).digest('hex');
}

function buildSessionCookie() {
  const expiry = Date.now() + SESSION_MAX_AGE_MS;
  const sig = signExpiry(expiry);
  const maxAgeSeconds = Math.floor(SESSION_MAX_AGE_MS / 1000);
  return `${COOKIE_NAME}=${expiry}.${sig}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAgeSeconds}`;
}

// ─── TIMING-SAFE PASSWORD COMPARE ────────────────────────────────────────────
// Avoids leaking password length/content via response-time comparison.

function safeCompare(input, expected) {
  const a = Buffer.from(String(input));
  const b = Buffer.from(String(expected));
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// ─── MAIN HANDLER ─────────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  if (!DASHBOARD_PASSWORD) {
    console.error('[dashboard-auth] DASHBOARD_PASSWORD not set in environment');
    return res.status(500).send('Dashboard auth is not configured.');
  }

  // ── GET — bookmarkable link: /dashboard?password=XXXX ───────────────────
  // Also handles the plain <form method="GET" action="/api/dashboard-auth">
  // submitted by the login page served from dashboard.js.
  if (req.method === 'GET') {
    const password = req.query.password;

    if (password && safeCompare(password, DASHBOARD_PASSWORD)) {
      res.setHeader('Set-Cookie', buildSessionCookie());
      res.writeHead(302, { Location: '/dashboard' });
      return res.end();
    }

    res.writeHead(302, { Location: '/dashboard?error=1' });
    return res.end();
  }

  // ── POST — in-page login form via fetch, no full reload ─────────────────
  if (req.method === 'POST') {
    let body = req.body;
    if (!body) {
      return res.status(400).json({ ok: false, error: 'Missing request body.' });
    }
    if (typeof body === 'string') {
      try {
        body = JSON.parse(body);
      } catch (e) {
        return res.status(400).json({ ok: false, error: 'Invalid JSON body.' });
      }
    }

    const password = body.password;
    if (password && safeCompare(password, DASHBOARD_PASSWORD)) {
      res.setHeader('Set-Cookie', buildSessionCookie());
      return res.status(200).json({ ok: true });
    }

    return res.status(401).json({ ok: false, error: 'Invalid password.' });
  }

  return res.status(405).send('Method Not Allowed');
};
