// api/wabiprop/cron/rent-reminders.js
// Group 10 (Builder Brief, 2 Jul 2026) — Tenant rent reminders cron.
// Schedule: Daily 06:00 SAST = 04:00 UTC (vercel.json: "0 4 * * *")
// Manual trigger: GET https://wabiprop-platform.vercel.app/api/wabiprop/cron/rent-reminders
//
// PARKED 11 Jul 2026 (Builder_Brief_Complete_Cutover.md): removed from vercel.json
// "crons" — Wabiprop's WhatsApp number was reassigned to Wabistay as its permanent
// production number, and Wabiprop's replacement number is not yet sourced. Handler
// left intact, not deleted. Re-add the vercel.json cron entry once a new Wabiprop
// number lands. Manual trigger above still resolves but sends will fail loudly
// (WP_PHONE_NUMBER_ID is cleared, not repointed) rather than silently misfiring.
//
// Content per Brief: 7/3/1 day before rent due date -> message to tenant.
// Due-date source is WP_Leases."Rent Due Day" (day-of-month number) -- CEO decision,
// NOT WP_Payments."Expected Payment Date". This cron computes each lease's next
// occurrence of that day-of-month from "today" (calendar day in SAST) and fires
// only on the exact 7/3/1-day mark -- it does not build the fuller arrears
// escalation ladder (Day 0 / +3 / +7 / +14) from the Product Reference doc; that
// is a separate, larger scope this Brief does not ask for tonight.
//
// PERFORMANCE NOTE: fetches ALL active leases and ALL active tenants once each
// (2 Airtable calls total) and joins them in memory, rather than one Airtable
// call per lease -- avoids an N+1 query pattern that would risk the 10s Vercel
// function timeout at real portfolio scale (e.g. Rochelle's ~60 properties).
//
// KNOWN LATENT LIMITATION (pre-existing, not introduced here): airtableGet in
// cronHelpers.js (and its twin in webhook.js) does not paginate past Airtable's
// 100-record-per-request default. Fine at current pilot scale (~55-60 tenants),
// will silently under-count once total tenant/lease records exceed 100. Flagging,
// not fixing -- broader refactor across both copies, out of scope tonight.
//
// Filters applied: Lease Status in (Active, Month-to-Month) -- excludes Expired/
// Pending. Tenant Status = Active -- excludes Vacated/Evicted. Respects both
// "Payment Reminder Opt-Out" and "Stop Flag (Opted Out)" on WP_Tenants.

const { airtableGet, sendWhatsApp, logToAxiom, alertShawn } = require('../_lib/cronHelpers');

function daysInMonth(year, monthIndex) { // monthIndex is 0-based
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

// Computes the next occurrence (as a UTC-midnight Date) of "dueDay" on or after
// today's calendar date. Clamps to the last real day of a month for due days
// like 31 falling in a 30-day (or 28/29-day) month.
function nextDueDate(todayY, todayM, todayD, dueDay) {
  const clampedThisMonth = Math.min(dueDay, daysInMonth(todayY, todayM));
  if (todayD <= clampedThisMonth) {
    return new Date(Date.UTC(todayY, todayM, clampedThisMonth));
  }
  const nextMonthIndex = todayM === 11 ? 0 : todayM + 1;
  const nextMonthYear  = todayM === 11 ? todayY + 1 : todayY;
  const clampedNextMonth = Math.min(dueDay, daysInMonth(nextMonthYear, nextMonthIndex));
  return new Date(Date.UTC(nextMonthYear, nextMonthIndex, clampedNextMonth));
}

function getTodaySAST() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Johannesburg', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date());
  const map = Object.fromEntries(parts.map(p => [p.type, p.value]));
  return { year: Number(map.year), month: Number(map.month) - 1, day: Number(map.day) }; // month 0-based
}

