// /api/wabistay/webhook.js
// WS1 — Wabistay Guest Booking Enquiry Bot
// Reads: WS_Rooms, WS_Rates, WS_Guests, WS_Cleaners
// Writes: WS_Guests, WS_Bookings, WS_Rooms
// No AI. Deterministic state machine only.
//
// H0: the state machine (state → input → action → next state) and ALL outbound
// message copy live in /states.json. This file holds transport, helpers and the
// side-effect handlers the table dispatches to. Every behaviour is frozen by a
// replay fixture in /fixtures — run `node --test` before and after any change.
//
// FIX LOG: see FIXLOG.md (F1–F14 from the WS1 build, referenced inline below).

const STATES = require('../../states.json');

const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
const WA_PHONE_NUMBER_ID = process.env.WA_PHONE_NUMBER_ID;
const WA_ACCESS_TOKEN = process.env.WA_ACCESS_TOKEN;
const WA_VERIFY_TOKEN = process.env.WA_VERIFY_TOKEN;
const OWNER_PHONE = process.env.OWNER_PHONE;
const AXIOM_TOKEN = process.env.AXIOM_TOKEN;
// Language code every Wabistay utility template is submitted under. Meta matches
// a template on name + language, so this must equal the locale of the approved
// template or the send is rejected as non-existent.
const TEMPLATE_LANGUAGE_CODE = process.env.WA_TEMPLATE_LANGUAGE || 'en';

// Meta utility template for the cleaner gate-arrival notification. FLAG: pending
// Meta approval (Shawn submits). Read at CALL time, not here, so the notify path
// is inert until the name is configured — see cleanerGateTemplate() below. An
// unset value is the stub state, exactly like B17's owner summary.
function cleanerGateTemplate() {
  return process.env.WABISTAY_CLEANER_GATE_TEMPLATE || null;
}

// B8 (PAID): the checkout push to the Reception seat. Same contract as the
// cleaner gate template above and B17's owner summary — read at CALL time, unset
// IS the stub state, and the stub logs the full payload rather than downgrading
// to free-form text. Reception has not messaged us at checkout time, so this is
// business-initiated to a third party: outside Meta's 24h window free-form is
// rejected 131047 and vanishes at HTTP 200 (CLAUDE.md line 30).
function receptionPaymentTemplate() {
  return process.env.WABISTAY_RECEPTION_PAYMENT_TEMPLATE || null;
}

// ─── AIRTABLE HELPERS ───────────────────────────────────────────────────────

// `opts.throwOnError` (default false): every existing caller relies on the
// original contract — a failed page logs to Axiom and returns whatever was
// accumulated so far, silently. That is the RIGHT default for most callers
// (e.g. "how many active cleaners" failing open to zero still fails loud via
// the existing no-cleaner-found logging). It is the WRONG default for a
// caller whose empty result means "nothing blocks this room" — there, a
// swallowed error and a genuine zero-rows answer are indistinguishable, and
// the difference is a fail-open double-booking. `findAvailableRoom` is the
// one caller (PR1 / P1b) that opts in, specifically for that query, and
// treats the throw as fail-CLOSED. No other call site is touched.
async function airtableGet(table, filterFormula, opts = {}) {
  const { throwOnError = false } = opts;
  // B10.5 BUG 1: Airtable's list API returns at most 100 records per response and
  // signals "there is more" with an `offset` token in the body. A single fetch
  // therefore SILENTLY truncates past 100 rows — no error, just a short list — and
  // any caller that treats the result as the complete set (e.g. logEnquiry's
  // dedup guard) breaks once the table grows. Loop on `offset`, accumulating every
  // page, until the response has no `offset`, so callers genuinely get everything.
  const base = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(table)}?filterByFormula=${encodeURIComponent(filterFormula)}`;
  console.log(`[Airtable GET] ${table} | ${filterFormula}`);
  const records = [];
  let offset;
  let page = 0;
  do {
    const url = offset ? `${base}&offset=${encodeURIComponent(offset)}` : base;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${AIRTABLE_API_KEY}` }
    });
    // F6: log HTTP status so we can see 401/403/404 in logs
    console.log(`[Airtable GET STATUS] ${table} | HTTP ${res.status} | page ${++page}`);
    const data = await res.json();
    if (data.error) {
      console.error(`[Airtable ERROR] ${table}:`, JSON.stringify(data.error));
      logToAxiom('error', 'airtable_get_error', { table, filterFormula, status: res.status, error: JSON.stringify(data.error) });
      if (throwOnError) {
        throw new Error(`airtableGet failed: ${table} — ${JSON.stringify(data.error)}`);
      }
      break;
    }
    if (data.records) records.push(...data.records);
    offset = data.offset; // Airtable omits this once the last page is returned
  } while (offset);
  return records;
}

async function airtableCreate(table, fields) {
  console.log(`[Airtable CREATE] ${table}`, JSON.stringify(fields));
  const res = await fetch(`https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(table)}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${AIRTABLE_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ fields })
  });
  console.log(`[Airtable CREATE STATUS] ${table} | HTTP ${res.status}`);
  const data = await res.json();
  if (data.error) {
    console.error(`[Airtable CREATE ERROR] ${table}:`, JSON.stringify(data.error));
    logToAxiom('error', 'airtable_create_error', { table, status: res.status, error: JSON.stringify(data.error) });
  } else {
    // Rule 30 step 1 (visibility only): mirrors sendWhatsAppTemplate's existing
    // success log exactly — this function already logged failure, never
    // success, so "did the write actually land" was only ever answerable from
    // the ABSENCE of an error event, indistinguishable from Axiom itself being
    // down (F32). This does not check-before-proceeding for any caller; it
    // only makes a fact visible that was previously only inferred.
    logToAxiom('info', 'airtable_create_success', { table, id: data.id || null });
  }
  return data;
}

async function airtableUpdate(table, recordId, fields) {
  console.log(`[Airtable UPDATE] ${table} ${recordId}`, JSON.stringify(fields));
  const res = await fetch(`https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(table)}/${recordId}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${AIRTABLE_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ fields })
  });
  console.log(`[Airtable UPDATE STATUS] ${table} | HTTP ${res.status}`);
  const data = await res.json();
  if (data.error) {
    console.error(`[Airtable UPDATE ERROR] ${table}:`, JSON.stringify(data.error));
    logToAxiom('error', 'airtable_update_error', { table, recordId, status: res.status, error: JSON.stringify(data.error) });
  } else {
    // Rule 30 step 1 — see airtableCreate's identical comment above.
    logToAxiom('info', 'airtable_update_success', { table, recordId });
  }
  return data;
}

// Rule 30 step 2, slice 2: shared wrapper for the ~23 structurally-identical
// WS_Guests Session State writes across the file, rather than 23 near-duplicate
// check-and-log blocks. NON-FATAL as a class: each write is paired with a
// sendWhatsApp reply describing the NEW state, so a failure here does create a
// guest/DB mismatch for one round-trip — but handleMessage's own dispatch
// entrypoint re-fetches WS_Guests fresh on every inbound message, so a failed
// state write self-corrects on the guest's next message rather than
// compounding. airtableUpdate already logs the generic 'airtable_update_error'
// (Rule 30 step 1) on any failure; this adds a correlated, guest/handler-scoped
// event on top, matching F44's precedent of a specific event per checked site
// rather than relying on the generic log alone to satisfy Rule 30's intent.
async function updateGuestState(guestId, fields, logContext = {}) {
  const result = await airtableUpdate('WS_Guests', guestId, fields);
  if (result && result.error) {
    logToAxiom('error', 'guest_state_write_failed', {
      guestId, fields, error: JSON.stringify(result.error), ...logContext
    });
  }
  return result;
}

// B9: the guest's half-built hourly booking — Check In recorded, duration not
// yet chosen, so Check Out is still blank. Blank Check Out is exactly what makes
// it inert to B8's overlap check while the guest is mid-conversation.
async function findPendingHourlyBooking(guestId) {
  const enquiries = await airtableGetBookingsByGuestId(guestId, 'Enquiry');
  return enquiries.find(b => b.fields['Booking Type'] === 'Hourly' && !b.fields['Check Out']) || null;
}

// F5: direct record ID lookup — replaces FIND/ARRAYJOIN pattern
async function airtableGetBookingsByGuestId(guestId, status) {
  // Airtable linked record filter via FIND/ARRAYJOIN is unreliable —
  // fetch all bookings with matching status, then filter by guest ID in JS
  const allBookings = await airtableGet('WS_Bookings', `{Status} = '${status}'`);
  return allBookings.filter(b => {
    const guests = b.fields['Guest'] || [];
    return guests.includes(guestId);
  });
}

// B10.5 Bug 2 — property scoping for cleaner dispatch.
//
// Scope is resolved from the booking's own `WS_Property` link (persisted at
// check-in), NOT from a Booking→Room→Property walk and not from request-scoped
// state, so the manual and auto checkout paths share one source of truth.
//
// Scoping is by property RECORD ID, never by name — names collide and change.
// Airtable's filterByFormula matches a linked-record field on its primary
// display value rather than the record id, so there is no id-safe formula here;
// the correct route is to fetch the active cleaners and filter on the link array
// in code. Same reasoning as airtableGetBookingsByGuestId above.
//
// Fails CLOSED: an unresolvable property dispatches nobody. The bug being fixed
// is dispatching to everybody, so a silent no-op is the safe direction of error.
function bookingPropertyId(booking, fallbackPropertyId) {
  const linked = booking && (booking.fields['WS_Property'] || [])[0];
  return linked || fallbackPropertyId || null;
}

// Rating flow: the guest's Session State carries no booking reference, so the
// booking a AWAITING_RATING/AWAITING_RATING_FEEDBACK reply belongs to is
// resolved the same way extendStay resolves "the active booking" — most
// recent by Check Out, but scoped to Checked Out + not yet rated, since a
// returning guest may have older, already-rated Checked Out bookings.
async function findBookingAwaitingRating(guestId) {
  const bookings = await airtableGetBookingsByGuestId(guestId, 'Checked Out');
  const unrated = bookings.filter(b => b.fields['Rating'] === undefined);
  unrated.sort((a, b) => Date.parse(b.fields['Check Out'] || 0) - Date.parse(a.fields['Check Out'] || 0));
  return unrated[0] || null;
}

// AWAITING_RATING_FEEDBACK counterpart: by this point Rating is already
// written on the booking the guest is replying about, so "unrated" no longer
// identifies it — "rated but no feedback yet" does.
async function findBookingAwaitingRatingFeedback(guestId) {
  const bookings = await airtableGetBookingsByGuestId(guestId, 'Checked Out');
  const unfed = bookings.filter(b => b.fields['Rating'] !== undefined && b.fields['Rating Feedback'] === undefined);
  unfed.sort((a, b) => Date.parse(b.fields['Check Out'] || 0) - Date.parse(a.fields['Check Out'] || 0));
  return unfed[0] || null;
}

async function activeCleanersForProperty(propertyId) {
  // F4: was {Active} = 1 — Airtable checkbox requires TRUE()
  const activeCleaners = await airtableGet('WS_Cleaners', `{Active} = TRUE()`);
  if (!propertyId) return [];
  return activeCleaners.filter(c => (c.fields['Assigned Property'] || []).includes(propertyId));
}

// Gate arrival → tell the property's cleaner someone has arrived. Before this,
// `gateArrival` told the guest "someone is on their way to open the gate" and
// notified only `Notify Phone` (the owner) — no member of staff on the ground was
// ever messaged, so the guest's promise was unbacked copy.
//
// Reuses the B10.5 Bug 2 scoping model unchanged: cleaners are filtered by the
// booking's own property, so a second property's cleaner is never notified.
// Deliberately notifies EVERY active cleaner assigned to this property, matching
// the checkout dispatch — picking one would require on-duty/shift resolution,
// which is explicitly deferred and NOT built here.
//
// Every exit path logs with `bookingId`, so "the cleaner was not notified for
// booking X" is answerable from Axiom rather than inferred from silence.
async function notifyCleanerOfArrival({ propertyId, bookingId, propertyName, guestName, roomName, guestPhone }) {
  const correlation = { site: 'gate_arrival', bookingId, propertyId, guestPhone };
  const cleaners = await activeCleanersForProperty(propertyId);

  if (cleaners.length === 0) {
    // Fails LOUD, not closed: unlike dispatch-to-everybody (Bug 2), notifying
    // nobody at the gate is itself the bug being fixed, so it must be visible.
    logToAxiom('warn', 'cleaner_gate_notify_no_cleaner', { ...correlation, reason: 'no active cleaner assigned to property' });
    await alertShawn('gate_arrival', 'no active cleaner assigned to property', {
      propertyId, propertyName, bookingId
    });
    return;
  }

  const templateName = cleanerGateTemplate();

  for (const cleaner of cleaners) {
    const rawPhone = cleaner.fields['Phone Number'];
    const cleanerName = cleaner.fields['Cleaner Name'] || 'there';
    const perCleaner = { ...correlation, cleanerId: cleaner.id, cleanerName };

    if (!rawPhone) {
      logToAxiom('warn', 'cleaner_gate_notify_no_phone', { ...perCleaner, reason: 'cleaner record has no Phone Number' });
      continue;
    }
    const to = formatPhone(rawPhone);
    // Order is fixed by the approved template's {{1}}..{{4}} — see PR body.
    const params = [cleanerName, guestName, roomName || 'an unassigned room', propertyName];

    if (!templateName) {
      // STUBBED until WABISTAY_CLEANER_GATE_TEMPLATE is approved and configured.
      // Deliberately NOT a free-form sendWhatsApp fallback: outside the 24h window
      // that 200s and vanishes, which is the invisible failure this fix exists to
      // end. Logging the exact payload keeps resolution verifiable before approval.
      logToAxiom('warn', 'cleaner_gate_notify_stubbed', {
        ...perCleaner, to, params,
        reason: 'WABISTAY_CLEANER_GATE_TEMPLATE not configured — template pending Meta approval'
      });
      continue;
    }

    const result = await sendWhatsAppTemplate(to, templateName, params, perCleaner);
    if (!result.ok) {
      logToAxiom('error', 'cleaner_gate_notify_failed', {
        ...perCleaner, to, template: templateName,
        error: JSON.stringify(result.error || null)
      });
    }
  }
}

// B8 (PAID): tell Reception what is owed, at the moment the guest checks out.
// Called from BOTH checkout paths — the manual one and the B12 cron — because
// walk-ins and hourly stays are normally closed by the cron, and a push wired
// only to the manual path would miss most of the money it exists to collect.
//
// `amountDue` is read off the booking at call time, so it already includes any
// extensions (F34 adds each extension's charge onto Amount Due in place).
async function notifyReceptionOfPayment({ propertyId, bookingId, bookingRef, roomName, guestName, amountDue, source }) {
  const correlation = { site: 'checkout_payment', source, bookingId, bookingRef, propertyId, amountDue };
  const seats = await activeReceptionRolesForProperty(propertyId);

  if (seats.length === 0) {
    // Fails LOUD, like the cleaner gate: nobody being told what to collect is
    // itself the failure this push exists to prevent, so it must be visible
    // rather than quietly skipped.
    logToAxiom('warn', 'reception_payment_notify_no_seat', {
      ...correlation, reason: 'no active Reception seat for property'
    });
    return;
  }

  const templateName = receptionPaymentTemplate();

  for (const seat of seats) {
    const to = formatPhone(String(seat.fields['Current Phone']));
    const perSeat = { ...correlation, roleId: seat.id, roleLabel: seat.fields['Role Label'] || null };
    // Positional and load-bearing once the template is approved — the order is
    // documented in docs/env.md alongside the variable.
    const params = [roomName || 'a room', guestName || 'the guest', formatAmount(amountDue), bookingRef || ''];

    if (!templateName) {
      // STUBBED until WABISTAY_RECEPTION_PAYMENT_TEMPLATE is approved and set.
      // Never downgraded to free-form: Reception has not messaged us, so a
      // free-form send outside the 24h window 200s and vanishes.
      logToAxiom('warn', 'reception_payment_notify_stubbed', {
        ...perSeat, to, params,
        reason: 'WABISTAY_RECEPTION_PAYMENT_TEMPLATE not configured — template pending Meta approval'
      });
      continue;
    }

    const result = await sendWhatsAppTemplate(to, templateName, params, perSeat);
    if (!result.ok) {
      logToAxiom('error', 'reception_payment_notify_failed', {
        ...perSeat, to, template: templateName, error: JSON.stringify(result.error || null)
      });
    }
    // Success is already logged by sendWhatsAppTemplate as `whatsapp_template_sent`
    // carrying the wamid — the join key to B3's status callbacks. Not duplicated
    // here, matching notifyCleanerOfArrival.
  }
}

// Rands, two decimals, no currency symbol — the symbol belongs to the template
// copy, not the parameter, so it cannot end up doubled ("RR400.00").
function formatAmount(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n.toFixed(2) : '0.00';
}

// ─── WHATSAPP HELPER ────────────────────────────────────────────────────────

async function sendWhatsApp(to, message) {
  console.log(`[WhatsApp SEND] to: ${to} | msg: ${message.slice(0, 80)}...`);
  // F3: was v19.0 — now v25.0 to match webhook subscription version
  const res = await fetch(`https://graph.facebook.com/v25.0/${WA_PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${WA_ACCESS_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { body: message }
    })
  });
  console.log(`[WhatsApp SEND STATUS] HTTP ${res.status}`);
  const data = await res.json();
  if (data.error) {
    console.error(`[WhatsApp SEND ERROR]:`, JSON.stringify(data.error));
    logToAxiom('error', 'whatsapp_send_error', { to, status: res.status, error: JSON.stringify(data.error) });
  } else {
    // Rule 30 step 1: mirrors sendWhatsAppTemplate's whatsapp_template_sent
    // exactly, same wamid — the join key to B3's whatsapp_status_callback
    // events. Meta can return HTTP 200 with an error BODY (e.g. 131047), which
    // is exactly the case the `if (data.error)` branch above already catches;
    // this only makes the OTHER case — genuine acceptance — equally visible,
    // where before it was pure absence of a log line.
    const wamid = (data && data.messages && data.messages[0] && data.messages[0].id) || null;
    logToAxiom('info', 'whatsapp_sent', { to, wamid });
  }
  return data;
}

// ─── WHATSAPP TEMPLATE HELPER ───────────────────────────────────────────────
// Business-initiated sends (cleaner dispatch, gate arrival, owner summary) go to
// a third party who has not messaged us, so they are outside Meta's 24-hour
// customer-service window. Free-form text there is rejected (131047) — CLAUDE.md
// line 30 — so those sends must be approved utility templates. This is the
// shared surface for all three; it is deliberately NOT gate-specific.
//
// Returns { ok, wamid, error } rather than the raw body so callers can correlate
// a failure back to the booking it belongs to. `meta` is merged into every Axiom
// event, which is how "the cleaner was NOT notified for booking X" becomes a
// queryable fact instead of a generic send error.
//
// The success log carries the wamid, which is the join key to B3's
// `whatsapp_status_callback` events (they log `wamid` too) — so a template that
// Meta accepts but never delivers is still traceable to its booking.
async function sendWhatsAppTemplate(to, templateName, params = [], meta = {}) {
  const { languageCode = TEMPLATE_LANGUAGE_CODE, ...correlation } = meta;
  console.log(`[WhatsApp TEMPLATE SEND] to: ${to} | template: ${templateName} | params: ${JSON.stringify(params)}`);

  const components = params.length > 0
    ? [{ type: 'body', parameters: params.map(p => ({ type: 'text', text: String(p) })) }]
    : [];

  const res = await fetch(`https://graph.facebook.com/v25.0/${WA_PHONE_NUMBER_ID}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${WA_ACCESS_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'template',
      template: {
        name: templateName,
        language: { code: languageCode },
        components
      }
    })
  });
  console.log(`[WhatsApp TEMPLATE SEND STATUS] HTTP ${res.status}`);
  const data = await res.json();

  const wamid = (data && data.messages && data.messages[0] && data.messages[0].id) || null;
  const ok = !data.error && res.status < 300;

  if (!ok) {
    console.error(`[WhatsApp TEMPLATE SEND ERROR]:`, JSON.stringify(data.error));
    logToAxiom('error', 'whatsapp_template_send_error', {
      to, template: templateName, status: res.status,
      error: JSON.stringify(data.error || null),
      // 131047 is the re-engagement rejection — the specific failure this helper
      // exists to make visible. Surfaced as its own flag so it can be alerted on.
      reEngagementRejected: !!(data.error && data.error.code === 131047),
      ...correlation
    });
  } else {
    logToAxiom('info', 'whatsapp_template_sent', { to, template: templateName, wamid, ...correlation });
  }

  return { ok, wamid, error: (data && data.error) || null };
}

// ─── FORMAT PHONE ────────────────────────────────────────────────────────────

function formatPhone(raw) {
  let clean = raw.replace(/[\s\-\+]/g, '');
  if (clean.startsWith('0')) clean = '27' + clean.slice(1);
  return clean;
}

// ─── ALERT SHAWN (Airtable-backed) ──────────────────────────────────────────
// Ported from api/wabiprop/_lib/cronHelpers.js:100-105. Unlike that copy, which
// hardcodes the destination number, this one reads it from WS_Config (single
// row, "Alert Phone" field) so the number can be changed without a redeploy.
// Free-form sendWhatsApp, not a template — same choice the Wabiprop original
// makes; the ops number is expected to already be inside the 24h session
// window from prior bot interaction, so this carries no new re-engagement
// risk beyond what alertShawn already has there.

let _alertPhoneCache = { value: null, fetchedAt: 0 };
// 5 min: long enough that a burst of failures in one run doesn't hammer
// Airtable once per failure, short enough that changing the number in
// Airtable takes effect within roughly one cron cycle rather than hours.
const ALERT_PHONE_CACHE_TTL_MS = 5 * 60 * 1000;

async function getAlertPhone() {
  const now = Date.now();
  if (_alertPhoneCache.value && (now - _alertPhoneCache.fetchedAt) < ALERT_PHONE_CACHE_TTL_MS) {
    return _alertPhoneCache.value;
  }
  try {
    // WS_Config is meant to be a single-row table by convention, but the
    // live base has been observed with extra blank rows (e.g. created via
    // Airtable's own "+" row button) — rows[0] is Airtable's return order,
    // NOT a guarantee the populated row comes first. Find the first row
    // that actually HAS a value instead of blindly trusting index 0, so a
    // reordered or newly-added blank row can't silently break alerting.
    const rows = await airtableGet('WS_Config', '');
    const populated = rows.find(r => r.fields['Alert Phone']);
    if (rows.length > 1) {
      logToAxiom('warn', 'alert_phone_multiple_rows', { rowCount: rows.length, usedRowId: populated ? populated.id : null });
    }
    const phone = populated && populated.fields['Alert Phone'];
    if (!phone) throw new Error('WS_Config has no row with an Alert Phone value');
    _alertPhoneCache = { value: String(phone), fetchedAt: now };
    return _alertPhoneCache.value;
  } catch (err) {
    // Airtable outage or a missing/misconfigured WS_Config row must not leave
    // zero alerting — fall back to the env var, but log every time this
    // happens so silent reliance on the fallback stays visible in Axiom
    // rather than persisting unnoticed for weeks.
    logToAxiom('warn', 'alert_phone_fallback_used', { reason: err.message });
    const fallback = process.env.ALERT_PHONE_FALLBACK;
    if (!fallback) {
      logToAxiom('error', 'alert_phone_unavailable', { reason: 'no WS_Config row and no ALERT_PHONE_FALLBACK set' });
    }
    return fallback || null;
  }
}

async function alertShawn(cronName, errorMessage, context = {}) {
  const to = await getAlertPhone();
  if (!to) {
    logToAxiom('error', 'alert_shawn_no_destination', { cronName, errorMessage });
    return;
  }
  const extra = Object.keys(context).length ? `\n${JSON.stringify(context)}` : '';
  const msg = `WABISTAY CRON ERROR — ${cronName} failed.\nError: ${errorMessage}${extra}`;
  await sendWhatsApp(to, msg).catch(e => console.error('[alertShawn failed]', e.message));
}

// ─── SAST DATES (B7) ─────────────────────────────────────────────────────────
// South Africa Standard Time is UTC+2 all year — the country has never observed
// DST — so the offset is a constant, not a timezone lookup. Every relative date
// ("today", "tomorrow") resolves against the SAST calendar; UTC appears only at
// the Airtable write boundary (sastToUtcIso). Vercel runs UTC, so a bare
// new Date() day-boundary is wrong between 00:00 and 01:59 SAST, when the UTC
// date is still the previous day — that window is what these helpers exist for.

const SAST_OFFSET_MS = 2 * 60 * 60 * 1000;

// CEO-confirmed overnight defaults (16 July). Per-property overrides are a
// later step's problem — do not derive these from the property record yet.
const OVERNIGHT_CHECKIN_HOUR = 14;
const OVERNIGHT_CHECKOUT_HOUR = 10;

// B12 (auto-checkout): once a booking is past its Check Out, the cron sends one
// warning offering an extension; if still unresolved AUTO_CHECKOUT_GRACE_MS
// after that warning, auto-checkout fires. Comparisons are on absolute instants
// (Check Out is already stored as the UTC instant of the SAST checkout time via
// sastToUtcIso), so no further SAST conversion is needed here — the arithmetic
// is pure milliseconds, which is what the mutation test targets.
const AUTO_CHECKOUT_GRACE_MS = 15 * 60 * 1000; // 15-minute warning window

// B12: an EXTEND reply pushes Check Out out (uncapped, repeatable). Increment is
// per booking type. FLAG (genuinely undefined in the brief): these exact
// durations are a CEO pricing/ops decision — built as a sensible default (one
// more hour for a short stay, one more night for an overnight) and called out in
// the PR for confirmation.
const EXTENSION_MS = {
  Hourly: 60 * 60 * 1000,        // +1 hour
  Overnight: 24 * 60 * 60 * 1000 // +1 day
};

// What one extension is WORTH. B12 shipped the time extension without the money:
// `extendStay` pushed `Check Out` out and wrote nothing financial, so every
// extension since has been free, and B17's revenue total (which sums
// `Amount Due`) has understated every extended booking. This resolves the price
// of exactly one extension — the same unit `EXTENSION_MS` moves the clock by —
// and the caller ADDS it to whatever `Amount Due` already holds.
//
// The two paths mirror how each booking type was priced at creation, so an
// extension costs what the stay costs:
//   · Overnight — the booking's own `Rate Applied` link (F19's occupancy-keyed
//     rate). Read from the booking, not re-derived from the guest's occupancy
//     answer, so a rate row edited mid-stay cannot silently reprice history.
//   · Hourly (and Walk-in, which IS Booking Type 'Hourly') — the property's
//     1-hour rate, since the extension unit is one hour.
//
// Returns null when the price cannot be established, and the caller then leaves
// `Amount Due` ALONE rather than guessing. Never invent a number: a wrong figure
// on a bill the guest pays at the desk is worse than a missing one, and the
// same fail-closed posture already governs F19 and `hourlyRates`.
async function extensionCharge(booking, property) {
  // Unknown/blank Booking Type falls to Overnight here for exactly the reason it
  // does in EXTENSION_MS above — the two must agree, or a booking would be given
  // a day of time at an hour's price.
  const type = booking.fields['Booking Type'] === 'Hourly' ? 'Hourly' : 'Overnight';

  if (type === 'Hourly') {
    // HOURLY_RATE_FIELDS[1] rather than a typed field name — same constant the
    // booking flow prices from, so the two cannot drift apart.
    const raw = property && property.fields[HOURLY_RATE_FIELDS[1]];
    const amount = Number(raw);
    if (raw === undefined || raw === null || raw === '' || !Number.isFinite(amount) || amount <= 0) return null;
    return amount;
  }

  const rateId = (booking.fields['Rate Applied'] || [])[0];
  if (!rateId) return null; // e.g. F19's fail-closed path: booked, never priced
  const rates = await airtableGet('WS_Rates', `RECORD_ID() = '${rateId}'`);
  const amount = Number(rates[0] && rates[0].fields['Amount']);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  return amount;
}

// B14 (STOP opt-out). Keywords are matched against the already-lowercased inbound
// text, so STOP / Stop / stop all match — case-insensitive by construction.
const STOP_KEYWORDS = ['stop'];
const START_KEYWORDS = ['start'];
// "Already-active booking" for the two-tier rule: a real commitment, not a
// browsing enquiry. Transaction-completion messages are allowed to an opted-out
// guest only while their booking is in one of these states.
const ACTIVE_BOOKING_STATES = ['CONFIRMED', 'CHECKED_IN'];

const MONTHS = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9,
  september: 9, oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12
};

const RELATIVE_DATE_WORDS = ['today', 'tomorrow'];

// The SAST wall-clock date at a given UTC instant.
function sastCalendarDate(nowUtc) {
  const shifted = new Date(nowUtc.getTime() + SAST_OFFSET_MS);
  return { y: shifted.getUTCFullYear(), m: shifted.getUTCMonth() + 1, d: shifted.getUTCDate() };
}

// The one and only UTC conversion — a SAST calendar date + SAST time → the ISO
// string Airtable stores. Nothing else in this file may build a booking datetime.
// B9 added the minute argument for hourly arrival times ("2:30pm"); overnight
// callers omit it and get :00, exactly as before.
function sastToUtcIso(date, sastHour, sastMinute = 0) {
  return new Date(Date.UTC(date.y, date.m - 1, date.d, sastHour, sastMinute) - SAST_OFFSET_MS).toISOString();
}

function addSastDays(date, days) {
  const shifted = new Date(Date.UTC(date.y, date.m - 1, date.d + days));
  return { y: shifted.getUTCFullYear(), m: shifted.getUTCMonth() + 1, d: shifted.getUTCDate() };
}

function compareYmd(a, b) {
  return (a.y - b.y) || (a.m - b.m) || (a.d - b.d);
}

