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

## Notifications and reporting

| Variable | Scope | Notes |
|---|---|---|
| `OWNER_PHONE` | [PER-ENV] | Production: real owner; Preview: CEO test phone. Fallback when a property has no `Notify Phone` |
| `OWNER_SUMMARY_DAILY` | optional | `'true'` switches the owner summary window from 7 days to 1. Testing aid |
| `AXIOM_TOKEN` | shared OK | Logging. Absent = logging silently disabled, so a missing token makes the whole observability layer inert — worth checking first when Axiom looks empty. Staging events are distinguishable by deploy environment |

## Dashboard

| Variable | Scope | Notes |
|---|---|---|
| `DASHBOARD_PASSWORD` | [PER-ENV] | Dashboard login. Also serves as the HMAC signing key for the session cookie (V1 decision — no second secret), so rotating it invalidates every live session |
