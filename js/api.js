// ══════════════════════════════════════════════
// api.js — v13.3
// Changes from v13.2:
//   - fetchStock() now uses a provider chain from exchange-registry-browser.js:
//     Yahoo primary → Stooq fallback (for TSX, LSE, XETRA, TSE, HKEX).
//     NSE: Yahoo only (Stooq coverage patchy).
//   - fetchStooqPrice() added — fetches latest + prev close from Stooq daily CSV.
//   - fetchStockExtra() unchanged — Yahoo 3mo chart remains the extras source
//     (Stooq CSV has OHLCV but no intraday data; extras degrade gracefully if Yahoo fails).
//   - All crypto paths (Binance, Kraken, CoinGecko) unchanged from v13.2.
//   - fetchStooq() (market pulse) unchanged — still used for indices/gold/DXY.
// ══════════════════════════════════════════════

const PROXIES = [
  u => `https://corsproxy.io/?${encodeURIComponent(u)}`,
  u => `https://corsproxy.io/?url=${encodeURIComponent(u)}`,
  u => `https://api.allorigins.win/get?url=${encodeURIComponent(u)}`,
];

// ── In-flight coalescing ──
const _inflight = new Map();
function _coalesce(key, fn) {
  if (_inflight.has(key)) return _inflight.get(key);
  const p = fn().finally(() => _inflight.delete(key));
  _inflight.set(key, p);
  return p;
}

// ── Proxy concurrency limiter ──
const PROXY_MAX_CONCURRENT = 12;
let _proxyActive = 0;
const _proxyQueue = [];
function _withProxySlot(fn) {
  return new Promise((resolve, reject) => {
    const run = () => {
      _proxyActive++;
      fn().then(resolve, reject).finally(() => {
        _proxyActive--;
        if (_proxyQueue.length) _proxyQueue.shift()();
      });
    };
    if (_proxyActive < PROXY_MAX_CONCURRENT) run();
    else _proxyQueue.push(run);
  });
}

async function fetchProxy(url) {
  return _withProxySlot(async () => {
    let lastErr;
    for (const fn of PROXIES) {
      try {
        const r = await fetch(fn(url), { signal: AbortSignal.timeout(8000) });
        if (!r.ok) { lastErr = new Error('proxy HTTP ' + r.status); continue; }
        const txt = await r.text();
        try { const o = JSON.parse(txt); return o && o.contents !== undefined ? JSON.parse(o.contents) : o; }
        catch { return JSON.parse(txt); }
      } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error('All proxies failed');
  });
}

async function fetchDirect(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

async function fetchBinance(url) {
  return _coalesce(url, async () => {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(6000) });
      if (r.ok) { const d = await r.json(); if (d && !d.code) return d; }
    } catch {}
    return fetchProxy(url);
  });
}

// ── CoinGecko ──
async function cgId(pair) {
  const { cgCache } = STATE;
  if (CG[pair]) return CG[pair];
  if (cgCache[pair]) return cgCache[pair];
  const base = pair.replace(/USDT|BUSD|USDC$/i, '').toLowerCase();
  try {
    const d = await fetchDirect(`https://api.coingecko.com/api/v3/search?query=${base}`);
    if (d.coins && d.coins[0]) {
      cgCache[pair] = d.coins[0].id;
      localStorage.setItem('a49_cgc', JSON.stringify(cgCache));
      return d.coins[0].id;
    }
  } catch {}
  return base;
}

// ── Batch crypto prices ──
async function batchCrypto(syms) {
  if (!syms.length) return {};
  const pairs = syms.map(s => s.split(':')[1]);
  const res = {};

  const binancePairs = pairs.filter(p => !BINANCE_DELISTED.has(p));
  try {
    const url  = `https://api.binance.com/api/v3/ticker/24hr`;
    const data = await fetchBinance(url);
    if (Array.isArray(data)) {
      const byPair = Object.fromEntries(data.map(t => [t.symbol, t]));
      for (const pair of binancePairs) {
        const t = byPair[pair];
        if (t) res['BINANCE:' + pair] = { p: parseFloat(t.lastPrice), chg: parseFloat(t.priceChangePercent) };
      }
      if (pairs.every(p => res['BINANCE:' + p])) return res;
    }
  } catch {}

  const missing = pairs.filter(p => !res['BINANCE:' + p]);
  if (missing.length) {
    const krakenMissing = missing.filter(p => KRAKEN_PAIR[p]);
    await Promise.allSettled(krakenMissing.map(async p => {
      try {
        const kPair = KRAKEN_PAIR[p];
        const url   = `https://api.kraken.com/0/public/Ticker?pair=${kPair}`;
        let d = null;
        try { const r = await fetch(url, { signal: AbortSignal.timeout(8000) }); if (r.ok) d = await r.json(); } catch {}
        if (!d) d = await fetchProxy(url);
        const key = Object.keys(d.result || {})[0];
        if (key) {
          const t    = d.result[key];
          const last = parseFloat(t.c[0]);
          const open = parseFloat(t.o);
          res['BINANCE:' + p] = { p: last, chg: open > 0 ? parseFloat(((last - open) / open * 100).toFixed(2)) : 0 };
        }
      } catch {}
    }));

    const cgMissing = missing.filter(p => !res['BINANCE:' + p]);
    if (cgMissing.length) {
      try {
        const idMap = {};
        await Promise.all(cgMissing.map(async p => { idMap[await cgId(p)] = p; }));
        const ids = Object.keys(idMap).join(',');
        const d   = await fetchDirect(`https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd&include_24hr_change=true`);
        for (const [id, pair] of Object.entries(idMap)) {
          if (d[id]) res['BINANCE:' + pair] = { p: d[id].usd, chg: d[id].usd_24h_change || 0 };
        }
      } catch {}
    }
  }
  return res;
}

