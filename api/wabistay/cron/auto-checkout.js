// /api/wabistay/cron/auto-checkout.js
// B12 — Vercel cron entry point for the Wabistay auto-checkout sweep.
// All logic (Airtable/WhatsApp helpers, the sweep itself) lives in
// ../webhook.js so there is a single source of truth for the checkout side
// effects and message copy. This file is only the HTTP handler the cron hits.
//
// Schedule is in vercel.json (crons); Shawn enables it at deploy time.
module.exports = require('../webhook.js').autoCheckoutHandler;
