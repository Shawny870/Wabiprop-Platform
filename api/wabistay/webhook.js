// /api/wabistay/webhook.js
// WS1 — Wabistay Guest Booking Enquiry Bot
// Reads: WS_Rooms, WS_Rates, WS_Guests, WS_Cleaners
// Writes: WS_Guests, WS_Bookings, WS_Rooms
// No AI. Deterministic state machine only.
// FIX LOG:
//   F1 — Body parse guard added (req.body undefined protection)
//   F2 — res.status(200) moved to AFTER handleMessage completes
//   F3 — Meta API version v19.0 → v25.0
//   F4 — {Active} = 1 → {Active} = TRUE() for Rates and Cleaners
//   F5 — FIND/ARRAYJOIN linked record filter replaced with direct lookup
//   F6 — Airtable error logging now includes HTTP status code
//   F7 — OWNER_PHONE notification added to NEW booking creation
//   F8 — CHECKED_IN state added (gate arrival → checked in flow)
//   F9 — All guest-facing messages converted to numbered menu options (Rule 11)
//   F10 — Greeting scoped to overnight bookings, HOURLY keyword placeholder added
//   F11 — Room assigned at gate arrival, Notify Phone from WS_Properties with OWNER_PHONE fallback
//   F12 — Axiom HTTP logging added (fire-and-forget, never blocks state machine)
//   F13 — Booking Ref written back to WS_Bookings after CREATE

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
  // Fetch all bookings with matching status, then filter by guest ID in JS
  // Airtable linked record filter via FIND/ARRAYJOIN is unreliable
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

// ─── STATE MACHINE ───────────────────────────────────────────────────────────

