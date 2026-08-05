// ══════════════════════════════════════════════
// sentiment.js — Alpha Vantage News/Sentiment panel
// ------------------------------------------------
// ALERT-ONLY. This module never touches positions.json, never auto-buys/sells,
// and never calls any exchange/trading API. It only:
//   1. Polls Alpha Vantage NEWS_SENTIMENT for the crypto symbols on the watchlist
//   2. Polls Alpha Vantage NEWS_SENTIMENT again with topics=blockchain,financial_markets
//      (no tickers param) for general market news, independent of the watchlist
//   3. Renders a dashboard panel with per-symbol sentiment + both headline feeds
//   4. Fires a Telegram alert (via the existing sendTelegramAlert()) when a
//      symbol's aggregate sentiment crosses into Bullish/Bearish territory
//      (general market news is display-only — it isn't tied to a symbol, so it
//      never fires a Telegram alert)
//
// Free-tier note: Alpha Vantage's free API key is limited (historically ~25
// requests/day). This module now makes 2 calls per poll (watchlist + general
// market). Polling is clustered around known news-heavy UTC hours (see
// AV_POLL_HOURS_UTC / _startAvClusteredPoll in app.js) rather than a flat
// interval, since news volume isn't evenly spread across the day either.
// ══════════════════════════════════════════════

const AV_SENTIMENT_COOLDOWN_HOURS = 4;       // min hours between repeat alerts, per symbol+direction
const AV_SENTIMENT_MIN_ARTICLES  = 2;        // don't alert off a single stray headline
const AV_BULLISH_THRESHOLD  = 0.35;  // matches Alpha Vantage's own "Bullish" bucket
const AV_BEARISH_THRESHOLD  = -0.35; // matches Alpha Vantage's own "Bearish" bucket
const AV_MAX_TICKERS = 15; // keep the request URL/relevance reasonable
const AV_MARKET_TOPICS = 'blockchain,financial_markets'; // watchlist-independent general market news

// ── Data source ──
// AV_API_KEY is a server-side-only secret. The GitHub Actions workflow runs
// scripts/sentiment-fetcher.js on every "fetch" job (using the real key from
// process.env) and commits its output to scripts/sentiment-data.json. The
// browser never sees the key — it just reads that committed JSON file via
// raw.githubusercontent.com (bypassing GitHub Pages' CDN cache).
// Same repo-detection fix as market-intelligence.js — see comment there.
// Was hardcoded to 'ahsan520/alpha', which pointed every other Alpha
// Terminal instance's Sentiment panel at the wrong repo's data file.
const SENTIMENT_DATA_REPO   = () => (typeof _deriveRepo === 'function' ? _deriveRepo() : (window.__GH_REPO || ''));
const SENTIMENT_DATA_BRANCH = 'main';
const SENTIMENT_DATA_PATH   = 'scripts/sentiment-data.json';

// Auto-start state — always unpaused; app.js init() calls
// _startAvClusteredPoll() / fetchSentimentIfActive() after scripts load.
// Whether there's actually data depends on whether the workflow has a
// server-side AV_API_KEY configured (see renderSentiment()'s no-data path).
window.SENTIMENT_PAUSED = false;


// ── Which crypto symbols to track — derived from the live watchlist ──
function sentimentCryptoBases() {
  const bases = (STATE.watchlist || [])
    .filter(s => s.startsWith('BINANCE:') && s.endsWith('USDT'))
    .map(s => s.replace('BINANCE:', '').replace('USDT', ''));
  return [...new Set(bases)].slice(0, AV_MAX_TICKERS);
}

function toggleSentiment() {
  STATE.sentimentOpen = !STATE.sentimentOpen;
  const body  = document.getElementById('sentiment-body');
  const chev  = document.getElementById('sentiment-chevron');
  if (body) body.classList.toggle('hide', !STATE.sentimentOpen);
  if (chev) chev.textContent = STATE.sentimentOpen ? '▲ COLLAPSE' : '▼ EXPAND';
}

function toggleSentimentPause() {
  window.SENTIMENT_PAUSED = !window.SENTIMENT_PAUSED;
  const btn = document.getElementById('sentiment-pause-btn');
  if (btn) btn.textContent = window.SENTIMENT_PAUSED ? '▶' : '⏸';
  if (!window.SENTIMENT_PAUSED) fetchSentimentIfActive(true);
}

function fetchSentimentIfActive(force) {
  if (!force && window.SENTIMENT_PAUSED) return;
  fetchSentiment();
}