// Rejects 31 June, 29 Feb in a non-leap year, etc. — Date.UTC silently rolls
// those forward, so round-trip the components and check they survived.
function isValidCalendarDate(y, m, d) {
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

// Guests book the future, so a bare day+month that has already passed this year
// means next year (CEO-confirmed 16 July). Only this year and next are
// considered: "29 February" in a two-non-leap-year window returns null and
// re-prompts rather than silently landing three years out.
function resolveYear(month, day, today) {
  for (const year of [today.y, today.y + 1]) {
    if (!isValidCalendarDate(year, month, day)) continue;
    if (compareYmd({ y: year, m: month, d: day }, today) >= 0) return year;
  }
  return null;
}

function buildFromMonthName(day, monthWord, explicitYear, today) {
  const month = MONTHS[monthWord];
  if (month === undefined) return null;
  if (explicitYear) {
    const y = Number(explicitYear);
    return isValidCalendarDate(y, month, day) ? { y, m: month, d: day } : null;
  }
  const y = resolveYear(month, day, today);
  return y === null ? null : { y, m: month, d: day };
}

function normalizeDateText(text) {
  return String(text || '')
    .trim()
    .toLowerCase()
    .replace(/,/g, ' ')
    .replace(/(\d)(st|nd|rd|th)\b/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

// Free text → a SAST calendar date, or null if it isn't one. `nowUtc` is passed
// in rather than read from the clock so the near-midnight cases are testable.
// Returns calendar parts only: the time-of-day default is the caller's choice,
// because it differs per booking type (overnight 14:00/10:00 today; hourly later).
function parseBookingDate(text, nowUtc) {
  const t = normalizeDateText(text);
  if (!t) return null;

  const today = sastCalendarDate(nowUtc);
  if (t === 'today') return today;
  if (t === 'tomorrow') return addSastDays(today, 1);

  let m;
  // "25 june", "25jun", "25 jun 2027"
  if ((m = t.match(/^(\d{1,2}) ?([a-z]+)\.?(?: (\d{4}))?$/))) {
    return buildFromMonthName(Number(m[1]), m[2], m[3], today);
  }
  // "june 25", "jun 25 2027"
  if ((m = t.match(/^([a-z]+)\.? ?(\d{1,2})(?: (\d{4}))?$/))) {
    return buildFromMonthName(Number(m[2]), m[1], m[3], today);
  }
  // "25/06", "25-6", "25/06/2027", "25/06/27" — day-first (SA convention, and
  // what the pre-B7 detection regex already assumed). Never MM/DD.
  if ((m = t.match(/^(\d{1,2})[\/\-](\d{1,2})(?:[\/\-](\d{2}|\d{4}))?$/))) {
    const day = Number(m[1]);
    const month = Number(m[2]);
    if (m[3]) {
      const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
      return isValidCalendarDate(y, month, day) ? { y, m: month, d: day } : null;
    }
    const y = resolveYear(month, day, today);
    return y === null ? null : { y, m: month, d: day };
  }
  return null;
}

// ─── DATE-TOKEN DETECTION (F20 — parser robustness) ──────────────────────────
// Locates date-shaped SPANS in free text, so collectDetails can accept a name
// plus two dates all on ONE line — a real prospect (Caillin) sent exactly
// "Caillin Mendes 31July 2026 1 August 2026" and the old three-separate-lines
// parser re-prompted three times until he abandoned the booking — as well as
// the existing newline-separated form. It also closes the month-substring trap:
// the old classifier used loose `line.includes('may'|'aug'|'jun'…)`, so a NAME
// containing a month fragment ("May Ndlovu", "Augustine", "Julian") was read as
// a date. This matches genuine date shapes (day+month, month+day, numeric
// day-first, today/tomorrow) instead of any substring.
//
// This only LOCATES candidates. parseBookingDate remains the gate that validates
// them downstream, so an over-eager match here re-prompts rather than booking a
// non-date. Longest month name wins (sorted by length) so "June" is not clipped
// to "Jun" — the raw token feeds Notes and guest copy, which must stay verbatim.
const MONTH_NAMES_BY_LEN = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join('|');
const DATE_TOKEN_SOURCE =
  '\\d{1,2}\\s*(?:' + MONTH_NAMES_BY_LEN + ')\\.?(?:\\s+\\d{4})?' +     // 31July 2026, 25 June, 1 August 2026
  '|(?:' + MONTH_NAMES_BY_LEN + ')\\.?\\s*\\d{1,2}(?:\\s+\\d{4})?' +    // June 25, Aug 3 2026
  '|\\d{1,2}[\\/\\-]\\d{1,2}(?:[\\/\\-]\\d{2,4})?' +                    // 25/06, 25-6-2027
  '|today|tomorrow';

function findDateTokens(text) {
  const re = new RegExp(DATE_TOKEN_SOURCE, 'gi');
  const out = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m[0].trim()) out.push({ text: m[0].trim(), start: m.index, end: m.index + m[0].length });
  }
  return out;
}

// ─── AXIOM LOGGER ────────────────────────────────────────────────────────────
// F12: fire-and-forget log to Axiom HTTP API
// Never awaited in critical path — cannot block or break the state machine
// Dataset: wabistay · Token via AXIOM_TOKEN env var
// This was always the correct name — it is the only dataset that exists in the
// org, which is why Wabistay logging worked while the router's silently did not.
const AXIOM_DATASET = 'wabistay';

function logToAxiom(level, event, detail = {}) {
  if (!AXIOM_TOKEN) return;
  const payload = [{
    _time: new Date().toISOString(),
    level,
    event,
    source: 'wabistay',
    ...detail
  }];
  fetch(`https://api.axiom.co/v1/datasets/${AXIOM_DATASET}/ingest`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${AXIOM_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  })
    // fetch resolves on 4xx/5xx — surface it or it is invisible. See api/webhook.js.
    .then(res => {
      if (!res.ok) console.error(`[Axiom ERROR] ingest rejected: HTTP ${res.status} dataset=${AXIOM_DATASET} event=${event}`);
    })
    .catch(err => console.error('[Axiom ERROR]', err.message));
}

// B17: instrument the three existing owner/notify sends. Business-initiated
// free-form text silently fails (HTTP 200, nothing logged) outside the 24-hour
// customer-service window (CLAUDE.md). We cannot see Meta's window directly, but
// the reliable proxy is: is the recipient the phone that just messaged us? If so
// it is inside the window by definition; if it is a third party (owner / notify
// phone), it is almost certainly OUTSIDE it. Logging this at each site makes the
// scale of the existing exposure measurable without changing any behaviour.
function logOwnerSendWindow(site, recipient, inboundPhone) {
  const inside = recipient === inboundPhone;
  logToAxiom('info', 'owner_send_window_check', {
    site, recipient, inboundPhone,
    recipientIsInboundSender: inside,
    likelyInside24hWindow: inside
  });
}

// ─── MESSAGE RENDERING ───────────────────────────────────────────────────────
// All copy lives in states.json → messages. {placeholder} substitution only.

function msg(key, vars = {}) {
  let out = STATES.messages[key];
  if (out === undefined) throw new Error(`states.json missing message: ${key}`);
  for (const [k, v] of Object.entries(vars)) {
    out = out.split(`{${k}}`).join(String(v));
  }
  return out;
}

// ─── PROPERTY RESOLUTION ─────────────────────────────────────────────────────
// 6.4: resolve which WS_Properties record this message belongs to, from the
// receiving phone_number_id. Called once per incoming message, before dispatch.
// filterByFormula on a plain singleLineText field ({Phone Number ID} = '...')
// — standard equality match, not a linked-record lookup, so no FIND/ARRAYJOIN needed here.

async function resolveProperty(phoneNumberId) {
  const properties = await airtableGet('WS_Properties', `{Phone Number ID} = '${phoneNumberId}'`);
  if (properties.length === 0) {
    logToAxiom('error', 'property_resolution_failed', { phone_number_id: phoneNumberId });
    return null;
  }
  return properties[0];
}

// ─── PROPERTY ACTIVITY TRACKER ──────────────────────────────────────────────
// Three WS_Properties timestamp fields, populated best-effort so a write
// failure here never blocks the guest/owner-facing flow it's attached to:
//   · Last Message Received — any inbound webhook message resolved to this
//     property (set in handleMessage, right after resolveProperty).
//   · Last Report Sent — deliberately NOT a WS_Properties write. runOwnerSummary/
//     runDailySummary are a documented, tested read-only invariant (Rule 29,
//     test/dailysummary.test.js: "both crons are read-only reporting — zero
//     writes from either"), so this is surfaced instead from the existing
//     owner_summary_payload / daily_summary_payload Axiom events, which
//     already carry propertyId and a timestamp per run — no new write, no
//     invariant break, satisfies "surface from existing cron logs" literally.
//   · Last Owner App Open — NOT a real Meta webhook event. Meta's Cloud API
//     has no "user opened WhatsApp" callback; account_offboarded/
//     account_reconnected (the events the original ask named) are
//     Coexistence WABA-connection events, not per-owner app-open signals, and
//     this codebase doesn't subscribe to them. The best available proxy is a
//     `read` delivery-status callback on a message sent to that owner's
//     Notify Phone — you cannot mark a WhatsApp message read without having
//     opened the app around that time. This only advances when Meta sends us
//     something to read a status on, so it under-reports app opens with no
//     Wabistay message in flight — flagged, not silently presented as ground
//     truth.
async function bumpPropertyActivity(propertyId, field) {
  if (!propertyId) return;
  try {
    const result = await airtableUpdate('WS_Properties', propertyId, { [field]: new Date().toISOString() });
    if (result && result.error) {
      logToAxiom('warn', 'property_activity_write_failed', { propertyId, field, error: JSON.stringify(result.error) });
    }
  } catch (err) {
    logToAxiom('warn', 'property_activity_write_failed', { propertyId, field, error: err.message });
  }
}

function propertyCityLine(property) {
  const city = property.fields['City'];
  return city ? `, ${city}` : '';
}

// F19 (Rate-fix): the occupancy step confirms the booking a turn after
// collectDetails created it, so it no longer has the guest's raw date strings in
// hand. They are recovered from the Notes line collectDetails wrote
// ("Check-in: X | Check-out: Y") so bookingReceived still shows the dates in the
// guest's own words ("25 June"), unchanged, rather than the reformatted datetime.
function checkDatesFromNotes(notes) {
  const s = String(notes || '');
  const inM = s.match(/Check-in:\s*(.+?)(?:\s*\|\s*Check-out:|$)/);
  const outM = s.match(/Check-out:\s*(.+?)\s*$/);
  return { checkIn: inM ? inM[1].trim() : '', checkOut: outM ? outM[1].trim() : '' };
}

// ─── HOURLY / SHORT STAY (B9) ────────────────────────────────────────────────
// Hourly bookings write real start/end datetimes into the same Check In/Check Out
// fields as overnight, so B8's findAvailableRoom blocks hourly-vs-hourly and
// hourly-vs-overnight with no extra logic. There is deliberately no second date
// system — the only difference from overnight is the hour granularity and the
// fact that check-out is computed from a duration rather than parsed.
//
// Rates come from three per-property currency fields (names verified against
// live Airtable metadata, per Rule 1 — never typed from memory).

const HOURLY_DURATIONS = [1, 2, 3];
const HOURLY_RATE_FIELDS = {
  1: 'Hourly Rate 1hr',
  2: 'Hourly Rate 2hr',
  3: 'Hourly Rate 3hr'
};

// Fail closed: a property with any hourly rate blank or zero has not configured
// short stays, and must never quote R0 or fall through to a free booking. The
// whole feature is switched off for that property and the guest is routed to the
// overnight flow instead — the same redirect the >3hr case uses.
function hourlyRates(property) {
  const rates = {};
  for (const hours of HOURLY_DURATIONS) {
    const raw = property.fields[HOURLY_RATE_FIELDS[hours]];
    const amount = Number(raw);
    if (raw === undefined || raw === null || raw === '' || !Number.isFinite(amount) || amount <= 0) return null;
    rates[hours] = amount;
  }
  return rates;
}

// Bare hours 1–11 are genuinely ambiguous ("9" could be morning or night) and
// guessing wrong puts the booking twelve hours from where the guest meant —
// wrong window held, wrong room blocked, guest arrives to nothing. One extra
// question is cheaper than that, so ambiguity re-prompts instead of assuming.
// Returns { hour, minute } in SAST, { ambiguous: n }, or null.
function parseArrivalTime(text) {
  const t = String(text || '')
    .trim().toLowerCase()
    .replace(/^(from|at|around|about|approx\.?|approximately|after|before|roughly)\s+/g, '')
    .replace(/\s+/g, '');
  if (!t) return null;

  const m = t.match(/^(\d{1,2})(?::|h|\.)?(\d{2})?(am|pm)?$/);
  if (!m) return null;
  let hour = Number(m[1]);
  const minute = m[2] === undefined ? 0 : Number(m[2]);
  const meridiem = m[3];
  if (minute > 59) return null;

  if (meridiem) {
    if (hour < 1 || hour > 12) return null;
    if (meridiem === 'pm' && hour !== 12) hour += 12;
    if (meridiem === 'am' && hour === 12) hour = 0;
    return { hour, minute };
  }
  if (hour > 23) return null;
  // 0 and 12–23 can only be 24-hour clock; 1–11 could be either.
  if (hour >= 1 && hour <= 11) return { ambiguous: hour };
  return { hour, minute };
}

// The load-bearing duration arithmetic: get this wrong and every hourly overlap
// check silently examines the wrong window. Kept as one tiny function so it can
// be mutation-tested directly.
function addHoursToIso(iso, hours) {
  return new Date(Date.parse(iso) + hours * 60 * 60 * 1000).toISOString();
}

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Renders a stored UTC instant back in SAST for guest-facing copy. Times are
// always shown with their date: an hourly booking that rolled to tomorrow must
// not read as if it were today.
function formatSastDateTime(iso) {
  const d = new Date(Date.parse(iso) + SAST_OFFSET_MS);
  const h24 = d.getUTCHours();
  const meridiem = h24 < 12 ? 'am' : 'pm';
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  const time = `${h12}:${String(d.getUTCMinutes()).padStart(2, '0')}${meridiem}`;
  return `${d.getUTCDate()} ${MONTH_ABBR[d.getUTCMonth()]} at ${time}`;
}

function durationText(hours) {
  return hours === 1 ? '1 hour' : `${hours} hours`;
}

// ─── WALK-IN COMMAND PARSER (B7) ─────────────────────────────────────────────
// `WALKIN ROOM <n> <h>HRS` — staff-initiated, no guest thread. This function is
// PURE: it reads the message and nothing else. Room resolution, authorisation
// and every Airtable write live in the handler, so the grammar can be tested
// exhaustively without a base.
//
// Deliberately strict, for three reasons that are all live-data hazards:
//
//  1. The ROOM keyword is REQUIRED. Villa Liza's rooms are numbered 1–12, so
//     `WALKIN 12 2` is two bare numbers with no way to tell which is the room.
//     The keyword is the only thing that disambiguates them.
//  2. The hour UNIT is REQUIRED (`2hrs`, not `2`). Same reason from the other
//     side: with the unit, `WALKIN ROOM 12 2HRS` is unambiguous even though both
//     tokens are numbers and both are valid room numbers.
//  3. Matching is anchored and exact — NOT `roomMatchesText`. That helper tests
//     `\b<number>\b` anywhere in the message, so it would match Room 02 on the
//     DURATION digit of `WALKIN ROOM 12 2HRS` and send staff to the wrong room.
//     It is correct where it is used (a cleaner naming a room in free text) and
//     wrong here; this parser is the reason it stays untouched.
//
// Three return shapes, and the distinction between the first two is what makes
// the no-leak rule work:
//   · null                          — not a WALKIN attempt at all. The guard
//                                     declines and the message falls through to
//                                     the ordinary guest flow, so an outsider
//                                     who types this sees exactly what any
//                                     stranger sees. Nothing confirms the
//                                     command exists.
//   · { ok: false, reason }         — a WALKIN attempt that is malformed. Only
//                                     an AUTHORISED sender ever sees the usage
//                                     help; for anyone else the handler is never
//                                     reached, so this shape still leaks nothing.
//   · { ok: true, roomToken, hours }— parsed. `roomToken` is the raw token
//                                     ('2', '02', 'a') for the resolver to match
//                                     against Room Number / Room Name; the
//                                     parser does not know what rooms exist.
const WALKIN_KEYWORD = /^walk\s*-?\s*in\b/i;
// `room2` (no space) and `room 02` (zero-padded, as every live Room Name is)
// both parse; the token is handed on verbatim rather than coerced to a number,
// because `Room A` exists in the fixtures and a number would lose it. Everything
// after the duration is guest identity — see splitWalkinIdentity.
const WALKIN_BODY = /^room\s*([a-z0-9]{1,4})\s+(\d{1,2})\s*(?:hrs|hr|hours|hour|h)\b\.?\s*(.*)$/i;
// A trailing SA phone number, in any of the shapes staff actually type. Anchored
// to the END so it can never eat a digit out of the middle of a name.
const WALKIN_PHONE = /(?:^|\s)(\+?\d[\d\s-]{7,15})\s*$/;

// The message is matched case-INSENSITIVELY but never lowercased, because the
// guest's name is carried through verbatim: "John Smith" must reach Airtable as
// the guest typed it, not as "john smith".
function splitWalkinIdentity(rest) {
  const trimmed = String(rest || '').trim();
  if (!trimmed) return { guestName: null, guestPhone: null };

  const pm = trimmed.match(WALKIN_PHONE);
  if (pm) {
    const digits = pm[1].replace(/[\s\-+]/g, '');
    // Validated as a real SA number before it is treated as one. A name ending
    // in a stray digit ("Room 5 guest 2") fails this and stays part of the name,
    // rather than becoming a phone number nobody can call.
    if (/^(?:27\d{9}|0\d{9})$/.test(digits)) {
      const name = trimmed.slice(0, pm.index).trim();
      return { guestName: name || null, guestPhone: formatPhone(pm[1]) };
    }
  }
  return { guestName: trimmed, guestPhone: null };
}

function parseWalkinCommand(text) {
  const t = String(text || '').trim().replace(/\s+/g, ' ');
  if (!WALKIN_KEYWORD.test(t)) return null;

  const body = t.replace(WALKIN_KEYWORD, '').trim();
  const m = body.match(WALKIN_BODY);
  if (!m) return { ok: false, reason: 'bad_syntax' };

  const hours = Number(m[2]);
  // Duration is locked to the hourly rate card (CEO, 6 Aug): 1/2/3 only. A
  // fourth duration has no price — the overnight rate is occupancy-keyed and a
  // walk-in has no guest to ask — so it is refused rather than guessed. Reusing
  // HOURLY_DURATIONS means the command and the rate card can never drift apart.
  if (!HOURLY_DURATIONS.includes(hours)) return { ok: false, reason: 'bad_duration', hours };

  // Name absent is NOT a parse error: the grammar's job is to report what the
  // message contained. The handler owns the policy that a name is required, and
  // answers a nameless command with the usage line — which is the closest a
  // stateless serverless handler can get to "prompt for the guest name" without
  // a place to park the half-finished command. See the PR.
  const { guestName, guestPhone } = splitWalkinIdentity(m[3]);
  return { ok: true, roomToken: m[1], hours, guestName, guestPhone };
}

// ─── PAID COMMAND PARSER (B8) ────────────────────────────────────────────────
// `PAID ROOM <n> <amount> [method]` — reception recording cash taken at the
// desk. Pure, like parseWalkinCommand, and strict for the same live-data reason:
// rooms are numbered 1–12, so the ROOM keyword is what separates the room from
// the amount. `PAID 2 500` has two readings and is refused rather than guessed.
//
// Return shapes match the walk-in parser exactly, and the null / {ok:false}
// split carries the same meaning: `null` is "not a PAID attempt" and falls
// through to the ordinary guest flow, so an unauthorised sender learns nothing.
//
// Stage 1 (payment reconciliation): `COLLECTED` is accepted as an alias for
// the identical keyword, not a second command. Deliberately just widening
// the keyword regex rather than adding a parallel parser/dispatch/handler —
// COLLECTED and PAID produce byte-identical `{ok, roomToken, amount, method}`
// shapes and flow through senderIsAuthorizedPaid -> paidBooking exactly the
// same way, so the mismatch-refusal rule, idempotency guard, and every write
// (Amount Paid, Payment Status) cannot diverge between the two spellings by
// construction — there is only one code path to diverge from.
const PAID_KEYWORD = /^(?:paid|collected)\b/i;
// `R500`, `500`, `500.00` and `500,00` all parse. The optional trailing method
// is NOT in the locked grammar — see the PR — but a reception that types CASH
// should not be refused for being more specific than required.
const PAID_BODY = /^room\s*([a-z0-9]{1,4})\s+r?\s*(\d+(?:[.,]\d{1,2})?)\s*(cash|eft|card)?\.?$/i;
const PAID_METHODS = { cash: 'Cash', eft: 'EFT', card: 'Card' };

function parsePaidCommand(text) {
  const t = String(text || '').trim().replace(/\s+/g, ' ');
  if (!PAID_KEYWORD.test(t)) return null;

  const body = t.replace(PAID_KEYWORD, '').trim();
  const m = body.match(PAID_BODY);
  if (!m) return { ok: false, reason: 'bad_syntax' };

  // Comma as decimal separator is normal SA usage ("R500,00").
  const amount = Number(String(m[2]).replace(',', '.'));
  if (!Number.isFinite(amount) || amount <= 0) return { ok: false, reason: 'bad_amount' };

  const method = m[3] ? PAID_METHODS[m[3].toLowerCase()] : null;
  return { ok: true, roomToken: m[1], amount, method };
}

// ─── CLEANING TIME (START / DONE) ────────────────────────────────────────────
// Two metrics, both emitted at the DONE event:
//
//   · Vacant-To-Ready = completion − `WS_Rooms.Cleaning Started At`. The
//     industry turnaround number: checkout → room sellable again. The baseline
//     already existed (written at checkout by both checkout paths) and would
//     have gone dead the moment per-job fields arrived; this is what keeps it
//     load-bearing.
//   · Job Duration    = completion − `Cleaning Job Started At`. Actual working
//     speed once a cleaner engages. Secondary, and only available when the
//     cleaner sent START.
//
// The timestamps live on WS_BOOKINGS, not WS_Rooms (CEO): a room holds exactly
// one slot and the next checkout overwrites it, so per-cleaner averages over
// many jobs need a per-job home that survives.
//
// HONEST LIMIT, and it belongs next to the code rather than only in the PR:
// DONE is self-reported and unverified. Nothing confirms a room was actually
// cleaned, and dispatch is a broadcast to every active cleaner on the property,
// so whoever replies first is credited. These numbers therefore measure reply
// speed at least as much as cleaning speed.
const CLEANING_JOB_STARTED_FIELD = 'Cleaning Job Started At';
const CLEANING_COMPLETED_FIELD = 'Cleaning Completed At';
const CLEANED_BY_FIELD = 'Cleaned By';

// A baseline this old is almost certainly a room that sat dirty for days rather
// than a real turnaround. It is still emitted — the CEO is clearing the known
// stale rooms by hand before go-live — but flagged so the first averages can be
// filtered rather than quietly skewed.
const CLEANING_SUSPECT_MS = 24 * 60 * 60 * 1000;

// `START ROOM <n>` — one-shot, no session state (CEO). Same strict grammar as
// WALKIN/PAID: the ROOM keyword is mandatory because rooms are numbered 1–12.
const START_CLEANING_KEYWORD = /^start\b/i;
const START_CLEANING_BODY = /^room\s*([a-z0-9]{1,4})\.?$/i;

function parseStartCleaningCommand(text) {
  const t = String(text || '').trim().replace(/\s+/g, ' ');
  if (!START_CLEANING_KEYWORD.test(t)) return null;

  const body = t.replace(START_CLEANING_KEYWORD, '').trim();
  // A bare `START` is B14's opt-back-in keyword and must stay that way — only
  // `START ROOM <n>` is a cleaning command, so anything else returns null and
  // falls through to the existing handling rather than being claimed here.
  if (!body) return null;

  const m = body.match(START_CLEANING_BODY);
  if (!m) return { ok: false, reason: 'bad_syntax' };
  return { ok: true, roomToken: m[1] };
}

// The booking whose checkout dirtied this room: its most recent closed stay.
// Same resolution shape as PAID's, and for the same reason — the room's current
// clean belongs to the stay that just ended, not to whoever is in it next.
async function bookingForCleaningJob(roomId) {
  const closed = await airtableGet('WS_Bookings', `{Status} = 'Checked Out'`);
  const candidates = closed
    .filter(b => (b.fields['Room'] || []).includes(roomId))
    .sort((a, b) => Date.parse(b.fields['Check Out'] || 0) - Date.parse(a.fields['Check Out'] || 0));
  return candidates[0] || null;
}

// Both durations, computed at the completion event. Returns nulls rather than
// guesses: a missing or impossible baseline produces NO number, because a wrong
// turnaround figure is worse than an absent one (locked).
function cleaningDurations(room, booking, completedAtIso) {
  const completedMs = Date.parse(completedAtIso);
  const out = { vacantToReadyMs: null, jobDurationMs: null, baselineSuspect: false };

  const vacantFrom = room && room.fields['Cleaning Started At'];
  const vacantMs = vacantFrom ? Date.parse(vacantFrom) : NaN;
  // A baseline in the FUTURE relative to completion is a stale value from an
  // earlier cycle or a clock problem — either way it cannot describe this job.
  if (Number.isFinite(vacantMs) && vacantMs <= completedMs) {
    out.vacantToReadyMs = completedMs - vacantMs;
    out.baselineSuspect = out.vacantToReadyMs > CLEANING_SUSPECT_MS;
  }

  const jobFrom = booking && booking.fields[CLEANING_JOB_STARTED_FIELD];
  const jobMs = jobFrom ? Date.parse(jobFrom) : NaN;
  if (Number.isFinite(jobMs) && jobMs <= completedMs) {
    out.jobDurationMs = completedMs - jobMs;
  }
  return out;
}

// ─── WALK-IN AUTHORISATION (B7) ──────────────────────────────────────────────
// Authority is a SEAT, not a hardcoded number: `WS_Roles.Current Phone` where
// the seat is Active. Multiple numbers per property is the normal case (two
// reception handsets, owner plus manager), which is exactly what a global
// OWNER_PHONE-style variable cannot express. This is B18's schema, built as a
// strict subset — B18 adds WS_People and the Notify toggles on top without
// changing what this reads.
//
// Cleaners are deliberately NOT authorised: a cleaner seat exists to receive
// dispatch, not to sell rooms.
const WALKIN_ROLE_TYPES = ['Owner', 'Manager', 'Reception'];

// Matched in JS rather than filterByFormula, for two reasons confirmed against
// the live table: `Current Phone` is free text, so the same number can be stored
// as 0821234567 or 27821234567 and only formatPhone can tell they are the same;
// and the table currently contains blank rows, which a formula match would have
// to special-case anyway.
async function activeWalkinRoleForPhone(phone) {
  const roles = await airtableGet('WS_Roles', `{Active} = TRUE()`);
  return roles.find(r => {
    if (!WALKIN_ROLE_TYPES.includes(r.fields['Role Type'])) return false;
    const raw = r.fields['Current Phone'];
    if (!raw) return false;
    return formatPhone(String(raw)) === phone;
  }) || null;
}

// Unfiltered sibling, used ONLY by senderIsAuthorizedWalkin's logging — deliberately
// NOT a replacement for activeWalkinRoleForPhone, which stays untouched because it
// also gates the STOP staff-check and the POPIA staff-check (rule 26: no refactor
// while adding a feature; those two call sites are out of scope for this fix).
// Fetches by role type + phone WITHOUT the {Active}=TRUE() filter, so a
// deactivated seat is still found — the caller decides what "found but inactive"
// means, rather than the query silently discarding the distinction.
async function walkinRoleRecordForPhone(phone) {
  const roles = await airtableGet('WS_Roles', orFormula('Role Type', WALKIN_ROLE_TYPES));
  return roles.find(r => {
    const raw = r.fields['Current Phone'];
    if (!raw) return false;
    return formatPhone(String(raw)) === phone;
  }) || null;
}

// ─── PAYMENT SEAT LOOKUPS (B8) ───────────────────────────────────────────────
// PAID is Reception-only, per the locked spec's refusal rule ("non-Reception
// seat ... falls through silently") — narrower than WALKIN, which also accepts
// Owner and Manager. Flagged in the PR: if the owner should be able to record a
// payment, this constant is the single place that changes.
const PAID_ROLE_TYPES = ['Reception'];

// Deliberately a sibling of activeWalkinRoleForPhone rather than a
// generalisation of it: rule 26 — no refactor while adding a feature. The two
// converge when B18 lands and owns seat resolution properly.
async function activePaidRoleForPhone(phone) {
  const roles = await airtableGet('WS_Roles', `{Active} = TRUE()`);
  return roles.find(r => {
    if (!PAID_ROLE_TYPES.includes(r.fields['Role Type'])) return false;
    const raw = r.fields['Current Phone'];
    if (!raw) return false;
    return formatPhone(String(raw)) === phone;
  }) || null;
}

// The recipients of the checkout push. Scoped by property record id and filtered
// in JS, for the same reason activeCleanersForProperty is: filterByFormula
// matches linked-record fields on their display value, which is not id-safe.
async function activeReceptionRolesForProperty(propertyId) {
  if (!propertyId) return [];
  const roles = await airtableGet('WS_Roles', `{Active} = TRUE()`);
  return roles.filter(r =>
    PAID_ROLE_TYPES.includes(r.fields['Role Type']) &&
    (r.fields['Property'] || []).includes(propertyId) &&
    r.fields['Current Phone']
  );
}

// Exact match only — never `roomMatchesText`, whose \b<number>\b test would
// match a room on the DURATION digit of the same command. `Room 01` is the live
// name shape and `Room Number` is 1, so both routes have to be tried; a token
// that is not a number can still name a room (`Room A`).
function roomMatchesWalkinToken(room, token) {
  const t = String(token || '').trim().toLowerCase();
  if (!t) return false;
  const name = String(room.fields['Room Name'] || '').trim().toLowerCase();
  if (name && (name === t || name === `room ${t}`)) return true;
  const number = room.fields['Room Number'];
  if (number === undefined || number === null) return false;
  return /^\d+$/.test(t) && Number(t) === Number(number);
}

// ─── AVAILABILITY (B8) ───────────────────────────────────────────────────────
// Rooms are held at enquiry, not at arrival: without a Room link on the booking
// there is nothing for an overlap check to compare against, and two guests
// asking for the same dates would both be accepted. The hold is also what ties a
// booking to a property — WS_Bookings has no Property field of its own.
//
// Two different axes, deliberately not conflated:
//   · Check In/Check Out — a future range. This is what decides availability.
//   · WS_Rooms.Status    — a fact about right now. Only a serviceability gate.
// A room occupied tonight is still sellable for next month, and same-day
// turnover means offering a room that is mid-clean — so Status cannot filter on
// the booking axis. Maintenance is the one status that means "not sellable at
// all", and it is excluded via an allowlist rather than a `!= Maintenance`
// denylist so that any status added to Airtable later is unsellable until
// someone deliberately allows it (fail closed, as resolveProperty does).

const BLOCKING_BOOKING_STATUSES = ['Enquiry', 'Confirmed', 'Checked In'];
const BOOKABLE_ROOM_STATUSES = ['Available', 'Occupied', 'Cleaning'];

function orFormula(field, values) {
  return `OR(${values.map(v => `{${field}} = '${v}'`).join(', ')})`;
}

// Exclusive bounds, strict inequalities — the locked definition. A room checked
// out of at 10:00 IS available for a 14:00 check-in the same day; inclusive
// bounds would silently cost every room a sellable night on every turnover.
function rangesOverlap(aStart, aEnd, bStart, bEnd) {
  return Date.parse(aStart) < Date.parse(bEnd) && Date.parse(aEnd) > Date.parse(bStart);
}

// A booking only blocks if it has both dates. Pre-B7 records (and any Walk-in
// row created by hand without dates) have nothing to compare, so they take no
// part — per the locked migration decision.
function bookingBlocksRange(booking, checkInIso, checkOutIso) {
  const bookedIn = booking.fields['Check In'];
  const bookedOut = booking.fields['Check Out'];
  if (!bookedIn || !bookedOut) return false;
  return rangesOverlap(checkInIso, checkOutIso, bookedIn, bookedOut);
}

// Returns the room record to use for this range, or null if the property is full.
// `preferRoomId` re-verifies an existing hold: it returns that room when it is
// still free, and silently re-offers a different one when it is not.
// `excludeBookingId` is essential for that re-verify — a booking overlaps its
// own range by definition, so without it a booking would always report its own
// held room as taken.
async function findAvailableRoom(propertyId, checkInIso, checkOutIso, opts = {}) {
  const { excludeBookingId = null, preferRoomId = null } = opts;

  // F5-style JS-side filter — FIND/ARRAYJOIN on linked records is unreliable.
  const allRooms = await airtableGet('WS_Rooms', orFormula('Status', BOOKABLE_ROOM_STATUSES));
  const rooms = allRooms.filter(r => (r.fields['Property'] || []).includes(propertyId));
  if (rooms.length === 0) return null;

  // Only statuses that actually block: a Cancelled or Checked Out booking must
  // not hold inventory. Bookings carry no Property field, so they are scoped to
  // this property by the room link itself — a booking on another property's room
  // can never mark one of these rooms taken.
  //
  // P1b: this is THE availability check — an empty result must mean "genuinely
  // nothing blocks this room", never "the read failed and we don't know". Before
  // this fix, airtableGet swallowed a failed page and returned whatever it had
  // (possibly []), which made a transient Airtable error indistinguishable from
  // a free room — a fail-OPEN path into exactly the double-booking this function
  // exists to prevent, independent of the P1a timing race. `throwOnError` makes
  // the failure loud instead of silent, and the catch below fails the whole
  // check CLOSED (room unavailable) rather than guessing the room is free.
  let blocking;
  try {
    blocking = await airtableGet('WS_Bookings', orFormula('Status', BLOCKING_BOOKING_STATUSES), { throwOnError: true });
  } catch (err) {
    logToAxiom('error', 'availability_check_failed_closed', {
      propertyId, checkInIso, checkOutIso, error: err.message,
      reason: 'blocking-bookings read failed — refusing rather than risking a double-booking'
    });
    return null;
  }
  const takenRoomIds = new Set();
  for (const booking of blocking) {
    if (excludeBookingId && booking.id === excludeBookingId) continue;
    if (!bookingBlocksRange(booking, checkInIso, checkOutIso)) continue;
    for (const roomId of booking.fields['Room'] || []) takenRoomIds.add(roomId);
  }

  const free = rooms.filter(r => !takenRoomIds.has(r.id));
  if (preferRoomId) {
    const held = free.find(r => r.id === preferRoomId);
    if (held) return held;
  }
  return free[0] || null;
}

// ─── GUARDS ──────────────────────────────────────────────────────────────────

// Matches a cleaner's free-text reply against a room's identifying fields.
// Deliberately loose (exact name, exact number, name-as-substring, or number
// as a whole word) since this only ever runs after senderIsCleaner-equivalent
// confirms the sender is a registered cleaner -- never evaluated against guest
// messages, so a loose match here can't misfire on unrelated guest traffic.
function roomMatchesText(room, text) {
  const t = String(text || '').trim().toLowerCase();
  if (!t) return false;
  const name = String(room.fields['Room Name'] || '').trim().toLowerCase();
  const number = room.fields['Room Number'];
  if (name && (t === name || t.includes(name))) return true;
  if (number !== undefined && number !== null) {
    return new RegExp(`\\b${number}\\b`).test(t);
  }
  return false;
}

// B11.5: does the sender's current guest-side state have a PENDING numbered
// expectation matching this exact reply? True when their Session State is a real
// (non-NEW) state with an explicit, non-"*" transition whose inputs include the
// text. A bare number ("2") is both a duration/menu choice AND a room number, so
// a phone that is both a registered cleaner and an active guest (Eric,
// 27825999279) would otherwise have "2" preempted by the cleaner-naming global
// and mark a room clean instead of driving their own booking. Read purely from
// states.json, so it stays correct as new numbered menus are added (occupancy,
// hourly duration) without touching this function.
function guestStateExpectsInput(guest, text) {
  if (!guest) return false;
  const state = guest.fields['Session State'];
  if (!state || state === 'NEW') return false;
  const rows = STATES.states[state];
  if (!rows) return false;
  return rows.some(t => t.inputs !== '*' && t.inputs.includes(text));
}

const guards = {
  // B7 (WALKIN). Registered FIRST in states.json's global list, ahead of the
  // cleaner-naming-room global: that guard matches \b<number>\b anywhere in the
  // message, so `WALKIN ROOM 2 2HRS` from a phone that is also a cleaner would
  // otherwise mark Room 02 clean instead of booking it. Same class of bug as
  // B11.5, and live data now guarantees the collision rather than merely
  // allowing it — the seeded Reception number (27825999279) is Eric's, already
  // both a registered cleaner and an active guest.
  //
  // Order of checks is load-bearing:
  //   1. Parse first. It is pure and free, and it returns null for everything
  //      that is not a WALKIN attempt — so ordinary guest traffic pays for no
  //      extra Airtable call, the same principle senderIsCleanerNamingRoom uses.
  //   2. Only then authorise. An unauthorised sender returns FALSE, not a
  //      refusal message: the message falls through to the ordinary guest flow
  //      and they see exactly what any stranger sees. Nothing anywhere confirms
  //      the command exists. This is the locked no-leak rule, and it is why
  //      there is no "unauthorised" reply to build.
  async senderIsAuthorizedWalkin(ctx) {
    const parsed = parseWalkinCommand(ctx.messageText);
    if (!parsed) return false;

    // Logging-granularity split, CEO decision: the no-leak guarantee to the
    // sender is unchanged either way (both cases return false with no reply,
    // identical fallthrough to the ordinary guest flow) — this only splits
    // WHAT gets logged, so Axiom can distinguish a stranger probing for the
    // command from a known staff seat whose Active box is off (revoked or
    // accidentally unticked), which the old single event name could not tell
    // apart.
    const record = await walkinRoleRecordForPhone(ctx.phone);
    if (!record) {
      logToAxiom('warn', 'walkin_unauthorised_stranger', { phone: ctx.phone });
      return false;
    }
    if (!record.fields['Active']) {
      logToAxiom('warn', 'walkin_unauthorised_deactivated', { phone: ctx.phone, roleId: record.id });
      return false;
    }
    const role = record;

    ctx.walkin = parsed;
    ctx.walkinRole = role;
    return true;
  },

  // B8 (PAID). Registered alongside the walk-in global and ahead of the
  // cleaner-naming-room guard for the same reason: `PAID ROOM 2 500` contains a
  // bare `2`, so if Room 02 is mid-clean that guard would match it and mark the
  // room Available instead of recording the money. Cheap pure parse first,
  // Airtable only for something that is actually a PAID command; an
  // unauthorised sender returns false and falls through to the guest flow.
  async senderIsAuthorizedPaid(ctx) {
    const parsed = parsePaidCommand(ctx.messageText);
    if (!parsed) return false;

    const role = await activePaidRoleForPhone(ctx.phone);
    if (!role) {
      logToAxiom('warn', 'paid_unauthorised_sender', { phone: ctx.phone });
      return false;
    }

    ctx.paid = parsed;
    ctx.paidRole = role;
    return true;
  },

  // `START ROOM <n>` from a registered cleaner. Registered ahead of the
  // cleaner-naming-room global for the now-familiar reason: the command
  // contains a bare room number, and that guard matches \b<number>\b anywhere —
  // reached first it would mark the room CLEAN at the moment the cleaner is
  // telling us they have only just started it. Parse first (pure, free, and
  // returns null for a bare START so B14's opt-back-in keyword is untouched),
  // Airtable only for something that really is the command.
  async senderIsCleanerStartingRoom(ctx) {
    const parsed = parseStartCleaningCommand(ctx.messageText);
    if (!parsed) return false;

    const cleaners = await airtableGet('WS_Cleaners', `{Phone Number} = '${ctx.phone}'`);
    if (cleaners.length === 0) {
      logToAxiom('warn', 'cleaning_start_unauthorised_sender', { phone: ctx.phone });
      return false;
    }

    ctx.cleaner = cleaners[0];
    ctx.cleaningStart = parsed;
    return true;
  },

  async senderIsCleaner(ctx) {
    const cleanerRecords = await airtableGet('WS_Cleaners', `{Phone Number} = '${ctx.phone}'`);
    ctx.cleaner = cleanerRecords[0] || null;
    return cleanerRecords.length > 0;
  },

  // Room-ambiguity fix: catches a cleaner's reply naming a specific room (any
  // time, not just right after "done") so cleanerDone never has to guess which
  // of several Cleaning rooms to resolve. Cheap check first (registered cleaner)
  // before the extra WS_Rooms lookup, so non-cleaner traffic only pays for one
  // Airtable call, same as it would if this guard didn't exist.
  async senderIsCleanerNamingRoom(ctx) {
    // B11.5 precedence: if the sender has a pending guest-side numbered
    // expectation for this exact reply, the guest state machine wins — this
    // global must not preempt it. Targeted addition only; the rest of the guard
    // (which behaves correctly for genuine cleaner room-naming) is unchanged.
    if (guestStateExpectsInput(ctx.guest, ctx.text)) return false;
    const cleanerRecords = await airtableGet('WS_Cleaners', `{Phone Number} = '${ctx.phone}'`);
    if (cleanerRecords.length === 0) return false;
    const cleaningRooms = await airtableGet('WS_Rooms', `{Status} = 'Cleaning'`);
    const match = cleaningRooms.find(r => roomMatchesText(r, ctx.text));
    if (!match) return false;
    ctx.cleaner = cleanerRecords[0];
    ctx.matchedCleaningRoom = match;
    return true;
  },

  // Universal escape hatch for the guest-side AWAITING_* limbo states
  // (AWAITING_STAY_TYPE / AWAITING_DETAILS / AWAITING_OCCUPANCY /
  // AWAITING_HOURLY_DETAILS / AWAITING_HOURLY_DURATION / AWAITING_ETA). Found
  // via live testing: a guest in one of these states whose input never
  // satisfies that state's own free-text parser (wrong format, or a reply
  // meant for a different flow entirely) gets the same reprompt forever —
  // states.json gives each of them exactly one "*" row pointing at a parser
  // that only advances state on a successful parse, so a guest who can't
  // produce parseable input has no way out short of a manual Airtable edit.
  // No keyword anywhere in any of these states' own input arrays offers an
  // exit, and the abandonment sweep (runEnquiryAbandonment, ENQUIRY LOGGING
  // section below) only ever WROTE a report row, never reset the guest —
  // see the fix alongside it.
  //
  // Registered in the GLOBAL array (states.json), so this is evaluated for
  // EVERY inbound message before any per-state routing happens at all — the
  // exact "checked before the state's own parsing logic" requirement, for
  // free, from the existing global-then-per-state dispatch order. inputs is
  // an explicit ["cancel","menu","hi"] list (not "*"), matched by
  // handleMessage's own pre-filter before this guard even runs — the guard's
  // only job is to confirm the sender is actually IN one of these limbo
  // states, so a CONFIRMED/CHECKED_IN guest's "cancel"/"hi" (which already
  // mean something real there — an active booking, not a stuck draft) is
  // untouched and keeps going through its own state's row as before.
  //
  // Exact whole-message match only (ctx.text is already trim+lowercased by
  // handleMessage) — not a substring/\b test — specifically so a guest whose
  // real name or arrival note merely CONTAINS one of these words (unlikely
  // but flagged: a guest named "Candace" does not collide since "candace"
  // does not contain "cancel" as a substring; a guest typing an arrival note
  // that IS literally the word "cancel"/"menu"/"hi" and nothing else would,
  // but that reads as them wanting out anyway, same intent this exists for).
  async senderStuckInAwaitingState(ctx) {
    const state = ctx.guest && ctx.guest.fields['Session State'];
    return !!state && state.startsWith('AWAITING_');
  }
};

// Shared by cleanerDone (unambiguous case) and cleanerRoomReply (disambiguated
// case) -- same side effects either way: room -> Available, thank the cleaner,
// notify the owner.
async function resolveRoomClean(ctx, room) {
  // Locked requirement: only a room actually in Cleaning can be completed. Both
  // callers already select from `{Status} = 'Cleaning'`, so this is belt-and-
  // braces — but it is the guard the metric depends on, and an invariant that is
  // merely implied by two call sites is one refactor away from being untrue.
  if (room.fields['Status'] !== 'Cleaning') {
    logToAxiom('warn', 'cleaning_complete_room_not_cleaning', {
      phone: ctx.phone, roomId: room.id, roomName: room.fields['Room Name'],
      status: room.fields['Status'] || null
    });
    await sendWhatsApp(ctx.phone, msg('cleanerNothingToClean'));
    return;
  }

  const completedAt = new Date().toISOString();
  const booking = await bookingForCleaningJob(room.id);
  const durations = cleaningDurations(room, booking, completedAt);

  // Rule 30 step 2, slice 1: checked but non-fatal, same shape as walkinBooking's
  // room->Occupied write (F40) — Status is a derived display field, not
  // findAvailableRoom's source of truth (that's the WS_Bookings overlap check),
  // so a failure here fails safe (room stays Cleaning, unsellable) rather than
  // unsafe. Logged loud so the write failure is visible instead of inferred.
  // Non-fatal: job completion and metrics below are the cleaner's declaration
  // of fact, independent of whether the derived Status field caught up.
  const roomWrite = await airtableUpdate('WS_Rooms', room.id, { 'Status': 'Available' });
  if (roomWrite && roomWrite.error) {
    logToAxiom('error', 'cleaner_done_room_status_write_failed', {
      phone: ctx.phone, roomId: room.id, roomName: room.fields['Room Name'],
      error: JSON.stringify(roomWrite.error)
    });
  }

  // Per-job record, on the booking so it survives the next checkout. Written
  // before the metric is logged so a failed write can never produce a number
  // with no record behind it. Proceeds regardless of the Status write above.
  if (booking) {
    const jobUpdate = { [CLEANING_COMPLETED_FIELD]: completedAt };
    // Attribution is to whoever declared DONE — the only identity the system
    // actually observes. If a different cleaner sent START, that divergence is
    // logged below rather than silently resolved in either direction.
    //
    // `Cleaned By` is a plain text field, not a link to WS_Cleaners (confirmed
    // live 6 Aug — a link was the original intent, but the field was created as
    // singleLineText). Writing the record-id array shape here would either be
    // rejected by Airtable or coerce into something unusable, so the cleaner's
    // NAME is written instead. This trades away click-through to the cleaner's
    // record and relational integrity if a cleaner is renamed — acceptable for
    // now since B18 is already going to migrate attribution wholesale to
    // WS_People, and a link built today would just be torn out then.
    if (ctx.cleaner) jobUpdate[CLEANED_BY_FIELD] = ctx.cleaner.fields['Cleaner Name'] || null;
    await airtableUpdate('WS_Bookings', booking.id, jobUpdate);
  } else {
    logToAxiom('warn', 'cleaning_complete_no_booking', {
      phone: ctx.phone, roomId: room.id, roomName: room.fields['Room Name'],
      reason: 'no Checked Out booking for this room — nothing to record the job against'
    });
  }

  const toMinutes = ms => (ms === null ? null : Number((ms / 60000).toFixed(1)));
  logToAxiom('info', 'cleaning_job_completed', {
    phone: ctx.phone,
    roomId: room.id, roomName: room.fields['Room Name'],
    bookingId: booking ? booking.id : null,
    bookingRef: (booking && booking.fields['Booking Ref']) || null,
    cleanerId: ctx.cleaner ? ctx.cleaner.id : null,
    cleanerName: (ctx.cleaner && ctx.cleaner.fields['Cleaner Name']) || null,
    completedAt,
    // Primary metric: checkout → sellable again.
    vacantToReadyMs: durations.vacantToReadyMs,
    vacantToReadyMinutes: toMinutes(durations.vacantToReadyMs),
    // Secondary: only present when the cleaner sent START ROOM <n>.
    jobDurationMs: durations.jobDurationMs,
    jobDurationMinutes: toMinutes(durations.jobDurationMs),
    // A missing/stale baseline emits NO turnaround rather than a wrong one.
    vacantToReadyOmitted: durations.vacantToReadyMs === null,
    baselineSuspect: durations.baselineSuspect,
    // Carried on every record so no downstream reader can mistake this for a
    // verified measurement: DONE is self-declared, and dispatch is a broadcast,
    // so this is reply speed as much as cleaning speed.
    selfReported: true
  });

  logToAxiom('info', 'state_transition', { phone: ctx.phone, roomId: room.id, roomName: room.fields['Room Name'], from: 'Cleaning', to: 'Available', reason: 'cleaner_done' });
  await sendWhatsApp(ctx.phone, msg('cleanerThanks', { roomName: room.fields['Room Name'] }));
  if (OWNER_PHONE) {
    logOwnerSendWindow('room_cleaned', OWNER_PHONE, ctx.phone); // B17 instrumentation
    // Rule 30 step 2, slice 2: checked but non-fatal — pure courtesy
    // notification, nothing reads a "did the owner get told" flag; the
    // cleaner already got their own confirmation above regardless.
    const ownerSend = await sendWhatsApp(OWNER_PHONE, msg('ownerRoomCleaned', { roomName: room.fields['Room Name'] }));
    if (ownerSend && ownerSend.error) {
      logToAxiom('error', 'owner_room_cleaned_notify_failed', {
        roomId: room.id, error: JSON.stringify(ownerSend.error)
      });
    }
  }
}

// ─── ACTION HANDLERS ─────────────────────────────────────────────────────────
// Each handler owns its side effects and write ORDER (frozen by fixtures).
// The Session State it writes comes from the transition's `next` in states.json.

const actions = {
  // B7 (WALKIN): staff-initiated booking, no guest thread. Reached only through
  // senderIsAuthorizedWalkin, so by the time this runs the sender IS authorised
  // and every reply below is safe to send — an outsider never gets here.
  //
  // Every reply goes to the SENDING STAFF NUMBER, which just messaged us and is
  // therefore inside Meta's 24-hour service window: free-form is correct here
  // and needs no template (CLAUDE.md line 30). Nothing is sent to the walk-in
  // guest, even when their number is supplied — that WOULD be business-initiated
  // to a third party, so it needs an approved template and is deliberately not
  // built here. Same reason there is no owner notification (F23's finding).
  async walkinBooking(ctx) {
    const parsed = ctx.walkin;
    const role = ctx.walkinRole;

    if (!parsed.ok) {
      if (parsed.reason === 'bad_duration') {
        logToAxiom('info', 'walkin_rejected', { phone: ctx.phone, reason: 'bad_duration', requestedHours: parsed.hours });
        await sendWhatsApp(ctx.phone, msg('walkinBadDuration', { hours: parsed.hours }));
        return;
      }
      logToAxiom('info', 'walkin_rejected', { phone: ctx.phone, reason: parsed.reason });
      await sendWhatsApp(ctx.phone, msg('walkinUsage'));
      return;
    }

    // The guest's name is required, and this is where "prompt for the name"
    // lands: a serverless handler has no memory between messages, and parking a
    // half-finished command would need a session store that does not exist for
    // staff numbers (WS_Guests.Session State has no walk-in states, and adding
    // them is a schema change — out of scope by instruction). So the command is
    // re-asked in full rather than continued. See the PR for the stateful
    // alternative.
    if (!parsed.guestName) {
      logToAxiom('info', 'walkin_rejected', { phone: ctx.phone, reason: 'missing_guest_name' });
      await sendWhatsApp(ctx.phone, msg('walkinNeedName'));
      return;
    }

    // Property comes from the SEAT, not from the inbound number: the role's
    // single Property link is the booking's property (locked). The link is
    // single at schema level, so [0] is the whole answer and there is no
    // disambiguation to build.
    const rolePropertyId = (role.fields['Property'] || [])[0] || null;
    if (!rolePropertyId) {
      logToAxiom('error', 'walkin_role_without_property', { phone: ctx.phone, roleId: role.id });
      await sendWhatsApp(ctx.phone, msg('walkinNotConfigured'));
      return;
    }

    // Fail closed on a cross-property mismatch. ctx.property is the property
    // that owns the WhatsApp number this message arrived on; the seat says a
    // different one. Both readings are defensible and the wrong one books a
    // stranger into another property's room, so it is refused rather than
    // guessed — the same posture as the room-assignment rule. Flagged in the PR:
    // the alternative (seat always wins) is a CEO decision, not a Builder one.
    if (rolePropertyId !== ctx.property.id) {
      logToAxiom('warn', 'walkin_property_mismatch', {
        phone: ctx.phone, roleId: role.id, rolePropertyId, inboundPropertyId: ctx.property.id
      });
      await sendWhatsApp(ctx.phone, msg('walkinWrongProperty'));
      return;
    }
    const property = ctx.property;

    // Rates: reuse hourlyRates, which fails closed on any blank or zero. A
    // walk-in is never quoted R0 and the price is never hardcoded here.
    const rates = hourlyRates(property);
    if (!rates) {
      logToAxiom('warn', 'walkin_rates_unavailable', { phone: ctx.phone, propertyId: property.id });
      await sendWhatsApp(ctx.phone, msg('walkinRatesUnavailable', { propertyName: property.fields['Property Name'] }));
      return;
    }

    // The guest is standing at the desk: the stay starts now.
    const checkInIso = new Date().toISOString();
    const checkOutIso = addHoursToIso(checkInIso, parsed.hours);

    const allRooms = await airtableGet('WS_Rooms', orFormula('Status', BOOKABLE_ROOM_STATUSES));
    const propertyRooms = allRooms.filter(r => (r.fields['Property'] || []).includes(property.id));
    const requested = propertyRooms.find(r => roomMatchesWalkinToken(r, parsed.roomToken)) || null;
    if (!requested) {
      logToAxiom('info', 'walkin_rejected', { phone: ctx.phone, reason: 'no_such_room', roomToken: parsed.roomToken });
      await sendWhatsApp(ctx.phone, msg('walkinNoSuchRoom', { roomToken: parsed.roomToken }));
      return;
    }

    // BOOKABLE_ROOM_STATUSES deliberately includes 'Cleaning' (comment above its
    // definition) so a FUTURE-dated overnight/hourly booking can still be offered
    // against a room that happens to be mid-clean right now — same-day turnover,
    // sellable by the guest's actual check-in time. WALKIN is the one caller of
    // findAvailableRoom where that reasoning does not hold: the stay starts NOW
    // (line ~1321), so "sellable by check-in time" and "sellable this instant"
    // are the same instant. Guarded here, not in findAvailableRoom/
    // BOOKABLE_ROOM_STATUSES itself, so collectDetails/collectHourlyDetails/
    // selectHourlyDuration's legitimate future-dated case is untouched.
    if (requested.fields['Status'] === 'Cleaning') {
      logToAxiom('info', 'walkin_room_mid_clean', {
        phone: ctx.phone, roomId: requested.id, roomName: requested.fields['Room Name']
      });
      await sendWhatsApp(ctx.phone, msg('walkinRoomCleaning', { roomName: requested.fields['Room Name'] }));
      return;
    }

    // ONE availability path, the same one both guest flows use. preferRoomId
    // re-offers a different room when the preferred one is taken — correct for a
    // guest chatting on WhatsApp, wrong for a staff member standing in front of
    // a specific door — so the substitution is rejected rather than accepted:
    // the room staff named must be the room that comes back.
    const free = await findAvailableRoom(property.id, checkInIso, checkOutIso, { preferRoomId: requested.id });
    if (!free || free.id !== requested.id) {
      logToAxiom('info', 'walkin_room_taken', {
        phone: ctx.phone, roomId: requested.id, roomName: requested.fields['Room Name'],
        checkIn: checkInIso, checkOut: checkOutIso
      });
      await logEnquiry(property, parsed.guestPhone || ctx.phone, 'No Availability', {
        checkInIso, checkOutIso, bookingType: 'Hourly'
      });
      await sendWhatsApp(ctx.phone, msg('walkinRoomTaken', { roomName: requested.fields['Room Name'] }));
      return;
    }

    // Guest identity. With a phone we can recognise a returning walk-in and
    // reuse their record; without one there is nothing to match on, so a
    // name-only record is created and repeat-guest tracking simply does not
    // apply to this booking (locked). Creation is never blocked on the phone.
    let guest = null;
    if (parsed.guestPhone) {
      guest = (await airtableGet('WS_Guests', `{Phone Number} = '${parsed.guestPhone}'`))[0] || null;
    }
    if (guest) {
      // An existing name is NOT overwritten — the record may be a returning
      // guest with their own history, and staff typing a shortened name at the
      // desk must not rewrite it.
      await updateGuestState(guest.id, { 'Session State': 'CHECKED_IN' });
    } else {
      const fields = {
        'Guest Name': parsed.guestName,
        'Guest Type': 'Walk-in',
        // Truthful from the moment the booking exists: they are checked in. It
        // also means a walk-in who DID give a number can drive EXTEND / checkout
        // from their own phone through the existing CHECKED_IN menu, with no new
        // flow to build.
        'Session State': 'CHECKED_IN',
        'First Visit': new Date().toISOString().split('T')[0]
      };
      if (parsed.guestPhone) fields['Phone Number'] = parsed.guestPhone;
      guest = await airtableCreate('WS_Guests', fields);
    }
    // airtableCreate resolves to Airtable's error body on a failed write rather
    // than throwing, so an unchecked `.id` here would surface as a crash three
    // lines later with the real cause already swallowed.
    if (!guest || !guest.id) {
      logToAxiom('error', 'walkin_guest_create_failed', { phone: ctx.phone, propertyId: property.id });
      await sendWhatsApp(ctx.phone, msg('walkinFailed'));
      return;
    }

    const booking = await airtableCreate('WS_Bookings', {
      'Guest': [guest.id],
      'Room': [requested.id],
      // Hourly, NOT the 'Walk-in' Booking Type option: Booking Type is read by
      // EXTENSION_MS, B17's room-night maths and findPendingHourlyBooking, and a
      // third value would fall silently through all three. Walk-in provenance
      // lives in Source, which is what that field is for (locked, CEO 6 Aug).
      'Booking Type': 'Hourly',
      'Source': 'Walk-in',
      'Logged By': 'Manual',
      // Checked In on creation (locked): the guest is physically in the room, so
      // the auto-checkout cron owns the rest of the stay from this instant — the
      // 15-minute warning, the auto-checkout, and the cleaner dispatch that
      // follows it all come for free from B12 rather than being rebuilt here.
      'Status': 'Checked In',
      'Check In': checkInIso,
      'Check Out': checkOutIso,
      'Checked In At': checkInIso,
      'Payment Status': 'Unpaid',
      'Amount Due': rates[parsed.hours],
      // B10.5 Bug 2: both checkout paths scope cleaner dispatch off this link.
      'WS_Property': [property.id],
      'Notes': `Walk-in: ${durationText(parsed.hours)} from ${formatSastDateTime(checkInIso)}`
    });

    if (!booking || !booking.id) {
      // Same reason as the guest guard above. Nothing has been written to the
      // room yet at this point, so there is nothing to roll back.
      logToAxiom('error', 'walkin_booking_create_failed', { phone: ctx.phone, propertyId: property.id, roomId: requested.id });
      await sendWhatsApp(ctx.phone, msg('walkinFailed'));
      return;
    }

    const bookingRef = `WS-${booking.id.slice(-6).toUpperCase()}`;
    // PR3 3c: checked, but non-fatal on failure. bookingRef is already computed
    // locally and used in every message/log below regardless of whether this
    // PATCH lands — the booking is Checked In, priced and roomed either way, so
    // a failed writeback is a "does the Airtable record match what everyone was
    // told" gap, not a broken booking. Logged loud rather than discovered later
    // by someone finding a blank Booking Ref on an otherwise-complete row.
    const refWrite = await airtableUpdate('WS_Bookings', booking.id, { 'Booking Ref': bookingRef });
    if (refWrite && refWrite.error) {
      logToAxiom('warn', 'walkin_bookingref_writeback_failed', {
        phone: ctx.phone, bookingId: booking.id, bookingRef, error: JSON.stringify(refWrite.error)
      });
    }

    // CLAUDE.md rule 32 — Airtable is not transactional. Re-query after the
    // assignment and confirm this booking still holds the room alone. A second
    // walk-in typed on the other reception handset in the same second would
    // otherwise double-book a room with a person already standing in it.
    // On conflict: roll back and re-offer, never leave two live bookings.
    const stillFree = await findAvailableRoom(property.id, checkInIso, checkOutIso, {
      excludeBookingId: booking.id, preferRoomId: requested.id
    });
    if (!stillFree || stillFree.id !== requested.id) {
      // PR3 3c: this rollback write is now checked — mirrors PR1's identical
      // fix for the same class of write (a Cancelled rollback with nothing
      // clean left to do if IT fails too). Same event name as PR1 deliberately,
      // for one queryable signal across every rollback-failure in the file.
      const rollback = await airtableUpdate('WS_Bookings', booking.id, { 'Status': 'Cancelled' });
      if (rollback && rollback.error) {
        logToAxiom('error', 'booking_rollback_failed', {
          phone: ctx.phone, bookingId: booking.id, roomId: requested.id,
          error: JSON.stringify(rollback.error),
          reason: 'lost the availability race AND the Cancelled write failed — booking may still be holding a contested room'
        });
      }
      logToAxiom('warn', 'walkin_rolled_back', {
        phone: ctx.phone, bookingId: booking.id, roomId: requested.id, reason: 'room taken between check and create'
      });
      await sendWhatsApp(ctx.phone, msg('walkinRoomTaken', { roomName: requested.fields['Room Name'] }));
      return;
    }

    // Only now is the room really occupied — after the conflict check, so a
    // rolled-back booking never leaves a room marked Occupied behind it.
    // PR3 3c: checked, but non-fatal on failure for the same reason as the
    // Booking Ref writeback — the BOOKING (its Check In/Check Out range) is
    // what findAvailableRoom actually blocks against, not this Status field,
    // which is cosmetic/ops-visibility for staff reading the room grid. A
    // failed write here risks a stale-looking room, not a double-booking.
    const roomWrite = await airtableUpdate('WS_Rooms', requested.id, { 'Status': 'Occupied' });
    if (roomWrite && roomWrite.error) {
      logToAxiom('error', 'walkin_room_status_write_failed', {
        phone: ctx.phone, roomId: requested.id, bookingId: booking.id, error: JSON.stringify(roomWrite.error)
      });
    }

    logToAxiom('info', 'booking_create', {
      phone: ctx.phone, guestName: parsed.guestName, bookingRef, bookingType: 'Hourly',
      source: 'Walk-in', hours: parsed.hours, roomId: requested.id, airtableId: booking.id,
      roleId: role.id, propertyId: property.id, guestPhone: parsed.guestPhone || null
    });
    // B19: a walk-in is a booking that happened — logged as Booked so the owner
    // summary's demand picture includes it. Keyed on the guest's number when
    // there is one, otherwise the staff number that logged it.
    await logEnquiry(property, parsed.guestPhone || ctx.phone, 'Booked', {
      checkInIso, checkOutIso, bookingType: 'Hourly', bookingId: booking.id
    });

    await sendWhatsApp(ctx.phone, msg('walkinConfirmed', {
      guestName: parsed.guestName,
      roomName: requested.fields['Room Name'],
      durationText: durationText(parsed.hours),
      checkOutText: formatSastDateTime(checkOutIso),
      amount: rates[parsed.hours],
      bookingRef
    }));
  },

  // B8 (PAID): reception records cash taken at the desk. Reached only through
  // senderIsAuthorizedPaid, so every reply here is safe to send and goes to the
  // seat that just messaged us — inside the 24h window, so free-form is correct.
  async paidBooking(ctx) {
    const parsed = ctx.paid;
    const role = ctx.paidRole;

    if (!parsed.ok) {
      logToAxiom('info', 'paid_rejected', { phone: ctx.phone, reason: parsed.reason });
      await sendWhatsApp(ctx.phone, msg('paidUsage'));
      return;
    }

    const rolePropertyId = (role.fields['Property'] || [])[0] || null;
    if (!rolePropertyId) {
      logToAxiom('error', 'paid_role_without_property', { phone: ctx.phone, roleId: role.id });
      await sendWhatsApp(ctx.phone, msg('paidNotConfigured'));
      return;
    }
    // Fails closed on a cross-property mismatch, same posture as WALKIN: the
    // seat says one property and the inbound number says another, and recording
    // a payment against the wrong property's booking is not recoverable by a
    // guess. Same CEO decision pending as WALKIN's.
    if (rolePropertyId !== ctx.property.id) {
      logToAxiom('warn', 'paid_property_mismatch', {
        phone: ctx.phone, roleId: role.id, rolePropertyId, inboundPropertyId: ctx.property.id
      });
      await sendWhatsApp(ctx.phone, msg('paidWrongProperty'));
      return;
    }
    const property = ctx.property;

    // Resolve the room within this property, exact match only — the same
    // matcher WALKIN uses, never roomMatchesText.
    const allRooms = await airtableGet('WS_Rooms', '');
    const propertyRooms = allRooms.filter(r => (r.fields['Property'] || []).includes(property.id));
    const room = propertyRooms.find(r => roomMatchesWalkinToken(r, parsed.roomToken)) || null;
    if (!room) {
      logToAxiom('info', 'paid_rejected', { phone: ctx.phone, reason: 'no_such_room', roomToken: parsed.roomToken });
      await sendWhatsApp(ctx.phone, msg('paidNoSuchRoom', { roomToken: parsed.roomToken }));
      return;
    }

    // Which stay is being paid for. Reception is standing at the desk just after
    // a checkout, so the target is that room's most recent CLOSED booking:
    // Checked Out ranks over Checked In (a guest still in the room has not been
    // billed at the desk yet), and within each, latest Check Out wins. Cancelled
    // and Enquiry rows can never be paid for.
    const PAYABLE_STATUSES = ['Checked Out', 'Checked In'];
    const all = await airtableGet('WS_Bookings', orFormula('Status', PAYABLE_STATUSES));
    const candidates = all
      .filter(b => (b.fields['Room'] || []).includes(room.id))
      .sort((a, b) => {
        const rank = s => (s === 'Checked Out' ? 0 : 1);
        const byStatus = rank(a.fields['Status']) - rank(b.fields['Status']);
        if (byStatus !== 0) return byStatus;
        return Date.parse(b.fields['Check Out'] || 0) - Date.parse(a.fields['Check Out'] || 0);
      });
    const booking = candidates[0] || null;
    if (!booking) {
      logToAxiom('info', 'paid_rejected', { phone: ctx.phone, reason: 'no_booking', roomId: room.id });
      await sendWhatsApp(ctx.phone, msg('paidNoBooking', { roomName: room.fields['Room Name'] }));
      return;
    }

    // Idempotency (locked): an already-Paid booking is reported, never rewritten.
    // Reception re-sending after a lost reply, or two handsets recording the same
    // cash, must not double-write — and must not silently look like a second
    // payment either.
    if (booking.fields['Payment Status'] === 'Paid') {
      logToAxiom('info', 'paid_already_recorded', {
        phone: ctx.phone, bookingId: booking.id, bookingRef: booking.fields['Booking Ref'] || null,
        amountPaid: booking.fields['Amount Paid'] || null
      });
      await sendWhatsApp(ctx.phone, msg('paidAlreadyRecorded', {
        roomName: room.fields['Room Name'],
        bookingRef: booking.fields['Booking Ref'] || '',
        amountPaid: formatAmount(booking.fields['Amount Paid'])
      }));
      return;
    }

    const amountDue = Number(booking.fields['Amount Due']) || 0;

    // Partial payments do not exist in this business (CEO, 6 Aug), and that is
    // what decides the mismatch rule rather than a preference: if every payment
    // settles the bill in full, then an amount that is not the amount owed is
    // not a short payment — it is a TYPO. So it is refused with zero writes and
    // reception re-sends the right figure.
    //
    // The alternative (record it, flag the mismatch, mark Paid) was rejected
    // because it is unrecoverable in one step: the write marks the booking Paid,
    // and the idempotency guard immediately above then refuses every correction,
    // so a fat-fingered R40 against R400 would be frozen into the record that
    // B17 builds the owner's revenue report from. Refusing costs one re-send;
    // accepting costs a wrong number nobody can fix from WhatsApp.
    //
    // Compared with a half-cent tolerance so decimal input ("400,00") cannot
    // fail on float representation alone.
    const AMOUNT_EPSILON = 0.005;
    // An unpriced booking has nothing to check against — F19's and F34's
    // fail-closed paths both produce exactly that (booked or extended, never
    // priced). Refusing there would leave reception unable to record real cash,
    // so whatever they send is accepted and the gap is logged instead.
    const priced = amountDue > 0;
    if (priced && Math.abs(parsed.amount - amountDue) > AMOUNT_EPSILON) {
      logToAxiom('warn', 'payment_amount_mismatch', {
        phone: ctx.phone, bookingId: booking.id, bookingRef: booking.fields['Booking Ref'] || null,
        roomName: room.fields['Room Name'], amountSent: parsed.amount, amountDue,
        delta: Number((parsed.amount - amountDue).toFixed(2)), written: false
      });
      await sendWhatsApp(ctx.phone, msg('paidAmountMismatch', {
        roomName: room.fields['Room Name'],
        amountSent: formatAmount(parsed.amount),
        amountDue: formatAmount(amountDue)
      }));
      return;
    }
    if (!priced) {
      logToAxiom('warn', 'payment_recorded_unpriced', {
        phone: ctx.phone, bookingId: booking.id, bookingRef: booking.fields['Booking Ref'] || null,
        amountSent: parsed.amount, reason: 'booking has no Amount Due to check against'
      });
    }

    const status = 'Paid';
    const method = parsed.method || 'Cash';

    // One instant, written to both sinks. Generating it twice would let the
    // Airtable field and the Axiom event disagree by however long the write
    // takes, and reconciling a payment against its log entry is exactly what
    // this timestamp is for.
    const recordedAt = new Date().toISOString();

    const update = {
      'Amount Paid': parsed.amount,
      'Payment Method': method,
      'Payment Status': status,
      // `Paid At` — created live by the CEO after F35 shipped, which is why the
      // original build could only log it. It goes in the SAME patch as the
      // payment fields deliberately: a payment recorded without its timestamp,
      // or a timestamp without its payment, is a half-written record either way.
      // (Contrast `Cleaning Started At`, which is a separate call precisely
      // because it was NOT confirmed live at the time.)
      'Paid At': recordedAt
    };
    // PR3 3b: the write is now checked before anything downstream trusts it.
    // `result.error` is exactly the same test airtableUpdate itself uses
    // internally to decide between logging airtable_update_success and
    // airtable_update_error (PR2) — that IS the signal; there is no separate
    // subscription mechanism to a fire-and-forget Axiom log, so the caller
    // checks the same condition the callee already checks, on the same
    // return value. Before this, the confirmation reply and payment_recorded
    // fired regardless of whether the PATCH actually landed — reception could
    // be told "Settled in full" while Payment Status stayed Unpaid, with
    // nothing but an easily-missed airtable_update_error to say otherwise.
    const result = await airtableUpdate('WS_Bookings', booking.id, update);
    if (result && result.error) {
      logToAxiom('error', 'payment_write_failed', {
        phone: ctx.phone, roleId: role.id, propertyId: property.id,
        bookingId: booking.id, bookingRef: booking.fields['Booking Ref'] || null,
        amountAttempted: parsed.amount, method,
        error: JSON.stringify(result.error)
      });
      await sendWhatsApp(ctx.phone, msg('paidWriteFailed', { roomName: room.fields['Room Name'] }));
      return;
    }

    logToAxiom('info', 'payment_recorded', {
      phone: ctx.phone, roleId: role.id, propertyId: property.id,
      bookingId: booking.id, bookingRef: booking.fields['Booking Ref'] || null,
      roomId: room.id, roomName: room.fields['Room Name'],
      amountPaid: parsed.amount, amountDue, method, status,
      recordedAt
    });

    await sendWhatsApp(ctx.phone, msg('paidRecorded', {
      roomName: room.fields['Room Name'],
      bookingRef: booking.fields['Booking Ref'] || '',
      amountPaid: formatAmount(parsed.amount),
      method
    }));
  },

  // Cleaner sends `START ROOM <n>` when they actually begin a job. Purely an
  // instrumentation step: it starts the Job Duration clock and changes nothing
  // about the room, the booking's status, or the existing DONE flow — a cleaner
  // who never sends START still completes normally, and simply has no secondary
  // metric for that job.
  async startCleaningJob(ctx) {
    const parsed = ctx.cleaningStart;
    if (!parsed.ok) {
      await sendWhatsApp(ctx.phone, msg('cleaningStartUsage'));
      return;
    }

    // Only a room already marked for cleaning can have a job started on it —
    // the same invariant the completion side enforces.
    const cleaningRooms = await airtableGet('WS_Rooms', `{Status} = 'Cleaning'`);
    const room = cleaningRooms.find(r => roomMatchesWalkinToken(r, parsed.roomToken)) || null;
    if (!room) {
      logToAxiom('info', 'cleaning_start_rejected', {
        phone: ctx.phone, roomToken: parsed.roomToken, reason: 'no room in Cleaning matches'
      });
      await sendWhatsApp(ctx.phone, msg('cleaningStartNotCleaning', { roomToken: parsed.roomToken }));
      return;
    }

    const booking = await bookingForCleaningJob(room.id);
    if (!booking) {
      // Nowhere to record the job. The cleaner is still told to carry on — the
      // room genuinely needs cleaning — but the gap is visible rather than
      // swallowed, because a missing job record is a missing metric later.
      logToAxiom('warn', 'cleaning_start_no_booking', {
        phone: ctx.phone, roomId: room.id, roomName: room.fields['Room Name']
      });
      await sendWhatsApp(ctx.phone, msg('cleaningStarted', { roomName: room.fields['Room Name'] }));
      return;
    }

    // FIRST start wins. A second START on the same job would reset the clock and
    // silently understate how long the work took, which is the one way this
    // metric could flatter itself.
    if (booking.fields[CLEANING_JOB_STARTED_FIELD]) {
      logToAxiom('info', 'cleaning_start_already_recorded', {
        phone: ctx.phone, roomId: room.id, bookingId: booking.id,
        startedAt: booking.fields[CLEANING_JOB_STARTED_FIELD]
      });
      await sendWhatsApp(ctx.phone, msg('cleaningStarted', { roomName: room.fields['Room Name'] }));
      return;
    }

    const startedAt = new Date().toISOString();
    await airtableUpdate('WS_Bookings', booking.id, { [CLEANING_JOB_STARTED_FIELD]: startedAt });
    logToAxiom('info', 'cleaning_job_started', {
      phone: ctx.phone, roomId: room.id, roomName: room.fields['Room Name'],
      bookingId: booking.id, bookingRef: booking.fields['Booking Ref'] || null,
      cleanerId: ctx.cleaner ? ctx.cleaner.id : null,
      cleanerName: (ctx.cleaner && ctx.cleaner.fields['Cleaner Name']) || null,
      startedAt
    });
    await sendWhatsApp(ctx.phone, msg('cleaningStarted', { roomName: room.fields['Room Name'] }));
  },

  // Cleaner replies DONE (global, any state)
  async cleanerDone(ctx) {
    // F4: was {Active} = 1 — Airtable checkbox requires TRUE()
    const cleaningRooms = await airtableGet('WS_Rooms', `{Status} = 'Cleaning'`);
    if (cleaningRooms.length === 0) {
      await sendWhatsApp(ctx.phone, msg('cleanerNothingToClean'));
      return;
    }
    if (cleaningRooms.length > 1) {
      // Ambiguity fix: more than one room in Cleaning -- ask, don't guess.
      // The cleaner's answer (any later message naming a room) is caught by
      // the cleanerRoomReply global transition below, whenever it arrives.
      const roomList = cleaningRooms.map(r => r.fields['Room Name']).join(', ');
      await sendWhatsApp(ctx.phone, msg('cleanerWhichRoom', { roomList }));
      return;
    }
    await resolveRoomClean(ctx, cleaningRooms[0]);
  },

  // Cleaner names a specific room (e.g. after being asked which one) --
  // resolves only that room, never touches any other room in Cleaning.
  async cleanerRoomReply(ctx) {
    await resolveRoomClean(ctx, ctx.matchedCleaningRoom);
  },

  // NEW guest (or reset): greet with availability + rates, ask for details (F10)
  // 6.4: scoped to ctx.property via {Property} linked-record filter — Airtable
  // FIND/ARRAYJOIN pattern for filtering multipleRecordLinks by record ID.
  // FLAG: this filterByFormula syntax has NOT been live-tested (no Airtable
  // credential available in this Builder session) — must be confirmed via a
  // real Airtable ping / device test before merge, per Rule 1 and the 3-lens
  // diagnostic. If it's wrong, Airtable returns HTTP 200 with an empty record
  // set (not an error) — a formula bug here would silently show 0 rooms/rates
  // rather than fail loudly, so this is the single highest-risk line in 6.4.
  // A1 (flow inversion, Stage 4): stay-type (short stay vs multiple days) is now
  // asked FIRST, before any date/name capture — this replaces the old
  // greetAndAskDetails, which asked for name+dates directly and buried the
  // short-stay option in a footnote ("reply HOURLY"). No config branching
  // (locked decision): every property gets asked both options regardless of its
  // Allow Anonymous Hourly/Overnight config — availability of each path is
  // still checked where it already was (hourlyRates() fail-closed in
  // selectStayType/startHourly), just never used to skip asking the question.
  async greetAndAskStayType(ctx) {
    // F5-style: FIND/ARRAYJOIN confirmed unreliable for this filter (live-tested
    // 6.4 verification — matched 0 of 3 correctly-linked rooms). Fetch unscoped,
    // filter by property inclusion in JS, same pattern as airtableGetBookingsByGuestId.
    const allAvailableRooms = await airtableGet('WS_Rooms', `{Status} = 'Available'`);
    const availableRooms = allAvailableRooms.filter(r => (r.fields['Property'] || []).includes(ctx.property.id));
    const roomCount = availableRooms.length;

    // Data-quality signal: rows with an empty Property field never match the
    // scoped filter above and so silently vanish from every property's greeting.
    // Schema can't force this field non-empty, so surface gaps instead of guessing.
    // Rates are checked here too (even though rateText itself now builds later,
    // in selectStayType) so this diagnostic still fires on every first contact,
    // unchanged from before the reorder.
    const unassignedRooms = await airtableGet('WS_Rooms', `AND({Status} = 'Available', {Property} = BLANK())`);
    const unassignedRates = await airtableGet('WS_Rates', `AND({Active} = TRUE(), {Property} = BLANK())`);
    if (unassignedRooms.length > 0 || unassignedRates.length > 0) {
      logToAxiom('warn', 'property_unassigned_rows', {
        phone: ctx.phone,
        propertyId: ctx.property.id,
        unassignedRoomCount: unassignedRooms.length,
        unassignedRateCount: unassignedRates.length
      });
    }

    if (!ctx.guest) {
      // Rule 30 step 2, slice 2: same NON-FATAL class as updateGuestState — a
      // failed first-contact create just means the guest's next message hits
      // this same !ctx.guest branch again (WS_Guests re-queried fresh on
      // every inbound message), self-correcting rather than compounding.
      const guestCreate = await airtableCreate('WS_Guests', {
        'Guest Name': 'Unknown',
        'Phone Number': ctx.phone,
        'Guest Type': 'WhatsApp',
        'Session State': ctx.next,
        'First Visit': new Date().toISOString().split('T')[0]
      });
      if (guestCreate && guestCreate.error) {
        logToAxiom('error', 'guest_state_write_failed', {
          phone: ctx.phone, fields: { 'Session State': ctx.next }, error: JSON.stringify(guestCreate.error)
        });
      }
    } else {
      await updateGuestState(ctx.guest.id, { 'Session State': ctx.next });
    }

    await sendWhatsApp(ctx.phone, msg('greeting', {
      propertyName: ctx.property.fields['Property Name'],
      propertyCityLine: propertyCityLine(ctx.property),
      roomCountText: `${roomCount} room${roomCount !== 1 ? 's' : ''}`
    }));
  },

  // AWAITING_STAY_TYPE: the guest's answer to "short stay or multiple days?".
  // Branches to a rate menu SCOPED to that answer only (never both types in one
  // message, locked decision) then continues into the existing capture flow for
  // that type — collectHourlyDetails (unchanged) for short stay, collectDetails
  // (unchanged) for multiple days. Both rate fetches below reuse the exact same
  // functions/queries B2/F19 (rate-fix) already established: hourlyRates() for
  // short stay, the WS_Rates active+property-scoped fetch (previously inline in
  // greetAndAskDetails) for overnight — no new pricing logic written here.
  //
  // "next" in states.json for this state is a nominal default only, same
  // convention startHourly already uses for its own fail-closed branch: this
  // handler always writes an explicit, hardcoded Session State on every real
  // path below, never ctx.next.
  async selectStayType(ctx) {
    const guestName = ctx.guest.fields['Guest Name'];
    const SHORT_STAY_CHOICES = ['1', 'short stay', 'short'];
    const MULTI_DAY_CHOICES = ['2', 'multiple days', 'multi-day', 'multiday', 'overnight'];

    if (SHORT_STAY_CHOICES.includes(ctx.text)) {
      const rates = hourlyRates(ctx.property);
      if (!rates) {
        // Same fail-closed posture as startHourly's own equivalent branch —
        // property has not configured short stays. Route to the overnight
        // path rather than dead-ending, zero rate quoted.
        logToAxiom('info', 'hourly_not_configured', { phone: ctx.phone, propertyId: ctx.property.id });
        await updateGuestState(ctx.guest.id, { 'Session State': 'AWAITING_DETAILS', 'Last Inbound At': new Date().toISOString() });
        await sendWhatsApp(ctx.phone, msg('hourlyUnavailable', {
          propertyName: ctx.property.fields['Property Name']
        }));
        return;
      }

      await updateGuestState(ctx.guest.id, { 'Session State': 'AWAITING_HOURLY_DETAILS', 'Last Inbound At': new Date().toISOString() });
      const hourlyRateText = HOURLY_DURATIONS
        .map(hours => `• ${hours} hour${hours === 1 ? '' : 's'}: R${rates[hours]}`)
        .join('\n');
      await sendWhatsApp(ctx.phone, msg('hourlyRatesMenu', {
        propertyName: ctx.property.fields['Property Name'],
        hourlyRateText
      }));
      await sendWhatsApp(ctx.phone, msg('hourlyAskDetails', {
        propertyName: ctx.property.fields['Property Name']
      }));
      return;
    }

    if (MULTI_DAY_CHOICES.includes(ctx.text)) {
      // Same fetch as the old greetAndAskDetails rateText build — F4/F5-style,
      // unfiltered fetch + JS filter by Property inclusion, unchanged.
      const allActiveRates = await airtableGet('WS_Rates', `{Active} = TRUE()`);
      const activeRates = allActiveRates.filter(r => (r.fields['Property'] || []).includes(ctx.property.id));
      const rateText = activeRates.length > 0
        ? activeRates.map(r =>
            `• ${r.fields['Rate Name']}: R${r.fields['Amount']} ${r.fields['Rate Type'] === 'Per Night' ? 'per night' : 'per hour'}`
          ).join('\n')
        : '• Contact us for current rates';

      await updateGuestState(ctx.guest.id, { 'Session State': 'AWAITING_DETAILS', 'Last Inbound At': new Date().toISOString() });
      await sendWhatsApp(ctx.phone, msg('overnightRatesMenu', {
        propertyName: ctx.property.fields['Property Name'],
        rateText
      }));
      return;
    }

    // Unreadable answer — zero writes, same re-prompt-in-place pattern as
    // selectOccupancy's own invalid-answer branch.
    await sendWhatsApp(ctx.phone, msg('stayTypeReprompt', { guestName }));
  },

  // AWAITING_DETAILS: parse name + dates, create Enquiry booking (F7, F13)
  async collectDetails(ctx) {
    const now = new Date();
    const rawText = ctx.messageText.trim();

    // F20 (parser robustness): find date-shaped tokens anywhere in the message —
    // one line or three. The first two are check-in / check-out; whatever precedes
    // the first date token is the name. Replaces the old per-line month-SUBSTRING
    // classifier, which required each field on its own line and ate names that
    // merely contained a month fragment. parseBookingDate below still validates.
    const dateTokens = findDateTokens(rawText);
    let checkIn = dateTokens[0] ? dateTokens[0].text : null;
    let checkOut = dateTokens[1] ? dateTokens[1].text : null;

    // A returning guest already has a name — parse dates only, never re-derive it.
    // Otherwise the name is the text before the first date token (newline- or
    // space-separated), collapsed to a single line.
    let guestName = ctx.guest.fields['Guest Name'] !== 'Unknown' ? ctx.guest.fields['Guest Name'] : null;
    if (!guestName) {
      const beforeFirstDate = dateTokens[0] ? rawText.slice(0, dateTokens[0].start) : rawText;
      guestName = beforeFirstDate.replace(/\s+/g, ' ').trim() || null;
    }

    // B8: check-out is now required. B7 allowed a check-in-only booking that
    // rendered as "TBC"; once a booking holds a room, one with no check-out
    // holds it against a range the overlap check cannot see, re-introducing the
    // double-booking B8 exists to prevent — via a rarer door. The greeting has
    // always asked for all three; this is the code enforcing what the copy says.
    if (!guestName || !checkIn || !checkOut) {
      // B19: the parser rejected this input (bot re-prompted) → Invalid Input.
      // Partial row: dates blank if not given. Deduped so repeated fumbles in one
      // attempt collapse to a single Invalid Input row.
      await logEnquiry(ctx.property, ctx.phone, 'Invalid Input', { bookingType: 'Overnight' });
      // Stay in AWAITING_DETAILS — reprompt only
      await sendWhatsApp(ctx.phone, msg('detailsReprompt'));
      return;
    }

    // B7: a line can look like a date to the classifier above and still not be
    // one. Parse before any write so an unusable date re-prompts (no writes,
    // same as the garbage path) rather than creating a booking whose structured
    // dates are absent or wrong — B8's overlap check is only as good as these.
    // The raw text keeps feeding Notes and the guest/owner copy untouched;
    // these parsed values are additional, not a replacement.
    const checkInDate = parseBookingDate(checkIn, now);
    const checkOutDate = parseBookingDate(checkOut, now);
    const datesUnusable = !checkInDate
      || !checkOutDate
      // Overnight stays span at least one night: 14:00 → 10:00 on a reversed or
      // same-day range is a negative stay, and would poison B8 (CEO 16 July).
      || compareYmd(checkOutDate, checkInDate) <= 0;
    if (datesUnusable) {
      logToAxiom('info', 'booking_date_unparsed', {
        phone: ctx.phone,
        checkInText: checkIn,
        checkOutText: checkOut || null
      });
      await logEnquiry(ctx.property, ctx.phone, 'Invalid Input', { bookingType: 'Overnight' });
      await sendWhatsApp(ctx.phone, msg('detailsReprompt'));
      return;
    }

    const checkInIso = sastToUtcIso(checkInDate, OVERNIGHT_CHECKIN_HOUR);
    const checkOutIso = sastToUtcIso(checkOutDate, OVERNIGHT_CHECKOUT_HOUR);

    // B8: the real double-booking fix — decided here, at enquiry, not at the gate.
    // Before this, the first collision anyone noticed was two guests at the door.
    // Refusing costs nothing and writes nothing; the guest keeps their turn in
    // AWAITING_DETAILS and can offer different dates.
    const room = await findAvailableRoom(ctx.property.id, checkInIso, checkOutIso);
    if (!room) {
      logToAxiom('info', 'booking_no_availability', {
        phone: ctx.phone,
        propertyId: ctx.property.id,
        checkIn: checkInIso,
        checkOut: checkOutIso
      });
      // B19: the revenue-relevant one — a real request refused by B8. Captures the
      // dates so the weekly summary can say "turned away, no room free".
      await logEnquiry(ctx.property, ctx.phone, 'No Availability', {
        checkInIso, checkOutIso, bookingType: 'Overnight'
      });
      await sendWhatsApp(ctx.phone, msg('noAvailability', { guestName, checkIn, checkOut }));
      return;
    }

    await updateGuestState(ctx.guest.id, {
      'Guest Name': guestName,
      'Session State': ctx.next,
      'Last Inbound At': now.toISOString() // B19: staleness anchor for the abandonment sweep
    }, { phone: ctx.phone });

    // F19 (Rate-fix): the rate is NOT chosen here any more. It was `activeRates[0]`
    // — no sort, no filter — so pricing was silently position-dependent: reorder the
    // WS_Rates view and every couple's price flipped with zero code change and zero
    // signal. Rate selection now waits for the occupancy answer (AWAITING_OCCUPANCY →
    // selectOccupancy), which matches on {Occupancy Type} rather than array position.
    // The booking is created here, unpriced, with the room already held — so the
    // occupancy question is answered against a real, blocking hold, and Amount Due /
    // Rate Applied are filled in the next step.
    const bookingData = {
      'Guest': [ctx.guest.id],
      'Booking Type': 'Overnight',
      'Source': 'WhatsApp',
      'Status': 'Enquiry',
      'Logged By': 'WhatsApp Bot',
      'Notes': `Check-in: ${checkIn}${checkOut ? ' | Check-out: ' + checkOut : ''}`,
      'Payment Status': 'Unpaid'
    };
    // B7: structured dates in addition to the Notes string above, which keeps its
    // exact pre-B7 format — it is the human-readable record of what the guest
    // actually typed, and these fields are what B8 queries.
    bookingData['Check In'] = checkInIso;
    bookingData['Check Out'] = checkOutIso;
    // B8: hold the room from this moment. Room Status deliberately stays as it
    // is — the guest is not in the room yet, and a hold is not occupancy.
    bookingData['Room'] = [room.id];

    const booking = await airtableCreate('WS_Bookings', bookingData);
    const bookingRef = booking.id ? `WS-${booking.id.slice(-6).toUpperCase()}` : 'WS-000001';
    // F13: write Booking Ref back to Airtable after CREATE
    if (booking.id) {
      // P1a: Airtable is not transactional (CLAUDE.md rule 32) — the
      // findAvailableRoom check above and this create are two separate calls,
      // and this is a WhatsApp-facing path with real concurrency (unlike
      // walkinBooking's single reception handset). Two guests racing the same
      // dates can both pass the pre-check before either's create lands. Ported
      // from walkinBooking's rollback pattern: re-verify excluding this
      // booking's own hold, and if the room did not survive, cancel rather than
      // let two Confirmed bookings exist on the same room discovered only at
      // the gate.
      const stillFree = await findAvailableRoom(ctx.property.id, checkInIso, checkOutIso, {
        excludeBookingId: booking.id, preferRoomId: room.id
      });
      if (!stillFree || stillFree.id !== room.id) {
        // Unlike walkinBooking's line-1556 rollback, THIS write is checked —
        // Rule 30 / PR3's finding applies to new code from the moment it's
        // written, not just to the handler that surfaced the bug.
        const rollback = await airtableUpdate('WS_Bookings', booking.id, { 'Status': 'Cancelled' });
        if (rollback && rollback.error) {
          // No clean recovery left at this point — the booking exists, holds a
          // room that may now be double-held, and the write meant to fix that
          // has itself failed. Nothing to do but make it maximally visible.
          logToAxiom('error', 'booking_rollback_failed', {
            phone: ctx.phone, bookingId: booking.id, roomId: room.id,
            error: JSON.stringify(rollback.error),
            reason: 'lost the availability race AND the Cancelled write failed — booking may still be holding a contested room'
          });
        }
        // The guest's Session State was already advanced to AWAITING_OCCUPANCY
        // above, before this booking existed to occupy that state. Leaving them
        // there with no valid booking is the same stuck-loop symptom PR1 exists
        // to prevent, just reached via the race instead of a create failure —
        // so it is reset here rather than left for PR4, which owns the
        // create-fails-outright case, not this one.
        await updateGuestState(ctx.guest.id, { 'Session State': 'AWAITING_DETAILS', 'Last Inbound At': new Date().toISOString() });
        logToAxiom('warn', 'booking_race_lost', {
          phone: ctx.phone, bookingId: booking.id, roomId: room.id,
          checkIn: checkInIso, checkOut: checkOutIso,
          reason: 'room taken by a concurrent booking between the pre-check and this create'
        });
        await logEnquiry(ctx.property, ctx.phone, 'No Availability', {
          checkInIso, checkOutIso, bookingType: 'Overnight'
        });
        await sendWhatsApp(ctx.phone, msg('noAvailability', { guestName, checkIn, checkOut }));
        return;
      }

      // Rule 30 step 2, slice 1: checked but non-fatal, same shape as
      // walkinBooking's identical Booking Ref writeback (F40) — bookingRef is
      // computed locally and used in every message/log regardless of whether
      // this PATCH lands, so a failure here is cosmetic, not a booking failure.
      const refWrite = await airtableUpdate('WS_Bookings', booking.id, { 'Booking Ref': bookingRef });
      if (refWrite && refWrite.error) {
        logToAxiom('warn', 'collectdetails_bookingref_writeback_failed', {
          phone: ctx.phone, bookingId: booking.id, bookingRef, error: JSON.stringify(refWrite.error)
        });
      }
      // B19: Booked, logged at creation. recordEta re-affirms on confirmation but
      // the booking-id dedup keeps it to one row.
      await logEnquiry(ctx.property, ctx.phone, 'Booked', {
        checkInIso, checkOutIso, bookingType: 'Overnight', bookingId: booking.id
      });
    }
    logToAxiom(booking.id ? 'info' : 'error', 'booking_create', {
      phone: ctx.phone,
      guestName,
      bookingRef,
      airtableId: booking.id || null,
      error: booking.error ? JSON.stringify(booking.error) : null
    });

    // F41-4 (fix-order item 4): the create itself failed outright — no room was
    // held, no booking exists. Session State was already written to ctx.next
    // above, before this create ran, so left unhandled the guest silently
    // stayed in AWAITING_OCCUPANCY with nothing behind it — selectOccupancy's
    // next turn finds no matching Enquiry row and just re-prompts forever,
    // with no path back to AWAITING_DETAILS. Reset here, tell the guest
    // plainly, and skip the owner notify — there is nothing for the owner to
    // action.
    if (!booking.id) {
      await updateGuestState(ctx.guest.id, { 'Session State': 'AWAITING_DETAILS', 'Last Inbound At': new Date().toISOString() });
      await sendWhatsApp(ctx.phone, msg('bookingCreateFailed', { guestName }));
      return;
    }

    // F7: notify owner on new booking (owner copy carries no rate, so it is
    // correct to send before occupancy is chosen — the human owner sees the
    // enquiry immediately and can finalise price if the fail-closed path fires).
    if (OWNER_PHONE) {
      logOwnerSendWindow('new_booking', OWNER_PHONE, ctx.phone); // B17 instrumentation
      // Rule 30 step 2, slice 2: checked but non-fatal — courtesy notification,
      // the guest already got their own occupancyMenu reply independent of this.
      const ownerSend = await sendWhatsApp(OWNER_PHONE, msg('ownerNewBooking', {
        guestName, phone: ctx.phone, bookingRef, checkIn, checkOut: checkOut || 'TBC'
      }));
      if (ownerSend && ownerSend.error) {
        logToAxiom('error', 'owner_new_booking_notify_failed', {
          bookingId: booking.id, error: JSON.stringify(ownerSend.error)
        });
      }
    }

    // F19: ask occupancy (numbered menu, Rule 11) instead of confirming the
    // booking — the rate depends on the answer, so bookingReceived now fires from
    // selectOccupancy once a rate has been matched.
    await sendWhatsApp(ctx.phone, msg('occupancyMenu', { guestName }));
  },

  // AWAITING_OCCUPANCY: F19 (Rate-fix). Map the numbered occupancy answer to an
  // {Occupancy Type} and select the matching WS_Rates row by that field — NEVER
  // by array position. Fail closed: if no rate row matches the chosen occupancy
  // for this property, do not fall back to activeRates[0]; route to a contact-the-
  // owner message and never quote a price picked by position.
  async selectOccupancy(ctx) {
    const OCCUPANCY_BY_CHOICE = {
      '1': 'Single', 'just me': 'Single',
      '2': 'Couple', 'two of us': 'Couple'
    };
    const occupancyType = OCCUPANCY_BY_CHOICE[ctx.text] || null;

    // Invalid / unreadable answer — re-prompt with zero writes (mirrors the
    // hourly duration re-prompt). Resolved before any Airtable read so a bad
    // answer costs nothing and cannot write.
    if (!occupancyType) {
      await sendWhatsApp(ctx.phone, msg('occupancyMenu', { guestName: ctx.guest.fields['Guest Name'] }));
      return;
    }

    // The unpriced overnight hold collectDetails created for this guest.
    const enquiries = await airtableGetBookingsByGuestId(ctx.guest.id, 'Enquiry');
    const booking = enquiries.find(b => b.fields['Booking Type'] === 'Overnight' && b.fields['Check Out']) || null;
    if (!booking) {
      // Flow lost its footing (no pending overnight enquiry) — re-prompt rather
      // than dead-end. Still zero writes.
      await sendWhatsApp(ctx.phone, msg('occupancyMenu', { guestName: ctx.guest.fields['Guest Name'] }));
      return;
    }

    // F5-style JS filter — see greetAndAskStayType. Match on {Occupancy Type}, the
    // whole point of F19: the selection is by field value, invariant to the order
    // Airtable returns the rows in.
    const allActiveRates = await airtableGet('WS_Rates', `{Active} = TRUE()`);
    const activeRates = allActiveRates.filter(r => (r.fields['Property'] || []).includes(ctx.property.id));
    const rate = activeRates.find(r => r.fields['Occupancy Type'] === occupancyType) || null;

    const guestName = ctx.guest.fields['Guest Name'];

    if (!rate) {
      // Fail closed. No rate write, no positional fallback. Advance to
      // AWAITING_ETA so the (already owner-notified) booking can still complete;
      // the owner finalises the price offline.
      logToAxiom('warn', 'occupancy_no_matching_rate', {
        phone: ctx.phone, propertyId: ctx.property.id, occupancyType
      });
      await updateGuestState(ctx.guest.id, { 'Session State': ctx.next, 'Last Inbound At': new Date().toISOString() });
      await sendWhatsApp(ctx.phone, msg('occupancyContactOwner', { guestName }));
      return;
    }

    // Rule 30 step 2, slice 1: FATAL on failure — this write sets the price the
    // guest is about to be told and billed, so an unchecked failure here would
    // confirm a booking at a rate that was never actually saved. Session State
    // is deliberately NOT advanced on failure, so the guest's next "1"/"2" reply
    // re-runs this same handler rather than landing in AWAITING_ETA with no
    // rate behind it.
    const rateWrite = await airtableUpdate('WS_Bookings', booking.id, {
      'Rate Applied': [rate.id],
      'Amount Due': rate.fields['Amount']
    });
    if (rateWrite && rateWrite.error) {
      logToAxiom('error', 'occupancy_rate_write_failed', {
        phone: ctx.phone, bookingId: booking.id, occupancyType,
        amount: rate.fields['Amount'], error: JSON.stringify(rateWrite.error)
      });
      await sendWhatsApp(ctx.phone, msg('occupancyWriteFailed', { guestName }));
      return;
    }
    await updateGuestState(ctx.guest.id, { 'Session State': ctx.next, 'Last Inbound At': new Date().toISOString() });
    logToAxiom('info', 'occupancy_selected', {
      phone: ctx.phone, guestId: ctx.guest.id, occupancyType, amount: rate.fields['Amount']
    });

    const { checkIn, checkOut } = checkDatesFromNotes(booking.fields['Notes']);
    const bookingRef = booking.fields['Booking Ref']
      || (booking.id ? `WS-${booking.id.slice(-6).toUpperCase()}` : 'WS-000001');
    await sendWhatsApp(ctx.phone, msg('bookingReceived', {
      guestName, bookingRef, checkIn, checkOut,
      rateLine: `*Rate:* R${rate.fields['Amount']} per night`
    }));
  },

  // NEW / AWAITING_DETAILS + "HOURLY": enter the short-stay flow (closes F10 —
  // the keyword has been a placeholder since WS1 and fell through to the
  // overnight re-prompt). Wired into AWAITING_DETAILS as well as NEW because the
  // greeting that advertises HOURLY is itself what moves the guest out of NEW,
  // so almost every real guest types it from AWAITING_DETAILS.
  async startHourly(ctx) {
    const rates = hourlyRates(ctx.property);
    if (!rates) {
      // Property has not configured short stays — fail closed, never quote R0.
      logToAxiom('info', 'hourly_not_configured', { phone: ctx.phone, propertyId: ctx.property.id });
      if (ctx.guest) {
        await updateGuestState(ctx.guest.id, { 'Session State': 'AWAITING_DETAILS', 'Last Inbound At': new Date().toISOString() });
      } else {
        // Rule 30 step 2, slice 2: same NON-FATAL class, same reasoning as
        // greetAndAskStayType's equivalent first-contact create.
        const guestCreate = await airtableCreate('WS_Guests', {
          'Guest Name': 'Unknown',
          'Phone Number': ctx.phone,
          'Guest Type': 'WhatsApp',
          'Session State': 'AWAITING_DETAILS',
          'Last Inbound At': new Date().toISOString(),
          'First Visit': new Date().toISOString().split('T')[0]
        });
        if (guestCreate && guestCreate.error) {
          logToAxiom('error', 'guest_state_write_failed', {
            phone: ctx.phone, fields: { 'Session State': 'AWAITING_DETAILS' }, error: JSON.stringify(guestCreate.error)
          });
        }
      }
      await sendWhatsApp(ctx.phone, msg('hourlyUnavailable', {
        propertyName: ctx.property.fields['Property Name']
      }));
      return;
    }

    if (ctx.guest) {
      await updateGuestState(ctx.guest.id, { 'Session State': ctx.next, 'Last Inbound At': new Date().toISOString() });
    } else {
      // Rule 30 step 2, slice 2: same NON-FATAL class, same reasoning as
      // greetAndAskStayType's equivalent first-contact create.
      const guestCreate = await airtableCreate('WS_Guests', {
        'Guest Name': 'Unknown',
        'Phone Number': ctx.phone,
        'Guest Type': 'WhatsApp',
        'Session State': ctx.next,
        'Last Inbound At': new Date().toISOString(),
        'First Visit': new Date().toISOString().split('T')[0]
      });
      if (guestCreate && guestCreate.error) {
        logToAxiom('error', 'guest_state_write_failed', {
          phone: ctx.phone, fields: { 'Session State': ctx.next }, error: JSON.stringify(guestCreate.error)
        });
      }
    }
    await sendWhatsApp(ctx.phone, msg('hourlyAskDetails', {
      propertyName: ctx.property.fields['Property Name']
    }));
  },

  // AWAITING_HOURLY_DETAILS: name + arrival time, then offer the duration menu.
  // Duration is a separate state because a numbered menu cannot share a message
  // with free text — "2" must mean two hours, never part of a name or a time.
  async collectHourlyDetails(ctx) {
    const lines = ctx.messageText.trim().split('\n').map(l => l.trim()).filter(Boolean);
    let guestName = ctx.guest.fields['Guest Name'] !== 'Unknown' ? ctx.guest.fields['Guest Name'] : null;
    let arrival = null;
    let ambiguousHour = null;

    for (const line of lines) {
      const parsed = parseArrivalTime(line);
      if (parsed && parsed.ambiguous !== undefined) {
        if (ambiguousHour === null) ambiguousHour = parsed.ambiguous;
      } else if (parsed && !arrival) {
        arrival = parsed;
      } else if (!parsed && !guestName) {
        guestName = line;
      }
    }

    if (!arrival && ambiguousHour !== null) {
      // Stay in AWAITING_HOURLY_DETAILS — ask which half of the clock they meant.
      await sendWhatsApp(ctx.phone, msg('hourlyTimeAmbiguous', { value: ambiguousHour }));
      return;
    }
    if (!guestName || !arrival) {
      await sendWhatsApp(ctx.phone, msg('hourlyDetailsReprompt'));
      return;
    }

    // An arrival time already past today means the next occurrence of that time,
    // same principle as B7's year-roll: guests book the future, and a bookable
    // answer beats a re-prompt. The confirmation always states the full date, so
    // a roll to tomorrow is visible rather than silent.
    const now = new Date();
    const today = sastCalendarDate(now);
    let arrivalDate = today;
    if (Date.parse(sastToUtcIso(today, arrival.hour, arrival.minute)) <= now.getTime()) {
      arrivalDate = addSastDays(today, 1);
    }
    const checkInIso = sastToUtcIso(arrivalDate, arrival.hour, arrival.minute);

    const rates = hourlyRates(ctx.property);
    if (!rates) {
      // Rates removed mid-conversation — same fail-closed redirect as entry.
      await updateGuestState(ctx.guest.id, { 'Session State': 'AWAITING_DETAILS', 'Last Inbound At': new Date().toISOString() });
      await sendWhatsApp(ctx.phone, msg('hourlyUnavailable', { propertyName: ctx.property.fields['Property Name'] }));
      return;
    }

    await updateGuestState(ctx.guest.id, {
      'Guest Name': guestName,
      'Session State': ctx.next,
      'Last Inbound At': new Date().toISOString() // B19: staleness anchor for the abandonment sweep
    }, { phone: ctx.phone });

    // The duration menu arrives as a separate WhatsApp message — a separate
    // serverless invocation with no shared memory — so the arrival time has to
    // be persisted. It goes on a booking record rather than scratch storage,
    // the same way WS1 parks the ETA: this row IS the guest's booking, just not
    // yet priced. With Check Out still blank it holds no room and blocks
    // nothing (B8's blank-date rule), so an abandoned one is inert rather than
    // phantom inventory. Reused rather than duplicated if the guest re-enters
    // a time after being told there is no availability.
    const pending = await findPendingHourlyBooking(ctx.guest.id);
    const bookingResult = pending
      ? await airtableUpdate('WS_Bookings', pending.id, { 'Check In': checkInIso })
      : await airtableCreate('WS_Bookings', {
          'Guest': [ctx.guest.id],
          'Booking Type': 'Hourly',
          'Source': 'WhatsApp',
          'Status': 'Enquiry',
          'Logged By': 'WhatsApp Bot',
          'Check In': checkInIso,
          'Payment Status': 'Unpaid'
        });

    // F41-4: same unchecked-write pattern as collectDetails, same fix shape.
    // Previously this return value was discarded entirely — a failed write
    // left the guest advanced to AWAITING_HOURLY_DURATION with no pending row
    // behind it. selectHourlyDuration's own missing-checkInIso guard would
    // eventually catch this on the guest's NEXT message, but silently — no
    // log, no explanation, a round-trip of confusion before self-healing.
    if (!bookingResult || !bookingResult.id) {
      logToAxiom('error', 'hourly_booking_write_failed', {
        phone: ctx.phone, guestName,
        error: bookingResult && bookingResult.error ? JSON.stringify(bookingResult.error) : null
      });
      await updateGuestState(ctx.guest.id, { 'Session State': 'AWAITING_DETAILS', 'Last Inbound At': new Date().toISOString() });
      await sendWhatsApp(ctx.phone, msg('hourlyBookingCreateFailed', { guestName }));
      return;
    }

    await sendWhatsApp(ctx.phone, msg('hourlyDurationMenu', {
      guestName,
      arrivalText: formatSastDateTime(checkInIso),
      rate1: rates[1], rate2: rates[2], rate3: rates[3]
    }));
  },

  // AWAITING_HOURLY_DURATION: 1/2/3 creates the booking; 4+ redirects to overnight.
  async selectHourlyDuration(ctx) {
    const choice = Number(ctx.text.replace(/\s*(hours?|hrs?)\s*$/, '').trim());
    const pending = await findPendingHourlyBooking(ctx.guest.id);
    const rates = hourlyRates(ctx.property);

    if (choice > 3 && Number.isInteger(choice)) {
      // Locked decision: >3hr is an overnight stay, not an error and not a
      // fourth hourly option. Cancel the half-built hourly booking on the way
      // out so the guest does not end up with two open Enquiry rows, which
      // would make recordEta ambiguous about which one to confirm.
      // Rule 30 step 2, slice 1: checked but non-fatal, same shape as the
      // rollback writes elsewhere in this handler — cancelling a half-built
      // hold is cleanup, not the guest's actual outcome (they're being
      // redirected to overnight regardless), so a failed cancel is logged
      // loud rather than blocking the redirect.
      if (pending) {
        const cancelWrite = await airtableUpdate('WS_Bookings', pending.id, { 'Status': 'Cancelled' });
        if (cancelWrite && cancelWrite.error) {
          logToAxiom('error', 'hourly_redirect_cancel_failed', {
            phone: ctx.phone, bookingId: pending.id, error: JSON.stringify(cancelWrite.error)
          });
        }
      }
      await updateGuestState(ctx.guest.id, { 'Session State': 'AWAITING_DETAILS', 'Last Inbound At': new Date().toISOString() });
      logToAxiom('info', 'hourly_redirect_overnight', { phone: ctx.phone, requestedHours: choice });
      await sendWhatsApp(ctx.phone, msg('hourlyTooLong'));
      return;
    }

    const checkInIso = pending && pending.fields['Check In'];
    if (!Number.isInteger(choice) || choice < 1 || !checkInIso || !rates) {
      // Unreadable choice, or the flow lost its footing (no pending booking,
      // rates pulled mid-conversation). Re-offer rather than dead-end.
      if (!checkInIso || !rates) {
        await updateGuestState(ctx.guest.id, { 'Session State': 'AWAITING_DETAILS', 'Last Inbound At': new Date().toISOString() });
        await sendWhatsApp(ctx.phone, msg('hourlyUnavailable', { propertyName: ctx.property.fields['Property Name'] }));
        return;
      }
      await sendWhatsApp(ctx.phone, msg('hourlyDurationMenu', {
        guestName: ctx.guest.fields['Guest Name'],
        arrivalText: formatSastDateTime(checkInIso),
        rate1: rates[1], rate2: rates[2], rate3: rates[3]
      }));
      return;
    }

    const checkOutIso = addHoursToIso(checkInIso, choice);
    const amount = rates[choice];
    const guestName = ctx.guest.fields['Guest Name'];

    // Same availability helper as overnight, unforked — this is what makes an
    // hourly booking block an overnight one on the same room and vice versa.
    const room = await findAvailableRoom(ctx.property.id, checkInIso, checkOutIso);
    if (!room) {
      logToAxiom('info', 'hourly_no_availability', {
        phone: ctx.phone, propertyId: ctx.property.id, checkIn: checkInIso, checkOut: checkOutIso
      });
      // Booking stays pending with Check Out blank — inert, and reused when the
      // guest offers a different time.
      await updateGuestState(ctx.guest.id, { 'Session State': 'AWAITING_HOURLY_DETAILS', 'Last Inbound At': new Date().toISOString() });
      // B19: B9's hourly availability check refused — turned away, Hourly.
      await logEnquiry(ctx.property, ctx.phone, 'No Availability', {
        checkInIso, checkOutIso, bookingType: 'Hourly'
      });
      await sendWhatsApp(ctx.phone, msg('hourlyNoAvailability', {
        guestName,
        checkInText: formatSastDateTime(checkInIso),
        checkOutText: formatSastDateTime(checkOutIso)
      }));
      return;
    }

    // Completes the pending row rather than creating a second one: Check Out and
    // the room hold are what turn it from inert into a real, blocking booking.
    const bookingRef = `WS-${pending.id.slice(-6).toUpperCase()}`;
    // Rule 30 step 2, slice 1: FATAL on failure — this is the write that sells
    // the room and sets the price (Amount Due), the hourly-flow analog of
    // walkinBooking's checked create (F40). Checked BEFORE the stillFree
    // re-check below: if this write never landed, there is nothing to
    // re-verify or roll back, and running that check anyway would misreport
    // a race loss for what is actually a write failure.
    const confirmWrite = await airtableUpdate('WS_Bookings', pending.id, {
      'Check Out': checkOutIso,
      'Room': [room.id],
      'Booking Ref': bookingRef,
      // The row was created as 'Enquiry' (a half-built hold) and this is the
      // point it becomes a real booking — so it must reach 'Confirmed' here, the
      // same status recordEta gives an overnight booking when its session moves
      // to CONFIRMED. Leaving it 'Enquiry' broke the invariant that a CONFIRMED
      // session has a Confirmed booking, and both `cancelBooking` and
      // `gateArrival` query strictly on 'Confirmed': the guest was told their
      // booking was cancelled while the row survived, still holding its room via
      // BLOCKING_BOOKING_STATUSES, and an arriving guest matched no booking and
      // fell through to the legacy first-available-room branch.
      'Status': 'Confirmed',
      'Notes': `Short stay: ${durationText(choice)} from ${formatSastDateTime(checkInIso)}`,
      // Amount Due carries the price. Rate Applied is deliberately left empty:
      // it links to WS_Rates, and hourly prices live as WS_Properties fields,
      // which cannot be linked to. Blank, not dangling — B17 aggregates on
      // Amount Due, which is populated for every booking type.
      'Amount Due': amount
    });
    if (confirmWrite && confirmWrite.error) {
      logToAxiom('error', 'hourly_confirm_write_failed', {
        phone: ctx.phone, bookingId: pending.id, roomId: room.id, amount,
        error: JSON.stringify(confirmWrite.error)
      });
      await sendWhatsApp(ctx.phone, msg('hourlyBookingCreateFailed', { guestName }));
      return;
    }

    // P1a: the write above is what puts this booking on the room (Room + Status
    // Confirmed in one call) — no intermediate Enquiry step the way overnight
    // has, so this is the SAME moment overnight's create happens, just phrased
    // as an update to the pending row. Same race, same fix: re-verify excluding
    // this booking's own hold before treating the room as genuinely secured.
    const stillFree = await findAvailableRoom(ctx.property.id, checkInIso, checkOutIso, {
      excludeBookingId: pending.id, preferRoomId: room.id
    });
    if (!stillFree || stillFree.id !== room.id) {
      const rollback = await airtableUpdate('WS_Bookings', pending.id, { 'Status': 'Cancelled' });
      if (rollback && rollback.error) {
        logToAxiom('error', 'booking_rollback_failed', {
          phone: ctx.phone, bookingId: pending.id, roomId: room.id,
          error: JSON.stringify(rollback.error),
          reason: 'lost the availability race AND the Cancelled write failed — booking may still be holding a contested room'
        });
      }
      // Same re-offer the existing no-availability branch above uses (line
      // ~2139) — the booking stays inert with Check Out cleared conceptually
      // by virtue of being Cancelled, and the guest can offer a different time.
      await updateGuestState(ctx.guest.id, { 'Session State': 'AWAITING_HOURLY_DETAILS', 'Last Inbound At': new Date().toISOString() });
      logToAxiom('warn', 'booking_race_lost', {
        phone: ctx.phone, bookingId: pending.id, roomId: room.id,
        checkIn: checkInIso, checkOut: checkOutIso,
        reason: 'room taken by a concurrent booking between the pre-check and this update'
      });
      await logEnquiry(ctx.property, ctx.phone, 'No Availability', {
        checkInIso, checkOutIso, bookingType: 'Hourly'
      });
      await sendWhatsApp(ctx.phone, msg('hourlyNoAvailability', {
        guestName,
        checkInText: formatSastDateTime(checkInIso),
        checkOutText: formatSastDateTime(checkOutIso)
      }));
      return;
    }

    logToAxiom('info', 'booking_create', {
      phone: ctx.phone, guestName, bookingRef, bookingType: 'Hourly',
      hours: choice, airtableId: pending.id
    });

    await updateGuestState(ctx.guest.id, { 'Session State': ctx.next });
    // B19: Booked, Hourly. Completed in one handler, so this is the single log site.
    await logEnquiry(ctx.property, ctx.phone, 'Booked', {
      checkInIso, checkOutIso, bookingType: 'Hourly', bookingId: pending.id
    });

    const view = {
      guestName, bookingRef, amount,
      durationText: durationText(choice),
      checkInText: formatSastDateTime(checkInIso),
      checkOutText: formatSastDateTime(checkOutIso)
    };
    if (OWNER_PHONE) {
      // Rule 30 step 2, slice 2: checked but non-fatal, same shape as
      // collectDetails' equivalent owner notify.
      const ownerSend = await sendWhatsApp(OWNER_PHONE, msg('hourlyOwnerNewBooking', { ...view, phone: ctx.phone }));
      if (ownerSend && ownerSend.error) {
        logToAxiom('error', 'owner_hourly_booking_notify_failed', {
          bookingId: pending.id, error: JSON.stringify(ownerSend.error)
        });
      }
    }
    await sendWhatsApp(ctx.phone, msg('hourlyBookingReceived', view));
  },

  // AWAITING_ETA: record ETA, confirm booking
  async recordEta(ctx) {
    const eta = ctx.messageText.trim();
    // F5: was FIND/ARRAYJOIN — now JS filter on fetched records
    const bookings = await airtableGetBookingsByGuestId(ctx.guest.id, 'Enquiry');
    const confirmedBooking = bookings[0] || null;
    // Rule 30 step 2, slice 1: FATAL on failure — this write is what moves the
    // booking from 'Enquiry' to 'Confirmed', and both cancelBooking and
    // gateArrival query strictly on 'Confirmed' (same invariant selectHourlyDuration's
    // comment above already documents). A failed write here left silently would
    // tell the guest their stay is confirmed while the booking stays invisible
    // to both of those handlers. Session State is deliberately NOT advanced on
    // failure, so the guest's next ETA message retries the same write.
    if (confirmedBooking) {
      const etaWrite = await airtableUpdate('WS_Bookings', confirmedBooking.id, {
        'ETA': eta,
        'Status': 'Confirmed'
      });
      if (etaWrite && etaWrite.error) {
        logToAxiom('error', 'eta_confirm_write_failed', {
          phone: ctx.phone, bookingId: confirmedBooking.id, error: JSON.stringify(etaWrite.error)
        });
        await sendWhatsApp(ctx.phone, msg('etaWriteFailed'));
        return;
      }
    }
    await updateGuestState(ctx.guest.id, { 'Session State': ctx.next });
    // B19: Booked, re-affirmed on confirmation — deduped by booking id, so this is
    // a no-op when collectDetails already logged it at creation, and the single
    // logging site when the booking reached AWAITING_ETA another way.
    if (confirmedBooking) {
      await logEnquiry(ctx.property, ctx.phone, 'Booked', {
        bookingType: confirmedBooking.fields['Booking Type'] || 'Overnight',
        bookingId: confirmedBooking.id
      });
    }
    logToAxiom('info', 'state_transition', { phone: ctx.phone, guestId: ctx.guest.id, from: 'AWAITING_ETA', to: ctx.next, eta });
    await sendWhatsApp(ctx.phone, msg('etaConfirmed', { eta, propertyName: ctx.property.fields['Property Name'] }));
  },

  // CONFIRMED → "1": gate arrival (F11)
  async gateArrival(ctx) {
    // Step 1: notify phone from ctx.property (resolved once at dispatch — 6.4,
    // no second WS_Properties call needed), fallback to OWNER_PHONE
    const notifyPhone = ctx.property.fields['Notify Phone']
      ? ctx.property.fields['Notify Phone'].replace(/[\s\-\+]/g, '')
      : OWNER_PHONE;

    // Step 2: settle which room this guest actually gets.
    // F5-style: see greetAndAskStayType — FIND/ARRAYJOIN confirmed unreliable, JS-filter instead
    const bookings = await airtableGetBookingsByGuestId(ctx.guest.id, 'Confirmed');
    const booking = bookings[0] || null;
    const heldRoomId = (booking && (booking.fields['Room'] || [])[0]) || null;
    const bookedIn = booking && booking.fields['Check In'];
    const bookedOut = booking && booking.fields['Check Out'];

    // B9: refuse a gate arrival before the booking's own check-in date. Without
    // this a guest could check in days early and take a room they had not booked
    // (observed live during B8 testing). Compared at SAST day granularity, and
    // deliberately one-sided — only a FUTURE check-in is refused. A guest who is
    // late is still a guest: turning them away at the gate would be worse than
    // the bug. Day granularity also avoids refusing someone who booked "today"
    // at 23:30 and arrives at 00:30, now technically the next day.
    if (bookedIn) {
      const bookedDate = sastCalendarDate(new Date(Date.parse(bookedIn)));
      const todayDate = sastCalendarDate(new Date());
      if (compareYmd(bookedDate, todayDate) > 0) {
        logToAxiom('info', 'gate_arrival_too_early', {
          phone: ctx.phone, bookingId: booking.id, checkIn: bookedIn
        });
        // No writes, no state change — the booking is untouched and the guest
        // can still arrive on the right day.
        await sendWhatsApp(ctx.phone, msg('gateTooEarly', {
          guestName: ctx.guest.fields['Guest Name'],
          bookingDate: formatSastDateTime(bookedIn)
        }));
        return;
      }
    }

    let room = null;
    if (bookedIn && bookedOut) {
      // B8: re-verify the hold rather than trust it. Airtable is not
      // transactional (CLAUDE.md), so the room held at enquiry may have been
      // taken since. preferRoomId returns the held room when it is still free
      // and re-offers a different one when it is not — never fails silently.
      room = await findAvailableRoom(ctx.property.id, bookedIn, bookedOut, {
        excludeBookingId: booking.id,
        preferRoomId: heldRoomId
      });
      if (heldRoomId && room && room.id !== heldRoomId) {
        logToAxiom('warn', 'held_room_reassigned', {
          phone: ctx.phone, bookingId: booking.id,
          heldRoomId, reassignedTo: room.id, reason: 'held room taken before arrival'
        });
      } else if (heldRoomId && !room) {
        logToAxiom('warn', 'held_room_lost_no_alternative', {
          phone: ctx.phone, bookingId: booking.id, heldRoomId
        });
      }
    } else {
      // No range to check against: a booking created before B8 (no hold, no
      // dates), or none at all. Falls through to the original F11 behaviour —
      // first physically-available room. Fixtures 06 and 07 hold this path.
      const allAvailableRoomsForArrival = await airtableGet('WS_Rooms', `{Status} = 'Available'`);
      const availableRooms = allAvailableRoomsForArrival.filter(r => (r.fields['Property'] || []).includes(ctx.property.id));
      room = availableRooms[0] || null;
    }

    const assignedRoomId = room ? room.id : null;
    const assignedRoomName = room ? room.fields['Room Name'] : null;

    // Step 3: room → Occupied. Now it really is occupancy, not a hold.
    // Rule 30 step 2, slice 1: checked but non-fatal — Status is a derived
    // display field here too, not findAvailableRoom's source of truth, so a
    // failure fails safe (room reads as still-available rather than sold).
    if (assignedRoomId) {
      const roomWrite = await airtableUpdate('WS_Rooms', assignedRoomId, { 'Status': 'Occupied' });
      if (roomWrite && roomWrite.error) {
        logToAxiom('error', 'gate_arrival_room_status_write_failed', {
          phone: ctx.phone, roomId: assignedRoomId, error: JSON.stringify(roomWrite.error)
        });
      }
    }

    // Step 4: booking → Checked In + link room + timestamp
    // Rule 30 step 2, slice 1: FATAL on failure — this is the write that
    // actually checks the guest in. A silent failure here would welcome a
    // guest into a room with no Checked-In record behind it, and Step 6b's
    // cleaner dispatch / Step 7's welcome message would both be false
    // positives. Everything past this point is skipped on failure.
    if (booking) {
      const bookingUpdate = {
        'Status': 'Checked In',
        'Checked In At': new Date().toISOString()
      };
      if (assignedRoomId) bookingUpdate['Room'] = [assignedRoomId];
      // B10.5 Bug 2: persist the property on the booking. Check-in is where the
      // property is first known for certain (ctx.property is already resolved
      // from the inbound phone_number_id), so both checkout paths can scope off
      // the record instead of re-deriving it. Single-record link → one-element array.
      bookingUpdate['WS_Property'] = [ctx.property.id];
      const checkInWrite = await airtableUpdate('WS_Bookings', booking.id, bookingUpdate);
      if (checkInWrite && checkInWrite.error) {
        logToAxiom('error', 'gate_arrival_checkin_write_failed', {
          phone: ctx.phone, bookingId: booking.id, error: JSON.stringify(checkInWrite.error)
        });
        await sendWhatsApp(ctx.phone, msg('gateArrivalWriteFailed'));
        return;
      }
    }

    // Step 5: session → CHECKED_IN
    await updateGuestState(ctx.guest.id, { 'Session State': ctx.next });
    logToAxiom('info', 'state_transition', { phone: ctx.phone, guestId: ctx.guest.id, from: 'CONFIRMED', to: ctx.next, assignedRoom: assignedRoomName || null });

    // Step 6: notify party
    if (notifyPhone) {
      logOwnerSendWindow('gate_arrival', notifyPhone, ctx.phone); // B17 instrumentation
      // Rule 30 step 2, slice 2: checked but non-fatal — courtesy notification.
      // notifyCleanerOfArrival (Step 6b, right after) is the operationally
      // load-bearing dispatch and already checks its own send properly.
      const ownerSend = await sendWhatsApp(notifyPhone, msg('gateNotify', {
        guestName: ctx.guest.fields['Guest Name'],
        roomInfo: assignedRoomName
          ? msg('gateRoomAssignedInfo', { roomName: assignedRoomName })
          : msg('gateNoRoomInfo'),
        phone: ctx.phone
      }));
      if (ownerSend && ownerSend.error) {
        logToAxiom('error', 'gate_arrival_notify_failed', {
          bookingId: booking ? booking.id : null, error: JSON.stringify(ownerSend.error)
        });
      }
    }

    // Step 6b: notify the property's cleaner. IN ADDITION to the owner send
    // above, never instead of it — the owner still gets `gateNotify` unchanged.
    // Scoped by ctx.property.id, which IS this booking's WS_Property: Step 4 above
    // writes `WS_Property: [ctx.property.id]` unconditionally, so the two agree by
    // construction. Deliberately NOT bookingPropertyId(booking, ...) here — that
    // reads the copy fetched at Step 2, BEFORE the Step 4 write, so a booking
    // carrying a stale link from a previous check-in at another property would
    // scope the cleaner to the old property while the record was updated to the
    // new one. The checkout paths have no such authority (no inbound property is
    // being written there) and correctly keep using bookingPropertyId.
    const propertyNameForCleaner = ctx.property.fields['Property Name'];
    await notifyCleanerOfArrival({
      propertyId: ctx.property.id,
      bookingId: booking ? booking.id : null,
      propertyName: propertyNameForCleaner,
      guestName: ctx.guest.fields['Guest Name'],
      roomName: assignedRoomName,
      guestPhone: ctx.phone
    });

    // Step 7: tell guest
    const propertyName = ctx.property.fields['Property Name'];
    await sendWhatsApp(ctx.phone, assignedRoomName
      ? msg('welcomeAssigned', { roomName: assignedRoomName, propertyName })
      : msg('welcomeUnassigned', { propertyName }));
  },

  // CONFIRMED → "2": cancel
  async cancelBooking(ctx) {
    // F5: was FIND/ARRAYJOIN
    const bookings = await airtableGetBookingsByGuestId(ctx.guest.id, 'Confirmed');
    // Rule 30 step 2, slice 1: FATAL on failure — telling the guest "cancelled"
    // while the booking stays Confirmed leaves it still holding its room via
    // BLOCKING_BOOKING_STATUSES with no way for the guest to know it's still
    // live. Session State is deliberately NOT advanced on failure.
    if (bookings.length > 0) {
      const cancelWrite = await airtableUpdate('WS_Bookings', bookings[0].id, { 'Status': 'Cancelled' });
      if (cancelWrite && cancelWrite.error) {
        logToAxiom('error', 'cancel_booking_write_failed', {
          phone: ctx.phone, bookingId: bookings[0].id, error: JSON.stringify(cancelWrite.error)
        });
        await sendWhatsApp(ctx.phone, msg('cancelWriteFailed'));
        return;
      }
    }
    await updateGuestState(ctx.guest.id, { 'Session State': ctx.next });
    logToAxiom('info', 'state_transition', { phone: ctx.phone, guestId: ctx.guest.id, from: 'CONFIRMED', to: ctx.next, reason: 'cancel' });
    await sendWhatsApp(ctx.phone, msg('cancelled'));
  },

  // CONFIRMED fallback menu (F9)
  async showConfirmedMenu(ctx) {
    await sendWhatsApp(ctx.phone, msg('confirmedMenu', { guestName: ctx.guest.fields['Guest Name'] }));
  },

  // CHECKED_IN → "1": checkout + cleaner dispatch
  async checkout(ctx) {
    // F14: gate cooldown guard — checkout < 60s after check-in is ignored
    const recentBookings = await airtableGetBookingsByGuestId(ctx.guest.id, 'Checked In');
    if (recentBookings.length > 0 && recentBookings[0].fields['Checked In At']) {
      const checkedInAt = new Date(recentBookings[0].fields['Checked In At']);
      const secondsSinceCheckin = (Date.now() - checkedInAt.getTime()) / 1000;
      if (secondsSinceCheckin < 60) {
        await sendWhatsApp(ctx.phone, msg('gateCooldownMenu', { guestName: ctx.guest.fields['Guest Name'], propertyName: ctx.property.fields['Property Name'] }));
        return; // stay CHECKED_IN
      }
    }
    // F5: was FIND/ARRAYJOIN
    const bookings = await airtableGetBookingsByGuestId(ctx.guest.id, 'Checked In');
    let roomName = 'your room';
    // B10.5 Bug 2: ctx.property is the fallback only — the booking's own
    // WS_Property wins when present (bookings checked in before this fix have none).
    let scopePropertyId = ctx.property.id;
    if (bookings.length > 0) {
      const booking = bookings[0];
      scopePropertyId = bookingPropertyId(booking, ctx.property.id);
      // Rule 30 step 2, slice 1: FATAL on failure — this write is what closes
      // out the stay, and its Amount Due later feeds notifyReceptionOfPayment
      // below. A silent failure here would dispatch cleaners and bill
      // reception for a checkout that never actually recorded.
      const checkoutWrite = await airtableUpdate('WS_Bookings', booking.id, {
        'Status': 'Checked Out',
        'Checkout Confirmed': true
      });
      if (checkoutWrite && checkoutWrite.error) {
        logToAxiom('error', 'checkout_write_failed', {
          phone: ctx.phone, bookingId: booking.id, error: JSON.stringify(checkoutWrite.error)
        });
        await sendWhatsApp(ctx.phone, msg('checkoutWriteFailed'));
        return;
      }
      if (booking.fields['Room'] && booking.fields['Room'].length > 0) {
        const roomId = booking.fields['Room'][0];
        const roomRecords = await airtableGet('WS_Rooms', `RECORD_ID() = '${roomId}'`);
        if (roomRecords.length > 0) {
          roomName = roomRecords[0].fields['Room Name'];
          // Rule 30 step 2, slice 1: checked but non-fatal, same shape as the
          // other room-status writes in this sweep — Status is a derived
          // display field, and cleaner dispatch below is a direct message,
          // not gated on this write succeeding. Logged loud: a failure here
          // does have a real downstream cost (senderIsCleanerNamingRoom only
          // matches rooms with Status='Cleaning', so the cleaner's own later
          // room-naming reply would silently fail to match), worth surfacing
          // even though it isn't blocked in this slice.
          const cleaningWrite = await airtableUpdate('WS_Rooms', roomId, { 'Status': 'Cleaning' });
          if (cleaningWrite && cleaningWrite.error) {
            logToAxiom('error', 'checkout_room_status_write_failed', {
              phone: ctx.phone, roomId, error: JSON.stringify(cleaningWrite.error)
            });
          }
          // Separate call, deliberately not combined with the Status update above:
          // 'Cleaning Started At' does not exist on WS_Rooms in Airtable yet (confirmed
          // live via meta API) -- Airtable rejects an entire PATCH if any field in it is
          // unrecognized, so bundling this would risk the Status transition itself
          // failing too, once the field is added and typo'd, or before it exists at all.
          // Logs an error (non-fatal) until the field is created in Airtable.
          await airtableUpdate('WS_Rooms', roomId, { 'Cleaning Started At': new Date().toISOString() });
        }
      }
    }
    // B10.5 Bug 2: was `{Active} = TRUE()` — unscoped, so every active cleaner in
    // the base was dispatched regardless of property. Now scoped to this booking's property.
    const cleaners = await activeCleanersForProperty(scopePropertyId);
    for (const cleaner of cleaners) {
      const cleanerPhone = cleaner.fields['Phone Number'];
      const cleanerName = cleaner.fields['Cleaner Name'];
      if (cleanerPhone) {
        const formattedCleanerPhone = formatPhone(cleanerPhone);
        // Rule 30 step 2, slice 2: checked but non-fatal — a missed cleaner
        // text shouldn't block reception notify or the guest's own checkout
        // confirmation below. sendWhatsApp already logs the generic
        // 'whatsapp_send_error' on failure; this adds correlation to the
        // booking/cleaner/room, matching notifyCleanerOfArrival's own
        // checked-send pattern for the equivalent gate-arrival dispatch.
        const dispatchSend = await sendWhatsApp(formattedCleanerPhone, msg('cleanerDispatch', { cleanerName, roomName }));
        if (dispatchSend && dispatchSend.error) {
          logToAxiom('error', 'cleaner_dispatch_failed', {
            bookingId: bookings[0] && bookings[0].id, cleanerId: cleaner.id, roomName,
            error: JSON.stringify(dispatchSend.error)
          });
        }
      }
    }
    // B8: tell Reception what to collect. After the booking/room writes and the
    // cleaner dispatch, so a failure here cannot cost the guest their checkout —
    // and deliberately NOT gating the cleaner dispatch on payment (the 5 Jul
    // spec proposed moving dispatch behind PAID; CEO kept it at checkout).
    if (bookings.length > 0) {
      const b = bookings[0];
      await notifyReceptionOfPayment({
        propertyId: scopePropertyId,
        bookingId: b.id,
        bookingRef: b.fields['Booking Ref'] || null,
        roomName,
        guestName: ctx.guest.fields['Guest Name'],
        amountDue: b.fields['Amount Due'],
        source: 'manual'
      });
    }

    await updateGuestState(ctx.guest.id, { 'Session State': ctx.next });
    logToAxiom('info', 'state_transition', { phone: ctx.phone, guestId: ctx.guest.id, from: 'CHECKED_IN', to: ctx.next, reason: 'checkout', roomName });
    await sendWhatsApp(ctx.phone, msg('checkoutThanks', { propertyName: ctx.property.fields['Property Name'] }));
    await sendWhatsApp(ctx.phone, msg('ratingPrompt', { propertyName: ctx.property.fields['Property Name'] }));
  },

  // AWAITING_RATING + unrecognized reply: reprompt, stay in state (mirrors
  // AWAITING_STAY_TYPE / AWAITING_DETAILS convention — required input, no
  // auto-advance to NEW, so a stray reply doesn't silently drop the rating).
  async ratingReprompt(ctx) {
    await sendWhatsApp(ctx.phone, msg('ratingReprompt'));
  },

  // AWAITING_RATING + "1".."5": write Rating on the most recent unrated
  // Checked Out booking, then branch:
  //  <=2  → optional free-text follow-up (AWAITING_RATING_FEEDBACK, skippable)
  //  ==3  → thanks, back to NEW
  //  >=4  → thanks + review-link prompt IF the property has one set, else
  //         same as ==3. No placeholder link is ever invented (CEO to confirm
  //         WS_Properties field); if the property record has no 'Review Link'
  //         field or it's blank, this step is skipped silently.
  async recordRating(ctx) {
    const rating = parseInt(ctx.text, 10);
    const booking = await findBookingAwaitingRating(ctx.guest.id);
    if (booking) {
      const ratingWrite = await airtableUpdate('WS_Bookings', booking.id, { 'Rating': rating });
      if (ratingWrite && ratingWrite.error) {
        logToAxiom('error', 'rating_write_failed', {
          phone: ctx.phone, bookingId: booking.id, rating, error: JSON.stringify(ratingWrite.error)
        });
        await updateGuestState(ctx.guest.id, { 'Session State': 'NEW' });
        await sendWhatsApp(ctx.phone, msg('ratingWriteFailed'));
        return;
      }
    } else {
      logToAxiom('error', 'rating_no_booking_found', { phone: ctx.phone, guestId: ctx.guest.id, rating });
    }

    if (rating <= 2) {
      await updateGuestState(ctx.guest.id, { 'Session State': 'AWAITING_RATING_FEEDBACK' });
      logToAxiom('info', 'state_transition', { phone: ctx.phone, guestId: ctx.guest.id, from: 'AWAITING_RATING', to: 'AWAITING_RATING_FEEDBACK', rating });
      await sendWhatsApp(ctx.phone, msg('ratingLowFollowup'));
      return;
    }

    await updateGuestState(ctx.guest.id, { 'Session State': 'NEW' });
    logToAxiom('info', 'state_transition', { phone: ctx.phone, guestId: ctx.guest.id, from: 'AWAITING_RATING', to: 'NEW', rating });

    if (rating >= 4) {
      const propertyId = bookingPropertyId(booking, ctx.property.id);
      const propertyRecord = propertyId === ctx.property.id
        ? ctx.property
        : (await airtableGet('WS_Properties', `RECORD_ID() = '${propertyId}'`))[0];
      const reviewLink = propertyRecord && propertyRecord.fields['Review Link'];
      if (reviewLink) {
        if (booking) await airtableUpdate('WS_Bookings', booking.id, { 'Review Prompted': true });
        await sendWhatsApp(ctx.phone, msg('ratingHighReviewPrompt', { reviewLink }));
      } else {
        // No Review Link set on WS_Properties for this property — skip silently.
        await sendWhatsApp(ctx.phone, msg('ratingHighThanks'));
      }
      return;
    }

    await sendWhatsApp(ctx.phone, msg('ratingMidThanks'));
  },

  // AWAITING_RATING_FEEDBACK + "skip"/"no"/"none": guest declines the optional follow-up.
  async skipRatingFeedback(ctx) {
    await updateGuestState(ctx.guest.id, { 'Session State': ctx.next });
    logToAxiom('info', 'state_transition', { phone: ctx.phone, guestId: ctx.guest.id, from: 'AWAITING_RATING_FEEDBACK', to: ctx.next, reason: 'skipped' });
  },

  // AWAITING_RATING_FEEDBACK + free text: optional follow-up for a <=2 rating.
  async recordRatingFeedback(ctx) {
    const booking = await findBookingAwaitingRatingFeedback(ctx.guest.id);
    if (booking) {
      const feedbackWrite = await airtableUpdate('WS_Bookings', booking.id, { 'Rating Feedback': ctx.messageText });
      if (feedbackWrite && feedbackWrite.error) {
        logToAxiom('error', 'rating_feedback_write_failed', {
          phone: ctx.phone, bookingId: booking.id, error: JSON.stringify(feedbackWrite.error)
        });
      }
    } else {
      logToAxiom('error', 'rating_feedback_no_booking_found', { phone: ctx.phone, guestId: ctx.guest.id });
    }
    await updateGuestState(ctx.guest.id, { 'Session State': ctx.next });
    logToAxiom('info', 'state_transition', { phone: ctx.phone, guestId: ctx.guest.id, from: 'AWAITING_RATING_FEEDBACK', to: ctx.next });
    await sendWhatsApp(ctx.phone, msg('ratingFeedbackThanks'));
  },

  // CHECKED_IN + "extend": B12. Push the checkout window out (uncapped, per the
  // 16 July lock — guests can extend repeatedly). Owner is notified on the FIRST
  // extension only (one notification per booking), tracked by the
  // `Extension Owner Notified` checkbox. Clearing `Checkout Warning Sent At`
  // re-arms the cron so a fresh warning fires when the new checkout time passes.
  async extendStay(ctx) {
    const guestName = ctx.guest.fields['Guest Name'];
    const bookings = await airtableGetBookingsByGuestId(ctx.guest.id, 'Checked In');
    const booking = bookings[0] || null;
    if (!booking || !booking.fields['Check Out']) {
      // Nothing to extend (no active booking, or a date-less legacy row).
      await sendWhatsApp(ctx.phone, msg('checkedInMenu', { guestName }));
      return;
    }

    // PR3 3a — idempotency, but NOT paidBooking's pattern, and deliberately so.
    // paidBooking can check "is Payment Status already Paid" because paying
    // twice is meaningless — there is a genuine terminal state to refuse
    // against. Extensions have no such state: they are locked (16 July) as
    // repeatable and uncapped, so "already extended" is not a valid refusal —
    // a guest who genuinely wants a second extension an hour later must get
    // one. Copying paidBooking's exact shape here would either do nothing or,
    // built carelessly, silently break that locked behaviour.
    //
    // What IS available, matching the threat actually named for this fix
    // (WhatsApp at-least-once delivery; a slow handler can cause Meta to
    // retry BEFORE the first 200 lands — i.e. a genuinely CONCURRENT second
    // invocation of the same inbound message, not one arriving minutes later):
    // a fresh re-read, immediately before the write, compared against what
    // THIS invocation started from — the same optimistic-concurrency idiom
    // PR1 used for the booking-availability race. If a concurrent duplicate
    // already committed its write in the gap, this invocation's own read is
    // now stale and it stands down rather than adding a second increment on
    // top of one it never saw.
    //
    // PR3b — closes the residual gap PR3 flagged above: a duplicate delivery
    // arriving AFTER the first EXTEND already fully completed is otherwise
    // indistinguishable from a deliberate second EXTEND. wamid (now threaded
    // through handleMessage/ctx) is the only thing that tells them apart.
    // Field-based check, matching this codebase's existing idempotency
    // convention (e.g. paidBooking's Payment Status check) rather than a new
    // generic dedup store — cheaper and avoids an in-memory cache that
    // wouldn't survive Vercel's serverless cold starts anyway.
    if (ctx.wamid && booking.fields['Last Extend Wamid'] === ctx.wamid) {
      logToAxiom('warn', 'extend_duplicate_wamid_suspected', {
        phone: ctx.phone, bookingId: booking.id, wamid: ctx.wamid
      });
      await sendWhatsApp(ctx.phone, msg('extensionConfirmed', { guestName }));
      return;
    }

    const readCheckOut = booking.fields['Check Out'];

    const extendMs = EXTENSION_MS[booking.fields['Booking Type']] || EXTENSION_MS.Overnight;
    const newCheckOut = new Date(Date.parse(booking.fields['Check Out']) + extendMs).toISOString();
    const alreadyNotified = !!booking.fields['Extension Owner Notified'];

    const bookingUpdate = {
      'Check Out': newCheckOut,
      // Re-arm the warning cycle for the extended window.
      'Checkout Warning Sent At': null,
      'Last Extend Wamid': ctx.wamid || null
    };
    // Set the flag only on the first extension — leave it untouched afterwards so
    // the write log shows no re-notify bookkeeping on later extensions.
    if (!alreadyNotified) bookingUpdate['Extension Owner Notified'] = true;

    // Price the extension onto the bill. Strictly ADDITIVE — the new total is
    // whatever the booking already carried plus one extension, never a
    // recomputation from scratch. Recomputing would silently overwrite anything
    // else that had adjusted the figure, and would make the Nth extension depend
    // on rates being unchanged since the 1st. Creation-time pricing is untouched.
    const charge = await extensionCharge(booking, ctx.property);
    const previousDue = Number(booking.fields['Amount Due']) || 0;
    if (charge === null) {
      // Unpriceable (no Rate Applied, or no hourly rate configured). The time
      // extension still happens — refusing a guest more time over a config gap
      // would be a worse failure, and is not what B12 promised them — but the
      // money is left untouched and the gap is made loud rather than papered
      // over with a guessed figure.
      logToAxiom('warn', 'extension_not_priced', {
        phone: ctx.phone, bookingId: booking.id,
        bookingType: booking.fields['Booking Type'] || null,
        propertyId: ctx.property.id, amountDue: previousDue
      });
    } else {
      bookingUpdate['Amount Due'] = previousDue + charge;
    }

    // The re-check itself: fresh read, compared against what this invocation
    // started from. A concurrent duplicate that already committed changes
    // Check Out out from under us — stand down rather than adding a second
    // increment neither the guest nor B17's revenue report should ever see.
    const freshBookings = await airtableGetBookingsByGuestId(ctx.guest.id, 'Checked In');
    const freshBooking = freshBookings.find(b => b.id === booking.id) || null;
    if (!freshBooking || freshBooking.fields['Check Out'] !== readCheckOut) {
      logToAxiom('warn', 'extend_duplicate_delivery_suspected', {
        phone: ctx.phone, bookingId: booking.id,
        readCheckOut, currentCheckOut: freshBooking ? freshBooking.fields['Check Out'] : null
      });
      // The extension the guest wanted already happened — courtesy reply, not
      // an error, and definitely not a second charge.
      await sendWhatsApp(ctx.phone, msg('extensionConfirmed', { guestName }));
      return;
    }

    // Rule 30 step 2, slice 1: FATAL on failure — this write sets Amount Due
    // and Check Out, the two facts the owner notify and guest confirmation
    // below both report as settled. F41's dedup write (Last Extend Wamid) is
    // part of this same bookingUpdate object, so this check also covers that.
    const extendWrite = await airtableUpdate('WS_Bookings', booking.id, bookingUpdate);
    if (extendWrite && extendWrite.error) {
      logToAxiom('error', 'extend_write_failed', {
        phone: ctx.phone, bookingId: booking.id, error: JSON.stringify(extendWrite.error)
      });
      await sendWhatsApp(ctx.phone, msg('extendWriteFailed', { guestName }));
      return;
    }

    if (!alreadyNotified && OWNER_PHONE) {
      // Rule 30 step 2, slice 2: checked but non-fatal — courtesy notification,
      // the guest already got their own extensionConfirmed reply below regardless.
      const ownerSend = await sendWhatsApp(OWNER_PHONE, msg('ownerExtension', {
        guestName,
        bookingRef: booking.fields['Booking Ref'] || '',
        checkOut: formatSastDateTime(newCheckOut)
      }));
      if (ownerSend && ownerSend.error) {
        logToAxiom('error', 'owner_extension_notify_failed', {
          bookingId: booking.id, error: JSON.stringify(ownerSend.error)
        });
      }
    }
    logToAxiom('info', 'booking_extended', {
      phone: ctx.phone, bookingId: booking.id, newCheckOut, ownerNotified: !alreadyNotified,
      // Both figures, so "what did this extension cost and what is owed now" is a
      // query rather than an inference — the number PAID will eventually display.
      extensionCharge: charge, amountDue: charge === null ? previousDue : previousDue + charge
    });
    await sendWhatsApp(ctx.phone, msg('extensionConfirmed', { guestName }));
  },

  // CHECKED_IN fallback menu (F9)
  async showCheckedInMenu(ctx) {
    await sendWhatsApp(ctx.phone, msg('checkedInMenu', { guestName: ctx.guest.fields['Guest Name'] }));
  },

  // Unknown session state: reset to NEW
  async unknownStateReset(ctx) {
    if (ctx.guest) {
      await updateGuestState(ctx.guest.id, { 'Session State': ctx.next });
    }
    await sendWhatsApp(ctx.phone, msg('unknownFallback'));
  }
};

// ─── AUTO-CHECKOUT CRON (B12) ────────────────────────────────────────────────
// Runs on a schedule (vercel.json → cron; Shawn enables at deploy). No guest
// message triggers it, so it is a separate entry point from handleMessage. For
// every Checked In booking past its Check Out:
//   · not yet warned  → send the 15-minute warning, stamp Checkout Warning Sent At
//   · warned ≥ AUTO_CHECKOUT_GRACE_MS ago → auto-checkout (same side effects and
//     cleaner-dispatch path as the manual `checkout` action)
//   · warned, still inside the grace → wait
// An EXTEND reply pushes Check Out into the future and clears the warning stamp,
// so an extended booking is simply "not past checkout" here and takes no action
// until the new time passes. `now` is injected for deterministic timing tests.

// Shared with the manual checkout path in spirit: mirrors the exact write/send
// ORDER of the `checkout` action (booking → Checked Out; room → Cleaning; room →
// Cleaning Started At; active cleaners dispatched; guest → NEW; guest thanked),
// so both routes leave identical state. Kept as its own function rather than
// refactoring `checkout` (frozen by fixtures 10/43) — a unifying refactor is its
// own session per CLAUDE.md.
// B10.5 Bug 2: `propertyId` is the caller's room-walk result, used only as a
// fallback for bookings checked in before WS_Property was persisted.
async function settleAutoCheckout(booking, room, guest, propertyName, propertyId) {
  // Rule 30 step 2, slice 1: FATAL on failure, cron twin of the manual
  // checkout write. No guest to reply to here — on failure this just logs
  // loud and returns without dispatching cleaners/reception/guest-thanks;
  // the booking stays 'Status: Checked In' so runAutoCheckout's own query
  // (`{Status} = 'Checked In'`) naturally retries it on the next tick.
  const checkoutWrite = await airtableUpdate('WS_Bookings', booking.id, {
    'Status': 'Checked Out',
    'Checkout Confirmed': true
  });
  if (checkoutWrite && checkoutWrite.error) {
    logToAxiom('error', 'auto_checkout_write_failed', {
      bookingId: booking.id, error: JSON.stringify(checkoutWrite.error)
    });
    return;
  }
  let roomName = 'your room';
  if (room) {
    roomName = room.fields['Room Name'];
    // Rule 30 step 2, slice 1: checked but non-fatal, same shape as the
    // manual checkout path's equivalent write.
    const cleaningWrite = await airtableUpdate('WS_Rooms', room.id, { 'Status': 'Cleaning' });
    if (cleaningWrite && cleaningWrite.error) {
      logToAxiom('error', 'auto_checkout_room_status_write_failed', {
        roomId: room.id, error: JSON.stringify(cleaningWrite.error)
      });
    }
    await airtableUpdate('WS_Rooms', room.id, { 'Cleaning Started At': new Date().toISOString() });
  }
  // B10.5 Bug 2: was `{Active} = TRUE()` — identical unscoped query to the manual
  // path. Both now scope off the booking's WS_Property via the same helper.
  const cleaners = await activeCleanersForProperty(bookingPropertyId(booking, propertyId));
  for (const cleaner of cleaners) {
    const cleanerPhone = cleaner.fields['Phone Number'];
    if (cleanerPhone) {
      // Rule 30 step 2, slice 2: checked but non-fatal, same shape as the
      // manual checkout path's equivalent dispatch.
      const dispatchSend = await sendWhatsApp(formatPhone(cleanerPhone), msg('cleanerDispatch', {
        cleanerName: cleaner.fields['Cleaner Name'], roomName
      }));
      if (dispatchSend && dispatchSend.error) {
        logToAxiom('error', 'auto_checkout_cleaner_dispatch_failed', {
          bookingId: booking.id, cleanerId: cleaner.id, roomName,
          error: JSON.stringify(dispatchSend.error)
        });
      }
    }
  }
  // B8: same push as the manual path. This is the branch that matters most —
  // walk-ins and hourly stays are normally closed here, not by the guest, and a
  // walk-in guest may have no phone on record to close it with at all.
  await notifyReceptionOfPayment({
    propertyId: bookingPropertyId(booking, propertyId),
    bookingId: booking.id,
    bookingRef: booking.fields['Booking Ref'] || null,
    roomName,
    guestName: guest ? guest.fields['Guest Name'] : null,
    amountDue: booking.fields['Amount Due'],
    source: 'auto'
  });

  if (guest) {
    await updateGuestState(guest.id, { 'Session State': 'AWAITING_RATING' });
  }
  const guestPhone = guest && formatPhone(String(guest.fields['Phone Number'] || ''));
  if (guestPhone) {
    await sendWhatsApp(guestPhone, msg('autoCheckoutThanks', { propertyName }));
    await sendWhatsApp(guestPhone, msg('ratingPrompt', { propertyName }));
  }
}

async function runAutoCheckout(now = new Date()) {
  const nowMs = now.getTime();
  const summary = { warnings: 0, autoCheckouts: 0 };

  const bookings = await airtableGet('WS_Bookings', `{Status} = 'Checked In'`);
  for (const booking of bookings) {
    const checkOut = booking.fields['Check Out'];
    if (!checkOut) continue;                 // date-less legacy row — cron can't manage it
    if (nowMs < Date.parse(checkOut)) continue; // not past checkout (incl. extended bookings)

    // Resolve guest, room and property for copy / dispatch (RECORD_ID lookups,
    // the same idiom the manual checkout uses for the room).
    const guestId = (booking.fields['Guest'] || [])[0];
    const guest = guestId ? (await airtableGet('WS_Guests', `RECORD_ID() = '${guestId}'`))[0] : null;
    const roomId = (booking.fields['Room'] || [])[0];
    const room = roomId ? (await airtableGet('WS_Rooms', `RECORD_ID() = '${roomId}'`))[0] : null;
    const propId = room && (room.fields['Property'] || [])[0];
    const property = propId ? (await airtableGet('WS_Properties', `RECORD_ID() = '${propId}'`))[0] : null;
    const propertyName = property ? property.fields['Property Name'] : '';
    const guestName = guest ? guest.fields['Guest Name'] : 'there';
    const guestPhone = guest && formatPhone(String(guest.fields['Phone Number'] || ''));

    const warnedAt = booking.fields['Checkout Warning Sent At'];
    if (!warnedAt) {
      // First pass past checkout → warn and stamp the time.
      // Rule 30 step 2, slice 2 (deferred from F44/slice 1): NON-FATAL —
      // nothing reads this field except this same cron function on its own
      // NEXT run (line ~3009, freshly refetched). A failed stamp just means
      // the warning re-sends every tick until the write succeeds — a
      // self-healing annoyance, not a broken state.
      const warnStampWrite = await airtableUpdate('WS_Bookings', booking.id, { 'Checkout Warning Sent At': now.toISOString() });
      if (warnStampWrite && warnStampWrite.error) {
        logToAxiom('error', 'checkout_warning_stamp_write_failed', {
          bookingId: booking.id, error: JSON.stringify(warnStampWrite.error)
        });
      }
      if (guestPhone) await sendWhatsApp(guestPhone, msg('checkoutWarning', { guestName, propertyName }));
      logToAxiom('info', 'auto_checkout_warning', { bookingId: booking.id, phone: guestPhone || null, checkOut });
      summary.warnings++;
      continue;
    }
    if (nowMs >= Date.parse(warnedAt) + AUTO_CHECKOUT_GRACE_MS) {
      // Grace elapsed, no extension, no manual checkout → auto-checkout.
      // B10.5 Bug 2: the room walk above stays — it feeds `propertyName` into the
      // guest copy. `propId` is passed only as the legacy-booking scoping fallback.
      await settleAutoCheckout(booking, room, guest, propertyName, propId);
      logToAxiom('info', 'auto_checkout_fired', { bookingId: booking.id, phone: guestPhone || null });
      summary.autoCheckouts++;
    }
    // else: warned, still inside the grace — wait for the next run.
  }
  return summary;
}

// ─── ENQUIRY LOGGING (B19) ───────────────────────────────────────────────────
// Every terminal point of a booking attempt writes one WS_Enquiries row, so the
// attempts that never became bookings — "3 enquiries turned away, no room free"
// — stop vanishing. Booked / No Availability / Invalid Input are logged at their
// definitive points; Abandoned is a staleness sweep (guest gave a name, then went
// silent) that reuses the auto-checkout cron rather than adding a second one.

const ENQUIRY_ABANDON_MS = 24 * 60 * 60 * 1000; // 24h since last inbound with no terminal outcome
// Originally just the 3 "produced a valid booking DRAFT" states. Extended to
// all 5 AWAITING_* limbo states (closing the last gap from the stuck-state
// investigation, recDAQmhoe4aFHvFy) — AWAITING_DETAILS/AWAITING_HOURLY_DETAILS
// added so the sweep also unsticks a guest who never even got past the
// details-capture step, not just one who has a draft in progress. See
// runEnquiryAbandonment for why these two needed more than just adding their
// names here: their data shape differs from the original 3 in ways that
// would have made the RESET silently never fire if the loop below weren't
// restructured to stop gating it on those differences.
const ENQUIRY_ABANDON_STATES = [
  'AWAITING_OCCUPANCY', 'AWAITING_ETA', 'AWAITING_HOURLY_DURATION',
  'AWAITING_DETAILS', 'AWAITING_HOURLY_DETAILS'
];

// Writes exactly one WS_Enquiries row. Property-scoped via property.id (JS-side
// record-id link, same idiom as B11). Partial rows are allowed — an attempt that
// dies before dates are given logs with blank date fields.
//
// One-write rule, two dedup guards:
//   · Booked  — never a second row for the same booking id. The overnight flow
//     reaches "Booked" at BOTH creation (collectDetails) and confirmation
//     (recordEta); only the first lands. Two SEPARATE attempts each hit their own
//     terminal and correctly produce two rows.
//   · Invalid Input — never a second OPEN (booking-less) Invalid-Input row for the
//     same phone, so repeated fumbles in one attempt collapse to one row.
async function logEnquiry(property, phone, outcome, opts = {}) {
  const { checkInIso, checkOutIso, bookingType, bookingId } = opts;
  const existing = await airtableGet('WS_Enquiries', '');
  if (bookingId && existing.some(e => (e.fields['Booking'] || []).includes(bookingId))) return false;
  if (outcome === 'Invalid Input' && existing.some(e =>
        e.fields['Phone Number'] === phone &&
        e.fields['Outcome'] === 'Invalid Input' &&
        (e.fields['Booking'] || []).length === 0)) return false;

  const fields = {
    'Phone Number': phone,
    'Property': [property.id],
    'Outcome': outcome,
    'Created At': new Date().toISOString()
  };
  if (checkInIso) fields['Requested Check In'] = checkInIso;
  if (checkOutIso) fields['Requested Check Out'] = checkOutIso;
  if (bookingType) fields['Booking Type'] = bookingType;
  if (bookingId) fields['Booking'] = [bookingId];
  // Rule 30 step 2, slice 2: NON-FATAL — WS_Enquiries is a one-way reporting
  // sink, nothing in the live guest/booking flow reads it back. The dedup
  // guards above (lines 3069-3073) re-query fresh on each future call, so a
  // failed write here just risks a duplicate row next attempt, not a broken
  // state. Previously logged 'enquiry_logged' unconditionally even on a
  // failed create, which was itself a small Rule 30 violation — now split.
  const enquiryWrite = await airtableCreate('WS_Enquiries', fields);
  if (enquiryWrite && enquiryWrite.error) {
    logToAxiom('error', 'enquiry_log_write_failed', {
      phone, propertyId: property.id, outcome, error: JSON.stringify(enquiryWrite.error)
    });
    return false;
  }
  logToAxiom('info', 'enquiry_logged', { phone, propertyId: property.id, outcome, bookingType: bookingType || null });
  return true;
}

// Staleness sweep. Runs on the auto-checkout cron. Two DECOUPLED jobs per
// stale guest, in order:
//   1. RESET — unconditional beyond staleness. A guest sitting in any of the
//      5 AWAITING_* states this long has nothing to lose from starting over,
//      whether or not they ever gave a name or produced a bookable draft.
//      This is the actual user-facing fix (closing the stuck-state gap,
//      recDAQmhoe4aFHvFy) and always runs when a guest is stale.
//   2. LOG — best-effort 'Abandoned' WS_Enquiries report row, same
//      preconditions as before this change (gave a name, no terminal already
//      covering this attempt, a property can be recovered). These exist for
//      REPORTING QUALITY, not for deciding whether to reset, so a guest who
//      fails them still gets reset — just without a report row.
//
// Why AWAITING_DETAILS/AWAITING_HOURLY_DETAILS specifically NEEDED this split
// (found while extending coverage to them, not assumed): unlike the original
// 3 states, a guest still stuck at the details-capture step has (a) never
// successfully parsed a name — Guest Name is still 'Unknown', which would
// fail gate 1 below; (b) no pending Enquiry booking yet, so no room to walk
// to a property — always fails the property-recovery gate; and (c) almost
// always already has a deduped 'Invalid Input' WS_Enquiries row from their
// first failed parse attempt, whose Created At is >= their state-entry
// timestamp — which trips the "already covered" dedup guard on every sweep
// run, forever. Leaving the old single gated code path unchanged and just
// adding these 2 states to ENQUIRY_ABANDON_STATES would have queried them
// correctly but then silently skipped every single one at one of these three
// gates — the guest would never actually get reset. Splitting the reset out
// from these three (still-correct, still-necessary) log preconditions is
// what actually closes the gap.
async function runEnquiryAbandonment(now = new Date()) {
  const nowMs = now.getTime();
  const summary = { abandoned: 0 };
  const guests = await airtableGet('WS_Guests', orFormula('Session State', ENQUIRY_ABANDON_STATES));
  const enquiries = await airtableGet('WS_Enquiries', '');

  for (const guest of guests) {
    const lastInbound = guest.fields['Last Inbound At'];
    if (!lastInbound || (nowMs - Date.parse(lastInbound)) < ENQUIRY_ABANDON_MS) continue;

    // 1. RESET — see function comment. No proactive WhatsApp send: a guest
    // silent 24h+ is outside Meta's free-form service window, so this only
    // takes effect on their own next inbound message. updateGuestState logs
    // its own guest_state_write_failed on error — non-fatal, best-effort,
    // matches this sweep's existing posture throughout.
    await updateGuestState(guest.id, { 'Session State': 'NEW' });
    logToAxiom('info', 'enquiry_abandoned', { phone: guest.fields['Phone Number'], guestId: guest.id, sessionState: guest.fields['Session State'] });
    summary.abandoned++;

    // 2. LOG — optional 'Abandoned' report row. Unchanged preconditions from
    // before this task; for AWAITING_DETAILS/AWAITING_HOURLY_DETAILS these
    // will usually (not always) skip the log — see function comment — which
    // is fine: the reset above already happened regardless.
    const name = guest.fields['Guest Name'];
    if (!name || name === 'Unknown') continue;                 // "provided at least a name"

    const phone = formatPhone(String(guest.fields['Phone Number'] || ''));
    // One-write guard: skip if an enquiry row for this phone already exists for
    // this attempt (created at/after the guest's last activity — i.e. a terminal
    // was already reached on that last message).
    if (enquiries.some(e => e.fields['Phone Number'] === phone &&
        Date.parse(e.fields['Created At']) >= Date.parse(lastInbound) - 60000)) continue;

    // Recover the property from the guest's pending Enquiry booking → room.
    const pending = (await airtableGetBookingsByGuestId(guest.id, 'Enquiry'))[0] || null;
    const roomId = pending && (pending.fields['Room'] || [])[0];
    const room = roomId ? (await airtableGet('WS_Rooms', `RECORD_ID() = '${roomId}'`))[0] : null;
    const propId = room && (room.fields['Property'] || [])[0];
    const property = propId ? (await airtableGet('WS_Properties', `RECORD_ID() = '${propId}'`))[0] : null;
    if (!property) continue; // cannot scope without a property — leave the log for a later run

    await logEnquiry(property, phone, 'Abandoned', {
      checkInIso: pending && pending.fields['Check In'],
      checkOutIso: pending && pending.fields['Check Out'],
      bookingType: pending && pending.fields['Booking Type']
    });
  }
  return summary;
}

async function autoCheckoutHandler(req, res) {
  try {
    const summary = await runAutoCheckout();
    // B19: reuse this cron for the enquiry-abandonment staleness sweep.
    const enquiry = await runEnquiryAbandonment();
    res.status(200).json({ ok: true, ...summary, ...enquiry });
  } catch (err) {
    console.error('[AUTO-CHECKOUT FATAL]', err.message, err.stack);
    logToAxiom('error', 'auto_checkout_fatal', { message: err.message, stack: err.stack });
    res.status(200).json({ ok: false, error: err.message });
  }
}

// ─── OWNER SUMMARY (B17) ─────────────────────────────────────────────────────
// "The weekly P&L IS the product." A per-property aggregation over WS_Bookings,
// run weekly (a daily variant is available behind OWNER_SUMMARY_DAILY). The SEND
// is stubbed: a weekly summary is a business-initiated message outside any 24h
// window, so it needs an approved Meta utility template (Shawn submits; Meta
// reviews on their own clock). Everything except the send is built and testable
// now — sendOwnerSummary logs the fully-assembled payload to Axiom so the
// aggregation is verifiable end-to-end before the template exists.

const DAY_MS = 24 * 60 * 60 * 1000;
// Meta utility template name for the owner summary. FLAG: pending Meta approval
// (Shawn submits). When approved, this is the one-line swap point in
// sendOwnerSummary below.
const OWNER_SUMMARY_TEMPLATE = 'wabistay_owner_weekly_summary';

// Room-nights sold for one booking. Convention (stated explicitly per the brief):
//   · Overnight → whole nights, rounded from the 14:00→10:00 clock span
//     (a 1-night 14:00→10:00 stay is 20h of clock but counts as 1 night).
//   · Hourly    → a PARTIAL room-night: the raw fraction of a day (2h = 2/24).
// A booking missing either date contributes 0 (cannot be measured).
function bookingRoomNights(booking) {
  const ci = booking.fields['Check In'];
  const co = booking.fields['Check Out'];
  if (!ci || !co) return 0;
  const rawDays = (Date.parse(co) - Date.parse(ci)) / DAY_MS;
  if (!Number.isFinite(rawDays) || rawDays <= 0) return 0;
  return booking.fields['Booking Type'] === 'Hourly' ? rawDays : Math.round(rawDays);
}

// Stage 1 (payment reconciliation): per-booking Amount Due vs Amount Paid,
// over the same period window the rest of the summary already uses — no new
// query, no new window, just read off the same `periodBookings` the revenue
// total is already computed from. Design note, not a gap: a delta can only
// ever be known once reception has actually recorded a collection via
// PAID/COLLECTED — there is no way to auto-detect real-world cash changing
// hands. A booking reception has not yet acted on shows its full Amount Due
// as delta, which is correct: it IS outstanding, by definition, until
// reception reports otherwise.
function paymentReconciliationLines(periodBookings, roomsById, guestsById) {
  return periodBookings.map(b => {
    const amountDue = Number(b.fields['Amount Due']) || 0;
    const amountPaid = Number(b.fields['Amount Paid']) || 0;
    const roomId = (b.fields['Room'] || [])[0] || null;
    const guestId = (b.fields['Guest'] || [])[0] || null;
    return {
      bookingId: b.id,
      bookingRef: b.fields['Booking Ref'] || null,
      roomName: roomId ? (roomsById.get(roomId) || null) : null,
      guestName: guestId ? (guestsById.get(guestId) || null) : null,
      amountDue,
      amountPaid,
      delta: amountDue - amountPaid
    };
  });
}

// Aggregates one property's bookings over the reporting window. `bookings` is
// already scoped to this property (via room link) and already excludes Cancelled.
function aggregateOwnerSummary(property, rooms, bookings, w, guestsById = new Map()) {
  const checkInMs = b => (b.fields['Check In'] ? Date.parse(b.fields['Check In']) : NaN);
  const inPeriod = b => {
    const t = checkInMs(b);
    return Number.isFinite(t) && t >= w.periodStartMs && t < w.periodEndMs;
  };
  const periodBookings = bookings.filter(inPeriod);

  const totalRevenue = periodBookings.reduce((s, b) => s + (Number(b.fields['Amount Due']) || 0), 0);
  const roomNightsSold = periodBookings.reduce((s, b) => s + bookingRoomNights(b), 0);
  const roomNightsAvailable = rooms.length * w.periodDays;
  const occupancyRate = roomNightsAvailable > 0 ? roomNightsSold / roomNightsAvailable : 0;

  const upcomingBookings = bookings.filter(b => {
    const t = checkInMs(b);
    return Number.isFinite(t) && t >= w.periodEndMs && t < w.upcomingEndMs;
  }).length;

  const roomsById = new Map(rooms.map(r => [r.id, r.fields['Room Name'] || null]));
  const paymentLines = paymentReconciliationLines(periodBookings, roomsById, guestsById);
  const paymentDeltaTotal = paymentLines.reduce((s, l) => s + l.delta, 0);

  return {
    propertyId: property.id,
    propertyName: property.fields['Property Name'],
    periodDays: w.periodDays,
    totalBookings: periodBookings.length,
    totalRevenue,
    roomNightsSold,
    roomNightsAvailable,
    // Rounded to 4 dp so partial (hourly) nights are visible without float noise.
    occupancyRate: Math.round(occupancyRate * 10000) / 10000,
    upcomingBookings,
    paymentLines,
    paymentDeltaTotal
  };
}

// Renders the Stage 1 reconciliation section of the weekly message: one
// aggregate delta line at the top (the number an owner actually needs first),
// then one line per booking. A booking reception has already fully settled
// still appears, at R0.00 delta — completeness matters more than brevity
// here, since the entire point is "is anything unaccounted for," and a
// filtered list can't answer that as trustworthily as a complete one can.
function formatPaymentReconciliationMessage(summary) {
  const sign = summary.paymentDeltaTotal >= 0 ? '' : '-';
  const lines = [
    `💰 *Payment Reconciliation — ${summary.propertyName}*`,
    `*Total Delta:* ${sign}R${formatAmount(Math.abs(summary.paymentDeltaTotal))}`,
    ''
  ];
  if (summary.paymentLines.length === 0) {
    lines.push('No bookings this period.');
  } else {
    for (const l of summary.paymentLines) {
      const lSign = l.delta >= 0 ? '' : '-';
      lines.push(
        `${l.roomName || 'Unknown room'} — ${l.guestName || 'Unknown guest'}: ` +
        `Due R${formatAmount(l.amountDue)} / Paid R${formatAmount(l.amountPaid)} ` +
        `(Δ ${lSign}R${formatAmount(Math.abs(l.delta))})`
      );
    }
  }
  return lines.join('\n');
}

// The send surface. STUBBED until OWNER_SUMMARY_TEMPLATE is approved: logs the
// full payload to Axiom (so aggregation is verifiable now) and marks exactly
// where the template send goes.
async function sendOwnerSummary(property, summary) {
  const notifyPhone = property.fields['Notify Phone']
    ? property.fields['Notify Phone'].replace(/[\s\-\+]/g, '')
    : (OWNER_PHONE || null);
  const paymentReconciliationMessage = formatPaymentReconciliationMessage(summary);
  const payload = { ...summary, template: OWNER_SUMMARY_TEMPLATE, notifyPhone, paymentReconciliationMessage };
  // Last Report Sent is deliberately NOT written back to WS_Properties here —
  // runOwnerSummary/runDailySummary are documented and tested (Rule 29,
  // test/dailysummary.test.js) as read-only reporting with zero Airtable
  // writes from either cron; adding one would silently break that invariant.
  // "Last Report Sent" is surfaced from this same owner_summary_payload
  // Axiom event instead (it already carries propertyId + the event's own
  // _time) — see the property-activity-tracker PR body for the query.
  logToAxiom('info', 'owner_summary_payload', payload);

  // TODO(B17): `sendWhatsAppTemplate` now EXISTS (see the WhatsApp template helper
  // above) — the only thing still missing is Meta's approval of
  // OWNER_SUMMARY_TEMPLATE. Once approved, this is the one-line swap:
  //   await sendWhatsAppTemplate(notifyPhone, OWNER_SUMMARY_TEMPLATE, ownerSummaryTemplateParams(summary), { site: 'owner_summary', propertyId: property.id });
  // Left stubbed here deliberately: enabling it is a separate, CEO-gated change,
  // not a side effect of building the helper.
  // Deliberately NOT a free-form sendWhatsApp — that would 200-and-vanish.

  return payload;
}

async function runOwnerSummary(opts = {}) {
  const {
    now = new Date(),
    daily = process.env.OWNER_SUMMARY_DAILY === 'true'
  } = opts;

  const periodDays = daily ? 1 : 7;
  const periodEndMs = now.getTime();
  const w = {
    periodDays,
    periodStartMs: periodEndMs - periodDays * DAY_MS,
    periodEndMs,
    upcomingEndMs: periodEndMs + 7 * DAY_MS
  };

  const properties = await airtableGet('WS_Properties', '');
  const allRooms = await airtableGet('WS_Rooms', orFormula('Status', BOOKABLE_ROOM_STATUSES));
  // Non-cancelled bookings only — a cancelled booking is neither revenue nor
  // occupancy. Scoped to each property below via its room link (WS_Bookings has
  // no Property field of its own).
  const allBookings = await airtableGet('WS_Bookings', orFormula('Status', BLOCKING_BOOKING_STATUSES.concat(['Checked Out'])));
  // Stage 1: guest names for the reconciliation line items. One extra table
  // read, same shape as allRooms/allBookings above — not a new query per
  // property, and not a new per-booking lookup either.
  const allGuests = await airtableGet('WS_Guests', '');
  const guestsById = new Map(allGuests.map(g => [g.id, g.fields['Guest Name'] || null]));

  const summaries = [];
  const failed = [];
  for (const property of properties) {
    // Per-property isolation, same reasoning as runDailySummary's own fix: one
    // property throwing here must not abort the rest of this run — before this
    // fix, an uncaught throw propagated straight out of the loop and silently
    // dropped every remaining property's weekly summary for that run, with no
    // automatic retry until next Monday (unlike daily, which self-heals within
    // the hour).
    try {
      const rooms = allRooms.filter(r => (r.fields['Property'] || []).includes(property.id));
      const roomIds = new Set(rooms.map(r => r.id));
      const bookings = allBookings.filter(b => (b.fields['Room'] || []).some(id => roomIds.has(id)));
      const summary = aggregateOwnerSummary(property, rooms, bookings, w, guestsById);
      await sendOwnerSummary(property, summary);
      summaries.push(summary);
    } catch (err) {
      logToAxiom('error', 'owner_summary_property_failed', {
        propertyId: property.id, propertyName: property.fields?.['Property Name'] || null,
        message: err.message, stack: err.stack
      });
      // Fires per property, not once for the whole run, so the alert itself
      // says which property failed rather than just "owner summary failed".
      await alertShawn('owner_summary', err.message, {
        propertyId: property.id, propertyName: property.fields?.['Property Name'] || null
      });
      failed.push({ propertyId: property.id, propertyName: property.fields?.['Property Name'] || null, error: err.message });
    }
  }
  // Return shape is unchanged (still a plain array of successful summaries —
  // existing callers index/map/find on it directly) — `failed` is attached as
  // a non-indexed property so callers who need failure visibility can read
  // `result.failed` without breaking anyone who only ever treated this as an
  // array. JSON.stringify silently drops non-indexed array properties, which
  // is why ownerSummaryHandler below also spreads it into the JSON response
  // explicitly rather than relying on this alone.
  summaries.failed = failed;
  return summaries;
}

async function ownerSummaryHandler(req, res) {
  try {
    const summaries = await runOwnerSummary();
    res.status(200).json({ ok: true, count: summaries.length, summaries, failed: summaries.failed || [] });
  } catch (err) {
    console.error('[OWNER-SUMMARY FATAL]', err.message, err.stack);
    logToAxiom('error', 'owner_summary_fatal', { message: err.message, stack: err.stack });
    await alertShawn('owner_summary_fatal', err.message, { scope: 'entire run, not a single property' });
    res.status(200).json({ ok: false, error: err.message });
  }
}

// ─── DAILY MINI-RECONCILIATION SUMMARY (Stage 3 part 1) ─────────────────────
// Runs in ADDITION to the Monday weekly cron above, not instead of it — both
// fire on Mondays. Vercel's native cron (Hobby tier: once/day, UTC-only, hour-
// imprecise) cannot deliver "fire at property X's chosen SAST hour," so this is
// invoked hourly by a GitHub Actions workflow instead (.github/workflows/
// daily-summary.yml — UTC-triggered every hour, deliberately timezone-naive:
// GitHub Actions' schedule trigger has no IANA-timezone field, so correctness
// lives entirely here, not in the workflow). Each invocation checks every
// property's `Daily Summary Hour` against the current SAST hour and only acts
// on a match — an unconfigured property (field blank) is silently skipped, not
// defaulted, since a wrong guess would fire at the wrong hour for real.
//
// Rule 29 — interaction surface with runOwnerSummary (the Monday weekly cron):
// both read WS_Properties and WS_Bookings; neither writes to either. Read-only
// reporting on both sides, so there is no write contention and no ordering
// dependence — the two can and do fire in the same hour on a Monday (weekly at
// 06:00 SAST, daily at whatever hour each property is configured for) without
// interfering, because neither's output depends on the other having run.
//
// Stage 3 part 2: content is now built. Send stays stubbed (same reasoning as
// sendOwnerSummary — no approved Meta template exists for this use case yet,
// confirmed live against Meta's template list before this part started).
//
// Meta utility template name for the daily summary. FLAG: pending Meta
// approval/submission — unlike OWNER_SUMMARY_TEMPLATE this hasn't been
// submitted yet either; naming it here only marks the swap point.
const DAILY_SUMMARY_TEMPLATE = 'wabistay_daily_summary';

// ── Room state grid ──────────────────────────────────────────────────────────
// WS_Rooms.Status alone cannot distinguish overnight vs hourly occupancy (both
// read 'Occupied') — the split requires resolving which booking currently holds
// the room. 'Maintenance' is excluded from the 4-state grid the spec asks for
// (same convention as BOOKABLE_ROOM_STATUSES elsewhere in this file, which also
// excludes it) but counted separately so a room in Maintenance is never silently
// dropped from the report.
function roomState(room, bookingsForRoom) {
  const status = room.fields['Status'];
  if (status === 'Cleaning') return 'cleaning';
  if (status === 'Available') return 'ready';
  if (status === 'Occupied') {
    const active = bookingsForRoom.find(b => b.fields['Status'] === 'Checked In');
    return (active && active.fields['Booking Type'] === 'Hourly') ? 'occupied-hourly' : 'occupied-overnight';
  }
  return null; // Maintenance (or any future status) — not part of the 4-state grid
}

function roomStateGrid(rooms, bookingsByRoomId) {
  const grid = { 'occupied-overnight': 0, 'occupied-hourly': 0, ready: 0, cleaning: 0 };
  let maintenance = 0;
  for (const room of rooms) {
    const state = roomState(room, bookingsByRoomId.get(room.id) || []);
    if (state) grid[state]++;
    else maintenance++;
  }
  return { ...grid, maintenance };
}

// ── No-shows (CEO-approved inferred definition, Stage 3 part 2) ─────────────
// WS_Bookings.Status has no 'No Show' choice (confirmed live via Meta API —
// only Enquiry/Confirmed/Checked In/Checked Out/Cancelled exist), so this is
// INFERRED, not a read of an existing fact: Confirmed, Check In date has
// already arrived (today or earlier), never transitioned to Checked In.
function isNoShow(booking, todayYmd) {
  if (booking.fields['Status'] !== 'Confirmed') return false;
  const ci = booking.fields['Check In'];
  if (!ci) return false;
  return compareYmd(sastCalendarDate(new Date(Date.parse(ci))), todayYmd) <= 0;
}

// ── Overnight: check-ins / check-outs / no-shows today ───────────────────────
// Check-ins use 'Checked In At' (a real event timestamp). Check-outs have no
// symmetric real event timestamp on WS_Bookings — only the scheduled 'Check Out'
// date exists (the same field aggregateOwnerSummary already keys period math
// off of), so "checked out today" here means Status = Checked Out with a
// scheduled Check Out date of today, not a captured actual-checkout moment.
// Flagging rather than silently treating it as precise.
function overnightStatsToday(bookings, todayYmd) {
  const dateIs = (iso, ymd) => !!iso && compareYmd(sastCalendarDate(new Date(Date.parse(iso))), ymd) === 0;

  const checkInsToday = bookings.filter(b =>
    b.fields['Booking Type'] === 'Overnight' && dateIs(b.fields['Checked In At'], todayYmd)
  ).length;

  const checkOutsToday = bookings.filter(b =>
    b.fields['Booking Type'] === 'Overnight' && b.fields['Status'] === 'Checked Out' && dateIs(b.fields['Check Out'], todayYmd)
  ).length;

  const noShowsToday = bookings.filter(b =>
    b.fields['Booking Type'] === 'Overnight' && isNoShow(b, todayYmd)
  ).length;

  return { checkInsToday, checkOutsToday, noShowsToday };
}

// ── Hourly: bookings today + overstay interventions ──────────────────────────
// 'Checkout Warning Sent At' is written by runAutoCheckout for ANY Checked-In
// booking it sweeps, regardless of Booking Type — it is not hourly-specific,
// even though the content spec groups it under "Hourly". Reported unscoped by
// type here (matching what the field actually measures) rather than silently
// filtered to Hourly bookings only, which would undercount and misrepresent it.
function hourlyStatsToday(bookings, todayYmd) {
  const dateIs = (iso, ymd) => !!iso && compareYmd(sastCalendarDate(new Date(Date.parse(iso))), ymd) === 0;

  const totalHourlyBookingsToday = bookings.filter(b =>
    b.fields['Booking Type'] === 'Hourly' && dateIs(b.fields['Check In'], todayYmd)
  ).length;

  const overstayInterventionsToday = bookings.filter(b =>
    dateIs(b.fields['Checkout Warning Sent At'], todayYmd)
  ).length;

  return { totalHourlyBookingsToday, overstayInterventionsToday };
}

// ── Cleaning turnaround — JOB DURATION, explicitly NOT vacant-to-ready ──────
// See CLAUDE.md BACKLOG-01. The true "checkout → sellable again" number
// (vacantToReadyMs in resolveRoomClean/cleaningDurations) is never persisted:
// its baseline, WS_Rooms.'Cleaning Started At', is overwritten every checkout
// cycle and never copied onto the booking, so after the fact it only ever
// existed in the 'cleaning_job_completed' Axiom log entry at the moment it
// happened — unrecoverable here. What DOES survive on WS_Bookings is
// 'Cleaning Job Started At' -> 'Cleaning Completed At' ("job duration": how
// long the cleaner spent once dispatched, only present when they sent START).
// Reported here, labeled explicitly, as the best available proxy.
function jobDurationMs(booking) {
  const started = booking.fields['Cleaning Job Started At'];
  const completed = booking.fields['Cleaning Completed At'];
  if (!started || !completed) return null;
  const startMs = Date.parse(started);
  const completedMs = Date.parse(completed);
  if (!Number.isFinite(startMs) || !Number.isFinite(completedMs) || completedMs < startMs) return null;
  return completedMs - startMs;
}

function cleaningTurnaroundToday(bookings, todayYmd) {
  const completedToday = bookings.filter(b =>
    b.fields['Cleaning Completed At'] &&
    compareYmd(sastCalendarDate(new Date(Date.parse(b.fields['Cleaning Completed At']))), todayYmd) === 0
  );
  const durations = completedToday.map(jobDurationMs).filter(ms => ms !== null);
  const averageJobDurationMs = durations.length > 0
    ? Math.round(durations.reduce((s, ms) => s + ms, 0) / durations.length)
    : null;
  return {
    metric: 'job_duration', // NOT vacant-to-ready/time-to-ready — see BACKLOG-01 in CLAUDE.md
    jobsCompletedToday: completedToday.length,
    jobsWithDuration: durations.length,
    averageJobDurationMs
  };
}

// ── Revenue today (overnight / hourly / combined) ────────────────────────────
// Scoped to bookings whose Check In date is today, same period-bucketing
// convention aggregateOwnerSummary already uses for its own totalRevenue.
function revenueToday(todaysBookings) {
  const sumDue = list => list.reduce((s, b) => s + (Number(b.fields['Amount Due']) || 0), 0);
  const overnightRevenue = sumDue(todaysBookings.filter(b => b.fields['Booking Type'] === 'Overnight'));
  const hourlyRevenue = sumDue(todaysBookings.filter(b => b.fields['Booking Type'] === 'Hourly'));
  return { overnightRevenue, hourlyRevenue, combinedRevenue: overnightRevenue + hourlyRevenue };
}

// ── Tomorrow's overnight arrivals ────────────────────────────────────────────
function tomorrowsOvernightArrivals(bookings, tomorrowYmd, roomsById, guestsById) {
  return bookings
    .filter(b => b.fields['Booking Type'] === 'Overnight' &&
      b.fields['Check In'] &&
      compareYmd(sastCalendarDate(new Date(Date.parse(b.fields['Check In']))), tomorrowYmd) === 0)
    .map(b => ({
      bookingId: b.id,
      bookingRef: b.fields['Booking Ref'] || null,
      guestName: guestsById.get((b.fields['Guest'] || [])[0]) || null,
      roomName: roomsById.get((b.fields['Room'] || [])[0]) || null,
      checkIn: b.fields['Check In']
    }));
}

// ── Full per-property aggregation ────────────────────────────────────────────
// Reuses paymentReconciliationLines (Stage 1) directly for section 6
// (outstanding/pending payments), scoped to today's bookings — same helper,
// same shape, no parallel version written.
function aggregateDailySummary(property, rooms, bookings, dates, guestsById) {
  const { todayYmd, tomorrowYmd } = dates;

  const bookingsByRoomId = new Map();
  for (const b of bookings) {
    for (const roomId of (b.fields['Room'] || [])) {
      if (!bookingsByRoomId.has(roomId)) bookingsByRoomId.set(roomId, []);
      bookingsByRoomId.get(roomId).push(b);
    }
  }
  const roomsById = new Map(rooms.map(r => [r.id, r.fields['Room Name'] || null]));

  const todaysBookings = bookings.filter(b =>
    b.fields['Check In'] && compareYmd(sastCalendarDate(new Date(Date.parse(b.fields['Check In']))), todayYmd) === 0
  );
  const paymentLines = paymentReconciliationLines(todaysBookings, roomsById, guestsById);
  const paymentDeltaTotal = paymentLines.reduce((s, l) => s + l.delta, 0);

  return {
    propertyId: property.id,
    propertyName: property.fields['Property Name'],
    date: `${todayYmd.y}-${String(todayYmd.m).padStart(2, '0')}-${String(todayYmd.d).padStart(2, '0')}`,
    roomStateGrid: roomStateGrid(rooms, bookingsByRoomId),
    overnight: overnightStatsToday(bookings, todayYmd),
    hourly: hourlyStatsToday(bookings, todayYmd),
    cleaningTurnaround: cleaningTurnaroundToday(bookings, todayYmd),
    revenue: revenueToday(todaysBookings),
    outstandingPayments: { paymentLines, paymentDeltaTotal },
    tomorrowsArrivals: tomorrowsOvernightArrivals(bookings, tomorrowYmd, roomsById, guestsById)
  };
}

// Stage 3 part 3 prep — NOT wired to any live send yet. Resolves the property's
// owner name for the wabistay_owner_daily_summary template's {{1}}. This link
// (WS_Properties.Owner -> WS_Owners) has never been read anywhere in the
// daily-summary path before now. Follows the exact same single-hop
// RECORD_ID() lookup idiom already used elsewhere for linked-record
// resolution (e.g. guest/room/property resolution around the auto-checkout
// warning path) — not a new pattern. Returns null, not a guessed default, if
// the property has no linked owner or the owner record has no name set: a
// caller sending this straight into a template param must decide what to do
// with null explicitly, not have this function silently paper over it.
async function resolveOwnerName(property) {
  const ownerId = (property.fields['Owner'] || [])[0];
  if (!ownerId) return null;
  const owners = await airtableGet('WS_Owners', `RECORD_ID() = '${ownerId}'`);
  return (owners[0] && owners[0].fields['Owner Name']) || null;
}

const MONTH_FULL = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// CEO-confirmed: the daily-summary template needs a human-readable date
// (e.g. "20 August 2026"), not the raw ISO YYYY-MM-DD aggregateDailySummary
// produces (~webhook.js:3979). Reformats ONLY for this template's output —
// deliberately does NOT touch `summary.date` itself, since other consumers
// of aggregateDailySummary's output (the daily_summary_payload Axiom log,
// the manual report-trigger endpoint) may depend on the ISO string staying
// intact. Parses the Y-M-D components directly rather than routing through
// formatSastDateTime, which formats a UTC *instant* with a SAST time-of-day
// — not what a bare calendar date needs — but reuses this file's existing
// month-name-array convention (MONTH_ABBR, above) rather than inventing an
// unrelated approach.
function formatHumanDate(isoYmd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoYmd);
  if (!m) throw new Error(`formatHumanDate: expected YYYY-MM-DD, got '${isoYmd}'`);
  const [, y, mo, d] = m;
  return `${Number(d)} ${MONTH_FULL[Number(mo) - 1]} ${y}`;
}

