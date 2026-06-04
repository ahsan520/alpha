// ══════════════════════════════════════════════
// app.js — init, sync loop, nav, misc UI actions
// ══════════════════════════════════════════════

// ── DEFAULT WATCHLIST (fallback if watchlist.json cannot be fetched) ──
const DEFAULT_WATCHLIST = ["ETHY.TO","KILO.TO","GE.TO","XRPP.TO","ETHH.TO","SVR.TO","XBM.TO","XEG.TO","T.TO","CGL.TO","GLCC.TO","ENCC.TO","TXF.TO","HTAE.TO","QMAX.TO"];

// ── INIT ──
async function init() {
  // ── Watchlist source of truth ──
  // ONLY two valid sources:
  //   1. watchlist.json (fetched from server)
  //   2. Tickers added in THIS tab's session via the GUI (STATE._sessionAdded)
  //
  // a49_wl_added (localStorage) is intentionally NOT read here.
  // Reading it would pull in tickers added by other open tabs that share the
  // same localStorage origin, causing foreign symbols to appear in this dashboard.
  // GUI additions persist for this session only; to make them permanent, export
  // watchlist.json and commit it.
  let base = DEFAULT_WATCHLIST;
  try {
    const r = await fetch('watchlist.json');
    if (r.ok) base = await r.json();
  } catch {}

  // Session-only additions: tickers the user added via GUI in this tab.
  // Populated by addTicker(); never read from localStorage.
  if (!STATE._sessionAdded) STATE._sessionAdded = [];
  const merged = [...base, ...STATE._sessionAdded.filter(s => !base.includes(s))];
  STATE.watchlist = merged;
  STATE.currentS = STATE.watchlist[0];

  // DS/PH: no cross-tab bleed — STATE.DS/PH start empty (see config.js).
  // We intentionally do NOT restore them from localStorage on init so stale
  // data from other tabs never pre-populates this tab's table.

  // Initialise alert-filter state AFTER base watchlist is known
  initAlertFilterState();
  STATE._baseWatchlist = [...base];
  switchT(STATE.currentS);
  fetchGlobal();
  fetchFG();
  fetchNews();
  sync();
  setInterval(sync, 15000);
  setInterval(fetchNews, 60000);
  setInterval(fetchFG, 300000);
  setInterval(fetchGlobal, 60000);
  renderJournal();
  initAlertCfg();
  renderAlertCfgPage();
  updateLastUpdBar();
}

