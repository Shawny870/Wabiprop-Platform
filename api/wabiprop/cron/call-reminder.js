// api/wabiprop/cron/call-reminder.js
// Group 9 (Builder Brief, 2 Jul 2026) — Call request reminder cron.
// Schedule: hourly (vercel.json: "0 * * * *")
// Manual trigger: GET https://wabiprop-platform.vercel.app/api/wabiprop/cron/call-reminder
//
// Any issue in Call Requested status with no reminder sent yet, older than N hours
// (Date Reported is the anchor -- each call request creates its own WP_Issues
// record per Menu Spec Flow T2, so Date Reported is the call-request timestamp),
// gets ONE nudge to the agent, then WP_Issues."Call Reminder Sent" is set so it
// never fires again for that issue -- per explicit instruction, not a repeating
// reminder.
//
// N = 2 HOURS, per Brief's suggested default -- FLAGGING, not silently picking:
// the older Menu Spec (Section 4.3, step T2-4) specced this exact same reminder
// at 24 HOURS, not 2. Going with the Brief's 2h since it's the current,
// CEO-approved instruction for tonight, but the 12x difference from the other
// documented value is worth a second look, not just a footnote.
//
// DEPENDENCY, not yet live: Flow T2 (Group 2, held pending Group 1) is what
// actually creates WP_Issues records with status Call Requested. Until that
// lands, this cron's query will correctly return zero candidates -- it is built
// and ready, not dead code, just nothing to act on yet.
//
// KNOWN GAP, not fixed here: there is currently no command that moves an issue
// OUT of Call Requested (Menu Spec lists "HANDLED WP-N" as Phase 11 "Polish" --
// not part of any group built tonight). Once nudged, a Call Requested issue sits
// nudged-once indefinitely until manually changed in Airtable or a future HANDLED
// command lands. Not a spam risk (Call Reminder Sent prevents repeat nudges), just
// a known incompleteness -- flagging rather than building HANDLED here, which
// would be scope creep beyond Group 9.

const { airtableGet, airtableUpdate, sendWhatsApp, logToAxiom, alertShawn } = require('../_lib/cronHelpers');

const REMINDER_THRESHOLD_MS = 2 * 60 * 60 * 1000; // 2 hours -- see file header re: the 24h alternative

module.exports = async function handler(req, res) {
  console.log('[Cron: call-reminder] Starting run');
  const results = [];

  try {
    const candidates = await airtableGet(
      'WP_Issues',
      `AND({Issue Resolution Status} = 'Call Requested', {Call Reminder Sent} != TRUE())`
    );
    console.log(`[Cron: call-reminder] ${candidates.length} unreminded Call Requested issue(s) found`);

    const now = Date.now();
    for (const issue of candidates) {
      const f = issue.fields;
      const issueRef = f['Issue Ref'] || issue.id.slice(-6).toUpperCase();
      const reportedTs = f['Date Reported'] ? new Date(f['Date Reported']).getTime() : null;

      if (!reportedTs) {
        results.push({ issueId: issue.id, issueRef, skipped: true, reason: 'no Date Reported' });
        continue;
      }

      const ageMs = now - reportedTs;
      if (ageMs < REMINDER_THRESHOLD_MS) {
        continue; // not old enough yet -- not an error, just not due
      }

      const agentPhone = (f['Agent Whatsapp number'] || '').trim();
      if (!agentPhone) {
        results.push({ issueId: issue.id, issueRef, skipped: true, reason: 'no agent phone on issue' });
        continue;
      }

      try {
        // Tenant name resolved via WP_Tenants lookup -- same established pattern as
        // Groups 5/6 (handleAgentAttend / handleAgentEscalateToOwner), not a parse
        // of Issue Title, since that field's format for a Call Requested issue
        // (created by the not-yet-built Flow T2) isn't confirmed.
        let tenantName = 'Tenant';
        const tenantPhone = (f['Tenant Whatsapp Number'] || '').trim();
        if (tenantPhone) {
          const tenantRecords = await airtableGet('WP_Tenants', `{Whatsapp Phone Number} = '${tenantPhone}'`);
          if (tenantRecords.length > 0) {
            tenantName = (tenantRecords[0].fields['Full Name'] || 'Tenant').trim().split(/\s+/)[0] || 'Tenant';
          }
        }

        const hoursAgo = (ageMs / 3600000).toFixed(1);

        const sendResult = await sendWhatsApp(agentPhone,
          `⏰ Reminder: ${tenantName} requested a call ${hoursAgo}h ago (WP-${issueRef}). Not yet handled.\n\n` +
          `Reply *STATUS WP-${issueRef}* for details.`
        );

        const patched = await airtableUpdate('WP_Issues', issue.id, { 'Call Reminder Sent': true });
        if (patched.error) throw new Error(`Issue PATCH failed: ${JSON.stringify(patched.error)}`);

        logToAxiom(sendResult.error ? 'error' : 'info', 'call_reminder_sent', {
          issueId: issue.id, issueRef: String(issueRef), agentPhone, hoursAgo,
          metaError: sendResult.error ? JSON.stringify(sendResult.error) : null,
        });

        results.push({ issueId: issue.id, issueRef, agentPhone, hoursAgo, sent: !sendResult.error });
        console.log(`[Cron: call-reminder] Nudged agent ${agentPhone} for WP-${issueRef} (${hoursAgo}h old)`);

      } catch (issueErr) {
        console.error(`[Cron: call-reminder] Error for issue ${issue.id}:`, issueErr.message);
        logToAxiom('error', 'call_reminder_error', { issueId: issue.id, error: issueErr.message });
        results.push({ issueId: issue.id, issueRef, error: issueErr.message });
      }
    }

    console.log('[Cron: call-reminder] Run complete', JSON.stringify(results));
    return res.status(200).json({ ok: true, candidatesChecked: candidates.length, results });

  } catch (err) {
    console.error('[Cron: call-reminder ERROR]', err.message);
    await alertShawn('call-reminder', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
};