async function binanceFallback(sym) {
  const pair = sym.split(':')[1];
  const d    = await fetchProxy(`https://api.binance.com/api/v3/ticker/24hr?symbol=${pair}`);
  if (d.lastPrice) return { p: parseFloat(d.lastPrice), chg: parseFloat(d.priceChangePercent) };
  throw new Error('no data');
}

// ── Stooq price fetch (for stock price, not just market pulse) ──
// Returns { p, chg } where chg = (last - prev) / prev * 100
// Stooq CSV: Date,Open,High,Low,Close,Volume
// Used as fallback when Yahoo fails for TSX/LSE/XETRA/TSE/HKEX symbols.
async function fetchStooqPrice(sym) {
  // exchange-registry-browser.js must be loaded first
  const ex     = typeof resolveExchange !== 'undefined' ? resolveExchange(sym) : null;
  const suffix  = ex?.suffixes?.[0] ?? '';

  // Build Stooq symbol: ETHY.TO → ethy.to, VOD.L → vod.uk, SIE.DE → sie.de,
  // 7203.T → 7203.jp, 0700.HK → 0700.hk, RELIANCE.NS → reliance.ns
  const STOOQ_SUFFIX_MAP = {
    '.TO': '.to', '.L': '.uk', '.DE': '.de',
    '.T': '.jp', '.HK': '.hk', '.NS': '.ns',
  };
  const stooqSuffix = STOOQ_SUFFIX_MAP[suffix];
  if (!stooqSuffix) throw new Error(`no Stooq mapping for ${sym}`);

  const bare     = suffix ? sym.slice(0, sym.length - suffix.length) : sym;
  const stooqSym = (bare + stooqSuffix).toLowerCase();
  const url      = `https://stooq.com/q/d/l/?s=${encodeURIComponent(stooqSym)}&i=d`;

  let txt = null;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(9000) });
    if (r.ok) txt = await r.text();
  } catch {}
  if (!txt) {
    try {
      const r = await fetch(PROXIES[0](url), { signal: AbortSignal.timeout(9000) });
      if (r.ok) { const raw = await r.text(); try { txt = JSON.parse(raw).contents ?? raw; } catch { txt = raw; } }
    } catch {}
  }

  if (!txt || txt.includes('No data') || txt.trim().split('\n').length < 3) {
    throw new Error(`Stooq: no data for ${stooqSym}`);
  }
  const rows = txt.trim().split('\n').slice(1).filter(Boolean);
  const close = row => parseFloat(row.split(',')[4]);
  const last  = close(rows[rows.length - 1]);
  const prev  = close(rows[rows.length - 2]);
  if (!last || !prev) throw new Error(`Stooq: parse failed for ${stooqSym}`);
  return { p: last, chg: ((last - prev) / prev) * 100 };
}

// ── Stock price — Yahoo primary, Stooq fallback ──
// Provider order mirrors exchange-registry (yahoo → stooq).
// NSE (.NS) skips Stooq (patchy coverage).
async function fetchStock(sym) {
  // ── Yahoo primary ──
  try {
    const d = await fetchProxy(`https://query1.finance.yahoo.com/v7/finance/quote?symbols=${sym}`);
    const q = d?.quoteResponse?.result?.[0];
    if (q?.regularMarketPrice != null && q?.regularMarketChangePercent != null) {
      return { p: q.regularMarketPrice, chg: q.regularMarketChangePercent };
    }
  } catch {}
  try {
    const d = await fetchProxy(`https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=1d&range=2d`);
    const r = d.chart.result[0];
    const p = r.meta.regularMarketPrice ?? r.meta.previousClose;
    const prev = r.meta.previousClose ?? r.meta.chartPreviousClose;
    return { p, chg: prev ? ((p - prev) / prev) * 100 : 0 };
  } catch {}
  try {
    const d = await fetchProxy(`https://query2.finance.yahoo.com/v8/finance/chart/${sym}?interval=1d&range=5d`);
    const r = d.chart.result[0];
    const p = r.meta.regularMarketPrice ?? r.meta.previousClose;
    const prev = r.meta.previousClose ?? r.meta.chartPreviousClose;
    return { p, chg: prev ? ((p - prev) / prev) * 100 : 0 };
  } catch {}

  // ── Stooq fallback (TSX, LSE, XETRA, TSE, HKEX — not NSE) ──
  if (!sym.endsWith('.NS')) {
    try {
      const result = await fetchStooqPrice(sym);
      console.log(`  📥 ${sym} price via Stooq fallback`);
      return result;
    } catch (e) {
      console.log(`  ⚠ ${sym} Stooq fallback failed: ${e.message}`);
    }
  }

  throw new Error('stock failed: ' + sym);
}

