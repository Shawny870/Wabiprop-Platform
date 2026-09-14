# Wabistay — Conversational Route Audit

**Scope:** every state and every outbound message on live trunk (`main` @ `541b829`), `api/wabistay/webhook.js` + `states.json`.
**Method:** each message's invitation was traced to the transition table for the state the guest is actually in *after* that message, then to the handler that transition names. What the copy implies is ignored; only what the code does is recorded.
**Status:** diagnosis only. No code changed, nothing pushed.

---

## 1. Route table

`H?` = handler exists for the reply this message invites, **from the state the guest is left in**.

| # | State / trigger | Message (abbrev.) | Invites reply? | H? | Routes to / notifies | Dead end? |
|---|---|---|---|---|---|---|
| 1 | any → unconfigured number | `numberNotConfigured` — "this number isn't configured yet. Please contact support." | No (points off-channel) | — | **Nobody.** No owner/ops alert; `console.error` + return | **YES** — terminal, and silent to ops |
| 2 | first contact | `consentNotice` — "…Reply STOP anytime" | STOP only | YES | STOP handled pre-dispatch (`handleMessage` L1791) | No |
| 3 | NEW `*` | `greeting` — name + dates; "_reply HOURLY and we'll assist you_" | YES — 3 fields, or HOURLY | YES | `collectDetails`; HOURLY → `startHourly` | No |
| 4 | AWAITING_DETAILS, parse fail | `detailsReprompt` | YES | YES | `collectDetails` (stays in state) | No — but loops indefinitely; no cancel/exit |
| 5 | AWAITING_DETAILS, no room | `noAvailability` — "try different dates?" | YES | YES | `collectDetails` | No |
| 6 | booking created | `ownerNewBooking` → **owner** | No | — | Notify Phone / `OWNER_PHONE` — **real** | No |
| 7 | AWAITING_OCCUPANCY | `occupancyMenu` — "1 – Just me / 2 – Two of us" | YES | YES | `selectOccupancy`; invalid → re-prompt, zero writes | No — but **only 1/2 escape**; see §2.4 |
| 8 | AWAITING_OCCUPANCY, no rate | `occupancyContactOwner` — "**the owner will be in touch shortly** to finalise the price" | Implicit — guest waits | — | **NOBODY.** `logToAxiom('warn')` only (L917). No owner send | **YES — fake affordance.** §2.1 |
| 9 | AWAITING_ETA | `bookingReceived` — "What time do you expect to arrive?" | YES | YES | `recordEta` — but accepts **any** text verbatim | No — but see §2.5 |
| 10 | CONFIRMED | `etaConfirmed` — "1 – I'm at the gate / 2 – Cancel my booking" | YES | YES | `gateArrival` / `cancelBooking` | No (overnight). **Hourly: see §2.2** |
| 11 | CONFIRMED `*` | `confirmedMenu` — re-offers 1/2 | YES | YES | `showConfirmedMenu` | No |
| 12 | CONFIRMED "2" | `cancelled` — "Your booking has been cancelled." | No | — | Booking → Cancelled; session → NEW. **Owner never told** | **Partly** — §2.2, §2.6 |
| 13 | CONFIRMED "1", too early | `gateTooEarly` — "booking is for {date}, not today… **if you need to change your booking, just let us know**" | YES, explicitly | **NO** | **Nobody.** Zero writes, state stays CONFIRMED; any reply → `showConfirmedMenu` (1/2 only) | **YES — the flagship dead end.** §2.3 |
| 14 | CONFIRMED "1" | `gateNotify` → **owner** | No | — | Notify Phone — **real** | No |
| 15 | CHECKED_IN | `welcomeAssigned` / `welcomeUnassigned` — "1 – Check out" | YES | YES | `checkout` | No |
| 16 | CHECKED_IN `*` | `checkedInMenu` — "1 – Check out" | YES | YES | `showCheckedInMenu` | No — but EXTEND is **undocumented**; §2.7 |
| 17 | CHECKED_IN, <60s | `gateCooldownMenu` — "Reply 1 again in a bit" | YES | YES | `checkout` after 60s | No |
| 18 | cron, past checkout | `checkoutWarning` — "Reply *EXTEND*… Reply *1*…" | YES | YES | `extendStay` / `checkout` | No |
| 19 | CHECKED_IN "extend" | `extensionConfirmed` | No | — | Owner told **once** (`ownerExtension`, first extension only) | No |
| 20 | CHECKED_IN "1" | `checkoutThanks` | No | — | Session → NEW | No |
| 21 | cron, grace elapsed | `autoCheckoutThanks` | No | — | Session → NEW. **Owner never told** | No — §2.6 |
| 22 | checkout | `cleanerDispatch` → **cleaner** — "Reply *DONE*" | YES | YES | global `cleanerDone` guard | No |
| 23 | cleaner "DONE", ambiguous | `cleanerWhichRoom` | YES | YES | global `cleanerRoomReply` guard | No |
| 24 | cleaner resolved | `cleanerThanks` / `ownerRoomCleaned` | No | — | Owner — **real** | No |
| 25 | cleaner, nothing to clean | `cleanerNothingToClean` | No | — | — | No |
| 26 | NEW/AWAITING_DETAILS "hourly" | `hourlyAskDetails` — name + arrival time | YES | YES | `collectHourlyDetails` | No |
| 27 | hourly parse fail | `hourlyDetailsReprompt` | YES | YES | `collectHourlyDetails` | No |
| 28 | hourly ambiguous time | `hourlyTimeAmbiguous` — "did you mean {v}am or {v}pm?" | YES | YES | `collectHourlyDetails` | No |
| 29 | AWAITING_HOURLY_DURATION | `hourlyDurationMenu` — "1/2/3… reply 4 for overnight" | YES | YES | `selectHourlyDuration` | No |
| 30 | hourly "4+" | `hourlyTooLong` | YES | YES | → AWAITING_DETAILS, `collectDetails` | No |
| 31 | hourly unavailable | `hourlyUnavailable` | YES | YES | → AWAITING_DETAILS | No |
| 32 | hourly, no room | `hourlyNoAvailability` — "try a different time?" | YES | YES | `collectHourlyDetails` | No |
| 33 | hourly booked | `hourlyBookingReceived` — "1 – gate / 2 – Cancel" | YES | **PARTLY** | `gateArrival` works by accident; **`cancelBooking` silently fails** | **YES** — §2.2 |
| 34 | hourly booked | `hourlyOwnerNewBooking` → owner | No | — | `OWNER_PHONE` only — **not** the property's Notify Phone | Inconsistent; §2.6 |
| 35 | unknown session state | `unknownFallback` — "…or *CHECKING OUT* if you are leaving today" | YES | **NO** | State already reset to **NEW**; "checking out" → `greetAndAskDetails` | **YES — fake affordance.** §2.8 |
| 36 | STOP | `optedOut` | START | YES | `handleMessage` L1809 | No |
| 37 | START | `optedBackIn` | — | YES | Normal dispatch resumes | No |

