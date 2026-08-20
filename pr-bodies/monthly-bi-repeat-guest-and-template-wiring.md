# Monthly BI report: 12-month repeat-guest window, revenue confirmation, duration-mode template wiring

**Branch:** `feat/wabistay-monthly-bi-repeat-guest-template-wiring` → base `main` (needs `aggregateMonthlyReport()`/`monthlyReportTemplateParams()` from `feat/wabistay-monthly-bi-report`, and `durationModeInsight()`/`overnightDurationModeInsight`/`shortStayDurationModeInsight` from PR #52 — both already merged).

## Item 1 — Repeat-guest definition: rolling 12-month window

**Changed.** `repeatGuestRate` in `aggregateMonthlyReport()` now counts a guest as repeat only if they have a booking this month **and** at least one other booking with a Check In date in the 12 months immediately prior to this report's period — not the previous lifetime-unbounded definition (any other booking anywhere in the fetched set, regardless of age).

- The 12-month-prior window boundary sits at `periodStartMs`, so a booking inside the current period can never be its own "prior" match — no separate exclusion check needed, it falls out of the date-range split automatically.
- **Guest-identity field:** the booking's linked `Guest` record ID (`booking.fields['Guest']`) — the same field every other repeat-adjacent read in this file already uses. **Not** a raw phone-number string comparison, and confirmed reliable: `WS_Guests` records are already deduped by `'Phone Number'` at guest-creation time (see the WALKIN guest-identity block, `webhook.js` ~line 1907 — "without one [a phone] there is nothing to match on, so a name-only record is created and repeat-guest tracking simply does not apply to this booking (locked)"). By the time a report reads `booking.fields['Guest']`, any guest reachable by phone already has one stable ID; a phone-less guest gets an always-unique record and is correctly never falsely matched. This was already the existing, documented, locked behavior — no new guest-matching logic was needed, only the date window.
- `runMonthlyReport`'s Airtable query was already unbounded-by-date (fetches all `WS_Bookings` regardless of age, per its own header comment) specifically so this and the prior-month window could see bookings outside the current 30 days — no query change needed, the fetch already covers the new 365-day lookback.

Tests added: a booking 45 days prior still counts (within the window), a booking 400 days prior no longer counts (rolling window, not lifetime), and two same-month bookings with no earlier history do NOT count as repeat (the definition measures returning-from-a-previous-visit, not double-booking-same-month).

## Item 2 — Revenue definition: **confirmed mismatch, flagged, NOT changed**

**Current implementation is billed revenue, not collected.** `revenue`/`priorRevenue` in `aggregateMonthlyReport()` sum `Amount Due` across bookings with Check In in the period — this is money billed, not money actually collected. This is explicit and deliberate in the existing code (`webhook.js`, header comment ~line 4170: *"Uses 'Amount Due' ... not 'Amount Paid' — so this is billed revenue, not collected cash. Same definition as the existing weekly report, deliberately, so the two reports never disagree about what 'revenue' means for the same booking."*).

**This differs from what was asked to confirm** (billed minus outstanding = collected). `WS_Bookings.'Amount Paid'` does exist and is already read elsewhere (`paymentReconciliationLines`, `webhook.js` ~line 4031) — so a "collected" figure is computable — but **not built in this branch**, because:
1. This item's instructions were confirm-only ("confirm... flag explicitly if..."), not a build instruction.
2. Changing the definition affects the weekly report too if consistency is meant to be preserved (explicitly documented as a deliberate design choice), which is a bigger decision than this task's scope.

**Flagging for a decision:** does the CEO want (a) monthly revenue changed to collected (`Amount Paid` scoped to the same window), (b) the weekly report changed to match, or (c) revenue left as billed and the Meta template copy adjusted to say "billed" rather than implying collected? No code change made pending that call.

## Item 3 — Wire duration-mode insights into the template (CEO-confirmed Option B)

**Changed.** `monthlyReportTemplateParams()` now returns 10 params instead of 6:

```
{{1}}  propertyName
{{2}}  occupancy insight
{{3}}  revenue insight
{{4}}  avg length of stay insight
{{5}}  repeat-guest insight
{{6}}  rating insight
{{7}}  overnight bookings count (NEW — report.overnightBookingsCount, already trivially available as overnightCurrent.length)
{{8}}  overnight duration-mode insight (PR #52)
{{9}}  short-stay bookings count (NEW — report.shortStayBookingsCount, already trivially available as hourlyCurrent.length)
{{10}} short-stay duration-mode insight (PR #52)
```

`report.busiestDayInsight` (PR #53) is **not** included — placement is still an open CEO decision, per instructions.

### Updated template body (Option B) and char count with real example data

```
📈 {{1}} — your month in review:
{{2}}
{{3}}
{{4}}
{{5}}
{{6}}

Overnight bookings: {{7}}
{{8}}

Short-stay bookings: {{9}}
{{10}}
```

Filled with representative sample values (property "Villa Liza Guest Lodge," 18 overnight bookings, 9 short-stay bookings, existing PR #52/#49 sample insight text):

```
📈 Villa Liza Guest Lodge — your month in review:
Occupancy up 12% vs last month (68.5%)
Revenue up 8% vs last month (R12400)
Average length of stay: 2.3 nights
42% of this month's guests were repeat guests
Guest rating up 0.3/5 vs last month (4.6/5)

Overnight bookings: 18
Most overnight guests stayed 2 nights.

Short-stay bookings: 9
Most short-stay guests stayed 2 hours.
```

**Variable count: 10** (`{{1}}`–`{{10}}`).
**Filled-body character count: 376** — well within Meta's Utility 1024-char limit.

## Test coverage
`test/monthlyreport.test.js`: 2 new repeat-guest tests (12-month window boundary, same-month-only doesn't count) alongside the existing prior-booking test (still passes unchanged — 45 days prior falls inside the new window), and 1 new template-wiring test asserting all 10 params land in the correct `{{n}}` position and that `busiestDayInsight` is excluded.

Full suite: 532 passing, 0 failing.
