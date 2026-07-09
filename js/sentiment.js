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

window.SENTIMENT_PAUSED = true;

function _avKeyStorageKey() { return `${_REPO_NS}_av_key`; }
function getAvApiKey()      { return (localStorage.getItem(_avKeyStorageKey()) || '').trim(); }

function saveAvApiKey() {
  const input = document.getElementById('av-key-input');
  if (!input) return;
  const key = input.value.trim();
  if (!key) return;
  localStorage.setItem(_avKeyStorageKey(), key);
  logAlertItem('info', '🔑 Alpha Vantage API key saved');
  fetchSentimentIfActive(true);
}

function clearAvApiKey() {
  localStorage.removeItem(_avKeyStorageKey());
  STATE.sentimentItems = [];
  STATE.sentimentBySymbol = {};
  STATE.marketNewsItems = [];
  renderSentiment();
}


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
  fetchMarketNews();
}

// ── Fetch + parse ──
async function fetchSentiment() {
  const apiKey = getAvApiKey();
  if (!apiKey) { renderSentiment(); return; }

  const bases = sentimentCryptoBases();
  if (!bases.length) { renderSentiment(); return; }

  const tickers = bases.map(b => 'CRYPTO:' + b).join(',');
  const url = `https://www.alphavantage.co/query?function=NEWS_SENTIMENT&tickers=${encodeURIComponent(tickers)}&limit=50&apikey=${encodeURIComponent(apiKey)}`;

  let data;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
    data = await r.json();
  } catch (e) {
    logAlertItem('info', `📰 Sentiment fetch FAILED: ${e.message}`);
    _useSentimentCache();
    return;
  }

  if (data?.Information || data?.Note || data?.['Error Message']) {
    const msg = data.Information || data.Note || data['Error Message'];
    logAlertItem('info', `📰 Alpha Vantage: ${msg.substring(0, 140)}`);
    _useSentimentCache(msg);
    return;
  }

  const feed = Array.isArray(data.feed) ? data.feed : [];
  if (!feed.length) { _useSentimentCache(); return; }

  const items = feed.slice(0, 40).map(a => ({
    title:  a.title,
    url:    a.url,
    source: a.source || 'AlphaVantage',
    time:   (() => { try { return new Date(
              a.time_published.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/, '$1-$2-$3T$4:$5:$6')
            ).toLocaleTimeString(); } catch { return ''; } })(),
    ts:     (() => { try { return new Date(
              a.time_published.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/, '$1-$2-$3T$4:$5:$6')
            ).getTime(); } catch { return 0; } })(),
    score:  typeof a.overall_sentiment_score === 'number' ? a.overall_sentiment_score : 0,
    label:  a.overall_sentiment_label || 'Neutral',
    tickerSentiments: Array.isArray(a.ticker_sentiment) ? a.ticker_sentiment : [],
  }));

  // Aggregate per watched symbol, weighted by relevance_score
  const bySymbol = {};
  for (const base of bases) {
    const avTicker = 'CRYPTO:' + base;
    let weightSum = 0, scoreSum = 0, count = 0;
    for (const item of items) {
      const hit = item.tickerSentiments.find(t => t.ticker === avTicker);
      if (!hit) continue;
      const rel = parseFloat(hit.relevance_score) || 0;
      const sc  = parseFloat(hit.ticker_sentiment_score) || 0;
      weightSum += rel; scoreSum += sc * rel; count++;
    }
    if (count > 0) {
      const avgScore = weightSum > 0 ? scoreSum / weightSum : 0;
      bySymbol[base] = { score: avgScore, label: _sentLabel(avgScore), count };
    }
  }

  STATE.sentimentItems     = items;
  STATE.sentimentBySymbol  = bySymbol;
  STATE.sentimentCache     = { items, bySymbol, ts: Date.now() };

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

