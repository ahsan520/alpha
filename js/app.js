// ══════════════════════════════════════════════
// app.js — v12.9.3 — init, sync loop, nav, misc UI
// Changes from v12.9.1:
//   • syncOne() Phase 1 for delisted pairs (XMR): goes directly to Kraken
//     ticker instead of routing through batchCrypto. Root cause of XMR never
//     appearing on leaderboard: batchCrypto's internal Kraken fallback was
//     unreachable when Binance returned CORS/451, leaving pd=undefined →
//     syncOne returned false → STATE.DS[XMR] never populated → leaderboard
//     had nothing to score. Direct Kraken call in Phase 1 fixes this.
//   • render.js: pumpLimit raised to 12%/20% so big movers (XMR +24%) are
//     not silently ejected by the ingestion gate — scoring already penalises
//     extended moves, we don't need a hard gate below 12%.
//   • render.js: strong-mover fast-track (>8% chg24 + CVD up) bypasses
//     persistence debounce so these appear immediately on first qualifying refresh.
// ══════════════════════════════════════════════

// ── DEFAULT WATCHLIST (fallback if watchlist.json cannot be fetched) ──
const DEFAULT_WATCHLIST = ["ETHY.TO","KILO.TO","GE.TO","XRPP.TO","ETHH.TO","SVR.TO","XBM.TO","XEG.TO","T.TO","CGL.TO","GLCC.TO","ENCC.TO","TXF.TO","HTAE.TO","QMAX.TO"];

// ══════════════════════════════════════════════
// MARKET HOURS ENGINE
// Determines whether a symbol's exchange is currently open,
// closed, or in pre/post market. All times compared in ET.
// ══════════════════════════════════════════════

// Returns the current wall-clock time as {h, m, dow} in US Eastern Time.
// dow: 0=Sun, 1=Mon … 6=Sat
function nowET() {
  const now = new Date();
  // toLocaleString with timeZone gives us a string we can parse back
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: 'numeric', minute: 'numeric',
    weekday: 'short', hour12: false,
  }).formatToParts(now);
  const get = t => parseInt(parts.find(p => p.type === t)?.value ?? '0', 10);
  const dowStr = parts.find(p => p.type === 'weekday')?.value ?? 'Mon';
  const dowMap = { Sun:0, Mon:1, Tue:2, Wed:3, Thu:4, Fri:5, Sat:6 };
  return { h: get('hour'), m: get('minute'), dow: dowMap[dowStr] ?? 1 };
}

// Returns market status for a given symbol:
//   'open'       → live session, include in leaderboard
//   'prepost'    → extended hours 04:00–09:30 / 16:00–20:00 ET, sync but freeze LB
//   'closed'     → weekend or outside all hours, exclude from LB, sync at 60s
function marketStatus(sym) {
  if (sym.includes('BINANCE:')) return 'open'; // crypto: 24/7

  const { h, m, dow } = nowET();
  const mins = h * 60 + m; // minutes since midnight ET

  // Weekend → fully closed for all equities
  if (dow === 0 || dow === 6) return 'closed';

  // NYSE/NASDAQ + TSX share the same core session hours: 09:30–16:00 ET
  const OPEN_MINS  =  9 * 60 + 30;  // 09:30
  const CLOSE_MINS = 16 * 60;        // 16:00
  // Extended hours window (US only): 04:00–09:30 and 16:00–20:00
  const PRE_START  =  4 * 60;        // 04:00
  const POST_END   = 20 * 60;        // 20:00

  if (mins >= OPEN_MINS && mins < CLOSE_MINS) return 'open';

  // TSX has no meaningful pre/post market — treat as closed outside core hours
  if (sym.endsWith('.TO')) return 'closed';

  // US equities: pre/post window
  if ((mins >= PRE_START && mins < OPEN_MINS) || (mins >= CLOSE_MINS && mins < POST_END)) return 'prepost';

  return 'closed';
}

// Convenience: returns true when the symbol is eligible for leaderboard scoring
function isLeaderboardEligible(sym) {
  return marketStatus(sym) === 'open'; // only live session qualifies
}

