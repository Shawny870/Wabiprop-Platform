// /api/wabistay/cron/weekly-value-nudge.js
// Weekly "here's what's happening at your property" nudge to owners.
// Deliberately separate from owner-summary.js — see the comment above
// runWeeklyValueNudge in ../webhook.js for why this isn't just a rename of
// the existing owner P&L summary.
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
  return wh.weeklyValueNudgeHandler(req, res);
};
