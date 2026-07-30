# Hourly bookings never reached `Confirmed` — inventory leak + wrong-room check-in (F29)

Isolated commit. One-line behavioural fix plus the tests that were missing, which is why this survived to production-adjacent code in the first place.

## The bug

`selectHourlyDuration` completes the half-built hourly row — writes `Check Out`, the room link, `Booking Ref`, `Amount Due` — and moves the **session** to `CONFIRMED`. It never set the **booking's** `Status`, so the row stayed `'Enquiry'`, the value `collectHourlyDetails` created it with.

That breaks the invariant overnight bookings hold: `recordEta` sets `Status: 'Confirmed'` at exactly the moment the session becomes `CONFIRMED`. Hourly had a confirmed session pointing at an unconfirmed booking. Two handlers query strictly on `'Confirmed'`:

**1. `cancelBooking` — cancellations that don't cancel, and never release the room.**
The query returns nothing, so no row is updated. The guest is still sent *"Your booking has been cancelled"* and the session resets to `NEW`. The row keeps `Status: 'Enquiry'` plus both dates and its room link — and `'Enquiry'` is in `BLOCKING_BOOKING_STATUSES`, so `findAvailableRoom` keeps honouring the hold. The room is blocked **permanently** by a booking the guest believes is gone and no flow will ever revisit.

**2. `gateArrival` — the guest is handed the wrong room.**
It also queries `'Confirmed'`, matches nothing, so `heldRoomId` is null and it falls through to the legacy "first physically available room" branch. The guest is checked into whatever room is free rather than the one they hold — and with no booking matched there is no `Check In` to compare, so the B9 too-early guard is skipped entirely.

## The fix

One field, at the point the row stops being a draft:

```js
await airtableUpdate('WS_Bookings', pending.id, {
  'Check Out': checkOutIso,
  'Room': [room.id],
  'Booking Ref': bookingRef,
  'Status': 'Confirmed',     // ← was never set; row stayed 'Enquiry'
  ...
});
```

`cancelBooking` and `gateArrival` are **untouched**, which is the correct direction: they already implement the contract every overnight booking satisfies. Hourly was the outlier, so hourly conforms.

### Verified against live schema (Meta API)

`WS_Bookings.Status` (`fldf2NiwNNUaDR2Zv`, `singleSelect`) — options are exactly `Enquiry`, `Confirmed`, `Checked In`, `Checked Out`, `Cancelled`. `'Confirmed'` is the live string, spelling and case as written.

### Nothing depended on the old behaviour

Audited every `'Enquiry'` reference:

| Site | Depends on hourly being `Enquiry`? |
|---|---|
| `findPendingHourlyBooking` (L98) | **No** — additionally requires `!Check Out`, so a completed row is excluded regardless of status |
| `recordEta` (L1174) | **No** — hourly goes straight to `CONFIRMED`, never entering `AWAITING_ETA` |
| `selectOccupancy` (L895) | **No** — overnight-only, and filters on `Booking Type === 'Overnight'` |
| `runEnquiryAbandonment` (L1597) | **No** — only sweeps guests in draft session states; a completed hourly guest is `CONFIRMED` |
| `BLOCKING_BOOKING_STATUSES` (L518) | Contains both `Enquiry` and `Confirmed`, so **room-holding behaviour is unchanged** for a live booking — only cancellation now releases it, as intended |

**Bonus hazard removed:** a stuck hourly `Enquiry` row could be picked up by `recordEta` during that guest's *next* overnight booking (`airtableGetBookingsByGuestId(guest, 'Enquiry')[0]`), confirming the wrong booking. The fix closes that too.

## Tests — `test/hourly.status.test.js`

The replay harness drives one message per fixture, but this bug is only visible **across** messages: message 1 (duration) does the damage, message 2 (cancel / gate arrival) reveals it. A single-message fixture cannot reproduce it. So these drive the real webhook **twice against one persistent `MockAirtable`** — same store, same handler, in sequence.

1. **Status is set** — a completed hourly booking reaches `Confirmed`.
2. **Leak closed** — book → cancel → the row is really `Cancelled`, and asserted *not* to be in `BLOCKING_BOOKING_STATUSES`, which is the actual leak condition rather than a proxy for it.
3. **Own room** — book → arrive → the guest is checked into `recR1` (their own room), and the second room `recR2` is asserted untouched. Two rooms are seeded deliberately so "did the fallback fire" has a detectable wrong answer.

**Red→green, verified by stash-and-rerun:**

| | unfixed trunk | fixed |
|---|---|---|
| status set | ✖ still `Enquiry` | ✔ `Confirmed` |
| cancel | ✖ *"the row must actually say so"* | ✔ `Cancelled`, room released |
| gate arrival | ✖ *"must find and check in the guest's own booking"* | ✔ own booking, own room |

`fixtures/32` also now pins `Status: 'Confirmed'` on the happy path.

Full suite: **130 passing.** One pre-existing unrelated failure (`router: message on 1157302750805659 …`), present on unmodified `main`.

## Live data — no cleanup needed, and the urgency premise was wrong

Queried the live base read-only (see `docs/hourly-enquiry-stuck-rows.md`):

- **0** hourly rows stuck at `Enquiry`
- **0** hourly bookings of any kind — the flow has never completed one in production
- 22 bookings total, all `Overnight`

The bug is real and reproducible, but **latent**: it sits in front of a path no live guest has reached. It was **not** corrupting live data on every hourly cancellation. Nothing to clear in Airtable. The fix is pre-emptive — the first live hourly booking on unfixed code would have started the leak.

## Governance

Not pushed. Untrusted until CEO device-tests it.