---

## 2. Confirmations on the specific items raised

### 2.1 "the owner will be in touch shortly" — nobody is in touch
`selectOccupancy` (L913–922), when no `WS_Rates` row matches the chosen occupancy: writes the session state, sends `occupancyContactOwner`, returns. The only record of it is `logToAxiom('warn', 'occupancy_no_matching_rate')` — Axiom, not WhatsApp. **No owner message is sent.** The owner did receive `ownerNewBooking` earlier, but that message contains no indication the rate is unresolved, so nothing distinguishes this guest from a normal one. The guest is told a human is coming and waits for a human who was never told. Worst-affected case: the guest still advances to AWAITING_ETA and completes a booking **with no price**.

### 2.2 "2 – Cancel my booking" — real for overnight, **silently broken for hourly**
`cancelBooking` (L1307) queries `airtableGetBookingsByGuestId(guest, 'Confirmed')`. But `selectHourlyDuration` **never sets `Status: 'Confirmed'`** — it completes the pending row (L1136) leaving `Status: 'Enquiry'`, and only moves the *session* to CONFIRMED. So for an hourly guest:
- the query returns nothing → **no booking is cancelled**;
- the guest is still told "Your booking has been cancelled";
- session resets to NEW;
- the row keeps `Status: 'Enquiry'` + both dates + its room link — and `'Enquiry'` is in `BLOCKING_BOOKING_STATUSES` (L518), so **the room stays blocked indefinitely** by a booking the guest believes is cancelled and no flow will ever revisit.

Same root cause, second symptom: `gateArrival` also queries `'Confirmed'`, so an arriving hourly guest matches no booking → `heldRoomId` is null → it falls through to the legacy "first physically available room" branch (L1260) and hands out a room **ignoring the one they were assigned**, and skipping the too-early check entirely (no `Check In` to compare).

### 2.3 The early-check-in block is terminal
`gateArrival` L1219–1233: on a future check-in date it logs, sends `gateTooEarly`, and returns — **zero writes, state stays CONFIRMED**. The message says "if you need to change your booking, just let us know." Whatever the guest replies next is routed by the CONFIRMED table: `1`/`here`/`arrived` → `gateArrival` (refused again), `2`/`cancel` → cancel, anything else → `showConfirmedMenu`, which re-offers only 1 and 2. There is **no handler for a modification request and no notification to any human.** The guest's only real options are turn up on the right day or cancel. "Just let us know" resolves to a menu that cannot express it.

### 2.4 Modify-an-existing-booking — **no path exists, anywhere**
No state, transition, or handler accepts a change to dates, time, or guest count after booking. The complete set of post-booking guest actions is: arrive (`1`), cancel (`2`), extend (CHECKED_IN only, and only forward in time), check out (`1`). `extendStay` is the sole mutation of a live booking and it only pushes `Check Out` later — it cannot change check-in, shorten a stay, or alter occupancy. A guest wanting any other change has no route and generates no notification; the request lands in the CONFIRMED fallback menu and is lost.

