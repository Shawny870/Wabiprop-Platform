// /api/wabistay/cron/owner-summary.js
// B17 — Vercel cron entry point for the Wabistay owner (weekly P&L) summary.
// Aggregation + the stubbed send live in ../webhook.js (single source of truth).
// Weekly by default; set OWNER_SUMMARY_DAILY=true to switch to a daily period.
// Schedule is in vercel.json (crons); Shawn enables it at deploy time.
//
// CRON_SECRET gate added — same fail-closed Authorization: Bearer check as
// daily-summary.js.
const wh = require('../webhook.js');

module.exports = async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.authorization || '';
  if (!secret || auth !== `Bearer ${secret}`) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  return wh.ownerSummaryHandler(req, res);
};
