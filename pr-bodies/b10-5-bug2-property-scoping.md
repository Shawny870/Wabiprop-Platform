# B10.5 BUG 2 — property-scoped cleaner dispatch (decision c)

Closes the Bug 2 gate from `pr-bodies/b10-5-bug2-gate-report.md`. Persists the property on the booking at check-in and scopes **both** checkout paths off it. Isolated commit — no B11–B19 feature work included.

## The bug

Both checkout paths dispatched cleaners with the same unscoped query:

```js
const cleaners = await airtableGet('WS_Cleaners', `{Active} = TRUE()`);
```

— manual `checkout` (~L1361) and `settleAutoCheckout` (~L1464). Every active cleaner in the base was notified on every checkout, regardless of which property the guest was at. Invisible with one property live; a guaranteed cross-property leak the moment a second one exists.

**Correction to the gate report (line 9):** the report expected the auto path to derive scope from the Booking→Room→Property walk. It does not. That walk resolves `propertyName` for the guest's message copy only and never reached the cleaner query. Both paths were identically unscoped, so there was no dead room-walk scoping to remove — the walk is live and stays.

## The fix

1. **Write** — the arrival handler's existing `bookingUpdate` now also sets `WS_Property: [ctx.property.id]`. No new call, no new resolution; `ctx.property` is already resolved from the inbound `phone_number_id`. Check-in is where the property is first known for certain.
2. **Read** — one shared helper pair (`bookingPropertyId` / `activeCleanersForProperty`) used by both checkout paths, so there is a single scoping mechanism rather than two.
3. **Room walk kept** in `runAutoCheckout` — it feeds `propertyName` into the guest copy. `propId` is now also passed to `settleAutoCheckout`, as a fallback only.

### Scoping is by record id, never by name

Airtable's `filterByFormula` matches a linked-record field on its **primary display value**, not the record id, so there is no id-safe formula for this. The helper fetches active cleaners and filters on the link array in code — the same reasoning already documented on `airtableGetBookingsByGuestId`. Property names collide and change; ids do not.

### Fallback and failure direction

Scope resolves as: booking's `WS_Property` → else `ctx.property.id` (manual) / room-walk `propId` (auto) → else **nobody**. Bookings checked in before this commit carry no `WS_Property`, and the fallback keeps them correctly scoped rather than unscoped. If nothing resolves, dispatch **fails closed**: the bug was notifying everyone, so a silent no-op is the safe direction of error. Covered by a dedicated test.

## Live schema (confirmed via meta API, not trunk `schema.json`)

| Table | Field | Type | Links to |
|---|---|---|---|
| `WS_Bookings` | `WS_Property` (`fld33emj2xY6kbBrJ`) | `multipleRecordLinks`, `prefersSingleRecordLink: true` | `WS_Properties` |
| `WS_Cleaners` | `Assigned Property` (`fldWzTeMsoG1og0z0`) | `multipleRecordLinks`, `prefersSingleRecordLink: false` | `WS_Properties` |

`Assigned Property` **does exist live** — it was absent from trunk code and from the stale `schema.json`, which is what made the original gate report treat it as a Chain B–only field. Both fields are added to `schema.json` here. Note `schema.json` remains stale in other respects (e.g. `WS_Bookings.WS_Enquiries`, `Checkout Warning Sent At`, `Extension Owner Notified` are all live but unrecorded) — a full refresh is out of scope for this commit.

## Tests

Both paths, two properties, exclusion-asserting. Three cleaners are seeded **all Active**, so the `{Active}` filter cannot be what excludes anyone — only property scoping can.

- `fixtures/61_manual_checkout_property_scoped.json` — manual path. The booking's room is deliberately left **without** a Property link, so a room-walk implementation would fail this fixture.
- `test/autocheckout.test.js` — auto path (the cron is time-driven and can't be replayed through the fixture harness), plus the fail-closed case.

Assertions prove exclusion, not just inclusion: exact send count, plus explicit checks that property B's number and name never appear.

**Red/green, verified:**

| | unfixed | fixed |
|---|---|---|
| auto-checkout sends | 4 — `27821110000`, `27822220000`, `27823330000`, guest | 2 — property A's cleaner, guest |

Full suite: **130 passing**. One pre-existing unrelated failure on trunk (`router: message on 1157302750805659 …`) — present before this change, untouched by it.

### Fixture seed corrections (behavioural, not cosmetic)

`fixtures/10`, `fixtures/58` and the existing B12 auto-checkout test seeded cleaners with no `Assigned Property`. Under property scoping those cleaners are correctly excluded, so the seeds now assign them to `recP1`. `fixtures/06` additionally asserts the new `WS_Property` write at check-in.

## ⚠️ Merge note — collision with B11 / B11.5

Neither branch touches the arrival/check-in write path, so **the `WS_Property` write is conflict-free**.

However, `feature/b11-cleaner-property-link` and `feature/b11-5-cleaner-guest-precedence` (both unmerged) **rewrite the same manual-checkout cleaner query line** this commit rewrites, to their own `Assigned Property` filter — and both also edit `fixtures/10`'s cleaner seed in the same place.

**Whoever merges second will hit a textual conflict there.** Resolve by keeping this commit's `activeCleanersForProperty(scopePropertyId)` call: it is strictly broader — scoped off the booking record rather than request-scoped `ctx.property.id`, and it covers the auto path too, which B11 does not. B11's `fixtures/43` should then be redundant with `fixtures/61`; keep whichever the reviewer prefers, or both.

## Governance

Not pushed — CEO runs the push. Nothing here is device-tested; treat as untrusted until the CEO device-tests it.
