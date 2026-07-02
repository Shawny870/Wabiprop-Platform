// api/wabiprop/cron/lease-reminders.js
// Group 11 (Builder Brief, 2 Jul 2026) — Agent-facing lease expiry digest cron.
// Schedule: Daily 06:30 SAST = 04:30 UTC (vercel.json: "30 4 * * *") -- offset 30min
// after rent-reminders (04:00 UTC) rather than the same instant.
// Manual trigger: GET https://wabiprop-platform.vercel.app/api/wabiprop/cron/lease-reminders
//
// RECONCILED POST-SESSION: originally shipped tenant-facing (one message per
// tenant, mirroring Group 10 exactly). CEO decision: switch to agent-facing --
// renewal/vacate decisions are agent work, and 7/3/1 days is too short a lead
// time for a tenant-facing renewal prompt to be useful (see the "every prior
// doc used 60/30/14 or 90/60/30/7 day lead times" note this was originally
// flagged with). Structure below is a genuine rework, not a copy-paste
// recipient swap -- see "WHAT CHANGED" below.
//
// Structure and in-memory join still reused from Group 10 (rent-reminders.js):
// fetch eligible leases + active tenants once each, join in memory, same
// pagination-safe airtableGet. Days Until Expiry query simplification (see
// original commit 8562ba6 for the DATETIME_DIFF confirmation) is unchanged.
//
// WHAT CHANGED from the tenant-facing version:
//   1. Recipient: was one WhatsApp send per tenant; now one compiled digest
//      per agent, covering every lease of theirs crossing a 7/3/1-day mark.
//   2. Agent resolution: WP_Leases has no direct Agent field. Resolved via
//      each lease's first linked, Active tenant's "Agent WhatsApp Number" --
//      same denormalised-field convention used everywhere else in this
//      session (Flow 1, Groups 5/6/12), not a new lookup pattern. If a lease
//      has multiple tenants, only the first Active one is used to identify
//      both the agent and the display name shown in the digest -- co-tenants
//      with a different agent (shouldn't happen; agent is a property-level
//      assignment) or a different display name are not separately listed.
//      Flagging as a simplification, not verified impossible.
//   3. New WP_Agents fetch (Active = TRUE()), matching Group 8's pattern, so
//      the digest can greet the agent by name rather than a bare "Hi agent".
//   4. Opt-out fields DROPPED entirely (Stop Flag (Opted Out) no longer
//      checked). That field governs whether to message the TENANT -- since
//      this cron no longer contacts tenants at all, it's not applicable to
//      what's being sent. An opted-out tenant's lease still appears in their
//      agent's digest, which is a deliberate behaviour change worth knowing:
//      previously such a tenant's lease produced no message to anyone;
//      now it does (to the agent, not the tenant).
//   5. Message format: NOT Group 8's compact stat-line style ("Open issues:
//      N (...)"), even though that was suggested as a reusable pattern.
//      Judgment call, flagged: a bare count ("3 leases expiring soon") isn't
//      actionable without knowing which tenant/unit/date, so this follows
//      Flow A1's numbered-list style instead, sorted soonest-first. Group 8's
//      greeting convention ("Good morning {name}. ...") is reused; its
//      count-only body is not, since it doesn't fit content that needs to be
//      followed up per-item rather than just reviewed as a total.

const { airtableGet, sendWhatsApp, logToAxiom, alertShawn } = require('../_lib/cronHelpers');