// ── General market news (watchlist-independent) ──
// Uses topics= instead of tickers= so it's not filtered by what's on the
// watchlist. Display-only: no per-item Telegram alerts, since there's no
// single symbol to attach an alert to.
async function fetchMarketNews() {
  const apiKey = getAvApiKey();
  if (!apiKey) { return; }

  const url = `https://www.alphavantage.co/query?function=NEWS_SENTIMENT&topics=${encodeURIComponent(AV_MARKET_TOPICS)}&limit=50&apikey=${encodeURIComponent(apiKey)}`;

  let data;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
    data = await r.json();
  } catch (e) {
    logAlertItem('info', `📰 Market news fetch FAILED: ${e.message}`);
    _useMarketNewsCache();
    return;
  }

  if (data?.Information || data?.Note || data?.['Error Message']) {
    const msg = data.Information || data.Note || data['Error Message'];
    logAlertItem('info', `📰 Alpha Vantage (market news): ${msg.substring(0, 140)}`);
    _useMarketNewsCache();
    return;
  }

  const feed = Array.isArray(data.feed) ? data.feed : [];
  if (!feed.length) { _useMarketNewsCache(); return; }

  const items = feed.slice(0, 30).map(a => ({
    title:  a.title,
    url:    a.url,
    source: a.source || 'AlphaVantage',
    time:   (() => { try { return new Date(
              a.time_published.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/, '$1-$2-$3T$4:$5:$6')
            ).toLocaleTimeString(); } catch { return ''; } })(),
    score:  typeof a.overall_sentiment_score === 'number' ? a.overall_sentiment_score : 0,
    label:  a.overall_sentiment_label || 'Neutral',
  }));

  STATE.marketNewsItems  = items;
  STATE.marketNewsCache  = { items, ts: Date.now() };
  renderSentiment();
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

  const apiKey = getAvApiKey();
  if (!apiKey) {
    if (badge) badge.textContent = 'no API key';
    body.innerHTML = `
      <div style="font-family:var(--mono);font-size:11px;color:var(--text-dim);display:flex;flex-direction:column;gap:8px;max-width:420px;">
        <div>Paste your free Alpha Vantage API key to enable crypto sentiment polling (every 5 min) and Telegram alerts.</div>
        <div style="display:flex;gap:6px;">
          <input id="av-key-input" type="password" placeholder="Alpha Vantage API key" style="flex:1;background:var(--card);border:1px solid var(--border);border-radius:3px;color:var(--text-bright);padding:5px 8px;font-family:var(--mono);font-size:11px;">
          <button onclick="saveAvApiKey()" style="font-family:var(--mono);font-size:11px;padding:4px 10px;background:var(--accent);color:#000;border:none;border-radius:3px;cursor:pointer;font-weight:700;">SAVE</button>
        </div>
        <div style="font-size:9px;opacity:.7;">Get a free key at alphavantage.co/support/#api-key. This is alert-only — sentiment never triggers a buy/sell, it just pings Telegram.</div>
      </div>`;
    return;
  }

  const items = STATE.sentimentItems || [];
  const bySymbol = STATE.sentimentBySymbol || {};
  const bulls = Object.values(bySymbol).filter(a => a.score >= AV_BULLISH_THRESHOLD).length;
  const bears = Object.values(bySymbol).filter(a => a.score <= AV_BEARISH_THRESHOLD).length;

  if (badge) badge.textContent = items.length + ' items · poll 5m';
  if (bullEl) bullEl.textContent = '▲ ' + bulls;
  if (bearEl) bearEl.textContent = '▼ ' + bears;

  if (!items.length) {
    body.innerHTML = `<div style="padding:20px;text-align:center;font-family:var(--mono);font-size:10px;color:var(--text-dim);">Waiting for first poll… click ▶ to start (refreshes every 5 min)</div>`;
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
    <div style="margin-top:8px;display:flex;justify-content:space-between;align-items:center;">
      <span style="font-family:var(--mono);font-size:8px;color:var(--text-dim);">Alert-only · thresholds ±${AV_BULLISH_THRESHOLD} · cooldown ${AV_SENTIMENT_COOLDOWN_HOURS}h/symbol</span>
      <button onclick="clearAvApiKey()" style="font-family:var(--mono);font-size:8px;padding:2px 6px;background:transparent;color:var(--text-dim);border:1px solid var(--border);border-radius:3px;cursor:pointer;">clear API key</button>
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
      ${rows || `<div style="padding:10px 0;font-family:var(--mono);font-size:10px;color:var(--text-dim);">Waiting for first poll…</div>`}
    </div>`;
}
