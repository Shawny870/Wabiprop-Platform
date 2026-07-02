// api/wabiprop/cron/lease-reminders.js
// Group 11 (Builder Brief, 2 Jul 2026) — Tenant lease expiry reminders cron.
// Schedule: Daily 06:30 SAST = 04:30 UTC (vercel.json: "30 4 * * *") -- offset 30min
// after rent-reminders (04:00 UTC) rather than the same instant.
// Manual trigger: GET https://wabiprop-platform.vercel.app/api/wabiprop/cron/lease-reminders
//
// Structure and in-memory join deliberately reused from Group 10 (rent-reminders.js)
// per instruction, not re-derived: fetch eligible leases + active tenants once each,
// join in memory, respect opt-out flags, same pagination-safe airtableGet.
//
// QUERY SIMPLIFICATION vs. Group 10 -- flagging why: WP_Leases."Days Until Expiry"
// is a live formula field, confirmed via Meta API as
// DATETIME_DIFF({Lease End Date}, TODAY(), 'days') -- Airtable recalculates it
// server-side on every read. That means the entire 7/3/1-day filter can live
// directly in the Airtable formula (OR({Days Until Expiry}=7, ...)), unlike Group
// 10, which needed JS-side date math with month-end clamping because
// "Rent Due Day" is a recurring day-of-month with no absolute date to filter on.
// Leases have one absolute expiry date, so this is the simpler, more direct case --
// used Days Until Expiry rather than computing from Lease End Date by hand.
//
// RECIPIENT -- PROPOSED, NOT silently decided: this sends to the TENANT, mirroring
// Group 10 exactly (informational, no interactive menu). Two things worth weighing
// before treating this as final:
//   1. Every prior doc that specced lease-expiry reminders (Master Build Spec
//      Section 3.6, Product Reference V2 features, Demo Bible Scene 3) used a much
//      longer lead time -- 60/30/14 days (agent-facing) or 90/60/30/7 days
//      (tenant-facing) -- because renewing a lease normally needs weeks of notice.
//      7/3/1 days out is very short for an actual renewal decision; it works fine
//      as "reuse Group 10's mechanical pattern" but may be too late to be useful
//      as an actual renewal-decision prompt.
//   2. An AGENT-facing digest ("N leases expiring this week") is arguably more
//      actionable than tenant-facing, since renewal/vacate decisions are agent
//      work per those same docs. Structurally trivial to add later (agent phone is
//      already denormalised on WP_Tenants) if tenant-facing turns out to be the
//      wrong call.
// Going with tenant-facing now since it's the most direct "port" of Group 10's
// structure, which is what was asked for -- flagging rather than second-guessing
// the 7/3/1 numbers or silently switching to agent-facing.
//
// OPT-OUT FIELDS -- deliberately NOT identical to Group 10: respects
// "Stop Flag (Opted Out)" (a general opt-out, by name) but NOT
// "Payment Reminder Opt-Out" -- that field is scoped to payment reminders
// specifically per its own name, and blindly reusing it here would let a tenant
// who only opted out of rent nagging also lose lease-expiry notice, which isn't
// the same request. Flagging this deviation from a literal copy of Group 10.

const { airtableGet, sendWhatsApp, logToAxiom, alertShawn } = require('../_lib/cronHelpers');

const REMINDER_COPY = {
  7: (name, dateStr) => `Hi ${name}, your lease is expiring in 7 days (${dateStr}). Please contact your agent to discuss renewal or moving out.`,
  3: (name, dateStr) => `Hi ${name}, your lease is expiring in 3 days (${dateStr}). Please contact your agent if you haven't already.`,
  1: (name, dateStr) => `Hi ${name}, your lease expires tomorrow (${dateStr}). Please contact your agent as soon as possible if you haven't already.`,
};

module.exports = async function handler(req, res) {
  console.log('[Cron: lease-reminders] Starting run');
  const results = [];

  try {
    const leases = await airtableGet(
      'WP_Leases',
      `AND(OR({Lease Status} = 'Active', {Lease Status} = 'Month-to-Month'), OR({Days Until Expiry} = 7, {Days Until Expiry} = 3, {Days Until Expiry} = 1))`
    );
    const tenants = await airtableGet('WP_Tenants', `{Tenant Status} = 'Active'`);
    const tenantById = new Map(tenants.map(t => [t.id, t]));

    console.log(`[Cron: lease-reminders] ${leases.length} lease(s) at a 7/3/1-day mark, ${tenants.length} active tenant(s)`);

    for (const lease of leases) {
      const daysUntil = Number(lease.fields['Days Until Expiry']);
      const endDate = lease.fields['Lease End Date'];
      const dateStr = endDate
        ? new Date(endDate).toLocaleDateString('en-ZA', { timeZone: 'UTC', day: 'numeric', month: 'long' })
        : 'soon';

      const tenantIds = lease.fields['Tenants'] || [];
      for (const tenantId of tenantIds) {
        const tenant = tenantById.get(tenantId);
        if (!tenant) continue; // not Active, or not found -- skip silently, not an error

        const optedOut = Boolean(tenant.fields['Stop Flag (Opted Out)']);
        const phone = (tenant.fields['Whatsapp Phone Number'] || '').trim();
        if (optedOut || !phone) {
          results.push({ leaseId: lease.id, tenantId, skipped: true, reason: optedOut ? 'opted out' : 'no phone' });
          continue;
        }

        const tenantName = (tenant.fields['Full Name'] || 'there').trim().split(/\s+/)[0] || 'there';
        const msg = REMINDER_COPY[daysUntil](tenantName, dateStr);

        const sendResult = await sendWhatsApp(phone, msg);
        logToAxiom(sendResult.error ? 'error' : 'info', 'lease_reminder_sent', {
          leaseId: lease.id, tenantId, phone, daysUntil, endDate,
          metaError: sendResult.error ? JSON.stringify(sendResult.error) : null,
        });

        results.push({ leaseId: lease.id, tenantId, phone, daysUntil, sent: !sendResult.error });
        console.log(`[Cron: lease-reminders] Sent ${daysUntil}-day reminder to ${phone} (lease ${lease.id})`);
      }
    }

    console.log('[Cron: lease-reminders] Run complete', JSON.stringify(results));
    return res.status(200).json({ ok: true, leasesAtThreshold: leases.length, results });

  } catch (err) {
    console.error('[Cron: lease-reminders ERROR]', err.message);
    await alertShawn('lease-reminders', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
};