// ── Fetch (reads the workflow-committed sentiment-data.json — no browser-side API key) ──
async function fetchSentiment() {
  const repo = SENTIMENT_DATA_REPO();
  if (!repo) { renderSentiment(); return; }

  const url = `https://raw.githubusercontent.com/${repo}/${SENTIMENT_DATA_BRANCH}/${SENTIMENT_DATA_PATH}?t=${Date.now()}`;

  let data;
  try {
    const r = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(15000) });
    if (r.status === 404) { renderSentiment('sentiment-data.json not found yet — waiting for first workflow run.'); return; }
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    data = await r.json();
  } catch (e) {
    logAlertItem('info', `📰 Sentiment data fetch FAILED: ${e.message}`);
    _useSentimentCache();
    return;
  }

  const items    = Array.isArray(data.items) ? data.items : [];
  const bySymbol = data.bySymbol && typeof data.bySymbol === 'object' ? data.bySymbol : {};
  const marketNewsItems = Array.isArray(data.marketNewsItems) ? data.marketNewsItems : [];

  STATE.sentimentItems     = items;
  STATE.sentimentBySymbol  = bySymbol;
  STATE.sentimentCache     = { items, bySymbol, ts: Date.now() };
  STATE.marketNewsItems    = marketNewsItems;
  STATE.marketNewsCache    = { items: marketNewsItems, ts: Date.now() };
  STATE.sentimentFetchedAt = data.fetchedAt || 0;

  renderSentiment();
  checkSentimentAlerts();
}

function _useSentimentCache(noteMsg) {
  const cached = STATE.sentimentCache;
  if (cached?.items?.length) {
    STATE.sentimentItems    = cached.items;
    STATE.sentimentBySymbol = cached.bySymbol;
  }
  renderSentiment(noteMsg);
}

function _useMarketNewsCache() {
  const cached = STATE.marketNewsCache;
  if (cached?.items?.length) STATE.marketNewsItems = cached.items;
  renderSentiment();
}

function _sentLabel(score) {
  if (score >= AV_BULLISH_THRESHOLD) return 'Bullish';
  if (score >= 0.15) return 'Somewhat-Bullish';
  if (score <= AV_BEARISH_THRESHOLD) return 'Bearish';
  if (score <= -0.15) return 'Somewhat-Bearish';
  return 'Neutral';
}

// ── Alert-only dispatch (no auto-action on positions) ──
function _avFpKey(base, direction) { return `a49_fp_av_sentiment_${base}_${direction}`; }

function _avIsCoolingDown(base, direction) {
  const ts = parseInt(localStorage.getItem(_avFpKey(base, direction)) || '0');
  if (!ts) return false;
  return (Date.now() - ts) < AV_SENTIMENT_COOLDOWN_HOURS * 3600000;
}

function _avMarkFired(base, direction) {
  localStorage.setItem(_avFpKey(base, direction), String(Date.now()));
}

function checkSentimentAlerts() {
  const bySymbol = STATE.sentimentBySymbol || {};
  for (const [base, agg] of Object.entries(bySymbol)) {
    if (agg.count < AV_SENTIMENT_MIN_ARTICLES) continue;

    let direction = null;
    if (agg.score >= AV_BULLISH_THRESHOLD) direction = 'bullish';
    else if (agg.score <= AV_BEARISH_THRESHOLD) direction = 'bearish';
    if (!direction) continue;

    if (_avIsCoolingDown(base, direction)) continue;

    const arrow = direction === 'bullish' ? '🟢' : '🔴';
    const msg = `${arrow} SENTIMENT ${direction.toUpperCase()} — ${base}\n` +
      `Score: ${agg.score.toFixed(2)} (${agg.label}) across ${agg.count} article(s)\n` +
      `Source: Alpha Vantage News/Sentiment\n` +
      `⚠ Alert-only — no position was opened, closed, or modified.`;

    logAlertItem('info', `[SENTIMENT] ${base} → ${agg.label} (${agg.score.toFixed(2)})`);

    const sym = 'BINANCE:' + base + 'USDT';
    if (typeof isAlertEnabled !== 'function' || isAlertEnabled(sym)) {
      sendTelegramAlert(msg);
    } else {
      logAlertItem('info', `[TG SKIPPED] ${base} — alerts disabled in Watchlist Manager`);
    }
    _avMarkFired(base, direction);
  }
}