module.exports = async function handler(req, res) {
  console.log('[Cron: lease-reminders] Starting run');
  const results = [];

  try {
    const leases = await airtableGet(
      'WP_Leases',
      `AND(OR({Lease Status} = 'Active', {Lease Status} = 'Month-to-Month'), OR({Days Until Expiry} = 7, {Days Until Expiry} = 3, {Days Until Expiry} = 1))`
    );
    const tenants = await airtableGet('WP_Tenants', `{Tenant Status} = 'Active'`);
    const agents  = await airtableGet('WP_Agents', `{Active} = TRUE()`);

    const tenantById = new Map(tenants.map(t => [t.id, t]));
    const agentNameByPhone = new Map(
      agents.map(a => [(a.fields['Agent Whatsapp number'] || '').trim(), (a.fields['Agent Name'] || '').trim()])
    );

    console.log(`[Cron: lease-reminders] ${leases.length} lease(s) at a 7/3/1-day mark, ${tenants.length} active tenant(s), ${agents.length} active agent(s)`);

    // Group eligible leases by agent phone -- one digest per agent, not one
    // message per lease/tenant.
    const digestByAgent = new Map();

    for (const lease of leases) {
      const daysUntil = Number(lease.fields['Days Until Expiry']);
      const endDate = lease.fields['Lease End Date'];
      const dateStr = endDate
        ? new Date(endDate).toLocaleDateString('en-ZA', { timeZone: 'UTC', day: 'numeric', month: 'long' })
        : 'soon';

      // First Active, resolvable tenant identifies the agent + display info
      // for this lease (see file header re: co-tenant simplification).
      const tenantIds = lease.fields['Tenants'] || [];
      const tenant = tenantIds.map(id => tenantById.get(id)).find(Boolean);

      if (!tenant) {
        results.push({ leaseId: lease.id, skipped: true, reason: 'no Active tenant found to resolve agent from' });
        continue;
      }

      const agentPhone = (tenant.fields['Agent WhatsApp Number'] || '').trim();
      if (!agentPhone) {
        results.push({ leaseId: lease.id, skipped: true, reason: 'no agent phone on tenant record' });
        continue;
      }

      const tenantName   = (tenant.fields['Full Name']    || 'Tenant').trim();
      const propertyName = (tenant.fields['Property Name'] || '').trim();
      const unitAddress  = (tenant.fields['Unit Address']  || '').trim();

      if (!digestByAgent.has(agentPhone)) digestByAgent.set(agentPhone, []);
      digestByAgent.get(agentPhone).push({
        leaseId: lease.id, tenantName, location: propertyName || unitAddress || 'unknown property',
        daysUntil, dateStr,
      });
    }

    for (const [agentPhone, entries] of digestByAgent.entries()) {
      entries.sort((a, b) => a.daysUntil - b.daysUntil); // most urgent (1 day) first

      const agentName = agentNameByPhone.get(agentPhone) || '';
      const agentFirstName = agentName.split(/\s+/)[0] || 'there';

      const lines = entries.map((e, i) =>
        `${i + 1} — ${e.tenantName} · ${e.location} · expires ${e.dateStr} (${e.daysUntil} day${e.daysUntil === 1 ? '' : 's'})`
      );

      const msg =
        `Good morning ${agentFirstName}. ${entries.length} lease${entries.length === 1 ? '' : 's'} crossing a renewal-decision point:\n\n` +
        `${lines.join('\n')}\n\n` +
        `Reach out directly to discuss renewal or moving out.`;

      const sendResult = await sendWhatsApp(agentPhone, msg);
      logToAxiom(sendResult.error ? 'error' : 'info', 'lease_reminder_digest_sent', {
        agentPhone, leaseCount: entries.length,
        metaError: sendResult.error ? JSON.stringify(sendResult.error) : null,
      });

      results.push({ agentPhone, leaseCount: entries.length, sent: !sendResult.error });
      console.log(`[Cron: lease-reminders] Sent digest to ${agentPhone} — ${entries.length} lease(s)`);
    }

    console.log('[Cron: lease-reminders] Run complete', JSON.stringify(results));
    return res.status(200).json({ ok: true, leasesAtThreshold: leases.length, agentsNotified: digestByAgent.size, results });

  } catch (err) {
    console.error('[Cron: lease-reminders ERROR]', err.message);
    await alertShawn('lease-reminders', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
};