// Returns sync interval ms for a symbol based on its market status.
// Infinity means the adaptive tick will never queue it — no wasted calls.
function syncIntervalFor(sym) {
  if (sym.includes('BINANCE:')) return 15_000; // crypto: always live
  const s = marketStatus(sym);
  if (s === 'open')    return 15_000;   // live session
  if (s === 'prepost') return 60_000;   // extended hours, light polling
  return Infinity;                       // closed — skip entirely, serve cache
}

// ── INIT ──
// ── PAUSE / PLAY state for market bar + news ──
// Default: PAUSED — only table and leaderboard load on boot.
// User clicks ▶ to start fetching index/sector/macro/crypto/news.
window.MPULSE_PAUSED = true;
window.NEWS_PAUSED   = true;

function toggleMpulsePause() {
  window.MPULSE_PAUSED = !window.MPULSE_PAUSED;
  const btn = document.getElementById('mpulse-pause-btn');
  if (btn) btn.textContent = window.MPULSE_PAUSED ? '▶' : '⏸';
  if (!window.MPULSE_PAUSED) fetchMarketPulse(); // immediate fetch on resume
}

function toggleNewsPause() {
  window.NEWS_PAUSED = !window.NEWS_PAUSED;
  const btn = document.getElementById('news-pause-btn');
  if (btn) btn.textContent = window.NEWS_PAUSED ? '▶' : '⏸';
  if (!window.NEWS_PAUSED && !STATE._newsFetched) {
    STATE._newsFetched = true;
    fetchNews();
  } else if (!window.NEWS_PAUSED) {
    fetchNews();
  }
}

// Guarded wrappers — silently skip when paused
function fetchMarketPulseIfActive() {
  if (!window.MPULSE_PAUSED) fetchMarketPulse();
}
function fetchNewsIfActive() {
  if (!window.NEWS_PAUSED && STATE.newsOpen) fetchNews();
}

async function init() {
  // v12.4: news starts collapsed — no data fetched until tab is opened
  STATE.newsOpen = false;
  STATE._newsFetched = false; // lazy flag: fetch only on first open
  STATE.alertsOpen = false;
  STATE.activeNewsTag = 'ALL';
  STATE.collapsedCols = {};

  // ── Watchlist source of truth ──
  // ONLY two valid sources:
  //   1. watchlist.json (fetched from server)
  //   2. Tickers added in THIS tab's session via the GUI (STATE._sessionAdded)
  //
  // a49_wl_added (localStorage) is intentionally NOT read here.
  let base = DEFAULT_WATCHLIST;
  try {
    const r = await fetch('watchlist.json');
    if (r.ok) base = await r.json();
  } catch {}

  if (!STATE._sessionAdded) STATE._sessionAdded = [];
  const merged = [...base, ...STATE._sessionAdded.filter(s => !base.includes(s))];
  STATE.watchlist = merged;

  // v12.4: NO symbol pre-selected on load — TradingView iframe deferred
  // until the user clicks a symbol. currentS starts null.
  STATE.currentS = null;

  // Initialise alert-filter state AFTER base watchlist is known
  initAlertFilterState();
  STATE._baseWatchlist = [...base];

  // Render the watchlist sidebar immediately (names only — no price yet)
  renderWL();

  // Render the table shell (rows with SYNC placeholders, no sparklines yet)
  renderTable();

  // Show the "click a symbol to load chart" placeholder in the TV panel
  _renderChartPlaceholder();

  fetchGlobal();
  fetchFG();
  // Market pulse + news start PAUSED — user clicks ▶ to activate
  // fetchMarketPulse() intentionally NOT called here (paused by default)

  // Start the sync engine
  sync();
  _startAdaptiveSyncLoop();

  setInterval(fetchFG, 300_000);
  setInterval(fetchGlobal, 60_000);
  setInterval(fetchMarketPulseIfActive, 300_000);

  // ── Independent UI refresh timers ────────────────────────────────────────
  // These run completely separately from the data sync loop.
  // The sync loop only patches individual table cells (patchSymbolRow).
  // WL sidebar prices update every 30s — cheap, just text nodes.
  setInterval(renderWL, 30_000);
  // Leaderboard re-scores every 60s — uses its fingerprint diff so it only
  // rebuilds cards when the ranked set actually changes.
  setInterval(scheduleLeaderboard, 60_000);

  renderJournal();
  initAlertCfg();
  renderAlertCfgPage();
  updateLastUpdBar();
}

