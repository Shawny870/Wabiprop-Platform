// api/wabiprop/cron/owner-weekly.js
// Group 7 (Builder Brief, 2 Jul 2026) — Owner weekly report cron.
// Schedule: Monday 07:00 SAST = 05:00 UTC (vercel.json: "0 5 * * 1")
// Manual trigger: GET https://wabiprop-platform.vercel.app/api/wabiprop/cron/owner-weekly
//
// Content per Brief: prior month's rental income summary + outstanding maintenance
// spend for the period. Plain outbound message -- no interactive menu (matches
// Group 6's owner-notification pattern; the fuller "Owner Monthly Summary" template
// in Wabiprop_Wabistay_Master_Build_Spec.md Section 3.2 -- management fee %, net
// payable, per-job cost breakdown -- is NOT built here; this is the narrower Brief
// scope only. Flagging that richer template as a V2 candidate if wanted later.
//
// DATA SOURCING -- read before changing anything:
//   WP_Issues.Linked Property is confirmed EMPTY on every live record (Flow 1 never
//   writes it -- same known issue the dashboard already worked around). WP_Payments
//   has never been populated with real data yet, so its Linked Property field's
//   reliability is untested. To avoid depending on either, this cron resolves "which
//   tenants belong to this owner" via WP_Tenants.Property Name (a denormalised text
//   field, reliably populated by seed-links.js and already used by the dashboard) --
//   NOT via any linked-record traversal. Both metrics below key off that tenant set.
//
// AMBIGUITIES FLAGGED FOR ENGINEER SIGN-OFF (see chat report):
//   1. "Outstanding maintenance spend" is read here as "total Cost logged against
//      Resolved/Closed issues in the period" -- there is no field distinguishing
//      paid vs. unpaid maintenance cost, so "outstanding" cannot mean a true unpaid
//      balance without new schema.
//   2. WP_Payments has two near-identical period fields ("Payment Period(Month/Year)"
//      and "Period (month/year)") -- this cron reads "Payment Period(Month/Year)".
//      Confirm that's the one tomorrow's seed data will actually populate.
//   3. Owner-to-property matching depends on WP_Properties."Owner Whatsapp" holding
//      the exact same phone string as WP_Owner."Landlord Whatsapp" for the same
//      person -- a silent-drift risk if the two fields are ever entered differently.

const { airtableGet, sendWhatsApp, logToAxiom, alertShawn } = require('../_lib/cronHelpers');

