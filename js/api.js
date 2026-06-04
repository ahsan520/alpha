// ══════════════════════════════════════════════
// api.js — all fetch, proxy, and data functions
// ══════════════════════════════════════════════

const PROXIES = [
  u => `https://corsproxy.io/?${encodeURIComponent(u)}`,
  u => `https://api.allorigins.win/get?url=${encodeURIComponent(u)}`,
];

async function fetchProxy(url) {
  for (const fn of PROXIES) {
    try {
      const r = await fetch(fn(url), { signal: AbortSignal.timeout(8000) });
      if (!r.ok) continue;
      const txt = await r.text();
      try { const o = JSON.parse(txt); return o && o.contents !== undefined ? JSON.parse(o.contents) : o; }
      catch { return JSON.parse(txt); }
    } catch {}
  }
  throw new Error('All proxies failed');
}

async function fetchDirect(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

async function fetchBinance(url) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(6000) });
    if (r.ok) { const d = await r.json(); if (d && !d.code) return d; }
  } catch {}
  return fetchProxy(url);
}

// ── CoinGecko ID lookup ──
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

// ── Batch crypto prices — Binance first for real-time true 24h%, CoinGecko fallback ──
// CoinGecko usd_24h_change can be stale by hours; Binance priceChangePercent is a
// rolling 24h value updated every few seconds and is the authoritative source.
async function batchCrypto(syms) {
  if (!syms.length) return {};
  const pairs = syms.map(s => s.split(':')[1]);
  const res = {};

  // Attempt Binance batch ticker — single request covers all symbols
  try {
    const url = `https://api.binance.com/api/v3/ticker/24hr`;
    let data = null;
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
      if (r.ok) data = await r.json();
    } catch {}
    if (!data) data = await fetchProxy(url);
    if (Array.isArray(data)) {
      const byPair = Object.fromEntries(data.map(t => [t.symbol, t]));
      for (const pair of pairs) {
        const t = byPair[pair];
        if (t) res['BINANCE:' + pair] = {
          p: parseFloat(t.lastPrice),
          chg: parseFloat(t.priceChangePercent), // real-time rolling 24h from Binance
        };
      }
      if (pairs.every(p => res['BINANCE:' + p])) return res;
    }
  } catch {}

  // Fallback: CoinGecko for any pairs Binance didn't cover (price + stale 24h%)
  const missing = pairs.filter(p => !res['BINANCE:' + p]);
  if (missing.length) {
    try {
      const idMap = {};
      await Promise.all(missing.map(async p => { idMap[await cgId(p)] = p; }));
      const ids = Object.keys(idMap).join(',');
      const d = await fetchDirect(`https://api.coingecko.com/api/v3/simple/price?ids=${ids}&vs_currencies=usd&include_24hr_change=true`);
      for (const [id, pair] of Object.entries(idMap)) {
        if (d[id]) res['BINANCE:' + pair] = { p: d[id].usd, chg: d[id].usd_24h_change || 0 };
      }
    } catch {}
  }
  return res;
}

// ── Binance fallback for single pair ──
async function binanceFallback(sym) {
  const pair = sym.split(':')[1];
  const d = await fetchProxy(`https://api.binance.com/api/v3/ticker/24hr?symbol=${pair}`);
  if (d.lastPrice) return { p: parseFloat(d.lastPrice), chg: parseFloat(d.priceChangePercent) };
  throw new Error('no data');
}

// ── Stock price via Yahoo Finance ──
// Priority: v7 quote endpoint returns regularMarketChangePercent which is the
// exchange-official day-change %. v8 chart uses (price-previousClose)/previousClose
// which is equivalent but we prefer the explicit field. Try v7 first, fall back to v8.
async function fetchStock(sym) {
  // Primary: Yahoo v7 quote — regularMarketChangePercent is the authoritative day %
  try {
    const d = await fetchProxy(`https://query1.finance.yahoo.com/v7/finance/quote?symbols=${sym}`);
    const q = d.quoteResponse.result[0];
    if (q && q.regularMarketPrice != null) {
      return {
        p: q.regularMarketPrice,
        chg: q.regularMarketChangePercent ?? 0, // official exchange day-change %
      };
    }
  } catch {}
  // Fallback: v8 chart — use regularMarketPreviousClose, NOT meta.previousClose.
  // meta.previousClose is a chart/adjusted field that diverges significantly for
  // TSX ETFs, producing wildly wrong 24h% values. regularMarketPreviousClose is
  // the official prior regular-session close that matches Yahoo Finance UI.
  try {
    const d = await fetchProxy(`https://query2.finance.yahoo.com/v8/finance/chart/${sym}?interval=1d&range=5d`);
    const r = d.chart.result[0];
    const p = r.meta.regularMarketPrice ?? r.meta.regularMarketPreviousClose;
    const prev = r.meta.regularMarketPreviousClose
               ?? r.meta.chartPreviousClose
               ?? r.meta.previousClose;
    return { p, chg: (p != null && prev) ? ((p - prev) / prev) * 100 : 0 };
  } catch {}
  throw new Error('stock failed: ' + sym);
}

