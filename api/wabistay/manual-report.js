// /api/wabistay/manual-report.js
// CEO-only manual trigger to preview daily/weekly/monthly report content on
// demand, against CURRENT LIVE Airtable data — so CEO/Design Engineer can see
// real report content without waiting on cron timing or calendar boundaries.
//
// Deliberately separate from the real crons (daily-summary.js /
// owner-summary.js) and does NOT touch or replace either: ignores the
// hour-match/schedule gate entirely and fires immediately regardless of the
// current time/day. Lives outside api/wabistay/cron/ (not under cron/)
// precisely because it is not on a schedule — nothing in vercel.json points
// at this route.
//
// Auth: a SEPARATE secret (MANUAL_REPORT_SECRET), not CRON_SECRET. This
// endpoint is invoked by a person typing a request, not GitHub Actions/Vercel
// cron — different trust boundary, so it gets its own credential rather than
// sharing the machine-to-machine cron secret. Fails closed: an unset secret
// refuses every request, same pattern as daily-summary.js / owner-summary.js.
//
// Reuses the exact same aggregation + send functions the real crons call:
// daily -> aggregateDailySummary/sendDailySummary (still stubbed, pending
// DAILY_SUMMARY_TEMPLATE approval); weekly -> aggregateWeeklyRecap/
// sendWeeklyRecap; monthly -> aggregateMonthlyReport/sendMonthlyReport.
//
// weekly/monthly ARE LIVE as of their templates' Meta approval — this
// endpoint CAN send a real WhatsApp message for those two report types. Both
// send functions are routed through the REPORT_TEST_MODE_PHONE gate (see
// resolveSendRecipient in webhook.js), which is exactly why this endpoint
// exists per this task: set REPORT_TEST_MODE_PHONE in Vercel, hit this route
// for a real property, and the send goes to that one number instead of the
// real owner — verify content against your own phone before unsetting the
// var and letting the crons reach real owners. daily is unaffected — its
// template is still unapproved, so sendDailySummary remains a stub.
const wh = require('./webhook.js');

const VALID_REPORT_TYPES = ['daily', 'weekly', 'monthly'];
const DAY_MS = 24 * 60 * 60 * 1000;

