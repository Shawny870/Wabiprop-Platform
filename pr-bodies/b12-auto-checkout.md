# B12: auto-checkout cron + extension warning

**Branch:** `feature/b12-auto-checkout` → base `feature/parser-robustness`
**Label:** `needs-decision` (new guest-facing copy + new fields + extension-duration decision)
**FIXLOG:** F21

## What this adds
A time-driven sweep (`runAutoCheckout`) that runs on a Vercel cron and, for every
`Checked In` booking past its `Check Out`:
- **not yet warned** → sends a 15-minute warning offering an extension and stamps `Checkout Warning Sent At`;
- **warned ≥ 15 min ago** → auto-checkout, with **no manager action** — mirroring the manual `checkout` action's exact write/send order (booking → Checked Out; room → Cleaning + Cleaning Started At; active cleaners dispatched; guest → NEW; guest thanked);
- **warned, still inside the grace** → waits for the next run.

Extension (LOCKED CEO 16 July — uncapped, repeatable): an `EXTEND` reply in
`CHECKED_IN` pushes `Check Out` out and clears the warning stamp to re-arm the
cron. **Owner is notified on the first extension only** (one per booking),
tracked by `Extension Owner Notified`; later extensions extend silently.

## Deploy-time / CEO actions
- **`vercel.json` cron** added (`*/5 * * * *` → `/api/wabistay/cron/auto-checkout`). Build-time only — **Shawn enables at deploy.**
- **New WS_Bookings fields (Shawn creates in Airtable — not in `schema.json`):**
  - `Checkout Warning Sent At` — dateTime (when the 15-min warning was sent; blank = not warned this cycle).
  - `Extension Owner Notified` — checkbox (owner already told about the first extension).
  - Per the brief: I did **not** silently invent a field — these are flagged here for creation, as no existing field fits (there is no extension/warning bookkeeping field on `WS_Bookings`).

## FLAG — genuinely undefined
The extension **increment** is not specified in the brief. Built as a sensible
default — `EXTENSION_MS`: **+1 hour hourly, +1 day overnight** — and called out
here for CEO confirmation. Everything else about extensions is per the 16 July lock.

## SAST / UTC
`Check Out` is stored as the UTC instant of the SAST checkout time (via
`sastToUtcIso`), so the cron compares absolute instants — no further conversion
is needed, and Vercel running UTC is irrelevant to the comparison. The arithmetic
is pure milliseconds (`AUTO_CHECKOUT_GRACE_MS`), which is the mutation target. The
15-min boundary is `>=` (a booking warned exactly 15 min ago auto-checks-out) and
is covered by a boundary test.

## Tests
`node --test` → **107 tests, 106 pass, 1 fail** (pre-existing BUG-10, unrelated).

- `test/autocheckout.test.js` (7): warning fires at the correct offset; no action before checkout / when extended into the future; within-grace no-op; auto-checkout fires with no guest response; 15-min boundary fires; hourly handled identically to overnight; date-less legacy row ignored.
- `52_extend_first_notifies_owner` — first `EXTEND` extends, notifies owner once, sets the flag.
- `53_extend_second_no_renotify` — second `EXTEND` extends but sends the guest confirmation only (no owner) — the single guest-only send is the no-re-notify proof.

## Mutation
Inflating `AUTO_CHECKOUT_GRACE_MS` 10× makes the three auto-checkout timing tests fail (auto-checkout stops firing in a realistic window) while the warning and no-op tests stay green. Reverted after confirming.

## System impact
- New cron entry point in `api/wabistay/cron/auto-checkout.js` is a thin wrapper over `webhook.js` — single source of truth for Airtable/WhatsApp helpers and copy.
- `settleAutoCheckout` mirrors the manual `checkout` action rather than refactoring it (frozen by fixtures 10/43); a unifying refactor is its own session per CLAUDE.md.
- New `CHECKED_IN` transition (`extend`) is ordered before the `1`/`checkout` row; `1` still means checkout — the warning copy tells the guest to reply `EXTEND` to stay.
- **Note for B14 (Step 6):** this step adds new `sendWhatsApp` call sites — `checkoutWarning` and `ownerExtension` (optional messaging), `autoCheckoutThanks` and the cleaner dispatch (transaction-completion). These are categorised in B14's system-impact trace.
