# Monthly template-name fix, weekly recap rebuild, and live-send enablement (gated)

**Branch:** `feat/wabistay-weekly-recap-live-send` → base `main`.

## Scope decisions made mid-task (flagging, not burying)

Two clarifying questions were asked and answered before any code was written:

1. **manual-report.js's weekly/monthly branches were rewired** (confirmed) to call the new `aggregateWeeklyRecap`/`sendWeeklyRecap` and the already-correct `aggregateMonthlyReport`/`sendMonthlyReport`, instead of the stale `aggregateOwnerSummary`/`sendOwnerSummary` reuse that predated this session's monthly work.
2. **`runOwnerSummary` was NOT retired**, despite the original task instruction to retire it. It is a substantial, separately-tested payment-reconciliation/P&L feature ("the weekly P&L IS the product," own header comment) with its own pending Meta template (`wabistay_owner_weekly_summary` — a third, different name from both approved templates), a daily-mode toggle explicitly cross-tested against `runDailySummary` (Rule 29, `test/dailysummary.test.js`), and ~15+ dedicated tests across `test/ownersummary.test.js`, `test/airtablecallcount.test.js`, and `test/extension.pricing.test.js`. It was never the implementation of `wabistay_owner_weekly_recap` — deleting it would have discarded a working, unrelated feature under a mistaken assumption. **Confirmed twice** before proceeding: only `runWeeklyValueNudge` (a genuine dead end — own test file, own cron, 5 wrong-shape params, never matched any approved template) was retired.

## 1. Monthly template name — fixed

```diff
- const MONTHLY_REPORT_TEMPLATE = 'wabistay_monthly_bi_report';
+ const MONTHLY_REPORT_TEMPLATE = 'wabistay_owner_monthly_recap';
```

No other monthly changes — the 11-param `monthlyReportTemplateParams()` was already confirmed correct in the prior session.

## 2. Weekly rebuilt as `runWeeklyRecap` (7 params, Meta-approved)

New: `aggregateWeeklyRecap()`, `weeklyRecapTemplateParams()`, `sendWeeklyRecap()`, `runWeeklyRecap()`, `weeklyRecapHandler()`, `WEEKLY_RECAP_TEMPLATE = 'wabistay_owner_weekly_recap'`.

Retired: `runWeeklyValueNudge`, `sendWeeklyValueNudge`, `valueNudgeTemplateParams`, `weeklyValueNudgeHandler`, `VALUE_NUDGE_TEMPLATE` — all deleted, including their exports. Confirmed via grep that nothing else in the codebase referenced them before deleting.

