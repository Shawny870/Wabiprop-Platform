// api/wabiprop/cron/agent-morning-summary.js
// Group 8 (Builder Brief, 2 Jul 2026) — Agent morning summary cron.
// Schedule: Daily 07:00 SAST = 05:00 UTC (vercel.json: "0 5 * * *")
// Manual trigger: GET https://wabiprop-platform.vercel.app/api/wabiprop/cron/agent-morning-summary
//
// Content per Brief (narrower than Menu Spec Section 5.6's fuller Flow A5 template):
// open issues count, stale issues count, "anything awaiting agent action".
//
// STALE THRESHOLD -- DELIBERATELY DIFFERENT FROM THE ON-DEMAND STALE COMMAND:
// This cron uses 48 hours, not the 4-hour threshold handleAgentStaleCheck (webhook.js)
// uses for the on-demand STALE command. Engineer decision: a daily digest that
// re-flags the same 5-hour-old issue every morning for two days straight is noise,
// not signal, against the "N items need attention" pitch -- the summary should
// surface genuinely neglected issues, not everything mid-flow. The anchor-resolution
// logic (which timestamp counts as "last progress" per status) is still duplicated
// from handleAgentStaleCheck unchanged -- only the threshold constant differs.
// STALE itself is untouched and stays at 4 hours.
//
// NOT included (deliberately, matching Brief's narrower scope, unlike Menu Spec's
// fuller template): leases expiring, rent overdue. Those depend on Groups 10/11
// (rent reminders / lease reminders) which either aren't built yet or aren't
// reliable data sources yet this session. Natural additions once those land.
//
// "Anything awaiting agent action" is read as: issues in Call Requested status
// for this agent (a tenant is waiting on a callback) -- the only concrete
// "agent owes someone a response" state that already exists in the schema.

const { airtableGet, sendWhatsApp, logToAxiom, alertShawn } = require('../_lib/cronHelpers');

const STALE_MS = 48 * 60 * 60 * 1000; // 48 hours -- intentionally NOT the 4h STALE-command threshold

// Anchor-resolution logic duplicated from handleAgentStaleCheck (webhook.js) rather
// than imported -- same "don't touch the live webhook" reasoning as the rest of
// this cron layer. Only the threshold constant above differs from the original.
function resolveAnchor(f, status) {
  if (status === 'Pending Confirmation') {
    return f['Contractor Completed Timestamp'] || f['Contractor Arrived Timestamp'] || f['Date Reported'] || null;
  }
  if (status === 'Awaiting Reopen Detail' || status === 'Confirming Reopen Detail') {
    return f['Date Reported'] || null;
  }
  return f['Contractor Arrived Timestamp'] || f['Date Reported'] || null;
}

module.exports = async function handler(req, res) {
  console.log('[Cron: agent-morning-summary] Starting run');
  const today = new Date().toLocaleDateString('en-ZA', { timeZone: 'Africa/Johannesburg', day: 'numeric', month: 'long', year: 'numeric' });
  const results = [];

  try {
    const agents = await airtableGet('WP_Agents', `{Active} = TRUE()`);
    console.log(`[Cron: agent-morning-summary] ${agents.length} active agent(s) found`);

    for (const agent of agents) {
      const agentPhone = (agent.fields['Agent Whatsapp number'] || '').trim();
      const agentName  = (agent.fields['Agent Name'] || 'there').trim();
      const agentFirstName = agentName.split(/\s+/)[0] || 'there';

      if (!agentPhone) {
        console.warn('[Cron: agent-morning-summary] Agent record missing phone -- skipped', agent.id);
        results.push({ agentId: agent.id, skipped: true, reason: 'no phone on file' });
        continue;
      }

      try {
        const openIssues = await airtableGet(
          'WP_Issues',
          `AND({Agent Whatsapp number} = '${agentPhone}', {Issue Resolution Status} = 'Open')`
        );

        const staleCandidates = await airtableGet(
          'WP_Issues',
          `AND({Agent Whatsapp number} = '${agentPhone}', OR(` +
            `{Issue Resolution Status} = 'Contractor Assigned', ` +
            `{Issue Resolution Status} = 'Contractor En Route', ` +
            `{Issue Resolution Status} = 'Pending Confirmation', ` +
            `{Issue Resolution Status} = 'Awaiting Reopen Detail', ` +
            `{Issue Resolution Status} = 'Confirming Reopen Detail'))`
        );
        const now = Date.now();
        const staleCount = staleCandidates.filter(rec => {
          const anchor = resolveAnchor(rec.fields, rec.fields['Issue Resolution Status']);
          if (!anchor) return true;
          return (now - new Date(anchor).getTime()) > STALE_MS;
        }).length;

        const callRequested = await airtableGet(
          'WP_Issues',
          `AND({Agent Whatsapp number} = '${agentPhone}', {Issue Resolution Status} = 'Call Requested')`
        );

        const msg =
          `Good morning ${agentFirstName}. Here is your summary for ${today}:\n\n` +
          `Open issues: ${openIssues.length} (${staleCount} stale >48h)\n` +
          `Call requests pending: ${callRequested.length}\n\n` +
          `Reply 1 to see your open issues.`;

        const sendResult = await sendWhatsApp(agentPhone, msg);
        logToAxiom(sendResult.error ? 'error' : 'info', 'agent_morning_summary_sent', {
          agentPhone, openCount: openIssues.length, staleCount, callRequestedCount: callRequested.length,
          metaError: sendResult.error ? JSON.stringify(sendResult.error) : null,
        });

        results.push({ agentPhone, openCount: openIssues.length, staleCount, callRequestedCount: callRequested.length });
        console.log(`[Cron: agent-morning-summary] Sent to ${agentPhone} — open ${openIssues.length}, stale ${staleCount}, call requests ${callRequested.length}`);

      } catch (agentErr) {
        console.error(`[Cron: agent-morning-summary] Error for agent ${agentPhone}:`, agentErr.message);
        logToAxiom('error', 'agent_morning_summary_error', { agentPhone, error: agentErr.message });
        results.push({ agentPhone, error: agentErr.message });
      }
    }

    console.log('[Cron: agent-morning-summary] Run complete', JSON.stringify(results));
    return res.status(200).json({ ok: true, date: today, agentsProcessed: agents.length, results });

  } catch (err) {
    console.error('[Cron: agent-morning-summary ERROR]', err.message);
    await alertShawn('agent-morning-summary', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
};
