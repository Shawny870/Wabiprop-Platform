// /api/wabistay/cron/daily-summary.js
// Stage 3 part 1 — daily mini-reconciliation summary, called hourly by
// .github/workflows/daily-summary.yml, not by Vercel's native cron (Hobby
// tier is once/day, UTC-only, hour-imprecise — cannot deliver "fire at
// property X's chosen SAST hour").
//
// Unlike auto-checkout.js / owner-summary.js (thin re-exports with no auth —
// Vercel's own cron is their only caller, and the route path isn't public),
// this route is reachable by GitHub Actions over the open internet, so it is
// the first Wabistay cron route to need its own auth check. CRON_SECRET is
// NEW here, not an existing pattern being reused — confirmed live before
// building (grep across the repo found no prior CRON_SECRET implementation,
// only a comment flagging the same gap on a parked, unrelated Wabiprop cron).
// Fails closed: an unset CRON_SECRET refuses every request rather than
// silently allowing them through.
const wh = require('../webhook.js');

module.exports = async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.authorization || '';
  if (!secret || auth !== `Bearer ${secret}`) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  return wh.dailySummaryHandler(req, res);
};
