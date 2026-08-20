# Monthly BI report: fix templateParams to the actually-approved 11-param wabistay_owner_monthly_recap

**Branch:** `feat/wabistay-monthly-bi-template-11-params` → base `feat/wabistay-monthly-bi-template-13-params` (which itself sits on top of `feat/wabistay-monthly-bi-repeat-guest-template-wiring` → `main`). Built on top of the 13-param branch specifically to preserve the split occupancy/revenue/rating logic, owner-name resolution, 12-month repeat-guest window, and duration-mode calculation — none of that needed rebuilding, only the overnight/short-stay param shape was wrong.

## Why

The 13-param build (previous branch) was wrong: it split overnight and short-stay each into a separate count param + duration-mode-sentence param (4 params total). The **actually approved** `wabistay_owner_monthly_recap` template, confirmed directly from Meta Business Manager's edit view, has **11 variables** — overnight and short-stay each get **one combined slot**, not two. Left as-was, this would have broken the live send (wrong param count entirely) or misaligned every param from position 7 onward once Meta approval landed.

## What changed

**Merge order note carried forward:** this branch is built on `feat/wabistay-monthly-bi-template-13-params`, which is itself built on `feat/wabistay-monthly-bi-repeat-guest-template-wiring`. Merge **only this branch** — it supersedes both of the others (contains everything from them plus this fix). Don't merge all three separately.

### Final 11-param order (confirmed)

```
{{1}}  owner name              report.ownerName
{{2}}  property name           report.propertyName
{{3}}  occupancy this-month    report.occupancy.currentPct     → "68.5%"
{{4}}  occupancy last-month    report.occupancy.priorPct       → "61.2%"
{{5}}  revenue this-month      report.revenue.current          → "R12400" (billed; "earned" stays static template text)
{{6}}  revenue last-month      report.revenue.prior            → "R11480"
{{7}}  overnight bookings      overnightBookingsParam(count, durationModeInsight) — ONE combined sentence
{{8}}  short-stay bookings     shortStayBookingsParam(count, durationModeInsight) — ONE combined sentence
{{9}}  repeat-guest %          report.repeatGuestRate → "42%" (12-month rolling window, unchanged)
{{10}} rating this-month       report.avgRating       → "4.6"
{{11}} rating last-month       report.priorAvgRating  → "4.3"
```

`report.busiestDayInsight` (PR #53) remains excluded — still an open CEO decision, unchanged from prior passes.

### {{7}}/{{8}}: combining count + duration-mode into one sentence

Two new small formatter functions, `overnightBookingsParam(count, durationSentence)` and `shortStayBookingsParam(count, durationSentence)`, sit directly above `monthlyReportTemplateParams()`. **`durationModeInsight()`'s mode-vs-average-vs-tie decision logic (PR #52) is completely untouched** — these functions call it exactly as before (via the existing `report.overnightDurationModeInsight`/`shortStayDurationModeInsight` fields) and only reformat its output string:

- **Zero bookings** (decided from `count`, not by parsing the sentence — doesn't depend on that string's exact wording staying stable): `"No overnight bookings this month."` / `"No short-stay bookings this month."`
- **Clear mode** (durationModeInsight's `"Most ... guests stayed ..."` case): reworded per the approved copy —
  - Overnight: `"{{count}} overnight booking(s) this month — most guests stayed {{n}} night(s)."`
  - Short-stay: `"{{count}} short-stay booking(s) this month — most guests booked {{n}}-hour stays."` (different verb/noun order than overnight, per the approved template text — this is copy, not logic, so it's hardcoded per booking type)
- **Average fallback** (tie, or below `durationModeInsight`'s minimum booking count): reuses `durationModeInsight`'s **existing average sentence verbatim**, just stripped of its redundant leading noun and prefixed with the count — e.g. `"2 overnight bookings this month — guests stayed an average of 2 nights."` Per instructions: don't reword the fallback, just combine it with the count.

### Example outputs (for CEO's side-by-side check against the Meta screenshots)

| # | Represents | Source | Example output |
|---|---|---|---|
| 1 | Owner name | `report.ownerName` | `Villa Liza Owner` |
| 2 | Property name | `report.propertyName` | `Villa Liza Guest Lodge` |
| 3 | Occupancy this-month | `report.occupancy.currentPct` | `68.5%` |
| 4 | Occupancy last-month | `report.occupancy.priorPct` | `61.2%` |
| 5 | Revenue this-month | `report.revenue.current` | `R12400` |
| 6 | Revenue last-month | `report.revenue.prior` | `R11480` |
| 7 | Overnight bookings | `overnightBookingsParam(...)` | `4 overnight bookings this month — most guests stayed 2 nights.` (or, below the mode threshold / tied: `2 overnight bookings this month — guests stayed an average of 3 nights.`; zero: `No overnight bookings this month.`) |
| 8 | Short-stay bookings | `shortStayBookingsParam(...)` | `3 short-stay bookings this month — most guests booked 2-hour stays.` (average fallback: `4 short-stay bookings this month — guests stayed an average of 2 hours.`; zero: `No short-stay bookings this month.`) |
| 9 | Repeat-guest % | `report.repeatGuestRate` | `42%` |
| 10 | Rating this-month | `report.avgRating` | `4.6` |
| 11 | Rating last-month | `report.priorAvgRating` | `4.3` |

**Final param count: 11**, matching the approved template exactly.

## Weekly template — untouched, as instructed

No changes anywhere to `runWeeklyValueNudge`, `sendWeeklyValueNudge`, `valueNudgeTemplateParams`, or any weekly-report code path. Confirmed via `git diff main...HEAD -- api/wabistay/webhook.js | grep -i weekly` — zero matches.

## Test coverage

Rewrote the 13-param test block into 11-param equivalents, and added dedicated `{{7}}`/`{{8}}` tests reusing PR #52's exact scenarios (clear mode, tie, below-minimum-count, zero-bookings) against the new combined-string format, for both overnight and short-stay. All prior coverage (split occupancy/revenue/rating, owner-name resolution/throw behavior, 12-month repeat-guest window, busiestDayInsight/cleaning-turnaround exclusion, end-to-end `runMonthlyReport` wiring) carried forward unchanged.

Full suite: 548 passing, 0 failing.