// ── Stock extra data (OBI, CVD, MTF, biases) ──
async function fetchStockExtra(sym) {
  const extra = { obi: null, cvd: null, mtf: [null, null, null], k4h: null, kDay: null, stockMeta: null };
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=1d&range=3mo`;
    const d = await fetchProxy(url);
    const r = d.chart.result[0];
    const qi = r.indicators.quote[0];
    const bars = [];
    for (let i = 0; i < qi.close.length; i++) {
      if (qi.close[i] != null && qi.open[i] != null && qi.volume[i] != null)
        bars.push({ c: qi.close[i], o: qi.open[i], h: qi.high[i] || qi.close[i], l: qi.low[i] || qi.close[i], v: qi.volume[i] });
    }
    const n = bars.length;
    if (n < 10) return extra;
    const closes = bars.map(b => b.c);
    const opens = bars.map(b => b.o);
    const highs = bars.map(b => b.h);
    const lows = bars.map(b => b.l);
    const volumes = bars.map(b => b.v);

    const rsi15 = calcRSI(closes.slice(-5), 4);
    const rsi1h = calcRSI(closes.slice(-15), 7);
    const rsiDaily = calcRSI(closes, 14);
    extra.mtf = [rsi15, rsi1h, rsiDaily];

    let cvd = 0;
    const cvdSeries = bars.map(b => { cvd += b.c >= b.o ? b.v : -b.v; return cvd; });
    const cvdLast = cvdSeries[n - 1], cvdPrev = cvdSeries[Math.max(0, n - 6)];
    extra.cvd = { value: cvdLast, series: cvdSeries.slice(-20), trending: cvdLast > cvdPrev ? 'up' : 'down' };

    const rangePos = highs[n - 1] > lows[n - 1] ? (closes[n - 1] - lows[n - 1]) / (highs[n - 1] - lows[n - 1]) : 0.5;
    extra.obi = {
      bidPct: (rangePos * 100).toFixed(1),
      askPct: ((1 - rangePos) * 100).toFixed(1),
      ratio: (rangePos / (1 - rangePos + 0.001)).toFixed(2)
    };

    const avgVol = volumes.slice(-21, -1).reduce((a, b) => a + b, 0) / Math.min(20, volumes.length - 1) || 1;
    const volShock = Math.min(3, volumes[n - 1] / avgVol);
    extra.stockMeta = { volShock: volShock.toFixed(2) };

    const recent5 = closes.slice(-5);
    const recentVols = volumes.slice(-5);
    const recentUp = recent5[4] > recent5[0];
    const volUp = recentVols[4] > (recentVols.slice(0, 4).reduce((a, b) => a + b, 0) / 4);
    const k8 = 2 / (8 + 1);
    let ema8 = closes[Math.max(0, n - 9)];
    for (let i = Math.max(0, n - 8); i < n; i++) ema8 = closes[i] * k8 + ema8 * (1 - k8);
    let cvd4h = 0;
    for (let i = n - 4; i < n; i++) cvd4h += bars[i].c >= bars[i].o ? 1 : -1;
    extra.k4h = { rsi4h: rsiDaily, recentUp, volUp, aboveEma8: closes[n - 1] > ema8, cvd4h, lastClose: closes[n - 1], prevClose: closes[n - 4] };

    const k7 = 2 / (7 + 1);
    let ema7 = closes[Math.max(0, n - 8)];
    for (let i = Math.max(0, n - 7); i < n; i++) ema7 = closes[i] * k7 + ema7 * (1 - k7);
    const chg7d = closes[n - 7] > 0 ? ((closes[n - 1] - closes[n - 7]) / closes[n - 7] * 100) : 0;
    const volSurge = volumes[n - 1] > avgVol * 1.4;
    let cvdDaily = 0;
    for (let i = n - 7; i < n; i++) cvdDaily += bars[i].c >= bars[i].o ? 1 : -1;
    extra.kDay = { rsiDaily, aboveEma7: closes[n - 1] > ema7, volSurge, chg7d: parseFloat(chg7d.toFixed(1)), cvdDaily };

    // Expose raw OHLC bar arrays so calcSupRes() in signals.js can compute pivots
    extra._barsDay = bars;           // all daily bars (up to ~60 from 3mo range)
    extra._bars4h  = bars.slice(-20); // most-recent 20 as shorter-term context
  } catch {}
  return extra;
}

// ── Crypto market microstructure ──
async function fetchOBI(pair) {
  const url = `https://api.binance.com/api/v3/depth?symbol=${pair}&limit=20`;
  let d = null;
  try { const r = await fetch(url, { signal: AbortSignal.timeout(5000) }); if (r.ok) d = await r.json(); } catch {}
  if (!d || !d.bids) { try { d = await fetchProxy(url); } catch { return null; } }
  if (!d || !d.bids) return null;
  const bv = d.bids.reduce((s, x) => s + parseFloat(x[1]), 0);
  const av = d.asks.reduce((s, x) => s + parseFloat(x[1]), 0);
  const tot = bv + av;
  return { bidPct: (bv / tot * 100).toFixed(1), askPct: (av / tot * 100).toFixed(1), ratio: (bv / av).toFixed(2) };
}

