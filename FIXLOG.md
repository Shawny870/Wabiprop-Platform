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

## H0 — Harness (5 July 2026, PR "H0: Harness")

- schema.json generated from live base metadata (WS_ tables only) + `scripts/schema-diff.js` drift check. `--write` is Shawn-only, after deliberate schema changes — never to clear a failing diff.
- fixtures/ replay suite (14 fixtures + 5 transport tests) freezing all F1–F14 WS1 behaviour; `node --test` runner in test/. Written and green against the pre-refactor webhook first.
- states.json refactor: state → input → action → next state and all outbound copy moved into the table; webhook handlers dispatch from it. Behaviour-preserving — same fixtures green before and after.
- Staging env split documented in `.env.example` (Vercel per-environment values; setting them is a Shawn action).

**Accepted technical debt:** Wabistay WS_ tables live in the shared Wabiprop Airtable base (`appgtVqX1dK88lpRT`). Approved as existing known reality, not D16 drift (D16 = repo/number/token separation). Base split to be revisited before multi-tenant onboarding (B10 gate).

**Known frozen-but-temporary behaviour:** fixture 14 (status callback dropped with 200) documents current behaviour only — B3 will deliberately change it.