function getPriorMonthRange(now) {
  const year  = now.getUTCFullYear();
  const month = now.getUTCMonth(); // 0-based
  const priorMonth = month === 0 ? 11 : month - 1;
  const priorYear  = month === 0 ? year - 1 : year;
  const firstOfPriorMonth = new Date(Date.UTC(priorYear, priorMonth, 1));
  const monthName = firstOfPriorMonth.toLocaleString('en-ZA', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  const isoDateOnly = firstOfPriorMonth.toISOString().split('T')[0];
  return { firstOfPriorMonth, monthName, isoDateOnly };
}

module.exports = async function handler(req, res) {
  console.log('[Cron: owner-weekly] Starting run');
  const { monthName, isoDateOnly } = getPriorMonthRange(new Date());
  const results = [];

  try {
    const owners = await airtableGet('WP_Owner', `AND({Onboarded} = TRUE(), {Landlord Whatsapp} != '')`);
    console.log(`[Cron: owner-weekly] ${owners.length} onboarded owner(s) found`);

    for (const owner of owners) {
      const ownerPhone = (owner.fields['Landlord Whatsapp'] || '').trim();
      const ownerName  = (owner.fields['Full Name of Landlord'] || 'there').trim();
      const ownerFirstName = ownerName.split(/\s+/)[0] || 'there';

      try {
        // Owner's properties -- matched via WP_Properties."Owner Whatsapp" (see note above)
        const properties = await airtableGet('WP_Properties', `{Owner Whatsapp} = '${ownerPhone}'`);
        if (properties.length === 0) {
          console.log(`[Cron: owner-weekly] No properties found for owner ${ownerPhone} -- skipping`);
          results.push({ ownerPhone, skipped: true, reason: 'no properties matched' });
          continue;
        }
        const propertyNames = properties.map(p => (p.fields['Property Name'] || '').trim()).filter(Boolean);

        // Owner's tenants -- via denormalised Property Name match (reliable path)
        const nameFilters = propertyNames.map(n => `{Property Name} = '${n.replace(/'/g, "\\'")}'`).join(', ');
        const tenants = nameFilters
          ? await airtableGet('WP_Tenants', `OR(${nameFilters})`)
          : [];
        const tenantIds    = tenants.map(t => t.id);
        const tenantPhones = new Set(tenants.map(t => (t.fields['Whatsapp Phone Number'] || '').trim()).filter(Boolean));

        // ── Rental income: WP_Payments, Payment Type = Rent, Received (in full or
        //    partial), Payment Period(Month/Year) matches prior month, tenant is
        //    one of this owner's tenants (client-side filter -- see file header)
        const paymentRecords = await airtableGet(
          'WP_Payments',
          `AND({Payment Type} = 'Rent', OR({Payment Status} = 'Received in Full', {Payment Status} = 'Received Partial'), IS_SAME({Payment Period(Month/Year)}, '${isoDateOnly}', 'month'))`
        );
        const ownerPayments = paymentRecords.filter(p => {
          const linked = p.fields['Linked Tenant'] || [];
          return linked.some(id => tenantIds.includes(id));
        });
        const rentalIncome = ownerPayments.reduce((sum, p) => sum + (Number(p.fields['Amount Received']) || 0), 0);

        // ── Maintenance spend: WP_Issues resolved in the prior month, tenant phone
        //    is one of this owner's tenants. See file header re: "outstanding" reading.
        const resolvedIssues = tenantPhones.size > 0
          ? await airtableGet(
              'WP_Issues',
              `AND(IS_SAME({Date Resolved}, '${isoDateOnly}', 'month'), OR({Issue Resolution Status} = 'Resolved', {Issue Resolution Status} = 'Closed'))`
            )
          : [];
        const ownerIssues = resolvedIssues.filter(i => tenantPhones.has((i.fields['Tenant Whatsapp Number'] || '').trim()));
        const maintenanceSpend = ownerIssues.reduce((sum, i) => sum + (Number(i.fields['Cost']) || Number(i.fields['Invoice Amount']) || 0), 0);

        // ── DRAFT COPY -- confirm wording before this is treated as final ──────
        const msg =
          `WABIPROP — OWNER SUMMARY\n\n` +
          `Hi ${ownerFirstName},\n\n` +
          `This has been your ${monthName} — here's the rent you should expect.\n\n` +
          `RENTAL INCOME (${monthName})\n` +
          `Collected: R${rentalIncome.toFixed(2)}\n\n` +
          `MAINTENANCE SPEND (${monthName})\n` +
          `Outstanding: R${maintenanceSpend.toFixed(2)}\n\n` +
          `Questions? Reply to this message.`;

        const sendResult = await sendWhatsApp(ownerPhone, msg);
        logToAxiom(sendResult.error ? 'error' : 'info', 'owner_weekly_report_sent', {
          ownerPhone, monthName, rentalIncome, maintenanceSpend,
          propertyCount: properties.length, tenantCount: tenants.length,
          metaError: sendResult.error ? JSON.stringify(sendResult.error) : null,
        });

        results.push({ ownerPhone, rentalIncome, maintenanceSpend, propertyCount: properties.length });
        console.log(`[Cron: owner-weekly] Sent to ${ownerPhone} — income R${rentalIncome}, maintenance R${maintenanceSpend}`);

      } catch (ownerErr) {
        console.error(`[Cron: owner-weekly] Error for owner ${ownerPhone}:`, ownerErr.message);
        logToAxiom('error', 'owner_weekly_report_error', { ownerPhone, error: ownerErr.message });
        results.push({ ownerPhone, error: ownerErr.message });
      }
    }

    console.log('[Cron: owner-weekly] Run complete', JSON.stringify(results));
    return res.status(200).json({ ok: true, monthName, ownersProcessed: owners.length, results });

  } catch (err) {
    console.error('[Cron: owner-weekly ERROR]', err.message);
    await alertShawn('owner-weekly', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
};
