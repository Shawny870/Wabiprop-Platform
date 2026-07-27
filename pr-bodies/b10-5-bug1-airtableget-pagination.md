# B10.5 BUG 1 — `airtableGet` pagination past 100 records

**Branch:** committed on `feature/b19-enquiry-logging` (top of Chain A) as its own commit, separate from the B19 feature commit. **Not pushed** — CEO runs all pushes.
**FIXLOG:** F27

## 1. Diagnosis (confirmed before fixing)
The current call, pasted:

```js
const url = `.../${table}?filterByFormula=${...}`;
const res = await fetch(url, { headers: {...} });
const data = await res.json();
return data.records || [];
```

It does a **single fetch** and returns the first page. It does **not** loop on the response `offset`. Airtable's list API returns at most **100 records** per response and includes an `offset` token when more remain — so past 100 rows the helper silently truncates (no error, just a short list). `logEnquiry`'s dedup guard reads that short list, misses the booking's own row, and every completed overnight booking double-logs (Booked is reached at both `collectDetails` and `recordEta`). Revenue and turned-away counts inflate. Invisible under 100 rows — which is why the earlier mutation test passed.

## 2. Fix
`airtableGet` now loops on `offset`, appending `&offset=<token>` and accumulating every page until the response has no `offset`. This corrects **every** call site at once (the bug was in the shared helper, not any one caller).

## 3. Test past the boundary (this was the real work)
- **The live base has zero rows to test against:** `WS_Enquiries` does not exist in `appgtVqX1dK88lpRT` yet — Shawn creates it. So "verify against 100+ real records" is a **CEO device-test** once the table exists; I proved the loop in the harness instead.
- **Harness now paginates:** the mock's Airtable GET mirrors the real API — 100 records per page with an `offset` cursor. Below 100 rows it returns everything in one page with no offset (identical to before, so existing fixtures are unaffected).
- **Boundary test** (`test/enquiry.test.js`): seeds **120 realistic `WS_Enquiries` filler rows** — field shape: `Phone Number` (unique per row, distinct from the test guest), `Property` `[recP1]`, `Outcome` cycled through all four values (`Booked`/`No Availability`/`Invalid Input`/`Abandoned`), `Booking Type` (Overnight/Hourly), a past `Created At`, and a `Booking` link on the Booked ones — then completes an overnight booking (the test guest's Booked row lands at ~position 120, past the first page) and asserts exactly **one** Booked row for the guest.
- **Mutation:** with the offset loop reverted (`offset = undefined`), the 120-row test fails (double-write) while every sub-100 test stays green — confirming the fix is load-bearing and the bug is boundary-only.

`node --test` → **128 tests, 127 pass, 1 fail** (pre-existing BUG-10, unrelated).

## 4. Decision — pagination vs. document-the-cap (review item 2)
Chose **(a) real pagination** in `airtableGet`, per the transfer doc, over (b) documenting the 100-cap and phone-scoping each caller. Rationale: it fixes correctness for **all** callers at the helper, so no future call site can reintroduce the silent-truncation bug by forgetting to filter. Cost: unbounded-in-size queries now do multiple page round-trips (latency/quota) — addressed by the audit's follow-ups below, not by leaving the helper broken.

## 5. `airtableGet` call-site audit (all now correct; flagged by result-set size)
Every site is correct after the fix. Marked by whether the result set stays small or grows:

**Bounded (small result — single page in practice):**
`WS_Properties {Phone Number ID}` (≤1); `WS_Cleaners {Phone Number}` (×3, ≤ few); `WS_Guests {Phone Number}` (≤1); all `RECORD_ID()` lookups (×7, =1); `WS_Rooms {Status='Cleaning'}` (×2, transient handful); `WS_Bookings {Status='Checked In'}` (small working set); `airtableGetBookingsByGuestId` active statuses (Enquiry/Confirmed/Checked In — small).

**Unbounded-in-size (grows as data grows — now multi-page; candidates for server-side filters, NOT fixed here per "do not fix the bounded ones"):**
- **`WS_Enquiries` `''` (logEnquiry + sweep)** — the whole enquiries table, grows fastest (every attempt ever), and sits in the live message path. **Top follow-up:** a `{Phone Number}` filter (both dedup guards are phone-scoped) or a date-bounded filter would bound it. (This is the review's item 6 latency note.)
- **`WS_Bookings` all-non-cancelled (B17 owner summary, line ~1730)** — every booking ever, incl. all Checked Out. Will exceed 100 fast. Needs a date/property-scoped query before the B17 template goes live (the send is still stubbed, so not yet live).
- `WS_Rooms`/`WS_Rates` unscoped-across-properties (greeting, occupancy, gate-arrival, owner summary), `WS_Cleaners {Active}` (×2), `WS_Guests` draft-states (sweep), `WS_Properties ''` (owner summary) — all fine at the single-property pilot; grow at multi-tenant scale. Pre-existing patterns tied to the "base split before multi-tenant onboarding (B10 gate)" tech-debt note in FIXLOG.

## System impact
- One shared-helper change; behaviour identical below 100 rows, correct above it.
- Harness change is test-only and behaviour-preserving for existing fixtures.
