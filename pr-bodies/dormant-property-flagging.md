# Dormant-property flagging (basic)

**Branch:** `feat/wabistay-dormant-property-flagging` → base `feat/wabistay-property-activity-tracker` (depends on its two new WS_Properties fields).

## What this adds
Read-only, no new notification channel — matches the original ask ("an Airtable view is sufficient").

1. **`dormantProperties(properties, opts)`** — pure helper in `api/wabistay/webhook.js`, flags properties where `Last Message Received` and/or `Last Owner App Open` exceeds a threshold (default 10 days, configurable via `DORMANT_THRESHOLD_DAYS` env var or per-call). A property that never recorded either timestamp is treated as maximally dormant, not skipped.
2. **`api/wabistay/dormant-report.js`** — CEO-only on-demand JSON endpoint (`GET`, `Authorization: Bearer MANUAL_REPORT_SECRET` — reuses the existing manual-report secret rather than inventing a third one, same trust boundary as `manual-report.js`). Query params: `thresholdDays`, `mode` (`either`/`both`). Purely additive, no schedule, not wired into `vercel.json`.
3. **Airtable formula field (for a real native view)** — see "Schema dependency" below.

## Judgment call — flagged, not silently decided
The task specified: *"properties where Last Message Received OR Last Owner App Open exceeds a configurable threshold."* Implemented literally (`mode: 'either'`, the default): a property is flagged if **either** signal alone is stale.

This over-flags relative to what the threshold is actually a buffer for — WhatsApp Coexistence's 14-day disconnect risk is about total silence on the number, i.e. **both** signals stale, not either one alone. Under `mode: 'either'`, a property with guests messaging constantly but where the owner hasn't triggered a `read` receipt recently (a sparse signal by nature — see the property-activity-tracker PR's own caveat about `Last Owner App Open` under-reporting) would still get flagged, even though the number itself is nowhere near disconnect risk.

Built both. `mode: 'both'` is available and tested (`test/dormantproperties.test.js`) for the stricter reading if the CEO prefers it — the default stays `either` to match the literal spec. Easy one-line change either way (default in `dormant-report.js` / `dormantProperties`'s own default param).

## Schema dependency (CEO) — Airtable-native view
For an actual Airtable view (not just the JSON endpoint above), add a formula field to `WS_Properties`, e.g. named `Dormant`:

```
OR(
  DATETIME_DIFF(NOW(), {Last Message Received}, 'days') > 10,
  DATETIME_DIFF(NOW(), {Last Owner App Open}, 'days') > 10
)
```

(Swap `OR` for `AND` for the stricter `mode: 'both'` reading.) `DATETIME_DIFF` against a blank field returns a large/error value in Airtable formulas depending on version — verify blank-field behavior when creating this field; it should read as "stale," matching the code's own "never recorded = maximally dormant" rule, but Airtable formula semantics for blank date fields should be confirmed against the live base rather than assumed. Then build a Grid view filtered on `{Dormant} = TRUE()`.

This depends on the two `WS_Properties` fields from `feat/wabistay-property-activity-tracker` existing first — same schema-dependency chain, not yet created in the live base.

## Test coverage
New `test/dormantproperties.test.js`, 9 tests: both modes, the never-recorded-at-all case, threshold configurability (param and env var), and the on-demand endpoint's auth/validation/read-only-ness.

Full suite: 489 passing, 0 failing (476 pre-existing/updated on the base branch + 4 property-activity tests + 9 new here).
