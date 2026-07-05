// ══════════════════════════════════════════════
// app.js — v12.9.4
// Changes from v12.9.3:
//   - marketStatus() removed — now delegated to exchange-registry-browser.js
//     which handles TSX, LSE, XETRA, TSE, HKEX, NSE, NYSE automatically
//     from the suffix. The shim in exchange-registry-browser.js returns the
//     same 'open'|'prepost'|'closed' tokens app.js already uses everywhere.
//   - syncIntervalFor() updated to call the registry-backed marketStatus().
//   - switchT() (TradingView chart) now uses buildTVSymbol() from the registry
//     to build the correct TV symbol for any exchange:
//       ETHY.TO  → TSX:ETHY
//       VOD.L    → LSE:VOD
//       SIE.DE   → XETRA:SIE
//       7203.T   → TSE:7203
//       0700.HK  → HKEX:0700
//       BINANCE:BTCUSDT stays as-is (TV supports it natively)
//   - addTicker() updated to handle non-BINANCE stocks correctly — no longer
//     blindly adds BINANCE: prefix; auto-detects exchange from suffix.
//   - marketStatusBadge() updated to use registry session names (lunch_break
//     gets the same FROZEN treatment as closed).
// ══════════════════════════════════════════════

const DEFAULT_WATCHLIST = [
  'TXF.TO','HTAE.TO','ENCC.TO','GLCC.TO','ETHY.TO',
  'KILO.TO','XBM.TO','CRWD.TO','GOOG.TO','DELL.TO',
  'TSLA.TO','XRPP.TO','SPCX','ENB.TO','QMAX.TO',
];

// ── marketStatus() is now provided by exchange-registry-browser.js ──
// The shim there returns 'open' | 'prepost' | 'closed'.
// isLeaderboardEligible() and syncIntervalFor() call it directly — no change
// needed in their logic since the return tokens are identical.

function isLeaderboardEligible(sym) {
  return marketStatus(sym) === 'open';
}

function syncIntervalFor(sym) {
  if (sym.includes('BINANCE:')) return 15_000;
  const s = marketStatus(sym);
  if (s === 'open')    return 15_000;
  if (s === 'prepost') return 60_000;
  return Infinity;
}

// ── PAUSE state ──
window.MPULSE_PAUSED = true;
window.NEWS_PAUSED   = true;

function toggleMpulsePause() {
  window.MPULSE_PAUSED = !window.MPULSE_PAUSED;
  const btn = document.getElementById('mpulse-pause-btn');
  if (btn) btn.textContent = window.MPULSE_PAUSED ? '▶' : '⏸';
  if (!window.MPULSE_PAUSED) fetchMarketPulse();
}

function toggleNewsPause() {
  window.NEWS_PAUSED = !window.NEWS_PAUSED;
  const btn = document.getElementById('news-pause-btn');
  if (btn) btn.textContent = window.NEWS_PAUSED ? '▶' : '⏸';
  if (!window.NEWS_PAUSED && !STATE._newsFetched) { STATE._newsFetched = true; fetchNews(); }
  else if (!window.NEWS_PAUSED) { fetchNews(); }
}

function fetchMarketPulseIfActive() { if (!window.MPULSE_PAUSED) fetchMarketPulse(); }
function fetchNewsIfActive()        { if (!window.NEWS_PAUSED && STATE.newsOpen) fetchNews(); }

async function init() {
  STATE.newsOpen     = false;
  STATE._newsFetched = false;
  STATE.alertsOpen   = false;
  STATE.activeNewsTag = 'ALL';
  STATE.collapsedCols = {};

  let base = DEFAULT_WATCHLIST;
  try { const r = await fetch('watchlist.json'); if (r.ok) base = await r.json(); } catch {}

  if (!STATE._sessionAdded) STATE._sessionAdded = [];
  STATE.watchlist = [...base, ...STATE._sessionAdded.filter(s => !base.includes(s))];
  STATE.currentS  = null;

  initAlertFilterState();
  STATE._baseWatchlist = [...base];

  renderWL();
  renderTable();
  _renderChartPlaceholder();
  fetchGlobal();
  fetchFG();
  sync();
  _startAdaptiveSyncLoop();

  setInterval(fetchFG, 300_000);
  setInterval(fetchGlobal, 60_000);
  setInterval(fetchMarketPulseIfActive, 300_000);
  setInterval(renderWL, 30_000);
  setInterval(scheduleLeaderboard, 60_000);

  renderJournal();
  initAlertCfg();
  renderAlertCfgPage();
  updateLastUpdBar();
}

function _renderChartPlaceholder() {
  const cont = document.getElementById('tv_chart');
  if (!cont) return;
  cont.innerHTML = `
    <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;
      height:100%;min-height:220px;color:var(--text-dim);font-size:12px;gap:8px;
      background:var(--panel);border-radius:6px;">
      <span style="font-size:22px;opacity:.35;">📈</span>
      <span>Click any symbol to load chart</span>
    </div>`;
}

