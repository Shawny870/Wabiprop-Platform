// /api/wabistay/dormant-report.js
// CEO-only on-demand list of dormant properties. Deliberately NOT a new
// notification channel (per the original ask: "an Airtable view is
// sufficient") — this is a read-only, pull-when-asked JSON list, same
// no-schedule/no-vercel-cron shape as manual-report.js.
//
// Two DISTINCT, un-conflated views (CEO decision — see the header comment
// above dormantProperties() in ./webhook.js for the full reasoning):
//   · `dormant` — the actual WhatsApp Coexistence disconnect-risk flag,
//     keyed on 'Last Owner App Open' alone by default (mode: 'owner_open_only').
//     `mode=either`/`mode=both` remain available for a combined view if ever
//     wanted, but are not the default.
//   · `messageInactive` — a separate "this property may be quiet" view keyed
//     on 'Last Message Received' alone. Not merged into `dormant` — a busy
//     guest inbox and a stale owner app-open are different risks and must
//     stay visibly different.
//
// Auth reuses MANUAL_REPORT_SECRET rather than inventing a third secret —
// same trust boundary (a person typing a request), same fail-closed pattern.
const wh = require('./webhook.js');

const VALID_MODES = ['owner_open_only', 'either', 'both'];

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
  const mode = (req.query && req.query.mode) || 'owner_open_only';
  if (!VALID_MODES.includes(mode)) {
    return res.status(400).json({ ok: false, error: `invalid mode: '${mode}' — must be one of: ${VALID_MODES.join(', ')}` });
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

  const inactiveOpts = {};
  if (thresholdDays !== undefined) inactiveOpts.thresholdDays = thresholdDays;
  const messageInactive = wh.inactiveByMessageActivity(properties, inactiveOpts);

  return res.status(200).json({
    ok: true,
    thresholdDays: thresholdDays !== undefined ? thresholdDays : wh.DORMANT_THRESHOLD_DAYS_DEFAULT,
    mode,
    totalProperties: properties.length,
    dormantCount: dormant.length,
    dormant,
    messageInactiveCount: messageInactive.length,
    messageInactive
  });
};
