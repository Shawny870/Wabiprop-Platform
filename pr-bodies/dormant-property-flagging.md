# Dormant-property flagging (basic)

**Branch:** `feat/wabistay-dormant-property-flagging` → base `feat/wabistay-property-activity-tracker` (depends on its two new WS_Properties fields).

## What this adds
Read-only, no new notification channel — matches the original ask ("an Airtable view is sufficient"). **Two separate, un-conflated views**, per CEO decision (see below):

1. **`dormantProperties(properties, opts)`** — the actual WhatsApp Coexistence disconnect-risk flag, keyed on **`Last Owner App Open` alone** by default (`mode: 'owner_open_only'`). `mode: 'either'`/`'both'` (combining it with `Last Message Received`) remain available but are not the default.
2. **`inactiveByMessageActivity(properties, opts)`** — a distinct, separate "this property may be quiet" view keyed on **`Last Message Received` alone**. Not merged into the dormancy flag.
3. **`api/wabistay/dormant-report.js`** — CEO-only on-demand JSON endpoint (`GET`, `Authorization: Bearer MANUAL_REPORT_SECRET`), returns both views as separate response keys (`dormant` / `messageInactive`), never combined into one number.
4. **Airtable formula field (for a real native view)** — see "Schema dependency" below, updated to match.

## CEO decision — supersedes this PR's original default (history kept, not deleted)
Original build defaulted to `mode: 'either'` per a literal reading of the original spec ("Last Message Received OR Last Owner App Open exceeds threshold"), already flagged at the time as over-flagging relative to actual disconnect risk. **CEO decision, follow-up batch**: `Last Message Received` (guest activity) and `Last Owner App Open` (the actual 14-day Coexistence signal) measure different risks and must not be conflated — a property with guests messaging constantly but a stale owner app-open is still real disconnect risk that a combined/either-signal flag would mask (busy guest inbox papering over the actual signal going stale).

Resolved by keying the dormancy flag on `Last Owner App Open` alone (new default), and keeping `Last Message Received` as its own separate, un-deleted view (`inactiveByMessageActivity`/`messageInactive`) rather than folding it into the disconnect-risk number. `mode: 'either'`/`'both'` stay available on `dormantProperties()` for anyone who wants a combined view later — the data and the option aren't gone, just no longer the default.

## Schema dependency (CEO) — Airtable-native view
For an actual Airtable view, add a formula field to `WS_Properties`, e.g. named `Dormant`:

```
DATETIME_DIFF(NOW(), {Last Owner App Open}, 'days') > 10
```

(A separate `Inactive` field, `DATETIME_DIFF(NOW(), {Last Message Received}, 'days') > 10`, gives the distinct message-activity view as its own Grid view/filter — kept separate on purpose, same reasoning as the code.) `DATETIME_DIFF` against a blank field's behavior should be confirmed against the live base rather than assumed — it should read as "stale," matching the code's own "never recorded = maximally dormant" rule.

This depends on the two `WS_Properties` fields from `feat/wabistay-property-activity-tracker` existing first — same schema-dependency chain, not yet created in the live base.

## Test coverage
`test/dormantproperties.test.js`: all three `dormantProperties` modes (`owner_open_only` default, `either`, `both`), the never-recorded-at-all case, threshold configurability (param and env var), `inactiveByMessageActivity` as its own separate function, and the on-demand endpoint's auth/validation/read-only-ness with both response keys present and independently correct.

Full suite: see latest CI run for this branch — re-verified after the CEO's mode-default change.