// ── Render ──
function renderSentiment() {
  const badge = document.getElementById('sentiment-badge');
  const bullEl = document.getElementById('sentiment-bull-n');
  const bearEl = document.getElementById('sentiment-bear-n');
  const body   = document.getElementById('sentiment-body');
  if (!body) return;

  const items = STATE.sentimentItems || [];
  if (!items.length && !STATE.sentimentFetchedAt) {
    if (badge) badge.textContent = 'no data yet';
    body.innerHTML = `<div style="padding:16px;font-family:var(--mono);font-size:10px;color:var(--text-dim);line-height:1.7;">
      No sentiment data yet.<br>
      Make sure <code style="color:var(--text-bright)">AV_API_KEY</code> is set as a GitHub repository secret — it's used server-side by <code>sentiment-fetcher.js</code>, which writes <code>sentiment-data.json</code> on the next workflow run.
    </div>`;
    return;
  }

  const bySymbol = STATE.sentimentBySymbol || {};
  const bulls = Object.values(bySymbol).filter(a => a.score >= AV_BULLISH_THRESHOLD).length;
  const bears = Object.values(bySymbol).filter(a => a.score <= AV_BEARISH_THRESHOLD).length;

  if (badge) badge.textContent = items.length + ' items · data hourly';
  if (bullEl) bullEl.textContent = '▲ ' + bulls;
  if (bearEl) bearEl.textContent = '▼ ' + bears;

  if (!items.length) {
    body.innerHTML = `
      <div style="padding:20px;text-align:center;font-family:var(--mono);font-size:10px;color:var(--text-dim);">Polled server-side, no matching articles yet this cycle — data updates hourly (checked here every 5 min)</div>
      ${_renderMarketNewsSection()}`;
    return;
  }

  // Per-symbol tiles
  const tiles = Object.entries(bySymbol).sort((a, b) => b[1].score - a[1].score).map(([base, agg]) => {
    const col = agg.score >= 0.15 ? 'var(--bull)' : agg.score <= -0.15 ? 'var(--bear)' : 'var(--text-dim)';
    return `<div style="display:flex;flex-direction:column;align-items:center;gap:2px;padding:6px 10px;background:var(--card);border:1px solid var(--border);border-radius:4px;min-width:64px;">
      <span style="font-family:var(--mono);font-size:10px;font-weight:700;color:var(--text-bright);">${base}</span>
      <span style="font-family:var(--mono);font-size:9px;color:${col};font-weight:700;">${agg.score.toFixed(2)}</span>
      <span style="font-family:var(--mono);font-size:7px;color:var(--text-dim);">${agg.label} · ${agg.count}</span>
    </div>`;
  }).join('');

  // Headline feed
  const headlines = items.slice(0, 25).map(n => {
    const badgeHtml = n.score >= AV_BULLISH_THRESHOLD ? `<span class="nf-alert bull">● BULLISH</span>`
      : n.score <= AV_BEARISH_THRESHOLD ? `<span class="nf-alert bear">● BEARISH</span>`
      : `<span class="nf-alert neu">● ${n.label.toUpperCase()}</span>`;
    const tickerTags = n.tickerSentiments
      .filter(t => t.ticker.startsWith('CRYPTO:'))
      .slice(0, 4)
      .map(t => `<span class="nf-itag">${t.ticker.replace('CRYPTO:', '')}</span>`)
      .join('');
    return `<div style="padding:6px 0;border-bottom:1px solid var(--border);display:flex;flex-direction:column;gap:3px;">
      <a href="${n.url}" target="_blank" rel="noopener" style="font-family:var(--mono);font-size:10.5px;color:var(--text-bright);text-decoration:none;">${n.title}</a>
      <div style="display:flex;align-items:center;gap:5px;flex-wrap:wrap;">
        ${badgeHtml}${tickerTags}
        <span style="font-family:var(--mono);font-size:8px;color:var(--text-dim);">${n.source} · ${n.time}</span>
      </div>
    </div>`;
  }).join('');

  body.innerHTML = `
    <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:10px;">${tiles}</div>
    <div>${headlines}</div>
    <div style="margin-top:8px;">
      <span style="font-family:var(--mono);font-size:8px;color:var(--text-dim);">Alert-only · thresholds ±${AV_BULLISH_THRESHOLD} · cooldown ${AV_SENTIMENT_COOLDOWN_HOURS}h/symbol · fetched server-side via AV_API_KEY secret</span>
    </div>
    ${_renderMarketNewsSection()}`;
}

// ── Render: general market news (watchlist-independent, display-only) ──
function _renderMarketNewsSection() {
  const items = STATE.marketNewsItems || [];
  const rows = items.slice(0, 20).map(n => {
    const badgeHtml = n.score >= AV_BULLISH_THRESHOLD ? `<span class="nf-alert bull">● BULLISH</span>`
      : n.score <= AV_BEARISH_THRESHOLD ? `<span class="nf-alert bear">● BEARISH</span>`
      : `<span class="nf-alert neu">● ${n.label.toUpperCase()}</span>`;
    return `<div style="padding:6px 0;border-bottom:1px solid var(--border);display:flex;flex-direction:column;gap:3px;">
      <a href="${n.url}" target="_blank" rel="noopener" style="font-family:var(--mono);font-size:10.5px;color:var(--text-bright);text-decoration:none;">${n.title}</a>
      <div style="display:flex;align-items:center;gap:5px;flex-wrap:wrap;">
        ${badgeHtml}
        <span style="font-family:var(--mono);font-size:8px;color:var(--text-dim);">${n.source} · ${n.time}</span>
      </div>
    </div>`;
  }).join('');

  return `
    <div style="margin-top:14px;padding-top:10px;border-top:1px solid var(--border);">
      <div style="font-family:var(--mono);font-size:9px;color:var(--text-dim);letter-spacing:1px;margin-bottom:6px;">
        ◆ MARKET NEWS — watchlist-independent (topics: ${AV_MARKET_TOPICS}) · display-only, no Telegram alerts
      </div>
      ${rows || `<div style="padding:10px 0;font-family:var(--mono);font-size:10px;color:var(--text-dim);">Waiting for first poll… (data updates hourly)</div>`}
    </div>`;
}