### 2.5 Unrecognised replies mid-flow — three different behaviours, one silent trap
- **AWAITING_DETAILS / AWAITING_HOURLY_\*** — re-prompt, zero writes. Safe.
- **AWAITING_OCCUPANCY** — re-prompts the menu, zero writes (L889). Safe, but `1`/`2` are the *only* escapes: `cancel`, `hourly`, and free text all loop. A guest who changes their mind here cannot get out.
- **AWAITING_ETA** — **not safe.** `recordEta` (L1172) takes `ctx.messageText.trim()` as the ETA with **no validation**, then sets the booking to `Confirmed`. So `HOURLY`, `cancel`, or "can I move this to the 25th?" typed at this step is stored verbatim in the `ETA` field, the booking is confirmed, and the guest gets `etaConfirmed`. The request is silently swallowed into a data field. This is the single worst input trap in the flow, because it *looks* like success to everyone.

### 2.6 HOURLY and STOP
- **HOURLY** is wired only in `NEW` and `AWAITING_DETAILS`. From AWAITING_OCCUPANCY it loops the occupancy menu; from **AWAITING_ETA it becomes the ETA string** (§2.5); from CONFIRMED/CHECKED_IN it hits the fallback menu. The greeting advertises it unconditionally, so it is a valid instruction only at the two points where the guest has not yet given dates.
- **STOP/START** are correct — handled pre-dispatch (L1791/L1809), before consent and before routing, with the two-tier rule intact.

### 2.7 EXTEND is functional but unadvertised
`extendStay` handles `extend`, `more time`, `stay longer`, `longer` from CHECKED_IN. But `welcomeAssigned`, `welcomeUnassigned` and `checkedInMenu` all offer **only** "1 – Check out". The guest only learns EXTEND exists if the auto-checkout warning fires. A real capability, invisible until the deadline — the inverse of a fake affordance.

### 2.8 `unknownFallback` advertises a keyword that cannot work
"Reply *CHECKING OUT* if you are leaving today." `unknownStateReset` sets `Session State: 'NEW'` **before** sending it (L1429). From NEW, `checking out` matches the `*` row → `greetAndAskDetails`. The guest is greeted and asked for booking dates. `checking out` is only ever valid in CHECKED_IN — the one state this message is guaranteed not to be in.

---

## 3. Human-action gaps — messages promising a human, wired to nobody

These are the silent drops: guest-facing copy implies a person will act, and no notification reaches one.

| Message | Implies | Actually notifies | Consequence |
|---|---|---|---|
| `occupancyContactOwner` | "the owner will be in touch shortly to finalise the price" | **Nobody** — Axiom warn only | Guest waits indefinitely; booking completes **unpriced** |
| `gateTooEarly` | "if you need to change your booking, just let us know" | **Nobody** — zero writes, no send | Modification requests vanish into the CONFIRMED menu |
| `numberNotConfigured` | "Please contact support" | **Nobody** — `console.error` only | A misconfigured property fails silently; no one is paged |
| `cancelled` | (implies the cancellation is actioned) | **Nobody** — owner got `ownerNewBooking` but is never told it was cancelled | Owner holds a booking the guest cancelled. Hourly: not even cancelled (§2.2) |
| `autoCheckoutThanks` | guest force-checked-out by the system | Cleaner only — **owner not told** | Owner never learns a guest overstayed and was auto-removed |
| `hourlyOwnerNewBooking` | owner notified of a booking | `OWNER_PHONE` env var only — **not** the property's `Notify Phone` | On a multi-property base, hourly bookings notify the wrong person, or nobody |
| `welcomeUnassigned` | "We've notified someone to assist you at the gate" | `gateNotify` **is** sent — genuine | ✅ Not a gap. Listed to confirm it was checked |

---

## 4. Ranked by damage

1. **Hourly cancel is a lie that also leaks inventory** (§2.2) — guest told cancelled, booking not cancelled, room blocked forever. Silent, permanent, revenue-affecting.
2. **AWAITING_ETA swallows everything** (§2.5) — any request becomes an ETA string and confirms the booking. Looks like success to guest, owner, and logs.
3. **Unpriced bookings with nobody notified** (§2.1) — guest waits on a human who does not know.
4. **No modification path at all** (§2.4) — structural gap; every "change my booking" is lost, and two messages actively invite it.
5. **`gateTooEarly` invites a reply into a two-option menu** (§2.3).
6. **Owner blind spots** (§3) — cancellations, auto-checkouts, misconfigured numbers.
7. **`unknownFallback` / EXTEND copy** (§2.7, §2.8) — cosmetic by comparison, cheap to fix.

**Note on 1 and 2:** both are behavioural bugs, not just copy gaps, and neither has a fixture. They are invisible to the current suite.

---

*Audit only. No code changed, nothing pushed. Fixes deliberately not proposed — scope is the CEO's call.*
