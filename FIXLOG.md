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

- F18 — B11: checkout cleaner dispatch scoped to the checking-out guest's property. `WS_Cleaners.Assigned Property` (single link to `WS_Properties`) now filters the active-cleaner dispatch in `checkout` by `ctx.property.id` — a JS-side record-id `includes`, mirroring the rooms/rates pattern (`(r.fields['Property'] || []).includes(ctx.property.id)`) and deliberately NOT `FIND/ARRAYJOIN` on the linked name (same class as the F5/6.4 fix — a name match collides when one property name is a substring of another). One-property-per-cleaner is the locked assumption; array-`includes` would also pass a multi-property cleaner, but multi-property dispatch is not a built feature (B11.5 territory) and is not relied on. Cleaner *identification* by phone (`senderIsCleanerNamingRoom` / DONE flow, `{Phone Number} = ...`) is intentionally left property-unscoped here — the separate bare-number / cross-property collision is tracked as B11.5, not folded in. Fixture 43 proves a second property's cleaners and an unassigned cleaner are not notified (all three seeded Active, so only property scoping can exclude them); fixture 10 updated to link its cleaners now that assignment is required. (F17 is B9's hourly flow, on its own unmerged branch — expect the F16→F18 gap on `main` to close when B9 merges first.)

- F25 — B11.5: bare-number cleaner/guest routing precedence. A phone can be both a registered cleaner and an active guest (Eric, `27825999279`). `senderIsCleanerNamingRoom` is a global `"*"` transition that preempts normal state routing, so Eric replying `2` to a numbered guest menu marked Room 02 clean instead of driving his booking. Fix: a new `guestStateExpectsInput(guest, text)` reads `states.json` and returns true when the sender's Session State is non-`NEW` and has an explicit (non-`"*"`) transition whose inputs include the text; `senderIsCleanerNamingRoom` now returns false (declines to preempt) when that holds — the guest-side state machine wins. **Precedence decision for the genuinely ambiguous case (pending guest menu AND matching cleaning room simultaneously): the GUEST side wins** — the guest's live booking transaction takes precedence; a cleaner can still resolve the room by name or `DONE`. Targeted change only — the rest of `senderIsCleanerNamingRoom` (correct for genuine room-naming) is untouched, and the fix is read from `states.json` so it generalises to future numbered menus (occupancy/hourly duration) with no further change. **Global `"*"` sweep (required system-impact check): `states.json` has two global rows — `["done"]`/`senderIsCleaner`/`cleanerDone` and `"*"`/`senderIsCleanerNamingRoom`/`cleanerRoomReply`. Only the `"*"` row had the preemption blindness (now fixed). The `"done"` row is input-specific and its keyword never overlaps any guest-state numbered input, so it cannot preempt a numbered menu — no other instance of this class exists.** Fixtures 62 (both pending → guest cancels, Room 02 untouched) and 63 (no guest expectation → cleaner room-naming unchanged). Mutation: inverting the precedence check fails both 62 and 63. (Chain B, off B11 — this branch's FIXLOG jumps F18→F25 because F19–F24 are Chain A, which merges first per the sprint merge order. b11 has no hourly flow, so the doc's `AWAITING_HOURLY_DURATION` example is exercised via CONFIRMED's numbered menu here; identical logic covers the hourly/occupancy menus once B9/F19 merge.)

## H0 — Harness (5 July 2026, PR "H0: Harness")

- schema.json generated from live base metadata (WS_ tables only) + `scripts/schema-diff.js` drift check. `--write` is Shawn-only, after deliberate schema changes — never to clear a failing diff.
- fixtures/ replay suite (14 fixtures + 5 transport tests) freezing all F1–F14 WS1 behaviour; `node --test` runner in test/. Written and green against the pre-refactor webhook first.
- states.json refactor: state → input → action → next state and all outbound copy moved into the table; webhook handlers dispatch from it. Behaviour-preserving — same fixtures green before and after.
- Staging env split documented in `.env.example` (Vercel per-environment values; setting them is a Shawn action).

**Accepted technical debt:** Wabistay WS_ tables live in the shared Wabiprop Airtable base (`appgtVqX1dK88lpRT`). Approved as existing known reality, not D16 drift (D16 = repo/number/token separation). Base split to be revisited before multi-tenant onboarding (B10 gate).

**Known frozen-but-temporary behaviour:** fixture 14 (status callback dropped with 200) documents current behaviour only — B3 will deliberately change it.