// ── Stock extra data (OBI, CVD, MTF, biases) — Yahoo only ──
// Stooq doesn't provide intraday data so extras degrade gracefully if Yahoo fails.
async function fetchStockExtra(sym) {
  const extra = { obi: null, cvd: null, mtf: [null, null, null], k4h: null, kDay: null, stockMeta: null };
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=1d&range=3mo`;
    const d   = await fetchProxy(url);
    const r   = d.chart.result[0];
    const qi  = r.indicators.quote[0];
    const bars = [];
    for (let i = 0; i < qi.close.length; i++) {
      if (qi.close[i] != null && qi.open[i] != null && qi.volume[i] != null)
        bars.push({ c: qi.close[i], o: qi.open[i], h: qi.high[i] || qi.close[i], l: qi.low[i] || qi.close[i], v: qi.volume[i] });
    }
    const n = bars.length;
    if (n < 10) return extra;

    const closes  = bars.map(b => b.c);
    const volumes = bars.map(b => b.v);

    const rsi15    = calcRSI(closes.slice(-5), 4);
    const rsi1h    = calcRSI(closes.slice(-15), 7);
    const rsiDaily = calcRSI(closes, 14);
    extra.mtf = [rsi15, rsi1h, rsiDaily];

    let cvd = 0;
    const cvdSeries = bars.map(b => { cvd += b.c >= b.o ? b.v : -b.v; return cvd; });
    const cvdLast   = cvdSeries[n - 1], cvdPrev = cvdSeries[Math.max(0, n - 6)];
    extra.cvd = { value: cvdLast, series: cvdSeries.slice(-20), trending: cvdLast > cvdPrev ? 'up' : 'down' };

    const rangePos = bars[n-1].h > bars[n-1].l ? (closes[n-1] - bars[n-1].l) / (bars[n-1].h - bars[n-1].l) : 0.5;
    extra.obi = {
      bidPct: (rangePos * 100).toFixed(1),
      askPct: ((1 - rangePos) * 100).toFixed(1),
      ratio:  (rangePos / (1 - rangePos + 0.001)).toFixed(2),
    };

    const avgVol    = volumes.slice(-21, -1).reduce((a, b) => a + b, 0) / Math.min(20, volumes.length - 1) || 1;
    const volShock  = Math.min(3, volumes[n - 1] / avgVol);
    extra.stockMeta = { volShock: volShock.toFixed(2) };

    const recentUp = closes[n-1] > closes[n-5];
    const recentVols5 = volumes.slice(-5);
    const volUp    = recentVols5[4] > (recentVols5.slice(0, 4).reduce((a, b) => a + b, 0) / 4);
    const k8 = 2 / 9;
    let ema8 = closes[Math.max(0, n - 9)];
    for (let i = Math.max(0, n - 8); i < n; i++) ema8 = closes[i] * k8 + ema8 * (1 - k8);
    let cvd4h = 0;
    for (let i = n - 4; i < n; i++) cvd4h += bars[i].c >= bars[i].o ? 1 : -1;
    extra.k4h = { rsi4h: rsiDaily, recentUp, volUp, aboveEma8: closes[n-1] > ema8, cvd4h, lastClose: closes[n-1], prevClose: closes[n-4] };

    const k7 = 2 / 8;
    let ema7 = closes[Math.max(0, n - 8)];
    for (let i = Math.max(0, n - 7); i < n; i++) ema7 = closes[i] * k7 + ema7 * (1 - k7);
    const chg7d    = closes[n-7] > 0 ? ((closes[n-1] - closes[n-7]) / closes[n-7] * 100) : 0;
    const chg1d    = closes[n-2] > 0 ? ((closes[n-1] - closes[n-2]) / closes[n-2] * 100) : 0;
    const volSurge = volumes[n-1] > avgVol * 1.4;
    let cvdDaily = 0;
    for (let i = n - 7; i < n; i++) cvdDaily += bars[i].c >= bars[i].o ? 1 : -1;
    extra.kDay = { rsiDaily, aboveEma7: closes[n-1] > ema7, volSurge, chg7d: parseFloat(chg7d.toFixed(1)), chg1d: parseFloat(chg1d.toFixed(2)), cvdDaily };
    extra._barsDay = bars;
    extra._bars4h  = bars.slice(-20);
  } catch {}
  return extra;
}

// ── Crypto extras (Binance) — unchanged from v13.2 ──
function _computeOBI(depthData) {
  if (!depthData?.bids?.length) return null;
  const bv = depthData.bids.reduce((s, x) => s + parseFloat(x[1]), 0);
  const av = depthData.asks.reduce((s, x) => s + parseFloat(x[1]), 0);
  const tot = bv + av;
  return { bidPct: (bv / tot * 100).toFixed(1), askPct: (av / tot * 100).toFixed(1), ratio: (bv / av).toFixed(2) };
}

function _computeCVDandMTF(klines15m) {
  if (!Array.isArray(klines15m) || klines15m.length < 10) return { cvd: null, mtf: [null, null, null] };
  let acc = 0;
  const series = klines15m.map(c => {
    const vol = parseFloat(c[5]), o = parseFloat(c[1]), cl = parseFloat(c[4]);
    acc += cl >= o ? vol : -vol;
    return acc;
  });
  const last = series.at(-1), prev5 = series.at(-6) ?? series[0];
  const cvd = { value: last, series: series.slice(-20), trending: last > prev5 ? 'up' : 'down' };
  const closes = klines15m.map(c => parseFloat(c[4]));
  const mtf = [
    calcRSI(closes.slice(-20), 14),
    calcRSI(closes.slice(-30), 14),
    calcRSI(closes,            14),
  ];
  return { cvd, mtf };
}

function _compute4hBias(klines4h) {
  if (!Array.isArray(klines4h) || klines4h.length < 5) return null;
  const closes  = klines4h.map(c => parseFloat(c[4]));
  const volumes = klines4h.map(c => parseFloat(c[5]));
  const n = closes.length;
  const recentUp = closes[n-1] > closes[n-4];
  const volUp    = volumes[n-1] > ((volumes[n-2] + volumes[n-3] + volumes[n-4]) / 3);
  const rsi4h    = calcRSI(closes, 14);
  const k2 = 2 / 9; let ema8 = closes[0];
  for (let i = 1; i < n; i++) ema8 = closes[i] * k2 + ema8 * (1 - k2);
  let cvd4h = 0;
  for (let i = n - 4; i < n; i++) { const o = parseFloat(klines4h[i][1]); cvd4h += closes[i] > o ? 1 : -1; }
  // _bars4h — raw 4h candle closes, exposed so signals.js can compute the
  // SAME EMA-20-on-4h-candles the server actually trades on (see
  // scripts/leaderboard-scanner.js scoreSymbol()'s ema20/emaTrend), instead
  // of the old tick-buffer EMA that never matched it. Mirrors the
  // _barsDay pattern in _computeDailyBias() below.
  const bars4h = klines4h.map(c => ({ h: parseFloat(c[2]), l: parseFloat(c[3]), c: parseFloat(c[4]) }));
  return { rsi4h, recentUp, volUp, aboveEma8: closes[n-1] > ema8, cvd4h, lastClose: closes[n-1], prevClose: closes[n-4], _bars4h: bars4h };
}

function _computeDailyBias(klinesDay) {
  if (!Array.isArray(klinesDay) || klinesDay.length < 7) return null;
  const closes  = klinesDay.map(c => parseFloat(c[4]));
  const volumes = klinesDay.map(c => parseFloat(c[5]));
  const n = closes.length;
  const rsiDaily = calcRSI(closes, 14);
  const k2 = 2 / 8; let ema7 = closes[0];
  for (let i = 1; i < n; i++) ema7 = closes[i] * k2 + ema7 * (1 - k2);
  const avgVol   = volumes.slice(0, n-1).reduce((a, b) => a + b, 0) / (n - 1);
  const volSurge = volumes[n-1] > avgVol * 1.5;
  const chg7d    = ((closes[n-1] - closes[n-7]) / closes[n-7] * 100).toFixed(1);
  const chg1d    = closes[n-2] > 0 ? parseFloat(((closes[n-1] - closes[n-2]) / closes[n-2] * 100).toFixed(2)) : null;
  let cvdDaily = 0;
  for (let i = n - 7; i < n; i++) { const o = parseFloat(klinesDay[i][1]); cvdDaily += closes[i] > o ? 1 : -1; }
  const dailyBars = klinesDay.map(c => ({ h: parseFloat(c[2]), l: parseFloat(c[3]), c: parseFloat(c[4]) }));
  return { rsiDaily, aboveEma7: closes[n-1] > ema7, volSurge, chg7d: parseFloat(chg7d), chg1d, cvdDaily, _barsDay: dailyBars };
}

const _klineCache = new Map();
const KLINE_TTL   = { k4h: 4 * 60 * 1000, kDay: 15 * 60 * 1000 };

async function _fetchCached(pair, intervalKey, url) {
  const cacheKey = `${pair}:${intervalKey}`;
  const cached   = _klineCache.get(cacheKey);
  const ttl      = KLINE_TTL[intervalKey];
  if (cached && (Date.now() - cached.fetchedAt) < ttl) return cached.data;
  const data = await _fetchOneRaw(url);
  if (data) _klineCache.set(cacheKey, { data, fetchedAt: Date.now() });
  return data ?? cached?.data ?? null;
}

async function _fetchOneRaw(url) {
  return _coalesce(url, async () => {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(6000) });
      if (r.ok) { const d = await r.json(); if (d) return d; }
    } catch {}
    return fetchProxy(url);
  });
}

async function fetchCryptoExtra(pair) {
  const BASE = 'https://api.binance.com/api/v3';
  const [depth, k15m, k4h, kDay] = await Promise.allSettled([
    _fetchOneRaw(`${BASE}/depth?symbol=${pair}&limit=20`),
    _fetchOneRaw(`${BASE}/klines?symbol=${pair}&interval=15m&limit=60`),
    _fetchCached(pair, 'k4h',  `${BASE}/klines?symbol=${pair}&interval=4h&limit=50`),
    _fetchCached(pair, 'kDay', `${BASE}/klines?symbol=${pair}&interval=1d&limit=14`),
  ]);
  const val = r => r.status === 'fulfilled' ? r.value : null;
  const { cvd, mtf } = _computeCVDandMTF(val(k15m));
  return {
    obi:  _computeOBI(val(depth)),
    cvd, mtf,
    k4h:  _compute4hBias(val(k4h)),
    kDay: _computeDailyBias(val(kDay)),
  };
}

// ── Legacy stubs ──
async function fetchOBI(pair)         { return (await fetchCryptoExtra(pair)).obi; }
async function fetchCVD(pair)         { return (await fetchCryptoExtra(pair)).cvd; }
async function fetchMTF(pair)         { return (await fetchCryptoExtra(pair)).mtf; }
async function fetch4hKlines(pair)    { return (await fetchCryptoExtra(pair)).k4h; }
async function fetchDailyKlines(pair) { return (await fetchCryptoExtra(pair)).kDay; }

// ── RSI ──
function calcRSI(closes, p = 14) {
  if (!closes || closes.length < p + 1) return null;
  let g = 0, l = 0;
  for (let i = 1; i <= p; i++) { const d = closes[i] - closes[i-1]; g += d > 0 ? d : 0; l += d < 0 ? -d : 0; }
  let ag = g / p, al = l / p;
  for (let i = p + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i-1];
    ag = (ag * (p-1) + (d > 0 ? d : 0)) / p;
    al = (al * (p-1) + (d < 0 ? -d : 0)) / p;
  }
  return al === 0 ? 100 : parseFloat((100 - 100 / (1 + ag / al)).toFixed(1));
}

// ── Kraken extra (XMR etc.) — unchanged from v13.2 ──
const KRAKEN_PAIR = { 'XMRUSDT': 'XMRUSD' };

async function fetchKrakenExtra(pair) {
  const kPair = KRAKEN_PAIR[pair];
  if (!kPair) return null;
  try {
    const dayUrl = `https://api.kraken.com/0/public/OHLC?pair=${kPair}&interval=1440&count=20`;
    const dayRaw = await _fetchCached(pair, 'kDay', dayUrl);
    const dayKey = Object.keys(dayRaw?.result || {}).find(k => k !== 'last');
    if (!dayKey) return null;
    const dayBars = dayRaw.result[dayKey].map(r => ({
      t: r[0]*1000, o: parseFloat(r[1]), h: parseFloat(r[2]),
      l: parseFloat(r[3]), c: parseFloat(r[4]), v: parseFloat(r[6]),
    }));
    if (dayBars.length < 8) return null;
    const closes  = dayBars.map(b => b.c);
    const volumes = dayBars.map(b => b.v);
    const n = closes.length;
    const rsiDaily = calcRSI(closes, 14);
    const k2 = 2 / 8; let ema7 = closes[0];
    for (let i = 1; i < n; i++) ema7 = closes[i] * k2 + ema7 * (1 - k2);
    const chg7d    = closes[n-7] > 0 ? parseFloat(((closes[n-1] - closes[n-7]) / closes[n-7] * 100).toFixed(1)) : 0;
    const chg1d    = closes[n-2] > 0 ? parseFloat(((closes[n-1] - closes[n-2]) / closes[n-2] * 100).toFixed(2)) : null;
    const avgVol   = volumes.slice(0, n-1).reduce((a, b) => a + b, 0) / (n - 1);
    const volSurge = volumes[n-1] > avgVol * 1.4;
    let cvdDaily = 0;
    for (let i = n - 7; i < n; i++) cvdDaily += dayBars[i].c >= dayBars[i].o ? 1 : -1;
    const dailyBars = dayBars.map(b => ({ h: b.h, l: b.l, c: b.c }));
    const kDay = { rsiDaily, aboveEma7: closes[n-1] > ema7, volSurge, chg7d, chg1d, cvdDaily, _barsDay: dailyBars };
    let k4h = null;
    try {
      const h4Url = `https://api.kraken.com/0/public/OHLC?pair=${kPair}&interval=240&count=20`;
      const h4Raw = await _fetchCached(pair, 'k4h', h4Url);
      const h4Key = Object.keys(h4Raw?.result || {}).find(k => k !== 'last');
      if (h4Key) {
        const h4Bars = h4Raw.result[h4Key].map(r => ({ o: parseFloat(r[1]), c: parseFloat(r[4]), v: parseFloat(r[6]) }));
        const rClose = h4Bars.map(b => b.c);
        const rn = rClose.length;
        const rsi4h = calcRSI(rClose, Math.min(14, rn - 1));
        const k3 = 2 / 9; let ema8 = rClose[0];
        for (let i = 1; i < rn; i++) ema8 = rClose[i] * k3 + ema8 * (1 - k3);
        const recentUp = rClose[rn-1] > rClose[Math.max(0, rn-4)];
        const rVols    = h4Bars.map(b => b.v);
        const avgVol4h = rVols.slice(0, rn-1).reduce((a, b) => a + b, 0) / (rn - 1);
        const volUp    = rVols[rn-1] > avgVol4h * 1.3;
        let cvd4h = 0;
        for (let i = Math.max(0, rn-4); i < rn; i++) cvd4h += h4Bars[i].c >= h4Bars[i].o ? 1 : -1;
        k4h = { rsi4h, recentUp, volUp, aboveEma8: rClose[rn-1] > ema8, cvd4h, lastClose: rClose[rn-1], prevClose: rClose[Math.max(0, rn-4)] };
      }
    } catch {}
    if (!k4h) {
      const recent = dayBars.slice(-8);
      const rClose = recent.map(b => b.c);
      const rn = rClose.length;
      const rsi4h = calcRSI(rClose, Math.min(7, rn - 1));
      const k3 = 2 / 9; let ema8 = rClose[0];
      for (let i = 1; i < rn; i++) ema8 = rClose[i] * k3 + ema8 * (1 - k3);
      let cvd4h = 0;
      for (let i = Math.max(0, rn-4); i < rn; i++) cvd4h += recent[i].c >= recent[i].o ? 1 : -1;
      k4h = { rsi4h, recentUp: rClose[rn-1] > rClose[Math.max(0, rn-4)], volUp: false,
              aboveEma8: rClose[rn-1] > ema8, cvd4h, lastClose: rClose[rn-1], prevClose: rClose[Math.max(0, rn-4)] };
    }
    let mtf = [null, null, null], cvd = null;
    try {
      const m15Url = `https://api.kraken.com/0/public/OHLC?pair=${kPair}&interval=15&count=60`;
      const m15Raw = await _fetchOneRaw(m15Url);
      const m15Key = Object.keys(m15Raw?.result || {}).find(k => k !== 'last');
      if (m15Key) {
        const rows = m15Raw.result[m15Key];
        const m15Closes = rows.map(r => parseFloat(r[4]));
        mtf = [calcRSI(m15Closes.slice(-20), 14), calcRSI(m15Closes.slice(-30), 14), calcRSI(m15Closes, 14)];
        let cvdAcc = 0;
        const cvdSeries = rows.slice(-48).map(r => { const v=parseFloat(r[6]),o=parseFloat(r[1]),c=parseFloat(r[4]); cvdAcc+=c>=o?v:-v; return cvdAcc; });
        const cvdLast = cvdSeries[cvdSeries.length-1], cvdPrev = cvdSeries[Math.max(0, cvdSeries.length-6)];
        cvd = { value: cvdLast, series: cvdSeries.slice(-20), trending: cvdLast > cvdPrev ? 'up' : 'down' };
      }
    } catch {}
    if (mtf.every(v => v === null)) mtf = [calcRSI(closes.slice(-6),3), calcRSI(closes.slice(-10),5), calcRSI(closes.slice(-12),7)];
    if (!cvd) {
      let cvdAcc = 0;
      const cvdSeries = dayBars.slice(-20).map(b => { cvdAcc += b.c >= b.o ? 1 : -1; return cvdAcc; });
      const cvdLast = cvdSeries[cvdSeries.length-1], cvdPrev = cvdSeries[Math.max(0, cvdSeries.length-6)];
      cvd = { value: cvdLast, series: cvdSeries, trending: cvdLast > cvdPrev ? 'up' : 'down' };
    }
    return { obi: null, cvd, mtf, k4h, kDay, _barsDay: dailyBars };
  } catch { return null; }
}

