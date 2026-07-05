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
  if (data.error) console.error(`[Airtable ERROR] ${table}:`, JSON.stringify(data.error));
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
  if (data.error) console.error(`[Airtable CREATE ERROR] ${table}:`, JSON.stringify(data.error));
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
  if (data.error) console.error(`[Airtable UPDATE ERROR] ${table}:`, JSON.stringify(data.error));
  return data;
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
  if (data.error) console.error(`[WhatsApp SEND ERROR]:`, JSON.stringify(data.error));
  return data;
}

// ─── FORMAT PHONE ────────────────────────────────────────────────────────────

function formatPhone(raw) {
  let clean = raw.replace(/[\s\-\+]/g, '');
  if (clean.startsWith('0')) clean = '27' + clean.slice(1);
  return clean;
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

// ─── GUARDS ──────────────────────────────────────────────────────────────────

const guards = {
  async senderIsCleaner(ctx) {
    const cleanerRecords = await airtableGet('WS_Cleaners', `{Phone Number} = '${ctx.phone}'`);
    ctx.cleaner = cleanerRecords[0] || null;
    return cleanerRecords.length > 0;
  }
};

// ─── ACTION HANDLERS ─────────────────────────────────────────────────────────
// Each handler owns its side effects and write ORDER (frozen by fixtures).
// The Session State it writes comes from the transition's `next` in states.json.

const actions = {
  // Cleaner replies DONE (global, any state)
  async cleanerDone(ctx) {
    // F4: was {Active} = 1 — Airtable checkbox requires TRUE()
    const cleaningRooms = await airtableGet('WS_Rooms', `{Status} = 'Cleaning'`);
    if (cleaningRooms.length > 0) {
      const room = cleaningRooms[0];
      await airtableUpdate('WS_Rooms', room.id, { 'Status': 'Available' });
      await sendWhatsApp(ctx.phone, msg('cleanerThanks', { roomName: room.fields['Room Name'] }));
      if (OWNER_PHONE) {
        await sendWhatsApp(OWNER_PHONE, msg('ownerRoomCleaned', { roomName: room.fields['Room Name'] }));
      }
    } else {
      await sendWhatsApp(ctx.phone, msg('cleanerNothingToClean'));
    }
  },

  // NEW guest (or reset): greet with availability + rates, ask for details (F10)
  async greetAndAskDetails(ctx) {
    const availableRooms = await airtableGet('WS_Rooms', `{Status} = 'Available'`);
    const roomCount = availableRooms.length;
    // F4: was {Active} = 1
    const activeRates = await airtableGet('WS_Rates', `{Active} = TRUE()`);
    const rateText = activeRates.length > 0
      ? activeRates.map(r =>
          `• ${r.fields['Rate Name']}: R${r.fields['Amount']} ${r.fields['Rate Type'] === 'Per Night' ? 'per night' : 'per hour'}`
        ).join('\n')
      : '• Contact us for current rates';

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
      roomCountText: `${roomCount} room${roomCount !== 1 ? 's' : ''}`,
      rateText
    }));
  },

  // AWAITING_DETAILS: parse name + dates, create Enquiry booking (F7, F13)
  async collectDetails(ctx) {
    const lines = ctx.messageText.trim().split('\n').map(l => l.trim()).filter(Boolean);
    let guestName = ctx.guest.fields['Guest Name'] !== 'Unknown' ? ctx.guest.fields['Guest Name'] : null;
    let checkIn = null;
    let checkOut = null;

    const dateKeywords = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec',
      'january','february','march','april','june','july','august','september','october','november','december'];

    lines.forEach((line, i) => {
      const lower = line.toLowerCase();
      const hasDate = dateKeywords.some(d => lower.includes(d)) || /\d{1,2}[\/\-]\d{1,2}/.test(lower);
      if (i === 0 && !hasDate && !guestName) {
        guestName = line;
      } else if (hasDate && !checkIn) {
        checkIn = line;
      } else if (hasDate && !checkOut) {
        checkOut = line;
      }
    });

    if (!guestName || !checkIn) {
      // Stay in AWAITING_DETAILS — no writes, reprompt only
      await sendWhatsApp(ctx.phone, msg('detailsReprompt'));
      return;
    }

    await airtableUpdate('WS_Guests', ctx.guest.id, {
      'Guest Name': guestName,
      'Session State': ctx.next
    });

    // F4: was {Active} = 1
    const activeRates = await airtableGet('WS_Rates', `{Active} = TRUE()`);
    const rate = activeRates[0] || null;

    const bookingData = {
      'Guest': [ctx.guest.id],
      'Booking Type': 'Overnight',
      'Source': 'WhatsApp',
      'Status': 'Enquiry',
      'Logged By': 'WhatsApp Bot',
      'Notes': `Check-in: ${checkIn}${checkOut ? ' | Check-out: ' + checkOut : ''}`,
      'Payment Status': 'Unpaid'
    };
    if (rate) {
      bookingData['Rate Applied'] = [rate.id];
      bookingData['Amount Due'] = rate.fields['Amount'];
    }

    const booking = await airtableCreate('WS_Bookings', bookingData);
    const bookingRef = booking.id ? `WS-${booking.id.slice(-6).toUpperCase()}` : 'WS-000001';
    // F13: write Booking Ref back to Airtable after CREATE
    if (booking.id) {
      await airtableUpdate('WS_Bookings', booking.id, { 'Booking Ref': bookingRef });
    }
    logToAxiom(booking.id ? 'info' : 'error', 'booking_create', {
      phone: ctx.phone,
      guestName,
      bookingRef,
      airtableId: booking.id || null,
      error: booking.error ? JSON.stringify(booking.error) : null
    });

    // F7: notify owner on new booking
    if (OWNER_PHONE) {
      await sendWhatsApp(OWNER_PHONE, msg('ownerNewBooking', {
        guestName, phone: ctx.phone, bookingRef, checkIn, checkOut: checkOut || 'TBC'
      }));
    }

    await sendWhatsApp(ctx.phone, msg('bookingReceived', {
      guestName, bookingRef, checkIn,
      checkOut: checkOut || 'TBC',
      rateLine: rate ? `*Rate:* R${rate.fields['Amount']} per night` : ''
    }));
  },

  // AWAITING_ETA: record ETA, confirm booking
  async recordEta(ctx) {
    const eta = ctx.messageText.trim();
    // F5: was FIND/ARRAYJOIN — now JS filter on fetched records
    const bookings = await airtableGetBookingsByGuestId(ctx.guest.id, 'Enquiry');
    if (bookings.length > 0) {
      await airtableUpdate('WS_Bookings', bookings[0].id, {
        'ETA': eta,
        'Status': 'Confirmed'
      });
    }
    await airtableUpdate('WS_Guests', ctx.guest.id, { 'Session State': ctx.next });
    await sendWhatsApp(ctx.phone, msg('etaConfirmed', { eta }));
  },

  // CONFIRMED → "1": gate arrival (F11)
  async gateArrival(ctx) {
    // Step 1: notify phone from WS_Properties, fallback to OWNER_PHONE
    const properties = await airtableGet('WS_Properties', `{Property Name} = 'Villa Liza Guest Lodge'`);
    const notifyPhone = (properties.length > 0 && properties[0].fields['Notify Phone'])
      ? properties[0].fields['Notify Phone'].replace(/[\s\-\+]/g, '')
      : OWNER_PHONE;

    // Step 2: first available room
    const availableRooms = await airtableGet('WS_Rooms', `{Status} = 'Available'`);
    let assignedRoomName = null;
    let assignedRoomId = null;
    if (availableRooms.length > 0) {
      assignedRoomId = availableRooms[0].id;
      assignedRoomName = availableRooms[0].fields['Room Name'];
      // Step 3: room → Occupied
      await airtableUpdate('WS_Rooms', assignedRoomId, { 'Status': 'Occupied' });
    }

    // Step 4: booking → Checked In + link room + timestamp
    const bookings = await airtableGetBookingsByGuestId(ctx.guest.id, 'Confirmed');
    if (bookings.length > 0) {
      const bookingUpdate = {
        'Status': 'Checked In',
        'Checked In At': new Date().toISOString()
      };
      if (assignedRoomId) bookingUpdate['Room'] = [assignedRoomId];
      await airtableUpdate('WS_Bookings', bookings[0].id, bookingUpdate);
    }

    // Step 5: session → CHECKED_IN
    await airtableUpdate('WS_Guests', ctx.guest.id, { 'Session State': ctx.next });

    // Step 6: notify party
    if (notifyPhone) {
      await sendWhatsApp(notifyPhone, msg('gateNotify', {
        guestName: ctx.guest.fields['Guest Name'],
        roomInfo: assignedRoomName
          ? msg('gateRoomAssignedInfo', { roomName: assignedRoomName })
          : msg('gateNoRoomInfo'),
        phone: ctx.phone
      }));
    }

    // Step 7: tell guest
    await sendWhatsApp(ctx.phone, assignedRoomName
      ? msg('welcomeAssigned', { roomName: assignedRoomName })
      : msg('welcomeUnassigned'));
  },

  // CONFIRMED → "2": cancel
  async cancelBooking(ctx) {
    // F5: was FIND/ARRAYJOIN
    const bookings = await airtableGetBookingsByGuestId(ctx.guest.id, 'Confirmed');
    if (bookings.length > 0) {
      await airtableUpdate('WS_Bookings', bookings[0].id, { 'Status': 'Cancelled' });
    }
    await airtableUpdate('WS_Guests', ctx.guest.id, { 'Session State': ctx.next });
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
        await sendWhatsApp(ctx.phone, msg('gateCooldownMenu', { guestName: ctx.guest.fields['Guest Name'] }));
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
        }
      }
    }
    // F4: was {Active} = 1
    const cleaners = await airtableGet('WS_Cleaners', `{Active} = TRUE()`);
    for (const cleaner of cleaners) {
      const cleanerPhone = cleaner.fields['Phone Number'];
      const cleanerName = cleaner.fields['Cleaner Name'];
      if (cleanerPhone) {
        await sendWhatsApp(formatPhone(cleanerPhone), msg('cleanerDispatch', { cleanerName, roomName }));
      }
    }
    await airtableUpdate('WS_Guests', ctx.guest.id, { 'Session State': ctx.next });
    await sendWhatsApp(ctx.phone, msg('checkoutThanks'));
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