// ── ADAPTIVE SYNC LOOP ──
let _syncRunning  = false;
let _lastSyncTime = {};

function _startAdaptiveSyncLoop() {
  setInterval(_adaptiveTick, 15_000);
}

async function _adaptiveTick() {
  if (_syncRunning) return;
  _syncRunning = true;

  const now    = Date.now();
  const toSync = STATE.watchlist.filter(s => {
    const interval = syncIntervalFor(s);
    return (now - (_lastSyncTime[s] || 0)) >= interval;
  });

  if (!toSync.length) { _syncRunning = false; return; }

  document.getElementById('sstatus').textContent = 'SYNCING';
  document.getElementById('sdot').style.background = 'var(--gold)';

  let ok = 0, fail = 0;
  for (const s of toSync) {
    const success = await syncOne(s);
    _lastSyncTime[s] = Date.now();
    if (success) ok++; else fail++;
    patchSymbolRow(s);
    await new Promise(r => setTimeout(r, 100));
  }

  localStorage.setItem('a49_ds', JSON.stringify(STATE.DS));
  localStorage.setItem('a49_ph', JSON.stringify(STATE.PH));
  await flushDigest();
  updateLastUpdBar();

  document.getElementById('sstatus').textContent = fail > 0 ? `LIVE (${fail} ERR)` : 'LIVE';
  document.getElementById('sdot').style.background = ok > 0 ? 'var(--bull)' : 'var(--bear)';
  _syncRunning = false;
}

// ── SINGLE SYMBOL FETCH ──
async function syncOne(s, { forceRefresh = false } = {}) {
  const isCrypto = s.includes('BINANCE:');

  if (!isCrypto && !forceRefresh) {
    const status = marketStatus(s);
    if (status === 'closed') {
      if (typeof patchSymbolRow === 'function') patchSymbolRow(s);
      return true;
    }
  }

  try {
    if (isCrypto) {
      const pair       = s.split(':')[1];
      const isDelisted = BINANCE_DELISTED.has(pair);
      let pd;

      if (isDelisted) {
        try {
          const kPair = KRAKEN_PAIR[pair];
          if (kPair) {
            const url = `https://api.kraken.com/0/public/Ticker?pair=${kPair}`;
            let d = null;
            try { const r = await fetch(url, { signal: AbortSignal.timeout(8000) }); if (r.ok) d = await r.json(); } catch {}
            if (!d) d = await fetchProxy(url);
            const key = Object.keys(d?.result || {})[0];
            if (key) {
              const t = d.result[key]; const last = parseFloat(t.c[0]); const open = parseFloat(t.o);
              pd = { p: last, chg: open > 0 ? parseFloat(((last - open) / open * 100).toFixed(2)) : 0 };
            }
          }
        } catch {}
      } else {
        try { pd = (await batchCrypto([s]))[s]; } catch {}
        if (!pd) pd = await binanceFallback(s).catch(() => null);
      }
      if (!pd) return false;

      if (!STATE.PH[s]) STATE.PH[s] = [];
      STATE.PH[s].push(pd.p);
      if (STATE.PH[s].length > 200) STATE.PH[s].shift();

      processAI(s, pd.p, pd.chg, {});
      if (typeof patchSymbolRow === 'function') patchSymbolRow(s);

      const extraFetch = isDelisted
        ? fetchKrakenExtra(pair).catch(() => ({}))
        : fetchCryptoExtra(pair).catch(() => ({}));

      extraFetch.then(extra => {
        if (!extra) return;
        processAI(s, pd.p, pd.chg, extra);
        if (typeof patchSymbolRow === 'function') patchSymbolRow(s);
        try {
          localStorage.setItem('a49_ds', JSON.stringify(STATE.DS));
          localStorage.setItem('a49_ph', JSON.stringify(STATE.PH));
        } catch {}
      });

    } else {
      const [{ p, chg: rawChg }, stockExtra] = await Promise.all([
        fetchStock(s),
        fetchStockExtra(s).catch(() => ({})),
      ]);
      const chg1d = stockExtra?.kDay?.chg1d;
      const chg   = (chg1d != null && Math.abs(rawChg) > 15 && Math.abs(chg1d) < Math.abs(rawChg))
        ? chg1d : rawChg;
      if (!STATE.PH[s]) STATE.PH[s] = [];
      STATE.PH[s].push(p);
      if (STATE.PH[s].length > 200) STATE.PH[s].shift();
      processAI(s, p, chg, stockExtra);
    }
    return true;
  } catch { return false; }
}

