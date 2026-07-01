// /api/dashboard.js
// Wabiprop Agent Dashboard — HTML shell
// Reads: nothing directly (browser calls /api/dashboard-data for live data)
// Writes: nothing
// Auth: session-gated via wp_dash_session cookie (see dashboard-auth.js)
// No AI. Deterministic logic only. Solar Geyser Principle.
// No framework — vanilla HTML/CSS/JS. Tailwind loaded via CDN, no build step.
//
// Route: exposed at the clean path /dashboard via the vercel.json rewrite
// (source: /dashboard -> destination: /api/dashboard). Both paths work;
// /dashboard is the one agents bookmark.

const crypto = require('crypto');

const DASHBOARD_PASSWORD = process.env.DASHBOARD_PASSWORD;
const COOKIE_NAME = 'wp_dash_session';

// ─── SESSION VERIFICATION ────────────────────────────────────────────────────
// Duplicated from dashboard-auth.js / dashboard-data.js by design — kept
// byte-for-byte identical across all three files rather than shared, per the
// Phase 1 review decision to keep each file fully self-contained.

function verifySession(req) {
  const cookieHeader = req.headers.cookie || '';
  const match = cookieHeader.match(/(?:^|;\s*)wp_dash_session=([^;]+)/);
  if (!match) return false;

  const [expiryStr, sig] = decodeURIComponent(match[1]).split('.');
  if (!expiryStr || !sig) return false;

  const expiry = Number(expiryStr);
  if (!Number.isFinite(expiry) || expiry < Date.now()) return false;

  const expected = crypto.createHmac('sha256', DASHBOARD_PASSWORD).update(String(expiry)).digest('hex');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

// ─── LOGIN PAGE ───────────────────────────────────────────────────────────────
// Plain GET form — submitting it hits /api/dashboard-auth?password=... directly.
// No JS required for login to work.

function renderLoginPage(showError) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Wabiprop Dashboard — Login</title>
<script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-gray-100 min-h-screen flex items-center justify-center p-4">
  <form method="GET" action="/api/dashboard-auth" class="bg-white rounded-lg shadow-md p-8 w-full max-w-sm">
    <h1 class="text-xl font-bold text-gray-900 mb-1">Wabiprop</h1>
    <p class="text-sm text-gray-500 mb-6">Agent Dashboard</p>
    ${showError ? '<p class="text-sm text-red-600 bg-red-50 rounded px-3 py-2 mb-4">Incorrect password. Try again.</p>' : ''}
    <label class="block text-sm font-medium text-gray-700 mb-1" for="password">Password</label>
    <input
      type="password"
      name="password"
      id="password"
      required
      class="w-full border border-gray-300 rounded-md px-3 py-3 mb-4 text-base min-h-[44px]"
      autofocus
    >
    <button type="submit" class="w-full bg-gray-900 text-white rounded-md py-3 min-h-[44px] font-medium">
      Log in
    </button>
  </form>
</body>
</html>`;
}

// ─── DASHBOARD SHELL ──────────────────────────────────────────────────────────

function renderDashboardShell() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Wabiprop Dashboard</title>
<script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-gray-50 min-h-screen pb-20">

  <!-- TOPBAR -->
  <header class="bg-white border-b border-gray-200 px-4 py-4 flex items-center justify-between sticky top-0 z-10">
    <div>
      <div id="greeting" class="text-base font-semibold text-gray-900">Good day</div>
      <div id="today-date" class="text-xs text-gray-500"></div>
    </div>
    <div class="flex items-center gap-3">
      <span class="text-xl" title="Notifications">&#128276;</span>
      <span class="w-9 h-9 rounded-full bg-gray-900 text-white flex items-center justify-center text-sm font-semibold" title="Agent">WP</span>
    </div>
  </header>

  <!-- URGENT BANNER -->
  <div id="urgent-banner" class="mx-4 mt-4 rounded-md px-4 py-3 min-h-[44px] flex items-center justify-between cursor-pointer bg-gray-100 text-gray-500">
    <span id="urgent-banner-text">Loading...</span>
    <span>&rsaquo;</span>
  </div>

  <!-- PULSE STRIP -->
  <div id="pulse-strip" class="grid grid-cols-2 gap-3 mx-4 mt-4">
    <div class="bg-white rounded-md border border-gray-200 p-3 animate-pulse h-20"></div>
    <div class="bg-white rounded-md border border-gray-200 p-3 animate-pulse h-20"></div>
    <div class="bg-white rounded-md border border-gray-200 p-3 animate-pulse h-20"></div>
    <div class="bg-white rounded-md border border-gray-200 p-3 animate-pulse h-20"></div>
  </div>

  <!-- TODAY'S FOCUS -->
  <section class="mx-4 mt-6">
    <h2 class="text-sm font-semibold text-gray-900 mb-2">Today's focus</h2>
    <div id="today-focus-list" class="space-y-2">
      <div class="bg-white rounded-md border border-gray-200 p-3 animate-pulse h-14"></div>
      <div class="bg-white rounded-md border border-gray-200 p-3 animate-pulse h-14"></div>
    </div>
  </section>

  <!-- PROPERTY HEALTH -->
  <section class="mx-4 mt-6">
    <div class="flex items-center justify-between mb-2">
      <h2 class="text-sm font-semibold text-gray-900">Property health</h2>
      <button id="toggle-all-properties" class="text-xs text-blue-600 hidden min-h-[44px] px-2">Show all</button>
    </div>
    <div id="property-cards-list" class="space-y-2">
      <div class="bg-white rounded-md border border-gray-200 p-3 animate-pulse h-16"></div>
      <div class="bg-white rounded-md border border-gray-200 p-3 animate-pulse h-16"></div>
      <div class="bg-white rounded-md border border-gray-200 p-3 animate-pulse h-16"></div>
    </div>
  </section>

  <!-- ERROR CARD (hidden unless fetch fails) -->
  <div id="error-card" class="hidden mx-4 mt-6 bg-red-50 border border-red-200 rounded-md p-4 text-center">
    <p class="text-sm text-red-700 mb-3">Couldn't load dashboard data.</p>
    <button id="retry-btn" class="bg-red-600 text-white rounded-md px-4 py-2 min-h-[44px] text-sm font-medium">Retry</button>
  </div>

  <!-- URGENT FILTER MODAL (bottom sheet) -->
  <div id="urgent-modal-backdrop" class="hidden fixed inset-0 bg-black/40 z-20">
    <div class="absolute bottom-0 left-0 right-0 bg-white rounded-t-lg max-h-[80vh] overflow-y-auto">
      <div class="flex items-center justify-between px-4 py-3 border-b border-gray-200">
        <h3 class="text-sm font-semibold">Filter urgent items</h3>
        <button id="urgent-modal-close" class="text-xl leading-none min-h-[44px] min-w-[44px]">&times;</button>
      </div>
      <div class="p-4">
        <div class="mb-4">
          <div class="text-xs font-medium text-gray-500 mb-2">Status</div>
          <div id="status-chip-row" class="flex flex-wrap gap-2"></div>
        </div>
        <div class="mb-4">
          <div class="text-xs font-medium text-gray-500 mb-2">Property</div>
          <select id="property-filter-select" class="w-full border border-gray-300 rounded-md px-3 py-2 min-h-[44px]">
            <option value="">All properties</option>
          </select>
        </div>
        <div class="flex gap-2 mb-4">
          <button id="urgent-filter-apply" class="flex-1 bg-gray-900 text-white rounded-md py-2 min-h-[44px] text-sm font-medium">Apply</button>
          <button id="urgent-filter-reset" class="flex-1 bg-gray-100 text-gray-700 rounded-md py-2 min-h-[44px] text-sm font-medium">Reset</button>
        </div>
        <div id="urgent-filter-results" class="space-y-2 border-t border-gray-200 pt-3"></div>
      </div>
    </div>
  </div>

  <!-- TOAST -->
  <div id="toast" class="hidden fixed bottom-24 left-1/2 -translate-x-1/2 bg-gray-900 text-white text-sm px-4 py-2 rounded-md z-30"></div>

  <!-- BOTTOM NAV -->
  <nav class="fixed bottom-0 left-0 right-0 bg-white border-t border-gray-200 flex justify-around items-center h-16 z-10">
    <button class="nav-tab flex flex-col items-center justify-center min-h-[44px] min-w-[44px] text-gray-900" data-tab="home">
      <span>&#127968;</span><span class="text-[11px]">Home</span>
    </button>
    <button class="nav-tab flex flex-col items-center justify-center min-h-[44px] min-w-[44px] text-gray-400" data-tab="properties">
      <span>&#127970;</span><span class="text-[11px]">Properties</span>
    </button>
    <button class="nav-tab flex flex-col items-center justify-center min-h-[44px] min-w-[44px] text-gray-400" data-tab="issues">
      <span>&#128295;</span><span class="text-[11px]">Issues</span>
    </button>
    <button class="nav-tab flex flex-col items-center justify-center min-h-[44px] min-w-[44px] text-gray-400" data-tab="contractors">
      <span>&#128101;</span><span class="text-[11px]">Contractors</span>
    </button>
    <button class="nav-tab flex flex-col items-center justify-center min-h-[44px] min-w-[44px] text-gray-400" data-tab="reports">
      <span>&#128202;</span><span class="text-[11px]">Reports</span>
    </button>
  </nav>

<script>
(function () {
  let cachedData = null;
  let allPropertiesShown = false;

  // ── Toast helper ──────────────────────────────────────────────────────
  function showToast(msg) {
    const el = document.getElementById('toast');
    el.textContent = msg;
    el.classList.remove('hidden');
    setTimeout(() => el.classList.add('hidden'), 2000);
  }

  // ── Bottom nav — only Home is built ──────────────────────────────────
  document.querySelectorAll('.nav-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.dataset.tab !== 'home') {
        showToast('Not built yet — coming in a later phase.');
      }
    });
  });

  // ── Topbar greeting + date ────────────────────────────────────────────
  function renderTopbar() {
    const hour = new Date().getHours();
    const greeting = hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
    document.getElementById('greeting').textContent = greeting;
    document.getElementById('today-date').textContent = new Date().toLocaleDateString('en-ZA', {
      weekday: 'long', day: 'numeric', month: 'long'
    });
  }

  // ── Load data ─────────────────────────────────────────────────────────
  async function loadData() {
    document.getElementById('error-card').classList.add('hidden');
    try {
      const res = await fetch('/api/dashboard-data');
      if (res.status === 401) {
        window.location.href = '/dashboard';
        return;
      }
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || 'Unknown error');
      cachedData = data;
      renderAll(data);
    } catch (err) {
      document.getElementById('error-card').classList.remove('hidden');
    }
  }

  function daysUntilLeaseExpiryList(properties, maxDays) {
    return properties.filter(p => p.daysUntilLeaseExpiry !== null && p.daysUntilLeaseExpiry <= maxDays);
  }

  function startOfMonth() {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
  }

  // ── Render everything once data is loaded ────────────────────────────
  function renderAll(data) {
    renderUrgentBanner(data);
    renderPulseStrip(data);
    renderTodayFocus(data);
    renderPropertyCards(data);
    renderUrgentModalFilters(data);
  }

  function renderUrgentBanner(data) {
    const staleCount = data.pulse.staleIssuesCount;
    const expiringSoon = daysUntilLeaseExpiryList(data.properties, 14).length;
    const urgentCount = staleCount + expiringSoon;

    const banner = document.getElementById('urgent-banner');
    const text = document.getElementById('urgent-banner-text');

    if (urgentCount === 0) {
      banner.className = 'mx-4 mt-4 rounded-md px-4 py-3 min-h-[44px] flex items-center justify-between cursor-pointer bg-green-50 text-green-800';
      text.textContent = 'All clear — nothing urgent today';
    } else {
      banner.className = 'mx-4 mt-4 rounded-md px-4 py-3 min-h-[44px] flex items-center justify-between cursor-pointer bg-red-50 text-red-800 font-medium';
      text.textContent = urgentCount + ' item' + (urgentCount === 1 ? '' : 's') + ' need attention';
    }
    banner.onclick = () => document.getElementById('urgent-modal-backdrop').classList.remove('hidden');
  }

  function pulseCard(label, value, sublabel) {
    return '<div class="bg-white rounded-md border border-gray-200 p-3">' +
      '<div class="text-xs text-gray-500">' + label + '</div>' +
      '<div class="text-2xl font-bold text-gray-900">' + value + '</div>' +
      (sublabel ? '<div class="text-xs text-red-600 mt-1">' + sublabel + '</div>' : '') +
      '</div>';
  }

  function renderPulseStrip(data) {
    const staleCount = data.pulse.staleIssuesCount;
    const openCount = data.pulse.openIssuesCount;
    const expiring30 = daysUntilLeaseExpiryList(data.properties, 30).length;
    const expiring14 = daysUntilLeaseExpiryList(data.properties, 14).length;
    const issuesThisMonth = data.issues.filter(i => i.dateReported && new Date(i.dateReported).getTime() >= startOfMonth()).length;
    const contractorsActive = new Set(
      data.issues.filter(i => i.active && i.contractorName).map(i => i.contractorName)
    ).size;

    document.getElementById('pulse-strip').innerHTML =
      pulseCard('Open issues', openCount, staleCount > 0 ? staleCount + ' stale' : null) +
      pulseCard('Leases expiring', expiring30, expiring14 > 0 ? expiring14 + ' within 14 days' : null) +
      pulseCard('Issues this month', issuesThisMonth, null) +
      pulseCard('Contractors active', contractorsActive, null);
  }

  function renderTodayFocus(data) {
    const container = document.getElementById('today-focus-list');
    const staleItems = data.issues.filter(i => i.stale);
    const leaseItems = daysUntilLeaseExpiryList(data.properties, 14);

    if (staleItems.length === 0 && leaseItems.length === 0) {
      container.innerHTML = '<div class="text-sm text-gray-500">Nothing flagged right now.</div>';
      return;
    }

    let html = '';
    staleItems.forEach(i => {
      html += '<div class="today-focus-item bg-white rounded-md border-l-4 border-red-500 border-y border-r border-gray-200 p-3 min-h-[44px] cursor-pointer">' +
        '<div class="text-sm font-medium text-gray-900">WP-' + i.issueRef + ' &mdash; ' + i.status + '</div>' +
        '<div class="text-xs text-gray-500">' + i.tenantName + ' &middot; ' + i.daysOpen + ' days open</div>' +
        '</div>';
    });
    leaseItems.forEach(p => {
      html += '<div class="today-focus-item bg-white rounded-md border-l-4 border-red-500 border-y border-r border-gray-200 p-3 min-h-[44px] cursor-pointer">' +
        '<div class="text-sm font-medium text-gray-900">' + p.propertyName + '</div>' +
        '<div class="text-xs text-gray-500">Lease expires in ' + p.daysUntilLeaseExpiry + ' days</div>' +
        '</div>';
    });
    container.innerHTML = html;

    document.querySelectorAll('.today-focus-item').forEach(el => {
      el.addEventListener('click', () => showToast('Issue detail view not built yet.'));
    });
  }

  function healthDotColor(band) {
    if (band === 'Healthy') return 'bg-green-500';
    if (band === 'Watch') return 'bg-amber-500';
    return 'bg-red-500';
  }

  function propertyCardHtml(p) {
    return '<div class="bg-white rounded-md border border-gray-200 p-3 min-h-[44px]">' +
      '<div class="flex items-center gap-2">' +
      '<span class="w-2.5 h-2.5 rounded-full ' + healthDotColor(p.healthBand) + '"></span>' +
      '<span class="text-sm font-medium text-gray-900 flex-1">' + p.propertyName + '</span>' +
      '<span class="text-xs px-2 py-0.5 rounded bg-gray-100 text-gray-700">' + p.healthBand + ' &middot; ' + p.healthScore + '</span>' +
      '</div>' +
      '<div class="text-xs text-gray-500 mt-1">' + p.openIssueCount + ' open issue' + (p.openIssueCount === 1 ? '' : 's') +
      (p.daysUntilLeaseExpiry !== null ? ' &middot; lease in ' + p.daysUntilLeaseExpiry + 'd' : '') + '</div>' +
      '</div>';
  }

  function renderPropertyCards(data) {
    const sorted = [...data.properties].sort((a, b) => a.healthScore - b.healthScore);
    const toggleBtn = document.getElementById('toggle-all-properties');

    function render() {
      const shown = allPropertiesShown ? sorted : sorted.slice(0, 5);
      document.getElementById('property-cards-list').innerHTML = shown.map(propertyCardHtml).join('');
      toggleBtn.textContent = allPropertiesShown ? 'Show top 5' : 'Show all ' + sorted.length;
    }

    if (sorted.length > 5) {
      toggleBtn.classList.remove('hidden');
      toggleBtn.onclick = () => { allPropertiesShown = !allPropertiesShown; render(); };
    } else {
      toggleBtn.classList.add('hidden');
    }
    render();
  }

  // ── Urgent filter modal ───────────────────────────────────────────────
  function renderUrgentModalFilters(data) {
    const statuses = [...new Set(data.issues.map(i => i.status))];
    const chipRow = document.getElementById('status-chip-row');
    chipRow.innerHTML = statuses.map(s =>
      '<button type="button" class="status-chip text-xs px-3 py-2 min-h-[44px] rounded-full border border-gray-300 text-gray-700" data-status="' + s + '">' + s + '</button>'
    ).join('');

    document.querySelectorAll('.status-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        chip.classList.toggle('bg-gray-900');
        chip.classList.toggle('text-white');
        chip.classList.toggle('border-gray-900');
      });
    });

    const propSelect = document.getElementById('property-filter-select');
    propSelect.innerHTML = '<option value="">All properties</option>' +
      data.properties.map(p => '<option value="' + p.propertyName + '">' + p.propertyName + '</option>').join('');
  }

  function applyUrgentFilter() {
    if (!cachedData) return;
    const activeStatuses = [...document.querySelectorAll('.status-chip.bg-gray-900')].map(c => c.dataset.status);
    const selectedProperty = document.getElementById('property-filter-select').value;

    const results = cachedData.issues.filter(i => {
      if (activeStatuses.length > 0 && !activeStatuses.includes(i.status)) return false;
      if (selectedProperty && i.propertyName !== selectedProperty) return false;
      return true;
    });

    const resultsEl = document.getElementById('urgent-filter-results');
    if (results.length === 0) {
      resultsEl.innerHTML = '<div class="text-sm text-gray-500">No matching items.</div>';
      return;
    }
    resultsEl.innerHTML = results.map(i =>
      '<div class="text-sm border-b border-gray-100 py-2"><span class="font-medium">WP-' + i.issueRef + '</span> &middot; ' + i.status + ' &middot; ' + i.daysOpen + 'd open</div>'
    ).join('');
  }

  document.getElementById('urgent-modal-close').addEventListener('click', () => {
    document.getElementById('urgent-modal-backdrop').classList.add('hidden');
  });
  document.getElementById('urgent-filter-apply').addEventListener('click', applyUrgentFilter);
  document.getElementById('urgent-filter-reset').addEventListener('click', () => {
    document.querySelectorAll('.status-chip').forEach(c => { c.classList.remove('bg-gray-900'); c.classList.remove('text-white'); });
    document.getElementById('property-filter-select').value = '';
    document.getElementById('urgent-filter-results').innerHTML = '';
  });
  document.getElementById('retry-btn').addEventListener('click', loadData);

  renderTopbar();
  loadData();
})();
</script>

</body>
</html>`;
}

// ─── MAIN HANDLER ─────────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).send('Method Not Allowed');
  }

  if (!DASHBOARD_PASSWORD) {
    console.error('[dashboard] DASHBOARD_PASSWORD not set in environment');
    return res.status(500).send('Dashboard auth is not configured.');
  }

  if (verifySession(req)) {
    res.setHeader('Content-Type', 'text/html');
    return res.status(200).send(renderDashboardShell());
  }

  // No valid session — bookmarked convenience URL with the password attached
  if (req.query.password) {
    const qs = new URLSearchParams({ password: req.query.password }).toString();
    res.writeHead(302, { Location: `/api/dashboard-auth?${qs}` });
    return res.end();
  }

  res.setHeader('Content-Type', 'text/html');
  return res.status(200).send(renderLoginPage(req.query.error === '1'));
};