async function fetchCVD(pair) {
  const url = `https://api.binance.com/api/v3/klines?symbol=${pair}&interval=15m&limit=48`;
  let k = null;
  try { const r = await fetch(url, { signal: AbortSignal.timeout(5000) }); if (r.ok) k = await r.json(); } catch {}
  if (!Array.isArray(k)) { try { k = await fetchProxy(url); } catch { return null; } }
  if (!Array.isArray(k)) return null;
  let cvd = 0;
  const series = k.map(c => { const vol = parseFloat(c[5]), o = parseFloat(c[1]), cl = parseFloat(c[4]); cvd += cl >= o ? vol : -vol; return cvd; });
  const last = series[series.length - 1], prev5 = series[series.length - 6] || series[0];
  return { value: last, series: series.slice(-20), trending: last > prev5 ? 'up' : 'down' };
}

async function fetchMTF(pair) {
  const tfs = ['15m', '1h', '4h'];
  return Promise.all(tfs.map(async tf => {
    try {
      const url = `https://api.binance.com/api/v3/klines?symbol=${pair}&interval=${tf}&limit=30`;
      const k = await fetchBinance(url);
      return calcRSI(k.map(c => parseFloat(c[4])), 14);
    } catch { return null; }
  }));
}

async function fetch4hKlines(pair) {
  try {
    const url = `https://api.binance.com/api/v3/klines?symbol=${pair}&interval=4h&limit=20`;
    const k = await fetchBinance(url);
    if (!Array.isArray(k) || k.length < 5) return null;
    const closes = k.map(c => parseFloat(c[4]));
    const volumes = k.map(c => parseFloat(c[5]));
    const n = closes.length;
    const recentUp = closes[n - 1] > closes[n - 4];
    const volUp = volumes[n - 1] > ((volumes[n - 2] + volumes[n - 3] + volumes[n - 4]) / 3);
    const rsi4h = calcRSI(closes, 14);
    const k2 = 2 / (8 + 1); let ema8 = closes[0];
    for (let i = 1; i < closes.length; i++) ema8 = closes[i] * k2 + ema8 * (1 - k2);
    let cvd4h = 0;
    for (let i = n - 4; i < n; i++) { const o = parseFloat(k[i][1]); cvd4h += closes[i] > o ? 1 : -1; }
    return { rsi4h, recentUp, volUp, aboveEma8: closes[n - 1] > ema8, cvd4h, lastClose: closes[n - 1], prevClose: closes[n - 4] };
  } catch { return null; }
}

