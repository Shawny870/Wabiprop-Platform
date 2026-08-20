# Monthly BI report: rebuild templateParams for the submitted 13-variable wabistay_owner_monthly_recap

**Branch:** `feat/wabistay-monthly-bi-template-13-params` → base `feat/wabistay-monthly-bi-repeat-guest-template-wiring` (commit `a7fd242`, itself → `main`). Built on top of the unmerged branch specifically to preserve its work rather than redo it — see "Preserved from the unmerged branch" below.

## Why

The already-submitted `wabistay_owner_monthly_recap` Meta template was built around **13 separate `{{n}}` slots** — split this-month/last-month values for occupancy, revenue, and rating. Both `main` and the previously-unmerged branch produced combined `"up X% vs last month"` delta sentences instead (6 and 10 params respectively) — a real risk of a broken send or misdirected data once Meta approves, per the prior status-report task. This rebuild replaces `monthlyReportTemplateParams()` entirely to match.

## What changed

### `monthlyReportTemplateParams(report)` — now 13 params, no combined sentences

```
{{1}}  owner name              report.ownerName (NEW — resolveOwnerName pattern, see below)
{{2}}  property name           report.propertyName
{{3}}  occupancy this-month    report.occupancy.currentPct  → "68.5%" (raw split value, not a delta sentence)
{{4}}  occupancy last-month    report.occupancy.priorPct    → "61.2%"
{{5}}  revenue this-month      report.revenue.current       → "R12400" (billed Amount Due — "earned" wording is
{{6}}  revenue last-month      report.revenue.prior         →  "R11480"  static template text, NOT baked into the param)
{{7}}  overnight booking count report.overnightBookingsCount     (preserved from the unmerged branch)
{{8}}  overnight duration-mode report.overnightDurationModeInsight (preserved, PR #52)
{{9}}  short-stay booking count report.shortStayBookingsCount     (preserved from the unmerged branch)
{{10}} short-stay duration-mode report.shortStayDurationModeInsight (preserved, PR #52)
{{11}} repeat-guest %          report.repeatGuestRate → "42%"  (preserved: 12-month rolling window, unmerged branch)
{{12}} rating this-month       report.avgRating       → "4.6"  (raw split value, not a delta sentence)
{{13}} rating last-month       report.priorAvgRating  → "4.3"
```

`report.busiestDayInsight` (PR #53) is still **not** included — placement remains an open CEO decision, unchanged from the prior pass.

**FLAG FOR CEO:** this order matches what was specified for this rebuild request. Double-check it against the *actual* submitted template body's `{{n}}` sequence before merging — a silent order mismatch here sends correct data into the wrong slot with no runtime error.

### Owner name — added, following the exact `dailySummaryTemplateParams`/`resolveOwnerName` pattern

`monthlyReportTemplateParams()` stays synchronous and pure: it expects `report.ownerName` to already be resolved and attached by the caller, and **throws** if it's missing (`undefined` or `null`) rather than silently sending "undefined" to a real owner — same reasoning, same error message shape as the daily-summary equivalent.

`sendMonthlyReport()` now calls `resolveOwnerName(property)` and attaches it before building params, mirroring `sendDailySummary()` exactly. A property with no linked `WS_Owners` record throws inside `sendMonthlyReport`, which `runMonthlyReport`'s existing per-property `try/catch` already isolates (logs `monthly_report_property_failed`, fires `alertShawn`, excludes that property from `sent` — no new isolation logic needed, the pattern already existed).

### Split values: no new aggregation needed

`aggregateMonthlyReport()` was **not changed** — `occupancy.currentPct`/`.priorPct`, `revenue.current`/`.prior`, and `avgRating`/`priorAvgRating` were already computed as separate this-month/last-month values; only `insights[]` combined them into delta sentences via `pctDeltaInsight()`. `monthlyReportTemplateParams()` now reads the raw split fields directly instead of `insights[]` for these three metrics. `insights[]` itself is untouched — still available for Axiom/internal use.

### Formatting decisions

- **Revenue:** `R${Math.round(value)}` — e.g. `"R12400"`. No thousands-comma grouping: none exists anywhere else in this codebase's currency formatting (`formatAmount`, `formatSignedAmount`, every inline `R${...}` site), so this matches the file's actual existing convention rather than inventing a new one. If Meta's approved template body expects comma-grouped figures, that's a follow-up formatting change, not a data-source change.
- **Occupancy:** raw percent + `%` suffix — e.g. `"68.5%"`.
- **Rating:** plain number, no `/5` suffix — e.g. `"4.6"` (the `/5` was part of the old combined sentence's static text, not meaningful in a split raw-value slot).
- **Null handling:** any of occupancy/rating/repeat-guest that has no data this or last month renders as the literal string `"N/A"` — never `"null"`, `"undefined"`, or `NaN`. Revenue is never null (`reduce` defaults to 0).

## Preserved from the unmerged branch (`feat/wabistay-monthly-bi-repeat-guest-template-wiring`, not redone)

- Repeat-guest rate: rolling 12-month-prior window keyed on the `Guest` linked-record ID (unchanged).
- `report.overnightBookingsCount` / `report.shortStayBookingsCount` (unchanged).
- `overnightDurationModeInsight` / `shortStayDurationModeInsight` from PR #52 (unchanged).
- All of PR #53's `busiestDayInsight`/`busiestDay` fields (unchanged, still not wired into the template).

This branch is built directly on top of that one (`a7fd242` is in its history) specifically so none of that work needed reimplementing.

## Test coverage

`test/monthlyreport.test.js`: rewrote the `monthlyReportTemplateParams` test block (previously asserting the 6/10-param shapes) into 10 tests covering: all 13 params in order against a known dataset, split-not-combined assertion for occupancy/revenue/rating, revenue formatting + no "earned" wording baked in, `N/A` handling for null metrics, that duration-mode/counts/repeat-guest carry over unchanged, `busiestDayInsight` and cleaning-turnaround exclusion, and `ownerName`-missing throw behavior (undefined and null cases) — mirroring `dailysummarytemplateparams.test.js`'s structure. Added 2 end-to-end tests proving `runMonthlyReport` actually wires `resolveOwnerName` → `monthlyReportTemplateParams` on the live path (a real linked owner produces correct params; a property with no linked owner throws, is isolated, and is excluded from `sent`). Updated the pre-existing `runMonthlyReport`/`alertShawn` isolation tests to add `Owner`/`WS_Owners` fixtures so they don't now fail on the new owner-name requirement for unrelated reasons.

Full suite: 542 passing, 0 failing.

## Final param count for CEO diff against the submitted body

**13 params.** Full source list is the `{{1}}`–`{{13}}` table above.