// ── CHART PLACEHOLDER — shown until user clicks a symbol ──
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
// Replaces the fixed setInterval(sync,15000). Runs a rolling timer that
// re-syncs all symbols, but uses per-symbol market-hours-aware intervals
// to decide whether each symbol actually needs a fetch this cycle.
// Closed-market symbols are only hit at most every 60s regardless of how
// fast the global loop fires.
let _syncRunning = false;
let _lastSyncTime = {}; // sym → timestamp of last successful syncOne call

function _startAdaptiveSyncLoop() {
  // Master tick: every 15s check which symbols need a refresh
  setInterval(_adaptiveTick, 15_000);
}

async function _adaptiveTick() {
  if (_syncRunning) return; // guard: don't overlap
  _syncRunning = true;

  const now = Date.now();
  const toSync = STATE.watchlist.filter(s => {
    const interval = syncIntervalFor(s);
    const last = _lastSyncTime[s] || 0;
    return (now - last) >= interval;
  });

  if (!toSync.length) { _syncRunning = false; return; }

  document.getElementById('sstatus').textContent = 'SYNCING';
  document.getElementById('sdot').style.background = 'var(--gold)';

  let ok = 0, fail = 0;
  const STAGGER_MS = 100; // reduced from 300ms — 15 symbols now complete in ~1.5s not 4.5s

  for (const s of toSync) {
    const success = await syncOne(s);
    _lastSyncTime[s] = Date.now();
    if (success) ok++; else fail++;
    // Touch only the one row that just updated — no table-wide repaint
    patchSymbolRow(s);
    await new Promise(r => setTimeout(r, STAGGER_MS));
  }

  localStorage.setItem('a49_ds', JSON.stringify(STATE.DS));
  localStorage.setItem('a49_ph', JSON.stringify(STATE.PH));
  await flushDigest();
  // Status bar update only — WL sidebar and leaderboard run on their own slow timers
  updateLastUpdBar();

  document.getElementById('sstatus').textContent = fail > 0 ? `LIVE (${fail} ERR)` : 'LIVE';
  document.getElementById('sdot').style.background = ok > 0 ? 'var(--bull)' : 'var(--bear)';
  _syncRunning = false;
}