// paymentDeltaTotal, unlike Reception's amountDue (always >= 0, so
// notifyReceptionOfPayment's params never need a sign), CAN be negative — an
// overpayment. formatAmount() alone (two decimals, no symbol, no sign) would
// silently drop that minus sign, showing an overpayment as if it were owed.
// Reuses the sign+abs pattern formatPaymentReconciliationMessage already
// uses for the same field, minus the 'R' prefix — the currency symbol
// decision stays with the template copy, same reasoning as formatAmount's
// own comment.
function formatSignedAmount(value) {
  const n = Number(value) || 0;
  const sign = n >= 0 ? '' : '-';
  return `${sign}${formatAmount(Math.abs(n))}`;
}

// Stage 3 part 3 prep, per the TODO below — builds the wabistay_owner_daily_summary
// template params in the Meta-locked positional order:
//   {{1}} ownerName · {{2}} propertyName · {{3}} date · {{4}} paymentDeltaTotalFormatted
//   {{5}} tomorrowsArrivalsCount
// NOT wired to sendWhatsAppTemplate yet — that only happens once the template
// is Meta-approved (see sendDailySummary's TODO). Deliberately synchronous and
// pure so it can be unit-tested in isolation without Airtable/network: it
// expects `summary.ownerName` to already be resolved and attached by the
// caller (via resolveOwnerName, above) before this runs — aggregateDailySummary
// itself is left untouched (sync, already tested, already reused by the
// manual report-trigger endpoint) rather than made async to fetch it inline.
//
// {{3}} date: CEO-confirmed the template needs human-readable output (e.g.
// "20 August 2026"), not the raw ISO YYYY-MM-DD aggregateDailySummary
// produces — reformatted here via formatHumanDate, above. summary.date
// itself is left untouched.
//
// Throws rather than silently defaulting if ownerName is missing: sending
// "undefined" or a guessed placeholder into a live WhatsApp template to a
// real owner is worse than a loud failure during wiring.
function dailySummaryTemplateParams(summary) {
  if (summary.ownerName === undefined || summary.ownerName === null) {
    throw new Error(
      'dailySummaryTemplateParams: summary.ownerName is missing — resolve it with ' +
      'resolveOwnerName(property) and attach it to the summary before calling this function.'
    );
  }
  return [
    summary.ownerName,
    summary.propertyName,
    formatHumanDate(summary.date),
    formatSignedAmount(summary.outstandingPayments.paymentDeltaTotal),
    summary.tomorrowsArrivals.length
  ];
}