// ── FULL SYNC ──
async function sync() {
  document.getElementById('sstatus').textContent = 'SYNCING';
  document.getElementById('sdot').style.background = 'var(--gold)';

  let ok = 0, fail = 0;
  for (const s of STATE.watchlist) {
    const success = await syncOne(s);
    _lastSyncTime[s] = Date.now();
    if (success) ok++; else fail++;
    if (typeof patchSymbolRow === 'function') patchSymbolRow(s);
    await new Promise(r => setTimeout(r, 100));
  }

  localStorage.setItem('a49_ds', JSON.stringify(STATE.DS));
  localStorage.setItem('a49_ph', JSON.stringify(STATE.PH));
  await flushDigest();
  updateLastUpdBar();

  document.getElementById('sstatus').textContent = fail > 0 ? `LIVE (${fail} ERR)` : 'LIVE';
  document.getElementById('sdot').style.background = ok > 0 ? 'var(--bull)' : 'var(--bear)';
}

// ── PER-ROW REFRESH ──
async function refreshSymbol(s, btnEl) {
  const isCrypto = s.includes('BINANCE:');
  const closed   = !isCrypto && marketStatus(s) === 'closed';
  if (btnEl) { btnEl.textContent = '⟳'; btnEl.style.opacity = '0.4'; btnEl.disabled = true; }
  const ok = await syncOne(s, { forceRefresh: true });
  _lastSyncTime[s] = Date.now();
  if (btnEl) {
    btnEl.textContent = closed ? '🔒' : '↺';
    btnEl.title       = closed ? 'Market closed — showing last close price' : '';
    btnEl.style.opacity = ok ? '1' : '0.3';
    btnEl.disabled = false;
  }
  localStorage.setItem('a49_ds', JSON.stringify(STATE.DS));
  localStorage.setItem('a49_ph', JSON.stringify(STATE.PH));
  if (typeof patchSymbolRow === 'function') patchSymbolRow(s); else renderTable();
  updateLastUpdBar();
}

function updateLastUpdBar() {
  const el = document.getElementById('last-upd-bar-time');
  if (el) el.textContent = new Date().toLocaleTimeString();
}

// ── TAB NAV ──
function switchTab(tab, btn) {
  document.querySelectorAll('.tc').forEach(el => el.classList.remove('on'));
  document.querySelectorAll('.tab').forEach(b  => b.classList.remove('on'));
  document.getElementById('tab-' + tab).classList.add('on');
  btn.classList.add('on');
  if (tab === 'alerts')        renderAlertCfgPage();
  if (tab === 'watchlist-mgr') renderWatchlistManager();
  if (tab === 'journal')       renderApiTrades();  // always refresh on open
}

// ══════════════════════════════════════════════════════════════════════════════
// API TRADES TRACKER
// Reads positions.json from GitHub (same raw.githubusercontent pull used by
// Position Tracker) and renders every position that has a `liveOrder` field —
// i.e. every buy/sell placed via the MEXC auto-trader.
// ══════════════════════════════════════════════════════════════════════════════
const _apiTradesState = { loading: false, lastFetched: 0, positions: {} };

async function refreshApiTrades() {
  if (_apiTradesState.loading) return;
  _apiTradesState.loading = true;
  setApiTradesFooter('Loading…');
  try {
    const cfg     = typeof loadGhSyncCfg === 'function' ? loadGhSyncCfg() : {};
    const repo    = cfg.repo  || window.__GH_REPO || '';
    const branch  = cfg.branch || 'main';
    const fpath   = (cfg.path || 'scripts/positions.json');
    if (!repo) { setApiTradesFooter('GitHub repo not configured — set GH_REPO in sync settings.'); return; }

    const url  = `https://raw.githubusercontent.com/${repo}/${branch}/${fpath}?t=${Date.now()}`;
    const res  = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const positions = await res.json();

    _apiTradesState.positions    = positions;
    _apiTradesState.lastFetched  = Date.now();
    renderApiTrades(positions);
    setApiTradesFooter(`Last synced ${new Date().toLocaleTimeString()} from ${repo}`);
  } catch (e) {
    setApiTradesFooter(`Error loading positions: ${e.message}`);
  } finally {
    _apiTradesState.loading = false;
  }
}

function setApiTradesFooter(msg) {
  const el = document.getElementById('api-trades-footer');
  if (el) el.textContent = msg;
}

