# B14: STOP opt-out flow (two-tier)

**Branch:** `feature/b14-stop-optout` → base `feature/b17-owner-summary` (**last in Chain A, deliberately**)
**Label:** `needs-decision` (compliance logic + new guest-facing copy + new fields)
**FIXLOG:** F24

## What this adds
Case-insensitive `STOP` sets `WS_Guests.Opted Out` + `Opted Out At` at the exact
event and acknowledges once. A two-tier gate in `handleMessage` (before consent
and dispatch):
- **STOP instantly kills all OPTIONAL messaging.**
- **Transaction-completion messages for an already-active booking** (`Session State` ∈ `CONFIRMED` / `CHECKED_IN`) **still deliver**, until that booking closes.
- No active booking → the booking/optional flow never runs; a later message returns the opt-out pointer.
- `START` clears the flags and welcomes the guest back.

## New WS_Guests fields (CEO creates — not in `schema.json`)
- `Opted Out` — checkbox.
- `Opted Out At` — date/time.

## FLAG — genuinely ambiguous
"Respond **once** … then silence" for later messages: strict once-then-total-
silence needs a **third** tracking field (e.g. `Opt Out Notice Sent`). Only the
two CEO-specified fields exist, so each optional inbound gets the compliant terse
pointer (a reply to a user-initiated message is within the window). Flagged for a
decision if strict once-only is required.

## System-impact check — full `sendWhatsApp` categorisation
"Provably built" matters more than "works in testing." The gate is at **dispatch**,
so an opted-out guest only ever reaches actions for their current `Session State`.
Every OPTIONAL guest send lives in an enquiry-state handler (unreachable once
opted out); every TRANSACTION-COMPLETION guest send lives in an active-state
handler or the cron. Complete trace (including the B12/B13/B17 sends):

### TRANSACTION-COMPLETION → guest (delivered while opted out, active booking)
- `gateArrival`: `gateTooEarly`, `welcomeAssigned` / `welcomeUnassigned` (CONFIRMED).
- `cancelBooking`: `cancelled` (CONFIRMED — closing the active booking).
- `showConfirmedMenu`: `confirmedMenu` (CONFIRMED fallback — guides active booking).
- `checkout`: `gateCooldownMenu`, `checkoutThanks` (CHECKED_IN).
- `showCheckedInMenu`: `checkedInMenu` (CHECKED_IN fallback).
- `extendStay`: `extensionConfirmed` (CHECKED_IN) — **B12**.
- cron `settleAutoCheckout`: `autoCheckoutThanks`; cron `runAutoCheckout`: `checkoutWarning` (active Checked In booking) — **B12**. Cron is not dispatch-gated; correctly exempt because these are transaction-completion for an active booking.

### OPTIONAL → guest (structurally suppressed once opted out — enquiry states)
- `greetAndAskDetails`: `greeting` (NEW).
- `collectDetails`: `detailsReprompt`, `noAvailability`, `occupancyMenu` (AWAITING_DETAILS) — **F19**.
- `selectOccupancy`: `occupancyMenu`, `occupancyContactOwner`, `bookingReceived` (AWAITING_OCCUPANCY) — **F19**.
- `startHourly` / `collectHourlyDetails` / `selectHourlyDuration`: `hourlyAskDetails`, `hourlyDetailsReprompt`, `hourlyTimeAmbiguous`, `hourlyDurationMenu`, `hourlyTooLong`, `hourlyUnavailable`, `hourlyNoAvailability`, `hourlyBookingReceived` (AWAITING_HOURLY_*).
- `recordEta`: `etaConfirmed` (AWAITING_ETA — booking not yet active; opting out before commitment means it is not confirmed).
- `unknownStateReset`: `unknownFallback` (unknown/non-active state).

### NOT guest sends (guest opt-out N/A — owner / cleaner / system)
- **Owner/manager:** `ownerNewBooking`, `hourlyOwnerNewBooking`, `ownerExtension` (B12), `ownerRoomCleaned`, `gateNotify`, and the stubbed `sendOwnerSummary` (B17, no live send). Owner opt-out is a separate concern (not built).
- **Cleaner:** `cleanerThanks`, `cleanerNothingToClean`, `cleanerWhichRoom`, `cleanerDispatch` (checkout + auto-checkout).
- **System / control:** `numberNotConfigured` (pre-guest); `consentNotice` (B13 — only new numbers; the opt-out gate runs first, so an opted-out guest never reaches it); `optedOut` / `optedBackIn` (the opt-out control messages themselves — delivered by design as direct responses).

Judgment call flagged: the active-state **fallback menus** (`confirmedMenu`,
`checkedInMenu`) are treated as transaction-completion (they help complete the
active booking). If these should count as optional, gate them individually.

## Tests
`node --test` → **120 tests, 119 pass, 1 fail** (pre-existing BUG-10, unrelated).
Fixtures 57 (STOP + timestamp, case-insensitive), 58 (active booking → checkout still delivers), 59 (no active booking → flow silenced), 60 (later message → pointer, greeting suppressed), 61 (START opts back in).

## Mutation
Collapsing the two-tier check (suppress even active bookings) fails fixture 58 (checkout transaction suppressed) while 59/60/61 stay green. Reverted after confirming.

## Ordering note
B13's consent copy references the STOP handler this step provides — B13 and B14
must merge together (B14 with/before B13's dependency is satisfied within this
Chain A stack).
