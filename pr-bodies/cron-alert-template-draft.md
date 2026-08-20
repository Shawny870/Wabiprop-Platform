# Meta template draft: Wabistay cron/system-alert (submission draft only)

**Branch:** `docs/wabistay-cron-alert-template` → base `main`. Docs only — no code changes, nothing submitted to Meta.

## Why this exists
`alertShawn()` (added in `feat/wabistay-alert-shawn`, `api/wabistay/webhook.js`) currently sends a **free-form** WhatsApp text to whoever's number is in `WS_Config.'Alert Phone'`. Free-form sends only work inside Meta's 24-hour session window — if the ops number hasn't messaged the bot recently, the alert silently vanishes at HTTP 200 (the exact failure mode this codebase already avoids everywhere else via approved utility templates — see `docs/env.md`, "Message templates" section). This draft closes that gap for `alertShawn()` specifically.

## Draft template content

**Name:** `wabistay_system_alert` (matches existing naming convention: `wabistay_cleaner_gate_arrival`, `wabistay_owner_weekly_summary`, `wabistay_daily_summary`)
**Category:** UTILITY
**Language:** `en` (matches `WA_TEMPLATE_LANGUAGE` default — `docs/env.md`)

**Body:**
```
⚠️ Wabistay alert: {{1}} failed.
Property: {{2}}
Time: {{3}} SAST
Details: {{4}}
```

**Sample values (for Meta's review form):**
- `{{1}}` — `owner_summary` (the cron/job name — matches the `cronName` argument already passed to `alertShawn()`, e.g. `owner_summary`, `daily_summary`, `owner_summary_fatal`, `daily_summary_fatal`, `gate_arrival`)
- `{{2}}` — `Villa Liza Guest Lodge` (property name when the failure is property-scoped; literal string `"system-wide"` for a fatal/whole-run failure with no single property — see variable notes below)
- `{{3}}` — `14 Aug 2026, 09:03` (SAST-formatted timestamp, matching the `formatSastDateTime` helper already used elsewhere in `webhook.js`)
- `{{4}}` — `Airtable timeout` (the error message — kept short deliberately; see length note below)

## Variable list (for the code-side wiring, once approved)
| Var | Source | Notes |
|---|---|---|
| `{{1}}` | `cronName` param already passed to every `alertShawn()` call site | No change needed at call sites |
| `{{2}}` | `context.propertyName` where present, else literal `"system-wide"` | The fatal-catch call sites (`owner_summary_fatal`, `daily_summary_fatal`) pass `{ scope: 'entire run...' }`, not a property name — needs a one-line adjustment to pass `"system-wide"` explicitly once this goes live |
| `{{3}}` | `new Date()` at alert time, SAST-formatted | Not currently computed inside `alertShawn()` — add at the same point |
| `{{4}}` | `errorMessage` param, truncated | Meta template body params have a practical length ceiling (~1024 bytes total payload, but WhatsApp clients truncate long params visually well before that) — truncate to ~200 chars in code before submission, in case `err.message` includes a stack fragment |

## What does NOT change yet
This is a draft for review only. Wiring `sendWhatsAppTemplate()` into `alertShawn()` in place of the current free-form `sendWhatsApp()` is a separate, small follow-up **once Meta approves this template** — same pattern already established for `WABISTAY_CLEANER_GATE_TEMPLATE`/`WABISTAY_RECEPTION_PAYMENT_TEMPLATE` (stub-until-approved, env-var-gated). Not done in this PR.

## For the CEO
1. Submit the body text above via Meta Business Manager, category **Utility**, language **en**.
2. Once approved, note the exact approved template name (Meta sometimes appends/normalizes) back to the team so the follow-up PR can wire it in.