// ── SINGLE SYMBOL FETCH ──
// Fetches and processes one symbol; used by both sync() and per-row refresh buttons.
async function syncOne(s) {
  const isCrypto = s.includes('BINANCE:');
  try {
    if (isCrypto) {
      const pair = s.split(':')[1];
      // Stagger extra calls to avoid bursting — run sequentially within one symbol
      let pd;
      try { pd = (await batchCrypto([s]))[s]; } catch {}
      if (!pd) pd = await binanceFallback(s);

      const obi   = await fetchOBI(pair).catch(() => null);
      const cvd   = await fetchCVD(pair).catch(() => null);
      const mtf   = await fetchMTF(pair).catch(() => [null, null, null]);
      const k4h   = await fetch4hKlines(pair).catch(() => null);
      const kDay  = await fetchDailyKlines(pair).catch(() => null);
      const extra = { obi, cvd, mtf, k4h, kDay };

      if (!STATE.PH[s]) STATE.PH[s] = [];
      STATE.PH[s].push(pd.p);
      if (STATE.PH[s].length > 200) STATE.PH[s].shift();
      processAI(s, pd.p, pd.chg, extra);
    } else {
      const [{ p, chg: rawChg }, stockExtra] = await Promise.all([
        fetchStock(s),
        fetchStockExtra(s).catch(() => ({})),
      ]);
      // Use the most reliable 24h% available:
      //   fetchStock v7 → regularMarketChangePercent (best, official exchange value)
      //   fetchStock v8 fallback → (price - previousClose) / previousClose
      //   stockExtra.kDay.chg1d → verified from 3-month daily bar series (closes[n-2] → closes[n-1])
      // If rawChg looks like a 7d figure (|rawChg| > 20 while kDay.chg1d is sane), prefer chg1d.
      const chg1d = stockExtra?.kDay?.chg1d;
      const chg = (chg1d != null && Math.abs(rawChg) > 15 && Math.abs(chg1d) < Math.abs(rawChg))
        ? chg1d   // rawChg was suspiciously large — use bar-derived 1d instead
        : rawChg; // normal path: use what fetchStock returned
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

// ── MAIN SYNC LOOP — staggered sequential loading ──
// Loads symbols one-at-a-time with a small gap between each to avoid
// mass-throttling 100+ concurrent requests when the watchlist is large.
async function sync() {
  document.getElementById('sstatus').textContent = 'SYNCING';
  document.getElementById('sdot').style.background = 'var(--gold)';

  // Do NOT persist a49_wl_added — session additions stay session-only to prevent
  // them leaking into other open tabs that share localStorage.

  let ok = 0, fail = 0;
  const STAGGER_MS = 300; // ms gap between symbols — keeps concurrent requests low

  for (const s of STATE.watchlist) {
    const success = await syncOne(s);
    if (success) ok++; else fail++;
    // Render after every symbol so the table populates progressively
    render();
    updateLastUpdBar();
    // Yield to browser between symbols to keep UI responsive
    await new Promise(r => setTimeout(r, STAGGER_MS));
  }

  localStorage.setItem('a49_ds', JSON.stringify(STATE.DS));
  localStorage.setItem('a49_ph', JSON.stringify(STATE.PH));
  await flushDigest();
  render();
  updateLastUpdBar();

  document.getElementById('sstatus').textContent = fail > 0 ? `LIVE (${fail} ERR)` : 'LIVE';
  document.getElementById('sdot').style.background = ok > 0 ? 'var(--bull)' : 'var(--bear)';
}

// ── PER-ROW REFRESH — called from the refresh button on each table row ──
async function refreshSymbol(s, btnEl) {
  if (btnEl) { btnEl.textContent = '⟳'; btnEl.style.opacity = '0.4'; btnEl.disabled = true; }
  const ok = await syncOne(s);
  if (btnEl) { btnEl.textContent = '↺'; btnEl.style.opacity = ok ? '1' : '0.3'; btnEl.disabled = false; }
  localStorage.setItem('a49_ds', JSON.stringify(STATE.DS));
  localStorage.setItem('a49_ph', JSON.stringify(STATE.PH));
  render();
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
function switchT(s) {
  STATE.currentS = s;
  const tv = s.endsWith('.TO') ? 'TSX:' + s.replace('.TO', '') : s;
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
}

// ── WATCHLIST MANAGEMENT ──
function addTicker() {
  let v = document.getElementById('newT').value.toUpperCase().trim();
  const t = document.getElementById('assetType').value;
  if (!v) return;
  const e = (t === 'crypto' && !v.includes('BINANCE:')) ? `BINANCE:${v}${v.includes('USDT') ? '' : 'USDT'}` : v;
  if (!STATE.watchlist.includes(e)) {
    STATE.watchlist.push(e);
    // Track in session-only array — never written to localStorage so other tabs
    // running a different watchlist.json are not affected.
    if (!STATE._sessionAdded) STATE._sessionAdded = [];
    if (!STATE._sessionAdded.includes(e)) STATE._sessionAdded.push(e);
    logAlertItem('info', 'Added: ' + e);
    sync();
  }
  document.getElementById('newT').value = '';
}

function delT(s) {
  STATE.watchlist = STATE.watchlist.filter(x => x !== s);
  // Remove from session additions if it was one; no localStorage write needed.
  if (STATE._sessionAdded) STATE._sessionAdded = STATE._sessionAdded.filter(x => x !== s);
  delete STATE.DS[s];
  delete STATE.PH[s];
  if (STATE.currentS === s && STATE.watchlist.length) switchT(STATE.watchlist[0]);
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

// ── NEWS UI ──
// ── Market feed categories ──
// ── Market update feeds ──
// All RSS feeds go through allorigins.win which returns { contents: "<xml>..." }
// CryptoPanic is a JSON API handled separately.
// Feed URLs chosen for CORS-proxy reliability (no Cloudflare blocks).
const MARKET_FEEDS = [
  // Crypto — CryptoPanic JSON API
  { tag: 'CRYPTO', json: true,
    url: 'https://cryptopanic.com/api/free/v1/posts/?auth_token=&public=true&kind=news',
    parse: d => (d.results || []).slice(0, 15).map(p => ({
      title: p.title, url: p.url, source: p.source.title, tag: 'CRYPTO',
      time: new Date(p.published_at).toLocaleTimeString(),
      sent: p.votes ? (p.votes.positive > p.votes.negative ? 'bullish' : p.votes.negative > p.votes.positive ? 'bearish' : 'neutral') : 'neutral'
    }))
  },
  // Energy & Commodities — Yahoo Finance RSS (works via allorigins)
  { tag: 'ENERGY', rss: true, limit: 10, keywords: ['oil','gas','energy','crude','opec','lng','brent','wti','barrel','refin'],
    url: 'https://finance.yahoo.com/rss/headline?s=USO,XLE,CL%3DF,NG%3DF'
  },
  // Metals & Mining
  { tag: 'METAL', rss: true, limit: 10, keywords: ['gold','silver','copper','platinum','palladium','mining','metal','lithium','iron','steel'],
    url: 'https://finance.yahoo.com/rss/headline?s=GLD,SLV,GDX,COPPER'
  },
  // Commodities — grains, soft commodities
  { tag: 'COMMODITY', rss: true, limit: 8, keywords: ['wheat','corn','soy','coffee','sugar','cotton','grain','cattle','hog','farm'],
    url: 'https://finance.yahoo.com/rss/headline?s=WEAT,CORN,SOYB,DBA'
  },
  // Tech
  { tag: 'TECH', rss: true, limit: 10, keywords: ['tech','ai','chip','semiconductor','nvidia','apple','microsoft','google','cloud','software','data'],
    url: 'https://finance.yahoo.com/rss/headline?s=QQQ,NVDA,AAPL,MSFT,SMH'
  },
  // TSX & Canadian markets — use Yahoo Canada top stories
  { tag: 'TSX', rss: true, limit: 10, keywords: ['tsx','canada','canadian','tsx','bay street','bank of canada','loonie','cad','toronto','cnq','shop'],
    url: 'https://finance.yahoo.com/rss/headline?s=XIU.TO,ENB.TO,RY.TO,TD.TO,SU.TO'
  },
];

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
        sent: 'neutral',
      };
    }).filter(x => x.title.length > 5);
  } catch { return []; }
}

async function fetchNews() {
  const allItems = [];

  await Promise.allSettled(MARKET_FEEDS.map(async feed => {
    try {
      if (feed.parse) {
        // JSON feed (CryptoPanic)
        const d = await fetchProxy(feed.url);
        allItems.push(...feed.parse(d));
      } else {
        // RSS — use allorigins (returns { contents: '<xml>...' }) which is more
        // reliable for XML than corsproxy. Two-proxy fallback for resilience.
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
            // allorigins wraps in JSON { contents: "..." }
            try { const j = JSON.parse(txt); xml = j.contents || txt; break; }
            catch { xml = txt; break; }
          } catch {}
        }
        if (xml) allItems.push(...parseRssItems(xml, feed.tag, feed.keywords, feed.limit));
      }
    } catch {}
  }));

  // Sort by recency best-effort; group by tag for variety
  // Interleave tags so the ticker shows all categories
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

function toggleNews() {
  STATE.newsOpen = !STATE.newsOpen;
  document.getElementById('bnews-body').classList.toggle('hide', !STATE.newsOpen);
  document.getElementById('news-chevron').textContent = STATE.newsOpen ? '▲ COLLAPSE' : '▼ EXPAND';
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
