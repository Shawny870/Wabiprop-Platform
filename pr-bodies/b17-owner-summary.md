# B17: owner summary aggregation (send stubbed pending template approval)

**Branch:** `feature/b17-owner-summary` → base `feature/b13-popia-consent`
**Label:** (none required — no pricing/consent/state-machine change; send is stubbed)
**FIXLOG:** F23

## What this adds
A per-property aggregation over `WS_Bookings` — "the weekly P&L IS the product" —
built now, minus the send.

`runOwnerSummary({ now, daily })`, per property (scoped via room link, since
`WS_Bookings` has no Property field):
- **Total bookings** in period.
- **Total revenue** in period — sum of `Amount Due` (the currency field per `schema.json`; hourly writes it too since F17).
- **Occupancy rate** — room-nights sold ÷ room-nights available.
- **Upcoming bookings** in the next 7 days.

Weekly by default; **daily variant behind `OWNER_SUMMARY_DAILY=true`**. Cancelled
bookings excluded at fetch.

### Occupancy convention (stated explicitly, per the brief)
- **Overnight** → whole nights, rounded from the 14:00→10:00 clock span (a 1-night stay is 20h of clock but counts as **1 night**).
- **Hourly** → a **partial** room-night: the raw fraction of a day (2h = 2/24 ≈ 0.083).
- **Available** = sellable rooms (Available/Occupied/Cleaning; Maintenance excluded) × period nights.

## The send is stubbed (by design)
A weekly summary is business-initiated, outside any 24h window, so free-form text
**silently fails** (HTTP 200, nothing logged). `sendOwnerSummary`:
- Logs the **fully-assembled payload** to Axiom (`owner_summary_payload`) so the aggregation is verifiable end-to-end **now**, before the template exists.
- Marks the one-line swap point behind `OWNER_SUMMARY_TEMPLATE` (`wabistay_owner_weekly_summary`).
- Is deliberately **not** a free-form `sendWhatsApp`.

**CEO/deploy actions:** submit the Meta utility template `wabistay_owner_weekly_summary`; enable the `vercel.json` cron (`0 6 * * 1` → `/api/wabistay/cron/owner-summary`) at deploy.

## 24-hour-window instrumentation (also in this step)
The three existing owner/notify sends (F7 new booking, F11 gate arrival,
room-cleaned) now emit `owner_send_window_check` via `logOwnerSendWindow` — no
behaviour change, just a measurement of whether the recipient is the inbound
sender (guaranteed inside the 24h window) or a third party (outside it).

**Finding:** all three sites send to a phone that is **never** the inbound sender —
the owner / `Notify Phone`, not the guest or cleaner who just messaged. So **every
existing owner notification is outside the guaranteed 24h window** and exposed to
the exact silent free-form failure B17's template is designed to avoid. This
confirms the "intermittently invisible owner notifications" hypothesis is not
intermittent at all for these three — it is structural. Recommendation: migrate
F7/F11/room-cleaned to approved templates too (its own session; not rewritten here
per the brief).

## Tests
`node --test` → **115 tests, 114 pass, 1 fail** (pre-existing BUG-10, unrelated).

`test/ownersummary.test.js`:
- correct weekly totals, hourly + overnight both counted;
- property scoping (Lodge A excludes Lodge B and vice versa);
- zero-booking week → sensible zeros, no error;
- fully-assembled payload logged to Axiom per property, send stubbed (0 WhatsApp sends);
- daily variant narrows the period to 1 day.

## Mutation
Dropping the date-window bounds on the period filter makes all totals tests fail (upcoming bookings leak into the period) while the zero-booking test stays green. Reverted after confirming.

## System impact
- New cron entry point `api/wabistay/cron/owner-summary.js` — thin wrapper over `webhook.js`.
- Instrumentation `logToAxiom` calls are opt-in in the replay harness (only asserted when a fixture declares `expect.axiom`), so no existing fixture is affected.
- **Note for B14 (Step 6):** `sendOwnerSummary` currently emits **no** `sendWhatsApp` (stubbed), so it adds no live send site to categorise; the future template send will be optional (business-initiated summary). Recorded in B14's trace.
