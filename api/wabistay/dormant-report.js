// /api/wabistay/dormant-report.js
// CEO-only on-demand list of dormant properties — see dormantProperties() in
// ./webhook.js for the flagging logic and pr-bodies/dormant-property-flagging.md
// for the Airtable-native view alternative. Deliberately NOT a new
// notification channel (per the original ask: "an Airtable view is
// sufficient") — this is a read-only, pull-when-asked JSON list, same
// no-schedule/no-vercel-cron shape as manual-report.js.
//
// Auth reuses MANUAL_REPORT_SECRET rather than inventing a third secret —
// same trust boundary (a person typing a request), same fail-closed pattern.
const wh = require('./webhook.js');

module.exports = async function handler(req, res) {
  const secret = process.env.MANUAL_REPORT_SECRET;
  const auth = req.headers.authorization || '';
  if (!secret || auth !== `Bearer ${secret}`) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }

  const thresholdDaysRaw = req.query ? req.query.thresholdDays : undefined;
  const thresholdDays = thresholdDaysRaw !== undefined ? Number(thresholdDaysRaw) : undefined;
  if (thresholdDaysRaw !== undefined && (!Number.isFinite(thresholdDays) || thresholdDays <= 0)) {
    return res.status(400).json({ ok: false, error: `invalid thresholdDays: '${thresholdDaysRaw}' — must be a positive number` });
  }
  const mode = (req.query && req.query.mode) || 'either';
  if (mode !== 'either' && mode !== 'both') {
    return res.status(400).json({ ok: false, error: `invalid mode: '${mode}' — must be 'either' or 'both'` });
  }

  let properties;
  try {
    properties = await wh.airtableGet('WS_Properties', '');
  } catch (err) {
    console.error('[DORMANT-REPORT] property lookup failed', err.message, err.stack);
    return res.status(502).json({ ok: false, error: `airtable lookup failed: ${err.message}` });
  }

  const opts = { mode };
  if (thresholdDays !== undefined) opts.thresholdDays = thresholdDays;
  const dormant = wh.dormantProperties(properties, opts);

  return res.status(200).json({
    ok: true,
    thresholdDays: thresholdDays !== undefined ? thresholdDays : wh.DORMANT_THRESHOLD_DAYS_DEFAULT,
    mode,
    totalProperties: properties.length,
    dormantCount: dormant.length,
    dormant
  });
};
