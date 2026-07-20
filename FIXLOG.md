# FIXLOG.md — Wabistay
One entry per fix, F-numbering continuous. Every fix gets a replay fixture in `fixtures/` so it can never regress silently.

Backfilled from the `api/wabistay/webhook.js` header (WS1 build):

- F1 — Body parse guard added (req.body undefined protection)
- F2 — res.status(200) moved to AFTER handleMessage completes
- F3 — Meta API version v19.0 → v25.0
- F4 — {Active} = 1 → {Active} = TRUE() for Rates and Cleaners
- F5 — FIND/ARRAYJOIN linked record filter replaced with direct lookup
- F6 — Airtable error logging now includes HTTP status code
- F7 — OWNER_PHONE notification added to NEW booking creation
- F8 — CHECKED_IN state added (gate arrival → checked in flow)
- F9 — All guest-facing messages converted to numbered menu options (Rule 11)
- F10 — Greeting scoped to overnight bookings, HOURLY keyword placeholder added
- F11 — Room assigned at gate arrival, Notify Phone from WS_Properties with OWNER_PHONE fallback
- F12 — Axiom HTTP logging added (fire-and-forget, never blocks state machine)
- F13 — Booking Ref written back to WS_Bookings after CREATE
- F14 — Gate cooldown guard: ignores checkout trigger if checked in < 60s ago

- F15 — Structured booking dates: guest free-text check-in/check-out parsed to SAST-anchored datetimes and written to `WS_Bookings.Check In`/`Check Out` (overnight defaults 14:00/10:00 SAST), alongside the unchanged `Notes` string. Relative dates ("today"/"tomorrow") now parse instead of re-prompting (closes Master Transfer v4 §12.1). Unparseable, reversed and same-day-overnight ranges re-prompt with zero writes rather than storing a date B8 cannot use.

- F16 — Real availability: rooms are held at enquiry (`WS_Bookings.Room` written in `collectDetails`, not first at `gateArrival`) and `findAvailableRoom` refuses any range overlapping an existing hold — exclusive bounds, `newIn < existingOut && newOut > existingIn`. Only Enquiry/Confirmed/Checked In block; only non-Maintenance rooms are sellable (status allowlist, fail closed). `gateArrival` re-verifies the hold and re-offers rather than failing silently. B7's "TBC" path removed: check-out is now required, since a booking with no check-out would hold a room against a range the overlap check cannot see.

- F17 — WS2 hourly/short-stay flow: HOURLY is a real entry point instead of the F10 placeholder. `AWAITING_HOURLY_DETAILS` (name + arrival time) → `AWAITING_HOURLY_DURATION` (1/2/3 menu) → booking. Hourly writes real-hour datetimes into the same `Check In`/`Check Out` fields, so B8's `findAvailableRoom` blocks hourly-vs-overnight both ways unforked — including back-to-back bookings sharing an instant, which B8's exclusive bounds allowed but no fixture could reach until now. Rates read from the three `WS_Properties` currency fields and **fail closed**: any blank or zero rate disables hourly for that property and routes to overnight, never quotes R0. `>3hr` redirects to overnight and cancels the half-built row. Gate arrival now refuses a check-in before the booking's own date (SAST day granularity, future-only — a late guest is still a guest).

## H0 — Harness (5 July 2026, PR "H0: Harness")

- schema.json generated from live base metadata (WS_ tables only) + `scripts/schema-diff.js` drift check. `--write` is Shawn-only, after deliberate schema changes — never to clear a failing diff.
- fixtures/ replay suite (14 fixtures + 5 transport tests) freezing all F1–F14 WS1 behaviour; `node --test` runner in test/. Written and green against the pre-refactor webhook first.
- states.json refactor: state → input → action → next state and all outbound copy moved into the table; webhook handlers dispatch from it. Behaviour-preserving — same fixtures green before and after.
- Staging env split documented in `.env.example` (Vercel per-environment values; setting them is a Shawn action).

**Accepted technical debt:** Wabistay WS_ tables live in the shared Wabiprop Airtable base (`appgtVqX1dK88lpRT`). Approved as existing known reality, not D16 drift (D16 = repo/number/token separation). Base split to be revisited before multi-tenant onboarding (B10 gate).

**Known frozen-but-temporary behaviour:** fixture 14 (status callback dropped with 200) documents current behaviour only — B3 will deliberately change it.