function renderApiTrades(positions) {
  positions = positions || _apiTradesState.positions;
  const tbody  = document.getElementById('api-trades-tbody');
  const stats  = document.getElementById('api-trades-stats');
  const badge  = document.getElementById('api-trade-mode-badge');
  if (!tbody) return;

  // Collect only positions that were touched by the MEXC auto-trader
  const rows = Object.values(positions)
    .filter(p => p.liveOrder)
    .sort((a, b) => (b.liveOrder.buyAt || b.alertedAt || 0) - (a.liveOrder.buyAt || a.alertedAt || 0));

  // Infer the current trade mode from positions on record
  const modes = [...new Set(rows.map(r => r.liveOrder.mode || 'paper'))];
  const mode  = modes.includes('live') ? 'live' : modes.includes('paper') ? 'paper' : 'off';
  if (badge) {
    badge.textContent = mode.toUpperCase();
    badge.className   = 'api-trades-mode' + (mode === 'live' ? ' live' : mode === 'off' ? ' off' : '');
  }

  // Summary stats
  const closed    = rows.filter(r => r.liveOrder.closedAt);
  const wins      = closed.filter(r => (r.liveOrder.pnlPct || 0) > 0);
  const totalPnl  = closed.reduce((s, r) => s + (r.liveOrder.pnlPct || 0), 0);
  const winRate   = closed.length ? Math.round(wins.length / closed.length * 100) : null;
  if (stats) stats.innerHTML = [
    `<span>${rows.length}</span> trades`,
    closed.length ? `<span>${winRate}%</span> win rate` : null,
    closed.length ? `<span>${totalPnl >= 0 ? '+' : ''}${totalPnl.toFixed(2)}%</span> total P&L` : null,
  ].filter(Boolean).join('&nbsp;&nbsp;·&nbsp;&nbsp;');

  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="11" style="text-align:center;color:var(--text-dim);padding:20px;">No API trades on record yet — they appear here once the ⭐ auto-trader places its first buy.</td></tr>';
    return;
  }

  tbody.innerHTML = rows.map(p => {
    const lo      = p.liveOrder;
    const buyAt   = lo.buyAt   ? new Date(lo.buyAt).toLocaleString()  : '—';
    const sellAt  = lo.closedAt? new Date(lo.closedAt).toLocaleString(): null;
    const buyQty  = lo.qty     ? lo.qty.toFixed(6)  : '—';
    const buyP    = lo.fillPrice? '$' + lo.fillPrice.toFixed(6) : '—';
    const sellQty = lo.closedAt && lo.qty ? lo.qty.toFixed(6) : '—';
    const sellP   = lo.exitFillPrice ? '$' + lo.exitFillPrice.toFixed(6) : '—';
    const pnlPct  = lo.fillPrice && lo.exitFillPrice
      ? ((lo.exitFillPrice - lo.fillPrice) / lo.fillPrice * 100)
      : lo.pnlPct || null;
    const pnlStr  = pnlPct !== null
      ? `<span class="${pnlPct >= 0 ? 'pnl-pos' : 'pnl-neg'}">${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(2)}%</span>`
      : '—';

    // Status badge
    const terminated = ['stopped', 'tp2_hit'].includes(p.status);
    const statusLabel = lo.closedAt
      ? (p.status === 'stopped' ? '🔴 stopped' : '🏆 tp2 hit')
      : (terminated ? '🟡 closing' : '🟢 open');
    const statusCls   = lo.closedAt
      ? (p.status === 'stopped' ? 'status-stopped' : 'status-closed')
      : 'status-open';

    // Show time info: buy time on first row, sell time if closed
    const timeCell = sellAt
      ? `<span title="Bought: ${buyAt}&#10;Sold: ${sellAt}">B: ${buyAt.split(', ')[1] || buyAt}<br><span style="color:var(--text-dim)">S: ${sellAt.split(', ')[1] || sellAt}</span></span>`
      : `<span title="${buyAt}">${buyAt}</span>`;

    return `<tr>
      <td style="font-size:9px">${timeCell}</td>
      <td><b style="color:var(--text-bright)">${p.base}</b><br><span style="font-size:8px;color:var(--text-dim)">${lo.mode || 'paper'}</span></td>
      <td><span style="font-size:8px;padding:2px 6px;border-radius:3px;background:rgba(61,155,255,0.1);color:#4da6ff">BUY</span></td>
      <td>${buyQty}</td>
      <td>${buyP}</td>
      <td class="ord-id" title="${lo.buyOrderId || '—'}">${lo.buyOrderId || '—'}</td>
      <td>${sellQty}</td>
      <td>${sellP}</td>
      <td class="ord-id" title="${lo.sellOrderId || '—'}">${lo.sellOrderId || '—'}</td>
      <td>${pnlStr}</td>
      <td class="${statusCls}" style="font-size:9px">${statusLabel}</td>
    </tr>`;
  }).join('');
}


function sortBy(k) {
  STATE.sortD = STATE.sortK === k ? STATE.sortD * -1 : -1;
  STATE.sortK = k;
  document.querySelectorAll('table.mx thead th').forEach(th => th.classList.remove('srt'));
  renderTable();
}