async function handleMessage(from, messageText) {
  const phone = formatPhone(from);
  const text = messageText.trim().toLowerCase();
  console.log(`[handleMessage] from: ${phone} | text: ${text}`);
  logToAxiom('info', 'message_received', { phone, text: messageText.slice(0, 100) });

  const guestRecords = await airtableGet('WS_Guests', `{Phone Number} = '${phone}'`);
  const guest = guestRecords[0] || null;
  const sessionState = guest ? guest.fields['Session State'] : null;
  console.log(`[State] guest: ${guest ? guest.id : 'none'} | state: ${sessionState}`);

  // ── CLEANER REPLY: DONE ──────────────────────────────────────────────────
  if (text === 'done') {
    const cleanerRecords = await airtableGet('WS_Cleaners', `{Phone Number} = '${phone}'`);
    if (cleanerRecords.length > 0) {
      // F4: was {Active} = 1 — Airtable checkbox requires TRUE()
      const cleaningRooms = await airtableGet('WS_Rooms', `{Status} = 'Cleaning'`);
      if (cleaningRooms.length > 0) {
        const room = cleaningRooms[0];
        await airtableUpdate('WS_Rooms', room.id, { 'Status': 'Available' });
        await sendWhatsApp(phone, `Thank you! ${room.fields['Room Name']} is marked as clean and available. ✅`);
        if (OWNER_PHONE) {
          await sendWhatsApp(OWNER_PHONE, `✅ ${room.fields['Room Name']} has been cleaned and is now available for new bookings.`);
        }
      } else {
        await sendWhatsApp(phone, `Thanks! No rooms currently marked for cleaning — nothing to update.`);
      }
      return;
    }
  }

  // ── NEW GUEST or FALLBACK ────────────────────────────────────────────────
  if (!guest || !sessionState || sessionState === 'NEW') {
    const availableRooms = await airtableGet('WS_Rooms', `{Status} = 'Available'`);
    const roomCount = availableRooms.length;
    // F4: was {Active} = 1 — Airtable checkbox requires TRUE()
    const activeRates = await airtableGet('WS_Rates', `{Active} = TRUE()`);
    let rateText = '';
    if (activeRates.length > 0) {
      rateText = activeRates.map(r =>
        `• ${r.fields['Rate Name']}: R${r.fields['Amount']} ${r.fields['Rate Type'] === 'Per Night' ? 'per night' : 'per hour'}`
      ).join('\n');
    } else {
      rateText = '• Contact us for current rates';
    }

    const greeting = `Hi! 👋 Welcome to Villa Liza Guest Lodge, Boksburg.\n\nWe currently have *${roomCount} room${roomCount !== 1 ? 's' : ''}* available.\n\n*Our rates:*\n${rateText}\n\nTo make an *overnight booking*, please send:\n1. Your full name\n2. Check-in date (e.g. 25 June)\n3. Check-out date (e.g. 27 June)\n\nSend all three, each on a new line.\n\n_For short stay bookings, reply HOURLY and we'll assist you._`;

    if (!guest) {
      await airtableCreate('WS_Guests', {
        'Guest Name': 'Unknown',
        'Phone Number': phone,
        'Guest Type': 'WhatsApp',
        'Session State': 'AWAITING_DETAILS',
        'First Visit': new Date().toISOString().split('T')[0]
      });
    } else {
      await airtableUpdate('WS_Guests', guest.id, { 'Session State': 'AWAITING_DETAILS' });
    }

    await sendWhatsApp(phone, greeting);
    return;
  }

  // ── AWAITING_DETAILS ────────────────────────────────────────────────────
  if (sessionState === 'AWAITING_DETAILS') {
    const lines = messageText.trim().split('\n').map(l => l.trim()).filter(Boolean);
    let guestName = guest.fields['Guest Name'] !== 'Unknown' ? guest.fields['Guest Name'] : null;
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
      await sendWhatsApp(phone, `Sorry, I didn't quite get that. Please reply with your:\n1. Full name\n2. Check-in date (e.g. 25 June)\n3. Check-out date (e.g. 27 June)\n\nSend each on a new line.`);
      return;
    }

    await airtableUpdate('WS_Guests', guest.id, {
      'Guest Name': guestName,
      'Session State': 'AWAITING_ETA'
    });

    // F4: was {Active} = 1
    const activeRates = await airtableGet('WS_Rates', `{Active} = TRUE()`);
    const rate = activeRates[0] || null;

    const bookingData = {
      'Guest': [guest.id],
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
      phone,
      guestName,
      bookingRef,
      airtableId: booking.id || null,
      error: booking.error ? JSON.stringify(booking.error) : null
    });

    // F7: Owner was never notified on new booking — now they are
    if (OWNER_PHONE) {
      await sendWhatsApp(OWNER_PHONE,
        `📋 New booking enquiry from ${guestName}\nPhone: ${phone}\nRef: ${bookingRef}\nCheck-in: ${checkIn}\nCheck-out: ${checkOut || 'TBC'}`
      );
    }

    await sendWhatsApp(phone,
      `Thanks ${guestName}! 🙏\n\nYour booking enquiry has been received.\n\n*Ref:* ${bookingRef}\n*Check-in:* ${checkIn}\n*Check-out:* ${checkOut || 'TBC'}\n${rate ? `*Rate:* R${rate.fields['Amount']} per night` : ''}\n\nWhat time do you expect to arrive? (e.g. "around 2pm" or "after 5")`
    );
    return;
  }

  // ── AWAITING_ETA ────────────────────────────────────────────────────────
  if (sessionState === 'AWAITING_ETA') {
    const eta = messageText.trim();
    // F5: was FIND/ARRAYJOIN — now JS filter on fetched records
    const bookings = await airtableGetBookingsByGuestId(guest.id, 'Enquiry');
    if (bookings.length > 0) {
      await airtableUpdate('WS_Bookings', bookings[0].id, {
        'ETA': eta,
        'Status': 'Confirmed'
      });
    }
    await airtableUpdate('WS_Guests', guest.id, { 'Session State': 'CONFIRMED' });
    await sendWhatsApp(phone,
      `Perfect! We'll have your room ready for you. 🛏️\n\nSee you at *${eta}*.\n\nWhen you arrive, reply with a number:\n1 - I'm at the gate\n2 - Cancel my booking\n\nWe look forward to hosting you at Villa Liza! 🌟`
    );
    return;
  }

  // ── CONFIRMED ───────────────────────────────────────────────────────────
  // F8: CONFIRMED now handles gate arrival and cancel only
  // Checkout moved to CHECKED_IN state
  if (sessionState === 'CONFIRMED') {
    // F9: accept number or word equivalent (Rule 11)
    if (text === '1' || text === 'here' || text === 'arrived' || text === 'at the gate') {
      // F11: gate arrival — assign first available room, notify party, move to CHECKED_IN

      // Step 1: get notify phone from WS_Properties, fallback to OWNER_PHONE
      const properties = await airtableGet('WS_Properties', `{Property Name} = 'Villa Liza Guest Lodge'`);
      const notifyPhone = (properties.length > 0 && properties[0].fields['Notify Phone'])
        ? properties[0].fields['Notify Phone'].replace(/[\s\-\+]/g, '')
        : OWNER_PHONE;

      // Step 2: find first available room
      const availableRooms = await airtableGet('WS_Rooms', `{Status} = 'Available'`);
      let assignedRoomName = null;
      let assignedRoomId = null;

      if (availableRooms.length > 0) {
        assignedRoomId = availableRooms[0].id;
        assignedRoomName = availableRooms[0].fields['Room Name'];
        // Step 3: set room → Occupied
        await airtableUpdate('WS_Rooms', assignedRoomId, { 'Status': 'Occupied' });
      }

      // Step 4: update booking — Checked In + link room if assigned
      const bookings = await airtableGetBookingsByGuestId(guest.id, 'Confirmed');
      if (bookings.length > 0) {
        const bookingUpdate = { 'Status': 'Checked In' };
        if (assignedRoomId) bookingUpdate['Room'] = [assignedRoomId];
        await airtableUpdate('WS_Bookings', bookings[0].id, bookingUpdate);
      }

      // Step 5: set session → CHECKED_IN
      await airtableUpdate('WS_Guests', guest.id, { 'Session State': 'CHECKED_IN' });

      // Step 6: notify party
      if (notifyPhone) {
        const roomInfo = assignedRoomName ? `${assignedRoomName} assigned.` : 'No rooms available — please assign manually.';
        await sendWhatsApp(notifyPhone,
          `🔔 ${guest.fields['Guest Name']} is at the gate. ${roomInfo}\nPhone: ${phone}`
        );
      }

      // Step 7: tell guest their room or no availability
      if (assignedRoomName) {
        await sendWhatsApp(phone,
          `Welcome to Villa Liza! 🌟 You've been assigned *${assignedRoomName}*.\n\nSomeone is on their way to open the gate for you. Enjoy your stay!\n\nWhen you're ready to leave, reply with a number:\n1 - Check out`
        );
      } else {
        await sendWhatsApp(phone,
          `Welcome to Villa Liza! 🌟 We've notified someone to assist you at the gate.\n\nEnjoy your stay! When you're ready to leave, reply with a number:\n1 - Check out`
        );
      }
      return;
    }

    if (text === '2' || text === 'cancel') {
      // F5: was FIND/ARRAYJOIN
      const bookings = await airtableGetBookingsByGuestId(guest.id, 'Confirmed');
      if (bookings.length > 0) {
        await airtableUpdate('WS_Bookings', bookings[0].id, { 'Status': 'Cancelled' });
      }
      await airtableUpdate('WS_Guests', guest.id, { 'Session State': 'NEW' });
      await sendWhatsApp(phone, `Your booking has been cancelled. No problem at all — we hope to see you another time. 👋`);
      return;
    }

    // F9: fallback — show numbered menu
    await sendWhatsApp(phone,
      `Hi ${guest.fields['Guest Name']}! Your booking is confirmed. 🛏️\n\nReply with a number:\n1 - I'm at the gate\n2 - Cancel my booking`
    );
    return;
  }

  // ── CHECKED_IN ──────────────────────────────────────────────────────────
  // F8: new state — guest has arrived, booking is Checked In
  if (sessionState === 'CHECKED_IN') {
    if (text === '1' || text === 'checking out' || text === 'checkout' || text === 'check out') {
      // F5: was FIND/ARRAYJOIN
      const bookings = await airtableGetBookingsByGuestId(guest.id, 'Checked In');
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
          await sendWhatsApp(
            formatPhone(cleanerPhone),
            `Hi ${cleanerName} 🧹 ${roomName} has just been vacated. Please prepare it with fresh linen immediately.\n\nReply *DONE* when complete.`
          );
        }
      }
      await airtableUpdate('WS_Guests', guest.id, { 'Session State': 'NEW' });
      await sendWhatsApp(phone,
        `Thank you for staying with us at Villa Liza! 🌟\n\nWe hope you enjoyed your stay. You're welcome back anytime.\n\nSafe travels! 👋`
      );
      return;
    }

    // F9: fallback — show numbered menu
    await sendWhatsApp(phone,
      `Hi ${guest.fields['Guest Name']}! You're checked in. 🛏️\n\nReply with a number:\n1 - Check out`
    );
    return;
  }

  // ── FALLBACK ─────────────────────────────────────────────────────────────
  if (guest) {
    await airtableUpdate('WS_Guests', guest.id, { 'Session State': 'NEW' });
  }
  await sendWhatsApp(phone, `Hi! Reply with your name and dates to make a booking, or *CHECKING OUT* if you are leaving today.`);
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
    // Previous code sent 200 first — Vercel could kill the function mid-execution
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