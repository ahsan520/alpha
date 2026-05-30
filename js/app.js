// ══════════════════════════════════════════════
// app.js — init, sync loop, nav, misc UI actions
// ══════════════════════════════════════════════

// ── INIT ──
async function init() {
  const saved = JSON.parse(localStorage.getItem('a49_wl'));
  if (saved && saved.length) STATE.watchlist = saved;
  else {
    try { const r = await fetch('watchlist.json'); STATE.watchlist = r.ok ? await r.json() : defWL(); }
    catch { STATE.watchlist = defWL(); }
  }
  STATE.currentS = STATE.watchlist[0];
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
  renderAlertCfgPage();
  updateLastUpdBar();
}

// ── MAIN SYNC LOOP ──
async function sync() {
  document.getElementById('sstatus').textContent = 'SYNCING';
  document.getElementById('sdot').style.background = 'var(--gold)';
  localStorage.setItem('a49_wl', JSON.stringify(STATE.watchlist));

  const cryptoS = STATE.watchlist.filter(s => s.includes('BINANCE:'));
  const stockS = STATE.watchlist.filter(s => !s.includes('BINANCE:'));
  let ok = 0, fail = 0;

  const batch = await batchCrypto(cryptoS);

  const extra = {};
  await Promise.all(cryptoS.map(async s => {
    const pair = s.split(':')[1];
    const [obi, cvd, mtf, k4h, kDay] = await Promise.all([
      fetchOBI(pair).catch(() => null),
      fetchCVD(pair).catch(() => null),
      fetchMTF(pair).catch(() => [null, null, null]),
      fetch4hKlines(pair).catch(() => null),
      fetchDailyKlines(pair).catch(() => null),
    ]);
    extra[s] = { obi, cvd, mtf, k4h, kDay };
  }));

  for (const s of cryptoS) {
    let pd = batch[s];
    if (!pd) { try { pd = await binanceFallback(s); } catch { fail++; continue; } }
    ok++;
    if (!STATE.PH[s]) STATE.PH[s] = [];
    STATE.PH[s].push(pd.p);
    if (STATE.PH[s].length > 200) STATE.PH[s].shift();
    processAI(s, pd.p, pd.chg, extra[s] || {});
  }

  await Promise.all(stockS.map(async s => {
    try {
      const [{ p, chg }, stockExtra] = await Promise.all([
        fetchStock(s),
        fetchStockExtra(s).catch(() => ({})),
      ]);
      if (!STATE.PH[s]) STATE.PH[s] = [];
      STATE.PH[s].push(p);
      if (STATE.PH[s].length > 200) STATE.PH[s].shift();
      processAI(s, p, chg, stockExtra);
      ok++;
    } catch { fail++; }
  }));

  localStorage.setItem('a49_ds', JSON.stringify(STATE.DS));
  localStorage.setItem('a49_ph', JSON.stringify(STATE.PH));
  render();
  updateLastUpdBar();

  document.getElementById('sstatus').textContent = fail > 0 ? `LIVE (${fail} ERR)` : 'LIVE';
  document.getElementById('sdot').style.background = ok > 0 ? 'var(--bull)' : 'var(--bear)';
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
    logAlertItem('info', 'Added: ' + e);
    sync();
  }
  document.getElementById('newT').value = '';
}

function delT(s) {
  STATE.watchlist = STATE.watchlist.filter(x => x !== s);
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
async function fetchNews() {
  try {
    const d = await fetchProxy('https://cryptopanic.com/api/free/v1/posts/?auth_token=&public=true&kind=news');
    STATE.newsItems = d.results.slice(0, 40).map(p => ({
      title: p.title, url: p.url, source: p.source.title,
      time: new Date(p.published_at).toLocaleTimeString(),
      sent: p.votes ? (p.votes.positive > p.votes.negative ? 'bullish' : p.votes.negative > p.votes.positive ? 'bearish' : 'neutral') : 'neutral'
    }));
  } catch { STATE.newsItems = mockNews(); }
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

function toggleAlerts() {
  STATE.alertsOpen = !STATE.alertsOpen;
  document.getElementById('alert-strip').style.display = STATE.alertsOpen ? 'block' : 'none';
}

window.onload = init;