// ── CHART SETUP — shared by single view and both compare panes ──
// Default view: last 5 minutes visible, with Supertrend + Bull Bear Power
// pre-loaded. Interval defaults to 1-minute candles — a 5-minute window of
// 30-minute candles would show well under one bar, so granularity has to
// match the window. The person can still change interval/indicators by hand
// afterward; this only sets what loads initially.
const DEFAULT_CHART_INTERVAL   = '1';       // 1-minute candles
const DEFAULT_VISIBLE_RANGE_S  = 5 * 60;    // last 5 minutes
const DEFAULT_STUDIES          = ['Supertrend', 'Bull Bear Power'];

function _applyDefaultChartView(widget) {
  if (!widget || typeof widget.onChartReady !== 'function') return;
  widget.onChartReady(() => {
    try {
      const chart  = widget.chart();
      const nowSec = Math.floor(Date.now() / 1000);
      chart.setVisibleRange({ from: nowSec - DEFAULT_VISIBLE_RANGE_S, to: nowSec });
      DEFAULT_STUDIES.forEach(name => {
        try { chart.createStudy(name, false, false); }
        catch (e) { console.log(`[chart] createStudy('${name}') failed:`, e.message); }
      });
    } catch (e) {
      console.log('[chart] default view setup failed:', e.message);
    }
  });
}

function _buildTVWidget(containerId, sym) {
  const tv = typeof buildTVSymbol !== 'undefined' ? buildTVSymbol(sym) : sym;
  const widget = new TradingView.widget({
    autosize: true, symbol: tv, interval: DEFAULT_CHART_INTERVAL, theme: 'dark',
    container_id: containerId, allow_symbol_change: true, style: '1',
    toolbar_bg: '#0d1117',
    overrides: {
      'paneProperties.background':              '#080a0d',
      'paneProperties.vertGridProperties.color': '#1e2530',
      'paneProperties.horzGridProperties.color': '#1e2530',
    },
  });
  _applyDefaultChartView(widget);
  return widget;
}

// ── CHART SWITCH — registry-backed TradingView symbol ──
function switchT(s) {
  const prev = STATE.currentS;
  STATE.currentS = s;

  const cont = document.getElementById('tv_chart');
  if (cont && cont.querySelector('div[style*="Click any symbol"]')) cont.innerHTML = '';

  if (STATE.tvW) { try { STATE.tvW.remove(); } catch {} }
  STATE.tvW = _buildTVWidget('tv_chart', s);

  renderWL();
  if (s !== prev && STATE._newsFetched) fetchNews();
}

// ── COMPARE MODE — side-by-side second chart ──
function toggleCompareMode() {
  STATE.compareMode = !STATE.compareMode;
  const btn      = document.getElementById('compare-toggle-btn');
  const wrap     = document.getElementById('compare-symbol-wrap');
  const paneB    = document.getElementById('tv_chart_b');
  if (btn)   btn.classList.toggle('on', STATE.compareMode);
  if (wrap)  wrap.classList.toggle('hide', !STATE.compareMode);
  if (paneB) paneB.style.display = STATE.compareMode ? 'block' : 'none';

  if (STATE.compareMode) {
    // Default second symbol: whatever's currently focused stays on the left;
    // pick the next watchlist entry (or fall back to the same symbol) for the right.
    if (!STATE.compareSymbol) {
      const others = STATE.watchlist.filter(s => s !== STATE.currentS);
      STATE.compareSymbol = others[0] || STATE.currentS;
    }
    const input = document.getElementById('compareSymbolInput');
    if (input) input.value = (STATE.compareSymbol || '').split(':').pop().replace('USDT', '');
    _renderComparePane();
  } else if (STATE.tvW2) {
    try { STATE.tvW2.remove(); } catch {}
    STATE.tvW2 = null;
  }
}

function setCompareSymbol(raw) {
  const v = (raw || '').trim().toUpperCase();
  if (!v) return;

  // Prefer an exact base match already in the watchlist (any exchange),
  // otherwise assume crypto on Binance — same default addTicker() uses.
  const existing = STATE.watchlist.find(sym => {
    const base = sym.includes(':') ? sym.split(':')[1].replace('USDT', '') : sym.replace(/\.\w+$/, '');
    return base === v;
  });
  STATE.compareSymbol = existing || (v.startsWith('BINANCE:') ? v : `BINANCE:${v}${v.includes('USDT') ? '' : 'USDT'}`);
  _renderComparePane();
}

function _renderComparePane() {
  if (!STATE.compareSymbol) return;
  if (STATE.tvW2) { try { STATE.tvW2.remove(); } catch {} }
  STATE.tvW2 = _buildTVWidget('tv_chart_b', STATE.compareSymbol);
}

