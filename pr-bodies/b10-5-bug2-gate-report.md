# B10.5 BUG 2 — auto-checkout property scoping: HARD GATE HIT, stopped for Design Engineer

**Status:** NOT fixed. Step 1 (confirm the scoping mechanism) tripped the hard gate in the transfer doc — "if property scoping is not already cleanly on the record… stop and report — do not invent." No code was changed. This is a schema/sequencing decision, not a Builder call.

## Step 1 — how property attaches on check-in (confirmed)
- **`WS_Bookings` has no `Property` field.** Property is **not persisted** on the booking/session record. (Confirmed against `schema.json`: WS_Bookings fields are Booking Ref, Guest, Room, Check In/Out, Booking Type, Source, Status, Nights, Amount Due/Paid, Payment Method/Status, Notes, Special Requests, Logged By, ETA, Checkout Confirmed, Rate Applied, Checked In At — no Property.)
- Property is **derived** via `Booking → Room → Property` (the Room link).
- The **manual** checkout path scopes via `ctx.property.id`, which comes from `resolveProperty(phone_number_id)` on the **inbound message** — a request-scoped value, not something stored on the record.
- The **auto-checkout** cron has no inbound message, so `runAutoCheckout` already derives `property` from the booking's room (RECORD_ID walk) for the warning copy. So property **is reachable** in `settleAutoCheckout`'s caller.

## Why the gate tripped (two findings)
1. **Property scoping is not cleanly on the record.** It is derived via the Room link, not persisted on the booking. The gate condition ("not already cleanly on the record") is literally met.
2. **The filter field B11 uses does not exist on this chain.** B11 scopes cleaners with `WS_Cleaners.Assigned Property` (`.filter(c => (c.fields['Assigned Property'] || []).includes(ctx.property.id))`). That field is a **Chain B (B11)** addition — `schema.json` on Chain A lists WS_Cleaners as Cleaner Name, Phone Number, **Assigned Rooms**, Active, Notes. There is **no `Assigned Property`** on Chain A. So the "mirror B11's fix" approach depends on a field that only exists once Chain B merges.
3. **Corollary:** on Chain A alone, the **manual** checkout is *also* unscoped (`{Active} = TRUE()`, line ~1361) — B11 isn't present here. Fixing only auto-checkout on Chain A would use a not-yet-present field and leave manual/auto inconsistent until Chain B lands.

The fix itself is trivial (pass the already-resolved `property` into `settleAutoCheckout` and filter cleaners by `Assigned Property`). What is **not** a Builder call is *which mechanism and where* — that's the schema/sequencing decision the gate protects.

## Decision needed from Design Engineer (options, not a recommendation to act on unilaterally)
- **(a) Fix inside Chain B, next to B11.** Property scoping — the `Assigned Property` field, the manual-checkout counterpart, and now the auto-checkout path — all live together where they belong. Keeps Chain A free of a field it doesn't define. Requires `settleAutoCheckout` (B12/Chain A code) to be reachable from Chain B, i.e. B12 merges before B11, or the fix rides on the merged trunk.
- **(b) Fix on Chain A now, using `Assigned Property`.** Simplest diff, but imports a Chain B field into Chain A and leaves Chain A's manual/auto checkout inconsistent until B11 merges.
- **(c) Persist `Property` on `WS_Bookings` at check-in** (schema addition), making both checkout paths independent of the room walk and of `Assigned Property` scoping semantics. Most robust, largest change.

## Test (ready to write once the mechanism is decided)
Two properties, each with an active cleaner; auto-checkout fires at property A → only A's cleaner dispatched — mirroring B11's fixture 43 for the cron path. Held until the gate clears.

**No commit for Bug 2.** Awaiting the Design Engineer's decision on (a)/(b)/(c).
