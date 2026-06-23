// /api/wabistay/webhook.js
// WS1 — Wabistay Guest Booking Enquiry Bot
// Reads: WS_Rooms, WS_Rates, WS_Guests, WS_Cleaners
// Writes: WS_Guests, WS_Bookings, WS_Rooms
// No AI. Deterministic state machine only.

const AIRTABLE_BASE_ID = process.env.AIRTABLE_BASE_ID;
const AIRTABLE_API_KEY = process.env.AIRTABLE_API_KEY;
const WA_PHONE_NUMBER_ID = process.env.WA_PHONE_NUMBER_ID;
const WA_ACCESS_TOKEN = process.env.WA_ACCESS_TOKEN;
const WA_VERIFY_TOKEN = process.env.WA_VERIFY_TOKEN;
const WA_APP_SECRET = process.env.WA_APP_SECRET;

// ─── AIRTABLE HELPERS ───────────────────────────────────────────────────────

async function airtableGet(table, filterFormula) {
  const url = `https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(table)}?filterByFormula=${encodeURIComponent(filterFormula)}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${AIRTABLE_API_KEY}` }
  });
  const data = await res.json();
  return data.records || [];
}

async function airtableCreate(table, fields) {
  const res = await fetch(`https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(table)}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${AIRTABLE_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ fields })
  });
  return await res.json();
}

async function airtableUpdate(table, recordId, fields) {
  const res = await fetch(`https://api.airtable.com/v0/${AIRTABLE_BASE_ID}/${encodeURIComponent(table)}/${recordId}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${AIRTABLE_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ fields })
  });
  return await res.json();
}

// ─── WHATSAPP HELPER ────────────────────────────────────────────────────────