// ─── DISPATCHER ──────────────────────────────────────────────────────────────
// Reads states.json: global rows first (guarded), then the current state's rows.
// A row matches when `inputs` is "*" or contains the lowercased message.

function matchTransition(rows, text) {
  return rows.find(t => t.inputs === '*' || t.inputs.includes(text)) || null;
}

async function handleMessage(from, messageText) {
  const phone = formatPhone(from);
  const text = messageText.trim().toLowerCase();
  console.log(`[handleMessage] from: ${phone} | text: ${text}`);
  logToAxiom('info', 'message_received', { phone, text: messageText.slice(0, 100) });

  const guestRecords = await airtableGet('WS_Guests', `{Phone Number} = '${phone}'`);
  const guest = guestRecords[0] || null;
  const sessionState = guest ? guest.fields['Session State'] : null;
  console.log(`[State] guest: ${guest ? guest.id : 'none'} | state: ${sessionState}`);

  const ctx = { phone, text, messageText, guest, next: null, cleaner: null };

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

    console.log(`[POST] entry: ${!!entry} | messages: ${messages?.length || 0}`);

    if (!messages || messages.length === 0) {
      // F2: respond 200 before returning on no-message events (status updates etc)
      // NOTE: delivery-status callbacks are dropped here — B3 changes this deliberately
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
      await handleMessage(from, messageText);
    } catch (err) {
      console.error('[FATAL]', err.message, err.stack);
      logToAxiom('error', 'fatal', { message: err.message, stack: err.stack });
    }

    res.status(200).send('OK');
    return;
  }

  res.status(405).send('Method Not Allowed');
};
