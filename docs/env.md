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

The B17 owner summary (`OWNER_SUMMARY_TEMPLATE`) is still a code constant rather
than an env var, because its send remains stubbed pending Meta approval.

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
