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

// ─── AIRTABLE HELPERS ───────────────────────────────────────────────────────

async function airtableGet(table, filterFormula) {
  const url = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(table)}?filterByFormula=${encodeURIComponent(filterFormula)}`;
  console.log(`[Airtable GET] ${table} | ${filterFormula}`);
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${AIRTABLE_API_KEY}` }
  });
  // F6: log HTTP status so we can see 401/403/404 in logs
  console.log(`[Airtable GET STATUS] ${table} | HTTP ${res.status}`);
  const data = await res.json();
  if (data.error) {
    console.error(`[Airtable ERROR] ${table}:`, JSON.stringify(data.error));
    logToAxiom('error', 'airtable_get_error', { table, filterFormula, status: res.status, error: JSON.stringify(data.error) });
  }
  return data.records || [];
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
  }
  return data;
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
  }
  return data;
}

// ─── FORMAT PHONE ────────────────────────────────────────────────────────────

function formatPhone(raw) {
  let clean = raw.replace(/[\s\-\+]/g, '');
  if (clean.startsWith('0')) clean = '27' + clean.slice(1);
  return clean;
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

function logToAxiom(level, event, detail = {}) {
  if (!AXIOM_TOKEN) return;
  const payload = [{
    _time: new Date().toISOString(),
    level,
    event,
    ...detail
  }];
  fetch('https://api.axiom.co/v1/datasets/wabistay/ingest', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${AXIOM_TOKEN}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  }).catch(err => console.error('[Axiom ERROR]', err.message));
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
  const blocking = await airtableGet('WS_Bookings', orFormula('Status', BLOCKING_BOOKING_STATUSES));
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

const guards = {
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
    const cleanerRecords = await airtableGet('WS_Cleaners', `{Phone Number} = '${ctx.phone}'`);
    if (cleanerRecords.length === 0) return false;
    const cleaningRooms = await airtableGet('WS_Rooms', `{Status} = 'Cleaning'`);
    const match = cleaningRooms.find(r => roomMatchesText(r, ctx.text));
    if (!match) return false;
    ctx.cleaner = cleanerRecords[0];
    ctx.matchedCleaningRoom = match;
    return true;
  }
};

// Shared by cleanerDone (unambiguous case) and cleanerRoomReply (disambiguated
// case) -- same side effects either way: room -> Available, thank the cleaner,
// notify the owner.
async function resolveRoomClean(ctx, room) {
  await airtableUpdate('WS_Rooms', room.id, { 'Status': 'Available' });
  logToAxiom('info', 'state_transition', { phone: ctx.phone, roomId: room.id, roomName: room.fields['Room Name'], from: 'Cleaning', to: 'Available', reason: 'cleaner_done' });
  await sendWhatsApp(ctx.phone, msg('cleanerThanks', { roomName: room.fields['Room Name'] }));
  if (OWNER_PHONE) {
    logOwnerSendWindow('room_cleaned', OWNER_PHONE, ctx.phone); // B17 instrumentation
    await sendWhatsApp(OWNER_PHONE, msg('ownerRoomCleaned', { roomName: room.fields['Room Name'] }));
  }
}

// ─── ACTION HANDLERS ─────────────────────────────────────────────────────────
// Each handler owns its side effects and write ORDER (frozen by fixtures).
// The Session State it writes comes from the transition's `next` in states.json.

