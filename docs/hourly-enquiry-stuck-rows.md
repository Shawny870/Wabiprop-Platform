# Live diagnostic — hourly bookings stuck at `Status: 'Enquiry'`

**Read-only.** Queried live base `appgtVqX1dK88lpRT` via the Airtable REST API (paginated), 30 July 2026. No records were written or modified.

## Headline: there are none — the bug has never fired in production

| Query | Result |
|---|---|
| `WS_Bookings` rows total | **22** |
| Rows with `Status: 'Enquiry'` | **2** (both `Overnight` — out of scope, normal in-flight enquiries) |
| Rows with `Booking Type: 'Hourly'` | **0** |
| **Hourly rows stuck at `Enquiry` with a room + `Check Out`** | **0** |

Full breakdown of every booking in the base:

| Booking Type / Status | Count |
|---|---|
| Overnight / Checked Out | 19 |
| Overnight / Confirmed | 1 |
| Overnight / Enquiry | 2 |

**No cleanup is required.** There is nothing for the CEO to clear in Airtable.

## Why zero

The hourly flow (B9) has never completed a booking in production — the base contains **no `Hourly` rows at all**. The bug is real and reproducible (see the red→green tests in `test/hourly.status.test.js`), but it is **latent, not active**: it has been sitting in front of a code path no live guest has reached yet.

This corrects the premise the fix was scheduled under. The leak is **not** corrupting live data on every hourly cancellation right now, because there have been no live hourly cancellations. The urgency is *pre-emptive* — the first hourly booking that goes through on unfixed code would have started the leak.

## Detection query (for re-running after hourly goes live)

Rows matching all four conditions are stuck and are holding a room they should not:

- `Status` = `Enquiry`
- `Booking Type` = `Hourly`
- `Room` is non-empty
- `Check Out` is set

The first two alone are not sufficient: a half-built hourly row (no `Room`, no `Check Out`) is a guest legitimately mid-flow at the duration menu. That row is **inert** — `bookingBlocksRange` ignores any booking missing either date — so it blocks nothing and must not be cleared.

Manual remediation, should any ever appear: set `Status` to `Cancelled` (releases the room, since only `Enquiry` / `Confirmed` / `Checked In` block) — or to `Confirmed` if the guest did in fact stay and the row should be kept for reporting.
