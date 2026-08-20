# Monthly report: operational + business intelligence rollup

**Branch:** `feat/wabistay-monthly-bi-report` → base `feat/wabistay-alert-shawn` (needs `alertShawn()` only — independent of the property-activity-tracker branch).

## What this is (and isn't)
Not a bigger daily/weekly summary at a monthly cadence — a distinct analytics feature comparing **this month vs last month**, presented as insight strings where possible ("Occupancy up 12% vs last month") rather than side-by-side raw numbers. No monthly cron existed before this — `manual-report.js`'s existing "monthly" option is an on-demand preview that reuses `aggregateOwnerSummary` with a 30-day window as a stand-in (see that file's own header comment); this PR builds the real thing: `aggregateMonthlyReport()`, `runMonthlyReport()`, `sendMonthlyReport()`, `monthlyReportHandler()` in `api/wabistay/webhook.js`, a new cron route `api/wabistay/cron/monthly-report.js`, scheduled `0 7 1 * *` (1st of month, 07:00 UTC — offset an hour from the existing Monday-06:00 weekly slot, arbitrary but avoids exact-minute collision) in `vercel.json`.

## Metric reliability — shipped clean vs. data-gap-limited (as requested, explicit, not silent)

| Metric | Status | Notes |
|---|---|---|
| **Revenue trend** | ✅ Clean | `Amount Due` (billed, not collected) — same field/definition `aggregateOwnerSummary.totalRevenue` already uses, so the weekly and monthly reports never disagree about what "revenue" means for the same booking. |
| **Average length of stay** | ✅ Clean | Overnight bookings only — a nights-based "length of stay" isn't a meaningful concept for Hourly bookings (different product, same table). Tested that a mixed batch doesn't let Hourly bookings drag the average down. |
| **Rating trend** | ✅ Clean | `WS_Bookings.Rating`, already captured by the existing Stage 3 Phase 3 rating flow. No new capture needed. |
| **Repeat-guest rate** | ⚠️ Scoped, not lifetime | "Repeat" means the guest has more than one booking within the `bookings` array this function receives (property-scoped, `BLOCKING_BOOKING_STATUSES` + `Checked Out`, **unbounded by date** so old bookings outside the 30-day window still count) — not true lifetime history if bookings were ever purged from Airtable. Flagged in the aggregator's own header comment. |
| **Occupancy trend** | ⚠️ Known data gap, inherited | `roomNightsAvailable = rooms.length * periodDays` — same formula `aggregateOwnerSummary` already uses, same known inaccuracy: assumes every currently-bookable room was available for the **entire** period, no accounting for a room added mid-period or one that spent part of the period in Maintenance. **Not fixed here** — this PR reuses the existing (flawed) formula rather than building a second, differently-wrong one. Every report payload carries an explicit `occupancy.denominatorCaveat` string; the deltas are directionally useful (up/down/flat) but the absolute percentages are not exact. |
| **Cleaning turnaround** | ⚠️ Proxy, not the real metric | This is the metric with the clearest known gap (CLAUDE.md BACKLOG-01): the true vacant-to-ready number is never persisted (its baseline, `WS_Rooms.'Cleaning Started At'`, is overwritten every checkout cycle). What's reported instead is `jobDurationMs` — "Cleaning Job Started At" → "Cleaning Completed At," i.e. how long the cleaner spent once dispatched, not checkout-to-sellable-again. The insight string itself says "(dispatch-to-DONE, not vacant-to-ready — see BACKLOG-01)" — labeled in the actual output, not just in a code comment, and **deliberately left out of the WhatsApp template body** (an internal ops metric the owner has no action to take on; still in the full Axiom-logged payload for anyone who wants it). |

Every "no data" case (young property, no prior month, zero bookings) returns an honest string ("no prior-month baseline to compare," "no overnight bookings this month") rather than a fake 0%, `NaN`, or a crash — tested explicitly.

## Pattern consistency with the rest of this batch
Per-property `try/catch` isolation + `alertShawn()` on failure (fires per failing property, tested end-to-end with a real assert on the alert's WhatsApp send), stubbed send pending Meta template approval (logs full payload to `monthly_report_payload` Axiom event), same `CRON_SECRET` fail-closed gate as every other cron route.

## Meta template (submission draft — CEO submits, not code)
**Name:** `wabistay_monthly_bi_report`
**Category:** UTILITY, language `en`

```
📈 {{1}} — your month in review:
{{2}}
{{3}}
{{4}}
{{5}}
{{6}}
```

Five insight lines as params (occupancy, revenue, avg length of stay, repeat-guest rate, rating — cleaning turnaround intentionally omitted, see table above), plus `{{1}}` property name. Sample values: `{{2}}` "Occupancy up 12% vs last month (68.5%)", `{{3}}` "Revenue up 8% vs last month (R12400)", `{{4}}` "Average length of stay: 2.3 nights", `{{5}}` "42% of this month's guests were repeat guests", `{{6}}` "Guest rating up 0.3/5 vs last month (4.6/5)". Parameter order is positional/load-bearing, matching `monthlyReportTemplateParams()`'s exact return order.

## Test coverage
`test/monthlyreport.test.js`, 10 tests: each metric's happy path, the no-prior-baseline and zero-bookings edge cases, the denominator-caveat and cleaning-turnaround-proxy labeling (asserted on the actual insight strings, not just that a field exists), the stubbed-send/read-only contract, template-param shape (confirms cleaning turnaround is excluded), and per-property failure isolation with a real `alertShawn` send. `test/cronauth.test.js` extended (+3) for the new route's auth gate.

Full suite: 489 passing, 0 failing.