// ── WATCHLIST MANAGEMENT ──
function addTicker() {
  let v = document.getElementById('newT').value.trim().toUpperCase();
  const t = document.getElementById('assetType').value;
  if (!v) return;

  let e;
  if (t === 'crypto') {
    // Crypto: ensure BINANCE: prefix and USDT quote
    e = v.startsWith('BINANCE:') ? v : `BINANCE:${v}${v.includes('USDT') ? '' : 'USDT'}`;
  } else {
    // Stock/ETF: keep bare symbol (TSX .TO, LSE .L, XETRA .DE etc.)
    // resolveExchange() in exchange-registry-browser.js handles detection
    e = v;
  }

  if (!STATE.watchlist.includes(e)) {
    STATE.watchlist.push(e);
    if (!STATE._sessionAdded) STATE._sessionAdded = [];
    if (!STATE._sessionAdded.includes(e)) STATE._sessionAdded.push(e);
    logAlertItem('info', 'Added: ' + e);
    sync();
    if (STATE._newsFetched) fetchNews();
  }
  document.getElementById('newT').value = '';
}

function delT(s) {
  STATE.watchlist       = STATE.watchlist.filter(x => x !== s);
  if (STATE._sessionAdded) STATE._sessionAdded = STATE._sessionAdded.filter(x => x !== s);
  delete STATE.DS[s];
  delete STATE.PH[s];
  delete _lastSyncTime[s];
  if (STATE.currentS === s) { STATE.currentS = null; _renderChartPlaceholder(); }
  render();
}

function wipeData()  { if (confirm('Clear all cached data and reload?')) { localStorage.clear(); location.reload(); } }
function exportWL()  { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify(STATE.watchlist, null, 2)], { type: 'text/plain' })); a.download = 'watchlist.json'; a.click(); }
function importWL(inp) { const r = new FileReader(); r.onload = () => { try { STATE.watchlist = JSON.parse(r.result); sync(); } catch { alert('Invalid file.'); } }; r.readAsText(inp.files[0]); }

// ── NEWS ──
function toggleNews() {
  STATE.newsOpen = !STATE.newsOpen;
  const body = document.getElementById('bnews-body');
  const chev = document.getElementById('news-chevron');
  if (body) body.classList.toggle('hide', !STATE.newsOpen);
  if (chev) chev.textContent = STATE.newsOpen ? '▲ COLLAPSE' : '▼ EXPAND';
  if (STATE.newsOpen && !STATE._newsFetched && !window.NEWS_PAUSED) {
    STATE._newsFetched = true;
    fetchNews();
    setInterval(fetchNewsIfActive, 300_000);
  }
  if (STATE.newsOpen && typeof applyMobileNewsFilter === 'function')
    setTimeout(applyMobileNewsFilter, 50);
}

function buildMarketFeeds() {
  const stockSyms   = (STATE.watchlist || []).filter(s => !s.includes('BINANCE:')).slice(0, 8);
  const tsxAnchors  = ['XIU.TO', 'ENB.TO', 'RY.TO', 'TD.TO', 'SU.TO'];
  const tsxSyms     = [...new Set([...stockSyms, ...tsxAnchors])].slice(0, 10);
  const tsxParam    = tsxSyms.map(s => encodeURIComponent(s)).join(',');
  return [
    { tag: 'CRYPTO', json: true,
      url: 'https://api.rss2json.com/v1/api.json?rss_url=https://coindesk.com/arc/outboundfeeds/rss/',
      parse: d => (d.items || []).slice(0, 15).map(p => ({
        title: p.title, url: p.link, source: 'CoinDesk', tag: 'CRYPTO',
        time: (() => { try { return new Date(p.pubDate).toLocaleTimeString(); } catch { return ''; } })(),
        ts:   (() => { try { return new Date(p.pubDate).getTime();            } catch { return 0; } })(),
        sent: 'neutral',
      })),
    },
    { tag: 'ENERGY',    rss: true, limit: 10, keywords: ['oil','gas','energy','crude','opec','lng','brent','wti','barrel','refin'], url: 'https://finance.yahoo.com/rss/headline?s=USO,XLE,CL%3DF,NG%3DF' },
    { tag: 'METAL',     rss: true, limit: 10, keywords: [],                                                                         url: 'https://finance.yahoo.com/rss/headline?s=GLD,SLV,GDX,COPPER' },
    { tag: 'COMMODITY', rss: true, limit: 8,  keywords: ['wheat','corn','soy','coffee','sugar','cotton','grain','cattle','hog','farm'], url: 'https://finance.yahoo.com/rss/headline?s=WEAT,CORN,SOYB,DBA' },
    { tag: 'TECH',      rss: true, limit: 10, keywords: ['tech','ai','chip','semiconductor','nvidia','apple','microsoft','google','cloud','software'], url: 'https://finance.yahoo.com/rss/headline?s=QQQ,NVDA,AAPL,MSFT,SMH' },
    { tag: 'TSX',       rss: true, limit: 12, keywords: ['tsx','canada','canadian','bay street','bank of canada','loonie','cad','toronto','cnq','shop'], url: `https://finance.yahoo.com/rss/headline?s=${tsxParam}` },
    { tag: 'FX',        rss: true, limit: 10, keywords: ['cad','usd','dollar','loonie','dxy','forex','fx','currency','exchange rate','bank of canada','federal reserve','rate','inflation'], url: 'https://finance.yahoo.com/rss/headline?s=CADUSD%3DX,DX-Y.NYB,FXC,UUP' },
  ];
}