async function fetchDailyKlines(pair) {
  try {
    const url = `https://api.binance.com/api/v3/klines?symbol=${pair}&interval=1d&limit=14`;
    const k = await fetchBinance(url);
    if (!Array.isArray(k) || k.length < 7) return null;
    const closes = k.map(c => parseFloat(c[4]));
    const volumes = k.map(c => parseFloat(c[5]));
    const n = closes.length;
    const rsiDaily = calcRSI(closes, 14);
    const k2 = 2 / (7 + 1); let ema7 = closes[0];
    for (let i = 1; i < closes.length; i++) ema7 = closes[i] * k2 + ema7 * (1 - k2);
    const avgVol = volumes.slice(0, n - 1).reduce((a, b) => a + b, 0) / (n - 1);
    const volSurge = volumes[n - 1] > avgVol * 1.5;
    const chg7d = ((closes[n - 1] - closes[n - 7]) / closes[n - 7] * 100).toFixed(1);
    let cvdDaily = 0;
    for (let i = n - 7; i < n; i++) { const o = parseFloat(k[i][1]); cvdDaily += closes[i] > o ? 1 : -1; }
    // Build normalised bar array for calcSupRes pivot detection
    const dailyBars = k.map(c => ({ h: parseFloat(c[2]), l: parseFloat(c[3]), c: parseFloat(c[4]) }));
    return { rsiDaily, aboveEma7: closes[n - 1] > ema7, volSurge, chg7d: parseFloat(chg7d), cvdDaily, _barsDay: dailyBars };
  } catch { return null; }
}

// ── RSI calculation ──
function calcRSI(closes, p = 14) {
  if (!closes || closes.length < p + 1) return null;
  let g = 0, l = 0;
  for (let i = 1; i <= p; i++) { const d = closes[i] - closes[i - 1]; g += d > 0 ? d : 0; l += d < 0 ? -d : 0; }
  let ag = g / p, al = l / p;
  for (let i = p + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    ag = (ag * (p - 1) + (d > 0 ? d : 0)) / p;
    al = (al * (p - 1) + (d < 0 ? -d : 0)) / p;
  }
  return al === 0 ? 100 : parseFloat((100 - 100 / (1 + ag / al)).toFixed(1));
}

// ── Liq cluster estimate (crypto only) ──
function liqEstimate(price, fr, lp) {
  if (!price) return null;
  const f = parseFloat(fr) || 0;
  let dist, side;
  if (lp > 60) { dist = -(3 + Math.abs(f) * 500 + (lp - 50) * .15); side = 'LONG LIQ'; }
  else if (lp < 40) { dist = +(3 + Math.abs(f) * 500 + (50 - lp) * .15); side = 'SHORT LIQ'; }
  else { dist = lp > 50 ? -(2 + Math.random() * 2) : (2 + Math.random() * 2); side = lp > 50 ? 'LONG LIQ' : 'SHORT LIQ'; }
  const lp2 = price * (1 + dist / 100);
  return { price: lp2.toFixed(lp2 < 1 ? 4 : 2), dist: dist.toFixed(1), side };
}

// ── Global market stats ──
async function fetchGlobal() {
  try {
    const d = await fetchDirect('https://api.coingecko.com/api/v3/global');
    document.getElementById('h-btcdom').textContent = d.data.market_cap_percentage.btc.toFixed(1) + '%';
    document.getElementById('h-mcap').textContent = '$' + (d.data.total_market_cap.usd / 1e12).toFixed(2) + 'T';
    document.getElementById('h-vol').textContent = '$' + (d.data.total_volume.usd / 1e9).toFixed(1) + 'B';
  } catch {}
}

async function fetchFG() {
  try {
    const d = await fetchDirect('https://api.alternative.me/fng/');
    const val = parseInt(d.data[0].value);
    const lbl = d.data[0].value_classification;
    const pill = document.getElementById('fg-pill');
    pill.textContent = 'F&G: ' + val + ' · ' + lbl.toUpperCase();
    if (val <= 25) { pill.style.background = 'var(--bear-dim)'; pill.style.color = 'var(--bear)'; }
    else if (val <= 45) { pill.style.background = 'rgba(255,140,0,.15)'; pill.style.color = '#ff8c00'; }
    else if (val >= 75) { pill.style.background = 'var(--bull-dim)'; pill.style.color = 'var(--bull)'; }
    else { pill.style.background = 'rgba(100,100,100,.2)'; pill.style.color = '#aaa'; }
  } catch {}
}