// ── Liq estimate ──
function liqEstimate(price, fr, lp) {
  if (!price) return null;
  const f = parseFloat(fr) || 0;
  let dist, side;
  if (lp > 60)       { dist = -(3 + Math.abs(f)*500 + (lp-50)*.15); side = 'LONG LIQ'; }
  else if (lp < 40)  { dist = +(3 + Math.abs(f)*500 + (50-lp)*.15); side = 'SHORT LIQ'; }
  else { dist = lp > 50 ? -(2 + Math.random()*2) : (2 + Math.random()*2); side = lp > 50 ? 'LONG LIQ' : 'SHORT LIQ'; }
  const lp2 = price * (1 + dist / 100);
  return { price: lp2.toFixed(lp2 < 1 ? 4 : 2), dist: dist.toFixed(1), side };
}

// ── Global market stats ──
async function fetchGlobal() {
  try {
    const d = await fetchDirect('https://api.coingecko.com/api/v3/global');
    document.getElementById('h-btcdom').textContent = d.data.market_cap_percentage.btc.toFixed(1) + '%';
    document.getElementById('h-mcap').textContent   = '$' + (d.data.total_market_cap.usd / 1e12).toFixed(2) + 'T';
    document.getElementById('h-vol').textContent    = '$' + (d.data.total_volume.usd / 1e9).toFixed(1) + 'B';
  } catch {}
}