const actions = {
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
  async greetAndAskDetails(ctx) {
    // F5-style: FIND/ARRAYJOIN confirmed unreliable for this filter (live-tested
    // 6.4 verification — matched 0 of 3 correctly-linked rooms). Fetch unscoped,
    // filter by property inclusion in JS, same pattern as airtableGetBookingsByGuestId.
    const allAvailableRooms = await airtableGet('WS_Rooms', `{Status} = 'Available'`);
    const availableRooms = allAvailableRooms.filter(r => (r.fields['Property'] || []).includes(ctx.property.id));
    const roomCount = availableRooms.length;
    // F4: was {Active} = 1
    const allActiveRates = await airtableGet('WS_Rates', `{Active} = TRUE()`);
    const activeRates = allActiveRates.filter(r => (r.fields['Property'] || []).includes(ctx.property.id));
    const rateText = activeRates.length > 0
      ? activeRates.map(r =>
          `• ${r.fields['Rate Name']}: R${r.fields['Amount']} ${r.fields['Rate Type'] === 'Per Night' ? 'per night' : 'per hour'}`
        ).join('\n')
      : '• Contact us for current rates';

    // Data-quality signal: rows with an empty Property field never match the
    // scoped filter above and so silently vanish from every property's greeting.
    // Schema can't force this field non-empty, so surface gaps instead of guessing.
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
      await airtableCreate('WS_Guests', {
        'Guest Name': 'Unknown',
        'Phone Number': ctx.phone,
        'Guest Type': 'WhatsApp',
        'Session State': ctx.next,
        'First Visit': new Date().toISOString().split('T')[0]
      });
    } else {
      await airtableUpdate('WS_Guests', ctx.guest.id, { 'Session State': ctx.next });
    }

    await sendWhatsApp(ctx.phone, msg('greeting', {
      propertyName: ctx.property.fields['Property Name'],
      propertyCityLine: propertyCityLine(ctx.property),
      roomCountText: `${roomCount} room${roomCount !== 1 ? 's' : ''}`,
      rateText
    }));
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

    await airtableUpdate('WS_Guests', ctx.guest.id, {
      'Guest Name': guestName,
      'Session State': ctx.next,
      'Last Inbound At': now.toISOString() // B19: staleness anchor for the abandonment sweep
    });

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
      await airtableUpdate('WS_Bookings', booking.id, { 'Booking Ref': bookingRef });
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

    // F7: notify owner on new booking (owner copy carries no rate, so it is
    // correct to send before occupancy is chosen — the human owner sees the
    // enquiry immediately and can finalise price if the fail-closed path fires).
    if (OWNER_PHONE) {
      logOwnerSendWindow('new_booking', OWNER_PHONE, ctx.phone); // B17 instrumentation
      await sendWhatsApp(OWNER_PHONE, msg('ownerNewBooking', {
        guestName, phone: ctx.phone, bookingRef, checkIn, checkOut: checkOut || 'TBC'
      }));
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

    // F5-style JS filter — see greetAndAskDetails. Match on {Occupancy Type}, the
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
      await airtableUpdate('WS_Guests', ctx.guest.id, { 'Session State': ctx.next, 'Last Inbound At': new Date().toISOString() });
      await sendWhatsApp(ctx.phone, msg('occupancyContactOwner', { guestName }));
      return;
    }

    await airtableUpdate('WS_Bookings', booking.id, {
      'Rate Applied': [rate.id],
      'Amount Due': rate.fields['Amount']
    });
    await airtableUpdate('WS_Guests', ctx.guest.id, { 'Session State': ctx.next, 'Last Inbound At': new Date().toISOString() });
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
        await airtableUpdate('WS_Guests', ctx.guest.id, { 'Session State': 'AWAITING_DETAILS' });
      } else {
        await airtableCreate('WS_Guests', {
          'Guest Name': 'Unknown',
          'Phone Number': ctx.phone,
          'Guest Type': 'WhatsApp',
          'Session State': 'AWAITING_DETAILS',
          'First Visit': new Date().toISOString().split('T')[0]
        });
      }
      await sendWhatsApp(ctx.phone, msg('hourlyUnavailable', {
        propertyName: ctx.property.fields['Property Name']
      }));
      return;
    }

    if (ctx.guest) {
      await airtableUpdate('WS_Guests', ctx.guest.id, { 'Session State': ctx.next });
    } else {
      await airtableCreate('WS_Guests', {
        'Guest Name': 'Unknown',
        'Phone Number': ctx.phone,
        'Guest Type': 'WhatsApp',
        'Session State': ctx.next,
        'First Visit': new Date().toISOString().split('T')[0]
      });
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
      await airtableUpdate('WS_Guests', ctx.guest.id, { 'Session State': 'AWAITING_DETAILS' });
      await sendWhatsApp(ctx.phone, msg('hourlyUnavailable', { propertyName: ctx.property.fields['Property Name'] }));
      return;
    }

    await airtableUpdate('WS_Guests', ctx.guest.id, {
      'Guest Name': guestName,
      'Session State': ctx.next,
      'Last Inbound At': new Date().toISOString() // B19: staleness anchor for the abandonment sweep
    });

    // The duration menu arrives as a separate WhatsApp message — a separate
    // serverless invocation with no shared memory — so the arrival time has to
    // be persisted. It goes on a booking record rather than scratch storage,
    // the same way WS1 parks the ETA: this row IS the guest's booking, just not
    // yet priced. With Check Out still blank it holds no room and blocks
    // nothing (B8's blank-date rule), so an abandoned one is inert rather than
    // phantom inventory. Reused rather than duplicated if the guest re-enters
    // a time after being told there is no availability.
    const pending = await findPendingHourlyBooking(ctx.guest.id);
    if (pending) {
      await airtableUpdate('WS_Bookings', pending.id, { 'Check In': checkInIso });
    } else {
      await airtableCreate('WS_Bookings', {
        'Guest': [ctx.guest.id],
        'Booking Type': 'Hourly',
        'Source': 'WhatsApp',
        'Status': 'Enquiry',
        'Logged By': 'WhatsApp Bot',
        'Check In': checkInIso,
        'Payment Status': 'Unpaid'
      });
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
      if (pending) await airtableUpdate('WS_Bookings', pending.id, { 'Status': 'Cancelled' });
      await airtableUpdate('WS_Guests', ctx.guest.id, { 'Session State': 'AWAITING_DETAILS' });
      logToAxiom('info', 'hourly_redirect_overnight', { phone: ctx.phone, requestedHours: choice });
      await sendWhatsApp(ctx.phone, msg('hourlyTooLong'));
      return;
    }

    const checkInIso = pending && pending.fields['Check In'];
    if (!Number.isInteger(choice) || choice < 1 || !checkInIso || !rates) {
      // Unreadable choice, or the flow lost its footing (no pending booking,
      // rates pulled mid-conversation). Re-offer rather than dead-end.
      if (!checkInIso || !rates) {
        await airtableUpdate('WS_Guests', ctx.guest.id, { 'Session State': 'AWAITING_DETAILS' });
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
      await airtableUpdate('WS_Guests', ctx.guest.id, { 'Session State': 'AWAITING_HOURLY_DETAILS' });
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
    await airtableUpdate('WS_Bookings', pending.id, {
      'Check Out': checkOutIso,
      'Room': [room.id],
      'Booking Ref': bookingRef,
      'Notes': `Short stay: ${durationText(choice)} from ${formatSastDateTime(checkInIso)}`,
      // Amount Due carries the price. Rate Applied is deliberately left empty:
      // it links to WS_Rates, and hourly prices live as WS_Properties fields,
      // which cannot be linked to. Blank, not dangling — B17 aggregates on
      // Amount Due, which is populated for every booking type.
      'Amount Due': amount
    });
    logToAxiom('info', 'booking_create', {
      phone: ctx.phone, guestName, bookingRef, bookingType: 'Hourly',
      hours: choice, airtableId: pending.id
    });

    await airtableUpdate('WS_Guests', ctx.guest.id, { 'Session State': ctx.next });
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
      await sendWhatsApp(OWNER_PHONE, msg('hourlyOwnerNewBooking', { ...view, phone: ctx.phone }));
    }
    await sendWhatsApp(ctx.phone, msg('hourlyBookingReceived', view));
  },

  // AWAITING_ETA: record ETA, confirm booking
  async recordEta(ctx) {
    const eta = ctx.messageText.trim();
    // F5: was FIND/ARRAYJOIN — now JS filter on fetched records
    const bookings = await airtableGetBookingsByGuestId(ctx.guest.id, 'Enquiry');
    const confirmedBooking = bookings[0] || null;
    if (confirmedBooking) {
      await airtableUpdate('WS_Bookings', confirmedBooking.id, {
        'ETA': eta,
        'Status': 'Confirmed'
      });
    }
    await airtableUpdate('WS_Guests', ctx.guest.id, { 'Session State': ctx.next });
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
    // F5-style: see greetAndAskDetails — FIND/ARRAYJOIN confirmed unreliable, JS-filter instead
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
    if (assignedRoomId) {
      await airtableUpdate('WS_Rooms', assignedRoomId, { 'Status': 'Occupied' });
    }

    // Step 4: booking → Checked In + link room + timestamp
    if (booking) {
      const bookingUpdate = {
        'Status': 'Checked In',
        'Checked In At': new Date().toISOString()
      };
      if (assignedRoomId) bookingUpdate['Room'] = [assignedRoomId];
      await airtableUpdate('WS_Bookings', booking.id, bookingUpdate);
    }

    // Step 5: session → CHECKED_IN
    await airtableUpdate('WS_Guests', ctx.guest.id, { 'Session State': ctx.next });
    logToAxiom('info', 'state_transition', { phone: ctx.phone, guestId: ctx.guest.id, from: 'CONFIRMED', to: ctx.next, assignedRoom: assignedRoomName || null });

    // Step 6: notify party
    if (notifyPhone) {
      logOwnerSendWindow('gate_arrival', notifyPhone, ctx.phone); // B17 instrumentation
      await sendWhatsApp(notifyPhone, msg('gateNotify', {
        guestName: ctx.guest.fields['Guest Name'],
        roomInfo: assignedRoomName
          ? msg('gateRoomAssignedInfo', { roomName: assignedRoomName })
          : msg('gateNoRoomInfo'),
        phone: ctx.phone
      }));
    }

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
    if (bookings.length > 0) {
      await airtableUpdate('WS_Bookings', bookings[0].id, { 'Status': 'Cancelled' });
    }
    await airtableUpdate('WS_Guests', ctx.guest.id, { 'Session State': ctx.next });
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
    if (bookings.length > 0) {
      const booking = bookings[0];
      await airtableUpdate('WS_Bookings', booking.id, {
        'Status': 'Checked Out',
        'Checkout Confirmed': true
      });
      if (booking.fields['Room'] && booking.fields['Room'].length > 0) {
        const roomId = booking.fields['Room'][0];
        const roomRecords = await airtableGet('WS_Rooms', `RECORD_ID() = '${roomId}'`);
        if (roomRecords.length > 0) {
          roomName = roomRecords[0].fields['Room Name'];
          await airtableUpdate('WS_Rooms', roomId, { 'Status': 'Cleaning' });
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
    // F4: was {Active} = 1
    const cleaners = await airtableGet('WS_Cleaners', `{Active} = TRUE()`);
    // DIAG (temporary — cleaner-notify send path instrumentation, remove once resolved):
    console.log(`[Cleaner Dispatch DIAG] cleaner count: ${cleaners.length} | raw phone fields:`, JSON.stringify(cleaners.map(c => c.fields['Phone Number'])));
    for (const cleaner of cleaners) {
      const cleanerPhone = cleaner.fields['Phone Number'];
      const cleanerName = cleaner.fields['Cleaner Name'];
      if (cleanerPhone) {
        const formattedCleanerPhone = formatPhone(cleanerPhone);
        console.log(`[Cleaner Dispatch DIAG] formatted phone about to be used: ${formattedCleanerPhone}`);
        const sendResult = await sendWhatsApp(formattedCleanerPhone, msg('cleanerDispatch', { cleanerName, roomName }));
        console.log(`[Cleaner Dispatch DIAG] raw sendWhatsApp return value:`, JSON.stringify(sendResult));
      }
    }
    await airtableUpdate('WS_Guests', ctx.guest.id, { 'Session State': ctx.next });
    logToAxiom('info', 'state_transition', { phone: ctx.phone, guestId: ctx.guest.id, from: 'CHECKED_IN', to: ctx.next, reason: 'checkout', roomName });
    await sendWhatsApp(ctx.phone, msg('checkoutThanks', { propertyName: ctx.property.fields['Property Name'] }));
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

    const extendMs = EXTENSION_MS[booking.fields['Booking Type']] || EXTENSION_MS.Overnight;
    const newCheckOut = new Date(Date.parse(booking.fields['Check Out']) + extendMs).toISOString();
    const alreadyNotified = !!booking.fields['Extension Owner Notified'];

    const bookingUpdate = {
      'Check Out': newCheckOut,
      // Re-arm the warning cycle for the extended window.
      'Checkout Warning Sent At': null
    };
    // Set the flag only on the first extension — leave it untouched afterwards so
    // the write log shows no re-notify bookkeeping on later extensions.
    if (!alreadyNotified) bookingUpdate['Extension Owner Notified'] = true;
    await airtableUpdate('WS_Bookings', booking.id, bookingUpdate);

    if (!alreadyNotified && OWNER_PHONE) {
      await sendWhatsApp(OWNER_PHONE, msg('ownerExtension', {
        guestName,
        bookingRef: booking.fields['Booking Ref'] || '',
        checkOut: formatSastDateTime(newCheckOut)
      }));
    }
    logToAxiom('info', 'booking_extended', {
      phone: ctx.phone, bookingId: booking.id, newCheckOut, ownerNotified: !alreadyNotified
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
      await airtableUpdate('WS_Guests', ctx.guest.id, { 'Session State': ctx.next });
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
async function settleAutoCheckout(booking, room, guest, propertyName) {
  await airtableUpdate('WS_Bookings', booking.id, {
    'Status': 'Checked Out',
    'Checkout Confirmed': true
  });
  let roomName = 'your room';
  if (room) {
    roomName = room.fields['Room Name'];
    await airtableUpdate('WS_Rooms', room.id, { 'Status': 'Cleaning' });
    await airtableUpdate('WS_Rooms', room.id, { 'Cleaning Started At': new Date().toISOString() });
  }
  const cleaners = await airtableGet('WS_Cleaners', `{Active} = TRUE()`);
  for (const cleaner of cleaners) {
    const cleanerPhone = cleaner.fields['Phone Number'];
    if (cleanerPhone) {
      await sendWhatsApp(formatPhone(cleanerPhone), msg('cleanerDispatch', {
        cleanerName: cleaner.fields['Cleaner Name'], roomName
      }));
    }
  }
  if (guest) {
    await airtableUpdate('WS_Guests', guest.id, { 'Session State': 'NEW' });
  }
  const guestPhone = guest && formatPhone(String(guest.fields['Phone Number'] || ''));
  if (guestPhone) {
    await sendWhatsApp(guestPhone, msg('autoCheckoutThanks', { propertyName }));
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
      await airtableUpdate('WS_Bookings', booking.id, { 'Checkout Warning Sent At': now.toISOString() });
      if (guestPhone) await sendWhatsApp(guestPhone, msg('checkoutWarning', { guestName, propertyName }));
      logToAxiom('info', 'auto_checkout_warning', { bookingId: booking.id, phone: guestPhone || null, checkOut });
      summary.warnings++;
      continue;
    }
    if (nowMs >= Date.parse(warnedAt) + AUTO_CHECKOUT_GRACE_MS) {
      // Grace elapsed, no extension, no manual checkout → auto-checkout.
      await settleAutoCheckout(booking, room, guest, propertyName);
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
// A guest who produced a valid booking DRAFT (occupancy/eta/duration) but went
// silent is Abandoned. (A guest still stuck at the details step — the parser kept
// re-prompting — is logged Invalid Input immediately at that reject, which also
// keeps ctx.property in hand for scoping; the sweep only handles Abandoned.)
const ENQUIRY_ABANDON_STATES = ['AWAITING_OCCUPANCY', 'AWAITING_ETA', 'AWAITING_HOURLY_DURATION'];

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
  await airtableCreate('WS_Enquiries', fields);
  logToAxiom('info', 'enquiry_logged', { phone, propertyId: property.id, outcome, bookingType: bookingType || null });
  return true;
}

// Staleness sweep for Abandoned. Runs on the auto-checkout cron. A guest sitting
// in a draft-bearing enquiry state, who provided a name and whose last inbound is
// older than the window, with no enquiry row already covering this attempt, is
// logged Abandoned. Property is recovered from the guest's pending booking's room.
async function runEnquiryAbandonment(now = new Date()) {
  const nowMs = now.getTime();
  const summary = { abandoned: 0 };
  const guests = await airtableGet('WS_Guests', orFormula('Session State', ENQUIRY_ABANDON_STATES));
  const enquiries = await airtableGet('WS_Enquiries', '');

  for (const guest of guests) {
    const name = guest.fields['Guest Name'];
    if (!name || name === 'Unknown') continue;                 // "provided at least a name"
    const lastInbound = guest.fields['Last Inbound At'];
    if (!lastInbound || (nowMs - Date.parse(lastInbound)) < ENQUIRY_ABANDON_MS) continue;

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
    if (!property) continue; // cannot scope without a property — leave for a later run

    await logEnquiry(property, phone, 'Abandoned', {
      checkInIso: pending && pending.fields['Check In'],
      checkOutIso: pending && pending.fields['Check Out'],
      bookingType: pending && pending.fields['Booking Type']
    });
    logToAxiom('info', 'enquiry_abandoned', { phone, guestId: guest.id, sessionState: guest.fields['Session State'] });
    summary.abandoned++;
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

// Aggregates one property's bookings over the reporting window. `bookings` is
// already scoped to this property (via room link) and already excludes Cancelled.
function aggregateOwnerSummary(property, rooms, bookings, w) {
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
    upcomingBookings
  };
}

// The send surface. STUBBED until OWNER_SUMMARY_TEMPLATE is approved: logs the
// full payload to Axiom (so aggregation is verifiable now) and marks exactly
// where the template send goes.
async function sendOwnerSummary(property, summary) {
  const notifyPhone = property.fields['Notify Phone']
    ? property.fields['Notify Phone'].replace(/[\s\-\+]/g, '')
    : (OWNER_PHONE || null);
  const payload = { ...summary, template: OWNER_SUMMARY_TEMPLATE, notifyPhone };
  logToAxiom('info', 'owner_summary_payload', payload);

  // TODO(B17): once OWNER_SUMMARY_TEMPLATE is approved by Meta, send it here as a
  // utility template (business-initiated, outside the 24h window — free-form text
  // silently fails). This is the one-line swap:
  //   await sendWhatsAppTemplate(notifyPhone, OWNER_SUMMARY_TEMPLATE, ownerSummaryTemplateParams(summary));
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

  const summaries = [];
  for (const property of properties) {
    const rooms = allRooms.filter(r => (r.fields['Property'] || []).includes(property.id));
    const roomIds = new Set(rooms.map(r => r.id));
    const bookings = allBookings.filter(b => (b.fields['Room'] || []).some(id => roomIds.has(id)));
    const summary = aggregateOwnerSummary(property, rooms, bookings, w);
    await sendOwnerSummary(property, summary);
    summaries.push(summary);
  }
  return summaries;
}

async function ownerSummaryHandler(req, res) {
  try {
    const summaries = await runOwnerSummary();
    res.status(200).json({ ok: true, count: summaries.length, summaries });
  } catch (err) {
    console.error('[OWNER-SUMMARY FATAL]', err.message, err.stack);
    logToAxiom('error', 'owner_summary_fatal', { message: err.message, stack: err.stack });
    res.status(200).json({ ok: false, error: err.message });
  }
}

// ─── DISPATCHER ──────────────────────────────────────────────────────────────
// Reads states.json: global rows first (guarded), then the current state's rows.
// A row matches when `inputs` is "*" or contains the lowercased message.

function matchTransition(rows, text) {
  return rows.find(t => t.inputs === '*' || t.inputs.includes(text)) || null;
}

async function handleMessage(from, messageText, phoneNumberId) {
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
    const at = new Date().toISOString();
    if (guest) {
      await airtableUpdate('WS_Guests', guest.id, { 'Opted Out': true, 'Opted Out At': at });
    } else {
      // STOP from a number we have never seen — record the opt-out so future
      // messages stay silent.
      await airtableCreate('WS_Guests', {
        'Phone Number': phone, 'Guest Type': 'WhatsApp', 'Session State': 'NEW',
        'Opted Out': true, 'Opted Out At': at
      });
    }
    logToAxiom('info', 'guest_opted_out', { phone, activeBooking });
    // The single acknowledgement explaining status + how to opt back in.
    await sendWhatsApp(phone, msg('optedOut'));
    return;
  }
  if (guest && guest.fields['Opted Out']) {
    if (START_KEYWORDS.includes(text)) {
      await airtableUpdate('WS_Guests', guest.id, { 'Opted Out': false, 'Opted Out At': null });
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
    if (!isCleaner && !isOwner) {
      await sendWhatsApp(phone, msg('consentNotice', { propertyName: property.fields['Property Name'] }));
      logToAxiom('info', 'popia_consent_sent', { phone });
    }
  }

  const ctx = { phone, text, messageText, guest, next: null, cleaner: null, property };

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

    console.log(`[POST] from: ${from} | text: ${messageText}`);

    if (!messageText) {
      res.status(200).send('OK');
      return;
    }

    // F2: handleMessage runs FULLY before we respond 200
    try {
      await handleMessage(from, messageText, phoneNumberId);
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
// B12: the auto-checkout cron entry point (autoCheckoutHandler wraps it for the
// Vercel HTTP cron; runAutoCheckout takes an injected `now` for timing tests).
module.exports.runAutoCheckout = runAutoCheckout;
module.exports.autoCheckoutHandler = autoCheckoutHandler;
// B17: owner summary aggregation. runOwnerSummary(opts) takes injected now/daily
// for tests; ownerSummaryHandler is the Vercel HTTP cron entry.
module.exports.runOwnerSummary = runOwnerSummary;
module.exports.ownerSummaryHandler = ownerSummaryHandler;
module.exports.aggregateOwnerSummary = aggregateOwnerSummary;
// B19: enquiry-abandonment staleness sweep (injected `now` for timing tests).
module.exports.runEnquiryAbandonment = runEnquiryAbandonment;
