# Rate-fix: deterministic occupancy-based pricing

**Branch:** `feature/rate-fix-occupancy` → base `feature/b9-hourly-booking-core`
**Label:** `needs-decision` (pricing logic + new guest-facing copy)
**FIXLOG:** F19

## Problem
`collectDetails` selected the overnight rate with `const rate = activeRates[0] || null` — no sort, no filter. Airtable returns records in view order, so pricing was silently **position-dependent**: reordering the `WS_Rates` view or adding a rate row flips the quoted price with zero code change and zero signal. Today it defaults to R400 (favours the house); it could just as easily start undercharging every couple.

## Change
- New `AWAITING_OCCUPANCY` state between `AWAITING_DETAILS` and `AWAITING_ETA`.
- `collectDetails` now creates the Enquiry booking **unpriced** (room already held, owner notified) and asks a numbered occupancy question (Rule 11: `1 - Just me` / `2 - Two of us`) instead of confirming.
- New `selectOccupancy` action maps the answer to an `{Occupancy Type}` (`Single`/`Couple`) and selects the `WS_Rates` row **by matching that field**, never by array position. It writes `Rate Applied` + `Amount Due`, advances to `AWAITING_ETA`, and sends `bookingReceived` with the matched price.
- **Fail-closed:** if no rate row matches the chosen occupancy for that property, there is **no positional fallback and no price quoted** — the guest is routed to a contact-the-owner message and the session still advances so the (already owner-notified) booking can complete with the owner pricing it offline.
- Hourly (B9) is untouched — it reads the per-property currency fields, not `WS_Rates`.

## Schema dependency (CEO)
Build is against these exact names, created by Shawn in Airtable tomorrow:
- `WS_Rates.Occupancy Type` — singleSelect, options exactly `Single` and `Couple`.
- Existing rows to be set: "Standard Night couples" → `Couple`, "Standard Night Single" → `Single`.

Not yet in `schema.json` — Shawn regenerates via `scripts/schema-diff.js --write` after creating the field. No code reads it from `schema.json`; the field is read at runtime off live records.

## Tests
`node --test` → **95 tests, 94 pass, 1 fail**. The single failure is the pre-existing BUG-10 (`test/router.dispatch.test.js` "dispatches to Wabistay handler cleanly" — no `WS_Properties` seed row), unrelated to this change and present on `main`/`b9` before it.

New fixtures:
- `44_occupancy_single_selects_r250` — `1` → Single rate R250.
- `45_occupancy_couple_selects_r400` — `2` → Couple rate R400.
- `46_occupancy_reorder_invariant` — **core regression proof**: `WS_Rates` seeded Couple-first, `1` still selects Single R250.
- `47_occupancy_invalid_reprompts` — `5` re-prompts the menu, zero writes.
- `48_occupancy_no_matching_rate_fail_closed` — only a Couple rate exists, `1` (Single) → contact-owner, no price, **no booking rate write** (the single guest-only write is the fail-closed proof).

Updated existing overnight fixtures to the new occupancy turn: `03`, `20`, `25`, `26`, `28`.

## Mutation
Inverting the occupancy match (`.find(... === ...)` → `!== `) flips fixture 46 to R400 and **fails it**, taking 44/45/48 with it; 47 (never reaches rate matching) stays green. Reverted after confirming.

## System impact
- Overnight flow gains one turn; hourly, cleaner, gate-arrival, checkout flows unchanged.
- `bookingReceived` recovers the guest's raw date strings ("25 June") from the `Notes` line `collectDetails` wrote, so guest-facing dates are unchanged in wording.
- `ownerNewBooking` still fires at enquiry (owner copy carries no rate, so it is correct before occupancy is known).
