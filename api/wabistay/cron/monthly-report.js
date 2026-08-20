// /api/wabistay/cron/monthly-report.js
// Monthly business-intelligence rollup — NOT a copy of daily/weekly at a
// monthly cadence. See runMonthlyReport's own header comment in ../webhook.js
// for what's reliably computable today vs. flagged as data-gap-limited.
//
// Same fail-closed CRON_SECRET gate as every other Wabistay cron route —
// Vercel's native cron (see vercel.json) auto-injects
// `Authorization: Bearer $CRON_SECRET` once the env var is set.
const wh = require('../webhook.js');

module.exports = async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  const auth = req.headers.authorization || '';
  if (!secret || auth !== `Bearer ${secret}`) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  return wh.monthlyReportHandler(req, res);
};