// The send surface. STUBBED until DAILY_SUMMARY_TEMPLATE is approved: logs the
// full payload to Axiom (so content is verifiable now) and marks exactly where
// the template send goes — same stub pattern as sendOwnerSummary above.
//
// resolveOwnerName + dailySummaryTemplateParams are wired in HERE, not left as
// orphaned, unit-tested-only functions the way they were before this fix —
// this is the actual "one-line swap point" the TODO below refers to; before
// this change that comment was aspirational, since ownerName was never
// resolved or attached anywhere on the live path. Deliberately NOT
// try/caught in this function: dailySummaryTemplateParams throwing on a
// missing ownerName (a property with no linked WS_Owners record, or a
// linked one with no name set) is a real, loud signal that property is
// misconfigured — swallowing it here would silently produce a payload
// that would later crash the actual WhatsApp send once the template is
// approved, or worse, quietly send "undefined" to a real owner. Isolating
// ONE property's failure from the rest of a run is the caller's job
// (runDailySummary's per-property try/catch) — not this function's.
async function sendDailySummary(property, summary) {
  const notifyPhone = property.fields['Notify Phone']
    ? property.fields['Notify Phone'].replace(/[\s\-\+]/g, '')
    : (OWNER_PHONE || null);

  const ownerName = await resolveOwnerName(property);
  const summaryWithOwner = { ...summary, ownerName };
  const templateParams = dailySummaryTemplateParams(summaryWithOwner);

  const payload = { ...summaryWithOwner, template: DAILY_SUMMARY_TEMPLATE, notifyPhone, templateParams };
  // See the matching comment in sendOwnerSummary — deliberately no Airtable
  // write here either, for the same read-only-cron reason.
  logToAxiom('info', 'daily_summary_payload', payload);

  // TODO(Stage 3 part 3): once DAILY_SUMMARY_TEMPLATE is approved by Meta,
  // this is now genuinely the one-line swap point — templateParams above is
  // already the exact array sendWhatsAppTemplate needs:
  //   await sendWhatsAppTemplate(notifyPhone, DAILY_SUMMARY_TEMPLATE, templateParams, { site: 'daily_summary', propertyId: property.id });
  // Left stubbed here deliberately — enabling it is a separate, CEO-gated change
  // once the template exists, same reasoning as sendOwnerSummary's stub above.
  return payload;
}

