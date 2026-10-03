# Environment variables

Durable record of every environment variable the platform reads. `.env.example`
cannot serve this purpose: `.gitignore` matches `.env*`, so it has never been
tracked and exists only on individual machines. Anything documented solely there
— or in a PR body — is lost the moment someone clones fresh.

Real values live in Vercel → Project → Settings → Environment Variables. Nothing
secret belongs in this file.

**[PER-ENV]** means the variable must hold *different* values in Production and
Preview. Preview deploys point at the staging Airtable base and the Meta test
number; production values are reachable only via `main`. Setting Preview-scoped
values in the Vercel dashboard is a CEO action.

Enumerated from `process.env.*` across `api/` and `scripts/` — if you add a new
variable, add it here in the same commit.

## Airtable

| Variable | Scope | Notes |
|---|---|---|
| `AIRTABLE_API_KEY` | [PER-ENV] | PAT scoped to that environment's base |
| `AIRTABLE_BASE_ID` | [PER-ENV] | Production `appgtVqX1dK88lpRT`; Preview: staging base |
| `WS_AIRTABLE_BASE_ID` | optional | Wabistay-specific base override where the two products are split |

## WhatsApp / Meta

| Variable | Scope | Notes |
|---|---|---|
| `WA_PHONE_NUMBER_ID` | [PER-ENV] | **Wabistay** number. Production: live booking number; Preview: Meta test number |
| `WP_PHONE_NUMBER_ID` | [PER-ENV] | **Wabiprop** number, deliberately separate from `WA_PHONE_NUMBER_ID` (P4). Currently parked — cleared rather than repointed, so the crons fail visibly instead of misfiring at Wabistay guests |
| `WA_ACCESS_TOKEN` | [PER-ENV] | Token for the number above |
| `WA_VERIFY_TOKEN` | [PER-ENV] | Webhook verify token. Different per environment so staging cannot verify production |
| `WA_TEMPLATE_LANGUAGE` | optional | Locale every utility template is submitted under. Defaults to `en`. Must equal the approved template's language or Meta rejects the send as a non-existent template |

## Message templates (business-initiated sends)

Sends to a third party who has not messaged us fall outside Meta's 24-hour
customer-service window, where free-form text is rejected (131047) and vanishes
at HTTP 200 — see CLAUDE.md line 30. Those sends must be approved utility
templates, and each is gated behind its own variable.

**Unset is the safe stub state**, not a misconfiguration: the send is skipped and
logged to Axiom with the booking it was for, never downgraded to free-form text.

