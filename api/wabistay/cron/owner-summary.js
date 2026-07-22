// /api/wabistay/cron/owner-summary.js
// B17 — Vercel cron entry point for the Wabistay owner (weekly P&L) summary.
// Aggregation + the stubbed send live in ../webhook.js (single source of truth).
// Weekly by default; set OWNER_SUMMARY_DAILY=true to switch to a daily period.
// Schedule is in vercel.json (crons); Shawn enables it at deploy time.
module.exports = require('../webhook.js').ownerSummaryHandler;
