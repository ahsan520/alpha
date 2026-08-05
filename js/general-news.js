// ══════════════════════════════════════════════
// general-news.js — GNews.io general market/geopolitical news panel
// ------------------------------------------------
// DISPLAY-ONLY. Never touches positions.json, never auto-buys/sells, never
// calls any exchange/trading API, and never fires Telegram alerts (there's no
// sentiment score or symbol to hang an alert off — this is a plain headline
// feed for situational awareness).
//
// Covers geopolitics (e.g. US-Iran / White House), Fed/interest-rate policy,
// jobs data, and crypto — via a single free-text search query — rather than
// Alpha Vantage's finance-only topic taxonomy.
//
// Free-tier note: GNews.io free tier = 100 requests/day, non-commercial use
// only, CORS enabled for all origins (works with a direct browser fetch, no
// backend proxy needed). Polling every 30 min uses ~48 requests/day, leaving
// headroom for manual refreshes.
// ══════════════════════════════════════════════

const GNEWS_INTERVAL_MS = 1_800_000; // 30 min

// ── Data source ──
// GNEWS_API_KEY is a server-side-only secret. The GitHub Actions workflow
// runs scripts/general-news-fetcher.js on every "fetch" job (using the real
// key from process.env) and commits its output to
// scripts/general-news-data.json. The browser never sees the key — it just
// reads that committed JSON via raw.githubusercontent.com (bypassing GitHub
// Pages' CDN cache).
// Same repo-detection fix as market-intelligence.js — see comment there.
// Was hardcoded to 'ahsan520/alpha', which pointed every other Alpha
// Terminal instance's News panel at the wrong repo's data file.
const GNEWS_DATA_REPO   = () => (typeof _deriveRepo === 'function' ? _deriveRepo() : (window.__GH_REPO || ''));
const GNEWS_DATA_BRANCH = 'main';
const GNEWS_DATA_PATH   = 'scripts/general-news-data.json';

// Auto-start state — always unpaused; app.js init() calls
// fetchGeneralNewsIfActive() after scripts load. Whether there's actually
// data depends on whether the workflow has a server-side GNEWS_API_KEY
// configured (see renderGeneralNews()'s no-data path).
window.GNEWS_PAUSED = false;

function toggleGeneralNews() {
  STATE.generalNewsOpen = !STATE.generalNewsOpen;
  const body = document.getElementById('general-news-body');
  const chev = document.getElementById('general-news-chevron');
  if (body) body.classList.toggle('hide', !STATE.generalNewsOpen);
  if (chev) chev.textContent = STATE.generalNewsOpen ? '▲ COLLAPSE' : '▼ EXPAND';
}

function toggleGeneralNewsPause() {
  window.GNEWS_PAUSED = !window.GNEWS_PAUSED;
  const btn = document.getElementById('general-news-pause-btn');
  if (btn) btn.textContent = window.GNEWS_PAUSED ? '▶' : '⏸';
  if (!window.GNEWS_PAUSED) fetchGeneralNewsIfActive(true);
}

function fetchGeneralNewsIfActive(force) {
  if (!force && window.GNEWS_PAUSED) return;
  fetchGeneralNews();
}

async function fetchGeneralNews() {
  const repo = GNEWS_DATA_REPO();
  if (!repo) { renderGeneralNews(); return; }

  const url = `https://raw.githubusercontent.com/${repo}/${GNEWS_DATA_BRANCH}/${GNEWS_DATA_PATH}?t=${Date.now()}`;

  let data;
  try {
    const r = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(15000) });
    if (r.status === 404) { renderGeneralNews('general-news-data.json not found yet — waiting for first workflow run.'); return; }
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    data = await r.json();
  } catch (e) {
    logAlertItem('info', `📰 GNews data fetch FAILED: ${e.message}`);
    _useGeneralNewsCache();
    return;
  }

  const items = Array.isArray(data.items) ? data.items : [];
  if (!items.length) { _useGeneralNewsCache(); return; }

  STATE.generalNewsItems  = items;
  STATE.generalNewsCache  = { items, ts: Date.now() };
  STATE.generalNewsFetchedAt = data.fetchedAt || 0;
  renderGeneralNews();
}

function _useGeneralNewsCache(noteMsg) {
  const cached = STATE.generalNewsCache;
  if (cached?.items?.length) STATE.generalNewsItems = cached.items;
  renderGeneralNews(noteMsg);
}

function renderGeneralNews(noteMsg) {
  const badge = document.getElementById('general-news-badge');
  const body  = document.getElementById('general-news-body');
  if (!body) return;

  const items = STATE.generalNewsItems || [];
  if (!items.length && !STATE.generalNewsFetchedAt) {
    if (badge) badge.textContent = 'no data yet';
    body.innerHTML = `<div style="padding:16px;font-family:var(--mono);font-size:10px;color:var(--text-dim);line-height:1.7;">
      No general news data yet.<br>
      Make sure <code style="color:var(--text-bright)">GNEWS_API_KEY</code> is set as a GitHub repository secret — it's used server-side by <code>general-news-fetcher.js</code>, which writes <code>general-news-data.json</code> on the next workflow run.
    </div>`;
    return;
  }

  if (badge) badge.textContent = items.length + ' items · poll 30m';

  if (!items.length) {
    body.innerHTML = `<div style="padding:20px;text-align:center;font-family:var(--mono);font-size:10px;color:var(--text-dim);">${noteMsg ? noteMsg.substring(0,140) : 'Waiting for first poll… click ▶ to start (refreshes every 30 min)'}</div>`;
    return;
  }

  const rows = items.map(n => `
    <div style="padding:6px 0;border-bottom:1px solid var(--border);display:flex;flex-direction:column;gap:3px;">
      <a href="${n.url}" target="_blank" rel="noopener" style="font-family:var(--mono);font-size:10.5px;color:var(--text-bright);text-decoration:none;">${n.title}</a>
      <span style="font-family:var(--mono);font-size:8px;color:var(--text-dim);">${n.source} · ${n.time}</span>
    </div>`).join('');

  body.innerHTML = `
    <div>${rows}</div>
    <div style="margin-top:8px;">
      <span style="font-family:var(--mono);font-size:8px;color:var(--text-dim);">Display-only · geopolitics/rates/jobs/crypto · no Telegram alerts · fetched server-side via GNEWS_API_KEY secret</span>
    </div>`;
}
