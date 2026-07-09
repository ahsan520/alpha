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
const GNEWS_QUERY = '"Iran" OR "White House" OR "Federal Reserve" OR "interest rate" OR "jobs report" OR crypto OR bitcoin';
const GNEWS_MAX_ARTICLES = 25;

window.GNEWS_PAUSED = true;

function _gnewsKeyStorageKey() { return `${_REPO_NS}_gnews_key`; }
function getGnewsApiKey()      { return (localStorage.getItem(_gnewsKeyStorageKey()) || '').trim(); }

function saveGnewsApiKey() {
  const input = document.getElementById('gnews-key-input');
  if (!input) return;
  const key = input.value.trim();
  if (!key) return;
  localStorage.setItem(_gnewsKeyStorageKey(), key);
  logAlertItem('info', '🔑 GNews API key saved');
  fetchGeneralNewsIfActive(true);
}

function clearGnewsApiKey() {
  localStorage.removeItem(_gnewsKeyStorageKey());
  STATE.generalNewsItems = [];
  renderGeneralNews();
}

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
  const apiKey = getGnewsApiKey();
  if (!apiKey) { renderGeneralNews(); return; }

  const url = `https://gnews.io/api/v4/search?q=${encodeURIComponent(GNEWS_QUERY)}&lang=en&max=${GNEWS_MAX_ARTICLES}&sortby=publishedAt&token=${encodeURIComponent(apiKey)}`;

  let data;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
    data = await r.json();
  } catch (e) {
    logAlertItem('info', `📰 GNews fetch FAILED: ${e.message}`);
    _useGeneralNewsCache();
    return;
  }

  if (data?.errors) {
    const msg = Array.isArray(data.errors) ? data.errors.join('; ') : String(data.errors);
    logAlertItem('info', `📰 GNews: ${msg.substring(0, 140)}`);
    _useGeneralNewsCache(msg);
    return;
  }

  const articles = Array.isArray(data.articles) ? data.articles : [];
  if (!articles.length) { _useGeneralNewsCache(); return; }

  const items = articles.map(a => ({
    title:  a.title,
    url:    a.url,
    source: a.source?.name || 'GNews',
    time:   (() => { try { return new Date(a.publishedAt).toLocaleTimeString(); } catch { return ''; } })(),
  }));

  STATE.generalNewsItems  = items;
  STATE.generalNewsCache  = { items, ts: Date.now() };
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

  const apiKey = getGnewsApiKey();
  if (!apiKey) {
    if (badge) badge.textContent = 'no API key';
    body.innerHTML = `
      <div style="font-family:var(--mono);font-size:11px;color:var(--text-dim);display:flex;flex-direction:column;gap:8px;max-width:420px;">
        <div>Paste your free GNews API key to enable geopolitical / rates / jobs / crypto headlines (polls every 30 min).</div>
        <div style="display:flex;gap:6px;">
          <input id="gnews-key-input" type="password" placeholder="GNews API key" style="flex:1;background:var(--card);border:1px solid var(--border);border-radius:3px;color:var(--text-bright);padding:5px 8px;font-family:var(--mono);font-size:11px;">
          <button onclick="saveGnewsApiKey()" style="font-family:var(--mono);font-size:11px;padding:4px 10px;background:var(--accent);color:#000;border:none;border-radius:3px;cursor:pointer;font-weight:700;">SAVE</button>
        </div>
        <div style="font-size:9px;opacity:.7;">Get a free key at gnews.io. Display-only — headlines never trigger a buy/sell or Telegram alert.</div>
      </div>`;
    return;
  }

  const items = STATE.generalNewsItems || [];
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
    <div style="margin-top:8px;display:flex;justify-content:space-between;align-items:center;">
      <span style="font-family:var(--mono);font-size:8px;color:var(--text-dim);">Display-only · geopolitics/rates/jobs/crypto search · no Telegram alerts</span>
      <button onclick="clearGnewsApiKey()" style="font-family:var(--mono);font-size:8px;padding:2px 6px;background:transparent;color:var(--text-dim);border:1px solid var(--border);border-radius:3px;cursor:pointer;">clear API key</button>
    </div>`;
}