| Variable | Scope | Notes |
|---|---|---|
| `WABISTAY_CLEANER_DISPATCH_TEMPLATE` | optional | Checkout → cleaner dispatch ("room vacated, please prepare it"; Doc 1b PR 7). Set to the **approved** template name only after Meta approves it (`wabistay_cleaner_dispatch`, language `en`). Used at all three dispatch sites (guest checkout, staff `CHECKOUT ROOM`, auto-checkout). Parameters are positional and load-bearing, exactly two: `{{1}}` cleaner name (`there` if the cleaner has none), `{{2}}` room name. **No buttons** — the router only understands typed text; the cleaner replies by typing DONE. If Meta rejects the template at once (not approved, wrong name or language) that is logged as `cleaner_dispatch_template_failed` and the original free-form message is tried once; a rejection that only shows up later in a delivery-status callback cannot be fallen back from. Unset = the free-form message exactly as before (which Meta drops silently outside the 24h window). A test on a phone that messaged the bot within 24 hours proves nothing about delivery |
| `WABISTAY_CLEANER_GATE_TEMPLATE` | optional | Cleaner gate-arrival notification (F30). Set to the **approved** template name — `wabistay_cleaner_gate_arrival` — only after Meta approves it. While unset, each skip logs `cleaner_gate_notify_stubbed` with `bookingId`. Parameter order is positional and load-bearing: `{{1}}` cleaner, `{{2}}` guest, `{{3}}` room, `{{4}}` property |
| `CRON_TIME_BUDGET_MS` | optional | Time budget for the auto-checkout cron (Doc 1b PR 5), in milliseconds. Default `8000`; a missing, non-numeric or non-positive value falls back to the default. When a run passes the budget it stops starting new work (the checkout sweep, then the enquiry-abandonment sweep), logs `cron_time_budget_hit` and returns `truncated: true`; the next 5-minute tick picks up the rest, because both sweeps are idempotent. Raise it only together with a larger `maxDuration` for that route in `vercel.json` (now 30s). Every cron run also logs `cron_started` and `cron_duration`; a start with no duration in Axiom is a run that was killed |
| `WABISTAY_ROOM_ORDER` | optional | Room selection order (Doc 1b PR 4). Set to `1` or `true` to turn on. `findAvailableRoom` then ranks the free rooms by status — Available, then Cleaning, then Occupied — and breaks ties by lowest room number (`Room Number`, else the digits in `Room Name`), instead of taking whichever free room Airtable lists first. A held room (`preferRoomId`, the gate-arrival re-check) still wins over any ordering. Date-overlap, `Active` and Maintenance rules are unchanged. Unset or any other value keeps Airtable order. Switch off by unsetting the variable |
| _all `WABISTAY_*` variables_ | info | Cold-start flag log. The first request of each process logs one `wabistay_flags` Axiom event (and a `[WABISTAY FLAGS]` console line) with every `WABISTAY_*` variable by NAME and `on`/`off` only, never a value, plus the Vercel commit (7 chars) and deployment id. `on` means set and non-empty; for `WABISTAY_STATE_WRITE_GUARD` it means `1`/`true`. Known flags are listed even when unset (as `off`); any other `WABISTAY_*` variable present is listed too. The same event has an `others` block: `REPORT_TEST_MODE_PHONE` and `OWNER_PHONE` as `set`/`unset` only (never the number), and `WA_TEMPLATE_LANGUAGE` with its effective value (`en` by default) and its source (`env`/`default`). Use it to confirm which deployment actually has a switch: query `event == "wabistay_flags"` and read the newest row for the deployment |
| `WABISTAY_HOLD_RELEASE` | optional | Stale-hold release (Doc 1b PR 6). Set to `1` or `true` to turn on. Turns on BOTH halves: (1) new bookings are written with `Hold Expires At` (`WS_Bookings`, date+time, UTC) = 30 minutes after the stated arrival, and never sooner than 30 minutes from the moment of booking — hourly: its arrival time; overnight: the ETA on the check-in day (a bare 1–11 is read as pm, an unreadable ETA holds to 23:59 SAST), tightened when the guest gives their ETA; (2) the 5-minute auto-checkout cron cancels any `Enquiry`/`Confirmed` booking whose `Hold Expires At` has passed and sends the guest back to `NEW` (only if they sit in `CONFIRMED`, `AWAITING_ETA` or `AWAITING_PAYMENT_METHOD` and have no other live hold). Never releases a booking with `Payment Status` Paid or an `Amount Paid`; bookings with no `Hold Expires At` (everything made before this was switched on) are never touched; no message is sent to the guest. Runs inside the cron time budget. Logs `hold_released`, `hold_expired_paid_skipped`, `hold_release_skipped_changed`. Unset = no writes and no release. Switch off by unsetting the variable |
| `WABISTAY_OVERDUE_ALERT_TEMPLATE` | optional | Overdue question to Reception (Doc 1b PR 6). Set to the **approved** template name only after Meta approves it; unset = the sweep is off (no reads, no sends). When a `Checked In` booking is still open 60 minutes after its `Check Out`, every Active `Reception` seat for the property (not On Duty) gets this template once, and the booking is stamped in `Overdue Alert Sent At` (date+time, UTC) so it is not asked again. A failed send is logged (`overdue_alert_failed`) and not stamped, so the next tick retries. Template `wabistay_overdue_checkout`, language `en`. Parameters are positional and load-bearing, exactly three: `{{1}}` room name, `{{2}}` guest name (`the guest` if unknown), `{{3}}` the scheduled check-out as a SAST date and time in the booking-message style, e.g. `3 Oct at 4:00pm`, so it reads correctly after "due to check out on". No reply handling: a Reception seat answers by sending `CHECKOUT ROOM <n>`, which already works. Note the auto-checkout sweep normally closes a booking about 15 minutes after its check-out, so this only fires for a booking auto-checkout has failed to settle |
| `WABISTAY_STATE_WRITE_GUARD` | optional | State-write guard (Doc 1b, PR 1). Set to `1` or `true` to turn on. When a booking-flow Session State advance fails (for example a select option missing in Airtable), the bot stops BEFORE sending the next prompt, sends the guest "speak to reception on {Guest Redirect Phone}" (falls back to `Notify Phone`; with neither set the guest is sent nothing and the alert says so), logs `guest_state_write_guard_tripped`, and fires `alertShawn` `guest_state_write_failed`. Unset or any other value keeps the old behaviour: the failure is only logged and the flow carries on. Covers greeting, stay-type/hourly/overnight details, hourly duration, payment method and ETA. Does not cover gate arrival, checkout, rating or cancel (they have side effects that must still complete). Switch off by unsetting the variable |
| `WABISTAY_ENQUIRY_TRACKING` | optional | Lost-enquiry tracking. Set to `1` or `true` to turn on; unset = none of this happens. Every `WS_Enquiries` row then also carries `First Message At`, `Last Message At` and `Last Step` (plain text: the guest's Session State), and the outcomes cover the whole funnel: `Booked`, `Cancelled` (guest cancel), `Hold Expired` (the #83 timer released the booking), `Abandoned`, plus the existing `No Availability` and `Invalid Input`. The greeting stamps `Attempt Started At` / `Attempt Property` / `Last Inbound At` on `WS_Guests`. The abandonment sweep also covers the greeting step (`AWAITING_STAY_TYPE`), no longer requires a name, falls back to `Attempt Property`, and records when the guest went quiet in `Last Message At`. The first unpaid gate tap stamps `Gate Tap At` on the booking (one non-fatal write after the guest's reply and the alert); 15 minutes later, if the booking is neither paid (by `Paid At`) nor checked in (by `Checked In At`), the cron writes `Unattended Gate Arrival At` once and logs `unattended_gate_arrival`. A guest with `Test Phone` ticked gets no enquiry row, no gate-tap stamp and no marker (Axiom events carry `testPhone: true`; this applies even with the flag off, and changes nothing until a guest is ticked). Axiom: `enquiry_closed` (one per row), `unattended_gate_arrival`, and `message_received` now carries `sessionState`. Runs inside the cron time budget |
| `WABISTAY_HIDE_ONE_HOUR` | optional | Hide the 1-hour short stay from guests. Set to `1` or `true` to turn on; unset = today's behaviour. On: the short-stay rates message lists only 2 and 3 hours, the duration prompt offers only `2` and `3` (reply keys stay the hour values), and a reply of `1` (or `1 hour`) repeats the prompt and books nothing (Axiom: `hourly_one_hour_hidden_reply`). The guest flow does not read `Hourly Rate 1hr`, so do NOT blank it in Airtable: staff walk-ins (`WALKIN ... 1HRS`), the +1 hour extension charge and `hourlyRates()` still need it, and `hourlyRates()` returns null (fails closed) on any blank rate. Switch off by unsetting the variable |
| `WABISTAY_NEW_BOOKING_TEMPLATE` | optional | New-booking alert (overnight and hourly) as a template. Set to the approved template name (`wabistay_new_booking`) ONLY after Meta approves it; unset = today's free-form alert, unchanged. Language `en`, 7 params in this order: `{{1}}` property name, `{{2}}` guest name, `{{3}}` guest phone, `{{4}}` booking reference, `{{5}}` stay description (lowercase: `overnight until 27 June`, `2 hours`), `{{6}}` arrival text (`3 Oct at 2:00pm`, SAST), `{{7}}` amount due (`R250`, or `to be confirmed` for an overnight booking with no single nightly rate). Body: "The stay is {{5}}. The guest is arriving {{6}}. The amount due is {{7}}." All seven values are built in `newBookingTemplateParams`. The recipient is still `operationalAlertPhone` (Notify Phone under `WABISTAY_NOTIFY_ROUTING`, else `OWNER_PHONE`). If Meta rejects the template at once, `new_booking_template_failed` is logged and the free-form alert is sent once; a rejection that only appears in a later delivery-status callback cannot fall back. Switch off by unsetting the variable |
| `WABISTAY_NOTIFY_ROUTING` | optional | Per-property routing of owner-side messages. Set to `1` or `true` to turn on; unset = today's behaviour exactly. On: the four operational alerts (new booking overnight and hourly, extension, room cleaned) go to the property's `Notify Phone` (`OWNER_PHONE` only as a fallback); the weekly recap and monthly report go to `Owner Report Phone`, falling back to `Notify Phone`, then `OWNER_PHONE`; and `Notify Phone` / `Owner Report Phone` numbers are excluded from the guest flow's `STOP` handling and POPIA consent notice, as `OWNER_PHONE` already is. Grants no command authority (PAID, WALKIN, DONE, CHECKOUT ROOM still resolve only from `WS_Roles` / `WS_Cleaners`). `REPORT_TEST_MODE_PHONE` still overrides every report recipient. Axiom: `wabistay_flags.others` carries `ownerPhoneLast4`; `wabistay_notify_phones` (once per cold start, on the first resolved property) carries `notifyPhoneLast4`, `ownerReportPhoneLast4`, `ownerPhoneLast4` and the routing state — last four digits only, never a full number. The hourly and extension alerts now also log `owner_send_window_check` |
| `WABISTAY_WEEKLY_RECAP_TEMPLATE`, `WABISTAY_MONTHLY_REPORT_TEMPLATE`, `WABISTAY_DAILY_SUMMARY_TEMPLATE`, `WABISTAY_OWNER_SUMMARY_TEMPLATE` | optional | Override the template name each report sends under. Unset = today's names (`wabistay_owner_weekly_recap`, `wabistay_owner_monthly_recap`, `wabistay_daily_summary`, `wabistay_owner_weekly_summary`). Param count and order are not affected by the name: setting the weekly one to `weekly_recap` needs no new approval only if that template's body takes the same 7 params in the same order. Daily and owner-summary are still stubbed and never send |
| `WABISTAY_GATE_ALERT_UNPAID` | optional | Unpaid gate-arrival alert. Set to `1` or `true` to turn on. When a guest taps "I'm at the gate" on a priced booking whose payment is not confirmed, the guest still gets the "pop into the office" reply, and now the office is told too: every Active `Reception` seat gets the `WABISTAY_GATE_ARRIVAL_TEMPLATE` template (room = the held room's real name and status, or `not assigned yet` / `payment not confirmed` when none is held), and `Notify Phone` gets the free-form `gateNotifyUnpaid` copy. Nothing is written to the guest or the room. Repeat taps are suppressed for 10 minutes via `WS_Bookings` `Gate Alert Sent At` (date+time, UTC), written only after an alert actually went out; a failed write is logged (`gate_alert_stamp_write_failed`) and never blocks the alert. A paid tap always alerts (normal path). Unset = today's behaviour: the unpaid tap alerts nobody. Switch off by unsetting the variable |
| `WABISTAY_GATE_ARRIVAL_TEMPLATE` | optional | Gate arrival → every Active **Reception** seat for the property (On Duty is not included). Set to the **approved** template name only after Meta approves it. Sent **in addition to** the free-form `Notify Phone` alert, which is unchanged. While unset, each skip logs `reception_gate_notify_stubbed` with the full payload; a property with no Active Reception seat logs `reception_gate_notify_no_seat`; a rejected send logs `reception_gate_notify_failed`. Parameters are positional and load-bearing, exactly five: `{{1}}` property name, `{{2}}` guest name, `{{3}}` room name (`an unassigned room` when none), `{{4}}` room status as it was before check-in flipped it to Occupied (`N/A` when no room), `{{5}}` guest phone |
| `WABISTAY_RECEPTION_PAYMENT_TEMPLATE` | optional | Checkout → Reception "amount owed" push (B8/PAID). Set to the **approved** template name only after Meta approves it. While unset, each skip logs `reception_payment_notify_stubbed` with the full payload, `bookingId` and `source` (`manual` / `auto`) — the send is never downgraded to free-form, because Reception has not messaged us at checkout time. Parameter order is positional and load-bearing: `{{1}}` room, `{{2}}` guest, `{{3}}` amount owed (formatted `400.00`, **no** R — the symbol belongs in the template copy or it renders doubled), `{{4}}` booking ref |

The B17 owner summary (`OWNER_SUMMARY_TEMPLATE`) is still a code constant rather
than an env var, because its send remains stubbed pending Meta approval.

## Webhook security (B1 / F31)

`CLAUDE.md` rule 25 requires HMAC verification of `X-Hub-Signature-256` on the
**raw** request body. It was never implemented until F31, and it is **still not
enforced in production** — it ships in report-only mode by default.

| Variable | Scope | Notes |
|---|---|---|
| `META_APP_SECRET` | [PER-ENV] | Meta app secret (App Dashboard → Settings → Basic → App Secret). Production and Preview apps have **different** secrets. Absent is never treated as a pass: it fails closed under `enforce` and logs `error` under `log` |
| `HMAC_MODE` | optional | Unset or `log` = verify and report, **always pass through** (safe default). `enforce` = 403 before any handler logic. `off` = no check. An unrecognised value falls back to `log`, never `off`, so a typo cannot silently disable the gate |

**Rollout is two steps and the order matters.**

1. Set `META_APP_SECRET`. Leave `HMAC_MODE` unset. Deploy — traffic behaviour is
   unchanged.
2. Watch Axiom for the `hmac_signature_check` event on real inbound traffic:
   - `reason: 'verified'` → safe to set `HMAC_MODE=enforce`. **This is the step
     that actually closes the gate.**
   - `reason: 'no_raw_body'` → Vercel is still parsing the body before the
     handler sees it, so the signed bytes are gone. **Do not enforce**: it would
     403 every webhook, Meta would retry and then disable the subscription, and
     Wabistay would go dark. Needs a code fix, not an env change.
   - `reason: 'signature_mismatch'` on genuine traffic → wrong secret, or the
     secret from the wrong Meta app.

Until step 2 is done, treat the webhook as unauthenticated.

## PayFast ITN verification (Payment Gating — transport layer only, not yet wired to a route)

`lib/payfast.js` verifies PayFast Instant Transaction Notifications: four checks (signature, source IP, amount match, server round-trip confirmation), not a single HMAC comparison — see that file's header comment for why this is not `lib/hmac.js` with different strings. No webhook route reads these env vars yet; they exist so the module is ready the moment Phase 2 wires a route to it.

| Variable | Scope | Notes |
|---|---|---|
| `PAYFAST_PASSPHRASE` | [PER-ENV] | The merchant "Salt Passphrase" set in the PayFast dashboard (Settings, or Sandbox → Account Information). **Required** for Subscriptions per PayFast's own docs. Absent is never treated as a pass — a missing passphrase changes what gets signed, so the signature check fails honestly rather than skipping the passphrase silently |
| `PAYFAST_ITN_MODE` | optional | Same three-mode shape as `HMAC_MODE`, carried over deliberately (CEO-confirmed 2026-09-17): unset or `log` = run all four checks, log the real verdict, **always pass through** (safe default — this scheme was built from documentation, not yet proven against real PayFast traffic). `enforce` = reject if any of the four checks fails. `off` = no checks. An unrecognised value falls back to `log`, never `off` |

**Known gap, not yet resolved (see `lib/payfast.js`'s `classifyPaymentStatus` and its header comment):** PayFast's docs document `payment_status: COMPLETE / CANCELLED` for subscriptions but no documented value for "this billing cycle's card charge failed, will retry." Do not wire Phase 2's suspend-on-failure logic against a guessed value — `classifyPaymentStatus` returns `'unknown'` for anything undocumented, deliberately not `'failed'`.

## Notifications and reporting

| Variable | Scope | Notes |
|---|---|---|
| `OWNER_PHONE` | [PER-ENV] | Production: real owner; Preview: CEO test phone. Fallback when a property has no `Notify Phone` |
| `OWNER_SUMMARY_DAILY` | optional | `'true'` switches the owner summary window from 7 days to 1. Testing aid |
| `ESCALATION_TIMEOUT_DEFAULT_MINUTES` | optional | Shift-routing/escalation PR 1. Global default for `escalationTimeoutMs()` (minutes) when a property has no `Escalation Timeout Minutes` field set. Defaults to 15 if unset/invalid. `Escalation Timeout Minutes` itself is a per-property Airtable field, not an env var — same per-property-with-global-fallback shape as `Daily Summary Hour`. **Not yet wired to any routing/resolver logic** (that starts at PR 2) — config value only |
| `AXIOM_TOKEN` | shared OK | Logging. Absent = logging silently disabled, so a missing token makes the whole observability layer inert — worth checking first when Axiom looks empty. Staging events are distinguishable by deploy environment |
| `ALERT_PHONE_FALLBACK` | [PER-ENV] | Last-resort destination for `alertShawn()` (ops failure alerts — cron errors, zero-cleaner gate arrivals) when the `WS_Config` → `Alert Phone` Airtable lookup itself fails (outage, missing row/field). Normal operation reads the number from Airtable so it can be changed without a redeploy; this env var only exists to cover an Airtable outage |

## Dashboard

| Variable | Scope | Notes |
|---|---|---|
| `DASHBOARD_PASSWORD` | [PER-ENV] | Dashboard login. Also serves as the HMAC signing key for the session cookie (V1 decision — no second secret), so rotating it invalidates every live session |