async function fetchFG() {
  try {
    const d   = await fetchDirect('https://api.alternative.me/fng/');
    const val = parseInt(d.data[0].value);
    const lbl = d.data[0].value_classification;
    const pill = document.getElementById('fg-pill');
    pill.textContent = 'F&G: ' + val + ' · ' + lbl.toUpperCase();
    if (val <= 25)      { pill.style.background = 'var(--bear-dim)'; pill.style.color = 'var(--bear)'; }
    else if (val <= 45) { pill.style.background = 'rgba(255,140,0,.15)'; pill.style.color = '#ff8c00'; }
    else if (val >= 75) { pill.style.background = 'var(--bull-dim)'; pill.style.color = 'var(--bull)'; }
    else                { pill.style.background = 'rgba(100,100,100,.2)'; pill.style.color = '#aaa'; }
  } catch {}
}

// ── Market Pulse — v13.4: added TSX Composite, IWM (risk appetite), XLB (materials) ──
const MPULSE_STOCKS = [
  { id: 'mp-SPY', sym: '^spx',     stooq: true },
  { id: 'mp-QQQ', sym: '^ndx',     stooq: true },
  { id: 'mp-DIA', sym: '^dji',     stooq: true },
  { id: 'mp-TSX', sym: '^tsx',     stooq: true },                        // TSX Composite
  { id: 'mp-IWM', sym: 'IWM',      stooq: false, yahoo: 'IWM'      },   // Russell 2000 — risk appetite
  { id: 'mp-XLK', sym: 'XLK',      stooq: false },
  { id: 'mp-XLE', sym: 'XLE',      stooq: false },
  { id: 'mp-XLF', sym: 'XLF',      stooq: false },
  { id: 'mp-XLV', sym: 'XLV',      stooq: false },
  { id: 'mp-XLB', sym: 'XLB',      stooq: false, yahoo: 'XLB'      },   // Materials
  { id: 'mp-GLD', sym: 'xauusd',   stooq: true,  yahoo: 'GC=F'     },
  { id: 'mp-SLV', sym: 'xagusd',   stooq: true,  yahoo: 'SI=F'     },
  { id: 'mp-UUP', sym: 'dx-y.nyb', stooq: true,  yahoo: 'DX-Y.NYB' },
  { id: 'mp-TLT', sym: '^tnx',     stooq: true,  yahoo: '%5ETNX'   },
  { id: 'mp-USO', sym: 'CL=F',     stooq: false, yahoo: 'CL=F'     },
  { id: 'mp-BRT', sym: 'BZ=F',     stooq: false, yahoo: 'BZ=F'     },
];
const MPULSE_CRYPTO = [
  { id: 'mp-BTC', sym: 'BTCUSDT' },
  { id: 'mp-ETH', sym: 'ETHUSDT' },
  { id: 'mp-SOL', sym: 'SOLUSDT' },
  { id: 'mp-XMR', sym: 'XMRUSDT' },
];