const REMINDER_COPY = {
  7: (name, amount, dateStr) => `Hi ${name}, just a reminder that your rent of R${amount} is due on ${dateStr} (7 days). Please ensure payment is ready.`,
  3: (name, amount, dateStr) => `Hi ${name}, your rent of R${amount} is due in 3 days (${dateStr}).`,
  1: (name, amount, dateStr) => `Hi ${name}, your rent of R${amount} is due tomorrow (${dateStr}). Please ensure payment is made on time.`,
};

module.exports = async function handler(req, res) {
  console.log('[Cron: rent-reminders] Starting run');
  const today = getTodaySAST();
  const results = [];

  try {
    const leases = await airtableGet(
      'WP_Leases',
      `AND(OR({Lease Status} = 'Active', {Lease Status} = 'Month-to-Month'), {Rent Due Day} != BLANK())`
    );
    const tenants = await airtableGet('WP_Tenants', `{Tenant Status} = 'Active'`);
    const tenantById = new Map(tenants.map(t => [t.id, t]));

    console.log(`[Cron: rent-reminders] ${leases.length} eligible lease(s), ${tenants.length} active tenant(s)`);

    for (const lease of leases) {
      const dueDay = Number(lease.fields['Rent Due Day']);
      if (!dueDay || dueDay < 1 || dueDay > 31) {
        results.push({ leaseId: lease.id, skipped: true, reason: `invalid Rent Due Day: ${lease.fields['Rent Due Day']}` });
        continue;
      }

      const dueDate = nextDueDate(today.year, today.month, today.day, dueDay);
      const todayUTC = new Date(Date.UTC(today.year, today.month, today.day));
      const daysUntil = Math.round((dueDate.getTime() - todayUTC.getTime()) / 86400000);

      if (![7, 3, 1].includes(daysUntil)) continue; // not a reminder day for this lease

      const amount = lease.fields['Monthly Rent Amount'] || 0;
      const dateStr = dueDate.toLocaleDateString('en-ZA', { timeZone: 'UTC', day: 'numeric', month: 'long' });

      const tenantIds = lease.fields['Tenants'] || [];
      for (const tenantId of tenantIds) {
        const tenant = tenantById.get(tenantId);
        if (!tenant) continue; // not Active, or not found -- skip silently, not an error

        const optedOut = Boolean(tenant.fields['Payment Reminder Opt-Out']) || Boolean(tenant.fields['Stop Flag (Opted Out)']);
        const phone = (tenant.fields['Whatsapp Phone Number'] || '').trim();
        if (optedOut || !phone) {
          results.push({ leaseId: lease.id, tenantId, skipped: true, reason: optedOut ? 'opted out' : 'no phone' });
          continue;
        }

        const tenantName = (tenant.fields['Full Name'] || 'there').trim().split(/\s+/)[0] || 'there';
        const msg = REMINDER_COPY[daysUntil](tenantName, amount, dateStr);

        const sendResult = await sendWhatsApp(phone, msg);
        logToAxiom(sendResult.error ? 'error' : 'info', 'rent_reminder_sent', {
          leaseId: lease.id, tenantId, phone, daysUntil, dueDate: dueDate.toISOString().split('T')[0],
          metaError: sendResult.error ? JSON.stringify(sendResult.error) : null,
        });

        results.push({ leaseId: lease.id, tenantId, phone, daysUntil, sent: !sendResult.error });
        console.log(`[Cron: rent-reminders] Sent ${daysUntil}-day reminder to ${phone} (lease ${lease.id})`);
      }
    }

    console.log('[Cron: rent-reminders] Run complete', JSON.stringify(results));
    return res.status(200).json({ ok: true, today: `${today.year}-${String(today.month + 1).padStart(2, '0')}-${String(today.day).padStart(2, '0')}`, leasesChecked: leases.length, results });

  } catch (err) {
    console.error('[Cron: rent-reminders ERROR]', err.message);
    await alertShawn('rent-reminders', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
};
