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

- F20 — Parser robustness: single-line details + month-substring name fix. Confirmed live: Caillin Mendes (a real prospect's guest) sent `Caillin Mendes 31July 2026 1 August 2026` all on one line; the parser required three separate lines, re-prompted three times, and Caillin abandoned the booking. `collectDetails` now locates date-shaped SPANS anywhere in the message via a new `findDateTokens` (day+month, month+day, numeric day-first, today/tomorrow) — the first two tokens are check-in/check-out, whatever precedes the first is the name — so name + two dates on one line parses, and the newline form is unchanged. Same pass fixes the month-substring trap: the old classifier used `line.includes('may'|'aug'|'jun'…)`, so a name containing a month fragment ("May Ndlovu", "Augustine", "Julian") was eaten as a date; detection now matches genuine date shapes, and `parseBookingDate` remains the downstream gate so an over-eager locate still re-prompts rather than booking a non-date. Longest month name wins (sorted by length) so "June" is never clipped to "Jun" and Notes/guest copy stay verbatim. Re-prompt copy unchanged. Fixtures 49 (Caillin's exact input books), 50 (`May Ndlovu 3 Aug 2026 5 Aug 2026` → name "May Ndlovu"), 51 (single-line name + one date re-prompts, zero writes); all existing B7/B8/B9 two- and three-line fixtures pass unchanged. Mutation: under-detection (day needs 3–4 digits) flips 49 books→re-prompt; over-detection (bare month word counts as a date) flips 50 (name eaten). Fixture 51 stays correct under both — the incomplete input is refused by three independent guards (detection, `parseBookingDate` validation, missing-checkout check), so no single detection mutation can force it to book; that layering is the property 51 encodes.

- F19 — Rate-fix: deterministic occupancy-based pricing. `collectDetails` used `activeRates[0]` — no sort, no filter — so the overnight rate was whichever row Airtable returned first: reordering the `WS_Rates` view or adding a row silently flipped every couple's price with zero code change and zero signal (today it defaulted R400, favouring the house; it could as easily start undercharging). Overnight now asks an occupancy question (numbered menu, Rule 11: `1 - Just me` / `2 - Two of us`) in a new `AWAITING_OCCUPANCY` state, and `selectOccupancy` picks the rate by matching the answer against `{WS_Rates.Occupancy Type}` (singleSelect `Single`/`Couple`), never by array position. The booking is created unpriced (room already held) in `collectDetails`, and `Rate Applied` / `Amount Due` are written in `selectOccupancy` once a rate is matched. **Fail-closed:** no rate row for the chosen occupancy → no positional fallback, no price quoted; guest is routed to a contact-the-owner message and the session still advances to `AWAITING_ETA` (owner already notified at enquiry, prices offline). Hourly (B9) is untouched — it reads the per-property currency fields, not `WS_Rates`. New guest-facing copy (`occupancyMenu`, `occupancyContactOwner`) — PR labelled `needs-decision`. Fixtures 44–48 (Single→R250, Couple→R400, reorder-invariance regression proof, invalid-answer re-prompt zero-writes, no-match fail-closed); mutation: inverting the `{Occupancy Type}` match flips 46 to R400 and fails, 44/45/48 with it. Existing overnight fixtures 03/20/25/26/28 updated to the new occupancy turn. Schema dependency: `WS_Rates.Occupancy Type` is created by the CEO in Airtable — build is against that exact field name (not yet in `schema.json`; Shawn regenerates on `--write` after creating it). **F18 gap on this chain is deliberate — F18 is B11 (Chain B); this branch stacks on B9 (F17).**

- F17 — WS2 hourly/short-stay flow: HOURLY is a real entry point instead of the F10 placeholder. `AWAITING_HOURLY_DETAILS` (name + arrival time) → `AWAITING_HOURLY_DURATION` (1/2/3 menu) → booking. Hourly writes real-hour datetimes into the same `Check In`/`Check Out` fields, so B8's `findAvailableRoom` blocks hourly-vs-overnight both ways unforked — including back-to-back bookings sharing an instant, which B8's exclusive bounds allowed but no fixture could reach until now. Rates read from the three `WS_Properties` currency fields and **fail closed**: any blank or zero rate disables hourly for that property and routes to overnight, never quotes R0. `>3hr` redirects to overnight and cancels the half-built row. Gate arrival now refuses a check-in before the booking's own date (SAST day granularity, future-only — a late guest is still a guest).

## H0 — Harness (5 July 2026, PR "H0: Harness")

- schema.json generated from live base metadata (WS_ tables only) + `scripts/schema-diff.js` drift check. `--write` is Shawn-only, after deliberate schema changes — never to clear a failing diff.
- fixtures/ replay suite (14 fixtures + 5 transport tests) freezing all F1–F14 WS1 behaviour; `node --test` runner in test/. Written and green against the pre-refactor webhook first.
- states.json refactor: state → input → action → next state and all outbound copy moved into the table; webhook handlers dispatch from it. Behaviour-preserving — same fixtures green before and after.
- Staging env split documented in `.env.example` (Vercel per-environment values; setting them is a Shawn action).

**Accepted technical debt:** Wabistay WS_ tables live in the shared Wabiprop Airtable base (`appgtVqX1dK88lpRT`). Approved as existing known reality, not D16 drift (D16 = repo/number/token separation). Base split to be revisited before multi-tenant onboarding (B10 gate).

**Known frozen-but-temporary behaviour:** fixture 14 (status callback dropped with 200) documents current behaviour only — B3 will deliberately change it.