async function fetchStooq(sym) {
  const s   = /^[A-Z]{2,5}$/.test(sym) ? sym.toLowerCase() + '.us' : sym.toLowerCase();
  const url = `https://stooq.com/q/d/l/?s=${encodeURIComponent(s)}&i=d`;
  let txt = null;
  try { const r = await fetch(url, { signal: AbortSignal.timeout(9000) }); if (r.ok) txt = await r.text(); } catch {}
  if (!txt) {
    try {
      const r = await fetch(PROXIES[0](url), { signal: AbortSignal.timeout(9000) });
      if (r.ok) { const raw = await r.text(); try { txt = JSON.parse(raw).contents ?? raw; } catch { txt = raw; } }
    } catch {}
  }
  if (!txt || txt.includes('No data') || txt.trim().split('\n').length < 3) throw new Error('stooq:nodata:' + sym);
  const rows  = txt.trim().split('\n').slice(1).filter(Boolean);
  const parse = row => parseFloat(row.split(',')[4]);
  const last  = parse(rows[rows.length - 1]);
  const prev  = parse(rows[rows.length - 2]);
  if (!last || !prev) throw new Error('stooq:parse:' + sym);
  return { p: last, chg: ((last - prev) / prev) * 100 };
}

async function fetchMarketPulse() {
  const btn = document.querySelector('.mp-refresh-btn');
  if (btn) btn.classList.add('spinning');
  [...MPULSE_STOCKS, ...MPULSE_CRYPTO].forEach(p => {
    const el = document.getElementById(p.id);
    if (el) el.classList.add('mp-loading');
  });

  try {
    const url  = `https://api.binance.com/api/v3/ticker/24hr`;
    const data = await fetchBinance(url);
    if (Array.isArray(data)) {
      const byPair = Object.fromEntries(data.map(t => [t.symbol, t]));
      for (const pill of MPULSE_CRYPTO) {
        if (BINANCE_DELISTED.has(pill.sym)) continue;
        const t = byPair[pill.sym];
        if (t) updateMPill(pill.id, parseFloat(t.lastPrice), parseFloat(t.priceChangePercent));
      }
    }
  } catch {}

  const delistedCrypto = MPULSE_CRYPTO.filter(p => BINANCE_DELISTED.has(p.sym));
  await Promise.allSettled(delistedCrypto.map(async pill => {
    const kPair = KRAKEN_PAIR[pill.sym];
    if (!kPair) return;
    try {
      const url = `https://api.kraken.com/0/public/Ticker?pair=${kPair}`;
      let d = null;
      try { const r = await fetch(url, { signal: AbortSignal.timeout(8000) }); if (r.ok) d = await r.json(); } catch {}
      if (!d) d = await fetchProxy(url);
      const key = Object.keys(d.result || {})[0];
      if (key) {
        const t = d.result[key]; const last = parseFloat(t.c[0]); const open = parseFloat(t.o);
        updateMPill(pill.id, last, open > 0 ? ((last - open) / open * 100) : 0);
      }
    } catch {}
  }));

  await Promise.allSettled(MPULSE_STOCKS.map(async pill => {
    if (pill.stooq) {
      try { const { p, chg } = await fetchStooq(pill.sym); if (p != null) { updateMPill(pill.id, p, chg); return; } } catch {}
      const yahooMap = { '^spx':'%5EGSPC', '^ndx':'%5EIXIC', '^dji':'%5EDJI', '^tnx':'%5ETNX', 'xauusd':'GC=F', 'xagusd':'SI=F', 'dx-y.nyb':'DX-Y.NYB' };
      const yTicker = pill.yahoo || yahooMap[pill.sym] || pill.sym;
      try { const { p, chg } = await fetchStock(yTicker); if (p != null) updateMPill(pill.id, p, chg); } catch {}
    } else {
      try { const { p, chg } = await fetchStock(pill.sym); if (p != null) updateMPill(pill.id, p, chg); } catch {}
    }
  }));

  const upd = document.getElementById('mp-updated');
  if (upd) upd.textContent = 'UPD ' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (btn) btn.classList.remove('spinning');
}

