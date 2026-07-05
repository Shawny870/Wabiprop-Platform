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