function parseRssItems(xmlText, tag, keywords, limit) {
  try {
    const parser = new DOMParser();
    const doc    = parser.parseFromString(xmlText, 'text/xml');
    const items  = [...doc.querySelectorAll('item')];
    if (!items.length) return [];
    const kw      = keywords || [];
    const matched = kw.length ? items.filter(it => { const t = (it.querySelector('title')?.textContent || '').toLowerCase(); return kw.some(k => t.includes(k)); }) : items;
    return (matched.length ? matched : items).slice(0, limit || 8).map(it => {
      const clean = s => (s || '').replace(/^\s*<!\[CDATA\[/, '').replace(/\]\]>\s*$/, '').trim();
      let url = '#';
      try { const linkEl = it.querySelector('link'); if (linkEl) url = linkEl.textContent.trim() || '#'; } catch {}
      return {
        title: clean(it.querySelector('title')?.textContent), url: url || '#',
        source: clean(it.querySelector('source')?.textContent) || tag, tag,
        time: (() => { try { return new Date(it.querySelector('pubDate')?.textContent).toLocaleTimeString(); } catch { return ''; } })(),
        ts:   (() => { try { return new Date(it.querySelector('pubDate')?.textContent).getTime();            } catch { return 0; } })(),
        sent: 'neutral',
      };
    }).filter(x => x.title.length > 5);
  } catch { return []; }
}

const delay = ms => new Promise(r => setTimeout(r, ms));

async function fetchNews() {
  const allItems    = [];
  const MARKET_FEEDS = buildMarketFeeds();
  for (let fi = 0; fi < MARKET_FEEDS.length; fi++) {
    if (fi > 0) await delay(400);
    const feed = MARKET_FEEDS[fi];
    let feedItems = [];
    try {
      if (feed.parse) {
        feedItems = feed.parse(await fetchProxy(feed.url));
      } else {
        let xml = null;
        for (const purl of [`https://api.allorigins.win/get?url=${encodeURIComponent(feed.url)}`, `https://corsproxy.io/?${encodeURIComponent(feed.url)}`]) {
          try { const r = await fetch(purl, { signal: AbortSignal.timeout(9000) }); if (!r.ok) continue; const txt = await r.text(); try { xml = JSON.parse(txt).contents ?? txt; } catch { xml = txt; } break; } catch {}
        }
        if (xml) feedItems = parseRssItems(xml, feed.tag, feed.keywords, feed.limit);
      }
      if (feedItems.length) { STATE.newsCache[feed.tag] = feedItems; allItems.push(...feedItems); }
      else throw new Error('empty');
    } catch {
      const cached = STATE.newsCache[feed.tag];
      if (cached?.length) { const now = new Date().toLocaleTimeString(); allItems.push(...cached.map(it => ({ ...it, time: `[cached] ${now}` }))); }
    }
  }
  const byTag = {};
  for (const item of allItems) { if (!byTag[item.tag]) byTag[item.tag] = []; byTag[item.tag].push(item); }
  const interleaved = []; const tags = Object.keys(byTag); let i = 0;
  while (interleaved.length < 60) {
    let added = false;
    for (const tag of tags) { if (byTag[tag][i]) { interleaved.push(byTag[tag][i]); added = true; } }
    i++; if (!added) break;
  }
  STATE.newsItems = interleaved.length > 0 ? interleaved : mockNews();
  renderNews(); updateTicker();
  if (typeof renderLeaderboard === 'function') renderLeaderboard();
}

function mockNews() {
  return [
    { title: 'Bitcoin consolidates near key support after weekend rally',     url: '#', source: 'CoinDesk',    time: '12:04', sent: 'bullish' },
    { title: 'Ethereum ETF sees record inflows amid institutional demand',    url: '#', source: 'Bloomberg',   time: '11:47', sent: 'bullish' },
    { title: 'Fed signals higher-for-longer rates, crypto pulls back',        url: '#', source: 'Reuters',     time: '11:22', sent: 'bearish' },
    { title: 'Solana DeFi TVL surpasses $8B amid network upgrades',          url: '#', source: 'Blockworks',  time: '10:58', sent: 'bullish' },
    { title: 'SEC eyes DeFi protocols as regulatory pressure mounts',        url: '#', source: 'Decrypt',     time: '10:30', sent: 'bearish' },
    { title: 'TSX energy sector outperforms on crude oil rebound',           url: '#', source: 'BNN',         time: '09:55', sent: 'bullish' },
    { title: 'Whale wallets accumulate XMR as privacy demand rises',         url: '#', source: 'Glassnode',   time: '09:20', sent: 'neutral' },
    { title: 'Altcoin season index hits 68 — BTC rotation accelerating',     url: '#', source: 'CryptoPanic', time: '08:45', sent: 'bullish' },
  ];
}