**`aggregateWeeklyRecap`** reuses `aggregateOwnerSummary` wholesale for occupancy and upcoming-arrivals (same CEO-confirmed exact-7-days-ahead window, same room-night occupancy formula, same inherited denominator gap — documented on `aggregateOwnerSummary` itself, not re-documented here). It adds only what didn't already exist for the weekly window:
- **Overnight/short-stay booking-type split** — did NOT already exist for weekly (only monthly had this, from PR #52's work) — built by filtering `periodBookings` (Check-In this week) by `Booking Type`, mirroring `aggregateMonthlyReport`'s exact pattern.
- **Outstanding payment scoped to stays that COMPLETED this week** — deliberately Check-Out-scoped, not Check-In-scoped like `aggregateOwnerSummary`'s own `paymentDeltaTotal`. Reuses the existing `paymentReconciliationLines()` pure function against a Check-Out-filtered booking set, rather than a new calculation.

**Param order** (`{{1}}`–`{{7}}`), confirmed from Meta Business Manager:
```
{{1}} owner name          resolveOwnerName(property) — same pattern as monthly/daily, throws if missing
{{2}} property name       report.propertyName
{{3}} overnight count     report.overnightBookingsCount
{{4}} short-stay count    report.shortStayBookingsCount
{{5}} occupancy %         report.occupancyRate (this week)
{{6}} upcoming arrivals   report.upcomingBookings (next 7 days, exact window — reused from aggregateOwnerSummary)
{{7}} outstanding amount  report.outstandingFromCompletedStays → "R0"–"R999", never negative, never blank
```

**Cron:** `api/wabistay/cron/weekly-value-nudge.js` renamed to `weekly-recap.js` (git-tracked rename), repointed to `weeklyRecapHandler`, **same Thursday 06:00 UTC slot** — `owner-summary.js`'s Monday 06:00 UTC slot is untouched (still `runOwnerSummary`, unrelated feature). `vercel.json` updated to the new path.

## 3. Test-mode gate — `REPORT_TEST_MODE_PHONE`

New `resolveSendRecipient(realRecipientPhone, site, correlation)` in `webhook.js`, next to `sendWhatsAppTemplate`. The entire safety mechanism, exactly as specified — no second gating layer:
- Unset → real recipient passed through unchanged.
- Set → every send (weekly + monthly, any property) redirects to that one number, and a `report_test_mode_redirect` Axiom event logs the real intended recipient alongside the redirect, so "this would have gone to [owner]" is verifiable without them receiving it.

**`REPORT_TEST_MODE_PHONE` is not set anywhere in this repo** — it's a Vercel env var the CEO controls manually, per instructions.

## 4. Live sends enabled, both gated through the same mechanism

`sendMonthlyReport` and `sendWeeklyRecap` both now call `sendWhatsAppTemplate(...)` for real (previously commented-out TODO stubs in both), with the recipient resolved through `resolveSendRecipient` first. Both throw a loud, named error if no recipient phone is available at all (no `Notify Phone` and no `OWNER_PHONE` fallback) — isolated by the existing per-property `try/catch` in each `run*` function, same as the `ownerName`-missing throw.

## 5. Manual-trigger path (answered directly, then extended)

**Already existed** — `api/wabistay/manual-report.js`, CEO-only, gated by its own `MANUAL_REPORT_SECRET` (not `CRON_SECRET`), not on any cron schedule:

```bash
curl -X GET \
  "https://<vercel-domain>/api/wabistay/manual-report?propertyId=<AIRTABLE_RECORD_ID>&reportType=weekly" \
  -H "Authorization: Bearer $MANUAL_REPORT_SECRET"
```
(`reportType=monthly` or `daily` also valid.)

**Rewired in this branch** (confirmed): its weekly/monthly branches now call the correct new/existing functions instead of the stale `aggregateOwnerSummary`/`sendOwnerSummary` reuse, and its header comment is corrected — it previously claimed "this route cannot send a real message regardless of report type," which is now **false** for weekly/monthly (both live). This is exactly the tool the CEO should use to test against his own number: set `REPORT_TEST_MODE_PHONE` in Vercel, hit this endpoint for a real property, verify content, then unset the var before the real crons reach real owners. `daily` is unaffected — its template is still unapproved, so `sendDailySummary` remains stubbed.

## Test coverage

- `test/weeklyrecap.test.js` (renamed from `weeklyvaluenudge.test.js`, rewritten): overnight/short-stay split, Check-Out-scoped outstanding-payment logic (including the "started but not yet completed" exclusion case and the never-negative-on-overpayment case), reuse-of-`aggregateOwnerSummary` equivalence check, zero-booking handling, 7-param order/sourcing, `ownerName`-missing throws (undefined and null), and end-to-end `runWeeklyRecap` tests proving the live send actually fires and per-property failure isolation still works.
- `test/reporttestmodegate.test.js` (new): the gate function in isolation (unset passes through, set redirects, logs the real intended recipient) and end-to-end proof for both `runMonthlyReport` and `runWeeklyRecap` that the gate is actually honored on the live path, both when set and unset.
- `test/monthlyreport.test.js`: updated the one test that asserted "still stubbed, `ctx.sends.length === 0`" to reflect the now-live send.
- `test/cronauth.test.js`: updated its cron-file list for the `weekly-value-nudge.js` → `weekly-recap.js` rename.
- `test/ownersummary.test.js`, `test/airtablecallcount.test.js`, `test/dailysummary.test.js` (Rule 29), `test/extension.pricing.test.js`: all pass unchanged — `runOwnerSummary` was not touched.

Full suite: 562 passing, 0 failing.

## For the CEO

1. This branch is ready to merge — nothing further needed for the code itself.
2. To test: set `REPORT_TEST_MODE_PHONE` in Vercel's env vars to your own WhatsApp number, redeploy, then hit `manual-report.js` (see the curl above) for a real property with `reportType=weekly` and `reportType=monthly`. Both should arrive on your phone with correct content.
3. When satisfied, unset `REPORT_TEST_MODE_PHONE` in Vercel — the next real cron firing (Monday 06:00 UTC for owner-summary, Thursday 06:00 UTC for weekly-recap, 1st-of-month 07:00 UTC for monthly-report) will reach real owners.
4. `runOwnerSummary` (the P&L reconciliation feature) is still fully stubbed, still pending its own `wabistay_owner_weekly_summary` Meta approval — untouched by this branch, not part of this task's scope.
