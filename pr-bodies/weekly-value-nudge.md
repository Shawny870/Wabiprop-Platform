# Weekly value-nudge message

**Branch:** `feat/wabistay-weekly-value-nudge` → base `feat/wabistay-property-activity-tracker` (needs `alertShawn()`, which that branch carries via its own base on `feat/wabistay-alert-shawn`).

## What this adds
A second, independent weekly WhatsApp send to owners — `runWeeklyValueNudge()` / `sendWeeklyValueNudge()` / `weeklyValueNudgeHandler()` in `api/wabistay/webhook.js`, wired into a new cron route `api/wabistay/cron/weekly-value-nudge.js`, scheduled **Thursday 06:00 UTC** in `vercel.json` (owner-summary is Monday 06:00 UTC — deliberately a different day, see judgment call below).

Bundles: bookings this week, occupancy %, upcoming bookings, and an outstanding-payments line — reusing `aggregateOwnerSummary`'s existing 7-day-window computation rather than re-deriving a parallel one. Stubbed (like `sendOwnerSummary`/`sendDailySummary`) pending Meta template approval; logs the full payload to Axiom (`weekly_value_nudge_payload`) so content is verifiable now.

Per-property `try/catch` isolation and `alertShawn()` on failure, matching the pattern established for `runOwnerSummary`/`runDailySummary` in this session — one property throwing doesn't abort the run, and the alert names the specific property that failed (tested in `test/weeklyvaluenudge.test.js`, including an end-to-end assertion that `alertShawn` actually sends when a property blows up).

## Why this is a separate feature, not a rename of owner-summary
The existing `owner-summary.js`/`OWNER_SUMMARY_TEMPLATE` is a full payment reconciliation/P&L report. This is a short "here's what's happening" nudge whose **practical side effect** is a second weekly touchpoint with the owner. WhatsApp's Coexistence rule disconnects a number after 14 days of no activity — two independent weekly sends (this one + owner-summary, once both go live) each act as their own buffer even if one fails or is skipped for a specific property in a given week.

## Judgment call — flagged
Scheduled the new cron for **Thursday**, not the same Monday slot as owner-summary. Reasoning: bunching both weekly touchpoints on the same day defeats the point of having two independent ones for the 14-day-disconnect buffer — if Monday's run fails for a property (Airtable outage, etc.), a second attempt three days later is more useful than a second attempt the same morning. Easy to change in `vercel.json` if the CEO prefers same-day.

## Known data gap — flagged, not silently inherited
`valueNudgeTemplateParams`'s occupancy % comes straight from `aggregateOwnerSummary.occupancyRate`, which is `roomNightsSold / (rooms.length * periodDays)` — it assumes every currently-bookable room was available for the **entire** period, with no accounting for a room added mid-period or one that spent part of the period in Maintenance. This is the same denominator gap flagged for Item 6 (monthly report). Deliberately reused unchanged rather than building a second, parallel (and equally wrong) occupancy calculation here — fixing the denominator is out of scope for this PR.

## Meta template (submission draft — CEO submits, not code)
**Name:** `wabistay_owner_value_nudge`
**Category:** UTILITY, language `en`

```
📊 This week at {{1}}: {{2}} booking(s), {{3}} occupancy, {{4}} upcoming.
{{5}}
```

Sample values: `{{1}}` Villa Liza Guest Lodge, `{{2}}` 3, `{{3}}` 50%, `{{4}}` 2, `{{5}}` "R150.00 outstanding from this week" (or "all payments settled"). Parameter order is positional/load-bearing, matching `valueNudgeTemplateParams()`'s exact return order — do not reorder the template body without updating that function to match.

## Test coverage
`test/weeklyvaluenudge.test.js`, 4 tests: stubbed-payload shape and read-only-ness, template param formatting (both outstanding and fully-settled cases), and per-property failure isolation with a real `alertShawn` send asserted end-to-end. `test/cronauth.test.js` extended to cover the new route's `CRON_SECRET` gate (+3 tests, same pattern as every other cron route).

Full suite: 487 passing, 0 failing.