function toggleWatchlist() {
  STATE.wlOpen = !STATE.wlOpen;
  const body = document.getElementById('wl-body');
  const chev = document.getElementById('wl-chevron');
  if (body) body.classList.toggle('hide', !STATE.wlOpen);
  if (chev) chev.textContent = STATE.wlOpen ? '▲' : '▼';
}

function toggleAlerts() {
  STATE.alertsOpen = !STATE.alertsOpen;
  document.getElementById('alert-strip').style.display = STATE.alertsOpen ? 'block' : 'none';
}

window.onload = init;

// ── MARKET STATUS BADGE ──
// Uses registry-backed getMarketSession() for accurate badge per exchange.
// lunch_break (TSE/HKEX midday) shows FROZEN — no fresh data during pause.
function marketStatusBadge(sym) {
  if (sym.includes('BINANCE:')) return '';
  const session = typeof getMarketSession !== 'undefined' ? getMarketSession(sym) : 'open';
  if (session === 'open' || session === '24/7') return '';
  if (session === 'pre_market')  return '<span class="mkt-badge prepost" title="Pre-market — light volume, excluded from leaderboard">🌅 PRE MKT</span>';
  if (session === 'after_hours') return '<span class="mkt-badge prepost" title="After-hours — excluded from leaderboard">🌙 AH</span>';
  if (session === 'lunch_break') return '<span class="mkt-badge closed"  title="Lunch break — exchange paused (TSE/HKEX)">⏸ LUNCH</span>';
  return '<span class="mkt-badge closed" title="Market closed — displaying last close price">🔒 FROZEN</span>';
}

// ── MOBILE HELPERS ──
const isMobile = () => window.innerWidth <= 768;

function applyMobileNewsFilter() {
  if (!isMobile()) return;
  const wrap = document.querySelector('.nf-cols-wrap');
  if (!wrap) return;
  const cols       = [...wrap.querySelectorAll('.nf-col')];
  const visibleTags = COL_ORDER.filter(t => !STATE.collapsedCols[t]);
  const activeTag  = STATE.mobileNewsTag || visibleTags[0] || 'ALL';
  if (activeTag === 'ALL') { wrap.classList.add('show-all'); cols.forEach(c => c.classList.remove('mobile-active')); }
  else { wrap.classList.remove('show-all'); cols.forEach((c, i) => c.classList.toggle('mobile-active', visibleTags[i] === activeTag)); }
  document.querySelectorAll('#news-tag-bar .nf-pill').forEach(btn => {
    const m = btn.getAttribute('onclick')?.match(/'([A-Z]+)'/);
    if (m) btn.classList.toggle('active', m[1] === activeTag);
  });
}

window.mobilePillClick = function(tag) {
  if (!isMobile()) { toggleNewsCol(tag); return; }
  STATE.mobileNewsTag = (STATE.mobileNewsTag === tag) ? 'ALL' : tag;
  applyMobileNewsFilter();
};

function renderLeaderboardDots() {
  if (!isMobile()) return;
  const body = document.querySelector('.hcl-body');
  if (!body) return;
  const old = document.getElementById('hcl-dots');
  if (old) old.remove();
  const cards = body.querySelectorAll('.hcl-card');
  if (cards.length <= 1) return;
  const dots = document.createElement('div');
  dots.id = 'hcl-dots';
  dots.style.cssText = 'display:flex;justify-content:center;align-items:center;gap:6px;padding:5px 0 4px;background:var(--bg);border-bottom:1px solid var(--border);';
  cards.forEach((_, i) => {
    const d = document.createElement('span');
    d.dataset.idx = i;
    d.style.cssText = `display:inline-block;width:${i===0?8:6}px;height:${i===0?8:6}px;border-radius:50%;background:${i===0?'var(--accent)':'var(--border2)'};transition:.2s;cursor:pointer;`;
    d.onclick = () => body.scrollTo({ left: i * body.clientWidth, behavior: 'smooth' });
    dots.appendChild(d);
  });
  body.parentNode.insertBefore(dots, body.nextSibling);
  body.addEventListener('scroll', () => {
    const idx = Math.round(body.scrollLeft / Math.max(body.clientWidth, 1));
    dots.querySelectorAll('span').forEach((d, i) => {
      d.style.background = i === idx ? 'var(--accent)' : 'var(--border2)';
      d.style.width = d.style.height = i === idx ? '8px' : '6px';
    });
  }, { passive: true });
}

document.addEventListener('DOMContentLoaded', () => {});
window.addEventListener('resize', () => { applyMobileNewsFilter(); renderLeaderboardDots(); }, { passive: true });
