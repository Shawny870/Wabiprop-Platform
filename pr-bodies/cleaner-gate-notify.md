# Cleaner gate-arrival notification, template-gated (F30)

**Label: `needs-decision`** — introduces new guest/staff-facing copy (a Meta utility template), which per CLAUDE.md line 31 requires CEO review before merge.

## The bug

`gateArrival` made exactly two sends: `gateNotify` to the property's `Notify Phone` (the owner), and the guest's `welcomeAssigned` — whose copy promises:

> Someone is on their way to open the gate for you.

There was **no `WS_Cleaners` read and no cleaner send anywhere in the handler**. The only two cleaner dispatch sites in the file were `checkout` and `settleAutoCheckout`, both checkout paths. The guest's promise was unbacked copy — nobody on the ground was ever messaged.

Live data confirms the cleaner *would* have resolved: Villa Liza's single cleaner is `Active` with `Assigned Property` set, and their number differs from the property's `Notify Phone`. Nothing ever asked for them.

The reported "cleaner is offline, so nothing arrives even after reconnecting" was a red herring. WhatsApp store-and-forwards anything Meta accepts; nothing arriving after reconnect means nothing was ever accepted. Here, nothing was ever sent.

## Why this is a template send, not free-form

Gate arrival is business-initiated to a third party who has not messaged us, so it falls outside Meta's 24-hour customer-service window. Free-form text there is rejected with **131047** and vanishes at HTTP 200 — CLAUDE.md line 30. Wiring in a plain `sendWhatsApp` would have reproduced the exact invisible failure this fix exists to end.

So the send routes through a new `sendWhatsAppTemplate`, and is **inert until the template below is approved and `WABISTAY_CLEANER_GATE_TEMPLATE` is set.** Unset is the stub state: skipped and logged, never downgraded to free-form.

---

## ▶ ACTION REQUIRED — submit this template to Meta

Meta Business Manager → WhatsApp Manager → Message Templates → Create template.

| Field | Value |
|---|---|
| **Name** | `wabistay_cleaner_gate_arrival` |
| **Category** | **Utility** (not Marketing — this is a transactional operational alert) |
| **Language** | English (`en`) |

**Body text — paste exactly:**

```
Hi {{1}}, a guest has arrived at the gate. {{2}} is checking in to {{3}} at {{4}}. Please open the gate and show them in.
```

No header, no footer, no buttons.

**Sample values** (Meta requires these to approve):

| Placeholder | Meaning | Sample |
|---|---|---|
| `{{1}}` | Cleaner name | `Thandi` |
| `{{2}}` | Guest name | `John Smith` |
| `{{3}}` | Room name | `Room 1` |
| `{{4}}` | Property name | `Villa Liza Guest Lodge` |

**The parameter ORDER is load-bearing** — the code sends `[cleanerName, guestName, roomName, propertyName]` positionally. If the approved template reorders the placeholders, the message renders scrambled with no error. Don't reword in a way that changes their order.

Two constraints the wording already satisfies, worth preserving if you edit it: Meta rejects a body that starts or ends with a variable, and rejects two adjacent variables. `{{3}}` also has to read correctly when no room was assigned — the code passes the literal `an unassigned room`, giving *"…is checking in to an unassigned room at Villa Liza Guest Lodge."*

**Once approved**, set in Vercel (Production, and Preview if testing there):

```
WABISTAY_CLEANER_GATE_TEMPLATE=wabistay_cleaner_gate_arrival
```

Until then this ships **inert and safe** — every skipped notification is logged, so the gap is measurable rather than silent.

---

## What's in the diff

**1. `sendWhatsAppTemplate(to, templateName, params, meta)`** — built as the shared surface for *all three* business-initiated sends (cleaner gate, checkout dispatch, B17 owner summary), not gate-specific. Replaces the commented-out TODO B17 had been blocked on. Returns `{ ok, wamid, error }` so callers can correlate a failure to its booking; `meta` is merged into every Axiom event.

**2. `notifyCleanerOfArrival`** wired into `gateArrival` as Step 6b — **in addition to** the owner send, which is unchanged.

**3. Delivery correlation** — every terminal path names the booking, so *"which bookings had no cleaner told?"* is a query, not an inference:

| Event | When |
|---|---|
| `cleaner_gate_notify_stubbed` | template not configured |
| `cleaner_gate_notify_no_cleaner` | no active cleaner assigned to the property |
| `cleaner_gate_notify_failed` | send attempted, Meta refused |
| `whatsapp_template_send_error` | with `reEngagementRejected: true` isolating 131047 |
| `whatsapp_template_sent` | success — carries `wamid`, the join key to B3's `whatsapp_status_callback` |

That last one closes the loop: a template Meta *accepts* but never *delivers* is still traceable to its booking.

**4. Diagnostics stripped** — the three `[Cleaner Dispatch DIAG]` `console.log`s in `checkout`, marked "temporary — remove once resolved", merged via PR #14.

## Two decisions embedded, flagged for review

**Scoping uses `ctx.property.id`, not `bookingPropertyId(booking, …)`** — a deliberate deviation from the Bug 2 call pattern, though the same model and the same `activeCleanersForProperty` helper. Step 4 writes `WS_Property: [ctx.property.id]` unconditionally, so the two agree by construction; but `bookingPropertyId` reads the booking copy fetched at Step 2, **before** that write. A booking carrying a stale link from a previous check-in at another property would scope the cleaner to the *old* property while the record was updated to the *new* one. The checkout paths have no such authority (no inbound property is being written) and correctly keep using `bookingPropertyId`.

**Every active cleaner assigned to the property is notified**, matching the checkout dispatch. Picking one would require on-duty/shift resolution — explicitly deferred, not built here.

## Testing

- `fixtures/65_gate_arrival_cleaner_notified_property_scoped.json` — two properties, two **active** cleaners (so only property scoping can exclude anyone), template configured. Cleaner seeded as `0821110000` to exercise `formatPhone` normalisation on the wire value.
- `test/cleanergate.test.js` — the four states a single-message fixture can't express: unconfigured, no cleaner assigned, 131047 rejection, and wamid capture. Property B's cleaner asserted **absent explicitly**, not merely implied by send count (fixture 61's exclusion pattern).

All six red on trunk, green here. Suite: **139 tests, 138 pass**, 1 known pre-existing failure (`router: message on 1157302750805659…`, identical on unmodified `main`, tracked by `docs/backlog-router-test-ws-properties-seed`).

Harness extended to record template sends — it previously read `body.text.body` and would have thrown on a template payload — and to support per-fixture `env`.