module.exports = async function handler(req, res) {
  const secret = process.env.MANUAL_REPORT_SECRET;
  const auth = req.headers.authorization || '';
  if (!secret || auth !== `Bearer ${secret}`) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }

  // Input validation happens entirely before any Airtable call — a malformed
  // request should not burn an API call it was never going to succeed with.
  const propertyId = req.query ? req.query.propertyId : undefined;
  const reportType = req.query ? req.query.reportType : undefined;

  if (!propertyId || typeof propertyId !== 'string') {
    return res.status(400).json({ ok: false, error: 'missing or invalid propertyId — must be a non-empty string (Airtable record ID)' });
  }
  // Exact-match only: wrong case ('Daily', 'WEEKLY') is rejected, not
  // silently normalized — a caller that typos the case should see an error,
  // not a report for a type it didn't ask for.
  if (!reportType || typeof reportType !== 'string' || !VALID_REPORT_TYPES.includes(reportType)) {
    return res.status(400).json({
      ok: false,
      error: `invalid reportType${reportType ? `: '${reportType}'` : ' (missing)'} — must be exactly one of: ${VALID_REPORT_TYPES.join(', ')}`
    });
  }

  let properties;
  try {
    properties = await wh.airtableGet('WS_Properties', `RECORD_ID() = '${propertyId}'`);
  } catch (err) {
    console.error('[MANUAL-REPORT] property lookup failed', err.message, err.stack);
    return res.status(502).json({ ok: false, error: `airtable lookup failed: ${err.message}` });
  }
  const property = properties[0];
  if (!property) {
    // Named, explicit 404 — never silently falls through to a default
    // property, never throws an unhandled exception at the caller.
    return res.status(404).json({ ok: false, error: `no property found for propertyId '${propertyId}'` });
  }

  try {
    if (reportType === 'daily') {
      const now = new Date();
      const todayYmd = wh.sastCalendarDate(now);
      const tomorrowYmd = wh.addSastDays(todayYmd, 1);

      // Unfiltered rooms — same as runDailySummary — includes Maintenance so
      // the room-state grid counts it rather than silently dropping rooms.
      const allRooms = await wh.airtableGet('WS_Rooms', '');
      const allBookings = await wh.airtableGet('WS_Bookings', wh.orFormula('Status', wh.BLOCKING_BOOKING_STATUSES.concat(['Checked Out'])));
      const allGuests = await wh.airtableGet('WS_Guests', '');
      const guestsById = new Map(allGuests.map(g => [g.id, g.fields['Guest Name'] || null]));

      const rooms = allRooms.filter(r => (r.fields['Property'] || []).includes(property.id));
      const roomIds = new Set(rooms.map(r => r.id));
      const bookings = allBookings.filter(b => (b.fields['Room'] || []).some(id => roomIds.has(id)));

      // aggregateDailySummary produces a full zeroed/empty payload for a
      // property with no matching bookings today (empty arrays, 0 totals,
      // null averages) — it never throws or returns a partial shape, so a
      // brand-new property with zero activity comes back as a normal 200
      // with every section present, not an error.
      const summary = wh.aggregateDailySummary(property, rooms, bookings, { todayYmd, tomorrowYmd }, guestsById);
      const payload = await wh.sendDailySummary(property, summary);

      return res.status(200).json({
        ok: true,
        reportType: 'daily',
        manual: true,
        propertyId: property.id,
        propertyName: property.fields['Property Name'],
        payload
      });
    }

    // weekly -> aggregateWeeklyRecap/sendWeeklyRecap (wabistay_owner_weekly_recap).
    // monthly -> aggregateMonthlyReport/sendMonthlyReport (wabistay_owner_monthly_recap).
    // Each has its own window shape — monthly needs priorPeriodStartMs for its
    // this-vs-last-month comparison, weekly needs upcomingEndMs for the
    // next-7-days arrivals count — so these are NOT interchangeable the way
    // this endpoint's old 7-day/30-day aggregateOwnerSummary reuse was.
    const now = new Date();
    const periodEndMs = now.getTime();
    const periodDays = reportType === 'weekly' ? 7 : 30;

    const allRooms = await wh.airtableGet('WS_Rooms', wh.orFormula('Status', wh.BOOKABLE_ROOM_STATUSES));
    const allBookings = await wh.airtableGet('WS_Bookings', wh.orFormula('Status', wh.BLOCKING_BOOKING_STATUSES.concat(['Checked Out'])));
    const allGuests = await wh.airtableGet('WS_Guests', '');
    const guestsById = new Map(allGuests.map(g => [g.id, g.fields['Guest Name'] || null]));

    const rooms = allRooms.filter(r => (r.fields['Property'] || []).includes(property.id));
    const roomIds = new Set(rooms.map(r => r.id));
    const bookings = allBookings.filter(b => (b.fields['Room'] || []).some(id => roomIds.has(id)));

    // Same "empty is not an error" guarantee as daily: both aggregators
    // return zeroed totals/honest "no data" fields for zero matching
    // bookings, not a thrown error or a malformed shape. A missing linked
    // WS_Owners record IS a thrown error (ownerName is required) — same
    // loud-failure behavior as the real crons, not swallowed here.
    let payload;
    if (reportType === 'weekly') {
      const w = {
        periodDays,
        periodStartMs: periodEndMs - periodDays * DAY_MS,
        periodEndMs,
        upcomingEndMs: periodEndMs + 7 * DAY_MS
      };
      const report = wh.aggregateWeeklyRecap(property, rooms, bookings, w, guestsById);
      payload = await wh.sendWeeklyRecap(property, report);
    } else {
      const w = {
        periodDays,
        periodStartMs: periodEndMs - periodDays * DAY_MS,
        priorPeriodStartMs: periodEndMs - 2 * periodDays * DAY_MS,
        periodEndMs
      };
      const report = wh.aggregateMonthlyReport(property, rooms, bookings, w, guestsById);
      payload = await wh.sendMonthlyReport(property, report);
    }

    return res.status(200).json({
      ok: true,
      reportType,
      manual: true,
      // Distinct from the "zero records" case above: this fires unconditionally
      // for weekly/monthly because the window is always "whatever real data
      // exists in the last N days," not a guarantee that a full period of
      // history exists yet. Sparse numbers here reflect a young property/window,
      // not a bug — the zero-records case (point 9) still returns this same
      // flag, honestly, rather than trying to distinguish "new property" from
      // "slow week" (this endpoint has no way to tell those apart from bookings
      // data alone).
      partialWindowNote: `${periodDays}-day window against whatever real Airtable data currently exists for this property — not necessarily a full real ${reportType === 'weekly' ? 'week' : 'month'} of activity. Small or zero numbers reflect actual history, not an error.`,
      propertyId: property.id,
      propertyName: property.fields['Property Name'],
      payload
    });
  } catch (err) {
    console.error('[MANUAL-REPORT FATAL]', err.message, err.stack);
    return res.status(500).json({ ok: false, error: err.message });
  }
};
