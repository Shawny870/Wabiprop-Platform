// /api/wabistay/cron/weekly-recap.js
// Weekly owner recap — implements the Meta-approved wabistay_owner_weekly_recap
// template (7 params). Deliberately separate from owner-summary.js, which
// remains its own unrelated P&L reconciliation feature with its own pending
// template — this file replaces the retired weekly-value-nudge.js (renamed,
// same Thursday slot), not owner-summary.js.
//
// Same fail-closed CRON_SECRET gate as daily-summary.js/owner-summary.js —
// Vercel's native cron (see vercel.json) auto-injects
// `Authorization: Bearer $CRON_SECRET` once the env var is set; an unset
// secret refuses every request rather than allowing them through.
const wh = require('../webhook.js');

module.exports = async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.authorization || '';
  if (!secret || auth !== `Bearer ${secret}`) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  return wh.weeklyRecapHandler(req, res);
};