// ── SINGLE SYMBOL FETCH — v12.9.1 two-phase load + market-hours gate ──
// Crypto (BINANCE:*): always fetches — 24/7, no gate.
// Stocks/ETFs (TSX + US):
//   open    → Phase 1 price immediately, Phase 2 extras async (same as v12.9)
//   prepost → same flow but row badge shows EXT HRS
//   closed  → NO network call; cached DS data served as-is; row shows FROZEN badge.
//             Returns true so the caller counts it as a non-error.
async function syncOne(s, { forceRefresh = false } = {}) {
  const isCrypto = s.includes('BINANCE:');

  // ── Market-hours gate (stocks/ETFs only) ──
  if (!isCrypto && !forceRefresh) {
    const status = marketStatus(s);
    if (status === 'closed') {
      // Serve cached data — patch row so FROZEN badge & dim are applied
      if (typeof patchSymbolRow === 'function') patchSymbolRow(s);
      return true; // not an error — just frozen
    }
  }

  try {
    if (isCrypto) {
      const pair = s.split(':')[1];
      const isDelisted = BINANCE_DELISTED.has(pair);

      // ── Phase 1: price only ──
      // v12.9.3: delisted pairs (e.g. XMR) go straight to Kraken for Phase 1
      // price — batchCrypto's internal Kraken fallback was unreachable when
      // the Binance fetch returned a CORS/451 error (common from browser),
      // leaving pd=undefined and causing syncOne to return false, which meant
      // XMR never entered STATE.DS and never appeared on the leaderboard.
      let pd;
      if (isDelisted) {
        // Direct Kraken ticker — fast, single call, no Binance dependency
        try {
          const kPair = KRAKEN_PAIR[pair];
          if (kPair) {
            const url = `https://api.kraken.com/0/public/Ticker?pair=${kPair}`;
            let d = null;
            try { const r = await fetch(url, { signal: AbortSignal.timeout(8000) }); if (r.ok) d = await r.json(); } catch {}
            if (!d) d = await fetchProxy(url);
            const key = Object.keys(d?.result || {})[0];
            if (key) {
              const t = d.result[key];
              const last = parseFloat(t.c[0]);
              const open = parseFloat(t.o);
              const chg  = open > 0 ? parseFloat(((last - open) / open * 100).toFixed(2)) : 0;
              pd = { p: last, chg };
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

      // Render the row immediately with whatever data we have (extras = {})
      processAI(s, pd.p, pd.chg, {});
      if (typeof patchSymbolRow === 'function') patchSymbolRow(s);

      // ── Phase 2: extras — fire-and-forget, patches the row when done ──
      const extraFetch = isDelisted
        ? fetchKrakenExtra(pair).catch(() => ({}))
        : fetchCryptoExtra(pair).catch(() => ({}));

      extraFetch.then(extra => {
        if (!extra) return;
        processAI(s, pd.p, pd.chg, extra);
        if (typeof patchSymbolRow === 'function') patchSymbolRow(s);
        // Persist after extras land so kDay / sparkBars are included
        try {
          localStorage.setItem('a49_ds', JSON.stringify(STATE.DS));
          localStorage.setItem('a49_ph', JSON.stringify(STATE.PH));
        } catch {}
      });

    } else {
      // ── Stocks: price + extras parallel, only runs when open/prepost ──
      const [{ p, chg: rawChg }, stockExtra] = await Promise.all([
        fetchStock(s),
        fetchStockExtra(s).catch(() => ({})),
      ]);
      const chg1d = stockExtra?.kDay?.chg1d;
      const chg = (chg1d != null && Math.abs(rawChg) > 15 && Math.abs(chg1d) < Math.abs(rawChg))
        ? chg1d : rawChg;
      if (!STATE.PH[s]) STATE.PH[s] = [];
      STATE.PH[s].push(p);
      if (STATE.PH[s].length > 200) STATE.PH[s].shift();
      processAI(s, p, chg, stockExtra);
    }
    return true;
  } catch {
    return false;
  }
}

// ── FULL SYNC (manual / on-demand) ──
// Kept for compatibility with addTicker(), importWL(), etc.
// Forces a full pass over the entire watchlist ignoring the adaptive timer.
async function sync() {
  document.getElementById('sstatus').textContent = 'SYNCING';
  document.getElementById('sdot').style.background = 'var(--gold)';

  let ok = 0, fail = 0;
  const STAGGER_MS = 100; // reduced — faster initial table population

  for (const s of STATE.watchlist) {
    const success = await syncOne(s);
    _lastSyncTime[s] = Date.now(); // reset per-symbol timer after forced sync
    if (success) ok++; else fail++;
    // Patch only this symbol's row — no table-wide repaint mid-loop
    if (typeof patchSymbolRow === 'function') patchSymbolRow(s);
    await new Promise(r => setTimeout(r, STAGGER_MS));
  }

  localStorage.setItem('a49_ds', JSON.stringify(STATE.DS));
  localStorage.setItem('a49_ph', JSON.stringify(STATE.PH));
  await flushDigest();
  updateLastUpdBar();

  document.getElementById('sstatus').textContent = fail > 0 ? `LIVE (${fail} ERR)` : 'LIVE';
  document.getElementById('sdot').style.background = ok > 0 ? 'var(--bull)' : 'var(--bear)';
}

// ── PER-ROW REFRESH — called from the refresh button on each table row ──
// Passes forceRefresh:true so the user can manually fetch even when closed.
// When the market is closed for a stock, button shows "(CLOSED)" label — the user
// can still click it to force a network call if they believe the market just opened.
async function refreshSymbol(s, btnEl) {
  const isCrypto = s.includes('BINANCE:');
  const closed = !isCrypto && marketStatus(s) === 'closed';
  if (btnEl) {
    btnEl.textContent = closed ? '⟳' : '⟳';
    btnEl.style.opacity = '0.4';
    btnEl.disabled = true;
  }
  const ok = await syncOne(s, { forceRefresh: true });
  _lastSyncTime[s] = Date.now();
  if (btnEl) {
    btnEl.textContent = closed ? '🔒' : '↺';
    btnEl.title = closed ? 'Market closed — showing last close price' : '';
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

// ── TAB NAVIGATION ──
function switchTab(tab, btn) {
  document.querySelectorAll('.tc').forEach(el => el.classList.remove('on'));
  document.querySelectorAll('.tab').forEach(b => b.classList.remove('on'));
  document.getElementById('tab-' + tab).classList.add('on');
  btn.classList.add('on');
  if (tab === 'alerts') renderAlertCfgPage();
  if (tab === 'watchlist-mgr') renderWatchlistManager();
}

// ── SORT ──
function sortBy(k) {
  STATE.sortD = STATE.sortK === k ? STATE.sortD * -1 : -1;
  STATE.sortK = k;
  document.querySelectorAll('table.mx thead th').forEach(th => th.classList.remove('srt'));
  renderTable();
}

// ── CHART SWITCH ──
// v12.4: TradingView widget is NOT created on init. It is created lazily here
// when the user first clicks a symbol. Subsequent clicks swap the symbol.
function switchT(s) {
  const prev = STATE.currentS;
  STATE.currentS = s;
  const tv = s.endsWith('.TO') ? 'TSX:' + s.replace('.TO', '') : s;

  // Clear placeholder HTML if this is the very first symbol click
  const cont = document.getElementById('tv_chart');
  if (cont && cont.querySelector('div[style*="Click any symbol"]')) {
    cont.innerHTML = '';
  }

  if (STATE.tvW) { try { STATE.tvW.remove(); } catch {} }
  STATE.tvW = new TradingView.widget({
    autosize: true, symbol: tv, interval: '30', theme: 'dark',
    container_id: 'tv_chart', allow_symbol_change: true, style: '1',
    toolbar_bg: '#0d1117',
    overrides: {
      'paneProperties.background': '#080a0d',
      'paneProperties.vertGridProperties.color': '#1e2530',
      'paneProperties.horzGridProperties.color': '#1e2530'
    }
  });
  renderWL();
  // Refresh news feed so TSX feed URL reflects the newly selected symbol
  if (s !== prev && STATE._newsFetched) fetchNews();
}

// ── WATCHLIST MANAGEMENT ──
function addTicker() {
  let v = document.getElementById('newT').value.toUpperCase().trim();
  const t = document.getElementById('assetType').value;
  if (!v) return;
  const e = (t === 'crypto' && !v.includes('BINANCE:')) ? `BINANCE:${v}${v.includes('USDT') ? '' : 'USDT'}` : v;
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
  STATE.watchlist = STATE.watchlist.filter(x => x !== s);
  if (STATE._sessionAdded) STATE._sessionAdded = STATE._sessionAdded.filter(x => x !== s);
  delete STATE.DS[s];
  delete STATE.PH[s];
  delete _lastSyncTime[s];
  if (STATE.currentS === s) {
    // Deselect: go back to placeholder rather than auto-picking next symbol
    STATE.currentS = null;
    _renderChartPlaceholder();
  }
  render();
}

function wipeData() {
  if (confirm('Clear all cached data and reload?')) { localStorage.clear(); location.reload(); }
}

function exportWL() {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(STATE.watchlist, null, 2)], { type: 'text/plain' }));
  a.download = 'watchlist.json';
  a.click();
}

function importWL(inp) {
  const r = new FileReader();
  r.onload = () => { try { STATE.watchlist = JSON.parse(r.result); sync(); } catch { alert('Invalid file.'); } };
  r.readAsText(inp.files[0]);
}

// ══════════════════════════════════════════════
// NEWS UI
// v12.4: news is lazy — data is NOT fetched until the panel is first opened.
// ══════════════════════════════════════════════

function toggleNews() {
  STATE.newsOpen = !STATE.newsOpen;
  const body = document.getElementById('bnews-body');
  const chev = document.getElementById('news-chevron');
  if (body) body.classList.toggle('hide', !STATE.newsOpen);
  if (chev) chev.textContent = STATE.newsOpen ? '▲ COLLAPSE' : '▼ EXPAND';

  // v12.4 lazy load: fetch news only on first open AND not paused
  if (STATE.newsOpen && !STATE._newsFetched && !window.NEWS_PAUSED) {
    STATE._newsFetched = true;
    fetchNews();
    setInterval(fetchNewsIfActive, 300_000);
  }
  // Explicit layout call — no MutationObserver needed
  if (STATE.newsOpen && typeof applyMobileNewsFilter === 'function')
    setTimeout(applyMobileNewsFilter, 50);
}

// ── Market feed categories ──
function buildMarketFeeds() {
  const stockSyms = (STATE.watchlist || [])
    .filter(s => !s.includes('BINANCE:'))
    .slice(0, 8);
  const tsxAnchors = ['XIU.TO', 'ENB.TO', 'RY.TO', 'TD.TO', 'SU.TO'];
  const tsxSyms = [...new Set([...stockSyms, ...tsxAnchors])].slice(0, 10);
  const tsxParam = tsxSyms.map(s => encodeURIComponent(s)).join(',');

  return [
    { tag: 'CRYPTO', json: true,
      url: 'https://api.rss2json.com/v1/api.json?rss_url=https://coindesk.com/arc/outboundfeeds/rss/',
      parse: d => (d.items || []).slice(0, 15).map(p => ({
        title: p.title, url: p.link, source: 'CoinDesk', tag: 'CRYPTO',
        time: (() => { try { return new Date(p.pubDate).toLocaleTimeString(); } catch { return ''; } })(),
        ts:   (() => { try { return new Date(p.pubDate).getTime(); } catch { return 0; } })(),
        sent: 'neutral'
      }))
    },
    { tag: 'ENERGY', rss: true, limit: 10, keywords: ['oil','gas','energy','crude','opec','lng','brent','wti','barrel','refin'],
      url: 'https://finance.yahoo.com/rss/headline?s=USO,XLE,CL%3DF,NG%3DF'
    },
    { tag: 'METAL', rss: true, limit: 10, keywords: [],
      url: 'https://finance.yahoo.com/rss/headline?s=GLD,SLV,GDX,COPPER'
    },
    { tag: 'COMMODITY', rss: true, limit: 8, keywords: ['wheat','corn','soy','coffee','sugar','cotton','grain','cattle','hog','farm'],
      url: 'https://finance.yahoo.com/rss/headline?s=WEAT,CORN,SOYB,DBA'
    },
    { tag: 'TECH', rss: true, limit: 10, keywords: ['tech','ai','chip','semiconductor','nvidia','apple','microsoft','google','cloud','software','data'],
      url: 'https://finance.yahoo.com/rss/headline?s=QQQ,NVDA,AAPL,MSFT,SMH'
    },
    { tag: 'TSX', rss: true, limit: 12, keywords: ['tsx','canada','canadian','bay street','bank of canada','loonie','cad','toronto','cnq','shop'],
      url: `https://finance.yahoo.com/rss/headline?s=${tsxParam}`
    },
    { tag: 'FX', rss: true, limit: 10, keywords: ['cad','usd','dollar','loonie','dxy','forex','fx','currency','exchange rate','bank of canada','federal reserve','rate','inflation','boc','fed'],
      url: 'https://finance.yahoo.com/rss/headline?s=CADUSD%3DX,DX-Y.NYB,FXC,UUP'
    },
  ];
}

function parseRssItems(xmlText, tag, keywords, limit) {
  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(xmlText, 'text/xml');
    const items = [...doc.querySelectorAll('item')];
    if (!items.length) return [];
    const kw = keywords || [];
    const matched = kw.length
      ? items.filter(it => {
          const t = (it.querySelector('title')?.textContent || '').toLowerCase();
          const desc = (it.querySelector('description')?.textContent || '').toLowerCase();
          return kw.some(k => t.includes(k) || desc.includes(k));
        })
      : items;
    const pool = matched.length ? matched : items;
    return pool.slice(0, limit || 8).map(it => {
      const clean = s => (s || '').replace(/^\s*<!\[CDATA\[/, '').replace(/\]\]>\s*$/, '').trim();
      let url = '#';
      try {
        const linkEl = it.querySelector('link');
        if (linkEl) url = linkEl.textContent.trim() || linkEl.getAttribute('href') || '#';
        if (!url || url === '#') {
          const nodes = [...it.childNodes];
          const li = nodes.findIndex(n => n.nodeName === 'link');
          if (li >= 0 && nodes[li + 1]?.nodeType === 3) url = nodes[li + 1].textContent.trim();
        }
      } catch {}
      return {
        title: clean(it.querySelector('title')?.textContent),
        url: url || '#',
        source: clean(it.querySelector('source')?.textContent) || tag,
        tag,
        time: (() => { try { return new Date(it.querySelector('pubDate')?.textContent).toLocaleTimeString(); } catch { return ''; } })(),
        ts:   (() => { try { return new Date(it.querySelector('pubDate')?.textContent).getTime(); } catch { return 0; } })(),
        sent: 'neutral',
      };
    }).filter(x => x.title.length > 5);
  } catch { return []; }
}

const delay = ms => new Promise(r => setTimeout(r, ms));

async function fetchNews() {
  const allItems = [];
  const MARKET_FEEDS = buildMarketFeeds();

  for (let fi = 0; fi < MARKET_FEEDS.length; fi++) {
    if (fi > 0) await delay(400);
    const feed = MARKET_FEEDS[fi];
    let feedItems = [];
    try {
      if (feed.parse) {
        const d = await fetchProxy(feed.url);
        feedItems = feed.parse(d);
      } else {
        let xml = null;
        const proxies = [
          `https://api.allorigins.win/get?url=${encodeURIComponent(feed.url)}`,
          `https://corsproxy.io/?${encodeURIComponent(feed.url)}`,
        ];
        for (const purl of proxies) {
          try {
            const r = await fetch(purl, { signal: AbortSignal.timeout(9000) });
            if (!r.ok) continue;
            const txt = await r.text();
            try { const j = JSON.parse(txt); xml = j.contents || txt; break; }
            catch { xml = txt; break; }
          } catch {}
        }
        if (xml) feedItems = parseRssItems(xml, feed.tag, feed.keywords, feed.limit);
      }
      if (feedItems.length) {
        STATE.newsCache[feed.tag] = feedItems;
        allItems.push(...feedItems);
      } else {
        throw new Error('empty');
      }
    } catch {
      const cached = STATE.newsCache[feed.tag];
      if (cached && cached.length) {
        const now = new Date().toLocaleTimeString();
        allItems.push(...cached.map(it => ({ ...it, time: `[cached] ${now}` })));
      }
    }
  }

  const byTag = {};
  for (const item of allItems) {
    if (!byTag[item.tag]) byTag[item.tag] = [];
    byTag[item.tag].push(item);
  }
  const interleaved = [];
  const tags = Object.keys(byTag);
  let i = 0;
  while (interleaved.length < 60) {
    let added = false;
    for (const tag of tags) {
      if (byTag[tag][i]) { interleaved.push(byTag[tag][i]); added = true; }
    }
    i++;
    if (!added) break;
  }

  STATE.newsItems = interleaved.length > 0 ? interleaved : mockNews();
  renderNews();
  updateTicker();
  if (typeof renderLeaderboard === 'function') renderLeaderboard();
}

function mockNews() {
  return [
    { title: 'Bitcoin consolidates near key support after weekend rally', url: '#', source: 'CoinDesk', time: '12:04', sent: 'bullish' },
    { title: 'Ethereum ETF sees record inflows amid institutional demand', url: '#', source: 'Bloomberg', time: '11:47', sent: 'bullish' },
    { title: 'Fed signals higher-for-longer rates, crypto pulls back', url: '#', source: 'Reuters', time: '11:22', sent: 'bearish' },
    { title: 'Solana DeFi TVL surpasses $8B amid network upgrades', url: '#', source: 'Blockworks', time: '10:58', sent: 'bullish' },
    { title: 'SEC eyes DeFi protocols as regulatory pressure mounts', url: '#', source: 'Decrypt', time: '10:30', sent: 'bearish' },
    { title: 'TSX energy sector outperforms on crude oil rebound', url: '#', source: 'BNN Bloomberg', time: '09:55', sent: 'bullish' },
    { title: 'Whale wallets accumulate XMR as privacy demand rises', url: '#', source: 'Glassnode', time: '09:20', sent: 'neutral' },
    { title: 'Altcoin season index hits 68 — BTC rotation accelerating', url: '#', source: 'CryptoPanic', time: '08:45', sent: 'bullish' },
    { title: 'Tether issues $2B USDT as stablecoin demand surges', url: '#', source: 'CoinTelegraph', time: '08:10', sent: 'neutral' },
    { title: 'KILO.TO reports strong earnings, raises guidance', url: '#', source: 'Globe and Mail', time: '07:40', sent: 'bullish' },
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

// ══════════════════════════════════════════════
// MARKET STATUS HELPERS — exposed for render.js
// ══════════════════════════════════════════════

// Returns HTML badge for a symbol's current market status.
// render.js calls this to inject status tags into row headers.
//   open    → no badge (live data)
//   prepost → 🕐 EXT HRS (extended hours, data still updating)
//   closed  → 🔒 FROZEN (market shut, showing last close price — no new fetches)
function marketStatusBadge(sym) {
  if (sym.includes('BINANCE:')) return ''; // crypto is always live
  const s = marketStatus(sym);
  if (s === 'open') return '';
  if (s === 'prepost') return '<span class="mkt-badge prepost" title="Extended hours — data still updating, excluded from leaderboard">🕐 EXT HRS</span>';
  return '<span class="mkt-badge closed" title="Market closed — displaying last close price, no live fetches">🔒 FROZEN</span>';
}

// ══════════════════════════════════════════════
// MOBILE HELPERS
// ══════════════════════════════════════════════

const isMobile = () => window.innerWidth <= 768;

function applyMobileNewsFilter() {
  if (!isMobile()) return;
  const wrap = document.querySelector('.nf-cols-wrap');
  if (!wrap) return;
  const cols = [...wrap.querySelectorAll('.nf-col')];
  const visibleTags = COL_ORDER.filter(t => !STATE.collapsedCols[t]);
  const activeTag = STATE.mobileNewsTag || visibleTags[0] || 'ALL';

  if (activeTag === 'ALL') {
    wrap.classList.add('show-all');
    cols.forEach(c => c.classList.remove('mobile-active'));
  } else {
    wrap.classList.remove('show-all');
    cols.forEach((c, i) => {
      c.classList.toggle('mobile-active', visibleTags[i] === activeTag);
    });
  }

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
      const active = i === idx;
      d.style.background = active ? 'var(--accent)' : 'var(--border2)';
      d.style.width = d.style.height = active ? '8px' : '6px';
    });
  }, { passive: true });
}

document.addEventListener('DOMContentLoaded', () => {
  // v12.5: No MutationObservers on live containers.
  // MutationObserver on hcl-body fired on EVERY cell textContent write,
  // creating a renderLeaderboardDots + applyMobileNewsFilter cascade on mobile.
  // Instead, call these explicitly only after intentional structure changes
  // (news tab open, leaderboard card set changes). See toggleNews() and
  // renderLeaderboard() full-rebuild path for the explicit call sites.
});

window.addEventListener('resize', () => {
  applyMobileNewsFilter();
  renderLeaderboardDots();
}, { passive: true });
