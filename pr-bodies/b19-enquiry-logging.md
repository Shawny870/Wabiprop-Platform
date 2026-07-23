# B19: enquiry logging

**Branch:** `feature/b19-enquiry-logging` → base `feature/b14-stop-optout` (top of Chain A — needs B9's hourly flow and the sprint's refusal paths)
**Label:** none (no guest-facing copy, no pricing, no `states.json` transitions)
**FIXLOG:** F26

## Why this matters
"3 enquiries turned away, no room free" is the single most sellable line in the
weekly owner summary — no competitor can report it, because no competitor sees
the enquiry that never became a booking. Today those attempts vanish (B8 refuses
and nothing is recorded). This captures them, plus abandonment data (Caillin's
single-line failure would have been a report line, not an accidental discovery).

## What it does
A new `WS_Enquiries` row at every terminal point of a booking attempt:
- **Booked** — at booking creation (`collectDetails` overnight / `selectHourlyDuration` hourly); the resulting `WS_Bookings` record is linked. Re-affirmed at `recordEta`, deduped by booking id.
- **No Availability** — at the B8 overnight refusal and the B9 hourly refusal, with the requested dates captured. The revenue-relevant one.
- **Invalid Input** — at the `collectDetails` parser-reject (the bot re-prompted). Deduped so repeated fumbles in one attempt collapse to a single open row.
- **Abandoned** — a **staleness sweep** (`runEnquiryAbandonment`) that **reuses the B12 auto-checkout cron** (no second cron). A draft-bearing enquiry guest who provided a name and whose `Last Inbound At` is older than **24 hours** (window stated), with no enquiry row already covering the attempt, is logged Abandoned; property is recovered from the pending booking's room.

Partial rows are written (an attempt that dies before dates are given logs with
blank date fields). Every row is property-scoped via `[ctx.property.id]`.

## One-write enforcement (how)
A single booking attempt produces exactly one row, via three dedup guards inside
`logEnquiry` / the sweep:
1. **Booking-id dedup** (Booked): the overnight flow reaches "Booked" at both creation and confirmation; only the first lands.
2. **Open-Invalid-Input dedup**: no second booking-less Invalid-Input row for the same phone, so repeated fumbles collapse.
3. **Created-since-last-inbound dedup** (sweep): the sweep skips a guest who already reached a terminal on their last message.

Two **separate** attempts (a refusal, then a booking) are two terminal events and
correctly produce two rows — proven by `test/enquiry.test.js`.

## Schema — CEO creates (not in `schema.json`)
**New table `WS_Enquiries`** (exact names, Title Case):
Phone Number (text), Property (link→WS_Properties), Requested Check In (dateTime),
Requested Check Out (dateTime), Booking Type (singleSelect Overnight/Hourly),
Outcome (singleSelect Booked/No Availability/Abandoned/Invalid Input), Created At
(dateTime), Booking (link→WS_Bookings).

**Also new: `WS_Guests.Last Inbound At` (dateTime)** — the sweep's staleness anchor.

## FLAG — genuinely undefined / noted
- **Abandonment window**: chosen as **24 hours since last inbound with no terminal outcome** (per the brief's guidance), configurable via `ENQUIRY_ABANDON_MS`.
- **`Last Inbound At` precision**: piggybacked onto the existing guest updates that enter the draft states (no new write, no fixture churn). This tracks **last flow progress**, not literally every inbound message; precise last-inbound would need a write on every message. Enough for a 24h sweep; flagged.
- **Invalid Input vs Abandoned**: Invalid Input is logged immediately at the parser reject (keeps `ctx.property` for scoping); Abandoned is the sweep for draft-bearing guests. A guest who reaches the details step and simply never replies (no bad input) is not separately logged — it would need a per-guest re-prompt flag; flagged as out of scope.

## Tests
`node --test` → **127 tests, 126 pass, 1 fail** (pre-existing BUG-10, unrelated).
- 21 existing booking-flow fixtures updated to assert the new enquiry write (Booked / No Availability / Invalid Input, per path).
- `64_enquiry_booked_links_booking` — Booked row with the Booking linked.
- `test/enquiry.test.js` — sequential attempts → exactly two rows; full booked flow → one Booked row (collectDetails + recordEta deduped, booking linked); property scoping; Abandoned sweep (property from the booking); sweep does not double-log an already-terminal attempt; sweep leaves a recent/active draft alone.

## Mutation
Removing the booking-id one-write guard makes the full booked attempt log twice, so the sequential-attempts test sees **3** rows instead of 2 and fails. Reverted after confirming.

## System impact
- New writes only at terminal points; the abandonment sweep runs inside the existing B12 cron handler (`autoCheckoutHandler` now returns `{...autoCheckout, ...enquiry}`).
- `Last Inbound At` is an added field on existing guest updates — write counts unchanged, so no existing send/flow behaviour changes.