// ─── WEEKLY VALUE-NUDGE ──────────────────────────────────────────────────────
// Deliberately a SEPARATE feature/template from OWNER_SUMMARY_TEMPLATE above,
// not a rename of it, even though both reuse aggregateOwnerSummary's 7-day
// window and both currently sit stubbed pending Meta approval. The owner
// summary is a full P&L reconciliation; this is a short "here's what's
// happening at your property" nudge whose PRACTICAL side effect is a second
// weekly touchpoint with the owner — WhatsApp's Coexistence rule disconnects
// a number after 14 days with no activity, so two independent weekly sends
// (this one + the owner summary, once both are live) each act as their own
// buffer even if one of the two fails or is skipped for a property.
//
// Scheduled Thursday 06:00 UTC (see vercel.json) — deliberately NOT the same
// day as owner-summary's Monday 06:00 UTC slot, so the two weekly touchpoints
// land spread across the week rather than bunched, which better serves the
// "keep the number active" goal than sending both on the same day would.
const VALUE_NUDGE_TEMPLATE = 'wabistay_owner_value_nudge';

// KNOWN DATA GAP, inherited and flagged rather than silently reused:
// aggregateOwnerSummary's occupancyRate is `roomNightsSold / (rooms.length *
// periodDays)` — it assumes every currently-bookable room was available for
// the ENTIRE period, with no accounting for a room added mid-period or one
// that spent part of the period in Maintenance. This value-nudge message
// inherits that same inaccuracy by reusing aggregateOwnerSummary unchanged
// (deliberately — building a second, parallel occupancy calculation here
// would only get the SAME wrong number a second, differently-shaped way).
// Fixing the denominator is out of scope for this PR.
function valueNudgeTemplateParams(summary) {
  const occupancyPct = `${Math.round(summary.occupancyRate * 100)}%`;
  const attention = summary.paymentDeltaTotal > 0
    ? `R${summary.paymentDeltaTotal.toFixed(2)} outstanding from this week`
    : 'all payments settled';
  return [
    summary.propertyName,
    String(summary.totalBookings),
    occupancyPct,
    String(summary.upcomingBookings),
    attention
  ];
}