function updateMPill(id, price, chgPct) {
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.remove('mp-loading');
  const valEl = el.querySelector('.mp-tile-val');
  const chgEl = el.querySelector('.mp-tile-chg');
  if (!valEl || !chgEl) return;
  const pStr = price >= 10000 ? '$' + Math.round(price).toLocaleString('en')
             : price >= 1     ? '$' + price.toFixed(2)
             :                  '$' + price.toFixed(4);
  valEl.textContent = pStr;
  const sign = chgPct >= 0 ? '+' : '';
  chgEl.textContent = sign + chgPct.toFixed(2) + '%';
  const up = chgPct > 0.05, dn = chgPct < -0.05;
  chgEl.className = 'mp-tile-chg ' + (up ? 'up' : dn ? 'dn' : 'flat');
  el.classList.toggle('mp-hot-up', chgPct >  1.5);
  el.classList.toggle('mp-hot-dn', chgPct < -1.5);
  // Store in STATE.marketPulse keyed by tile id suffix
  // so calcRiskAppetite() and calcSectorFlow() can read all pulse data
  const sym = id.replace('mp-', '');
  if (!STATE.marketPulse) STATE.marketPulse = {};
  STATE.marketPulse[sym] = { p: price, chg: chgPct };
  // Also store by common aliases used in PULSE_KEY_MAP
  const PULSE_ALIASES = {
    'SPY':'SPY', 'QQQ':'QQQ', 'DIA':'DIA', 'TSX':'TSX', 'IWM':'IWM',
    'XLK':'XLK', 'XLE':'XLE', 'XLF':'XLF', 'XLV':'XLV', 'XLB':'XLB',
    'GLD':'GLD', 'SLV':'SLV', 'TLT':'TLT', 'UUP':'UUP', 'USO':'USO', 'BRT':'BRT',
    'BTC':'BTC', 'ETH':'ETH', 'SOL':'SOL', 'XMR':'XMR',
  };
  if (PULSE_ALIASES[sym]) STATE.marketPulse[PULSE_ALIASES[sym]] = { p: price, chg: chgPct };
}
