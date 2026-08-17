// /api/wabistay/cron/auto-checkout.js
// B12 — Vercel cron entry point for the Wabistay auto-checkout sweep.
// All logic (Airtable/WhatsApp helpers, the sweep itself) lives in
// ../webhook.js so there is a single source of truth for the checkout side
// effects and message copy. This file is only the HTTP handler the cron hits.
//
// Schedule is in vercel.json (crons); Shawn enables it at deploy time.
//
// CRON_SECRET gate added — same fail-closed Authorization: Bearer check as
// daily-summary.js (that file's comment calling this route "no auth" is now
// stale; not edited there per scope — auth-only PR, single source of truth
// left to drift rather than touching a file outside the fix list).
const wh = require('../webhook.js');

module.exports = async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.authorization || '';
  if (!secret || auth !== `Bearer ${secret}`) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  return wh.autoCheckoutHandler(req, res);
};