// STUBBED until VALUE_NUDGE_TEMPLATE is approved by Meta — identical pattern
// to sendOwnerSummary/sendDailySummary above: logs the full payload to Axiom
// (content verifiable now) and marks the one-line swap point. Deliberately
// NOT a free-form sendWhatsApp — would 200-and-vanish outside the 24h window,
// same reasoning as every other business-initiated send in this file.
async function sendWeeklyValueNudge(property, summary) {
  const notifyPhone = property.fields['Notify Phone']
    ? property.fields['Notify Phone'].replace(/[\s\-\+]/g, '')
    : (OWNER_PHONE || null);
  const templateParams = valueNudgeTemplateParams(summary);
  const payload = { ...summary, template: VALUE_NUDGE_TEMPLATE, notifyPhone, templateParams };
  logToAxiom('info', 'weekly_value_nudge_payload', payload);

  // TODO: once VALUE_NUDGE_TEMPLATE is approved by Meta, this is the one-line
  // swap point:
  //   await sendWhatsAppTemplate(notifyPhone, VALUE_NUDGE_TEMPLATE, templateParams, { site: 'weekly_value_nudge', propertyId: property.id });
  return payload;
}

async function runWeeklyValueNudge(opts = {}) {
  const { now = new Date() } = opts;
  const periodDays = 7;
  const periodEndMs = now.getTime();
  const w = {
    periodDays,
    periodStartMs: periodEndMs - periodDays * DAY_MS,
    periodEndMs,
    upcomingEndMs: periodEndMs + 7 * DAY_MS
  };

  const properties = await airtableGet('WS_Properties', '');
  const allRooms = await airtableGet('WS_Rooms', orFormula('Status', BOOKABLE_ROOM_STATUSES));
  const allBookings = await airtableGet('WS_Bookings', orFormula('Status', BLOCKING_BOOKING_STATUSES.concat(['Checked Out'])));
  const allGuests = await airtableGet('WS_Guests', '');
  const guestsById = new Map(allGuests.map(g => [g.id, g.fields['Guest Name'] || null]));

  const sent = [];
  const failed = [];
  for (const property of properties) {
    // Per-property isolation, matching runOwnerSummary/runDailySummary's own
    // established pattern: one property throwing must not abort the rest of
    // this run. alertShawn fires per failing property (not once for the
    // whole run) so the alert itself names which property failed.
    try {
      const rooms = allRooms.filter(r => (r.fields['Property'] || []).includes(property.id));
      const roomIds = new Set(rooms.map(r => r.id));
      const bookings = allBookings.filter(b => (b.fields['Room'] || []).some(id => roomIds.has(id)));
      const summary = aggregateOwnerSummary(property, rooms, bookings, w, guestsById);
      await sendWeeklyValueNudge(property, summary);
      sent.push(summary);
    } catch (err) {
      logToAxiom('error', 'weekly_value_nudge_property_failed', {
        propertyId: property.id, propertyName: property.fields?.['Property Name'] || null,
        message: err.message, stack: err.stack
      });
      await alertShawn('weekly_value_nudge', err.message, {
        propertyId: property.id, propertyName: property.fields?.['Property Name'] || null
      });
      failed.push({ propertyId: property.id, propertyName: property.fields?.['Property Name'] || null, error: err.message });
    }
  }
  sent.failed = failed;
  return sent;
}

