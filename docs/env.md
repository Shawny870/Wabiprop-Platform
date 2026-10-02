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
| `WABISTAY_CLEANER_GATE_TEMPLATE` | optional | Cleaner gate-arrival notification (F30). Set to the **approved** template name — `wabistay_cleaner_gate_arrival` — only after Meta approves it. While unset, each skip logs `cleaner_gate_notify_stubbed` with `bookingId`. Parameter order is positional and load-bearing: `{{1}}` cleaner, `{{2}}` guest, `{{3}}` room, `{{4}}` property |
| `WABISTAY_ROOM_ORDER` | optional | Room selection order (Doc 1b PR 4). Set to `1` or `true` to turn on. `findAvailableRoom` then ranks the free rooms by status — Available, then Cleaning, then Occupied — and breaks ties by lowest room number (`Room Number`, else the digits in `Room Name`), instead of taking whichever free room Airtable lists first. A held room (`preferRoomId`, the gate-arrival re-check) still wins over any ordering. Date-overlap, `Active` and Maintenance rules are unchanged. Unset or any other value keeps Airtable order. Switch off by unsetting the variable |
| `WABISTAY_STATE_WRITE_GUARD` | optional | State-write guard (Doc 1b, PR 1). Set to `1` or `true` to turn on. When a booking-flow Session State advance fails (for example a select option missing in Airtable), the bot stops BEFORE sending the next prompt, sends the guest "speak to reception on {Guest Redirect Phone}" (falls back to `Notify Phone`; with neither set the guest is sent nothing and the alert says so), logs `guest_state_write_guard_tripped`, and fires `alertShawn` `guest_state_write_failed`. Unset or any other value keeps the old behaviour: the failure is only logged and the flow carries on. Covers greeting, stay-type/hourly/overnight details, hourly duration, payment method and ETA. Does not cover gate arrival, checkout, rating or cancel (they have side effects that must still complete). Switch off by unsetting the variable |
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