async function sendWhatsApp(to, message) {
  const res = await fetch(`https://graph.facebook.com/v19.0/${WA_PHONE_NUMBER_ID}/messages`, {
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
  return await res.json();
}

// ─── FORMAT PHONE ────────────────────────────────────────────────────────────

function formatPhone(raw) {
  // Strips spaces, dashes, +. Converts 0XX to 27XX.
  let clean = raw.replace(/[\s\-\+]/g, '');
  if (clean.startsWith('0')) clean = '27' + clean.slice(1);
  return clean;
}

// ─── STATE MACHINE ───────────────────────────────────────────────────────────

async function handleMessage(from, messageText) {
  const phone = formatPhone(from);
  const text = messageText.trim().toLowerCase();

  // Look up guest by phone number
  const guestRecords = await airtableGet('WS_Guests', `{Phone Number} = '${phone}'`);
  const guest = guestRecords[0] || null;
  const sessionState = guest ? guest.fields['Session State'] : null;

  // ── CLEANER REPLY: DONE ──────────────────────────────────────────────────
  if (text === 'done') {
    // Find cleaner by phone
    const cleanerRecords = await airtableGet('WS_Cleaners', `{Phone Number} = '${phone}'`);
    if (cleanerRecords.length > 0) {
      // Find the most recent Cleaning room linked to this cleaner
      // For now: find any room in Cleaning status
      const cleaningRooms = await airtableGet('WS_Rooms', `{Status} = 'Cleaning'`);
      if (cleaningRooms.length > 0) {
        const room = cleaningRooms[0];
        await airtableUpdate('WS_Rooms', room.id, { Status: 'Available' });
        await sendWhatsApp(phone, `Thank you! ${room.fields['Room Name']} is marked as clean and available. ✅`);

        // Notify owner — owner number must be set as env var OWNER_PHONE
        const ownerPhone = process.env.OWNER_PHONE;
        if (ownerPhone) {
          await sendWhatsApp(ownerPhone, `✅ ${room.fields['Room Name']} has been cleaned and is now available for new bookings.`);
        }
      }
      return;
    }
  }

  // ── NEW GUEST or FALLBACK ────────────────────────────────────────────────
  if (!guest || !sessionState || sessionState === 'NEW') {
    // Get available rooms
    const availableRooms = await airtableGet('WS_Rooms', `{Status} = 'Available'`);
    const roomCount = availableRooms.length;

    // Get active rates
    const activeRates = await airtableGet('WS_Rates', `{Active} = 1`);
    let rateText = '';
    if (activeRates.length > 0) {
      rateText = activeRates.map(r =>
        `• ${r.fields['Rate Name']}: R${r.fields['Amount']} ${r.fields['Rate Type'] === 'Per Night' ? 'per night' : 'per hour'}`
      ).join('\n');
    }

    const greeting = `Hi! 👋 Welcome to Villa Liza Guest Lodge, Boksburg.\n\nWe currently have *${roomCount} room${roomCount !== 1 ? 's' : ''}* available.\n\n*Our rates:*\n${rateText}\n\nTo make a booking, please reply with:\n1. Your full name\n2. Check-in date (e.g. 25 June)\n3. Check-out date (e.g. 27 June)`;

    // Create or update guest record with state AWAITING_DETAILS
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

  // ── AWAITING_DETAILS: Guest sends name + dates ───────────────────────────
  if (sessionState === 'AWAITING_DETAILS') {
    // Parse the message — store raw, don't try to be clever
    const lines = messageText.trim().split('\n').map(l => l.trim()).filter(Boolean);

    let guestName = guest.fields['Guest Name'] !== 'Unknown' ? guest.fields['Guest Name'] : null;
    let checkIn = null;
    let checkOut = null;

    // Simple heuristic: first line is name if it doesn't contain a date keyword
    const dateKeywords = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec','january','february','march','april','june','july','august','september','october','november','december'];

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

    // If we can't parse enough — ask again
    if (!guestName || !checkIn) {
      await sendWhatsApp(phone, `Sorry, I didn't quite get that. Please reply with your:\n1. Full name\n2. Check-in date (e.g. 25 June)\n3. Check-out date (e.g. 27 June)\n\nSend each on a new line.`);
      return;
    }

    // Update guest name
    await airtableUpdate('WS_Guests', guest.id, {
      'Guest Name': guestName,
      'Session State': 'AWAITING_ETA'
    });

    // Get active rate for booking amount
    const activeRates = await airtableGet('WS_Rates', `{Active} = 1`);
    const rate = activeRates[0] || null;

    // Create booking record
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

    await sendWhatsApp(phone,
      `Thanks ${guestName}! 🙏\n\nYour booking enquiry has been received.\n\n*Ref:* ${bookingRef}\n*Check-in:* ${checkIn}\n*Check-out:* ${checkOut || 'TBC'}\n${rate ? `*Rate:* R${rate.fields['Amount']} per night` : ''}\n\nWhat time do you expect to arrive? (e.g. "around 2pm" or "after 5")`
    );
    return;
  }

  // ── AWAITING_ETA: Guest sends arrival time ───────────────────────────────
  if (sessionState === 'AWAITING_ETA') {
    const eta = messageText.trim();

    // Find their most recent Enquiry booking
    const bookings = await airtableGet('WS_Bookings', `AND({Status}='Enquiry', FIND('${guest.id}', ARRAYJOIN({Guest})))`);
    if (bookings.length > 0) {
      const booking = bookings[0];
      await airtableUpdate('WS_Bookings', booking.id, {
        'ETA': eta,
        'Status': 'Confirmed'
      });
    }

    await airtableUpdate('WS_Guests', guest.id, { 'Session State': 'CONFIRMED' });

    await sendWhatsApp(phone,
      `Perfect! We'll have your room ready for you. 🛏️\n\nSee you at *${eta}*.\n\nIf your plans change, reply *CANCEL* and we'll free up the room.\n\nWe look forward to hosting you at Villa Liza! 🌟`
    );
    return;
  }

  // ── CONFIRMED: Handle CANCEL or CHECKOUT ────────────────────────────────
  if (sessionState === 'CONFIRMED') {
    if (text === 'cancel') {
      // Find confirmed booking
      const bookings = await airtableGet('WS_Bookings', `AND({Status}='Confirmed', FIND('${guest.id}', ARRAYJOIN({Guest})))`);
      if (bookings.length > 0) {
        await airtableUpdate('WS_Bookings', bookings[0].id, { 'Status': 'Cancelled' });
      }
      await airtableUpdate('WS_Guests', guest.id, { 'Session State': 'NEW' });
      await sendWhatsApp(phone, `Your booking has been cancelled. No problem at all — we hope to see you another time. 👋`);
      return;
    }

    if (text.includes('check') && text.includes('out') || text === 'checking out' || text === 'checkout') {
      // Find confirmed booking
      const bookings = await airtableGet('WS_Bookings', `AND({Status}='Checked In', FIND('${guest.id}', ARRAYJOIN({Guest})))`);
      let roomName = 'your room';

      if (bookings.length > 0) {
        const booking = bookings[0];
        await airtableUpdate('WS_Bookings', booking.id, {
          'Status': 'Checked Out',
          'Checkout Confirmed': true
        });

        // Get room from booking and set to Cleaning
        if (booking.fields['Room'] && booking.fields['Room'].length > 0) {
          const roomId = booking.fields['Room'][0];
          const roomRecords = await airtableGet('WS_Rooms', `RECORD_ID() = '${roomId}'`);
          if (roomRecords.length > 0) {
            roomName = roomRecords[0].fields['Room Name'];
            await airtableUpdate('WS_Rooms', roomId, { 'Status': 'Cleaning' });
          }
        }
      }

      // Notify all active cleaners
      const cleaners = await airtableGet('WS_Cleaners', `{Active} = 1`);
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

    // Any other message from confirmed guest
    await sendWhatsApp(phone,
      `Hi ${guest.fields['Guest Name']}! Your booking is confirmed. 🛏️\n\nReply *CANCEL* to cancel your booking, or *CHECKING OUT* when you leave.`
    );
    return;
  }

  // ── FALLBACK ─────────────────────────────────────────────────────────────
  await airtableUpdate('WS_Guests', guest.id, { 'Session State': 'NEW' });
  await sendWhatsApp(phone, `Hi! Reply with your name and dates to make a booking, or *CHECKING OUT* if you are leaving today.`);
}

// ─── MAIN HANDLER ────────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  // Webhook verification (GET)
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

  // Inbound message (POST)
  if (req.method === 'POST') {
    try {
      const body = req.body;

      // Acknowledge immediately — Meta requires 200 within 5 seconds
      res.status(200).send('OK');

      const entry = body?.entry?.[0];
      const changes = entry?.changes?.[0];
      const value = changes?.value;
      const messages = value?.messages;

      if (!messages || messages.length === 0) return;

      const message = messages[0];
      const from = message.from;
      const messageText = message?.text?.body;

      if (!messageText) return; // Ignore non-text messages for now

      await handleMessage(from, messageText);

    } catch (err) {
      console.error('WS1 webhook error:', err);
    }
    return;
  }

  res.status(405).send('Method Not Allowed');
}