async function weeklyValueNudgeHandler(req, res) {
  try {
    const sent = await runWeeklyValueNudge();
    res.status(200).json({ ok: true, count: sent.length, sent, failed: sent.failed || [] });
  } catch (err) {
    console.error('[WEEKLY-VALUE-NUDGE FATAL]', err.message, err.stack);
    logToAxiom('error', 'weekly_value_nudge_fatal', { message: err.message, stack: err.stack });
    await alertShawn('weekly_value_nudge_fatal', err.message, { scope: 'entire run, not a single property' });
    res.status(200).json({ ok: false, error: err.message });
  }
}

async function runDailySummary(opts = {}) {
  const { now = new Date() } = opts;
  const shifted = new Date(now.getTime() + SAST_OFFSET_MS);
  const currentSastHour = shifted.getUTCHours();
  const todayYmd = sastCalendarDate(now);
  const tomorrowYmd = addSastDays(todayYmd, 1);

  const properties = await airtableGet('WS_Properties', '');
  const fired = [];
  const skipped = [];
  const failed = [];

  // Rooms/bookings/guests are fetched at most once per run, only if at least
  // one property's hour actually matches — most hourly invocations match
  // nothing, so this avoids three Airtable calls on 23/24 runs a day.
  let allRooms = null, allBookings = null, guestsById = null;

  for (const property of properties) {
    const configuredHour = property.fields['Daily Summary Hour'];
    if (configuredHour === undefined || configuredHour === null) {
      skipped.push({ propertyId: property.id, reason: 'not_configured' });
      continue;
    }
    if (Number(configuredHour) !== currentSastHour) {
      skipped.push({ propertyId: property.id, reason: 'hour_not_matched', configuredHour: Number(configuredHour) });
      continue;
    }

    // Per-property isolation: one property throwing here (e.g. sendDailySummary's
    // new ownerName resolution above, on a property with no linked/misconfigured
    // WS_Owners record) must not abort every OTHER property still waiting in this
    // same run — before this fix, an uncaught throw here propagated straight out
    // of the for-loop, silently skipping every remaining property until the outer
    // handler's catch-all, with no way to tell "genuinely zero activity" apart
    // from "crashed partway through" without checking Axiom by hand.
    try {
      if (allRooms === null) {
        // Unfiltered — includes Maintenance, unlike BOOKABLE_ROOM_STATUSES
        // elsewhere, since the room-state grid counts Maintenance separately
        // rather than silently dropping those rooms from the report.
        allRooms = await airtableGet('WS_Rooms', '');
        allBookings = await airtableGet('WS_Bookings', orFormula('Status', BLOCKING_BOOKING_STATUSES.concat(['Checked Out'])));
        const allGuests = await airtableGet('WS_Guests', '');
        guestsById = new Map(allGuests.map(g => [g.id, g.fields['Guest Name'] || null]));
      }

      const rooms = allRooms.filter(r => (r.fields['Property'] || []).includes(property.id));
      const roomIds = new Set(rooms.map(r => r.id));
      const bookings = allBookings.filter(b => (b.fields['Room'] || []).some(id => roomIds.has(id)));

      const summary = aggregateDailySummary(property, rooms, bookings, { todayYmd, tomorrowYmd }, guestsById);
      await sendDailySummary(property, summary);

      fired.push({ propertyId: property.id, propertyName: property.fields['Property Name'], summary });
    } catch (err) {
      logToAxiom('error', 'daily_summary_property_failed', {
        propertyId: property.id, propertyName: property.fields?.['Property Name'] || null,
        message: err.message, stack: err.stack
      });
      // Fires per property, not once for the whole run, so the alert itself
      // says which property failed rather than just "daily summary failed".
      await alertShawn('daily_summary', err.message, {
        propertyId: property.id, propertyName: property.fields?.['Property Name'] || null
      });
      failed.push({ propertyId: property.id, propertyName: property.fields?.['Property Name'] || null, error: err.message });
    }
  }
  return { currentSastHour, fired, skipped, failed };
}

async function dailySummaryHandler(req, res) {
  try {
    const result = await runDailySummary();
    res.status(200).json({ ok: true, ...result });
  } catch (err) {
    console.error('[DAILY-SUMMARY FATAL]', err.message, err.stack);
    logToAxiom('error', 'daily_summary_fatal', { message: err.message, stack: err.stack });
    await alertShawn('daily_summary_fatal', err.message, { scope: 'entire run, not a single property' });
    res.status(200).json({ ok: false, error: err.message });
  }
}

// ─── DISPATCHER ──────────────────────────────────────────────────────────────
// Reads states.json: global rows first (guarded), then the current state's rows.
// A row matches when `inputs` is "*" or contains the lowercased message.

function matchTransition(rows, text) {
  return rows.find(t => t.inputs === '*' || t.inputs.includes(text)) || null;
}

async function handleMessage(from, messageText, phoneNumberId, wamid) {
  const phone = formatPhone(from);
  const text = messageText.trim().toLowerCase();
  console.log(`[handleMessage] from: ${phone} | text: ${text}`);
  logToAxiom('info', 'message_received', { phone, text: messageText.slice(0, 100) });

  // 6.4: resolve property before anything else — no action may run for an
  // unconfigured number, and no property's data may leak to another's guest.
  const property = await resolveProperty(phoneNumberId);
  if (!property) {
    console.error(`[Dispatch] no WS_Properties match for phone_number_id: ${phoneNumberId} — refusing dispatch`);
    await sendWhatsApp(phone, msg('numberNotConfigured'));
    return;
  }
  // Best-effort, non-blocking — see bumpPropertyActivity's own comment.
  await bumpPropertyActivity(property.id, 'Last Message Received');

  const guestRecords = await airtableGet('WS_Guests', `{Phone Number} = '${phone}'`);
  const guest = guestRecords[0] || null;
  const sessionState = guest ? guest.fields['Session State'] : null;
  console.log(`[State] guest: ${guest ? guest.id : 'none'} | state: ${sessionState}`);

  // ── B14: STOP opt-out (two-tier) ───────────────────────────────────────────
  // Evaluated before consent and before dispatch, so an opting-out or already
  // opted-out guest never receives an optional message. Case-insensitive by
  // construction (text is already lowercased). Two-tier rule (CEO):
  //   · STOP instantly kills all OPTIONAL messaging.
  //   · TRANSACTION-COMPLETION messages for an already-active booking (Confirmed
  //     / Checked In) still deliver, until that booking closes.
  const activeBooking = ACTIVE_BOOKING_STATES.includes(sessionState);
  if (STOP_KEYWORDS.includes(text)) {
    // F43 (fix-order item 5a): STOP previously ran before any staff-identity
    // check and wrote 'Opted Out': true to WS_Guests for ANY number, staff or
    // guest — including creating a brand-new WS_Guests row for a cleaner/
    // reception/owner number never seen before. Confirmed by diagnosis this
    // never actually blocked an operational send (cleaner dispatch, owner
    // notify, reception notify all look up their target via WS_Cleaners/
    // WS_Roles/OWNER_PHONE directly, never WS_Guests) and never broke a staff
    // member's own commands (senderIsAuthorizedWalkin etc. resolve purely from
    // WS_Roles/WS_Cleaners too) — so this was data-hygiene pollution, not an
    // operational lockout. Fixed anyway: a stray Opted-Out guest row for a
    // staff seat is still wrong, and opt-out is a guest-facing concept a
    // staff number never meant to invoke by typing a word that happens to
    // collide. Same identity check the POPIA-consent block below already
    // uses, run here first instead — cost is one extra pair of reads, paid
    // only on the rare message that is literally "stop", not on every inbound
    // message.
    const isCleanerNumber = (await airtableGet('WS_Cleaners', `{Phone Number} = '${phone}'`)).length > 0;
    const isOwnerNumber = OWNER_PHONE && phone === formatPhone(OWNER_PHONE);
    const isStaffNumber = isCleanerNumber || isOwnerNumber || (await activeWalkinRoleForPhone(phone)) !== null;
    if (isStaffNumber) {
      logToAxiom('info', 'stop_ignored_staff_number', { phone });
      return;
    }
    const at = new Date().toISOString();
    // Rule 30 step 2, slice 2 — scope correction, not a slice default: this is
    // FATAL-style not because it's a WS_Guests write (most of this slice's
    // WS_Guests writes, like Session State, are NON-FATAL) but because of what
    // 'Opted Out' actually gates — every subsequent inbound message from this
    // number branches on it (the check just below this block). If this write
    // silently fails, telling the guest "you're opted out" while the record
    // still reads opted-IN means their very next message runs straight through
    // the booking flow instead of staying suppressed — a real compliance
    // mismatch, not a cosmetic miss. The rule was never "table X gets
    // treatment Y" — it's "does failure leave the system asserting something
    // false to the guest."
    const optOutWrite = guest
      ? await airtableUpdate('WS_Guests', guest.id, { 'Opted Out': true, 'Opted Out At': at })
      // STOP from a number we have never seen — record the opt-out so future
      // messages stay silent.
      : await airtableCreate('WS_Guests', {
          'Phone Number': phone, 'Guest Type': 'WhatsApp', 'Session State': 'NEW',
          'Opted Out': true, 'Opted Out At': at
        });
    if (optOutWrite && optOutWrite.error) {
      logToAxiom('error', 'guest_opt_out_write_failed', {
        phone, error: JSON.stringify(optOutWrite.error)
      });
      await sendWhatsApp(phone, msg('optOutWriteFailed'));
      return;
    }
    logToAxiom('info', 'guest_opted_out', { phone, activeBooking });
    // The single acknowledgement explaining status + how to opt back in.
    await sendWhatsApp(phone, msg('optedOut'));
    return;
  }
  if (guest && guest.fields['Opted Out']) {
    if (START_KEYWORDS.includes(text)) {
      // Rule 30 step 2, slice 2: same FATAL-style reasoning as the STOP write
      // above, mirrored — a silent failure here would tell the guest they're
      // opted back in while the record still reads opted-out, silencing the
      // booking flow on their very next message.
      const optInWrite = await airtableUpdate('WS_Guests', guest.id, { 'Opted Out': false, 'Opted Out At': null });
      if (optInWrite && optInWrite.error) {
        logToAxiom('error', 'guest_opt_in_write_failed', {
          phone, error: JSON.stringify(optInWrite.error)
        });
        await sendWhatsApp(phone, msg('optOutWriteFailed'));
        return;
      }
      logToAxiom('info', 'guest_opted_back_in', { phone });
      await sendWhatsApp(phone, msg('optedBackIn'));
      return;
    }
    if (!activeBooking) {
      // No active booking → optional messaging is silenced: the booking flow
      // never runs. Respond once with the opt-out status + how to opt back in.
      // (Strictly-once-then-total-silence would need a third tracking field — see
      // PR; only the two CEO-specified fields exist, so each optional inbound
      // gets the terse pointer, which is a compliant reply to a user message.)
      logToAxiom('info', 'opted_out_optional_suppressed', { phone, sessionState });
      await sendWhatsApp(phone, msg('optedOut'));
      return;
    }
    // Active booking: fall through to dispatch so transaction-completion
    // messages (gate arrival, checkout, extension) still deliver.
    logToAxiom('info', 'opted_out_transaction_allowed', { phone, sessionState });
  }

  // B13: POPIA consent notice. Notice-only, implied consent (CEO 16 July) — no
  // YES/1 opt-in gate. Sent as message #1 for a genuinely NEW guest conversation:
  // "new" = first-ever contact from this number, i.e. NO existing WS_Guests
  // record. A returning guest starting another booking already has a record and
  // does not see it again. Never sent to a registered cleaner or the owner. The
  // STOP line references B14 (Step 6 of this sprint) — valid by merge time, since
  // both branches merge together (ordering dependency noted in the PR).
  if (!guest) {
    const isCleaner = (await airtableGet('WS_Cleaners', `{Phone Number} = '${phone}'`)).length > 0;
    const isOwner = OWNER_PHONE && phone === formatPhone(OWNER_PHONE);
    // B7: a staff seat is not a guest. Without this, the first WALKIN ever sent
    // from a reception handset answers with a POPIA notice about that person's
    // own data — same category error the cleaner and owner exclusions above
    // already fix. Costs one extra read, and only for a number we have never
    // seen before.
    const isStaff = (await activeWalkinRoleForPhone(phone)) !== null;
    if (!isCleaner && !isOwner && !isStaff) {
      await sendWhatsApp(phone, msg('consentNotice', { propertyName: property.fields['Property Name'] }));
      logToAxiom('info', 'popia_consent_sent', { phone });
    }
  }

  const ctx = { phone, text, messageText, wamid, guest, next: null, cleaner: null, property };

  // Global transitions (cleaner DONE) — guard decides, any state
  for (const t of STATES.global) {
    if (t.inputs !== '*' && !t.inputs.includes(text)) continue;
    if (t.guard && !(await guards[t.guard](ctx))) continue;
    ctx.next = t.next || null;
    console.log(`[Dispatch] global → ${t.action}`);
    return actions[t.action](ctx);
  }

  // State routing: no guest / no state / NEW all route to NEW; unknown states to "*"
  const stateKey = (!guest || !sessionState || sessionState === 'NEW')
    ? 'NEW'
    : (STATES.states[sessionState] ? sessionState : '*');

  const transition = matchTransition(STATES.states[stateKey], text);
  if (!transition) return; // unreachable while every state has a "*" row
  ctx.next = transition.next || null;
  console.log(`[Dispatch] ${stateKey} → ${transition.action}${ctx.next ? ' → ' + ctx.next : ''}`);
  return actions[transition.action](ctx);
}

// ─── MAIN HANDLER ────────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  if (req.method === 'GET') {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];
    if (mode === 'subscribe' && token === WA_VERIFY_TOKEN) {
      console.log('Webhook verified');
      return res.status(200).send(challenge);
    }
    return res.status(403).send('Forbidden');
  }

  if (req.method === 'POST') {
    // F1: explicit body parse guard — req.body can be undefined or a raw string
    // depending on how Meta sends the webhook and Vercel's body parser state
    let body = req.body;
    if (!body) {
      console.error('[BODY] req.body is undefined — body parser did not run');
      res.status(200).send('OK');
      return;
    }
    if (typeof body === 'string') {
      try {
        body = JSON.parse(body);
        console.log('[BODY] Parsed raw string body successfully');
      } catch (e) {
        console.error('[BODY] Failed to parse body string:', e.message);
        res.status(200).send('OK');
        return;
      }
    }

    const entry = body?.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;
    const messages = value?.messages;
    const phoneNumberId = value?.metadata?.phone_number_id;

    console.log(`[POST] entry: ${!!entry} | messages: ${messages?.length || 0}`);

    // B3: delivery-status callbacks (sent/delivered/read/failed) — log each to Axiom,
    // then return. Mutually exclusive with `messages` in Meta's payload shape. In
    // production this branch is normally pre-empted by the master router's own copy
    // of this same check (api/webhook.js), which is the actual Meta-configured
    // entry point — kept here too so this handler is still correct if it's ever
    // invoked directly (its own dedicated webhook URL, or in tests).
    const statuses = value?.statuses;
    if (statuses && statuses.length > 0) {
      for (const s of statuses) {
        const detail = { wamid: s.id, status: s.status, timestamp: s.timestamp, recipient: s.recipient_id };
        if (s.status === 'failed' && s.errors) detail.errors = s.errors;
        logToAxiom('info', 'whatsapp_status_callback', detail);

        // Proxy for "owner opened WhatsApp" — see bumpPropertyActivity's
        // comment for why this is a proxy, not a real Meta app-open event.
        if (s.status === 'read' && s.recipient_id) {
          const recipient = formatPhone(String(s.recipient_id));
          airtableGet('WS_Properties', `{Notify Phone} = '${recipient}'`)
            .then(matches => {
              if (matches[0]) return bumpPropertyActivity(matches[0].id, 'Last Owner App Open');
            })
            .catch(err => logToAxiom('warn', 'owner_app_open_lookup_failed', { recipient, error: err.message }));
        }
      }
      res.status(200).send('OK');
      return;
    }

    if (!messages || messages.length === 0) {
      // F2: respond 200 before returning on no-message events (status updates etc)
      res.status(200).send('OK');
      return;
    }

    const message = messages[0];
    const from = message.from;
    const messageText = message?.text?.body;
    const wamid = message.id || null;

    console.log(`[POST] from: ${from} | text: ${messageText}`);

    if (!messageText) {
      res.status(200).send('OK');
      return;
    }

    // F2: handleMessage runs FULLY before we respond 200
    try {
      await handleMessage(from, messageText, phoneNumberId, wamid);
    } catch (err) {
      console.error('[FATAL]', err.message, err.stack);
      logToAxiom('error', 'fatal', { message: err.message, stack: err.stack });
    }

    res.status(200).send('OK');
    return;
  }

  res.status(405).send('Method Not Allowed');
};

// B7: exported for test/dates.test.js only. The SAST parser's interesting cases
// are near-midnight ones that need a frozen clock, which the fixture replay
// harness has no way to express — so they're unit-tested against these directly.
module.exports.parseBookingDate = parseBookingDate;
module.exports.sastToUtcIso = sastToUtcIso;
module.exports.sastCalendarDate = sastCalendarDate;
module.exports.addSastDays = addSastDays;
module.exports.compareYmd = compareYmd;
// B8: exported for test/availability.test.js. The exclusive-bounds behaviour is
// only observable when a check-in instant exactly equals a check-out instant,
// which the overnight flow can never produce (14:00 never equals 10:00) — so it
// is unreachable through a fixture and has to be tested here. See that file.
module.exports.rangesOverlap = rangesOverlap;
// B9: duration arithmetic and arrival-time parsing. addHoursToIso is the piece
// the mutation test targets — wrong by an hour and every hourly availability
// check silently examines the wrong window.
module.exports.parseArrivalTime = parseArrivalTime;
module.exports.addHoursToIso = addHoursToIso;
module.exports.hourlyRates = hourlyRates;
module.exports.formatSastDateTime = formatSastDateTime;
// F20: exported for parser unit coverage — findDateTokens locates the spans,
// parseBookingDate (already exported) validates them.
module.exports.findDateTokens = findDateTokens;
// B7 (WALKIN): the command grammar is pure and has no Airtable dependency, so it
// is tested exhaustively here — see test/walkin.parser.test.js. The handler that
// consumes it (authorisation, room resolution, booking write) is a separate,
// schema-dependent commit.
module.exports.parseWalkinCommand = parseWalkinCommand;
// B8 (PAID): the command grammar is pure and Airtable-free, so it is unit-tested
// directly — see test/paid.test.js.
module.exports.parsePaidCommand = parsePaidCommand;
// Cleaning time: the START grammar is pure, and the bare-`START` case is the one
// that must never regress (it is B14's opt-back-in keyword). Unit-tested in
// test/cleaningtime.test.js alongside the derived metrics.
module.exports.parseStartCleaningCommand = parseStartCleaningCommand;
module.exports.cleaningDurations = cleaningDurations;
// B12: the auto-checkout cron entry point (autoCheckoutHandler wraps it for the
// Vercel HTTP cron; runAutoCheckout takes an injected `now` for timing tests).
module.exports.runAutoCheckout = runAutoCheckout;
module.exports.autoCheckoutHandler = autoCheckoutHandler;
// B17: owner summary aggregation. runOwnerSummary(opts) takes injected now/daily
// for tests; ownerSummaryHandler is the Vercel HTTP cron entry.
module.exports.runOwnerSummary = runOwnerSummary;
module.exports.ownerSummaryHandler = ownerSummaryHandler;
module.exports.runWeeklyValueNudge = runWeeklyValueNudge;
module.exports.weeklyValueNudgeHandler = weeklyValueNudgeHandler;
module.exports.sendWeeklyValueNudge = sendWeeklyValueNudge;
module.exports.valueNudgeTemplateParams = valueNudgeTemplateParams;
module.exports.VALUE_NUDGE_TEMPLATE = VALUE_NUDGE_TEMPLATE;
module.exports.runDailySummary = runDailySummary;
module.exports.dailySummaryHandler = dailySummaryHandler;
// Stage 3 part 2: daily summary content sections, exported individually so
// each can be unit-tested apart from the full hour-matching loop.
module.exports.aggregateDailySummary = aggregateDailySummary;
module.exports.roomStateGrid = roomStateGrid;
module.exports.isNoShow = isNoShow;
module.exports.overnightStatsToday = overnightStatsToday;
module.exports.hourlyStatsToday = hourlyStatsToday;
module.exports.cleaningTurnaroundToday = cleaningTurnaroundToday;
module.exports.revenueToday = revenueToday;
module.exports.tomorrowsOvernightArrivals = tomorrowsOvernightArrivals;
module.exports.aggregateOwnerSummary = aggregateOwnerSummary;
module.exports.paymentReconciliationLines = paymentReconciliationLines;
module.exports.formatPaymentReconciliationMessage = formatPaymentReconciliationMessage;
// B19: enquiry-abandonment staleness sweep (injected `now` for timing tests).
module.exports.runEnquiryAbandonment = runEnquiryAbandonment;
// Rule 30 step 1: exported so the new success-vs-failure logging on these three
// shared write/send functions is testable directly — see
// test/success-logging.test.js — rather than only indirectly through whichever
// handler happens to call them.
module.exports.airtableCreate = airtableCreate;
module.exports.airtableUpdate = airtableUpdate;
module.exports.sendWhatsApp = sendWhatsApp;
module.exports.alertShawn = alertShawn;
module.exports.getAlertPhone = getAlertPhone;
module.exports.bumpPropertyActivity = bumpPropertyActivity;
// CEO manual report-trigger (api/wabistay/cron/manual-report.js) needs these
// to build the SAME live-data fetch + stubbed-send pipeline the real crons
// use, without duplicating the Airtable query/pagination logic here.
module.exports.airtableGet = airtableGet;
module.exports.orFormula = orFormula;
module.exports.BLOCKING_BOOKING_STATUSES = BLOCKING_BOOKING_STATUSES;
module.exports.BOOKABLE_ROOM_STATUSES = BOOKABLE_ROOM_STATUSES;
module.exports.sendDailySummary = sendDailySummary;
module.exports.sendOwnerSummary = sendOwnerSummary;
// Stage 3 part 3 prep (dailySummaryTemplateParams) — exported for isolated
// unit testing per the TODO at sendDailySummary; NOT wired to a live send.
module.exports.resolveOwnerName = resolveOwnerName;
module.exports.formatSignedAmount = formatSignedAmount;
module.exports.formatHumanDate = formatHumanDate;
module.exports.dailySummaryTemplateParams = dailySummaryTemplateParams;
